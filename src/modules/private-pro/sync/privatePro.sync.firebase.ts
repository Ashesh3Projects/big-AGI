import {
  collection,
  doc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  type Firestore,
} from 'firebase/firestore';

import { getPrivateProClientFirestore } from '../firebase/firebase.client';
import { privateProRecordKey } from './privatePro.sync.codec';
import {
  PrivateProSyncMutationReceiptSchema,
  PrivateProSyncMutationKindSchema,
  PrivateProSyncRecordDocumentSchema,
  PrivateProSyncRecordKeySchema,
  PrivateProSyncRecordTypeSchema,
  PrivateProSyncTombstoneDocumentSchema,
  type PrivateProSyncMutationKind,
} from './privatePro.sync.schemas';
import {
  PrivateProSyncTransportError,
  type PrivateProSyncTransport,
  PrivateProSyncErrorCategory,
  PrivateProSyncRemoteEvent,
  PrivateProSyncRemoteRecord,
  PrivateProSyncWriteInput,
  PrivateProSyncWriteResult,
} from './privatePro.sync.transport';


const EMPTY_PAYLOAD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

interface PrivateProFirestoreChange {
  type: 'added' | 'modified' | 'removed';
  id: string;
  data: unknown;
  hasPendingWrites: boolean;
}

interface PrivateProFirestoreListener {
  next(changes: readonly PrivateProFirestoreChange[]): void;
  error(error: unknown): void;
}

export interface PrivateProFirestoreTransactionPort {
  get(path: string): Promise<unknown | null>;
  set(path: string, data: unknown): void;
}

export interface PrivateProFirestorePort {
  runTransaction<T>(callback: (transaction: PrivateProFirestoreTransactionPort) => Promise<T>): Promise<T>;
  listenCollection(path: string, options: { includeMetadataChanges: true }, listener: PrivateProFirestoreListener): () => void;
  serverTimestamp(): unknown;
}

class FirebaseWebPrivateProFirestorePort implements PrivateProFirestorePort {
  constructor(private readonly firestore: Firestore) {}

  runTransaction<T>(callback: (transaction: PrivateProFirestoreTransactionPort) => Promise<T>): Promise<T> {
    return runTransaction(this.firestore, transaction => callback({
      get: async path => {
        const snapshot = await transaction.get(doc(this.firestore, path));
        return snapshot.exists() ? snapshot.data() : null;
      },
      set: (path, data) => { transaction.set(doc(this.firestore, path), data); },
    }));
  }

  listenCollection(path: string, options: { includeMetadataChanges: true }, listener: PrivateProFirestoreListener): () => void {
    return onSnapshot(collection(this.firestore, path), options, snapshot => listener.next(snapshot.docChanges().map(change => ({
      type: change.type,
      id: change.doc.id,
      data: change.doc.data(),
      hasPendingWrites: change.doc.metadata.hasPendingWrites,
    }))), error => listener.error(error));
  }

  serverTimestamp(): unknown {
    return serverTimestamp();
  }
}

function syncRoot(uid: string): string {
  return `users/${uid}/workspaces/v1`;
}

function requestedRevision(input: PrivateProSyncWriteInput): number {
  if (!Number.isInteger(input.baseRevision) || input.baseRevision < 0)
    throw new TypeError('Private Pro sync base revision is invalid.');
  return input.baseRevision + 1;
}

function assertRequestedIdentity(input: PrivateProSyncWriteInput): void {
  PrivateProSyncRecordKeySchema.parse(input.recordKey);
  PrivateProSyncRecordTypeSchema.parse(input.recordType);
  PrivateProSyncMutationKindSchema.parse(input.kind);
  if (!input.logicalId || input.logicalId.length > 512 || !Number.isInteger(input.schemaVersion) || input.schemaVersion <= 0 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.mutationId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.writerId))
    throw new TypeError('Private Pro sync mutation identity is invalid.');
  if (privateProRecordKey(input.recordType, input.logicalId) !== input.recordKey)
    throw new TypeError('Private Pro sync requested record identity is invalid.');
  if ((input.kind === 'put') !== (input.contentHash !== null))
    throw new TypeError('Private Pro sync mutation content hash is invalid.');
  if (input.contentHash !== null && !/^[a-f0-9]{64}$/.test(input.contentHash))
    throw new TypeError('Private Pro sync mutation content hash is invalid.');
  if (input.kind === 'delete' && input.payload !== '')
    throw new TypeError('Private Pro sync delete payload is invalid.');
}

