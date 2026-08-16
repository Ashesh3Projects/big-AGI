import type { PrivateProIdentity } from '../auth/privatePro.auth.types';
import type {
  PrivateProChatChunkDescriptor,
  PrivateProConflictResult,
  PrivateProDeleteResult,
  PrivateProPutEntityResult,
  PrivateProPutPersonaRequest,
  PrivateProSyncRepository,
} from './privatePro.sync.repository';
import { SyncChunkSchema, type SyncChunk } from './privatePro.sync.schemas';


const CHAT_UPLOAD_TTL_MS = 15 * 60 * 1000;

export interface PrepareChatRequest {
  operationId: string;
  chatId: string;
  baseRevision: number;
  contentHash: string;
  chunks: PrivateProChatChunkDescriptor[];
  deviceId: string;
}

export type PrepareChatResult =
  | { status: 'prepared'; targetRevision: number }
  | { status: 'unchanged'; revision: number }
  | PrivateProConflictResult;

export interface DeleteEntityRequest {
  operationId: string;
  entityId: string;
  baseRevision: number;
  deviceId: string;
}

function requireNonNegativeRevision(revision: number): void {
  if (!Number.isInteger(revision) || revision < 0) throw new Error('Sync base revision must be a non-negative integer.');
}

function requireHash(hash: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`${label} must be a SHA-256 hex digest.`);
}

function sameUpload(existing: PrepareChatRequest, incoming: PrepareChatRequest): boolean {
  return existing.operationId === incoming.operationId &&
    existing.chatId === incoming.chatId &&
    existing.baseRevision === incoming.baseRevision &&
    existing.contentHash === incoming.contentHash &&
    existing.deviceId === incoming.deviceId &&
    JSON.stringify(existing.chunks) === JSON.stringify(incoming.chunks);
}

export function createPrivateProSyncService(repository: PrivateProSyncRepository, now: () => number = Date.now) {
  return {
    async prepareChat(identity: PrivateProIdentity, request: PrepareChatRequest): Promise<PrepareChatResult> {
      requireNonNegativeRevision(request.baseRevision);
      requireHash(request.contentHash, 'Chat content hash');
      if (!request.operationId || !request.chatId || !request.deviceId || !request.chunks.length)
        throw new Error('Chat sync preparation is incomplete.');
      if (request.chunks.length > 400) throw new Error('Chat sync payload has too many chunks.');
      request.chunks.forEach(chunk => {
        requireHash(chunk.hash, `Chunk ${chunk.id} hash`);
        if (!chunk.id || !Number.isInteger(chunk.index) || chunk.index < 0 || !Number.isInteger(chunk.byteLength) || chunk.byteLength < 0)
          throw new Error('Chat sync chunk descriptor is invalid.');
      });

      const existingUpload = await repository.getUpload(identity.uid, request.operationId);
      if (existingUpload) {
        if (!sameUpload(existingUpload, request)) throw new Error('Sync operation ID is already used by different content.');
        return { status: 'prepared', targetRevision: existingUpload.targetRevision };
      }

      const [current, tombstone] = await Promise.all([
        repository.getChat(identity.uid, request.chatId),
        repository.getTombstone(identity.uid, 'chat', request.chatId),
      ]);
      if (current?.contentHash === request.contentHash && (!tombstone || current.revision > tombstone.revision))
        return { status: 'unchanged', revision: current.revision };

      const effectiveRevision = Math.max(current?.revision ?? 0, tombstone?.revision ?? 0);
      if (effectiveRevision !== request.baseRevision)
        return { status: 'conflict', currentRevision: effectiveRevision, currentHash: current?.contentHash ?? null };

      const createdAtMs = now();
      await repository.putUpload(identity.uid, {
        ...structuredClone(request),
        targetRevision: request.baseRevision + 1,
        createdAtMs,
        expiresAtMs: createdAtMs + CHAT_UPLOAD_TTL_MS,
      });
      return { status: 'prepared', targetRevision: request.baseRevision + 1 };
    },

    async putChatChunk(identity: PrivateProIdentity, request: { operationId: string; chunk: SyncChunk }): Promise<void> {
      const upload = await repository.getUpload(identity.uid, request.operationId);
      if (!upload) throw new Error('Prepared chat upload was not found.');
      if (upload.expiresAtMs <= now()) throw new Error('Prepared chat upload has expired.');

      const chunk = SyncChunkSchema.parse(request.chunk);
      const expected = upload.chunks.find(descriptor => descriptor.id === chunk.id);
      if (!expected || expected.index !== chunk.index || expected.byteLength !== chunk.byteLength || expected.hash !== chunk.hash)
        throw new Error(`Sync chunk ${chunk.id} does not match the prepared upload.`);
      await repository.putUploadChunk(identity.uid, request.operationId, chunk);
    },

    async commitChat(identity: PrivateProIdentity, request: { operationId: string }) {
      const upload = await repository.getUpload(identity.uid, request.operationId);
      if (!upload) throw new Error('Prepared chat upload was not found.');
      if (upload.committedRevision !== undefined)
        return { status: 'committed' as const, revision: upload.committedRevision };
      if (upload.expiresAtMs <= now()) throw new Error('Prepared chat upload has expired.');

      const chunks = await repository.getUploadChunks(identity.uid, request.operationId);
      for (const descriptor of upload.chunks) {
        const chunk = chunks.find(candidate => candidate.id === descriptor.id);
        if (!chunk) throw new Error(`Missing sync chunk ${descriptor.id}.`);
        if (chunk.index !== descriptor.index || chunk.byteLength !== descriptor.byteLength || chunk.hash !== descriptor.hash)
          throw new Error(`Sync chunk ${descriptor.id} failed prepared-upload validation.`);
      }
      if (chunks.length !== upload.chunks.length) throw new Error('Prepared chat upload contains unexpected chunks.');

      return repository.commitChat(identity.uid, upload, [...chunks].sort((a, b) => a.index - b.index));
    },

    deleteChat(identity: PrivateProIdentity, request: DeleteEntityRequest): Promise<PrivateProDeleteResult> {
      requireNonNegativeRevision(request.baseRevision);
      return repository.deleteEntity(identity.uid, 'chat', request.entityId, request.baseRevision, request.deviceId, request.operationId);
    },

    putPersona(identity: PrivateProIdentity, request: PrivateProPutPersonaRequest): Promise<PrivateProPutEntityResult> {
      requireNonNegativeRevision(request.baseRevision);
      requireHash(request.contentHash, 'Persona content hash');
      return repository.putPersona(identity.uid, structuredClone(request));
    },

    deletePersona(identity: PrivateProIdentity, request: DeleteEntityRequest): Promise<PrivateProDeleteResult> {
      requireNonNegativeRevision(request.baseRevision);
      return repository.deleteEntity(identity.uid, 'persona', request.entityId, request.baseRevision, request.deviceId, request.operationId);
    },
  };
}

export type PrivateProSyncService = ReturnType<typeof createPrivateProSyncService>;
