import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
} from 'firebase/firestore';

import { apiAsyncNode } from '~/common/util/trpc.client';

import { getPrivateProClientFirestore } from '../firebase/firebase.client';
import { joinSyncChunks, splitSyncPayload } from './privatePro.sync.chunk';
import type { PrivateProLocalEntity, PrivateProRemoteEvent, PrivateProSyncTransport } from './privatePro.sync.engine';
import type { PrivateProLegacyMigrationItem, PrivateProLegacyMigrationTransport } from './privatePro.sync.engine';
import { SyncChunkSchema, SyncConversationSchema, SyncPersonaSchema } from './privatePro.sync.schemas';
import { PRIVATE_PRO_CHAT_CHUNK_BYTES } from '../config/privatePro.config';


interface RemoteChatManifest {
  chatId: string;
  revision: number;
  operationId: string;
  contentHash: string;
  deviceId: string;
  updatedAtMs: number;
}

interface RemotePersonaDocument {
  personaId: string;
  revision: number;
  contentHash: string;
  payload: unknown;
}

interface RemoteTombstoneDocument {
  entityType: 'chat' | 'persona';
  entityId: string;
  revision: number;
}

function isManifest(value: unknown): value is RemoteChatManifest {
  const manifest = value as Partial<RemoteChatManifest>;
  return !!manifest && typeof manifest.chatId === 'string' && typeof manifest.revision === 'number' &&
    typeof manifest.operationId === 'string' && typeof manifest.contentHash === 'string';
}

async function downloadChat(uid: string, manifest: RemoteChatManifest, signal?: AbortSignal): Promise<PrivateProLocalEntity> {
  if (signal?.aborted) throw new DOMException('Legacy sync migration was cancelled.', 'AbortError');
  const firestore = getPrivateProClientFirestore();
  const revisionPath = `users/${uid}/chats/${manifest.chatId}/revisions/${manifest.revision}-${manifest.operationId}`;
  const chunksQuery = query(collection(firestore, revisionPath, 'chunks'), orderBy('index', 'asc'));
  const chunks = await new Promise<ReturnType<typeof SyncChunkSchema.parse>[]>((resolve, reject) => {
    const unsubscribe = onSnapshot(chunksQuery, snapshot => {
      unsubscribe();
      resolve(snapshot.docs.map(chunkDoc => SyncChunkSchema.parse(chunkDoc.data())));
    }, reject);
  });
  if (signal?.aborted) throw new DOMException('Legacy sync migration was cancelled.', 'AbortError');
  const payload = SyncConversationSchema.parse(JSON.parse(await joinSyncChunks(chunks)));
  const assetIds = new Set<string>();
  for (const message of payload.conversation.messages) {
    for (const fragment of message.fragments) {
      const part = (fragment as { part?: { pt?: string; rt?: string; zType?: string; assetId?: string; _legacyImageRefPart?: { dataRef?: { reftype?: string; dblobAssetId?: string } } } }).part;
      if (part?.pt === 'reference' && part.rt === 'zync' && part.zType === 'asset') {
        const legacyId = part._legacyImageRefPart?.dataRef?.reftype === 'dblob' ? part._legacyImageRefPart.dataRef.dblobAssetId : undefined;
        if (legacyId) assetIds.add(legacyId);
      }
    }
  }
  return { entityType: 'chat', entityId: manifest.chatId, contentHash: manifest.contentHash, payload, assetIds: [...assetIds] };
}

function migrationVersion(entity: PrivateProLocalEntity, revision: number): string {
  return `${revision}:${entity.contentHash}`;
}

export function createPrivateProLegacyMigrationTransport(uid: string): PrivateProLegacyMigrationTransport {
  return {
    async listForMigration(signal) {
      const firestore = getPrivateProClientFirestore();
      const [chats, personas] = await Promise.all([
        getDocs(collection(firestore, `users/${uid}/chats`)),
        getDocs(collection(firestore, `users/${uid}/personas`)),
      ]);
      if (signal.aborted) throw new DOMException('Legacy sync migration was cancelled.', 'AbortError');
      const items: PrivateProLegacyMigrationItem[] = [];
      for (const snapshot of chats.docs) {
        const manifest = snapshot.data();
        if (!isManifest(manifest)) throw new Error('Remote chat manifest is invalid.');
        const entity = await downloadChat(uid, manifest, signal);
        items.push({ entity, sourceVersion: migrationVersion(entity, manifest.revision) });
      }
      for (const snapshot of personas.docs) {
        const persona = snapshot.data() as RemotePersonaDocument;
        const entity: PrivateProLocalEntity = {
          entityType: 'persona', entityId: persona.personaId, contentHash: persona.contentHash,
          payload: SyncPersonaSchema.parse(persona.payload),
        };
        items.push({ entity, sourceVersion: migrationVersion(entity, persona.revision) });
      }
      return items;
    },

    async currentVersion(entityType, entityId, signal) {
      if (signal.aborted) throw new DOMException('Legacy sync migration was cancelled.', 'AbortError');
      const remote = await createPrivateProFirebaseTransport(uid).fetch(entityType, entityId);
      if (!remote || remote.kind === 'delete') return null;
      return migrationVersion(remote.entity, remote.revision);
    },

    async cleanupMigrationItem(_item, operationId, signal) {
      if (signal.aborted) throw new DOMException('Legacy sync migration was cancelled.', 'AbortError');
      const result = await apiAsyncNode.privateProSync.cleanupMigratedEntity.mutate({
        operationId,
        entityType: _item.entity.entityType,
        entityId: _item.entity.entityId,
        sourceVersion: _item.sourceVersion,
      });
      if (result === 'conflict') throw new Error('Legacy cloud data changed after inventory. Cleanup was blocked.');
    },
  };
}

