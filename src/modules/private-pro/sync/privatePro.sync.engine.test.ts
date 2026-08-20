import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';
import Dexie from 'dexie';

import {
  createPrivateProSyncEngine,
  type PrivateProSyncEngineOutbound,
} from './privatePro.sync.engine';
import type { PrivateProSyncLocalMutation, PrivateProSyncSerializer } from './privatePro.sync.serializers';
import { createPrivateProSyncStore } from './store-private-pro-sync';
import type { PrivateProSyncRemoteEvent, PrivateProSyncTransport } from './privatePro.sync.transport';
import { privateProCanonicalJson, privateProContentHash, privateProRecordKey } from './privatePro.sync.codec';
import { createPrivateProSyncCoordinator } from './privatePro.sync.coordinator';
import { createPrivateProSyncOutbound } from './privatePro.sync.outbound';
import { PrivateProSyncDB } from './privatePro.sync.db';
import { createPrivateProStartupMutationBuffer } from './ProviderPrivateProSync';


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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolve_ => { resolve = resolve_; });
  return { promise, resolve };
}

function startupEntry(mutation: PrivateProSyncLocalMutation, version = 1) {
  const identity = mutation.kind === 'put' ? mutation.record : mutation;
  return { key: privateProRecordKey(identity.recordType, identity.logicalId), version, mutation, baselineGenerationResult: Promise.resolve({ ok: true, value: 0 } as const) };
}

