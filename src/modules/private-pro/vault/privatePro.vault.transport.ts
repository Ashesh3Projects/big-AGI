import { apiAsyncNode } from '~/common/util/trpc.client';

import { PRIVATE_PRO_VAULT_FIRESTORE_MAX_CIPHERTEXT_BYTES } from './privatePro.vault.repository';
import type { PrivateProVaultIndexEntry } from './privatePro.vault.repository';
import type { PutVaultRecordResult } from './privatePro.vault.service';
import type { PrivateProVaultEnvelope, PrivateProVaultOperation } from './privatePro.vault.types';


export type PrivateProVaultWriteResult = PutVaultRecordResult;
export type { PrivateProVaultIndexEntry };

export interface PrivateProVaultTransport {
  isOnline(): boolean;
  subscribeConnectivity(listener: (online: boolean) => void): () => void;
  getIndex(): Promise<PrivateProVaultIndexEntry[]>;
  getRecords(recordIds: readonly string[]): Promise<PrivateProVaultEnvelope[]>;
  write(operation: PrivateProVaultOperation): Promise<PrivateProVaultWriteResult>;
}

export class PrivateProVaultChunkRequiredError extends Error {
  constructor() {
    super('Encrypted vault record requires chunked transport support.');
    this.name = 'PrivateProVaultChunkRequiredError';
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
