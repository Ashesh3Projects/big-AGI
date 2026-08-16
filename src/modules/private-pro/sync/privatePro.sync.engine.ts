import type { PrivateProEntityType } from './privatePro.sync.repository';
import type { PrivateProOutboxOperation, PrivateProSyncDB } from './privatePro.sync.db';


export interface PrivateProLocalEntity {
  entityType: PrivateProEntityType;
  entityId: string;
  contentHash: string;
  payload: unknown;
  assetIds?: string[];
}

export interface PrivateProLocalStorePort {
  snapshot(): Promise<PrivateProLocalEntity[]>;
  get(entityType: PrivateProEntityType, entityId: string): Promise<PrivateProLocalEntity | null>;
  exists(entityType: PrivateProEntityType, entityId: string): Promise<boolean>;
  applyUpsert(entity: PrivateProLocalEntity): Promise<void>;
  applyDelete(entityType: PrivateProEntityType, entityId: string): Promise<void>;
  createConflictCopy(source: PrivateProLocalEntity): Promise<void>;
  prepareForUpload?(entity: PrivateProLocalEntity): Promise<void>;
  prepareForRemoteApply?(entity: PrivateProLocalEntity): Promise<void>;
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
export type PrivateProSyncProblemPhase = 'offline' | 'quota-blocked' | 'error';

export interface PrivateProSyncProblem {
  kind: 'retryable' | 'blocked';
  phase: PrivateProSyncProblemPhase;
  message: string;
}

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
  random?: () => number;
  onStatus?: (status: { phase: PrivateProSyncProblemPhase; error: string }) => void;
}

const LEASE_MS = 30_000;
const MAX_RETRY_DELAY_MS = 60_000;

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const data = 'data' in error ? error.data : undefined;
  return data && typeof data === 'object' && 'code' in data && typeof data.code === 'string'
    ? data.code
    : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return 'Private sync failed.';
}

export function privateProClassifySyncError(error: unknown): PrivateProSyncProblem {
  const message = errorMessage(error);
  const normalized = message.toLowerCase();
  if (normalized.includes('quota')) return { kind: 'blocked', phase: 'quota-blocked', message };

  const code = errorCode(error);
  if (code && ['UNAUTHORIZED', 'FORBIDDEN', 'BAD_REQUEST', 'PAYLOAD_TOO_LARGE', 'UNPROCESSABLE_CONTENT'].includes(code))
    return { kind: 'blocked', phase: 'error', message };
  if (normalized.includes('schema') || normalized.includes('validation') || normalized.includes('permission denied'))
    return { kind: 'blocked', phase: 'error', message };
  return { kind: 'retryable', phase: 'offline', message };
}

export function privateProRetryDelay(attempts: number, random: () => number = Math.random): number {
  const exponential = Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** Math.max(0, attempts));
  const jitter = 0.75 + Math.min(1, Math.max(0, random())) * 0.5;
  return Math.round(exponential * jitter);
}

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

export function privateProOperationId(operation: PrivateProOutboxOperation): string {
  if (operation.id === undefined) throw new Error('Private sync operation is missing its ID.');
  const deviceId = operation.deviceId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
  return `sync-${deviceId}-${operation.id.toString(36).padStart(8, '0')}`;
}

export function createPrivateProSyncEngine(deps: PrivateProSyncEngineDependencies): PrivateProSyncEngine {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
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
      if (event.kind === 'upsert') await deps.store.prepareForRemoteApply?.(event.entity);
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
    await deps.db.discardOperationsForEntity(deps.uid, entity.entityType, entity.entityId, {
      kind: 'upsert',
      contentHash: entity.contentHash,
    });
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
      if (state.remoteHash === null || localKeys.has(state.entityKey) || await deps.store.exists(state.entityType, state.entityId)) continue;
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
      if (operation.kind === 'upsert') {
        const local = await deps.store.get(operation.entityType, operation.entityId);
        if (local) await deps.store.prepareForUpload?.(local);
      }
      const result = operation.kind === 'upsert'
        ? await deps.transport.upsert({
          operationId: privateProOperationId(operation),
          entityType: operation.entityType,
          entityId: operation.entityId,
          contentHash: operation.contentHash,
          payload: structuredClone(operation.payload),
          baseRevision: operation.baseRevision,
          deviceId: operation.deviceId,
        })
        : await deps.transport.delete({
          operationId: privateProOperationId(operation),
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
      const problem = privateProClassifySyncError(error);
      if (problem.kind === 'blocked') await deps.db.blockOperation(operation.id, problem.message);
      else await deps.db.retryOperation(operation.id, problem.message, now(), privateProRetryDelay(operation.attempts, random));
      deps.onStatus?.({ phase: problem.phase, error: problem.message });
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
