import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  createPrivateProSyncEngine,
  type PrivateProSyncEngineOutbound,
} from './privatePro.sync.engine';
import type { PrivateProSyncLocalMutation, PrivateProSyncSerializer } from './privatePro.sync.serializers';
import { createPrivateProSyncStore } from './store-private-pro-sync';
import type { PrivateProSyncRemoteEvent, PrivateProSyncTransport } from './privatePro.sync.transport';


class FakeSerializer implements PrivateProSyncSerializer<unknown> {
  readonly recordType = 'settings' as const;
  readonly schemaVersion = 1;
  readonly conflictPolicy = 'replace' as const;
  subscribeCount = 0;
  unsubscribeCount = 0;

  async snapshot() { return []; }
  async validate(_logicalId: string, value: unknown) { return value; }
  project(logicalId: string) { return { projectionKey: logicalId, referencedAssetIds: [] }; }
  projection = { apply: async () => {}, remove: async () => {} };
  listener: ((mutation: PrivateProSyncLocalMutation) => void) | null = null;
  subscribe(listener: (mutation: PrivateProSyncLocalMutation) => void) {
    this.subscribeCount++;
    this.listener = listener;
    return () => { this.unsubscribeCount++; this.listener = null; };
  }
  emit(value: string) { this.listener?.({ kind: 'put', record: { recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1, value: { value }, referencedAssetIds: [] } }); }
}

class FakeTransport implements PrivateProSyncTransport {
  listener: ((event: PrivateProSyncRemoteEvent) => void) | null = null;
  readonly listeners: Array<(event: PrivateProSyncRemoteEvent) => void> = [];
  closed = 0;
  async write(): Promise<never> { throw new Error('unused'); }
  listen(listener: (event: PrivateProSyncRemoteEvent) => void) {
    this.listener = listener;
    this.listeners.push(listener);
    return () => { this.closed++; this.listener = null; };
  }
  emit(event: PrivateProSyncRemoteEvent) { this.listener?.(event); }
}

class FakeWindowEvents {
  readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: 'online' | 'offline', listener: () => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: 'online' | 'offline', listener: () => void) { this.listeners.get(type)?.delete(listener); }
  emit(type: 'online' | 'offline') { this.listeners.get(type)?.forEach(listener => listener()); }
}

function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function harness(options: { cache?: Promise<void>; pending?: number; statusStore?: ReturnType<typeof createPrivateProSyncStore> } = {}) {
  const order: string[] = [];
  const serializer = new FakeSerializer();
  const transport = new FakeTransport();
  const windowEvents = new FakeWindowEvents();
  const store = options.statusStore ?? createPrivateProSyncStore();
  let pending = options.pending ?? 0;
  let outboundHooks!: Parameters<NonNullable<Parameters<typeof createPrivateProSyncEngine>[0]['createOutbound']>>[0];
  let capturedMutations = 0;
  const outbound: PrivateProSyncEngineOutbound = {
    start: async () => { serializer.subscribe(mutation => { if (outboundHooks.shouldCapture(mutation)) capturedMutations++; }); order.push('outbound-start'); },
    retryNow: async () => { order.push('retry'); },
    flushNow: async () => { order.push('flush'); pending = 0; },
    wake: () => { order.push('wake'); },
    handleCommitted: async () => {},
    stop: async () => { serializer.unsubscribeCount++; order.push('outbound-stop'); },
  };
  const engine = createPrivateProSyncEngine({
    uid: 'uid-1',
    writerId: '123e4567-e89b-12d3-a456-426614174001',
    serializers: [serializer],
    transport,
    db: { pendingCount: async () => pending },
    runSuppressed: async callback => callback(),
    createOutbound: hooks => {
      order.push('create-outbound');
      outboundHooks = hooks;
      return outbound;
    },
    createReconciler: () => ({
      applyCached: async () => { order.push('cache'); await options.cache; },
      handle: async () => { order.push('remote'); },
    }),
    windowEvents,
    statusStore: store,
    now: () => 42,
  });
  return { engine, order, serializer, transport, windowEvents, store, hooks: () => outboundHooks, capturedMutations: () => capturedMutations, setPending: (value: number) => { pending = value; } };
}