function parseCanonical(recordKey: string, value: unknown, expected?: Pick<PrivateProSyncWriteInput, 'recordType' | 'logicalId'>): PrivateProSyncRemoteRecord {
  const record = PrivateProSyncRecordDocumentSchema.parse(value);
  if (privateProRecordKey(record.recordType, record.logicalId) !== recordKey ||
      (expected && (record.recordType !== expected.recordType || record.logicalId !== expected.logicalId)))
    throw new TypeError('Private Pro sync canonical record identity is invalid.');
  return { recordKey, ...record };
}

function assertReceiptIdentity(receiptValue: unknown, input: PrivateProSyncWriteInput, revision: number): void {
  const receipt = PrivateProSyncMutationReceiptSchema.parse(receiptValue);
  const expectedContentHash = input.kind === 'put' ? input.contentHash : null;
  if (receipt.mutationId !== input.mutationId ||
      receipt.recordKey !== input.recordKey ||
      receipt.recordType !== input.recordType ||
      receipt.logicalId !== input.logicalId ||
      receipt.kind !== input.kind ||
      receipt.contentHash !== expectedContentHash ||
      receipt.revision !== revision ||
      receipt.writerId !== input.writerId)
    throw new TypeError('Private Pro sync mutation receipt identity does not match.');
}

function classifyFirebaseError(error: unknown): PrivateProSyncErrorCategory {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : '';
  if (code === 'permission-denied' || code === 'unauthenticated') return 'permission';
  if (code === 'unavailable' || code === 'deadline-exceeded' || code === 'cancelled') return 'offline';
  if (code === 'resource-exhausted') return 'quota';
  return 'unknown';
}

function createCanonicalDocument(input: PrivateProSyncWriteInput, revision: number, timestamp: unknown) {
  return PrivateProSyncRecordDocumentSchema.parse({
    recordType: input.recordType,
    logicalId: input.logicalId,
    schemaVersion: input.schemaVersion,
    payload: input.kind === 'delete' ? '' : input.payload,
    contentHash: input.kind === 'delete' ? EMPTY_PAYLOAD_SHA256 : input.contentHash,
    revision,
    mutationId: input.mutationId,
    writerId: input.writerId,
    deleted: input.kind === 'delete',
    updatedAt: timestamp,
  });
}

function createReceipt(input: PrivateProSyncWriteInput, revision: number, timestamp: unknown) {
  return PrivateProSyncMutationReceiptSchema.parse({
    schemaVersion: 1,
    mutationId: input.mutationId,
    recordKey: input.recordKey,
    recordType: input.recordType,
    logicalId: input.logicalId,
    kind: input.kind,
    contentHash: input.kind === 'put' ? input.contentHash : null,
    revision,
    writerId: input.writerId,
    committedAt: timestamp,
  });
}

function createTombstone(input: PrivateProSyncWriteInput, revision: number, timestamp: unknown) {
  return PrivateProSyncTombstoneDocumentSchema.parse({
    recordKey: input.recordKey,
    recordType: input.recordType,
    logicalId: input.logicalId,
    deletedRevision: revision,
    mutationId: input.mutationId,
    writerId: input.writerId,
    deletedAt: timestamp,
  });
}

function parseTombstone(recordKey: string, value: unknown, expected?: Pick<PrivateProSyncWriteInput, 'recordType' | 'logicalId'>) {
  const tombstone = PrivateProSyncTombstoneDocumentSchema.parse(value);
  if (tombstone.recordKey !== recordKey || privateProRecordKey(tombstone.recordType, tombstone.logicalId) !== recordKey ||
      (expected && (tombstone.recordType !== expected.recordType || tombstone.logicalId !== expected.logicalId)))
    throw new TypeError('Private Pro sync tombstone identity is invalid.');
  return tombstone;
}

