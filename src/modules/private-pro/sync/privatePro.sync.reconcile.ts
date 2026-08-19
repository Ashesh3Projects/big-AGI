import { privateProCanonicalJson, privateProContentHash, privateProRecordKey } from './privatePro.sync.codec';
import type {
  PrivateProLocalRecordState,
  PrivateProSyncDB,
  PrivateProSyncRecordIdentity,
} from './privatePro.sync.db';
import type {
  PrivateProSyncPreparedRecord,
  PrivateProSyncSerializedRecord,
  PrivateProSyncSerializer,
} from './privatePro.sync.serializers';
import type { PrivateProSyncRecordType } from './privatePro.sync.schemas';
import type { PrivateProSyncRemoteEvent, PrivateProSyncRemoteRecord } from './privatePro.sync.transport';


export interface PrivateProSyncLocalOrigin {
  captureId: string;
  projectionKey: string;
  editVersion: number;
  generation: number | null;
  mutationId: string | null;
  dirty: boolean;
}

export interface PrivateProSyncCommittedMarker {
  recordKey: string;
  generation: number;
  mutationId: string;
  revision: number;
  deleted: boolean;
}

export interface PrivateProSyncReconcilerDependencies {
  uid: string;
  writerId: string;
  serializers: readonly PrivateProSyncSerializer<unknown>[];
  db: PrivateProSyncDB;
  localOrigins: Map<string, PrivateProSyncLocalOrigin>;
  committedMarkers?: Map<string, PrivateProSyncCommittedMarker>;
  projectionVersions?: Map<string, number>;
  outbound: Pick<{ handleCommitted(mutationId: string, revision: number): Promise<void> }, 'handleCommitted'>;
  runSuppressed<T>(callback: () => Promise<T> | T): Promise<T> | T;
  isEpochActive?: (epoch: number) => boolean;
  now?: () => number;
  onError?: (category: 'schema' | 'offline' | 'permission' | 'quota' | 'unknown') => void;
}

export interface PrivateProSyncReconciler {
  applyCached(epoch?: number): Promise<void>;
  handle(event: PrivateProSyncRemoteEvent, epoch?: number): Promise<void>;
}

interface ValidatedRecord {
  prepared: PrivateProSyncPreparedRecord;
  serialized: PrivateProSyncSerializedRecord;
  serializer: PrivateProSyncSerializer<unknown>;
}

function chatProjectionKey(recordType: PrivateProSyncRecordType, logicalId: string): string | null {
  if (recordType === 'chat-meta') return logicalId;
  if (recordType !== 'chat-message') return null;
  const separator = logicalId.indexOf('\0');
  return separator > 0 ? logicalId.slice(0, separator) : null;
}

function messageOrder(record: PrivateProSyncSerializedRecord): readonly [number, string] {
  if (record.recordType !== 'chat-message' || typeof record.value !== 'object' || record.value === null)
    return [Number.NEGATIVE_INFINITY, record.logicalId];
  const value = record.value as { message?: { created?: unknown; id?: unknown }; created?: unknown; id?: unknown };
  const created = typeof value.message?.created === 'number' ? value.message.created : typeof value.created === 'number' ? value.created : 0;
  const id = typeof value.message?.id === 'string' ? value.message.id : typeof value.id === 'string' ? value.id : record.logicalId;
  return [created, id];
}

function sortProjectionRecords(records: PrivateProSyncSerializedRecord[]): void {
  records.sort((left, right) => {
    if (left.recordType === 'chat-meta' && right.recordType !== 'chat-meta') return -1;
    if (right.recordType === 'chat-meta' && left.recordType !== 'chat-meta') return 1;
    const [leftCreated, leftId] = messageOrder(left);
    const [rightCreated, rightId] = messageOrder(right);
    return leftCreated - rightCreated || leftId.localeCompare(rightId);
  });
}

