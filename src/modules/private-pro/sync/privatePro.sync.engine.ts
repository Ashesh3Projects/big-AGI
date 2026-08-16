import type { PrivateProEntityType } from './privatePro.sync.repository';
import type { PrivateProOutboxOperation, PrivateProSyncDB } from './privatePro.sync.db';


export interface PrivateProLocalEntity {
  entityType: PrivateProEntityType;
  entityId: string;
  contentHash: string;
  payload: unknown;
}

export interface PrivateProLocalStorePort {
  snapshot(): Promise<PrivateProLocalEntity[]>;
  get(entityType: PrivateProEntityType, entityId: string): Promise<PrivateProLocalEntity | null>;
  applyUpsert(entity: PrivateProLocalEntity): Promise<void>;
  applyDelete(entityType: PrivateProEntityType, entityId: string): Promise<void>;
  createConflictCopy(source: PrivateProLocalEntity): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export type PrivateProRemoteEvent =
  | { kind: 'upsert'; revision: number; entity: PrivateProLocalEntity }
  | { kind: 'delete'; entityType: PrivateProEntityType; entityId: string; revision: number };

export type PrivateProRemoteMutationResult =
  | { status: 'committed'; revision: number }
  | { status: 'deleted'; revision: number }
  | { status: 'unchanged'; revision: number }
  | { status: 'conflict'; currentRevision: number; currentHash: string | null };

export interface PrivateProSyncTransport {
  upsert(operation: {
    operationId: string;
    entityType: PrivateProEntityType;
    entityId: string;
    contentHash: string;
    payload: unknown;
    baseRevision: number;
    deviceId: string;
  }): Promise<PrivateProRemoteMutationResult>;
  delete(operation: {
    operationId: string;
    entityType: PrivateProEntityType;
    entityId: string;
    baseRevision: number;
    deviceId: string;
  }): Promise<PrivateProRemoteMutationResult>;
  fetch(entityType: PrivateProEntityType, entityId: string): Promise<PrivateProRemoteEvent | null>;
  subscribe(uid: string, listener: (event: PrivateProRemoteEvent) => void): () => void;
}

export type PrivateProSyncStartResult = 'started' | 'already-started' | 'binding-conflict';

export interface PrivateProSyncEngine {
  start(): Promise<PrivateProSyncStartResult>;
  stop(): void;
  scanNow(): Promise<void>;
  retryNow(): Promise<void>;
  whenIdle(): Promise<void>;
}

interface PrivateProSyncEngineDependencies {
  uid: string;
  deviceId: string;
  db: PrivateProSyncDB;
  store: PrivateProLocalStorePort;
  transport: PrivateProSyncTransport;
  now?: () => number;
}

const LEASE_MS = 30_000;
const RETRY_DELAY_MS = 5_000;

function entityKey(entityType: PrivateProEntityType, entityId: string): string {
  return `${entityType}:${entityId}`;
}

function validHash(hash: string): boolean {
  return /^[a-f0-9]{64}$/.test(hash);
}

function assertLocalEntity(value: PrivateProLocalEntity): void {
  if (!['chat', 'persona'].includes(value.entityType) || !value.entityId || !validHash(value.contentHash) || value.payload === undefined)
    throw new Error('Remote sync entity failed validation.');
}

function operationId(operation: PrivateProOutboxOperation): string {
  if (operation.id === undefined) throw new Error('Private sync operation is missing its ID.');
  return `sync-${operation.id.toString(36).padStart(8, '0')}`;
}

export function createPrivateProSyncEngine(deps: PrivateProSyncEngineDependencies): PrivateProSyncEngine {
  const now = deps.now ?? Date.now;
  let started = false;
  let stopped = false;
  let suppressLocalEvents = 0;
  let unsubscribeStore: (() => void) | undefined;
  let unsubscribeRemote: (() => void) | undefined;
  let work = Promise.resolve();

  const queue = (task: () => Promise<void>): Promise<void> => {
    work = work.then(task, task);
    return work;
  };

  const withRemoteApply = async (task: () => Promise<void>) => {
    suppressLocalEvents++;
    try {
      await task();
    } finally {
      suppressLocalEvents--;
    }
  };

  const recordRemoteState = async (event: PrivateProRemoteEvent) => {
    const type = event.kind === 'upsert' ? event.entity.entityType : event.entityType;
    const id = event.kind === 'upsert' ? event.entity.entityId : event.entityId;
    const hash = event.kind === 'upsert' ? event.entity.contentHash : '';
    await deps.db.putEntityState({
      uid: deps.uid,
      entityKey: entityKey(type, id),
      entityType: type,
      entityId: id,
      remoteRevision: event.revision,
      localHash: hash,
      remoteHash: event.kind === 'upsert' ? hash : null,
      updatedAtMs: now(),
    });
  };

  const applyRemote = async (event: PrivateProRemoteEvent) => {
    try {
      if (!Number.isInteger(event.revision) || event.revision <= 0) throw new Error('Remote revision is invalid.');
      if (event.kind === 'upsert') assertLocalEntity(event.entity);
      else if (!['chat', 'persona'].includes(event.entityType) || !event.entityId) throw new Error('Remote tombstone is invalid.');

      const type = event.kind === 'upsert' ? event.entity.entityType : event.entityType;
      const id = event.kind === 'upsert' ? event.entity.entityId : event.entityId;
      const key = entityKey(type, id);
      const [current, state] = await Promise.all([
        deps.store.get(type, id),
        deps.db.getEntityState(deps.uid, key),
      ]);
      if (state && event.revision <= state.remoteRevision) return;

      const hasUnsyncedLocal = !!current && (!state || current.contentHash !== state.localHash);
      if (hasUnsyncedLocal && (event.kind === 'delete' || current.contentHash !== event.entity.contentHash))
        await withRemoteApply(() => deps.store.createConflictCopy(current));

      await deps.db.discardOperationsForEntity(deps.uid, type, id);
      await withRemoteApply(() => event.kind === 'upsert'
        ? deps.store.applyUpsert(event.entity)
        : deps.store.applyDelete(type, id)
      );
      await recordRemoteState(event);
    } catch (error) {
      const type = event.kind === 'upsert' ? event.entity?.entityType : event.entityType;
      const id = event.kind === 'upsert' ? event.entity?.entityId : event.entityId;
      await deps.db.quarantineRemoteRecord({
        uid: deps.uid,
        entityKey: `${type || 'unknown'}:${id || 'unknown'}`,
        reason: error instanceof Error ? error.message : 'Invalid remote sync record.',
        payload: structuredClone(event),
        createdAtMs: now(),
      });
    }
  };

  const enqueueEntity = async (entity: PrivateProLocalEntity, baseRevision: number) => {
    await deps.db.discardOperationsForEntity(deps.uid, entity.entityType, entity.entityId);
    await deps.db.enqueueOperation({
      uid: deps.uid,
      entityType: entity.entityType,
      entityId: entity.entityId,
      kind: 'upsert',
      baseRevision,
      contentHash: entity.contentHash,
      payload: structuredClone(entity.payload),
      deviceId: deps.deviceId,
      createdAtMs: now(),
    });
  };

  const scan = async () => {
    const localEntities = await deps.store.snapshot();
    const localKeys = new Set(localEntities.map(entity => entityKey(entity.entityType, entity.entityId)));
    for (const entity of localEntities) {
      assertLocalEntity(entity);
      const key = entityKey(entity.entityType, entity.entityId);
      const state = await deps.db.getEntityState(deps.uid, key);
      if (state) {
        if (state.localHash !== entity.contentHash)
          await enqueueEntity(entity, state.remoteRevision);
        continue;
      }

      await deps.db.recordMigrationItem({
        uid: deps.uid,
        entityType: entity.entityType,
        entityId: entity.entityId,
        status: 'pending',
        updatedAtMs: now(),
      });
      try {
        const remote = await deps.transport.fetch(entity.entityType, entity.entityId);
        if (remote) {
          if (remote.kind === 'upsert' && remote.entity.contentHash === entity.contentHash) {
            await recordRemoteState(remote);
            await deps.db.recordMigrationItem({ uid: deps.uid, entityType: entity.entityType, entityId: entity.entityId, status: 'complete', updatedAtMs: now() });
          } else {
            await applyRemote(remote);
            await deps.db.recordMigrationItem({ uid: deps.uid, entityType: entity.entityType, entityId: entity.entityId, status: 'complete', updatedAtMs: now() });
          }
        } else {
          await enqueueEntity(entity, 0);
        }
      } catch {
        await enqueueEntity(entity, 0);
      }
    }

    const knownStates = await deps.db.listEntityStates(deps.uid);
    for (const state of knownStates) {
      if (state.remoteHash === null || localKeys.has(state.entityKey)) continue;
      await deps.db.discardOperationsForEntity(deps.uid, state.entityType, state.entityId);
      await deps.db.enqueueOperation({
        uid: deps.uid,
        entityType: state.entityType,
        entityId: state.entityId,
        kind: 'delete',
        baseRevision: state.remoteRevision,
        contentHash: `delete-${state.remoteRevision}`,
        payload: null,
        deviceId: deps.deviceId,
        createdAtMs: now(),
      });
    }
  };

  const resolveConflict = async (operation: PrivateProOutboxOperation) => {
    const remote = await deps.transport.fetch(operation.entityType, operation.entityId);
    const local = await deps.store.get(operation.entityType, operation.entityId);
    if (local) await withRemoteApply(() => deps.store.createConflictCopy(local));
    if (remote) await applyRemote(remote);
    else {
      await deps.db.discardOperation(operation.id!);
      await deps.db.putEntityState({
        uid: deps.uid,
        entityKey: entityKey(operation.entityType, operation.entityId),
        entityType: operation.entityType,
        entityId: operation.entityId,
        remoteRevision: 0,
        localHash: '',
        remoteHash: null,
        updatedAtMs: now(),
      });
    }
  };

  const processOperation = async (operation: PrivateProOutboxOperation) => {
    if (operation.id === undefined) return;
    try {
      const result = operation.kind === 'upsert'
        ? await deps.transport.upsert({
          operationId: operationId(operation),
          entityType: operation.entityType,
          entityId: operation.entityId,
          contentHash: operation.contentHash,
          payload: structuredClone(operation.payload),
          baseRevision: operation.baseRevision,
          deviceId: operation.deviceId,
        })
        : await deps.transport.delete({
          operationId: operationId(operation),
          entityType: operation.entityType,
          entityId: operation.entityId,
          baseRevision: operation.baseRevision,
          deviceId: operation.deviceId,
        });

      if (result.status === 'conflict') {
        await resolveConflict(operation);
        return;
      }

      const remoteHash = operation.kind === 'upsert' ? operation.contentHash : null;
      await deps.db.ackOperation(operation.id, {
        uid: deps.uid,
        entityKey: entityKey(operation.entityType, operation.entityId),
        entityType: operation.entityType,
        entityId: operation.entityId,
        remoteRevision: result.revision,
        localHash: operation.kind === 'upsert' ? operation.contentHash : '',
        remoteHash,
        updatedAtMs: now(),
      });
      await deps.db.recordMigrationItem({
        uid: deps.uid,
        entityType: operation.entityType,
        entityId: operation.entityId,
        status: 'complete',
        updatedAtMs: now(),
      });
    } catch (error) {
      await deps.db.retryOperation(operation.id, error instanceof Error ? error.message : 'Private sync failed.', now(), RETRY_DELAY_MS);
    }
  };

  const drain = async () => {
    while (!stopped) {
      const operation = await deps.db.leaseNextOperation(deps.uid, now(), LEASE_MS);
      if (!operation) return;
      await processOperation(operation);
    }
  };

  const scanAndDrain = async () => {
    await scan();
    await drain();
  };

  return {
    async start() {
      if (started) return 'already-started';
      const binding = await deps.db.bindVault(deps.uid, now());
      if (binding.status === 'binding-conflict') return 'binding-conflict';
      started = true;
      stopped = false;
      unsubscribeStore = deps.store.subscribe(() => {
        if (!suppressLocalEvents && !stopped) void queue(scanAndDrain);
      });
      unsubscribeRemote = deps.transport.subscribe(deps.uid, event => {
        if (!stopped) void queue(() => applyRemote(event));
      });
      void queue(scanAndDrain);
      return 'started';
    },

    stop() {
      stopped = true;
      started = false;
      unsubscribeStore?.();
      unsubscribeRemote?.();
      unsubscribeStore = undefined;
      unsubscribeRemote = undefined;
    },

    scanNow() {
      return queue(scanAndDrain);
    },

    retryNow() {
      return queue(async () => {
        await deps.db.makeOperationsDue(deps.uid, now());
        await drain();
      });
    },

    async whenIdle() {
      while (true) {
        const current = work;
        await current;
        if (current === work) return;
      }
    },
  };
}
