import { PRIVATE_PRO_SYNC_WINDOW_MS } from '../config/privatePro.config';
import {
  assertPrivateProPayloadSize,
  privateProCanonicalJson,
  privateProContentHash,
  privateProRecordKey,
} from './privatePro.sync.codec';
import type { PrivateProSyncCoordinator, PrivateProSyncLeaderContext } from './privatePro.sync.coordinator';
import type { PrivateProOutboxState, PrivateProRemoteBaseState, PrivateProSyncDB } from './privatePro.sync.db';
import type {
  PrivateProSyncLocalMutation,
  PrivateProSyncPreparedRecord,
  PrivateProSyncSerializer,
} from './privatePro.sync.serializers';
import type { PrivateProSyncRecordType } from './privatePro.sync.schemas';
import {
  PrivateProSyncTransportError,
  type PrivateProSyncErrorCategory,
  type PrivateProSyncRemoteRecord,
  type PrivateProSyncTransport,
} from './privatePro.sync.transport';


const OUTBOX_LEASE_MS = 15_000;
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = PRIVATE_PRO_SYNC_WINDOW_MS;

type TimeoutHandle = ReturnType<typeof globalThis.setTimeout>;
export type PrivateProOutboundErrorCategory = PrivateProSyncErrorCategory | 'schema';

export interface PrivateProSyncCaptureNotice {
  kind: 'put' | 'delete';
  recordType: PrivateProSyncRecordType;
  logicalId: string;
  recordKey: string;
}

export interface PrivateProSyncDurableCapture extends PrivateProSyncCaptureNotice {
  generation: number;
  mutationId: string;
}

export interface PrivateProSyncOutboundStatus {
  category: PrivateProOutboundErrorCategory;
}

export interface PrivateProSyncAssetPort {
  ensureUploaded(referencedAssetIds: readonly string[]): Promise<void>;
}

export interface PrivateProSyncOutboundDependencies {
  uid: string;
  writerId: string;
  serializers: readonly PrivateProSyncSerializer<unknown>[];
  db: PrivateProSyncDB;
  coordinator: PrivateProSyncCoordinator;
  transport: PrivateProSyncTransport;
  assets?: PrivateProSyncAssetPort;
  shouldCapture?: (mutation: PrivateProSyncLocalMutation) => boolean;
  onCapture?: (notice: PrivateProSyncCaptureNotice) => void;
  onCaptured?: (notice: PrivateProSyncDurableCapture) => void;
  onStatus?: (status: PrivateProSyncOutboundStatus) => void;
  now?: () => number;
  random?: () => number;
  setTimeout?: (callback: () => void, ms: number) => TimeoutHandle;
  clearTimeout?: (handle: TimeoutHandle) => void;
}

export interface PrivateProSyncOutbound {
  start(): Promise<void>;
  capture(mutation: PrivateProSyncLocalMutation): Promise<PrivateProOutboxState>;
  handleCommitted(mutationId: string, revision: number): Promise<void>;
  wake(): void;
  flushNow(): Promise<void>;
  stop(): Promise<void>;
}

interface ActiveSend {
  row: PrivateProOutboxState;
  sentAtMs: number;
}

type AbortRace<T> =
  | { type: 'result'; result: T }
  | { type: 'error'; error: unknown }
  | { type: 'aborted' };

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
}

function remoteBase(record: PrivateProSyncRemoteRecord): PrivateProRemoteBaseState {
  return { revision: record.revision, mutationId: record.mutationId, deleted: record.deleted };
}

function isSchemaError(error: unknown): boolean {
  return error instanceof TypeError || error instanceof RangeError || (error instanceof Error && error.name === 'ZodError');
}

export function privateProClassifySyncError(error: unknown): PrivateProOutboundErrorCategory {
  if (error instanceof PrivateProSyncTransportError) return error.category;
  if (isSchemaError(error)) return 'schema';
  return 'offline';
}

export function privateProSyncRetryDelay(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)));
  const jittered = exponential * (0.5 + Math.min(1, Math.max(0, random())));
  return Math.min(RETRY_CAP_MS, Math.max(0, Math.round(jittered)));
}


