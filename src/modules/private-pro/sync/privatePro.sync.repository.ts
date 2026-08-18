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
    operationId: string;
    entityType: PrivateProEntityType;
    entityId: string;
    sourceVersion: string;
  }): Promise<'deleted' | 'already-deleted' | 'conflict'>;
}

export interface PrivateProLegacyCleanupReceipt {
  uid: string;
  operationId: string;
  entityType: PrivateProEntityType;
  entityId: string;
  sourceVersion: string;
  revisionPath: string | null;
  chunkIds: string[];
  chunkCursor: number;
  status: 'children' | 'complete';
}

export interface PrivateProLegacyCleanupPort {
  prepare(input: {
    uid: string;
    operationId: string;
    entityType: PrivateProEntityType;
    entityId: string;
    sourceVersion: string;
  }): Promise<
    | { status: 'ready'; receipt: PrivateProLegacyCleanupReceipt }
    | { status: 'complete'; receipt: PrivateProLegacyCleanupReceipt }
    | { status: 'already-deleted' }
    | { status: 'conflict' }
  >;
  deleteChunk(input: {
    receipt: PrivateProLegacyCleanupReceipt;
    chunkId: string;
    expectedCursor: number;
  }): Promise<PrivateProLegacyCleanupReceipt>;
  listUnexpectedChunks(receipt: PrivateProLegacyCleanupReceipt): Promise<string[]>;
  finalize(input: { receipt: PrivateProLegacyCleanupReceipt }): Promise<PrivateProLegacyCleanupReceipt>;
}

export async function resumePrivateProLegacyMigrationCleanup(
  port: PrivateProLegacyCleanupPort,
  input: Parameters<PrivateProLegacyCleanupPort['prepare']>[0],
): Promise<'deleted' | 'already-deleted' | 'conflict'> {
  const prepared = await port.prepare(input);
  if (prepared.status === 'already-deleted' || prepared.status === 'conflict') return prepared.status;
  if (prepared.status === 'complete') return 'deleted';
  let receipt = prepared.receipt;
  if (await port.listUnexpectedChunks(receipt).then(chunks => chunks.length > 0)) return 'conflict';
  while (receipt.chunkCursor < receipt.chunkIds.length) {
    const expectedCursor = receipt.chunkCursor;
    receipt = await port.deleteChunk({ receipt, chunkId: receipt.chunkIds[expectedCursor], expectedCursor });
  }
  await port.finalize({ receipt });
  return 'deleted';
}