export function createPrivateProSyncReconciler(dependencies: PrivateProSyncReconcilerDependencies): PrivateProSyncReconciler {
  const now = dependencies.now ?? Date.now;
  const serializers = new Map(dependencies.serializers.map(serializer => [serializer.recordType, serializer]));
  const projectionVersions = dependencies.projectionVersions ?? new Map<string, number>();
  const committedMarkers = dependencies.committedMarkers ?? new Map<string, PrivateProSyncCommittedMarker>();

  function advanceProjection(projectionKey: string): number {
    const version = (projectionVersions.get(projectionKey) ?? 0) + 1;
    projectionVersions.set(projectionKey, version);
    return version;
  }

  function serializerFor(recordType: PrivateProSyncRecordType): PrivateProSyncSerializer<unknown> {
    const serializer = serializers.get(recordType);
    if (!serializer) throw new TypeError('Private Pro sync record has no serializer.');
    return serializer;
  }

  async function validateRemote(canonical: PrivateProSyncRemoteRecord): Promise<ValidatedRecord> {
    const serializer = serializerFor(canonical.recordType);
    if (canonical.deleted || canonical.schemaVersion !== serializer.schemaVersion ||
        privateProRecordKey(canonical.recordType, canonical.logicalId) !== canonical.recordKey)
      throw new TypeError('Private Pro sync remote record identity is invalid.');
    const parsed = JSON.parse(canonical.payload) as unknown;
    const value = await serializer.validate(canonical.logicalId, parsed);
    if (privateProCanonicalJson(value) !== canonical.payload || await privateProContentHash(canonical.payload) !== canonical.contentHash)
      throw new TypeError('Private Pro sync remote payload is not canonical.');
    const projected = serializer.project(canonical.logicalId, value);
    const prepared: PrivateProSyncPreparedRecord = {
      recordType: canonical.recordType,
      logicalId: canonical.logicalId,
      recordKey: canonical.recordKey,
      projectionKey: projected.projectionKey,
      schemaVersion: canonical.schemaVersion,
      payload: canonical.payload,
      contentHash: canonical.contentHash,
      referencedAssetIds: [...projected.referencedAssetIds],
    };
    return {
      prepared,
      serializer,
      serialized: { ...prepared, value },
    };
  }

  async function deserializeLocal(record: PrivateProLocalRecordState): Promise<PrivateProSyncSerializedRecord> {
    const serializer = serializerFor(record.recordType);
    const value = await serializer.validate(record.logicalId, JSON.parse(record.payload) as unknown);
    const projected = serializer.project(record.logicalId, value);
    if (projected.projectionKey !== record.projectionKey)
      throw new TypeError('Private Pro sync cached projection identity is invalid.');
    return {
      recordType: record.recordType,
      logicalId: record.logicalId,
      projectionKey: record.projectionKey,
      schemaVersion: record.schemaVersion,
      value,
      referencedAssetIds: [...projected.referencedAssetIds],
    };
  }

  async function projectionRecords(
    projectionKey: string,
    override?: PrivateProSyncSerializedRecord,
    excludeRecordKey?: string,
  ): Promise<PrivateProSyncSerializedRecord[]> {
    const records = await dependencies.db.listProjectionRecords(dependencies.uid, projectionKey);
    const values = await Promise.all(records
      .filter(record => record.recordKey !== excludeRecordKey && record.recordKey !== (override ? privateProRecordKey(override.recordType, override.logicalId) : ''))
      .map(deserializeLocal));
    if (override) values.push(override);
    sortProjectionRecords(values);
    return values;
  }

  async function materialize(
    projectionKey: string,
    preferredSerializer?: PrivateProSyncSerializer<unknown>,
    options: { override?: PrivateProSyncSerializedRecord; excludeRecordKey?: string; epoch?: number } = {},
  ): Promise<void> {
    const version = projectionVersions.get(projectionKey) ?? 0;
    const originVersions = new Map([...dependencies.localOrigins.entries()]
      .filter(([, origin]) => origin.projectionKey === projectionKey)
      .map(([recordKey, origin]) => [recordKey, origin.editVersion]));
    const epoch = options.epoch ?? 0;
    if (dependencies.isEpochActive && !dependencies.isEpochActive(epoch)) return;
    const records = await projectionRecords(projectionKey, options.override, options.excludeRecordKey);
    const isChat = records.some(record => record.recordType === 'chat-meta' || record.recordType === 'chat-message') ||
      preferredSerializer?.recordType === 'chat-meta' || preferredSerializer?.recordType === 'chat-message';
    const missingChatMeta = isChat && !records.some(record => record.recordType === 'chat-meta');
    if (missingChatMeta && preferredSerializer?.recordType !== 'chat-meta') return;
    const projections = new Set(records.map(record => serializerFor(record.recordType).projection));
    if (preferredSerializer) projections.add(preferredSerializer.projection);
    for (const projection of projections) {
      if ((projectionVersions.get(projectionKey) ?? 0) !== version) return;
      if ([...dependencies.localOrigins.entries()].some(([recordKey, origin]) =>
        origin.projectionKey === projectionKey && origin.editVersion !== originVersions.get(recordKey))) return;
      if (dependencies.isEpochActive && !dependencies.isEpochActive(epoch)) return;
      const applying = dependencies.runSuppressed(() => records.length && !missingChatMeta
        ? projection.apply(projectionKey, records)
        : projection.remove(projectionKey));
      await applying;
      if ((projectionVersions.get(projectionKey) ?? 0) !== version) return;
      if (dependencies.isEpochActive && !dependencies.isEpochActive(epoch)) return;
    }
  }

  async function quarantine(recordKey: string, reasonCode: string): Promise<void> {
    await dependencies.db.quarantineRemote(dependencies.uid, recordKey, reasonCode, now());
    dependencies.onError?.('schema');
  }

  async function handleRecord(canonical: PrivateProSyncRemoteRecord, epoch: number): Promise<void> {
    const currentBase = await dependencies.db.getRemoteBase(dependencies.uid, canonical.recordKey);
    if (currentBase && currentBase.revision > canonical.revision) return;
    let validated: ValidatedRecord;
    try {
      validated = await validateRemote(canonical);
    } catch {
      await quarantine(canonical.recordKey, 'invalid-payload');
      return;
    }
    const editVersion = projectionVersions.get(validated.prepared.projectionKey) ?? 0;

    const existing = await dependencies.db.getLocalRecord(dependencies.uid, canonical.recordKey);
    if (canonical.recordType === 'chat-message' && existing && !existing.deleted &&
        existing.contentHash !== null && existing.contentHash !== canonical.contentHash) {
      await quarantine(canonical.recordKey, 'message-id-collision');
      return;
    }

    const origin = dependencies.localOrigins.get(canonical.recordKey);
    const marker = committedMarkers.get(canonical.recordKey);
    if (marker && canonical.revision > marker.revision) committedMarkers.delete(canonical.recordKey);
    const exactMarker = canonical.writerId === dependencies.writerId && marker?.mutationId === canonical.mutationId && marker.revision === canonical.revision;
    const sameTabMutation = canonical.writerId === dependencies.writerId && origin?.mutationId === canonical.mutationId;
    if (exactMarker) return;
    if (sameTabMutation) {
      await dependencies.db.setEffectiveRemoteBase(dependencies.uid, canonical.recordKey, {
        revision: canonical.revision,
        mutationId: canonical.mutationId,
        deleted: false,
      });
      await dependencies.outbound.handleCommitted(canonical.mutationId, canonical.revision);
      if (dependencies.localOrigins.get(canonical.recordKey) === origin) dependencies.localOrigins.delete(canonical.recordKey);
      committedMarkers.set(canonical.recordKey, {
        recordKey: canonical.recordKey, generation: origin.generation ?? 0, mutationId: canonical.mutationId,
        revision: canonical.revision, deleted: false,
      });
      return;
    }

    const effectiveBase = await dependencies.db.commitRemoteRecord(dependencies.uid, validated.prepared, {
      revision: canonical.revision,
      mutationId: canonical.mutationId,
      deleted: false,
    }, now());
    if (effectiveBase.revision !== canonical.revision || effectiveBase.deleted) return;
    if ((projectionVersions.get(validated.prepared.projectionKey) ?? 0) !== editVersion) return;
    if (origin) return;
    advanceProjection(validated.prepared.projectionKey);
    await materialize(validated.prepared.projectionKey, validated.serializer, { override: validated.serialized, epoch });
  }

  async function handleTombstone(event: Extract<PrivateProSyncRemoteEvent, { type: 'tombstone' }>, epoch: number): Promise<void> {
    const { tombstone } = event;
    if (privateProRecordKey(tombstone.recordType, tombstone.logicalId) !== tombstone.recordKey) {
      await quarantine(tombstone.recordKey, 'invalid-tombstone');
      return;
    }
    const serializer = serializers.get(tombstone.recordType);
    if (!serializer) {
      await quarantine(tombstone.recordKey, 'invalid-tombstone');
      return;
    }
    const local = await dependencies.db.getLocalRecord(dependencies.uid, tombstone.recordKey);
    const projectionKey = local?.projectionKey ?? chatProjectionKey(tombstone.recordType, tombstone.logicalId) ?? tombstone.logicalId;
    const editVersion = projectionVersions.get(projectionKey) ?? 0;
    const identity: PrivateProSyncRecordIdentity = {
      recordType: tombstone.recordType,
      logicalId: tombstone.logicalId,
      recordKey: tombstone.recordKey,
      projectionKey,
      schemaVersion: local?.schemaVersion ?? serializer.schemaVersion,
    };
    const remoteBase = { revision: tombstone.deletedRevision, mutationId: tombstone.mutationId, deleted: true } as const;
    const effectiveBase = await dependencies.db.commitRemoteTombstone(dependencies.uid, identity, remoteBase, now());
    if (effectiveBase.revision !== remoteBase.revision || !effectiveBase.deleted) return;
    await dependencies.db.discardAcrossTombstone(dependencies.uid, tombstone.recordKey, remoteBase);
    if ((projectionVersions.get(projectionKey) ?? 0) !== editVersion) return;
    const origin = dependencies.localOrigins.get(tombstone.recordKey);
    if (tombstone.writerId === dependencies.writerId && origin?.mutationId === tombstone.mutationId) {
      await dependencies.outbound.handleCommitted(tombstone.mutationId, tombstone.deletedRevision);
      if (dependencies.localOrigins.get(tombstone.recordKey) === origin) dependencies.localOrigins.delete(tombstone.recordKey);
    }
    if (origin) return;
    advanceProjection(projectionKey);
    await materialize(projectionKey, serializer, { excludeRecordKey: tombstone.recordKey, epoch });
  }

  return {
    async applyCached(epoch = 0): Promise<void> {
      const local = (await dependencies.db.listLocalRecords(dependencies.uid)).filter(record => !record.deleted);
      const projections = new Map<string, PrivateProLocalRecordState[]>();
      for (const record of local) {
        const records = projections.get(record.projectionKey) ?? [];
        records.push(record);
        projections.set(record.projectionKey, records);
      }
      for (const [projectionKey, records] of projections) {
        if (records.some(record => dependencies.localOrigins.has(record.recordKey))) continue;
        try {
          await materialize(projectionKey, serializerFor(records[0].recordType), { epoch });
        } catch {
          await quarantine(records[0].recordKey, 'invalid-cache');
        }
      }
    },

    async handle(event, epoch = 0): Promise<void> {
      if (event.type === 'record') return handleRecord(event.canonical, epoch);
      if (event.type === 'tombstone') return handleTombstone(event, epoch);
      if (event.type === 'invalid-document') return quarantine(event.recordKey, event.reason);
      if (event.type === 'error') dependencies.onError?.(event.category);
    },
  };
}
