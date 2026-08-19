import type { PrivateProSyncCoordinator } from './privatePro.sync.coordinator';
import type { PrivateProSyncDB } from './privatePro.sync.db';
import {
  createPrivateProSyncOutbound,
  type PrivateProOutboundErrorCategory,
  type PrivateProSyncCaptureFailure,
  type PrivateProSyncCaptureNotice,
  type PrivateProSyncCommittedNotice,
  type PrivateProSyncDurableCapture,
  type PrivateProSyncOutbound,
} from './privatePro.sync.outbound';
import {
  createPrivateProSyncReconciler,
  type PrivateProSyncCommittedMarker,
  type PrivateProSyncLocalOrigin,
  type PrivateProSyncReconciler,
} from './privatePro.sync.reconcile';
import type { PrivateProSyncLocalMutation, PrivateProSyncSerializer } from './privatePro.sync.serializers';
import { createPrivateProSyncStore, type PrivateProSyncStore } from './store-private-pro-sync';
import type { PrivateProSyncCollection, PrivateProSyncRemoteEvent, PrivateProSyncTransport } from './privatePro.sync.transport';


type TimeoutHandle = ReturnType<typeof globalThis.setTimeout>;

export interface PrivateProSyncEngine {
  start(): Promise<void>;
  retryNow(): Promise<void>;
  flushNow(timeoutMs: number): Promise<{ pending: number }>;
  pendingCount(): Promise<number>;
  stop(): Promise<void>;
}

export interface PrivateProSyncEngineOutbound {
  start(): Promise<void>;
  retryNow(): Promise<void>;
  flushNow(): Promise<void>;
  wake(): void;
  handleCommitted(mutationId: string, revision: number): Promise<void>;
  stop(): Promise<void>;
}

interface PrivateProSyncEngineDB {
  pendingCount(uid: string): Promise<number>;
}

interface WindowEventsPort {
  addEventListener(type: 'online' | 'offline', listener: () => void): void;
  removeEventListener(type: 'online' | 'offline', listener: () => void): void;
}

interface OutboundHooks {
  onCapture(notice: PrivateProSyncCaptureNotice): void;
  onCaptured(notice: PrivateProSyncDurableCapture): void;
  onCaptureFailed(notice: PrivateProSyncCaptureFailure): void;
  onCommitted(notice: PrivateProSyncCommittedNotice): void;
  onStatus(status: { category: PrivateProOutboundErrorCategory }): void;
  shouldCapture(mutation: PrivateProSyncLocalMutation): boolean;
  runSuppressed<T>(projectionKey: string, callback: () => Promise<T> | T): Promise<T>;
  originFor(recordKey: string): PrivateProSyncLocalOrigin | undefined;
  committedFor(recordKey: string): PrivateProSyncCommittedMarker | undefined;
}

interface ReconcilerHooks {
  localOrigins: Map<string, PrivateProSyncLocalOrigin>;
  committedMarkers: Map<string, PrivateProSyncCommittedMarker>;
  projectionVersions: Map<string, number>;
  outbound: Pick<PrivateProSyncEngineOutbound, 'handleCommitted'>;
  runSuppressed<T>(projectionKey: string, callback: () => Promise<T> | T): Promise<T>;
  isEpochActive(epoch: number): boolean;
  onError(category: PrivateProOutboundErrorCategory): void;
  onHydrate?(assetIds: readonly string[], epoch: number): void;
}

export interface PrivateProSyncEngineDependencies {
  uid: string;
  writerId?: string;
  serializers: readonly PrivateProSyncSerializer<unknown>[];
  db: PrivateProSyncEngineDB;
  coordinator?: PrivateProSyncCoordinator;
  transport: PrivateProSyncTransport;
  assets?: {
    ensureUploaded(assetIds: readonly string[], signal?: AbortSignal): Promise<void>;
    hydrate(assetIds: readonly string[], signal?: AbortSignal): Promise<void>;
  };
  runSuppressed<T>(callback: () => Promise<T> | T): Promise<T> | T;
  createOutbound?: (hooks: OutboundHooks) => PrivateProSyncEngineOutbound;
  createReconciler?: (hooks: ReconcilerHooks) => PrivateProSyncReconciler;
  windowEvents?: WindowEventsPort;
  statusStore?: PrivateProSyncStore;
  createStatusStore?: () => PrivateProSyncStore;
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => TimeoutHandle;
  clearTimeout?: (handle: TimeoutHandle) => void;
}

