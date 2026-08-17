import type * as z from 'zod/v4';

import type { PrivateProVaultRecordType } from './privatePro.vault.types';
import { assertPrivateProVaultRecordId, privateProVaultRecordId } from './privatePro.vault.recordIds';
import { privateProVaultChatSerializer } from './serializers/chat';
import { privateProVaultFolderSerializer } from './serializers/folder';
import { privateProVaultCredentialSerializer, privateProVaultModelSerializer } from './serializers/models';
import { privateProVaultPersonaSerializer } from './serializers/persona';
import { privateProVaultScratchSerializer } from './serializers/scratch';
import { privateProVaultSettingsSerializer } from './serializers/settings';


export type PrivateProPortableMutation = {
  kind: 'put';
  recordType: PrivateProVaultRecordType;
  recordId: string;
  schemaVersion: number;
  value: unknown;
} | {
  kind: 'delete';
  recordType: PrivateProVaultRecordType;
  recordId: string;
  schemaVersion: number;
};

export interface PrivateProVaultSerializer<T> {
  recordType: PrivateProVaultRecordType;
  schemaVersion: number;
  snapshot(): Promise<Array<{ recordId: string; value: T }>>;
  apply(recordId: string, value: T): Promise<void>;
  remove(recordId: string): Promise<void>;
  subscribe(listener: (mutation: PrivateProPortableMutation) => void): () => void;
}

export interface PrivateProVaultLogicalSerializer<T> {
  recordType: PrivateProVaultRecordType;
  schemaVersion: number;
  schema: z.ZodType<T>;
  logicalId(value: T): string;
  snapshot(): Array<{ logicalId: string; value: T }>;
  apply(logicalId: string, value: T): void;
  remove(logicalId: string): void;
  subscribe(listener: () => void): () => void;
}


function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function bindSerializer<T>(
  serializer: PrivateProVaultLogicalSerializer<T>,
  identifierKey: CryptoKey,
): PrivateProVaultSerializer<T> {
  const opaqueId = (logicalId: string) => privateProVaultRecordId(identifierKey, serializer.recordType, logicalId);

  const snapshot = async () => Promise.all(serializer.snapshot().map(async record => ({
    recordId: await opaqueId(record.logicalId),
    value: serializer.schema.parse(record.value),
  })));

  return {
    recordType: serializer.recordType,
    schemaVersion: serializer.schemaVersion,
    snapshot,
    apply: async (recordId, input) => {
      const value = serializer.schema.parse(input);
      const logicalId = serializer.logicalId(value);
      await assertPrivateProVaultRecordId(identifierKey, serializer.recordType, logicalId, recordId);
      serializer.apply(logicalId, value);
    },
    remove: async recordId => {
      for (const record of serializer.snapshot()) {
        if (await opaqueId(record.logicalId) === recordId) {
          serializer.remove(record.logicalId);
          return;
        }
      }
    },
    subscribe: listener => {
      let stopped = false;
      let previousPromise = snapshot();
      let queued = Promise.resolve();
      const unsubscribe = serializer.subscribe(() => {
        queued = queued.then(async () => {
          const previous = await previousPromise;
          const current = await snapshot();
          previousPromise = Promise.resolve(current);
          if (stopped) return;

          const previousById = new Map(previous.map(record => [record.recordId, record]));
          const currentById = new Map(current.map(record => [record.recordId, record]));
          for (const record of current) {
            const before = previousById.get(record.recordId);
            if (!before || canonicalJson(before.value) !== canonicalJson(record.value))
              listener({ kind: 'put', recordType: serializer.recordType, recordId: record.recordId, schemaVersion: serializer.schemaVersion, value: record.value });
          }
          for (const record of previous) {
            if (!currentById.has(record.recordId))
              listener({ kind: 'delete', recordType: serializer.recordType, recordId: record.recordId, schemaVersion: serializer.schemaVersion });
          }
        });
      });
      return () => {
        stopped = true;
        unsubscribe();
      };
    },
  };
}

const logicalSerializers: readonly PrivateProVaultLogicalSerializer<unknown>[] = [
  privateProVaultCredentialSerializer,
  privateProVaultModelSerializer,
  privateProVaultSettingsSerializer,
  privateProVaultChatSerializer,
  privateProVaultPersonaSerializer,
  privateProVaultFolderSerializer,
  privateProVaultScratchSerializer,
];

const activeSerializers: PrivateProVaultSerializer<unknown>[] = [];
export const privateProVaultSerializers: readonly PrivateProVaultSerializer<unknown>[] = activeSerializers;

export function createPrivateProVaultSerializers(identifierKey: CryptoKey): readonly PrivateProVaultSerializer<unknown>[] {
  const serializers = logicalSerializers.map(serializer => bindSerializer(serializer, identifierKey));
  activeSerializers.splice(0, activeSerializers.length, ...serializers);
  return serializers;
}
