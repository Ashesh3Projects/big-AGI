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
  outbound: Pick<{ handleCommitted(mutationId: string, revision: number, signal?: AbortSignal): Promise<void> }, 'handleCommitted'>;
  runSuppressed<T>(projectionKey: string, callback: () => Promise<T> | T): Promise<T> | T;
  isEpochActive?: (epoch: number) => boolean;
  now?: () => number;
  onError?: (category: 'schema' | 'offline' | 'permission' | 'quota' | 'unknown') => void;
  onHydrate?(assetIds: readonly string[], epoch: number): void;
}

export interface PrivateProSyncReconciler {
  applyCached(epoch?: number, signal?: AbortSignal): Promise<void>;
  handle(event: PrivateProSyncRemoteEvent, epoch?: number, signal?: AbortSignal): Promise<void>;
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

  function stopped(epoch: number, signal?: AbortSignal): boolean {
    return !!signal?.aborted || !!dependencies.isEpochActive && !dependencies.isEpochActive(epoch);
  }

  function assertActive(epoch: number, signal?: AbortSignal): void {
    if (stopped(epoch, signal)) throw new DOMException('Private Pro sync reconciliation stopped.', 'AbortError');
  }

  function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError'
      || error instanceof Error && error.name === 'AbortError';
  }

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

  async function validateRemote(canonical: PrivateProSyncRemoteRecord, epoch: number, signal?: AbortSignal): Promise<ValidatedRecord> {
    assertActive(epoch, signal);
    const serializer = serializerFor(canonical.recordType);
    if (canonical.deleted || canonical.schemaVersion !== serializer.schemaVersion ||
        privateProRecordKey(canonical.recordType, canonical.logicalId) !== canonical.recordKey)
      throw new TypeError('Private Pro sync remote record identity is invalid.');
    const parsed = JSON.parse(canonical.payload) as unknown;
    const value = await serializer.validate(canonical.logicalId, parsed);
    assertActive(epoch, signal);
    const contentHash = await privateProContentHash(canonical.payload);
    assertActive(epoch, signal);
    if (privateProCanonicalJson(value) !== canonical.payload || contentHash !== canonical.contentHash)
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

  async function deserializeLocal(record: PrivateProLocalRecordState, epoch: number, signal?: AbortSignal): Promise<PrivateProSyncSerializedRecord> {
    assertActive(epoch, signal);
    const serializer = serializerFor(record.recordType);
    const value = await serializer.validate(record.logicalId, JSON.parse(record.payload) as unknown);
    assertActive(epoch, signal);
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
    epoch = 0,
    signal?: AbortSignal,
  ): Promise<PrivateProSyncSerializedRecord[]> {
    const records = await dependencies.db.listProjectionRecords(dependencies.uid, projectionKey);
    assertActive(epoch, signal);
    const values = await Promise.all(records
      .filter(record => record.recordKey !== excludeRecordKey && record.recordKey !== (override ? privateProRecordKey(override.recordType, override.logicalId) : ''))
      .map(record => deserializeLocal(record, epoch, signal)));
    assertActive(epoch, signal);
    if (override) values.push(override);
    sortProjectionRecords(values);
    return values;
  }

  async function materialize(
    projectionKey: string,
    preferredSerializer?: PrivateProSyncSerializer<unknown>,
    options: { override?: PrivateProSyncSerializedRecord; excludeRecordKey?: string; epoch?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    const version = projectionVersions.get(projectionKey) ?? 0;
    const originVersions = new Map([...dependencies.localOrigins.entries()]
      .filter(([, origin]) => origin.projectionKey === projectionKey)
      .map(([recordKey, origin]) => [recordKey, origin.editVersion]));
    const epoch = options.epoch ?? 0;
    const signal = options.signal;
    assertActive(epoch, signal);
    const records = await projectionRecords(projectionKey, options.override, options.excludeRecordKey, epoch, signal);
    assertActive(epoch, signal);
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
      assertActive(epoch, signal);
      const applying = dependencies.runSuppressed(projectionKey, () => records.length && !missingChatMeta
        ? projection.apply(projectionKey, records, signal)
        : projection.remove(projectionKey, signal));
      await applying;
      assertActive(epoch, signal);
      if ((projectionVersions.get(projectionKey) ?? 0) !== version) return;
      assertActive(epoch, signal);
    }
  }

  async function quarantine(recordKey: string, reasonCode: string, epoch: number, signal?: AbortSignal): Promise<void> {
    assertActive(epoch, signal);
    await dependencies.db.quarantineRemote(dependencies.uid, recordKey, reasonCode, now(), signal);
    assertActive(epoch, signal);
    dependencies.onError?.('schema');
  }

  async function handleRecord(canonical: PrivateProSyncRemoteRecord, epoch: number, signal?: AbortSignal): Promise<void> {
    assertActive(epoch, signal);
    const currentBase = await dependencies.db.getRemoteBase(dependencies.uid, canonical.recordKey);
    assertActive(epoch, signal);
    if (currentBase && currentBase.revision > canonical.revision) return;
    if (canonical.deleted) {
      await dependencies.db.observeRemoteBase(dependencies.uid, canonical.recordKey, {
        revision: canonical.revision,
        mutationId: canonical.mutationId,
        deleted: true,
      }, signal);
      assertActive(epoch, signal);
      return;
    }
    let validated: ValidatedRecord;
    try {
      validated = await validateRemote(canonical, epoch, signal);
    } catch (error) {
      if (stopped(epoch, signal) || isAbortError(error)) return;
      await quarantine(canonical.recordKey, 'invalid-payload', epoch, signal);
      return;
    }
    assertActive(epoch, signal);
    const editVersion = projectionVersions.get(validated.prepared.projectionKey) ?? 0;

    const existing = await dependencies.db.getLocalRecord(dependencies.uid, canonical.recordKey);
    assertActive(epoch, signal);
    if (canonical.recordType === 'chat-message' && existing && !existing.deleted &&
        existing.contentHash !== null && existing.contentHash !== canonical.contentHash) {
      await quarantine(canonical.recordKey, 'message-id-collision', epoch, signal);
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
      }, signal);
      assertActive(epoch, signal);
      await dependencies.outbound.handleCommitted(canonical.mutationId, canonical.revision, signal);
      assertActive(epoch, signal);
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
    }, now(), signal);
    assertActive(epoch, signal);
    if (effectiveBase.revision !== canonical.revision || effectiveBase.deleted) return;
    if ((projectionVersions.get(validated.prepared.projectionKey) ?? 0) !== editVersion) return;
    if (origin) return;
    advanceProjection(validated.prepared.projectionKey);
    await materialize(validated.prepared.projectionKey, validated.serializer, { override: validated.serialized, epoch, signal });
    assertActive(epoch, signal);
    dependencies.onHydrate?.(validated.prepared.referencedAssetIds, epoch);
  }

  async function handleTombstone(event: Extract<PrivateProSyncRemoteEvent, { type: 'tombstone' }>, epoch: number, signal?: AbortSignal): Promise<void> {
    assertActive(epoch, signal);
    const { tombstone } = event;
    if (privateProRecordKey(tombstone.recordType, tombstone.logicalId) !== tombstone.recordKey) {
      await quarantine(tombstone.recordKey, 'invalid-tombstone', epoch, signal);
      return;
    }
    const serializer = serializers.get(tombstone.recordType);
    if (!serializer) {
      await quarantine(tombstone.recordKey, 'invalid-tombstone', epoch, signal);
      return;
    }
    const marker = committedMarkers.get(tombstone.recordKey);
    if (marker && tombstone.deletedRevision > marker.revision) committedMarkers.delete(tombstone.recordKey);
    const exactMarker = tombstone.writerId === dependencies.writerId && marker?.deleted === true &&
      marker.mutationId === tombstone.mutationId && marker.revision === tombstone.deletedRevision;
    if (exactMarker) {
      await dependencies.db.setEffectiveRemoteBase(dependencies.uid, tombstone.recordKey, {
        revision: tombstone.deletedRevision,
        mutationId: tombstone.mutationId,
        deleted: true,
      }, signal);
      assertActive(epoch, signal);
      return;
    }
    const local = await dependencies.db.getLocalRecord(dependencies.uid, tombstone.recordKey);
    assertActive(epoch, signal);
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
    const effectiveBase = await dependencies.db.commitRemoteTombstone(dependencies.uid, identity, remoteBase, now(), signal);
    assertActive(epoch, signal);
    if (effectiveBase.revision !== remoteBase.revision || !effectiveBase.deleted) return;
    await dependencies.db.discardAcrossTombstone(dependencies.uid, tombstone.recordKey, remoteBase, signal);
    assertActive(epoch, signal);
    if ((projectionVersions.get(projectionKey) ?? 0) !== editVersion) return;
    const origin = dependencies.localOrigins.get(tombstone.recordKey);
    if (tombstone.writerId === dependencies.writerId && origin?.mutationId === tombstone.mutationId) {
      await dependencies.outbound.handleCommitted(tombstone.mutationId, tombstone.deletedRevision, signal);
      assertActive(epoch, signal);
      if (dependencies.localOrigins.get(tombstone.recordKey) === origin) dependencies.localOrigins.delete(tombstone.recordKey);
    }
    if (origin) return;
    advanceProjection(projectionKey);
    await materialize(projectionKey, serializer, { excludeRecordKey: tombstone.recordKey, epoch, signal });
  }

  return {
    async applyCached(epoch = 0, signal?: AbortSignal): Promise<void> {
      if (stopped(epoch, signal)) return;
      const local = (await dependencies.db.listLocalRecords(dependencies.uid)).filter(record => !record.deleted);
      if (stopped(epoch, signal)) return;
      const projections = new Map<string, PrivateProLocalRecordState[]>();
      for (const record of local) {
        const records = projections.get(record.projectionKey) ?? [];
        records.push(record);
        projections.set(record.projectionKey, records);
      }
      for (const [projectionKey, records] of projections) {
        if (records.some(record => dependencies.localOrigins.has(record.recordKey))) continue;
        try {
          await materialize(projectionKey, serializerFor(records[0].recordType), { epoch, signal });
          if (stopped(epoch, signal)) return;
          dependencies.onHydrate?.([...new Set(records.flatMap(record => record.referencedAssetIds))], epoch);
        } catch (error) {
          if (stopped(epoch, signal) || isAbortError(error)) return;
          await quarantine(records[0].recordKey, 'invalid-cache', epoch, signal);
        }
      }
    },

    async handle(event, epoch = 0, signal?: AbortSignal): Promise<void> {
      if (stopped(epoch, signal)) return;
      try {
        if (event.type === 'record') return await handleRecord(event.canonical, epoch, signal);
        if (event.type === 'tombstone') return await handleTombstone(event, epoch, signal);
        if (event.type === 'invalid-document') return await quarantine(event.recordKey, event.reason, epoch, signal);
        if (event.type === 'error' && !stopped(epoch, signal)) dependencies.onError?.(event.category);
      } catch (error) {
        if (stopped(epoch, signal) || isAbortError(error)) return;
        throw error;
      }
    },
  };
}