function defaultWindowEvents(): WindowEventsPort | undefined {
  return typeof window === 'undefined' ? undefined : window;
}

export function createPrivateProSyncEngine(dependencies: PrivateProSyncEngineDependencies): PrivateProSyncEngine {
  const writerId = dependencies.writerId ?? crypto.randomUUID();
  const statusStore = dependencies.statusStore ?? dependencies.createStatusStore?.() ?? createPrivateProSyncStore();
  const now = dependencies.now ?? Date.now;
  const scheduleTimeout = dependencies.setTimeout ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  const cancelTimeout = dependencies.clearTimeout ?? (handle => globalThis.clearTimeout(handle));
  const windowEvents = dependencies.windowEvents ?? defaultWindowEvents();
  const localOrigins = new Map<string, PrivateProSyncLocalOrigin>();
  const captures = new Map<string, PrivateProSyncLocalOrigin>();
  const committedMarkers = new Map<string, PrivateProSyncCommittedMarker>();
  const projectionVersions = new Map<string, number>();
  const currentCollections = new Set<PrivateProSyncCollection>();

  const suppressionDepths = new Map<string, number>();
  let lifecycleEpoch = 0;
  let listenerEpoch = 0;
  let started = false;
  let transportUnsubscribe: (() => void) | null = null;
  let eventQueue: Promise<void> = Promise.resolve();
  let cacheTask: Promise<void> | null = null;
  const projectionTasks = new Set<Promise<unknown>>();
  const assetTasks = new Set<Promise<unknown>>();
  let assetAbort = new AbortController();

  function isEpochActive(epoch: number): boolean {
    return started && lifecycleEpoch === epoch;
  }

  async function runSuppressed<T>(projectionKey: string, callback: () => Promise<T> | T): Promise<T> {
    suppressionDepths.set(projectionKey, (suppressionDepths.get(projectionKey) ?? 0) + 1);
    let resolveTracked!: () => void;
    const tracked = new Promise<void>(resolve => { resolveTracked = resolve; });
    projectionTasks.add(tracked);
    try {
      return await dependencies.runSuppressed(callback);
    } finally {
      const depth = (suppressionDepths.get(projectionKey) ?? 1) - 1;
      if (depth > 0) suppressionDepths.set(projectionKey, depth);
      else suppressionDepths.delete(projectionKey);
      resolveTracked();
      projectionTasks.delete(tracked);
    }
  }

  function nextProjectionVersion(projectionKey: string): number {
    const version = (projectionVersions.get(projectionKey) ?? 0) + 1;
    projectionVersions.set(projectionKey, version);
    return version;
  }

  function phaseForPending(pending: number): 'local' | 'syncing' | 'synced' {
    if (currentCollections.size !== 3) return 'local';
    return pending === 0 ? 'synced' : 'syncing';
  }

  async function refreshStatus(epoch: number, preserveFailure = true): Promise<number> {
    const pending = await dependencies.db.pendingCount(dependencies.uid);
    if (!isEpochActive(epoch)) return pending;
    const state = statusStore.getState();
    const keepFailure = preserveFailure && (state.phase === 'offline' || state.phase === 'error');
    const phase = keepFailure ? state.phase : phaseForPending(pending);
    statusStore.setState({
      pending,
      phase,
      ...(phase === 'synced' ? { lastSuccessfulSyncTime: now(), lastCategory: null } : {}),
    });
    return pending;
  }

  function report(category: PrivateProOutboundErrorCategory, epoch = lifecycleEpoch): void {
    if (!isEpochActive(epoch)) return;
    statusStore.setState({ phase: category === 'offline' ? 'offline' : 'error', lastCategory: category });
    void refreshStatus(epoch, true);
  }

  function onCapture(notice: PrivateProSyncCaptureNotice): void {
    const editVersion = nextProjectionVersion(notice.projectionKey);
    const origin: PrivateProSyncLocalOrigin = {
      captureId: notice.captureId,
      projectionKey: notice.projectionKey,
      editVersion,
      generation: null,
      mutationId: null,
      dirty: true,
    };
    captures.set(notice.captureId, origin);
    localOrigins.set(notice.recordKey, origin);
    committedMarkers.delete(notice.recordKey);
    if (started) statusStore.setState({ phase: 'local' });
  }

  function onCaptured(notice: PrivateProSyncDurableCapture): void {
    const origin = captures.get(notice.captureId);
    captures.delete(notice.captureId);
    if (!origin || localOrigins.get(notice.recordKey) !== origin) return;
    origin.generation = notice.generation;
    origin.mutationId = notice.mutationId;
    void refreshStatus(lifecycleEpoch);
  }

  function onCaptureFailed(notice: PrivateProSyncCaptureFailure): void {
    const origin = captures.get(notice.captureId);
    captures.delete(notice.captureId);
    if (!origin || localOrigins.get(notice.recordKey) !== origin) return;
    origin.generation = null;
    origin.mutationId = null;
    origin.dirty = true;
  }

  function onCommitted(notice: PrivateProSyncCommittedNotice): void {
    const origin = localOrigins.get(notice.recordKey);
    if (origin && (origin.generation !== notice.generation || origin.mutationId !== notice.mutationId)) return;
    if (origin) localOrigins.delete(notice.recordKey);
    committedMarkers.set(notice.recordKey, { ...notice });
    while (committedMarkers.size > 256) committedMarkers.delete(committedMarkers.keys().next().value!);
    void refreshStatus(lifecycleEpoch);
  }

  const outboundHooks: OutboundHooks = {
    onCapture,
    onCaptured,
    onCaptureFailed,
    onCommitted,
    onStatus: status => report(status.category),
    shouldCapture: mutation => {
      const projectionKey = mutation.kind === 'put' ? mutation.record.projectionKey : mutation.projectionKey;
      return !suppressionDepths.has(projectionKey);
    },
    runSuppressed,
    originFor: recordKey => localOrigins.get(recordKey),
    committedFor: recordKey => committedMarkers.get(recordKey),
  };

  const outbound: PrivateProSyncEngineOutbound = dependencies.createOutbound?.(outboundHooks) ?? (() => {
    if (!dependencies.coordinator) throw new TypeError('Private Pro sync engine requires a coordinator.');
    const implementation: PrivateProSyncOutbound = createPrivateProSyncOutbound({
      uid: dependencies.uid,
      writerId,
      serializers: dependencies.serializers,
      db: dependencies.db as PrivateProSyncDB,
      coordinator: dependencies.coordinator,
      transport: dependencies.transport,
      assets: dependencies.assets,
      shouldCapture: mutation => outboundHooks.shouldCapture(mutation),
      onCapture,
      onCaptured,
      onCaptureFailed,
      onCommitted,
      onStatus: status => outboundHooks.onStatus(status),
    });
    return implementation;
  })();

  const reconciler = dependencies.createReconciler?.({
    localOrigins, committedMarkers, projectionVersions, outbound, runSuppressed, isEpochActive, onError: report,
    onHydrate: (assetIds, epoch) => {
      if (!assetIds.length || !dependencies.assets || !isEpochActive(epoch)) return;
      const task = dependencies.assets.hydrate(assetIds, assetAbort.signal)
        .catch(() => { if (isEpochActive(epoch)) report('offline', epoch); })
        .finally(() => assetTasks.delete(task));
      assetTasks.add(task);
    },
  }) ?? createPrivateProSyncReconciler({
    uid: dependencies.uid,
    writerId,
    serializers: dependencies.serializers,
    db: dependencies.db as PrivateProSyncDB,
    localOrigins,
    committedMarkers,
    projectionVersions,
    outbound,
    runSuppressed,
    isEpochActive,
    onError: report,
    onHydrate: (assetIds, epoch) => {
      if (!assetIds.length || !dependencies.assets || !isEpochActive(epoch)) return;
      const task = dependencies.assets.hydrate(assetIds, assetAbort.signal)
        .catch(() => { if (isEpochActive(epoch)) report('offline', epoch); })
        .finally(() => assetTasks.delete(task));
      assetTasks.add(task);
    },
    now,
  });

  function closeListener(): void {
    transportUnsubscribe?.();
    transportUnsubscribe = null;
  }

  function queueRemote(epoch: number, attachedEpoch: number, event: PrivateProSyncRemoteEvent): void {
    const queue = eventQueue;
    eventQueue = queue.then(async () => {
      if (!isEpochActive(epoch) || attachedEpoch !== listenerEpoch) return;
      if (event.type === 'current') {
        currentCollections.add(event.collection);
        await refreshStatus(epoch);
        return;
      }
      if (event.type === 'error') {
        currentCollections.delete(event.collection);
        closeListener();
        listenerEpoch++;
        report(event.category, epoch);
        return;
      }
      await reconciler.handle(event, epoch);
      await refreshStatus(epoch);
    }).catch(() => report('unknown', epoch));
  }

  function attachListener(epoch: number): void {
    closeListener();
    currentCollections.clear();
    const attachedEpoch = ++listenerEpoch;
    transportUnsubscribe = dependencies.transport.listen(event => queueRemote(epoch, attachedEpoch, event));
  }

  async function retryNow(): Promise<void> {
    const epoch = lifecycleEpoch;
    if (!isEpochActive(epoch)) return;
    statusStore.setState({ phase: 'local', lastCategory: null });
    attachListener(epoch);
    await outbound.retryNow();
    await refreshStatus(epoch, false);
  }

  const onOffline = () => report('offline');
  const onOnline = () => { void retryNow().catch(() => report('offline')); };

  const engine: PrivateProSyncEngine = {
    async start(): Promise<void> {
      if (started) return;
      started = true;
      assetAbort = new AbortController();
      const epoch = ++lifecycleEpoch;
      eventQueue = Promise.resolve();
      currentCollections.clear();
      statusStore.setState({ phase: 'local', retry: retryNow, lastCategory: null });
      await outbound.start();
      if (!isEpochActive(epoch)) return;
      cacheTask = reconciler.applyCached(epoch).catch(() => report('schema', epoch));
      attachListener(epoch);
      windowEvents?.addEventListener('online', onOnline);
      windowEvents?.addEventListener('offline', onOffline);
      outbound.wake();
      await refreshStatus(epoch, false);
    },

    retryNow,

    async flushNow(timeoutMs: number): Promise<{ pending: number }> {
      const epoch = lifecycleEpoch;
      let timeout: TimeoutHandle | null = null;
      await Promise.race([
        outbound.flushNow().catch(() => report('offline', epoch)),
        new Promise<void>(resolve => { timeout = scheduleTimeout(resolve, Math.max(0, timeoutMs)); }),
      ]);
      if (timeout !== null) cancelTimeout(timeout);
      return { pending: await refreshStatus(epoch, true) };
    },

    pendingCount(): Promise<number> {
      return dependencies.db.pendingCount(dependencies.uid);
    },

    async stop(): Promise<void> {
      if (!started) return;
      const ownedRetry = retryNow;
      started = false;
      lifecycleEpoch++;
      listenerEpoch++;
      closeListener();
      assetAbort.abort();
      windowEvents?.removeEventListener('online', onOnline);
      windowEvents?.removeEventListener('offline', onOffline);
      await outbound.stop();
      await Promise.allSettled([...projectionTasks]);
      eventQueue.catch(() => {});
      cacheTask?.catch(() => {});
      cacheTask = null;
      captures.clear();
      localOrigins.clear();
      committedMarkers.clear();
      if (statusStore.getState().retry === ownedRetry) statusStore.setState({ retry: null });
    },
  };

  return engine;
}
