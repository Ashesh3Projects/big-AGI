import { FieldValue, type DocumentData, type DocumentReference, type Firestore } from 'firebase-admin/firestore';

import { getPrivateProFirestore } from '../firebase/firebase.admin';
import { resumePrivateProLegacyMigrationCleanup } from './privatePro.sync.repository';
import type {
  PrivateProChatManifest,
  PrivateProChatUpload,
  PrivateProCommitResult,
  PrivateProDeleteResult,
  PrivateProEntityType,
  PrivateProPutEntityResult,
  PrivateProPutPersonaRequest,
  PrivateProLegacyCleanupPort,
  PrivateProLegacyCleanupReceipt,
  PrivateProSyncRepository,
  PrivateProTombstone,
} from './privatePro.sync.repository';
import { SyncChunkSchema, type SyncChunk } from './privatePro.sync.schemas';


function docData<T>(snapshot: { exists: boolean; data(): DocumentData | undefined }): T | null {
  return snapshot.exists ? snapshot.data() as T : null;
}

function chatRef(db: Firestore, uid: string, chatId: string) {
  return db.doc(`users/${uid}/chats/${chatId}`);
}

function personaRef(db: Firestore, uid: string, personaId: string) {
  return db.doc(`users/${uid}/personas/${personaId}`);
}

function tombstoneRef(db: Firestore, uid: string, entityType: PrivateProEntityType, entityId: string) {
  return db.doc(`users/${uid}/tombstones/${entityType}:${entityId}`);
}

function uploadRef(db: Firestore, uid: string, operationId: string) {
  return db.doc(`users/${uid}/chatUploads/${operationId}`);
}

function personaRevision(value: DocumentData | undefined): number {
  return typeof value?.revision === 'number' ? value.revision : 0;
}

function currentHash(value: DocumentData | undefined): string | null {
  return typeof value?.contentHash === 'string' ? value.contentHash : null;
}

async function deleteEntityInTransaction(
  db: Firestore,
  canonical: DocumentReference,
  tombstone: DocumentReference,
  entityType: PrivateProEntityType,
  entityId: string,
  baseRevision: number,
  deviceId: string,
  operationId: string,
): Promise<PrivateProDeleteResult> {
  return db.runTransaction(async transaction => {
    const [canonicalSnapshot, tombstoneSnapshot] = await Promise.all([
      transaction.get(canonical),
      transaction.get(tombstone),
    ]);
    const canonicalData = canonicalSnapshot.data();
    const tombstoneData = tombstoneSnapshot.data() as PrivateProTombstone | undefined;
    if (tombstoneData?.operationId === operationId)
      return { status: 'deleted', revision: tombstoneData.revision };

    const effectiveRevision = Math.max(personaRevision(canonicalData), tombstoneData?.revision ?? 0);
    if (effectiveRevision !== baseRevision)
      return { status: 'conflict', currentRevision: effectiveRevision, currentHash: currentHash(canonicalData) };

    const revision = baseRevision + 1;
    transaction.set(tombstone, {
      entityType,
      entityId,
      revision,
      deviceId,
      operationId,
      deletedAtMs: Date.now(),
    } satisfies PrivateProTombstone);
    transaction.delete(canonical);
    return { status: 'deleted', revision };
  });
}

export class FirebasePrivateProSyncRepository implements PrivateProSyncRepository {
  constructor(private readonly db: Firestore = getPrivateProFirestore()) {}

  async getChat(uid: string, chatId: string): Promise<PrivateProChatManifest | null> {
    return docData<PrivateProChatManifest>(await chatRef(this.db, uid, chatId).get());
  }

  async getUpload(uid: string, operationId: string): Promise<PrivateProChatUpload | null> {
    return docData<PrivateProChatUpload>(await uploadRef(this.db, uid, operationId).get());
  }

  async putUpload(uid: string, upload: PrivateProChatUpload): Promise<void> {
    const reference = uploadRef(this.db, uid, upload.operationId);
    await this.db.runTransaction(async transaction => {
      const snapshot = await transaction.get(reference);
      if (snapshot.exists) {
        const existing = snapshot.data() as PrivateProChatUpload;
        if (JSON.stringify(existing) !== JSON.stringify(upload))
          throw new Error('Sync operation ID is already used by different content.');
        return;
      }
      transaction.create(reference, upload);
    });
  }

  async putUploadChunk(uid: string, operationId: string, chunk: SyncChunk): Promise<void> {
    await uploadRef(this.db, uid, operationId).collection('chunks').doc(chunk.id).set(chunk);
  }

  async getUploadChunks(uid: string, operationId: string): Promise<SyncChunk[]> {
    const snapshot = await uploadRef(this.db, uid, operationId).collection('chunks').get();
    return snapshot.docs.map(doc => SyncChunkSchema.parse(doc.data()));
  }

