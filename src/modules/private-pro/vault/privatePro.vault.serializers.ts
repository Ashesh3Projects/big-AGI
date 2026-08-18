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

export type PrivateProVaultConflictPolicy = 'replace' | 'conflict-copy' | 'manual';

export interface PrivateProVaultSerializer<T> {
  recordType: PrivateProVaultRecordType;
  schemaVersion: number;
  conflictPolicy: PrivateProVaultConflictPolicy;
  snapshot(): Promise<Array<{ recordId: string; value: T }>>;
  validate(recordId: string, value: unknown): Promise<T>;
  apply(recordId: string, value: T): Promise<void>;
  remove(recordId: string): Promise<void>;
  removeIfVersion?(recordId: string, expectedVersion: string): Promise<boolean>;
  createConflictCopy?(value: T): Promise<{ recordId: string; value: T }>;
  subscribe(listener: (mutation: PrivateProPortableMutation) => void): () => void;
}

export interface PrivateProVaultLogicalSerializer<T> {
  recordType: PrivateProVaultRecordType;
  schemaVersion: number;
  conflictPolicy?: PrivateProVaultConflictPolicy;
  schema: z.ZodType<T>;
  logicalId(value: T): string;
  snapshot(): Array<{ logicalId: string; value: T }>;
  apply(logicalId: string, value: T): void;
  remove(logicalId: string): void;
  createConflictCopy?(value: T): T;
  subscribe(listener: () => void): () => void;
}


const serializerLocks = new Map<PrivateProVaultRecordType, { tail: Promise<void> }>();

function withSerializerLock<T>(recordType: PrivateProVaultRecordType, operation: () => Promise<T> | T): Promise<T> {
  const state = serializerLocks.get(recordType) ?? { tail: Promise.resolve() };
  serializerLocks.set(recordType, state);
  const previous = state.tail;
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  state.tail = previous.then(() => current);
  return previous.then(operation).finally(() => {
    release();
    if (state.tail === current) serializerLocks.delete(recordType);
  });
}

async function valueVersion(value: unknown): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value))));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}


function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function bindSerializer<T>(
  serializer: PrivateProVaultLogicalSerializer<T>,
  identifierKey: CryptoKey,
): PrivateProVaultSerializer<T> {
  const opaqueId = (logicalId: string) => privateProVaultRecordId(identifierKey, serializer.recordType, logicalId);

  const snapshotUnlocked = async () => Promise.all(serializer.snapshot().map(async record => ({
    recordId: await opaqueId(record.logicalId),
    value: serializer.schema.parse(record.value),
  })));
  const snapshot = () => withSerializerLock(serializer.recordType, snapshotUnlocked);

  const validate = async (recordId: string, input: unknown) => {
    const value = serializer.schema.parse(input);
    const logicalId = serializer.logicalId(value);
    await assertPrivateProVaultRecordId(identifierKey, serializer.recordType, logicalId, recordId);
    return value;
  };

  return {
    recordType: serializer.recordType,
    schemaVersion: serializer.schemaVersion,
    conflictPolicy: serializer.conflictPolicy ?? 'manual',
    snapshot,
    validate,
    apply: (recordId, input) => withSerializerLock(serializer.recordType, async () => {
      const value = await validate(recordId, input);
      const logicalId = serializer.logicalId(value);
      serializer.apply(logicalId, value);
    }),
    remove: recordId => withSerializerLock(serializer.recordType, async () => {
      for (const record of serializer.snapshot()) {
        if (await opaqueId(record.logicalId) === recordId) {
          serializer.remove(record.logicalId);
          return;
        }
      }
    }),
    removeIfVersion: (recordId, expectedVersion) => withSerializerLock(serializer.recordType, async () => {
      for (const record of serializer.snapshot()) {
        if (await opaqueId(record.logicalId) !== recordId) continue;
        const value = serializer.schema.parse(record.value);
        if (await valueVersion(value) !== expectedVersion) return false;
        serializer.remove(record.logicalId);
        return true;
      }
      return false;
    }),
    ...(serializer.createConflictCopy ? {
      createConflictCopy: async (input: T) => {
        const value = serializer.schema.parse(serializer.createConflictCopy!(serializer.schema.parse(input)));
        const recordId = await opaqueId(serializer.logicalId(value));
        return { recordId, value };
      },
    } : {}),
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