function emitChanges(
  collectionKind: 'record' | 'asset' | 'tombstone',
  changes: readonly PrivateProFirestoreChange[],
  listener: (event: PrivateProSyncRemoteEvent) => void,
): void {
  for (const change of changes) {
    if (change.hasPendingWrites || change.type === 'removed') continue;
    try {
      if (collectionKind === 'tombstone') {
        const tombstone = parseTombstone(change.id, change.data);
        listener({ type: 'tombstone', tombstone });
        continue;
      }
      const canonical = parseCanonical(change.id, change.data);
      if ((collectionKind === 'asset') !== (canonical.recordType === 'asset'))
        throw new TypeError('Private Pro sync record collection identity is invalid.');
      listener({ type: 'record', canonical });
    } catch {
      listener({ type: 'error', category: 'unknown' });
    }
  }
}

async function writeMutation(
  root: string,
  firestore: PrivateProFirestorePort,
  input: PrivateProSyncWriteInput,
): Promise<PrivateProSyncWriteResult> {
  assertRequestedIdentity(input);
  const revision = requestedRevision(input);
  const recordPath = input.recordType === 'asset'
    ? `${root}/assets/${input.recordKey}`
    : `${root}/records/${input.recordKey}`;
  const receiptPath = `${root}/mutationReceipts/${input.mutationId}`;
  const tombstonePath = `${root}/tombstones/${input.recordKey}`;

  return firestore.runTransaction(async transaction => {
    const receiptValue = await transaction.get(receiptPath);
    if (receiptValue !== null) {
      assertReceiptIdentity(receiptValue, input, revision);
      return { status: 'already-committed', revision };
    }

    const recordValue = await transaction.get(recordPath);
    const existing = recordValue === null ? null : parseCanonical(input.recordKey, recordValue, input);
    const tombstoneValue = await transaction.get(tombstonePath);
    const tombstone = tombstoneValue === null ? null : parseTombstone(input.recordKey, tombstoneValue, input);
    if (tombstone) {
      if (!existing?.deleted || existing.revision !== tombstone.deletedRevision || existing.mutationId !== tombstone.mutationId)
        throw new TypeError('Private Pro sync tombstone does not match the canonical deleted record.');
      return { status: 'deleted', canonical: existing };
    }
    if (existing?.deleted) return { status: 'deleted', canonical: existing };
    if ((existing?.revision ?? 0) !== input.baseRevision) {
      if (!existing) throw new TypeError('Private Pro sync missing canonical record conflicts with the requested base.');
      return { status: 'conflict', canonical: existing };
    }

    const timestamp = firestore.serverTimestamp();
    transaction.set(recordPath, createCanonicalDocument(input, revision, timestamp));
    if (input.kind === 'delete') transaction.set(tombstonePath, createTombstone(input, revision, timestamp));
    transaction.set(receiptPath, createReceipt(input, revision, timestamp));
    return { status: 'accepted', revision };
  });
}

export function createPrivateProFirebaseSyncTransport(
  uid: string,
  firestore: PrivateProFirestorePort = new FirebaseWebPrivateProFirestorePort(getPrivateProClientFirestore()),
): PrivateProSyncTransport {
  const root = syncRoot(uid);
  return {
    async write(input) {
      try {
        return await writeMutation(root, firestore, input);
      } catch (error) {
        if (error instanceof PrivateProSyncTransportError) throw error;
        throw new PrivateProSyncTransportError(classifyFirebaseError(error));
      }
    },
    listen(listener) {
      const onError = (error: unknown) => listener({ type: 'error', category: classifyFirebaseError(error) });
      const unsubscribes = (['record', 'asset', 'tombstone'] as const).map(kind => {
        const collectionName = kind === 'record' ? 'records' : kind === 'asset' ? 'assets' : 'tombstones';
        return firestore.listenCollection(`${root}/${collectionName}`, { includeMetadataChanges: true }, {
          next: changes => emitChanges(kind, changes, listener),
          error: onError,
        });
      });
      return () => { for (const unsubscribe of unsubscribes) unsubscribe(); };
    },
  };
}