  async commitChat(uid: string, upload: PrivateProChatUpload, chunks: SyncChunk[]): Promise<PrivateProCommitResult> {
    const manifestRef = chatRef(this.db, uid, upload.chatId);
    const deletedRef = tombstoneRef(this.db, uid, 'chat', upload.chatId);
    const preparedRef = uploadRef(this.db, uid, upload.operationId);
    const revisionRef = manifestRef.collection('revisions').doc(`${upload.targetRevision}-${upload.operationId}`);

    const revisionBatch = this.db.batch();
    revisionBatch.set(revisionRef, {
      chatId: upload.chatId,
      revision: upload.targetRevision,
      operationId: upload.operationId,
      contentHash: upload.contentHash,
      chunkIds: chunks.map(chunk => chunk.id),
      byteLength: chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
      deviceId: upload.deviceId,
      createdAtMs: Date.now(),
    });
    for (const chunk of chunks)
      revisionBatch.set(revisionRef.collection('chunks').doc(chunk.id), chunk);
    await revisionBatch.commit();

    return this.db.runTransaction(async transaction => {
      const [manifestSnapshot, tombstoneSnapshot, uploadSnapshot] = await Promise.all([
        transaction.get(manifestRef),
        transaction.get(deletedRef),
        transaction.get(preparedRef),
      ]);
      const committedUpload = uploadSnapshot.data() as PrivateProChatUpload | undefined;
      if (committedUpload?.committedRevision !== undefined)
        return { status: 'committed', revision: committedUpload.committedRevision };

      const current = manifestSnapshot.data() as PrivateProChatManifest | undefined;
      const tombstone = tombstoneSnapshot.data() as PrivateProTombstone | undefined;
      const effectiveRevision = Math.max(current?.revision ?? 0, tombstone?.revision ?? 0);
      if (effectiveRevision !== upload.baseRevision)
        return { status: 'conflict', currentRevision: effectiveRevision, currentHash: current?.contentHash ?? null };

      const manifest: PrivateProChatManifest = {
        chatId: upload.chatId,
        revision: upload.targetRevision,
        operationId: upload.operationId,
        contentHash: upload.contentHash,
        chunkIds: chunks.map(chunk => chunk.id),
        byteLength: chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
        deviceId: upload.deviceId,
        updatedAtMs: Date.now(),
      };
      transaction.set(manifestRef, manifest);
      transaction.set(preparedRef, { committedRevision: upload.targetRevision, committedAtMs: Date.now() }, { merge: true });
      transaction.delete(deletedRef);
      return { status: 'committed', revision: upload.targetRevision };
    });
  }

  async getTombstone(uid: string, entityType: PrivateProEntityType, entityId: string): Promise<PrivateProTombstone | null> {
    return docData<PrivateProTombstone>(await tombstoneRef(this.db, uid, entityType, entityId).get());
  }

  deleteEntity(
    uid: string,
    entityType: PrivateProEntityType,
    entityId: string,
    baseRevision: number,
    deviceId: string,
    operationId: string,
  ): Promise<PrivateProDeleteResult> {
    const canonical = entityType === 'chat' ? chatRef(this.db, uid, entityId) : personaRef(this.db, uid, entityId);
    return deleteEntityInTransaction(
      this.db,
      canonical,
      tombstoneRef(this.db, uid, entityType, entityId),
      entityType,
      entityId,
      baseRevision,
      deviceId,
      operationId,
    );
  }

  async putPersona(uid: string, request: PrivateProPutPersonaRequest): Promise<PrivateProPutEntityResult> {
    const canonical = personaRef(this.db, uid, request.personaId);
    const deletedRef = tombstoneRef(this.db, uid, 'persona', request.personaId);
    return this.db.runTransaction(async transaction => {
      const [personaSnapshot, tombstoneSnapshot] = await Promise.all([
        transaction.get(canonical),
        transaction.get(deletedRef),
      ]);
      const current = personaSnapshot.data();
      const tombstone = tombstoneSnapshot.data() as PrivateProTombstone | undefined;
      if (currentHash(current) === request.contentHash && personaSnapshot.exists)
        return { status: 'unchanged', revision: personaRevision(current) };

      const effectiveRevision = Math.max(personaRevision(current), tombstone?.revision ?? 0);
      if (effectiveRevision !== request.baseRevision)
        return { status: 'conflict', currentRevision: effectiveRevision, currentHash: currentHash(current) };

      const revision = request.baseRevision + 1;
      transaction.set(canonical, {
        personaId: request.personaId,
        revision,
        contentHash: request.contentHash,
        payload: request.payload,
        deviceId: request.deviceId,
        updatedAtMs: Date.now(),
      });
      transaction.delete(deletedRef);
      return { status: 'committed', revision };
    });
  }

  async cleanupMigratedEntity(input: { uid: string; operationId: string; entityType: PrivateProEntityType; entityId: string; sourceVersion: string }) {
    return resumePrivateProLegacyMigrationCleanup(new FirebasePrivateProLegacyCleanupPort(this.db), input);
  }
}

