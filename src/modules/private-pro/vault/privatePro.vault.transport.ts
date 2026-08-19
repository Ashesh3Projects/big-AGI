import { apiAsyncNode } from '~/common/util/trpc.client';
import { TRPCClientError } from '@trpc/client';

import { PRIVATE_PRO_VAULT_FIRESTORE_MAX_CIPHERTEXT_BYTES } from './privatePro.vault.repository';
import type { PrivateProVaultIndexEntry } from './privatePro.vault.repository';
import type { PutVaultRecordResult } from './privatePro.vault.service';
import type {
  BeginVaultBackupRestoreInput,
  ConfirmVaultBackupRestoreInput,
  MergeVaultBackupInput,
  MergeVaultBackupRestoreChunkInput,
  MergeVaultBackupResult,
  SealVaultBackupRestoreInput,
} from './privatePro.vault.service';
import type { PrivateProVaultEnvelope, PrivateProVaultOperation } from './privatePro.vault.types';


export type PrivateProVaultWriteResult = PutVaultRecordResult;
export type { PrivateProVaultIndexEntry };

export interface PrivateProVaultTransport {
  isOnline(): boolean;
  subscribeConnectivity(listener: (online: boolean) => void): () => void;
  getIndex(): Promise<PrivateProVaultIndexEntry[]>;
  getRecords(recordIds: readonly string[]): Promise<PrivateProVaultEnvelope[]>;
  mergeBackup(input: MergeVaultBackupInput): Promise<MergeVaultBackupResult>;
  beginBackupRestore?(input: BeginVaultBackupRestoreInput): Promise<unknown>;
  getBackupRestoreStatus?(restoreId: string): Promise<{
    phase: 'merging' | 'awaiting-verification' | 'completed';
    nextChunkIndex: number;
  } | null>;
  mergeBackupRestoreChunk?(input: MergeVaultBackupRestoreChunkInput): Promise<MergeVaultBackupResult & { nextChunkIndex: number }>;
  getBackupRestoreIndex?(restoreId: string): Promise<PrivateProVaultIndexEntry[]>;
  getBackupRestoreRecords?(restoreId: string, recordIds: readonly string[]): Promise<PrivateProVaultEnvelope[]>;
  sealBackupRestore?(input: SealVaultBackupRestoreInput): Promise<{ status: 'sealed' | 'unchanged'; sessionFingerprint: string }>;
  confirmBackupRestoreVerified?(input: ConfirmVaultBackupRestoreInput): Promise<unknown>;
  write(operation: PrivateProVaultOperation): Promise<PrivateProVaultWriteResult>;
}

export class PrivateProVaultChunkRequiredError extends Error {
  constructor() {
    super('Encrypted vault record requires chunked transport support.');
    this.name = 'PrivateProVaultChunkRequiredError';
  }
}

export class PrivateProVaultAmbiguousTransportError extends Error {
  constructor(cause: unknown) {
    super('Encrypted vault transport response was ambiguous.', { cause });
    this.name = 'PrivateProVaultAmbiguousTransportError';
  }
}

export function isPrivateProVaultAmbiguousTRPCError(error: unknown): boolean {
  if (!(error instanceof TRPCClientError)) return false;
  if (error.data != null || error.shape != null) return false;
  const cause = error.cause;
  if (cause instanceof Error && cause.name === 'AbortError') return false;
  return cause instanceof SyntaxError
    || cause instanceof TypeError
    || cause instanceof DOMException
    || cause instanceof Error && /(?:failed to fetch|fetch failed|network|socket|terminated|connection|stream closed|invalid json|unexpected (?:end|token)|response.*pars)/i.test(cause.message);
}

async function mergeBackup(input: MergeVaultBackupInput): Promise<MergeVaultBackupResult> {
  try {
    return await apiAsyncNode.privateProVault.mergeBackup.mutate(input);
  } catch (error) {
    if (isPrivateProVaultAmbiguousTRPCError(error)) throw new PrivateProVaultAmbiguousTransportError(error);
    throw error;
  }
}

