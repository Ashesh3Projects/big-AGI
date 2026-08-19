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
  subscribe(_listener: (mutation: PrivateProSyncLocalMutation) => void) {
    this.subscribeCount++;
    return () => { this.unsubscribeCount++; };
  }
}

class FakeTransport implements PrivateProSyncTransport {
  listener: ((event: PrivateProSyncRemoteEvent) => void) | null = null;
  closed = 0;
  async write(): Promise<never> { throw new Error('unused'); }
  listen(listener: (event: PrivateProSyncRemoteEvent) => void) {
    this.listener = listener;
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

function harness(options: { cache?: Promise<void>; pending?: number } = {}) {
  const order: string[] = [];
  const serializer = new FakeSerializer();
  const transport = new FakeTransport();
  const windowEvents = new FakeWindowEvents();
  const store = createPrivateProSyncStore();
  let pending = options.pending ?? 0;
  const outbound: PrivateProSyncEngineOutbound = {
    start: async () => { serializer.subscribe(() => {}); order.push('outbound-start'); },
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
      void hooks;
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
  return { engine, order, serializer, transport, windowEvents, store, setPending: (value: number) => { pending = value; } };
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
});
