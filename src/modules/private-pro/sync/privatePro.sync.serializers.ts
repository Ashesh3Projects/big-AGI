import type * as z from 'zod/v4';

import type { PrivateProSyncRecordType } from './privatePro.sync.schemas';
import { privateProCanonicalJson } from './privatePro.sync.codec';
import { privateProSyncChatMessageSerializer, privateProSyncChatMetaSerializer, privateProSyncChatProjection } from './serializers/chat';
import { privateProSyncFolderSerializer } from './serializers/folder';
import { privateProSyncCredentialSerializer, privateProSyncModelSerializer } from './serializers/models';
import { privateProSyncPersonaSerializer } from './serializers/persona';
import { privateProSyncScratchSerializer } from './serializers/scratch';
import { privateProSyncSettingsSerializer } from './serializers/settings';


export interface PrivateProSyncSerializedRecord<T = unknown> {
  recordType: PrivateProSyncRecordType;
  logicalId: string;
  projectionKey: string;
  schemaVersion: number;
  value: T;
  referencedAssetIds: readonly string[];
}

export interface PrivateProSyncPreparedRecord {
  recordType: PrivateProSyncRecordType;
  logicalId: string;
  recordKey: string;
  projectionKey: string;
  schemaVersion: number;
  payload: string;
  contentHash: string;
  referencedAssetIds: readonly string[];
}

export type PrivateProSyncLocalMutation =
  | { kind: 'put'; record: PrivateProSyncSerializedRecord }
  | { kind: 'delete'; recordType: PrivateProSyncRecordType; logicalId: string; projectionKey: string; schemaVersion: number };

export interface PrivateProSyncSerializer<T> {
  recordType: PrivateProSyncRecordType;
  schemaVersion: number;
  conflictPolicy: 'replace' | 'message-identity';
  snapshot(): Promise<readonly PrivateProSyncSerializedRecord<T>[]>;
  validate(logicalId: string, value: unknown): Promise<T>;
  project(logicalId: string, value: T): { projectionKey: string; referencedAssetIds: readonly string[] };
  projection: PrivateProSyncProjection;
  subscribe(listener: (mutation: PrivateProSyncLocalMutation) => void): () => void;
}

export interface PrivateProSyncProjection {
  apply(projectionKey: string, records: readonly PrivateProSyncSerializedRecord[]): Promise<void>;
  remove(projectionKey: string): Promise<void>;
}

export interface PrivateProSyncLogicalSerializer<T> {
  recordType: PrivateProSyncRecordType;
  schemaVersion: number;
  conflictPolicy?: 'replace' | 'message-identity';
  schema: z.ZodType<T>;
  logicalId(value: T): string;
  projectionKey(value: T): string;
  referencedAssetIds?(value: T): readonly string[];
  snapshot(): readonly { logicalId: string; value: T }[];
  apply(logicalId: string, value: T): void;
  remove(logicalId: string): void;
  subscribe(listener: () => void): () => void;
}

function bindSerializer<T>(serializer: PrivateProSyncLogicalSerializer<T>): PrivateProSyncSerializer<T> {
  const snapshotNow = (): readonly PrivateProSyncSerializedRecord<T>[] => serializer.snapshot().map(({ logicalId, value }) => ({
    recordType: serializer.recordType,
    logicalId,
    projectionKey: serializer.projectionKey(value),
    schemaVersion: serializer.schemaVersion,
    value: structuredClone(value),
    referencedAssetIds: serializer.referencedAssetIds?.(value) ?? [],
  }));

  const projection: PrivateProSyncProjection = serializer.recordType === 'chat-meta' || serializer.recordType === 'chat-message'
    ? privateProSyncChatProjection
    : {
      apply: async (projectionKey, records) => {
        const record = records.find(candidate => candidate.recordType === serializer.recordType && candidate.projectionKey === projectionKey);
        if (record) serializer.apply(record.logicalId, serializer.schema.parse(record.value));
        else serializer.remove(projectionKey);
      },
      remove: async projectionKey => serializer.remove(projectionKey),
    };

  return {
    recordType: serializer.recordType,
    schemaVersion: serializer.schemaVersion,
    conflictPolicy: serializer.conflictPolicy ?? 'replace',
    snapshot: () => Promise.resolve(snapshotNow()),
    validate: async (logicalId, input) => {
      const value = serializer.schema.parse(input);
      if (serializer.logicalId(value) !== logicalId)
        throw new TypeError('Private Pro sync record logical ID does not match its payload.');
      return value;
    },
    project: (logicalId, value) => {
      if (serializer.logicalId(value) !== logicalId)
        throw new TypeError('Private Pro sync record logical ID does not match its payload.');
      return {
        projectionKey: serializer.projectionKey(value),
        referencedAssetIds: serializer.referencedAssetIds?.(value) ?? [],
      };
    },
    projection,
    subscribe: listener => {
      let stopped = false;
      let emitting = false;
      let pending = false;
      let previous = snapshotNow();
      const unsubscribe = serializer.subscribe(() => {
        if (emitting) {
          pending = true;
          return;
        }
        do {
          pending = false;
          const current = snapshotNow();
          if (stopped) return;

          const previousById = new Map(previous.map(record => [record.logicalId, record]));
          const currentById = new Map(current.map(record => [record.logicalId, record]));
          const mutations: PrivateProSyncLocalMutation[] = [];
          for (const record of current) {
            const before = previousById.get(record.logicalId);
            if (!before || privateProCanonicalJson(before.value) !== privateProCanonicalJson(record.value)) mutations.push({ kind: 'put', record });
          }
          for (const record of previous) {
            if (!currentById.has(record.logicalId))
              mutations.push({ kind: 'delete', recordType: serializer.recordType, logicalId: record.logicalId, projectionKey: record.projectionKey, schemaVersion: serializer.schemaVersion });
          }
          previous = current;
          emitting = true;
          try {
            mutations.forEach(listener);
          } finally {
            emitting = false;
          }
        } while (pending && !stopped);
      });
      return () => {
        stopped = true;
        unsubscribe();
      };
    },
  };
}

const logicalSerializers: readonly PrivateProSyncLogicalSerializer<unknown>[] = [
  privateProSyncCredentialSerializer,
  privateProSyncModelSerializer,
  privateProSyncSettingsSerializer,
  privateProSyncChatMetaSerializer,
  privateProSyncChatMessageSerializer,
  privateProSyncPersonaSerializer,
  privateProSyncFolderSerializer,
  privateProSyncScratchSerializer,
];

export { privateProSyncChatProjection };

export function createPrivateProSyncSerializers(extraSerializers: readonly PrivateProSyncSerializer<unknown>[] = []): readonly PrivateProSyncSerializer<unknown>[] {
  return [...logicalSerializers.map(serializer => bindSerializer(serializer)), ...extraSerializers];
}
