import type { PrivateProSyncCoordinator } from './privatePro.sync.coordinator';
import type { PrivateProSyncDB } from './privatePro.sync.db';
import {
  createPrivateProSyncOutbound,
  type PrivateProOutboundErrorCategory,
  type PrivateProSyncCaptureNotice,
  type PrivateProSyncDurableCapture,
  type PrivateProSyncOutbound,
} from './privatePro.sync.outbound';
import {
  createPrivateProSyncReconciler,
  type PrivateProSyncLocalOrigin,
  type PrivateProSyncReconciler,
} from './privatePro.sync.reconcile';
import type { PrivateProSyncSerializer } from './privatePro.sync.serializers';
import { privateProSyncStore, type PrivateProSyncStore } from './store-private-pro-sync';
import type { PrivateProSyncRemoteEvent, PrivateProSyncTransport } from './privatePro.sync.transport';


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
  onStatus(status: { category: PrivateProOutboundErrorCategory }): void;
}

interface ReconcilerHooks {
  localOrigins: Map<string, PrivateProSyncLocalOrigin>;
  outbound: Pick<PrivateProSyncEngineOutbound, 'handleCommitted'>;
  onError(category: PrivateProOutboundErrorCategory): void;
}

export interface PrivateProSyncEngineDependencies {
  uid: string;
  writerId?: string;
  serializers: readonly PrivateProSyncSerializer<unknown>[];
  db: PrivateProSyncEngineDB;
  coordinator?: PrivateProSyncCoordinator;
  transport: PrivateProSyncTransport;
  runSuppressed<T>(callback: () => Promise<T> | T): Promise<T> | T;
  createOutbound?: (hooks: OutboundHooks) => PrivateProSyncEngineOutbound;
  createReconciler?: (hooks: ReconcilerHooks) => PrivateProSyncReconciler;
  windowEvents?: WindowEventsPort;
  statusStore?: PrivateProSyncStore;
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => TimeoutHandle;
  clearTimeout?: (handle: TimeoutHandle) => void;
}

function defaultWindowEvents(): WindowEventsPort | undefined {
  return typeof window === 'undefined' ? undefined : window;
}