export function createPrivateProFirebaseTransport(uid: string): PrivateProSyncTransport {
  return {
    async upsert(operation) {
      if (operation.entityType === 'persona') {
        return apiAsyncNode.privateProSync.putPersona.mutate({
          personaId: operation.entityId,
          baseRevision: operation.baseRevision,
          contentHash: operation.contentHash,
          payload: SyncPersonaSchema.parse(operation.payload),
          deviceId: operation.deviceId,
        });
      }

      const payload = JSON.stringify(SyncConversationSchema.parse(operation.payload));
      const chunks = await splitSyncPayload(payload, PRIVATE_PRO_CHAT_CHUNK_BYTES);
      const prepared = await apiAsyncNode.privateProSync.prepareChat.mutate({
        operationId: operation.operationId,
        chatId: operation.entityId,
        baseRevision: operation.baseRevision,
        contentHash: operation.contentHash,
        chunks: chunks.map(({ id, index, byteLength, hash }) => ({ id, index, byteLength, hash })),
        deviceId: operation.deviceId,
      });
      if (prepared.status !== 'prepared') return prepared;
      for (const chunk of chunks)
        await apiAsyncNode.privateProSync.putChatChunk.mutate({ operationId: operation.operationId, chunk });
      return apiAsyncNode.privateProSync.commitChat.mutate({ operationId: operation.operationId });
    },

    delete(operation) {
      return operation.entityType === 'chat'
        ? apiAsyncNode.privateProSync.deleteChat.mutate({
          operationId: operation.operationId,
          entityId: operation.entityId,
          baseRevision: operation.baseRevision,
          deviceId: operation.deviceId,
        })
        : apiAsyncNode.privateProSync.deletePersona.mutate({
          operationId: operation.operationId,
          entityId: operation.entityId,
          baseRevision: operation.baseRevision,
          deviceId: operation.deviceId,
        });
    },

    async fetch(entityType, entityId) {
      const firestore = getPrivateProClientFirestore();
      const [canonicalSnapshot, tombstoneSnapshot] = await Promise.all([
        getDoc(entityType === 'chat'
          ? doc(firestore, `users/${uid}/chats/${entityId}`)
          : doc(firestore, `users/${uid}/personas/${entityId}`)),
        getDoc(doc(firestore, `users/${uid}/tombstones/${entityType}:${entityId}`)),
      ]);
      const tombstone = tombstoneSnapshot.exists() ? tombstoneSnapshot.data() as RemoteTombstoneDocument : null;
      const canonicalRevision = canonicalSnapshot.exists() && typeof canonicalSnapshot.data().revision === 'number'
        ? canonicalSnapshot.data().revision as number
        : 0;
      if (tombstone && tombstone.revision >= canonicalRevision)
        return { kind: 'delete', ...tombstone };
      if (!canonicalSnapshot.exists()) return null;
      if (entityType === 'chat') {
        const manifest = canonicalSnapshot.data();
        if (!isManifest(manifest)) throw new Error('Remote chat manifest is invalid.');
        return { kind: 'upsert', revision: manifest.revision, entity: await downloadChat(uid, manifest) };
      }
      const persona = canonicalSnapshot.data() as RemotePersonaDocument;
      return {
        kind: 'upsert',
        revision: persona.revision,
        entity: {
          entityType: 'persona',
          entityId: persona.personaId,
          contentHash: persona.contentHash,
          payload: SyncPersonaSchema.parse(persona.payload),
        },
      };
    },

    subscribe(_uid, listener) {
      const firestore = getPrivateProClientFirestore();
      const unsubscribers = [
        onSnapshot(collection(firestore, `users/${uid}/chats`), snapshot => {
          for (const change of snapshot.docChanges()) {
            if (change.type === 'removed') continue;
            const manifest = change.doc.data();
            if (!isManifest(manifest)) {
              listener({ kind: 'upsert', revision: 0, entity: { entityType: 'chat', entityId: '', contentHash: '', payload: manifest } });
              continue;
            }
            void downloadChat(uid, manifest).then(entity => listener({ kind: 'upsert', revision: manifest.revision, entity })).catch(() => {
              listener({ kind: 'upsert', revision: 0, entity: { entityType: 'chat', entityId: '', contentHash: '', payload: manifest } });
            });
          }
        }),
        onSnapshot(collection(firestore, `users/${uid}/personas`), snapshot => {
          for (const change of snapshot.docChanges()) {
            if (change.type === 'removed') continue;
            const persona = change.doc.data() as RemotePersonaDocument;
            listener({
              kind: 'upsert',
              revision: persona.revision,
              entity: {
                entityType: 'persona',
                entityId: persona.personaId,
                contentHash: persona.contentHash,
                payload: persona.payload,
              },
            });
          }
        }),
        onSnapshot(collection(firestore, `users/${uid}/tombstones`), snapshot => {
          for (const change of snapshot.docChanges()) {
            if (change.type === 'removed') continue;
            const tombstone = change.doc.data() as RemoteTombstoneDocument;
            listener({ kind: 'delete', ...tombstone });
          }
        }),
      ];
      return () => unsubscribers.forEach(unsubscribe => unsubscribe());
    },
  };
}