function integrationDB(t: TestContext): PrivateProSyncDB {
  const name = `private-pro-engine-integration-${crypto.randomUUID()}`;
  const db = new PrivateProSyncDB(name);
  t.after(async () => {
    db.close();
    await Dexie.delete(name);
  });
  return db;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await settle();
  }
  assert.fail('Timed out waiting for engine state.');
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
  test('starts remote asset hydration in the background without blocking projection work', async () => {
    let hydrateStarted = false;
    let release!: () => void;
    const hydrate = new Promise<void>(resolve => { release = resolve; });
    let hooks!: Parameters<NonNullable<Parameters<typeof createPrivateProSyncEngine>[0]['createReconciler']>>[0];
    const base = harness();
    const order: string[] = [];
    const engine = createPrivateProSyncEngine({
        uid: 'uid-1', writerId: '123e4567-e89b-12d3-a456-426614174001', serializers: [base.serializer], transport: base.transport,
        db: { pendingCount: async () => 0 }, runSuppressed: callback => callback(),
        assets: { ensureUploaded: async () => {}, hydrate: async () => { hydrateStarted = true; await hydrate; } },
        createOutbound: () => ({ start: async () => {}, retryNow: async () => {}, flushNow: async () => {}, wake: () => {}, handleCommitted: async () => {}, stop: async () => {} }),
        createReconciler: input => { hooks = input; return { applyCached: async () => {}, handle: async (_event, epoch = 0) => { hooks.onHydrate?.(['asset-1'], epoch); order.push('projected'); } }; },
      });
    await engine.start();

    base.transport.emit({ type: 'invalid-document', collection: 'records', recordKey: 'record-1', reason: 'invalid-document' });
    await settle();

    assert.equal(hydrateStarted, true);
    assert.deepEqual(order, ['projected']);
    release();
    await engine.stop();
  });
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

  test('startup replay creates a local origin so cached remote state cannot overwrite the edit', async (t) => {
    const db = integrationDB(t);
    const serializer = new FakeSerializer();
    const recordKey = privateProRecordKey('settings', 'main');
    const remotePayload = privateProCanonicalJson({ value: 'cached-remote' });
    await db.commitRemoteRecord('uid-startup', {
      recordType: 'settings', logicalId: 'main', recordKey, projectionKey: 'main', schemaVersion: 1,
      payload: remotePayload, contentHash: await privateProContentHash(remotePayload), referencedAssetIds: [],
    }, { revision: 1, mutationId: crypto.randomUUID(), deleted: false }, 1);
    const startupMutation: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { value: 'edited-during-cutover' }, referencedAssetIds: [],
    } };
    const pending = new Map([['settings:main', startupMutation]]);
    let active = true;
    const startupBuffer = {
      active: () => active,
      closeAndTake: () => { active = false; const values = [...pending.values()].map(mutation => startupEntry(mutation)); pending.clear(); return values; },
    };
    let applied = false;
    serializer.projection.apply = async () => { applied = true; };
    const transport = new FakeTransport();
    const engine = createPrivateProSyncEngine({
      uid: 'uid-startup', writerId: crypto.randomUUID(), serializers: [serializer], startupBuffer,
      transport, db, runSuppressed: callback => callback(),
      createOutbound: hooks => createPrivateProSyncOutbound({
        uid: 'uid-startup', writerId: crypto.randomUUID(), serializers: [serializer], db,
        coordinator: createPrivateProSyncCoordinator({ uid: 'uid-startup', leases: db }), transport,
        shouldCapture: hooks.shouldCapture, onCapture: hooks.onCapture, onCaptured: hooks.onCaptured,
        onCaptureFailed: hooks.onCaptureFailed, onCommitted: hooks.onCommitted, onStatus: hooks.onStatus,
      }),
    });

    await engine.start();
    await settle();

    assert.equal(applied, false);
    assert.equal((await db.getOutbox('uid-startup', recordKey))?.payload, '{"value":"edited-during-cutover"}');
    await engine.stop();
  });

  test('startup buffering and outbound subscription coalesce one edit to one durable generation', async (t) => {
    const db = integrationDB(t);
    const serializer = new FakeSerializer();
    const mutation: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { value: 'same-edit' }, referencedAssetIds: [],
    } };
    const pending = new Map([['settings:main', mutation]]);
    let active = true;
    const startupBuffer = {
      active: () => active,
      closeAndTake: () => { active = false; const values = [...pending.values()].map(mutation => startupEntry(mutation)); pending.clear(); return values; },
    };
    const transport = new FakeTransport();
    const engine = createPrivateProSyncEngine({
      uid: 'uid-duplicate', writerId: crypto.randomUUID(), serializers: [serializer], startupBuffer,
      transport, db, runSuppressed: callback => callback(),
      createOutbound: hooks => {
        const outbound = createPrivateProSyncOutbound({
          uid: 'uid-duplicate', writerId: crypto.randomUUID(), serializers: [serializer], db,
          coordinator: createPrivateProSyncCoordinator({ uid: 'uid-duplicate', leases: db }), transport,
          shouldCapture: hooks.shouldCapture, onCapture: hooks.onCapture, onCaptured: hooks.onCaptured,
          onCaptureFailed: hooks.onCaptureFailed, onCommitted: hooks.onCommitted, onStatus: hooks.onStatus,
        });
        return outbound;
      },
    });

    await engine.start();
    await settle();

    assert.equal((await db.getOutbox('uid-duplicate', privateProRecordKey('settings', 'main')))?.generation, 1);
    await engine.stop();
  });

  test('queues every frozen capture synchronously before post-close edits can overtake it', async () => {
    const first: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'first', projectionKey: 'first', schemaVersion: 1, value: { value: 'old-first' }, referencedAssetIds: [],
    } };
    const oldSecond: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'second', projectionKey: 'second', schemaVersion: 1, value: { value: 'old-second' }, referencedAssetIds: [],
    } };
    const newSecond: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'second', projectionKey: 'second', schemaVersion: 1, value: { value: 'new-second' }, referencedAssetIds: [],
    } };
    const firstCapture = deferred<void>();
    const postCloseEmitted = deferred<void>();
    const calls: string[] = [];
    let active = true;
    let emitPostClose: () => void = () => assert.fail('Post-close edit hook was not installed.');
    const engine = createPrivateProSyncEngine({
      uid: 'uid-order-barrier', serializers: [new FakeSerializer()],
      startupBuffer: { active: () => active, closeAndTake: () => { active = false; return [startupEntry(first), startupEntry(oldSecond)]; } },
      transport: new FakeTransport(), db: { pendingCount: async () => 2 }, runSuppressed: callback => callback(),
      createOutbound: hooks => ({
        start: async () => { emitPostClose = () => { if (hooks.shouldCapture(newSecond)) calls.push('new-second'); }; },
        capture: mutation => {
          const identity = mutation.kind === 'put' ? mutation.record : mutation;
          calls.push(identity.logicalId === 'second' ? `old-second:${(mutation as { record: { value: { value: string } } }).record.value.value}` : 'first');
          if (identity.logicalId === 'first') {
            queueMicrotask(() => { emitPostClose(); postCloseEmitted.resolve(); });
            return firstCapture.promise;
          }
          return Promise.resolve();
        },
        retryNow: async () => {}, flushNow: async () => {}, wake: () => {}, handleCommitted: async () => {}, stop: async () => {},
      }),
      createReconciler: () => ({ applyCached: async () => {}, handle: async () => {} }),
    });

    const starting = engine.start();
    await postCloseEmitted.promise;

    assert.deepEqual(calls, ['first', 'old-second:old-second', 'new-second']);
    firstCapture.resolve();
    await starting;
    await engine.stop();
  });

  test('a synchronous frozen capture error cannot prevent later frozen entries from being invoked', async () => {
    const mutation = (logicalId: string): PrivateProSyncLocalMutation => ({ kind: 'put', record: {
      recordType: 'settings', logicalId, projectionKey: logicalId, schemaVersion: 1,
      value: { value: logicalId }, referencedAssetIds: [],
    } });
    const calls: string[] = [];
    const engine = createPrivateProSyncEngine({
      uid: 'uid-sync-capture-error', serializers: [new FakeSerializer()],
      startupBuffer: {
        active: () => false,
        closeAndTake: () => [startupEntry(mutation('first')), startupEntry(mutation('second'))],
        isCurrent: () => true,
      },
      transport: new FakeTransport(), db: {
        pendingCount: async () => 0,
      }, runSuppressed: callback => callback(),
      createOutbound: () => ({
        start: async () => {},
        capture: frozen => {
          const logicalId = frozen.kind === 'put' ? frozen.record.logicalId : frozen.logicalId;
          calls.push(logicalId);
          if (logicalId === 'first') throw new Error('synchronous capture failure');
          return Promise.resolve();
        },
        retryNow: async () => {}, flushNow: async () => {}, wake: () => {}, handleCommitted: async () => {}, stop: async () => {},
      }),
      createReconciler: () => ({ applyCached: async () => {}, handle: async () => {} }),
    });

    await engine.start();

    assert.deepEqual(calls, ['first', 'second']);
    await engine.stop();
  });

  test('a failed frozen capture is non-fatal and preserves sanitized error status', async () => {
    const store = createPrivateProSyncStore();
    const mutation: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { value: 'invalid' }, referencedAssetIds: [],
    } };
    let hooks!: Parameters<NonNullable<Parameters<typeof createPrivateProSyncEngine>[0]['createOutbound']>>[0];
    const engine = createPrivateProSyncEngine({
      uid: 'uid-nonfatal-startup', serializers: [new FakeSerializer()], statusStore: store,
      startupBuffer: { active: () => false, closeAndTake: () => [startupEntry(mutation)], isCurrent: () => true, forget: () => {} },
      transport: new FakeTransport(), db: { pendingCount: async () => 0 }, runSuppressed: callback => callback(),
      createOutbound: input => {
        hooks = input;
        return {
          start: async () => {},
          capture: async failedMutation => {
            const identity = failedMutation.kind === 'put' ? failedMutation.record : failedMutation;
            const notice = {
              captureId: crypto.randomUUID(), kind: failedMutation.kind, recordType: identity.recordType,
              logicalId: identity.logicalId, recordKey: privateProRecordKey(identity.recordType, identity.logicalId), projectionKey: identity.projectionKey,
            } as const;
            hooks.onCapture(notice);
            hooks.onCaptureFailed({ ...notice, category: 'schema' });
            hooks.onStatus({ category: 'schema' });
            throw new TypeError('secret invalid value');
          },
          retryNow: async () => {}, flushNow: async () => {}, wake: () => {}, handleCommitted: async () => {}, stop: async () => {},
        };
      },
      createReconciler: () => ({ applyCached: async () => {}, handle: async () => {} }),
    });

    await engine.start();

    assert.equal(store.getState().phase, 'error');
    assert.equal(store.getState().lastCategory, 'schema');
    assert.equal(hooks.originFor(privateProRecordKey('settings', 'main'))?.dirty, true);
    assert.equal(engine.testOnlyStartupRecoveryStateSize(), 1);
    await engine.stop();
  });

  test('real outbound keeps a post-close edit newer than every frozen record', async (t) => {
    const db = integrationDB(t);
    const serializer = new FakeSerializer();
    const firstValidationStarted = deferred<void>();
    const releaseFirstValidation = deferred<void>();
    serializer.validate = async (logicalId, value) => {
      if (logicalId === 'first') {
        firstValidationStarted.resolve();
        await releaseFirstValidation.promise;
      }
      return value;
    };
    const first: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'first', projectionKey: 'first', schemaVersion: 1,
      value: { value: 'old-first' }, referencedAssetIds: [],
    } };
    const oldSecond: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'second', projectionKey: 'second', schemaVersion: 1,
      value: { value: 'old-second' }, referencedAssetIds: [],
    } };
    const newSecond: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'second', projectionKey: 'second', schemaVersion: 1,
      value: { value: 'new-second' }, referencedAssetIds: [],
    } };
    const versions = new Map([[privateProRecordKey('settings', 'first'), 1], [privateProRecordKey('settings', 'second'), 1]]);
    let active = true;
    const startupBuffer = {
      active: () => active,
      closeAndTake: () => {
        active = false;
        return [startupEntry(first), startupEntry(oldSecond)];
      },
      noteLiveMutation: (mutation: PrivateProSyncLocalMutation) => {
        const identity = mutation.kind === 'put' ? mutation.record : mutation;
        const key = privateProRecordKey(identity.recordType, identity.logicalId);
        const version = (versions.get(key) ?? 0) + 1;
        versions.set(key, version);
        return version;
      },
      isCurrent: (entry: ReturnType<typeof startupEntry>) => versions.get(entry.key) === entry.version,
      forget: (key: string, version: number) => { if (versions.get(key) === version) versions.delete(key); },
    };
    const transport = new FakeTransport();
    const engine = createPrivateProSyncEngine({
      uid: 'uid-real-order-barrier', writerId: crypto.randomUUID(), serializers: [serializer], startupBuffer,
      transport, db, runSuppressed: callback => callback(),
      createOutbound: hooks => createPrivateProSyncOutbound({
        uid: 'uid-real-order-barrier', writerId: crypto.randomUUID(), serializers: [serializer], db,
        coordinator: createPrivateProSyncCoordinator({ uid: 'uid-real-order-barrier', leases: db }), transport,
        shouldCapture: hooks.shouldCapture, onCapture: hooks.onCapture, onCaptured: hooks.onCaptured,
        onCaptureFailed: hooks.onCaptureFailed, onCommitted: hooks.onCommitted, onStatus: hooks.onStatus,
      }),
    });

    const starting = engine.start();
    await firstValidationStarted.promise;
    serializer.listener?.(newSecond);
    releaseFirstValidation.resolve();
    await starting;

    const secondRecordKey = privateProRecordKey('settings', 'second');
    let second = await db.getOutbox('uid-real-order-barrier', secondRecordKey);
    for (let attempt = 0; attempt < 20 && second?.payload !== '{"value":"new-second"}'; attempt++) {
      await settle();
      second = await db.getOutbox('uid-real-order-barrier', secondRecordKey);
    }
    assert.equal(second?.payload, '{"value":"new-second"}');
    assert.equal(second?.generation, 2);
    await engine.stop();
  });

  test('failed frozen capture waits for newer live durability and retry never replays the old value', async (t) => {
    const uid = 'uid-real-failure-handoff';
    const db = integrationDB(t);
    const serializer = new FakeSerializer();
    const firstValidationStarted = deferred<void>();
    const releaseFirstValidation = deferred<void>();
    let failFirst = true;
    serializer.validate = async (logicalId, value) => {
      if (logicalId === 'first' && failFirst) {
        firstValidationStarted.resolve();
        await releaseFirstValidation.promise;
        failFirst = false;
        throw new TypeError('forced frozen failure');
      }
      return value;
    };
    const first: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'first', projectionKey: 'first', schemaVersion: 1,
      value: { value: 'old-first' }, referencedAssetIds: [],
    } };
    const oldSecond: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'second', projectionKey: 'second', schemaVersion: 1,
      value: { value: 'old-second' }, referencedAssetIds: [],
    } };
    const newSecond: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'second', projectionKey: 'second', schemaVersion: 1,
      value: { value: 'new-second' }, referencedAssetIds: [],
    } };
    const versions = new Map([[privateProRecordKey('settings', 'first'), 1], [privateProRecordKey('settings', 'second'), 1]]);
    const pending = new Map([
      [privateProRecordKey('settings', 'first'), startupEntry(first)],
      [privateProRecordKey('settings', 'second'), startupEntry(oldSecond)],
    ]);
    let active = true;
    const startupBuffer = {
      active: () => active,
      closeAndTake: () => {
        active = false;
        const entries = [...pending.values()];
        pending.clear();
        return entries;
      },
      noteLiveMutation: (mutation: PrivateProSyncLocalMutation) => {
        const identity = mutation.kind === 'put' ? mutation.record : mutation;
        const key = privateProRecordKey(identity.recordType, identity.logicalId);
        const version = (versions.get(key) ?? 0) + 1;
        versions.set(key, version);
        return version;
      },
      isCurrent: (entry: ReturnType<typeof startupEntry>) => versions.get(entry.key) === entry.version,
      forget: (key: string, version: number) => { if (versions.get(key) === version) versions.delete(key); },
    };
    const createEngine = () => {
      const transport = new FakeTransport();
      return createPrivateProSyncEngine({
        uid, writerId: crypto.randomUUID(), serializers: [serializer], startupBuffer,
        transport, db, runSuppressed: callback => callback(),
        createOutbound: hooks => createPrivateProSyncOutbound({
          uid, writerId: crypto.randomUUID(), serializers: [serializer], db,
          coordinator: createPrivateProSyncCoordinator({ uid, leases: db }), transport,
          shouldCapture: hooks.shouldCapture, onCapture: hooks.onCapture, onCaptured: hooks.onCaptured,
          onCaptureFailed: hooks.onCaptureFailed, onCommitted: hooks.onCommitted, onStatus: hooks.onStatus,
        }),
      });
    };

    const firstEngine = createEngine();
    const starting = firstEngine.start();
    await firstValidationStarted.promise;
    serializer.listener?.(newSecond);
    releaseFirstValidation.resolve();
    await starting;

    const secondRecordKey = privateProRecordKey('settings', 'second');
    for (let attempt = 0; attempt < 20 && (await db.getOutbox(uid, secondRecordKey))?.payload !== '{"value":"new-second"}'; attempt++) await settle();
    assert.equal((await db.getOutbox(uid, secondRecordKey))?.payload, '{"value":"new-second"}');
    assert.deepEqual([...pending.keys()], []);
    assert.equal(firstEngine.testOnlyStartupRecoveryStateSize(), 1);
    await firstEngine.stop();

    const retryEngine = createEngine();
    await retryEngine.start();

    assert.equal((await db.getOutbox(uid, secondRecordKey))?.payload, '{"value":"new-second"}');
    assert.equal((await db.getOutbox(uid, secondRecordKey))?.generation, 2);
    await retryEngine.stop();
  });

  test('drains an edit emitted during outbound startup before cache hydration', async () => {
    const first: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'first', projectionKey: 'first', schemaVersion: 1,
      value: { value: 'before-start' }, referencedAssetIds: [],
    } };
    const duringStart: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'second', projectionKey: 'second', schemaVersion: 1,
      value: { value: 'during-start' }, referencedAssetIds: [],
    } };
    const pending = new Map([['settings:first', first]]);
    let active = true;
    const order: string[] = [];
    const startupBuffer = {
      active: () => active,
      closeAndTake() { active = false; const values = [...pending.values()].map(mutation => startupEntry(mutation)); pending.clear(); return values; },
    };
    const engine = createPrivateProSyncEngine({
      uid: 'uid-transition', serializers: [new FakeSerializer()], startupBuffer,
      transport: new FakeTransport(), db: { pendingCount: async () => 2 }, runSuppressed: callback => callback(),
      createOutbound: () => ({
        start: async () => { pending.set('settings:second', duringStart); },
        capture: async mutation => {
          const identity = mutation.kind === 'put' ? mutation.record : mutation;
          order.push(`capture:${identity.logicalId}`);
        },
        retryNow: async () => {}, flushNow: async () => {}, wake: () => {}, handleCommitted: async () => {}, stop: async () => {},
      }),
      createReconciler: () => ({ applyCached: async () => { order.push('cache'); }, handle: async () => {} }),
    });

    await engine.start();

    assert.deepEqual(order, ['capture:first', 'capture:second', 'cache']);
    assert.equal(startupBuffer.active(), false);
    await engine.stop();
  });

  test('captures an edit emitted after atomic close while startup replay awaits durability', async () => {
    const first: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'first', projectionKey: 'first', schemaVersion: 1,
      value: { value: 'before-start' }, referencedAssetIds: [],
    } };
    const duringCapture: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'second', projectionKey: 'second', schemaVersion: 1,
      value: { value: 'during-capture' }, referencedAssetIds: [],
    } };
    const firstCapture = deferred<void>();
    let active = true;
    const order: string[] = [];
    let normalCapture: (mutation: PrivateProSyncLocalMutation) => void = () => assert.fail('Normal capture was not installed.');
    const startupBuffer = {
      active: () => active,
      closeAndTake() { active = false; return [startupEntry(first)]; },
    };
    const engine = createPrivateProSyncEngine({
      uid: 'uid-capture-transition', serializers: [new FakeSerializer()], startupBuffer,
      transport: new FakeTransport(), db: { pendingCount: async () => 2 }, runSuppressed: callback => callback(),
      createOutbound: hooks => ({
        start: async () => { normalCapture = mutation => { if (hooks.shouldCapture(mutation)) order.push(`normal:${mutation.kind === 'put' ? mutation.record.logicalId : mutation.logicalId}`); }; },
        capture: async mutation => {
          const identity = mutation.kind === 'put' ? mutation.record : mutation;
          order.push(`capture:${identity.logicalId}`);
          if (identity.logicalId === 'first') await firstCapture.promise;
        },
        retryNow: async () => {}, flushNow: async () => {}, wake: () => {}, handleCommitted: async () => {}, stop: async () => {},
      }),
      createReconciler: () => ({ applyCached: async () => { order.push('cache'); }, handle: async () => {} }),
    });

    const starting = engine.start();
    await settle();
    normalCapture(duringCapture);
    firstCapture.resolve();
    await starting;

    assert.deepEqual(order, ['capture:first', 'normal:second', 'cache']);
    await engine.stop();
  });

  test('atomically closes the startup buffer and replays one finite frozen batch', async () => {
    const first: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'first', projectionKey: 'first', schemaVersion: 1, value: { value: 'first' }, referencedAssetIds: [],
    } };
    const afterClose: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'second', projectionKey: 'second', schemaVersion: 1, value: { value: 'after-close' }, referencedAssetIds: [],
    } };
    let active = true;
    let closeCalls = 0;
    const normalCaptures: string[] = [];
    const startupBuffer = {
      active: () => active,
      closeAndTake() {
        closeCalls++;
        active = false;
        return [startupEntry(first)];
      },
    };
    const engine = createPrivateProSyncEngine({
      uid: 'uid-atomic', serializers: [new FakeSerializer()], startupBuffer,
      transport: new FakeTransport(), db: { pendingCount: async () => 2 }, runSuppressed: callback => callback(),
      createOutbound: hooks => ({
        start: async () => {},
        capture: async mutation => {
          const identity = mutation.kind === 'put' ? mutation.record : mutation;
          normalCaptures.push(identity.logicalId);
          if (identity.logicalId === 'first') assert.equal(hooks.shouldCapture(afterClose), true);
        },
        retryNow: async () => {}, flushNow: async () => {}, wake: () => {}, handleCommitted: async () => {}, stop: async () => {},
      }),
      createReconciler: () => ({ applyCached: async () => {}, handle: async () => {} }),
    });

    await engine.start();

    assert.equal(closeCalls, 1);
    assert.deepEqual(normalCaptures, ['first']);
    await engine.stop();
  });

  test('continuous edits cannot make startup replay unbounded', async () => {
    const frozen = Array.from({ length: 200 }, (_, index): PrivateProSyncLocalMutation => ({ kind: 'put', record: {
      recordType: 'settings', logicalId: `setting-${index}`, projectionKey: `setting-${index}`, schemaVersion: 1,
      value: { value: `value-${index}` }, referencedAssetIds: [],
    } }));
    let active = true;
    let normalCaptures = 0;
    const engine = createPrivateProSyncEngine({
      uid: 'uid-stress', serializers: [new FakeSerializer()],
      startupBuffer: { active: () => active, closeAndTake: () => { active = false; return frozen.map(mutation => startupEntry(mutation)); } },
      transport: new FakeTransport(), db: { pendingCount: async () => frozen.length }, runSuppressed: callback => callback(),
      createOutbound: hooks => ({
        start: async () => {},
        capture: async mutation => {
          if (hooks.shouldCapture(mutation)) normalCaptures++;
        },
        retryNow: async () => {}, flushNow: async () => {}, wake: () => {}, handleCommitted: async () => {}, stop: async () => {},
      }),
      createReconciler: () => ({ applyCached: async () => {}, handle: async () => {} }),
    });

    await engine.start();

    assert.equal(normalCaptures, frozen.length);
    await engine.stop();
  });

  test('startup capture failure retains only the failed frozen entry for explicit retry', async () => {
    const first: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'first', projectionKey: 'first', schemaVersion: 1, value: { value: 'first' }, referencedAssetIds: [],
    } };
    const second: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'second', projectionKey: 'second', schemaVersion: 1, value: { value: 'second' }, referencedAssetIds: [],
    } };
    let active = true;
    const forgotten: string[] = [];
    let conditionalCaptures = 0;
    const engine = createPrivateProSyncEngine({
      uid: 'uid-restore', serializers: [new FakeSerializer()],
      startupBuffer: {
        active: () => active,
        closeAndTake: () => { active = false; return [startupEntry(first), startupEntry(second)]; },
        isCurrent: () => true,
        forget: key => { forgotten.push(key); },
      },
      transport: new FakeTransport(), db: {
        pendingCount: async () => 2,
      }, runSuppressed: callback => callback(),
      createOutbound: () => ({
        start: async () => {},
        capture: async mutation => {
          const identity = mutation.kind === 'put' ? mutation.record : mutation;
          if (identity.logicalId === 'second') throw new Error('capture failed');
        },
        captureIfGeneration: async mutation => {
          conditionalCaptures++;
          const identity = mutation.kind === 'put' ? mutation.record : mutation;
          return { status: 'captured', row: {} as never, notice: {
            captureId: crypto.randomUUID(), kind: mutation.kind, recordType: identity.recordType, logicalId: identity.logicalId,
            recordKey: privateProRecordKey(identity.recordType, identity.logicalId), projectionKey: identity.projectionKey,
            generation: 1, mutationId: crypto.randomUUID(),
          } };
        },
        retryNow: async () => {}, flushNow: async () => {}, wake: () => {}, handleCommitted: async () => {}, stop: async () => {},
      }),
      createReconciler: () => ({ applyCached: async () => {}, handle: async () => {} }),
    });

    await engine.start();

    assert.equal(active, false);
    assert.deepEqual(forgotten, [privateProRecordKey('settings', 'first')]);
    await engine.retryNow();
    assert.equal(conditionalCaptures, 1);
    assert.deepEqual(forgotten, [privateProRecordKey('settings', 'first'), privateProRecordKey('settings', 'second')]);
    await engine.stop();
  });

  test('same-UID remount rehydrates failed startup recovery before applying cached state', async (t) => {
    const db = integrationDB(t);
    const serializer = new FakeSerializer();
    const recordKey = privateProRecordKey('settings', 'main');
    const cachedPayload = privateProCanonicalJson({ value: 'cached' });
    await db.commitRemoteRecord('uid-remount-recovery', {
      recordType: 'settings', logicalId: 'main', recordKey, projectionKey: 'main', schemaVersion: 1,
      payload: cachedPayload, contentHash: await privateProContentHash(cachedPayload), referencedAssetIds: [],
    }, { revision: 1, mutationId: crypto.randomUUID(), deleted: false }, 1);
    let applied = 0;
    serializer.projection.apply = async () => { applied++; };
    const startupBuffer = createPrivateProStartupMutationBuffer([serializer], async () => 0);
    startupBuffer.start();
    serializer.emit('unpersisted-local');
    const firstEngine = createPrivateProSyncEngine({
      uid: 'uid-remount-recovery', serializers: [serializer], startupBuffer,
      transport: new FakeTransport(), db, runSuppressed: callback => callback(),
      createOutbound: () => ({
        start: async () => {}, capture: async () => { throw new Error('frozen capture failed'); },
        retryNow: async () => {}, flushNow: async () => {}, wake: () => {}, handleCommitted: async () => {}, stop: async () => {},
      }),
    });

    await firstEngine.start();
    await settle();
    assert.equal(applied, 0);
    await firstEngine.stop();
    assert.equal(startupBuffer.failedEntries().length, 1);

    startupBuffer.start();
    let conditionalCaptures = 0;
    const secondEngine = createPrivateProSyncEngine({
      uid: 'uid-remount-recovery', serializers: [serializer], startupBuffer,
      transport: new FakeTransport(), db, runSuppressed: callback => callback(),
      createOutbound: hooks => ({
        start: async () => {}, capture: async () => assert.fail('Replacement startup batch must be empty.'),
        captureIfGeneration: async mutation => {
          conditionalCaptures++;
          const identity = mutation.kind === 'put' ? mutation.record : mutation;
          const notice = {
            captureId: crypto.randomUUID(), kind: mutation.kind, recordType: identity.recordType,
            logicalId: identity.logicalId, recordKey: privateProRecordKey(identity.recordType, identity.logicalId),
            projectionKey: identity.projectionKey,
          } as const;
          hooks.onCapture(notice);
          const durable = { ...notice, generation: 1, mutationId: crypto.randomUUID() };
          hooks.onCaptured(durable);
          return { status: 'captured', row: {} as never, notice: durable };
        },
        retryNow: async () => {}, flushNow: async () => {}, wake: () => {}, handleCommitted: async () => {}, stop: async () => {},
      }),
    });

    await secondEngine.start();
    await settle();

    assert.equal(applied, 0);
    assert.equal(secondEngine.testOnlyStartupRecoveryStateSize(), 1);
    await secondEngine.retryNow();
    assert.equal(conditionalCaptures, 1);
    assert.deepEqual(startupBuffer.failedEntries(), []);
    await secondEngine.stop();
  });

  test('superseded startup retry removes its temporary local origin', async () => {
    const mutation: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { value: 'old' }, referencedAssetIds: [],
    } };
    let hooks!: Parameters<NonNullable<Parameters<typeof createPrivateProSyncEngine>[0]['createOutbound']>>[0];
    let attempts = 0;
    const engine = createPrivateProSyncEngine({
      uid: 'uid-superseded-origin', serializers: [new FakeSerializer()],
      startupBuffer: {
        active: () => false,
        closeAndTake: () => [startupEntry(mutation)],
        isCurrent: () => true,
        forget: () => {},
      },
      transport: new FakeTransport(), db: { pendingCount: async () => 0 }, runSuppressed: callback => callback(),
      createOutbound: input => {
        hooks = input;
        return {
          start: async () => {},
          capture: async () => { throw new Error('startup capture failed'); },
          captureIfGeneration: async conditionalMutation => {
            attempts++;
            const identity = conditionalMutation.kind === 'put' ? conditionalMutation.record : conditionalMutation;
            const notice = {
              captureId: crypto.randomUUID(), kind: conditionalMutation.kind, recordType: identity.recordType,
              logicalId: identity.logicalId, recordKey: privateProRecordKey(identity.recordType, identity.logicalId), projectionKey: identity.projectionKey,
            } as const;
            hooks.onCapture(notice);
            return { status: 'superseded', notice };
          },
          retryNow: async () => {}, flushNow: async () => {}, wake: () => {}, handleCommitted: async () => {}, stop: async () => {},
        };
      },
      createReconciler: () => ({ applyCached: async () => {}, handle: async () => {} }),
    });

    await engine.start();
    await engine.retryNow();

    assert.equal(attempts, 1);
    assert.equal(hooks.originFor(privateProRecordKey('settings', 'main')), undefined);
    assert.equal(engine.testOnlyStartupRecoveryStateSize(), 0);
    await engine.stop();
  });

  test('a live edit during another failed baseline wait cancels its stale retry and keeps its origin', async () => {
    const mutation = (logicalId: string, value: string): PrivateProSyncLocalMutation => ({ kind: 'put', record: {
      recordType: 'settings', logicalId, projectionKey: logicalId, schemaVersion: 1, value: { value }, referencedAssetIds: [],
    } });
    const oldFirst = mutation('first', 'old-first');
    const oldSecond = mutation('second', 'old-second');
    const newFirst = mutation('first', 'new-first');
    const secondBaseline = deferred<{ ok: true; value: number } | { ok: false }>();
    const firstEntry = startupEntry(oldFirst);
    const secondEntry = { ...startupEntry(oldSecond), baselineGenerationResult: secondBaseline.promise };
    const conditionalKeys: string[] = [];
    let liveCaptureId = '';
    let emitLive: () => void = () => assert.fail('Live capture hook was not installed.');
    let outboundHooks!: Parameters<NonNullable<Parameters<typeof createPrivateProSyncEngine>[0]['createOutbound']>>[0];
    const noticeFor = (localMutation: PrivateProSyncLocalMutation) => {
      const identity = localMutation.kind === 'put' ? localMutation.record : localMutation;
      return {
        captureId: crypto.randomUUID(), kind: localMutation.kind, recordType: identity.recordType,
        logicalId: identity.logicalId, recordKey: privateProRecordKey(identity.recordType, identity.logicalId), projectionKey: identity.projectionKey,
      } as const;
    };
    const engine = createPrivateProSyncEngine({
      uid: 'uid-live-during-retry', serializers: [new FakeSerializer()],
      startupBuffer: {
        active: () => false,
        closeAndTake: () => [firstEntry, secondEntry],
        isCurrent: () => true,
        forget: () => {},
      },
      transport: new FakeTransport(), db: { pendingCount: async () => 0 }, runSuppressed: callback => callback(),
      createOutbound: hooks => {
        outboundHooks = hooks;
        return {
          start: async () => {
            emitLive = () => {
              if (!hooks.shouldCapture(newFirst)) return;
              const notice = noticeFor(newFirst);
              liveCaptureId = notice.captureId;
              hooks.onCapture(notice);
              hooks.onCaptured({ ...notice, generation: 1, mutationId: crypto.randomUUID() });
            };
          },
          capture: async localMutation => {
            const notice = noticeFor(localMutation);
            hooks.onCapture(notice);
            hooks.onCaptureFailed({ ...notice, category: 'offline' });
            throw new Error('startup capture failed');
          },
          captureIfGeneration: async localMutation => {
            const notice = noticeFor(localMutation);
            conditionalKeys.push(notice.recordKey);
            hooks.onCapture(notice);
            return { status: 'superseded', notice };
          },
          retryNow: async () => {}, flushNow: async () => {}, wake: () => {}, handleCommitted: async () => {}, stop: async () => {},
        };
      },
      createReconciler: () => ({ applyCached: async () => {}, handle: async () => {} }),
    });
    await engine.start();

    const retrying = engine.retryNow();
    await settle();
    emitLive();
    secondBaseline.resolve({ ok: true, value: 0 });
    await retrying;

    assert.deepEqual(conditionalKeys, [privateProRecordKey('settings', 'second')]);
    assert.equal(outboundHooks.originFor(privateProRecordKey('settings', 'first'))?.captureId, liveCaptureId);
    await engine.stop();
  });

  test('startup capture failure does not restore when its durable baseline cannot be verified', async () => {
    const mutation: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { value: 'frozen' }, referencedAssetIds: [],
    } };
    let forgotten = 0;
    let conditionalAttempts = 0;
    const store = createPrivateProSyncStore();
    const engine = createPrivateProSyncEngine({
      uid: 'uid-unknown-baseline', serializers: [new FakeSerializer()], statusStore: store,
      startupBuffer: {
        active: () => false,
        closeAndTake: () => [{ ...startupEntry(mutation), baselineGenerationResult: Promise.resolve({ ok: false } as const) }],
        isCurrent: () => true,
        forget: () => { forgotten++; },
      },
      transport: new FakeTransport(),
      db: {
        pendingCount: async () => 0,
      },
      runSuppressed: callback => callback(),
      createOutbound: () => ({
        start: async () => {}, capture: async () => { throw new Error('capture failed'); },
        captureIfGeneration: async () => { conditionalAttempts++; throw new Error('must not retry unknown baseline'); },
        retryNow: async () => {}, flushNow: async () => {}, wake: () => {}, handleCommitted: async () => {}, stop: async () => {},
      }),
      createReconciler: () => ({ applyCached: async () => {}, handle: async () => {} }),
    });

    await engine.start();
    await engine.retryNow();

    assert.equal(forgotten, 0);
    assert.equal(conditionalAttempts, 0);
    assert.equal(engine.testOnlyStartupRecoveryStateSize(), 1);
    assert.equal(store.getState().phase, 'error');
    assert.equal(store.getState().lastCategory, 'unknown');
    await engine.stop();
  });

  test('startup capture failure retains a dirty retry when baseline state is unknown', async () => {
    const mutation: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { value: 'frozen' }, referencedAssetIds: [],
    } };
    let forgotten = 0;
    const engine = createPrivateProSyncEngine({
      uid: 'uid-unknown-current', serializers: [new FakeSerializer()],
      startupBuffer: {
        active: () => false,
        closeAndTake: () => [startupEntry(mutation)],
        isCurrent: () => true,
        forget: () => { forgotten++; },
      },
      transport: new FakeTransport(),
      db: {
        pendingCount: async () => 0,
      },
      runSuppressed: callback => callback(),
      createOutbound: () => ({
        start: async () => {}, capture: async () => { throw new Error('capture failed'); },
        retryNow: async () => {}, flushNow: async () => {}, wake: () => {}, handleCommitted: async () => {}, stop: async () => {},
      }),
      createReconciler: () => ({ applyCached: async () => {}, handle: async () => {} }),
    });

    await engine.start();

    assert.equal(forgotten, 0);
    assert.equal(engine.testOnlyStartupRecoveryStateSize(), 1);
    await engine.stop();
  });

  test('failed old frozen mutation is not restored after a newer live durable capture', async () => {
    const oldSecond: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'second', projectionKey: 'second', schemaVersion: 1, value: { value: 'old-second' }, referencedAssetIds: [],
    } };
    const newSecond: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'second', projectionKey: 'second', schemaVersion: 1, value: { value: 'new-second' }, referencedAssetIds: [],
    } };
    let version = 1;
    let forgotten = 0;
    let durableGeneration = 0;
    let latestCaptureId = '';
    let outboundHooks!: Parameters<NonNullable<Parameters<typeof createPrivateProSyncEngine>[0]['createOutbound']>>[0];
    let emitNew: () => void = () => assert.fail('New capture hook was not installed.');
    const oldCapture = deferred<void>();
    const engine = createPrivateProSyncEngine({
      uid: 'uid-newer-live', serializers: [new FakeSerializer()],
      startupBuffer: {
        active: () => false,
        closeAndTake: () => [startupEntry(oldSecond)],
        noteLiveMutation: () => ++version,
        isCurrent: entry => entry.version === version,
        forget: () => { forgotten++; },
      },
      transport: new FakeTransport(),
      db: {
        pendingCount: async () => 1,
      },
      runSuppressed: callback => callback(),
      createOutbound: hooks => {
        outboundHooks = hooks;
        return {
        start: async () => {
          emitNew = () => {
            if (!hooks.shouldCapture(newSecond)) return;
            const notice = {
              captureId: crypto.randomUUID(), kind: 'put', recordType: 'settings', logicalId: 'second',
              recordKey: privateProRecordKey('settings', 'second'), projectionKey: 'second',
            } as const;
            latestCaptureId = notice.captureId;
            hooks.onCapture(notice);
            durableGeneration = 2;
            hooks.onCaptured({ ...notice, generation: 2, mutationId: crypto.randomUUID() });
          };
        },
        capture: mutation => {
          const value = mutation.kind === 'put' ? (mutation.record.value as { value: string }).value : '';
          if (value === 'old-second') {
            queueMicrotask(emitNew);
            return oldCapture.promise;
          }
          return Promise.resolve();
        },
        retryNow: async () => {}, flushNow: async () => {}, wake: () => {}, handleCommitted: async () => {}, stop: async () => {},
        };
      },
      createReconciler: () => ({ applyCached: async () => {}, handle: async () => {} }),
    });
    const starting = engine.start();
    await new Promise(resolve => setImmediate(resolve));
    oldCapture.resolve();
    await starting;

    assert.equal(forgotten, 1);
    assert.equal(durableGeneration, 2);
    assert.equal(engine.testOnlyStartupRecoveryStateSize(), 0);
    assert.equal(outboundHooks.originFor(privateProRecordKey('settings', 'second'))?.captureId, latestCaptureId);
    await engine.stop();
  });

  test('a stopped startup capture failure cannot restore the closed buffer', async () => {
    const mutation: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1, value: { value: 'local' }, referencedAssetIds: [],
    } };
    let rejectCapture!: (error: unknown) => void;
    const capture = new Promise<void>((_resolve, reject) => { rejectCapture = reject; });
    let restoreCalls = 0;
    const engine = createPrivateProSyncEngine({
      uid: 'uid-stopped-restore', serializers: [new FakeSerializer()],
      startupBuffer: {
        active: () => false,
        closeAndTake: () => [startupEntry(mutation)],
        isCurrent: () => true,
        forget: () => { restoreCalls++; },
      },
      transport: new FakeTransport(), db: { pendingCount: async () => 1 }, runSuppressed: callback => callback(),
      createOutbound: () => ({
        start: async () => {}, capture: () => capture,
        retryNow: async () => {}, flushNow: async () => {}, wake: () => {}, handleCommitted: async () => {}, stop: async () => {},
      }),
      createReconciler: () => ({ applyCached: async () => {}, handle: async () => {} }),
    });
    const starting = engine.start();
    await new Promise(resolve => setImmediate(resolve));

    const stopping = engine.stop();
    rejectCapture(new Error('late failure'));
    await Promise.allSettled([starting, stopping]);

    assert.equal(restoreCalls, 0);
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

    const projection = hooks().runSuppressed('main', async () => {
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

  test('suppresses only the projection under apply while unrelated edits still capture', async () => {
    const { engine, hooks, capturedMutations } = harness();
    await engine.start();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const settingsMutation: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'settings', logicalId: 'settings-a', projectionKey: 'settings-a', schemaVersion: 1,
      value: { value: 'settings' }, referencedAssetIds: [],
    } };
    const personaMutation: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'persona', logicalId: 'persona-b', projectionKey: 'persona-b', schemaVersion: 1,
      value: { value: 'persona' }, referencedAssetIds: [],
    } };

    const applying = hooks().runSuppressed('settings-a', async () => {
      assert.equal(hooks().shouldCapture(settingsMutation), false);
      assert.equal(hooks().shouldCapture(personaMutation), true);
      await gate;
      assert.equal(hooks().shouldCapture(settingsMutation), false);
    });
    assert.equal(hooks().shouldCapture(personaMutation), true);
    release();
    await applying;
    assert.equal(hooks().shouldCapture(settingsMutation), true);
    assert.equal(capturedMutations(), 0);
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

  test('stop abort-races an already-running projection scope instead of waiting forever', async () => {
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
        handle: async () => hooks.runSuppressed('main', async () => { projectionStarted(); await gate; }),
      }),
    });
    await engine.start();
    base.transport.emit({ type: 'invalid-document', collection: 'records', recordKey: 'key', reason: 'invalid-document' });
    await started;
    let stopped = false;
    const stopping = engine.stop().then(() => { stopped = true; });
    await settle();
    assert.equal(stopped, true);
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

  test('stop aborts an in-flight remote handler before it resolves', async () => {
    const base = harness();
    let handlingStarted!: () => void;
    const started = new Promise<void>(resolve => { handlingStarted = resolve; });
    let abortObserved = false;
    const engine = createPrivateProSyncEngine({
      uid: 'uid-3-abort', serializers: [base.serializer], transport: base.transport, db: { pendingCount: async () => 0 },
      runSuppressed: async callback => callback(), windowEvents: base.windowEvents,
      createOutbound: () => ({
        start: async () => {}, retryNow: async () => {}, flushNow: async () => {}, wake: () => {}, handleCommitted: async () => {}, stop: async () => {},
      }),
      createReconciler: () => ({
        applyCached: async () => {},
        handle: async (_event, _epoch, signal) => {
          assert.ok(signal);
          handlingStarted();
          await new Promise<void>(resolve => signal.addEventListener('abort', () => {
            abortObserved = true;
            resolve();
          }, { once: true }));
        },
      }),
    });
    await engine.start();
    base.transport.emit({ type: 'invalid-document', collection: 'records', recordKey: 'key', reason: 'invalid-document' });
    await started;

    await engine.stop();

    assert.equal(abortObserved, true);
  });

  test('a blocked old remote validation cannot mutate after stop, clear, and replacement start', async (t) => {
    const db = integrationDB(t);
    const transport = new FakeTransport();
    const validationStarted = deferred<void>();
    const releaseValidation = deferred<void>();
    let validations = 0;
    const serializer: PrivateProSyncSerializer<unknown> = {
      recordType: 'settings', schemaVersion: 1, conflictPolicy: 'replace', snapshot: async () => [],
      async validate(logicalId, input) {
        if (++validations === 1) {
          validationStarted.resolve();
          await releaseValidation.promise;
        }
        const value = input as { id?: unknown; value?: unknown };
        if (value.id !== logicalId || typeof value.value !== 'string') throw new TypeError('invalid settings');
        return value;
      },
      project: logicalId => ({ projectionKey: logicalId, referencedAssetIds: [] }),
      projection: { apply: async () => {}, remove: async () => {} },
      subscribe: () => () => {},
    };
    const engine = createPrivateProSyncEngine({
      uid: 'uid-integration', serializers: [serializer], transport, db, runSuppressed: callback => callback(),
      createOutbound: () => ({
        start: async () => {}, retryNow: async () => {}, flushNow: async () => {}, wake: () => {}, handleCommitted: async () => {}, stop: async () => {},
      }),
    });
    const remote = async (logicalId: string, revision: number) => {
      const payload = privateProCanonicalJson({ id: logicalId, value: `remote-${revision}` });
      return {
        type: 'record' as const,
        canonical: {
          recordKey: privateProRecordKey('settings', logicalId), recordType: 'settings' as const, logicalId, schemaVersion: 1,
          payload, contentHash: await privateProContentHash(payload), revision, mutationId: crypto.randomUUID(),
          writerId: crypto.randomUUID(), deleted: false, updatedAt: 'server-time',
        },
      };
    };
    const old = await remote('old', 1);
    const replacement = await remote('replacement', 1);
    await engine.start();
    transport.emit(old);
    await validationStarted.promise;

    await engine.stop();
    await db.clearUid('uid-integration');
    await engine.start();
    transport.emit(replacement);
    for (let attempt = 0; attempt < 20 && !await db.getLocalRecord('uid-integration', replacement.canonical.recordKey); attempt++) await settle();
    assert.notEqual(await db.getLocalRecord('uid-integration', replacement.canonical.recordKey), null);

    releaseValidation.resolve();
    await settle();
    await settle();

    assert.equal(await db.getLocalRecord('uid-integration', old.canonical.recordKey), null);
    assert.equal(await db.getRemoteBase('uid-integration', old.canonical.recordKey), null);
    await engine.stop();
  });

  test('a restarted listener queue processes new events while the old lifecycle handler never settles', async () => {
    const base = harness();
    let oldStarted!: () => void;
    const started = new Promise<void>(resolve => { oldStarted = resolve; });
    const never = new Promise<void>(() => {});
    let handles = 0;
    const engine = createPrivateProSyncEngine({
      uid: 'uid-4', serializers: [base.serializer], transport: base.transport, db: { pendingCount: async () => 0 },
      runSuppressed: async callback => callback(), windowEvents: base.windowEvents, statusStore: base.store,
      createOutbound: () => ({
        start: async () => {}, retryNow: async () => {}, flushNow: async () => {}, wake: () => {}, handleCommitted: async () => {}, stop: async () => {},
      }),
      createReconciler: () => ({
        applyCached: async () => {},
        handle: async () => {
          handles++;
          if (handles === 1) { oldStarted(); await never; }
        },
      }),
    });
    await engine.start();
    base.transport.emit({ type: 'invalid-document', collection: 'records', recordKey: 'old', reason: 'invalid-document' });
    await started;
    await engine.stop();
    await engine.start();

    base.transport.emit({ type: 'invalid-document', collection: 'records', recordKey: 'new', reason: 'invalid-document' });
    for (const collection of ['records', 'assets', 'tombstones'] as const) base.transport.emit({ type: 'current', collection });
    await waitFor(() => base.store.getState().phase === 'synced');

    assert.equal(handles, 2);
    assert.equal(base.store.getState().phase, 'synced');
    await engine.stop();
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