export function createPrivateProSyncOutbound(dependencies: PrivateProSyncOutboundDependencies): PrivateProSyncOutbound {
  const now = dependencies.now ?? Date.now;
  const random = dependencies.random ?? Math.random;
  const scheduleTimeout = dependencies.setTimeout ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  const cancelTimeout = dependencies.clearTimeout ?? (handle => globalThis.clearTimeout(handle));
  const assets = dependencies.assets ?? { ensureUploaded: async () => {} };
  const serializers = new Map(dependencies.serializers.map(serializer => [serializer.recordType, serializer]));
  const activeSends = new Map<string, ActiveSend>();
  const unsubscribers: Array<() => void> = [];

  let started = false;
  let stopped = false;
  let leaderContext: PrivateProSyncLeaderContext | null = null;
  let timer: TimeoutHandle | null = null;
  let scheduleVersion = 0;
  let captureQueue: Promise<void> = Promise.resolve();
  let drainPromise: Promise<void> | null = null;

  function report(category: PrivateProOutboundErrorCategory): void {
    dependencies.onStatus?.({ category });
  }

  function clearTimer(): void {
    if (timer === null) return;
    cancelTimeout(timer);
    timer = null;
  }

  function scheduleAt(targetMs: number): void {
    clearTimer();
    if (!leaderContext || leaderContext.signal.aborted || stopped) return;
    timer = scheduleTimeout(() => {
      timer = null;
      return requestDrain();
    }, Math.max(0, targetMs - now()));
  }

  async function reschedule(): Promise<void> {
    const version = ++scheduleVersion;
    if (!leaderContext || leaderContext.signal.aborted || stopped) {
      clearTimer();
      return;
    }
    const dueAt = await dependencies.db.nextDueAt(dependencies.uid);
    if (version !== scheduleVersion || !leaderContext || leaderContext.signal.aborted || stopped) return;
    if (dueAt === null) {
      clearTimer();
      return;
    }
    scheduleAt(dueAt);
  }

  function serializerFor(recordType: PrivateProSyncPreparedRecord['recordType']): PrivateProSyncSerializer<unknown> {
    const serializer = serializers.get(recordType);
    if (!serializer) throw new TypeError('Private Pro sync mutation has no serializer.');
    return serializer;
  }

  async function persistMutation(mutation: PrivateProSyncLocalMutation, notice: PrivateProSyncCaptureNotice): Promise<PrivateProOutboxState> {
    const serializer = serializerFor(notice.recordType);
    let pending: PrivateProOutboxState;
    if (mutation.kind === 'put') {
      if (mutation.record.recordType !== serializer.recordType || mutation.record.schemaVersion !== serializer.schemaVersion)
        throw new TypeError('Private Pro sync serializer identity does not match the mutation.');
      const value = await serializer.validate(mutation.record.logicalId, mutation.record.value);
      const payload = privateProCanonicalJson(value);
      assertPrivateProPayloadSize(payload);
      const record: PrivateProSyncPreparedRecord = {
        recordType: mutation.record.recordType,
        logicalId: mutation.record.logicalId,
        recordKey: notice.recordKey,
        projectionKey: mutation.record.projectionKey,
        schemaVersion: mutation.record.schemaVersion,
        payload,
        contentHash: await privateProContentHash(payload),
        referencedAssetIds: [...mutation.record.referencedAssetIds],
      };
      pending = await dependencies.db.recordLocalPut(dependencies.uid, record, now());
    } else {
      if (mutation.recordType !== serializer.recordType || mutation.schemaVersion !== serializer.schemaVersion)
        throw new TypeError('Private Pro sync serializer identity does not match the mutation.');
      pending = await dependencies.db.recordLocalDelete(dependencies.uid, {
        recordType: mutation.recordType,
        logicalId: mutation.logicalId,
        recordKey: notice.recordKey,
        projectionKey: mutation.projectionKey,
        schemaVersion: mutation.schemaVersion,
      }, now());
    }
    dependencies.onCaptured?.({ ...notice, generation: pending.generation, mutationId: pending.mutationId });
    dependencies.coordinator.wake();
    void reschedule();
    return pending;
  }

  function capture(mutation: PrivateProSyncLocalMutation): Promise<PrivateProOutboxState> {
    const identity = mutation.kind === 'put' ? mutation.record : mutation;
    const notice: PrivateProSyncCaptureNotice = {
      kind: mutation.kind,
      recordType: identity.recordType,
      logicalId: identity.logicalId,
      recordKey: privateProRecordKey(identity.recordType, identity.logicalId),
    };
    dependencies.onCapture?.(notice);
    const result = captureQueue.then(() => persistMutation(mutation, notice));
    captureQueue = result.then(() => undefined, error => {
      report(privateProClassifySyncError(error));
    });
    return result;
  }

  async function retry(row: PrivateProOutboxState, category: PrivateProOutboundErrorCategory): Promise<number> {
    if (!row.leaseToken || row.leaseFence === null || row.leasedGeneration === null) return 0;
    const delayMs = privateProSyncRetryDelay((row.retryAttempt ?? 0) + 1, random);
    await dependencies.db.retry(
      dependencies.uid,
      row.recordKey,
      row.leasedGeneration,
      row.leaseToken,
      row.leaseFence,
      now(),
      delayMs,
      category,
    );
    return delayMs;
  }

  async function release(row: PrivateProOutboxState): Promise<void> {
    if (!row.leaseToken || row.leaseFence === null || row.leasedGeneration === null) return;
    await dependencies.db.releaseLease(
      dependencies.uid,
      row.recordKey,
      row.leasedGeneration,
      row.leaseToken,
      row.leaseFence,
    );
  }

  async function acknowledge(row: PrivateProOutboxState, base: PrivateProRemoteBaseState, sentAtMs: number): Promise<void> {
    if (!row.leaseToken || row.leaseFence === null || row.leasedGeneration === null) return;
    await dependencies.db.acknowledge(
      dependencies.uid,
      row.recordKey,
      row.leasedGeneration,
      row.leaseToken,
      row.leaseFence,
      base,
      sentAtMs,
    );
  }

  async function raceAbortable<T>(request: Promise<T>, signal: AbortSignal): Promise<AbortRace<T>> {
    request.catch(() => {});
    return Promise.race([
      request.then(result => ({ type: 'result' as const, result }), error => ({ type: 'error' as const, error })),
      waitForAbort(signal).then(() => ({ type: 'aborted' as const })),
    ]);
  }

  function raceWrite(row: PrivateProOutboxState, signal: AbortSignal): Promise<AbortRace<Awaited<ReturnType<PrivateProSyncTransport['write']>>>> {
    return raceAbortable(dependencies.transport.write({
      recordKey: row.recordKey,
      recordType: row.recordType,
      logicalId: row.logicalId,
      schemaVersion: row.schemaVersion,
      kind: row.kind,
      payload: row.payload,
      contentHash: row.contentHash,
      baseRevision: row.baseRevision,
      mutationId: row.mutationId,
      writerId: dependencies.writerId,
    }), signal);
  }

  async function processRow(row: PrivateProOutboxState, context: PrivateProSyncLeaderContext): Promise<void> {
    if (!row.leaseToken || row.leaseFence === null || row.leasedGeneration === null)
      throw new Error('Private Pro sync leased row is missing its fencing identity.');
    const sentAtMs = now();
    activeSends.set(row.mutationId, { row, sentAtMs });
    try {
      const assetsOutcome = await raceAbortable(assets.ensureUploaded(row.referencedAssetIds), context.signal);
      if (assetsOutcome.type === 'aborted') {
        await release(row);
        return;
      }
      if (assetsOutcome.type === 'error') {
        const category = privateProClassifySyncError(assetsOutcome.error);
        if (category === 'permission' || category === 'quota' || category === 'schema' || category === 'unknown') {
          await dependencies.db.block(dependencies.uid, row.recordKey, row.leasedGeneration, row.leaseToken, row.leaseFence, category);
          report(category);
          return;
        }
        await retry(row, category);
        return;
      }

      if (context.signal.aborted) {
        await release(row);
        return;
      }
      const outcome = await raceWrite(row, context.signal);
      if (outcome.type === 'aborted') {
        await release(row);
        return;
      }
      if (outcome.type === 'error') {
        const category = privateProClassifySyncError(outcome.error);
        if (category === 'permission' || category === 'quota' || category === 'schema' || category === 'unknown') {
          await dependencies.db.block(dependencies.uid, row.recordKey, row.leasedGeneration, row.leaseToken, row.leaseFence, category);
          report(category);
          return;
        }
        await retry(row, category);
        return;
      }

      const result = outcome.result;
      if (result.status === 'accepted' || result.status === 'already-committed') {
        await acknowledge(row, {
          revision: result.revision,
          mutationId: row.mutationId,
          deleted: row.kind === 'delete',
        }, sentAtMs);
        return;
      }
      if (result.status === 'deleted') {
        if (row.kind === 'delete') {
          await acknowledge(row, remoteBase(result.canonical), sentAtMs);
          return;
        }
        await dependencies.db.discardLeasedAcrossTombstone(
          dependencies.uid,
          row.recordKey,
          row.leasedGeneration,
          row.leaseToken,
          row.leaseFence,
          remoteBase(result.canonical),
        );
        return;
      }

      const serializer = serializerFor(row.recordType);
      if (serializer.conflictPolicy === 'message-identity') {
        if (row.contentHash !== result.canonical.contentHash) {
          await dependencies.db.quarantineLeased(
            dependencies.uid,
            row.recordKey,
            row.leasedGeneration,
            row.leaseToken,
            row.leaseFence,
            'message-id-collision',
            now(),
          );
          report('schema');
          return;
        }
        await acknowledge(row, remoteBase(result.canonical), sentAtMs);
        return;
      }

      const delayMs = privateProSyncRetryDelay((row.retryAttempt ?? 0) + 1, random);
      await dependencies.db.rebase(
        dependencies.uid,
        row.recordKey,
        row.leasedGeneration,
        row.leaseToken,
        row.leaseFence,
        remoteBase(result.canonical),
        now(),
        delayMs,
      );
      return;
    } finally {
      activeSends.delete(row.mutationId);
    }
  }

  async function drain(context: PrivateProSyncLeaderContext): Promise<void> {
    await captureQueue;
    while (!context.signal.aborted && !stopped) {
      const row = await dependencies.db.leaseDue(dependencies.uid, now(), OUTBOX_LEASE_MS, context.coordinatorFence);
      if (!row) return;
      await processRow(row, context);
    }
  }

  function requestDrain(): Promise<void> {
    const context = leaderContext;
    if (!context || context.signal.aborted || stopped) return Promise.resolve();
    if (drainPromise) return drainPromise;
    drainPromise = drain(context).finally(async () => {
      drainPromise = null;
      await reschedule();
    });
    return drainPromise;
  }

  async function runLeader(context: PrivateProSyncLeaderContext): Promise<void> {
    leaderContext = context;
    await reschedule();
    await waitForAbort(context.signal);
    clearTimer();
    if (drainPromise) await drainPromise;
    leaderContext = null;
  }

  return {
    async start(): Promise<void> {
      if (started) return;
      started = true;
      stopped = false;
      for (const serializer of dependencies.serializers) {
        unsubscribers.push(serializer.subscribe(mutation => {
          if (dependencies.shouldCapture && !dependencies.shouldCapture(mutation)) return;
          void capture(mutation).catch(() => {});
        }));
      }
      await dependencies.coordinator.start(runLeader);
    },

    capture,

    async handleCommitted(mutationId: string, revision: number): Promise<void> {
      const active = activeSends.get(mutationId);
      if (!active || !Number.isInteger(revision) || revision <= 0) return;
      await acknowledge(active.row, { revision, mutationId, deleted: active.row.kind === 'delete' }, active.sentAtMs);
      void reschedule();
    },

    wake(): void {
      void reschedule();
    },

    async flushNow(): Promise<void> {
      await captureQueue;
      await dependencies.db.expedite(dependencies.uid, now());
      dependencies.coordinator.wake();
      await requestDrain();
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      unsubscribers.splice(0).forEach(unsubscribe => unsubscribe());
      await captureQueue;
      clearTimer();
      if (started) await dependencies.coordinator.stop();
      if (drainPromise) await drainPromise;
      started = false;
      leaderContext = null;
    },
  };
}