function cleanupReceiptRef(db: Firestore, uid: string, operationId: string) {
  return db.doc(`users/${uid}/legacyCleanupReceipts/${operationId}`);
}

class FirebasePrivateProLegacyCleanupPort implements PrivateProLegacyCleanupPort {
  constructor(private readonly db: Firestore) {}

  async prepare(input: Parameters<PrivateProLegacyCleanupPort['prepare']>[0]) {
    const [revisionText, contentHash] = input.sourceVersion.split(':');
    const expectedRevision = Number(revisionText);
    const canonical = input.entityType === 'chat' ? chatRef(this.db, input.uid, input.entityId) : personaRef(this.db, input.uid, input.entityId);
    const receiptRef = cleanupReceiptRef(this.db, input.uid, input.operationId);
    return this.db.runTransaction(async transaction => {
      const [receiptSnapshot, canonicalSnapshot] = await Promise.all([transaction.get(receiptRef), transaction.get(canonical)]);
      if (receiptSnapshot.exists) {
        const receipt = receiptSnapshot.data() as PrivateProLegacyCleanupReceipt;
        if (receipt.uid !== input.uid || receipt.entityType !== input.entityType || receipt.entityId !== input.entityId || receipt.sourceVersion !== input.sourceVersion)
          throw new Error('Legacy cleanup operation ID is already used by different content.');
        return { status: receipt.status === 'complete' ? 'complete' as const : 'ready' as const, receipt };
      }
      if (!canonicalSnapshot.exists) return { status: 'already-deleted' as const };
      const value = canonicalSnapshot.data();
      if (personaRevision(value) !== expectedRevision || currentHash(value) !== contentHash) return { status: 'conflict' as const };
      const canonicalOperationId = typeof value?.operationId === 'string' ? value.operationId : null;
      const revisionPath = input.entityType === 'chat' && canonicalOperationId
        ? canonical.collection('revisions').doc(`${expectedRevision}-${canonicalOperationId}`).path
        : null;
      const chunkIds = input.entityType === 'chat' && Array.isArray(value?.chunkIds)
        ? value.chunkIds.filter((chunkId): chunkId is string => typeof chunkId === 'string')
        : [];
      const receipt: PrivateProLegacyCleanupReceipt = {
        uid: input.uid, operationId: input.operationId, entityType: input.entityType, entityId: input.entityId,
        sourceVersion: input.sourceVersion, revisionPath, chunkIds, chunkCursor: 0, status: 'children',
      };
      transaction.create(receiptRef, receipt);
      transaction.delete(canonical);
      return { status: 'ready' as const, receipt };
    });
  }

  async deleteChunk(input: Parameters<PrivateProLegacyCleanupPort['deleteChunk']>[0]) {
    const receiptRef = cleanupReceiptRef(this.db, input.receipt.uid, input.receipt.operationId);
    return this.db.runTransaction(async transaction => {
      const snapshot = await transaction.get(receiptRef);
      if (!snapshot.exists) throw new Error('Legacy cleanup receipt was not found.');
      const receipt = snapshot.data() as PrivateProLegacyCleanupReceipt;
      if (receipt.chunkCursor > input.expectedCursor) return receipt;
      if (receipt.chunkCursor !== input.expectedCursor || receipt.chunkIds[input.expectedCursor] !== input.chunkId)
        throw new Error('Legacy cleanup cursor conflicts with this retry.');
      if (receipt.revisionPath) transaction.delete(this.db.doc(receipt.revisionPath).collection('chunks').doc(input.chunkId));
      const next = { ...receipt, chunkCursor: receipt.chunkCursor + 1 };
      transaction.set(receiptRef, next);
      return next;
    });
  }

  async listUnexpectedChunks(receipt: PrivateProLegacyCleanupReceipt) {
    if (!receipt.revisionPath) return [];
    const snapshot = await this.db.doc(receipt.revisionPath).collection('chunks').get();
    return snapshot.docs.map(document => document.id).filter(chunkId => !receipt.chunkIds.includes(chunkId));
  }

  async finalize(input: { receipt: PrivateProLegacyCleanupReceipt }) {
    const receiptRef = cleanupReceiptRef(this.db, input.receipt.uid, input.receipt.operationId);
    return this.db.runTransaction(async transaction => {
      const snapshot = await transaction.get(receiptRef);
      if (!snapshot.exists) throw new Error('Legacy cleanup receipt was not found.');
      const receipt = snapshot.data() as PrivateProLegacyCleanupReceipt;
      if (receipt.status === 'complete') return receipt;
      if (receipt.chunkCursor !== receipt.chunkIds.length) throw new Error('Legacy cleanup children are incomplete.');
      if (receipt.revisionPath) transaction.delete(this.db.doc(receipt.revisionPath));
      const complete = { ...receipt, status: 'complete' as const };
      transaction.set(receiptRef, complete);
      return complete;
    });
  }
}
