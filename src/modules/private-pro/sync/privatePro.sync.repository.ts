import type { SyncChunk } from './privatePro.sync.schemas';


export type PrivateProEntityType = 'chat' | 'persona';

export interface PrivateProChatManifest {
  chatId: string;
  revision: number;
  operationId: string;
  contentHash: string;
  chunkIds: string[];
  byteLength: number;
  deviceId: string;
  updatedAtMs: number;
}

export interface PrivateProChatChunkDescriptor {
  id: string;
  index: number;
  byteLength: number;
  hash: string;
}

export interface PrivateProChatUpload {
  operationId: string;
  chatId: string;
  baseRevision: number;
  targetRevision: number;
  contentHash: string;
  chunks: PrivateProChatChunkDescriptor[];
  deviceId: string;
  createdAtMs: number;
  expiresAtMs: number;
  committedRevision?: number;
}

export interface PrivateProTombstone {
  entityType: PrivateProEntityType;
  entityId: string;
  revision: number;
  deviceId: string;
  operationId: string;
  deletedAtMs: number;
}

export type PrivateProConflictResult = {
  status: 'conflict';
  currentRevision: number;
  currentHash: string | null;
};

export type PrivateProCommitResult =
  | { status: 'committed'; revision: number }
  | PrivateProConflictResult;

export type PrivateProDeleteResult =
  | { status: 'deleted'; revision: number }
  | PrivateProConflictResult;

export type PrivateProPutEntityResult =
  | { status: 'committed'; revision: number }
  | { status: 'unchanged'; revision: number }
  | PrivateProConflictResult;

export interface PrivateProPutPersonaRequest {
  personaId: string;
  baseRevision: number;
  contentHash: string;
  payload: unknown;
  deviceId: string;
}

export interface PrivateProSyncRepository {
  getChat(uid: string, chatId: string): Promise<PrivateProChatManifest | null>;
  getUpload(uid: string, operationId: string): Promise<PrivateProChatUpload | null>;
  putUpload(uid: string, upload: PrivateProChatUpload): Promise<void>;
  putUploadChunk(uid: string, operationId: string, chunk: SyncChunk): Promise<void>;
  getUploadChunks(uid: string, operationId: string): Promise<SyncChunk[]>;
  commitChat(uid: string, upload: PrivateProChatUpload, chunks: SyncChunk[]): Promise<PrivateProCommitResult>;
  getTombstone(uid: string, entityType: PrivateProEntityType, entityId: string): Promise<PrivateProTombstone | null>;
  deleteEntity(
    uid: string,
    entityType: PrivateProEntityType,
    entityId: string,
    baseRevision: number,
    deviceId: string,
    operationId: string,
  ): Promise<PrivateProDeleteResult>;
  putPersona(uid: string, request: PrivateProPutPersonaRequest): Promise<PrivateProPutEntityResult>;
  cleanupMigratedEntity(input: {
    uid: string;
    entityType: PrivateProEntityType;
    entityId: string;
    sourceVersion: string;
  }): Promise<'deleted' | 'already-deleted' | 'conflict'>;
}