describe('Private Pro sync engine', () => {
  test('subscribes before cache application and starts without waiting for cache or server current', async () => {
    let resolveCache!: () => void;
    const cache = new Promise<void>(resolve => { resolveCache = resolve; });
    const { engine, order, store } = harness({ cache });

    await engine.start();

    assert.deepEqual(order.slice(0, 4), ['create-outbound', 'outbound-start', 'cache', 'wake']);
    assert.equal(store.getState().phase, 'local');
    resolveCache();
    await engine.stop();
  });

  test('becomes synced only after all remote collections are current and pending is zero', async () => {
    const { engine, transport, store } = harness();
    await engine.start();

    transport.emit({ type: 'current', collection: 'records' });
    transport.emit({ type: 'current', collection: 'assets' });
    assert.equal(store.getState().phase, 'local');
    transport.emit({ type: 'current', collection: 'tombstones' });
    await settle();

    assert.equal(store.getState().phase, 'synced');
    assert.equal(store.getState().lastSuccessfulSyncTime, 42);
    await engine.stop();
  });

  test('reports offline without hiding local children and resumes durable work online', async () => {
    const { engine, order, windowEvents, store } = harness({ pending: 2 });
    await engine.start();

    windowEvents.emit('offline');
    assert.equal(store.getState().phase, 'offline');
    assert.equal(store.getState().pending, 2);
    windowEvents.emit('online');
    await settle();

    assert.equal(order.includes('retry'), true);
    assert.equal(store.getState().phase, 'local');
    await engine.stop();
  });

  test('flushNow has a bounded timeout and always returns the durable pending count', async () => {
    const { engine, setPending } = harness({ pending: 3 });
    await engine.start();
    const result = await engine.flushNow(50);
    assert.deepEqual(result, { pending: 0 });
    setPending(4);
    assert.equal(await engine.pendingCount(), 4);
    await engine.stop();
  });

  test('closes transport, serializer, window listeners, and outbound on stop', async () => {
    const { engine, serializer, transport, windowEvents, order } = harness();
    await engine.start();
    await engine.stop();

    assert.equal(transport.closed, 1);
    assert.equal(serializer.unsubscribeCount, 1);
    assert.equal(windowEvents.listeners.get('online')?.size, 0);
    assert.equal(windowEvents.listeners.get('offline')?.size, 0);
    assert.equal(order.at(-1), 'outbound-stop');
  });

  test('suppresses outbound capture for the full asynchronous projection scope', async () => {
    const { engine, serializer, hooks, capturedMutations } = harness();
    await engine.start();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });

    const projection = hooks().runSuppressed(async () => {
      serializer.emit('sync-start');
      await gate;
      serializer.emit('sync-end');
    });
    await settle();
    assert.equal(capturedMutations(), 0);
    release();
    await projection;
    serializer.emit('user');

    assert.equal(capturedMutations(), 1);
    await engine.stop();
  });

  test('uses isolated default status stores and exposes syncing while current work is pending', async () => {
    const first = harness({ pending: 2 });
    const second = harness();
    await first.engine.start();
    await second.engine.start();
    for (const collection of ['records', 'assets', 'tombstones'] as const) first.transport.emit({ type: 'current', collection });
    await settle();

    assert.notEqual(first.store, second.store);
    assert.equal(first.store.getState().phase, 'syncing');
    assert.equal(second.store.getState().phase, 'local');
    await first.engine.stop();
    await second.engine.stop();
  });

  test('listener error invalidates current and retry attaches one fresh listener epoch', async () => {
    const { engine, transport, store } = harness();
    await engine.start();
    for (const collection of ['records', 'assets', 'tombstones'] as const) transport.emit({ type: 'current', collection });
    await settle();
    const firstListener = transport.listeners[0];
    transport.emit({ type: 'error', collection: 'records', category: 'offline' });
    await settle();

    assert.equal(store.getState().phase, 'offline');
    await engine.retryNow();
    assert.equal(transport.closed, 1);
    assert.equal(transport.listeners.length, 2);
    firstListener({ type: 'current', collection: 'records' });
    await settle();
    assert.equal(store.getState().phase, 'local');
    await engine.stop();
  });

  test('a stopped lifecycle ignores old cache and listener callbacks after restart', async () => {
    let resolveCache!: () => void;
    const cache = new Promise<void>(resolve => { resolveCache = resolve; });
    const { engine, transport, order, store } = harness({ cache });
    await engine.start();
    const firstListener = transport.listeners[0];
    await engine.stop();
    await engine.start();
    const before = order.length;

    resolveCache();
    firstListener({ type: 'current', collection: 'records' });
    firstListener({ type: 'error', collection: 'records', category: 'offline' });
    await settle();

    assert.equal(order.length, before);
    assert.equal(store.getState().phase, 'local');
    await engine.stop();
  });

  test('stop waits for an already-running projection scope before it resolves', async () => {
    let projectionStarted!: () => void;
    let releaseProjection!: () => void;
    const started = new Promise<void>(resolve => { projectionStarted = resolve; });
    const gate = new Promise<void>(resolve => { releaseProjection = resolve; });
    const base = harness();
    const engine = createPrivateProSyncEngine({
      uid: 'uid-2', serializers: [base.serializer], transport: base.transport, db: { pendingCount: async () => 0 },
      runSuppressed: async callback => callback(), windowEvents: base.windowEvents,
      createOutbound: hooks => ({
        start: async () => {}, retryNow: async () => {}, flushNow: async () => {}, wake: () => {}, handleCommitted: async () => {}, stop: async () => {},
      }),
      createReconciler: hooks => ({
        applyCached: async () => {},
        handle: async () => hooks.runSuppressed(async () => { projectionStarted(); await gate; }),
      }),
    });
    await engine.start();
    base.transport.emit({ type: 'invalid-document', collection: 'records', recordKey: 'key', reason: 'invalid-document' });
    await started;
    let stopped = false;
    const stopping = engine.stop().then(() => { stopped = true; });
    await settle();
    assert.equal(stopped, false);
    releaseProjection();
    await stopping;
    assert.equal(stopped, true);
  });

  test('stop does not wait forever for an arbitrary remote handler', async () => {
    const base = harness();
    let handlingStarted!: () => void;
    const started = new Promise<void>(resolve => { handlingStarted = resolve; });
    const never = new Promise<void>(() => {});
    const engine = createPrivateProSyncEngine({
      uid: 'uid-3', serializers: [base.serializer], transport: base.transport, db: { pendingCount: async () => 0 },
      runSuppressed: async callback => callback(), windowEvents: base.windowEvents,
      createOutbound: () => ({
        start: async () => {}, retryNow: async () => {}, flushNow: async () => {}, wake: () => {}, handleCommitted: async () => {}, stop: async () => {},
      }),
      createReconciler: () => ({
        applyCached: async () => {},
        handle: async () => { handlingStarted(); await never; },
      }),
    });
    await engine.start();
    base.transport.emit({ type: 'invalid-document', collection: 'records', recordKey: 'key', reason: 'invalid-document' });
    await started;

    await Promise.race([
      engine.stop(),
      new Promise<never>((_, reject) => setImmediate(() => reject(new Error('stop hung')))),
    ]);
  });

  test('failed capture stays dirty and the next capture binds only its own durable completion', async () => {
    const { engine, hooks } = harness();
    await engine.start();
    const first = { captureId: crypto.randomUUID(), kind: 'put' as const, recordType: 'settings' as const, logicalId: 'main', recordKey: 'key', projectionKey: 'main' };
    const second = { ...first, captureId: crypto.randomUUID() };

    hooks().onCapture(first);
    hooks().onCaptureFailed({ ...first, category: 'schema' });
    hooks().onCapture(second);
    hooks().onCaptured({ ...second, generation: 2, mutationId: crypto.randomUUID() });

    assert.deepEqual(hooks().originFor('key'), { captureId: second.captureId, projectionKey: 'main', editVersion: 2, generation: 2, mutationId: hooks().originFor('key')?.mutationId, dirty: true });
    await engine.stop();
  });

  test('an old synthetic commit cannot recreate a marker after a newer local capture', async () => {
    const { engine, hooks } = harness();
    await engine.start();
    const old = { captureId: crypto.randomUUID(), kind: 'put' as const, recordType: 'settings' as const, logicalId: 'main', recordKey: 'key', projectionKey: 'main' };
    const newer = { ...old, captureId: crypto.randomUUID() };
    const oldMutationId = crypto.randomUUID();
    hooks().onCapture(old);
    hooks().onCaptured({ ...old, generation: 1, mutationId: oldMutationId });
    hooks().onCapture(newer);

    hooks().onCommitted({ recordKey: 'key', generation: 1, mutationId: oldMutationId, revision: 1, deleted: false });

    assert.equal(hooks().originFor('key')?.captureId, newer.captureId);
    assert.equal(hooks().committedFor('key'), undefined);
    await engine.stop();
  });
});