async function ambiguousMutation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isPrivateProVaultAmbiguousTRPCError(error)) throw new PrivateProVaultAmbiguousTransportError(error);
    throw error;
  }
}

export function createPrivateProVaultTransport(): PrivateProVaultTransport {
  return {
    isOnline: () => typeof navigator === 'undefined' || navigator.onLine,

    subscribeConnectivity(listener) {
      if (typeof window === 'undefined') return () => {};
      const onOnline = () => listener(true);
      const onOffline = () => listener(false);
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
      return () => {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
      };
    },

    async getIndex() {
      const entries: PrivateProVaultIndexEntry[] = [];
      let cursor: string | null = null;
      do {
        const page = await apiAsyncNode.privateProVault.getIndex.query({ pageSize: 500, cursor });
        entries.push(...page.entries);
        cursor = page.nextCursor;
      } while (cursor !== null);
      return entries;
    },

    async getRecords(recordIds) {
      if (recordIds.length === 0) return [];
      const envelopes: PrivateProVaultEnvelope[] = [];
      for (let offset = 0; offset < recordIds.length; offset += 500) {
        const records = await apiAsyncNode.privateProVault.getRecords.query({ opaqueRecordIds: recordIds.slice(offset, offset + 500) });
        envelopes.push(...records.map(record => structuredClone(record.envelope)));
      }
      return envelopes;
    },

    mergeBackup,

    beginBackupRestore: input => ambiguousMutation(() => apiAsyncNode.privateProVault.beginBackupRestore.mutate(input)),

    getBackupRestoreStatus: restoreId => apiAsyncNode.privateProVault.getBackupRestoreStatus.query({ restoreId }),

    mergeBackupRestoreChunk: input => ambiguousMutation(() => apiAsyncNode.privateProVault.mergeBackupRestoreChunk.mutate(input)),

    async getBackupRestoreIndex(restoreId) {
      const entries: PrivateProVaultIndexEntry[] = [];
      let cursor: string | null = null;
      do {
        const page = await apiAsyncNode.privateProVault.getBackupRestoreIndex.query({ restoreId, pageSize: 500, cursor });
        entries.push(...page.entries);
        cursor = page.nextCursor;
      } while (cursor !== null);
      return entries;
    },

    async getBackupRestoreRecords(restoreId, recordIds) {
      const envelopes: PrivateProVaultEnvelope[] = [];
      for (let offset = 0; offset < recordIds.length; offset += 500) {
        const records = await apiAsyncNode.privateProVault.getBackupRestoreRecords.query({ restoreId, opaqueRecordIds: recordIds.slice(offset, offset + 500) });
        envelopes.push(...records.map(record => structuredClone(record.envelope)));
      }
      return envelopes;
    },

    sealBackupRestore: input => ambiguousMutation(() => apiAsyncNode.privateProVault.sealBackupRestore.mutate(input)),

    confirmBackupRestoreVerified: input => ambiguousMutation(() => apiAsyncNode.privateProVault.confirmBackupRestoreVerified.mutate(input)),

    async write(operation) {
      if (operation.kind === 'put') {
        if (operation.envelope.ciphertextBytes > PRIVATE_PRO_VAULT_FIRESTORE_MAX_CIPHERTEXT_BYTES)
          throw new PrivateProVaultChunkRequiredError();
        return apiAsyncNode.privateProVault.putRecord.mutate({
          operationId: operation.operationId,
          opaqueRecordId: operation.envelope.recordId,
          baseRevision: operation.baseRevision,
          envelope: operation.envelope,
        });
      }
      return apiAsyncNode.privateProVault.deleteRecord.mutate({
        operationId: operation.operationId,
        opaqueRecordId: operation.tombstone.recordId,
        baseRevision: operation.baseRevision,
        tombstone: operation.tombstone,
      });
    },
  };
}