export function createPrivateProSyncEngine(dependencies: PrivateProSyncEngineDependencies): PrivateProSyncEngine {
  const writerId = dependencies.writerId ?? crypto.randomUUID();
  const statusStore = dependencies.statusStore ?? privateProSyncStore;
  const now = dependencies.now ?? Date.now;
  const scheduleTimeout = dependencies.setTimeout ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  const cancelTimeout = dependencies.clearTimeout ?? (handle => globalThis.clearTimeout(handle));
  const windowEvents = dependencies.windowEvents ?? defaultWindowEvents();
  const localOrigins = new Map<string, PrivateProSyncLocalOrigin>();
  const pendingOrigins = new Map<string, PrivateProSyncLocalOrigin[]>();
  const currentCollections = new Set<string>();

  let sequence = 0;
  let started = false;
  let stopped = false;
  let transportUnsubscribe: (() => void) | null = null;
  let eventQueue: Promise<void> = Promise.resolve();

  function phaseForPending(pending: number): 'local' | 'synced' {
    return currentCollections.size === 3 && pending === 0 ? 'synced' : 'local';
  }

  async function refreshStatus(options: { preserveFailure?: boolean } = {}): Promise<number> {
    const pending = await dependencies.db.pendingCount(dependencies.uid);
    if (stopped) return pending;
    const state = statusStore.getState();
    const preserveFailure = options.preserveFailure !== false && (state.phase === 'offline' || state.phase === 'error');
    const phase = preserveFailure ? state.phase : phaseForPending(pending);
    statusStore.setState({
      pending,
      phase,
      ...(phase === 'synced' ? { lastSuccessfulSyncTime: now(), lastCategory: null } : {}),
    });
    return pending;
  }

  function report(category: PrivateProOutboundErrorCategory): void {
    statusStore.setState({
      phase: category === 'offline' ? 'offline' : 'error',
      lastCategory: category,
    });
    void refreshStatus({ preserveFailure: true });
  }

  function onCapture(notice: PrivateProSyncCaptureNotice): void {
    const origin: PrivateProSyncLocalOrigin = { sequence: ++sequence, generation: null, mutationId: null };
    const queue = pendingOrigins.get(notice.recordKey) ?? [];
    queue.push(origin);
    pendingOrigins.set(notice.recordKey, queue);
    localOrigins.set(notice.recordKey, origin);
    statusStore.setState({ phase: 'local' });
  }

  function onCaptured(notice: PrivateProSyncDurableCapture): void {
    const queue = pendingOrigins.get(notice.recordKey);
    const origin = queue?.shift();
    if (queue?.length === 0) pendingOrigins.delete(notice.recordKey);
    if (origin) {
      origin.generation = notice.generation;
      origin.mutationId = notice.mutationId;
    }
    void refreshStatus();
  }

  const outbound: PrivateProSyncEngineOutbound = dependencies.createOutbound?.({ onCapture, onCaptured, onStatus: status => report(status.category) }) ?? (() => {
    if (!dependencies.coordinator) throw new TypeError('Private Pro sync engine requires a coordinator.');
    const implementation: PrivateProSyncOutbound = createPrivateProSyncOutbound({
      uid: dependencies.uid,
      writerId,
      serializers: dependencies.serializers,
      db: dependencies.db as PrivateProSyncDB,
      coordinator: dependencies.coordinator,
      transport: dependencies.transport,
      onCapture,
      onCaptured,
      onStatus: status => report(status.category),
    });
    return {
      ...implementation,
      retryNow: () => implementation.flushNow(),
    };
  })();

  const reconciler = dependencies.createReconciler?.({ localOrigins, outbound, onError: report }) ?? createPrivateProSyncReconciler({
    uid: dependencies.uid,
    writerId,
    serializers: dependencies.serializers,
    db: dependencies.db as PrivateProSyncDB,
    localOrigins,
    outbound,
    runSuppressed: callback => dependencies.runSuppressed(callback),
    shouldApply: () => !stopped,
    onError: report,
    now,
  });

  function queueRemote(event: PrivateProSyncRemoteEvent): void {
    eventQueue = eventQueue.then(async () => {
      if (stopped) return;
      if (event.type === 'current') {
        currentCollections.add(event.collection);
        await refreshStatus();
        return;
      }
      await reconciler.handle(event);
      await refreshStatus();
    }).catch(() => report('unknown'));
  }

  const onOffline = () => report('offline');
  const onOnline = () => { void (async () => {
    statusStore.setState({ phase: 'local', lastCategory: null });
    await outbound.retryNow();
    await refreshStatus({ preserveFailure: false });
  })().catch(() => report('offline')); };

  async function retryNow(): Promise<void> {
    statusStore.setState({ phase: 'local', lastCategory: null });
    await outbound.retryNow();
    await refreshStatus({ preserveFailure: false });
  }

  const engine: PrivateProSyncEngine = {
    async start(): Promise<void> {
      if (started) return;
      started = true;
      stopped = false;
      currentCollections.clear();
      statusStore.setState({ phase: 'local', retry: retryNow, lastCategory: null });
      await outbound.start();
      void reconciler.applyCached().catch(() => report('schema'));
      transportUnsubscribe = dependencies.transport.listen(queueRemote);
      windowEvents?.addEventListener('online', onOnline);
      windowEvents?.addEventListener('offline', onOffline);
      outbound.wake();
      await refreshStatus({ preserveFailure: false });
    },

    retryNow,

    async flushNow(timeoutMs: number): Promise<{ pending: number }> {
      let timeout: TimeoutHandle | null = null;
      await Promise.race([
        outbound.flushNow().catch(() => report('offline')),
        new Promise<void>(resolve => { timeout = scheduleTimeout(resolve, Math.max(0, timeoutMs)); }),
      ]);
      if (timeout !== null) cancelTimeout(timeout);
      return { pending: await refreshStatus({ preserveFailure: true }) };
    },

    pendingCount(): Promise<number> {
      return dependencies.db.pendingCount(dependencies.uid);
    },

    async stop(): Promise<void> {
      if (!started || stopped) return;
      stopped = true;
      transportUnsubscribe?.();
      transportUnsubscribe = null;
      windowEvents?.removeEventListener('online', onOnline);
      windowEvents?.removeEventListener('offline', onOffline);
      pendingOrigins.clear();
      localOrigins.clear();
      await outbound.stop();
      statusStore.setState({ retry: null });
      started = false;
    },
  };

  return engine;
}
