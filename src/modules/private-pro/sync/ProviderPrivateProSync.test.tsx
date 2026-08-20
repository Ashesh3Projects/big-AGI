import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import Dexie from 'dexie';

import { privateProClientConfig } from '../config/privatePro.config';
import {
  preparePrivateProCrossUidTransition,
  createPrivateProSyncLifecycle,
  createPrivateProBufferedSyncLifecycle,
  createPrivateProStartupMutationBuffer,
  createProductionPrivateProSyncCoordinator,
  preparePrivateProPersistenceOwner,
  PrivateProUnsyncedChangesError,
  PrivateProWorkspaceTransitionScreen,
  ProviderPrivateProSync,
  ProviderPrivateProSyncAccount,
  runPrivateProTransitionSignOut,
  type PrivateProSyncLifecycleEngine,
  waitForPrivateProSyncLifecycleOwner,
} from './ProviderPrivateProSync';
import { createPrivateProSyncEngine } from './privatePro.sync.engine';
import { PrivateProSyncDB } from './privatePro.sync.db';
import { createPrivateProSyncStore } from './store-private-pro-sync';
import { PrivateProAccountControlContent } from '../ui/PrivateProAccountControl';
import { PrivateProAccountControl } from '../ui/PrivateProAccountControl';
import type { PrivateProSyncLocalMutation, PrivateProSyncSerializer } from './privatePro.sync.serializers';


function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve_, reject_) => { resolve = resolve_; reject = reject_; });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index++) {
    await Promise.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

class ProductionCompositionClock {
  nowMs = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now = (): number => this.nowMs;
  setTimeout = (callback: () => void, ms: number): ReturnType<typeof globalThis.setTimeout> => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowMs + Math.max(0, ms), callback });
    return id as unknown as ReturnType<typeof globalThis.setTimeout>;
  };
  clearTimeout = (id: ReturnType<typeof globalThis.setTimeout>): void => { this.timers.delete(id as unknown as number); };

  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    while (true) {
      await settle();
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      this.nowMs = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.nowMs = target;
    await settle();
  }
}

class ProductionCompositionLocks {
  private readonly queues = new Map<string, Array<{
    callback: () => Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
  }>>();
  private readonly held = new Set<string>();

  request(name: string, options: LockOptions, callback: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const queue = this.queues.get(name) ?? [];
      const entry = { callback, resolve, reject, signal: options.signal };
      queue.push(entry);
      this.queues.set(name, queue);
      options.signal?.addEventListener('abort', () => {
        const index = queue.indexOf(entry);
        if (index < 0) return;
        queue.splice(index, 1);
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
      this.pump(name);
    });
  }

  private pump(name: string): void {
    if (this.held.has(name)) return;
    const entry = this.queues.get(name)?.shift();
    if (!entry) return;
    if (entry.signal?.aborted) {
      entry.reject(new DOMException('aborted', 'AbortError'));
      this.pump(name);
      return;
    }
    this.held.add(name);
    void entry.callback().then(entry.resolve, entry.reject).finally(() => {
      this.held.delete(name);
      this.pump(name);
    });
  }
}

class ProductionCompositionBroadcastChannel {
  static readonly channels = new Map<string, Set<ProductionCompositionBroadcastChannel>>();
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;

  constructor(readonly name: string) {
    const peers = ProductionCompositionBroadcastChannel.channels.get(name) ?? new Set();
    peers.add(this);
    ProductionCompositionBroadcastChannel.channels.set(name, peers);
  }

  postMessage(message: unknown): void {
    for (const peer of ProductionCompositionBroadcastChannel.channels.get(this.name) ?? []) {
      if (peer !== this) peer.onmessage?.({ data: message } as MessageEvent<unknown>);
    }
  }

  close(): void {
    const peers = ProductionCompositionBroadcastChannel.channels.get(this.name);
    peers?.delete(this);
    if (!peers?.size) ProductionCompositionBroadcastChannel.channels.delete(this.name);
  }
}

function productionCompositionSerializer(): PrivateProSyncSerializer<unknown> {
  return {
    recordType: 'settings',
    schemaVersion: 1,
    conflictPolicy: 'replace',
    snapshot: async () => [],
    validate: async (_logicalId, value) => structuredClone(value),
    project: logicalId => ({ projectionKey: logicalId, referencedAssetIds: [] }),
    projection: { apply: async () => {}, remove: async () => {} },
    subscribe: () => () => {},
  };
}

function productionCompositionDB(t: TestContext): PrivateProSyncDB {
  const name = `private-pro-provider-composition-${crypto.randomUUID()}`;
  const db = new PrivateProSyncDB(name);
  t.after(async () => {
    db.close();
    await Dexie.delete(name);
  });
  return db;
}

function fakeEngine(options: { pending?: number } = {}) {
  const calls: string[] = [];
  let pending = options.pending ?? 0;
  const engine: PrivateProSyncLifecycleEngine = {
    async start() { calls.push('start'); },
    async retryNow() { calls.push('retry'); },
    async flushNow(timeoutMs) { calls.push(`flush:${timeoutMs}`); return { pending }; },
    async pendingCount() { return pending; },
    async stop() { calls.push('stop'); },
  };
  return { engine, calls, setPending: (value: number) => { pending = value; } };
}

describe('ProviderPrivateProSync', () => {
  test('production coordinator composition wakes the leader for follower-only capture without expediting its minute deadline', async (t) => {
    const uid = 'uid-production-wake';
    const db = productionCompositionDB(t);
    const locks = new ProductionCompositionLocks();
    const clock = new ProductionCompositionClock();
    const writes: number[] = [];
    const transport = {
      async write(input: { baseRevision: number }) {
        writes.push(clock.nowMs);
        return { status: 'accepted' as const, revision: input.baseRevision + 1 };
      },
      listen: () => () => {},
    };
    const createAccount = (writerId: string) => {
      const binding = createProductionPrivateProSyncCoordinator({
        uid,
        leases: db,
        locks,
        broadcastChannel: ProductionCompositionBroadcastChannel,
      });
      const engine = createPrivateProSyncEngine({
        uid,
        writerId,
        serializers: [productionCompositionSerializer()],
        db,
        coordinator: binding.coordinator,
        transport,
        runSuppressed: callback => callback(),
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
      });
      binding.bindEngine(engine);
      return { binding, engine };
    };
    const leader = createAccount('123e4567-e89b-42d3-a456-426614174101');
    const follower = createAccount('123e4567-e89b-42d3-a456-426614174102');
    t.after(async () => {
      await Promise.allSettled([leader.engine.stop(), follower.engine.stop()]);
    });
    await leader.engine.start();
    await follower.engine.start();
    await settle();
    assert.equal(leader.binding.coordinator.isLeader(), true);
    assert.equal(follower.binding.coordinator.isLeader(), false);

    await follower.engine.capture({ kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { theme: 'dark' }, referencedAssetIds: [],
    } });
    await settle();

    await clock.advance(59_999);
    assert.deepEqual(writes, []);
    await clock.advance(1);
    assert.deepEqual(writes, [60_000]);
  });

  test('a peer signed-out signal quiesces and clears the sibling lifecycle without a broadcast loop', async (t) => {
    const uid = 'uid-production-sign-out';
    const order: string[] = [];
    const locks = new ProductionCompositionLocks();
    const sender = createProductionPrivateProSyncCoordinator({ uid, locks, broadcastChannel: ProductionCompositionBroadcastChannel });
    const sibling = createProductionPrivateProSyncCoordinator({ uid, locks, broadcastChannel: ProductionCompositionBroadcastChannel });
    let loopSignals = 0;
    sender.bindLifecycle({ handleSignedOut: async () => { loopSignals++; } });
    const engine: PrivateProSyncLifecycleEngine = {
      async start() {
        order.push('start');
        await sibling.coordinator.start(context => new Promise(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true })));
      },
      async retryNow() {},
      async flushNow() { order.push('flush'); return { pending: 0 }; },
      async pendingCount() { return 0; },
      async stop() { order.push('stop'); await sibling.coordinator.stop(); },
    };
    const lifecycle = createPrivateProSyncLifecycle({
      uid,
      statusStore: createPrivateProSyncStore(),
      prepare: async () => ({ engine, coordinator: sibling.coordinator }),
      release: async () => { order.push('release'); },
      clear: async value => { order.push(`clear:${value}`); },
      firebaseSignOut: async () => { order.push('auth'); },
      reload: () => { order.push('reload'); },
      pendingCount: async () => 0,
    });
    sibling.bindLifecycle(lifecycle);
    await sender.coordinator.start(context => new Promise(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true })));
    await lifecycle.start();
    t.after(async () => { await sender.coordinator.stop(); });

    sender.coordinator.broadcastSignedOut?.();
    await settle();

    assert.deepEqual(order, ['start', 'stop', 'release', `clear:${uid}`, 'auth', 'reload']);
    assert.equal(loopSignals, 0);
  });

  test('a peer signed-out signal preempts an unresolved local sign-out decision and shares cleanup', async () => {
    const pending = deferred<{ pending: number }>();
    const order: string[] = [];
    let broadcasts = 0;
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-peer-race',
      statusStore: createPrivateProSyncStore(),
      prepare: async () => ({
        engine: {
          async start() {},
          async retryNow() {},
          flushNow: () => pending.promise,
          async pendingCount() { return 0; },
          async stop() { order.push('stop'); },
        },
        coordinator: { broadcastSignedOut: () => { broadcasts++; } },
      }),
      release: async () => { order.push('release'); },
      clear: async () => { order.push('clear'); },
      firebaseSignOut: async () => { order.push('auth'); },
      reload: () => { order.push('reload'); },
      pendingCount: async () => 0,
    });
    await lifecycle.start();
    const localSignOut = lifecycle.signOut();
    await Promise.resolve();

    await Promise.race([
      lifecycle.handleSignedOut(),
      new Promise<never>((_, reject) => setImmediate(() => reject(new Error('peer sign-out waited for local decision')))),
    ]);
    pending.resolve({ pending: 1 });
    await localSignOut;

    assert.deepEqual(order, ['stop', 'release', 'clear', 'auth', 'reload']);
    assert.equal(broadcasts, 0);
  });

  test('buffers only edits emitted while prepare is pending and reuses them after a failed attempt', async () => {
    let emit: (mutation: PrivateProSyncLocalMutation) => void = () => assert.fail('Startup buffer listener was not installed.');
    const serializer = {
      subscribe(next: (mutation: PrivateProSyncLocalMutation) => void) {
        emit = next;
        return () => { emit = () => {}; };
      },
    } as PrivateProSyncSerializer<unknown>;
    const buffer = createPrivateProStartupMutationBuffer([serializer]);
    const first: PrivateProSyncLocalMutation = { kind: 'put', record: {
      recordType: 'scratch', logicalId: 'scratch-clip', projectionKey: 'scratch-clip', schemaVersion: 1,
      value: { history: [{ id: 'one', text: 'during-cutover', timestamp: 1 }] }, referencedAssetIds: [],
    } };
    const replacement: PrivateProSyncLocalMutation = { kind: 'put', record: {
      ...first.record, value: { history: [{ id: 'two', text: 'after-retry', timestamp: 2 }] },
    } };

    buffer.start();
    emit(first);
    assert.equal(buffer.active(), true);
    emit(first);
    emit(replacement);
    assert.deepEqual(buffer.closeAndTake().map(entry => entry.mutation), [replacement]);
    assert.equal(buffer.active(), false);
    emit(first);
    assert.deepEqual(buffer.closeAndTake(), []);
  });

  test('a newer live edit supersedes a frozen startup version and prunes its metadata', () => {
    let emit: (mutation: PrivateProSyncLocalMutation) => void = () => assert.fail('Startup buffer listener was not installed.');
    const serializer = { subscribe(listener: (mutation: PrivateProSyncLocalMutation) => void) { emit = listener; return () => { emit = () => {}; }; } } as PrivateProSyncSerializer<unknown>;
    const buffer = createPrivateProStartupMutationBuffer([serializer]);
    const mutation = (value: string): PrivateProSyncLocalMutation => ({ kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1, value: { value }, referencedAssetIds: [],
    } });
    buffer.start();
    emit(mutation('old'));
    const [frozen] = buffer.closeAndTake();
    assert.deepEqual(buffer.testOnlyStateSize(), { versions: 1, failed: 0 });
    assert.equal(buffer.isCurrent(frozen), true);

    buffer.noteLiveMutation(mutation('new'));

    assert.equal(buffer.isCurrent(frozen), false);
    assert.deepEqual(buffer.testOnlyStateSize(), { versions: 0, failed: 0 });
  });

  test('startup baseline rejection is handled in the observation turn', async () => {
    let emit: (mutation: PrivateProSyncLocalMutation) => void = () => assert.fail('Startup buffer listener was not installed.');
    const serializer = { subscribe(listener: (mutation: PrivateProSyncLocalMutation) => void) { emit = listener; return () => { emit = () => {}; }; } } as PrivateProSyncSerializer<unknown>;
    const unhandled: unknown[] = [];
    const handled: Promise<unknown>[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    const onHandled = (promise: Promise<unknown>) => { handled.push(promise); };
    process.on('unhandledRejection', onUnhandled);
    process.on('rejectionHandled', onHandled);
    try {
      const buffer = createPrivateProStartupMutationBuffer([serializer], async () => { throw new Error('secret baseline failure'); });
      buffer.start();
      emit({ kind: 'put', record: {
        recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1, value: { value: 'old' }, referencedAssetIds: [],
      } });
      const [frozen] = buffer.closeAndTake();

      assert.deepEqual(await frozen.baselineGenerationResult, { ok: false });
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
      assert.deepEqual(handled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      process.off('rejectionHandled', onHandled);
    }
  });

  test('normal post-startup live mutations leave no version metadata', () => {
    const buffer = createPrivateProStartupMutationBuffer([]);
    const mutation = (index: number): PrivateProSyncLocalMutation => ({ kind: 'put', record: {
      recordType: 'settings', logicalId: `setting-${index}`, projectionKey: `setting-${index}`, schemaVersion: 1,
      value: { value: index }, referencedAssetIds: [],
    } });

    for (let index = 0; index < 5_000; index++) buffer.noteLiveMutation(mutation(index));

    assert.deepEqual(buffer.testOnlyStateSize(), { versions: 0, failed: 0 });
  });

  test('ordinary stop preserves failed startup recovery until destructive clear', () => {
    let emit: (mutation: PrivateProSyncLocalMutation) => void = () => assert.fail('Startup buffer listener was not installed.');
    const serializer = { subscribe(listener: (mutation: PrivateProSyncLocalMutation) => void) { emit = listener; return () => { emit = () => {}; }; } } as PrivateProSyncSerializer<unknown>;
    const buffer = createPrivateProStartupMutationBuffer([serializer]);
    buffer.start();
    emit({ kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { value: 'local' }, referencedAssetIds: [],
    } });
    const [entry] = buffer.closeAndTake();
    buffer.retainFailed(entry);

    buffer.stop();

    assert.deepEqual(buffer.failedEntries().map(failed => failed.mutation), [entry.mutation]);
    assert.equal(buffer.isCurrent(entry), true);
    buffer.clearFailed();
    assert.deepEqual(buffer.failedEntries(), []);
    assert.deepEqual(buffer.testOnlyStateSize(), { versions: 0, failed: 0 });
  });

  test('cross-UID cleanup error screen exposes retry and raw account sign-out', () => {
    const markup = renderToStaticMarkup(React.createElement(PrivateProWorkspaceTransitionScreen, {
      failed: true, busy: false, actionError: false, onRetry: () => {}, onSignOut: () => {},
    }));

    assert.match(markup, />Retry</);
    assert.match(markup, />Sign out</);
  });

  test('cross-UID cleanup sign-out reloads after a sanitized Firebase failure', async () => {
    const order: string[] = [];

    const succeeded = await runPrivateProTransitionSignOut(
      async () => { order.push('firebase-sign-out'); throw new Error('secret Firebase failure'); },
      () => { order.push('reload'); },
    );

    assert.equal(succeeded, false);
    assert.deepEqual(order, ['firebase-sign-out', 'reload']);
  });

  test('cross-UID cleanup sign-out still reports failure when reload throws', async () => {
    const order: string[] = [];

    const succeeded = await runPrivateProTransitionSignOut(
      async () => { order.push('firebase-sign-out'); },
      () => { order.push('reload'); throw new Error('reload failed'); },
    );

    assert.equal(succeeded, false);
    assert.deepEqual(order, ['firebase-sign-out', 'reload']);
  });

  test('production persistence prepare runs the global local cutover before managed and asset activation', async () => {
    const order: string[] = [];

    await preparePrivateProPersistenceOwner({
      uid: 'uid-a', owner: Symbol('owner'), previousOwnership: null, isCurrent: () => true,
      beforeObserve: () => { order.push('observe'); },
      runLocalCutover: async () => { order.push('cutover'); },
      activateManaged: async () => { order.push('activate-managed'); },
      deactivateManaged: async () => {},
      deactivateAssets: async () => {},
      prepareAssets: async () => { order.push('activate-assets'); return 'prepared'; },
    });

    assert.deepEqual(order, ['observe', 'cutover', 'activate-managed', 'activate-assets']);
  });

  test('failed local cutover prevents persistence activation and can be retried from the start', async () => {
    let attempts = 0;
    const order: string[] = [];
    const dependencies = () => ({
      uid: 'uid-a', owner: Symbol('owner'), previousOwnership: null, isCurrent: () => true,
      runLocalCutover: async () => {
        order.push(`cutover:${++attempts}`);
        if (attempts === 1) throw new Error('raw local cleanup failure');
      },
      activateManaged: async () => { order.push('activate-managed'); },
      deactivateManaged: async () => {},
      deactivateAssets: async () => {},
      prepareAssets: async () => { order.push('activate-assets'); return 'prepared'; },
    });

    await assert.rejects(preparePrivateProPersistenceOwner(dependencies()));
    await preparePrivateProPersistenceOwner(dependencies());

    assert.deepEqual(order, ['cutover:1', 'cutover:2', 'activate-managed', 'activate-assets']);
  });

  test('buffered lifecycle installs its observer before prepare and retains it across retry', async () => {
    const order: string[] = [];
    let attempts = 0;
    const base = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(),
      async prepare() {
        order.push(`prepare:${++attempts}`);
        if (attempts === 1) throw new Error('cutover failed');
        return { engine: fakeEngine().engine };
      },
      deactivate: async () => {}, clear: async () => {}, firebaseSignOut: async () => {}, reload: () => {}, pendingCount: async () => 0,
    });
    let active = false;
    const lifecycle = createPrivateProBufferedSyncLifecycle(base, {
      active: () => active,
      start: () => { active = true; order.push('buffer-start'); },
      closeAndTake: () => [],
      retainFailed: () => {},
      failedEntries: () => [],
      resolveFailed: () => {},
      clearFailed: () => {},
      noteLiveMutation: () => 1,
      isCurrent: () => true,
      forget: () => {},
      testOnlyStateSize: () => ({ versions: 0, failed: 0 }),
      stop: () => { active = false; order.push('buffer-stop'); },
    });

    await lifecycle.start();
    assert.deepEqual(order, ['buffer-start', 'prepare:1']);
    assert.equal(active, true);
    await lifecycle.retry();
    assert.deepEqual(order, ['buffer-start', 'prepare:1', 'prepare:2']);
    assert.equal(active, true);
    await lifecycle.stop();
    assert.equal(active, false);
  });

  test('production persistence prepare stops between cross-UID cleanup transitions when ownership is cancelled', async () => {
    const oldAssetCleanup = deferred<void>();
    let current = true;
    const order: string[] = [];
    const preparing = preparePrivateProPersistenceOwner({
      uid: 'uid-b', owner: Symbol('uid-b-owner'), previousOwnership: { uid: 'uid-a', owner: Symbol('uid-a-owner') },
      isCurrent: () => current,
      activateManaged: async () => { order.push('activate-managed'); },
      deactivateManaged: async uid => { order.push(`deactivate-managed:${uid}`); },
      deactivateAssets: async uid => { order.push(`deactivate-assets:${uid}`); await oldAssetCleanup.promise; },
      prepareAssets: async () => { order.push('activate-assets'); return 'prepared'; },
    });
    await Promise.resolve();
    current = false;
    oldAssetCleanup.resolve();
    await assert.rejects(preparing);

    assert.deepEqual(order, ['deactivate-assets:uid-a']);
  });

  test('cross-UID transition clears A before B observation and application mount', async () => {
    const order: string[] = [];
    const previous = { uid: 'uid-a', owner: Symbol('uid-a-owner') };

    await preparePrivateProCrossUidTransition({
      uid: 'uid-b', previousOwnership: previous, isCurrent: () => true,
      waitForPreviousOwner: async () => { order.push('wait-a'); },
      deactivateAssets: async () => { order.push('deactivate-a-assets'); },
      clearPrevious: async () => { order.push('clear-a'); },
      beforeObserve: () => { order.push('observe-b'); },
    });
    order.push('render-b-children');

    assert.deepEqual(order, ['wait-a', 'deactivate-a-assets', 'clear-a', 'observe-b', 'render-b-children']);
  });

  test('A cleanup mutations cannot enter B buffer but B edits after observation survive', async () => {
    let emit: (mutation: PrivateProSyncLocalMutation) => void = () => {};
    const serializer = { subscribe(listener: (mutation: PrivateProSyncLocalMutation) => void) { emit = listener; return () => { emit = () => {}; }; } } as PrivateProSyncSerializer<unknown>;
    const buffer = createPrivateProStartupMutationBuffer([serializer]);
    const mutation = (value: string): PrivateProSyncLocalMutation => ({ kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1, value: { value }, referencedAssetIds: [],
    } });

    emit(mutation('a-reset'));
    buffer.start();
    emit(mutation('b-edit'));

    assert.deepEqual(buffer.closeAndTake().map(entry => entry.mutation), [mutation('b-edit')]);
  });

  test('production persistence prepare rolls back its exact owner after managed activation is cancelled', async () => {
    const managedActivation = deferred<void>();
    const owner = Symbol('owner');
    let current = true;
    let managedOwner: object | symbol | null = null;
    let assetOwner: object | symbol | null = null;
    const preparing = preparePrivateProPersistenceOwner({
      uid: 'uid-a', owner, previousOwnership: null, isCurrent: () => current,
      activateManaged: async () => { managedOwner = owner; await managedActivation.promise; },
      deactivateManaged: async (_uid, candidate) => { if (managedOwner === candidate) managedOwner = null; },
      deactivateAssets: async (_uid, candidate) => { if (assetOwner === candidate) assetOwner = null; },
      prepareAssets: async () => { assetOwner = owner; return 'prepared'; },
    });
    await Promise.resolve();
    current = false;
    managedActivation.resolve();
    await assert.rejects(preparing);

    assert.equal(managedOwner, null);
    assert.equal(assetOwner, null);
  });

  test('stale production prepare cannot clear a newer same-UID persistence owner', async () => {
    const oldActivation = deferred<void>();
    const oldOwner = Symbol('old-owner');
    const replacementOwner = Symbol('replacement-owner');
    let oldCurrent = true;
    let managedOwner: object | symbol | null = null;
    let assetOwner: object | symbol | null = null;
    const transitions = (owner: object | symbol, wait?: Promise<void>) => ({
      uid: 'uid-a', owner, previousOwnership: null, isCurrent: () => owner === oldOwner ? oldCurrent : true,
      activateManaged: async () => { managedOwner = owner; await wait; },
      deactivateManaged: async (_uid: string, candidate: object | symbol) => { if (managedOwner === candidate) managedOwner = null; },
      deactivateAssets: async (_uid: string, candidate: object | symbol) => { if (assetOwner === candidate) assetOwner = null; },
      prepareAssets: async () => { assetOwner = owner; return owner; },
    });
    const oldPrepare = preparePrivateProPersistenceOwner(transitions(oldOwner, oldActivation.promise));
    await Promise.resolve();
    oldCurrent = false;
    await preparePrivateProPersistenceOwner(transitions(replacementOwner));
    oldActivation.resolve();
    await assert.rejects(oldPrepare);

    assert.equal(managedOwner, replacementOwner);
    assert.equal(assetOwner, replacementOwner);
  });

  test('same-UID remount prepare waits for the previous lifecycle owner to quiesce', async () => {
    const stopped = deferred<void>();
    let oldOwner!: object | symbol;
    const oldLifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(), prepare: async (_isCurrent, owner) => {
        oldOwner = owner;
        return { engine: {
          async start() {}, async retryNow() {}, async flushNow() { return { pending: 0 }; }, async pendingCount() { return 0; },
          stop: () => stopped.promise,
        } };
      },
      release: async () => {}, clear: async () => {}, firebaseSignOut: async () => {}, reload: () => {}, pendingCount: async () => 0,
    });
    await oldLifecycle.start();
    const order: string[] = [];
    const preparing = preparePrivateProPersistenceOwner({
      uid: 'uid-a', owner: Symbol('new-owner'), previousOwnership: { uid: 'uid-a', owner: oldOwner }, isCurrent: () => true,
      waitForPreviousOwner: waitForPrivateProSyncLifecycleOwner,
      activateManaged: async () => { order.push('activate'); }, deactivateManaged: async () => {}, deactivateAssets: async () => {},
      prepareAssets: async () => 'prepared',
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, []);

    stopped.resolve();
    await preparing;

    assert.deepEqual(order, ['activate']);
  });

  test('same-UID remount waits for a rejected old stop to settle before activating', async () => {
    const stopped = deferred<void>();
    let oldOwner!: object | symbol;
    const oldLifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(), prepare: async (_isCurrent, owner) => {
        oldOwner = owner;
        return { engine: {
          async start() {}, async retryNow() {}, async flushNow() { return { pending: 0 }; }, async pendingCount() { return 0; },
          stop: () => stopped.promise,
        } };
      },
      release: async () => {}, clear: async () => {}, firebaseSignOut: async () => {}, reload: () => {}, pendingCount: async () => 0,
    });
    await oldLifecycle.start();
    const order: string[] = [];
    const preparing = preparePrivateProPersistenceOwner({
      uid: 'uid-a', owner: Symbol('new-owner'), previousOwnership: { uid: 'uid-a', owner: oldOwner }, isCurrent: () => true,
      waitForPreviousOwner: waitForPrivateProSyncLifecycleOwner,
      activateManaged: async () => { order.push('activate'); }, deactivateManaged: async () => {}, deactivateAssets: async () => {},
      prepareAssets: async () => 'prepared',
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, []);

    stopped.reject(new Error('old stop failed after cleanup'));
    await preparing;

    assert.deepEqual(order, ['activate']);
  });

  test('disabled Private Pro renders children without constructing sync', () => {
    const enabled = privateProClientConfig.enabled;
    Object.defineProperty(privateProClientConfig, 'enabled', { configurable: true, value: false });
    try {
      const markup = renderToStaticMarkup(React.createElement(
        ProviderPrivateProSync,
        null,
        React.createElement('main', null, 'Open workspace'),
      ));
      assert.match(markup, /<main>Open workspace<\/main>/);
    } finally {
      Object.defineProperty(privateProClientConfig, 'enabled', { configurable: true, value: enabled });
    }
  });

  test('signed-in account renders children with no setup, unlock, recovery, or reconnect gate', () => {
    const startup = deferred<void>();
    const store = createPrivateProSyncStore();
    const markup = renderToStaticMarkup(React.createElement(
      ProviderPrivateProSyncAccount,
      {
        uid: 'uid-a',
        statusStore: store,
        lifecycle: {
          start: () => startup.promise,
          retry: async () => {},
          signOut: async () => {},
          handleSignedOut: async () => {},
          stop: async () => {},
        },
      },
      React.createElement('main', null, 'Signed-in workspace'),
    ));

    assert.match(markup, /<main>Signed-in workspace<\/main>/);
    assert.doesNotMatch(markup, /setup|unlock|recovery|reconnect|vault/i);
    startup.resolve();
  });

  test('cleanup stops the mounted engine and deactivates account-scoped persistence', async () => {
    const { engine, calls } = fakeEngine();
    const order: string[] = [];
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(),
      prepare: async () => ({ engine }),
      deactivate: async uid => { order.push(`deactivate:${uid}`); },
      clear: async () => {}, firebaseSignOut: async () => {}, reload: () => {}, pendingCount: async () => 0,
    });
    await lifecycle.start();
    await lifecycle.stop();

    assert.deepEqual(calls, ['start', 'stop']);
    assert.deepEqual(order, ['deactivate:uid-a']);
  });

  test('late startup after cleanup cannot reactivate the old account', async () => {
    const prepared = deferred<{ engine: PrivateProSyncLifecycleEngine }>();
    const { engine, calls } = fakeEngine();
    const deactivated: string[] = [];
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(), prepare: () => prepared.promise,
      deactivate: async uid => { deactivated.push(uid); },
      clear: async () => {}, firebaseSignOut: async () => {}, reload: () => {}, pendingCount: async () => 0,
    });
    const starting = lifecycle.start();
    const stopping = lifecycle.stop();
    prepared.resolve({ engine });
    await Promise.all([starting, stopping]);

    assert.deepEqual(calls, []);
    assert.deepEqual(deactivated, ['uid-a']);
  });

  test('sign-out drains for 5000 ms and requires explicit discard while pending remains', async () => {
    const { engine, calls, setPending } = fakeEngine({ pending: 3 });
    const order: string[] = [];
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(), prepare: async () => ({ engine }),
      deactivate: async () => { order.push('deactivate'); }, clear: async () => { order.push('clear'); },
      firebaseSignOut: async () => { order.push('firebase-sign-out'); }, reload: () => { order.push('reload'); }, pendingCount: async () => 3,
    });
    await lifecycle.start();

    await assert.rejects(lifecycle.signOut(), error => error instanceof PrivateProUnsyncedChangesError && error.count === 3);
    assert.deepEqual(calls, ['start', 'flush:5000']);
    assert.deepEqual(order, []);

    setPending(3);
    await lifecycle.signOut({ discardPending: true });
    assert.deepEqual(calls, ['start', 'flush:5000', 'flush:5000', 'stop']);
    assert.deepEqual(order, ['deactivate', 'clear', 'firebase-sign-out', 'reload']);
  });

  test('confirmed sign-out stops, deactivates, clears, broadcasts, signs out, and reloads in order', async () => {
    const order: string[] = [];
    const engine: PrivateProSyncLifecycleEngine = {
      async start() {}, async retryNow() {}, async flushNow() { return { pending: 0 }; },
      async pendingCount() { return 0; }, async stop() { order.push('stop'); },
    };
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(),
      prepare: async () => ({ engine, coordinator: { broadcastSignedOut: () => { order.push('broadcast'); } } }),
      deactivate: async () => { order.push('deactivate'); }, clear: async () => { order.push('clear'); },
      firebaseSignOut: async () => { order.push('firebase-sign-out'); }, reload: () => { order.push('reload'); }, pendingCount: async () => 0,
    });
    await lifecycle.start();

    await lifecycle.signOut();

    assert.deepEqual(order, ['broadcast', 'stop', 'deactivate', 'clear', 'firebase-sign-out', 'reload']);
  });

  test('concurrent confirmed sign-out calls share one cleanup sequence', async () => {
    const order: string[] = [];
    const gate = deferred<void>();
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(),
      prepare: async () => ({ engine: {
        async start() {}, async retryNow() {}, async flushNow() { order.push('flush'); await gate.promise; return { pending: 0 }; },
        async pendingCount() { return 0; }, async stop() { order.push('stop'); },
      }, coordinator: { broadcastSignedOut: () => { order.push('broadcast'); } } }),
      deactivate: async () => { order.push('deactivate'); }, clear: async () => { order.push('clear'); },
      firebaseSignOut: async () => { order.push('firebase-sign-out'); }, reload: () => { order.push('reload'); }, pendingCount: async () => 0,
    });
    await lifecycle.start();
    const first = lifecycle.signOut({ discardPending: true });
    const second = lifecycle.signOut({ discardPending: true });
    gate.resolve();
    await Promise.all([first, second]);

    assert.deepEqual(order, ['flush', 'broadcast', 'stop', 'deactivate', 'clear', 'firebase-sign-out', 'reload']);
  });

  test('pending confirmation releases the sign-out flight for one later confirmed drain', async () => {
    const { engine, calls } = fakeEngine({ pending: 2 });
    const order: string[] = [];
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(), prepare: async () => ({ engine }),
      deactivate: async () => { order.push('deactivate'); }, clear: async () => { order.push('clear'); },
      firebaseSignOut: async () => { order.push('firebase-sign-out'); }, reload: () => { order.push('reload'); }, pendingCount: async () => 2,
    });
    await lifecycle.start();

    const first = lifecycle.signOut();
    const second = lifecycle.signOut();
    await Promise.allSettled([first, second]);
    await lifecycle.signOut({ discardPending: true });

    assert.deepEqual(calls, ['start', 'flush:5000', 'flush:5000', 'stop']);
    assert.deepEqual(order, ['deactivate', 'clear', 'firebase-sign-out', 'reload']);
  });

  test('confirmed sign-out attempts every step and reload before returning a sanitized failure', async () => {
    const order: string[] = [];
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(),
      prepare: async () => ({ engine: {
        async start() {}, async retryNow() {}, async flushNow() { return { pending: 0 }; }, async pendingCount() { return 0; },
        async stop() { order.push('stop'); throw new Error('secret stop'); },
      }, coordinator: { broadcastSignedOut: () => { order.push('broadcast'); } } }),
      deactivate: async () => { order.push('deactivate'); throw new Error('secret deactivate'); },
      clear: async () => { order.push('clear'); throw new Error('secret clear'); },
      firebaseSignOut: async () => { order.push('firebase-sign-out'); throw new Error('secret auth'); },
      reload: () => { order.push('reload'); throw new Error('reload mocked'); }, pendingCount: async () => 0,
    });
    await lifecycle.start();

    await assert.rejects(lifecycle.signOut({ discardPending: true }), error => error instanceof Error && !/secret/i.test(error.message));
    assert.deepEqual(order, ['broadcast', 'stop', 'deactivate', 'clear', 'firebase-sign-out', 'reload']);
  });

  test('sign-out falls back to the durable count when the bounded flush errors', async () => {
    const order: string[] = [];
    const engine: PrivateProSyncLifecycleEngine = {
      async start() {}, async retryNow() {}, async flushNow() { throw new Error('offline'); },
      async pendingCount() { return 2; }, async stop() { order.push('stop'); },
    };
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(), prepare: async () => ({ engine }),
      deactivate: async () => {}, clear: async () => {}, firebaseSignOut: async () => {}, reload: () => {}, pendingCount: async () => 2,
    });
    await lifecycle.start();

    await assert.rejects(lifecycle.signOut(), error => error instanceof PrivateProUnsyncedChangesError && error.count === 2);
    assert.deepEqual(order, []);
  });

  test('prepare failure rolls back, reports a sanitized error, and retry reruns full startup', async () => {
    const store = createPrivateProSyncStore();
    const { engine, calls } = fakeEngine();
    const order: string[] = [];
    let attempts = 0;
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: store,
      async prepare() {
        attempts++;
        if (attempts === 1) throw new Error('secret prepare detail');
        return { engine };
      },
      deactivate: async () => { order.push('deactivate'); }, clear: async () => {},
      firebaseSignOut: async () => {}, reload: () => {}, pendingCount: async () => 0,
    });

    await lifecycle.start();
    assert.equal(store.getState().phase, 'error');
    assert.equal(store.getState().lastCategory, 'unknown');
    assert.deepEqual(order, ['deactivate']);
    await lifecycle.retry();

    assert.equal(attempts, 2);
    assert.deepEqual(calls, ['start']);
  });

  test('engine start failure attempts stop and cleanup before retry succeeds', async () => {
    const store = createPrivateProSyncStore();
    const order: string[] = [];
    let attempts = 0;
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: store,
      async prepare() {
        attempts++;
        return { engine: {
          async start() { order.push(`start:${attempts}`); if (attempts === 1) throw new Error('secret start detail'); },
          async retryNow() {}, async flushNow() { return { pending: 0 }; }, async pendingCount() { return 0; },
          async stop() { order.push(`stop:${attempts}`); },
        }, resumeStartupCapture: () => { order.push(`resume-buffer:${attempts}`); } };
      },
      deactivate: async () => { order.push('deactivate'); }, clear: async () => {},
      firebaseSignOut: async () => {}, reload: () => {}, pendingCount: async () => 0,
    });

    await lifecycle.start();
    assert.deepEqual(order, ['start:1', 'resume-buffer:1', 'stop:1', 'deactivate']);
    await lifecycle.retry();

    assert.deepEqual(order, ['start:1', 'resume-buffer:1', 'stop:1', 'deactivate', 'start:2']);
    assert.equal(store.getState().phase, 'local');
  });

  test('lifecycle preserves an engine-reported startup error after start resolves', async () => {
    const statusStore = createPrivateProSyncStore();
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore,
      prepare: async () => ({ engine: {
        async start() { statusStore.setState({ phase: 'error', lastCategory: 'schema' }); },
        async retryNow() {}, async flushNow() { return { pending: 0 }; }, async pendingCount() { return 0; }, async stop() {},
      } }),
      deactivate: async () => {}, clear: async () => {}, firebaseSignOut: async () => {}, reload: () => {}, pendingCount: async () => 0,
    });

    await lifecycle.start();

    assert.equal(statusStore.getState().phase, 'error');
    assert.equal(statusStore.getState().lastCategory, 'schema');
    await lifecycle.stop();
  });

  test('a canceled engine-start failure cannot re-arm the stopped startup buffer', async () => {
    const start = deferred<void>();
    const order: string[] = [];
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(),
      prepare: async () => ({
        engine: {
          start: () => start.promise,
          async retryNow() {}, async flushNow() { return { pending: 0 }; }, async pendingCount() { return 0; }, async stop() { order.push('stop'); },
        },
        resumeStartupCapture: () => order.push('resume-buffer'),
      }),
      deactivate: async () => { order.push('deactivate'); }, clear: async () => {},
      firebaseSignOut: async () => {}, reload: () => {}, pendingCount: async () => 0,
    });
    const starting = lifecycle.start();
    await new Promise(resolve => setImmediate(resolve));

    const stopping = lifecycle.stop();
    start.reject(new Error('late start failure'));
    await Promise.allSettled([starting, stopping]);

    assert.deepEqual(order, ['stop', 'deactivate']);
  });

  test('stop failure cannot skip release and replacement waits for stop settlement', async () => {
    const order: string[] = [];
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(),
      prepare: async () => ({ engine: {
        async start() {}, async retryNow() {}, async flushNow() { return { pending: 0 }; }, async pendingCount() { return 0; },
        async stop() { order.push('stop'); throw new Error('secret stop detail'); },
      } }),
      deactivate: async () => { order.push('deactivate'); }, clear: async () => {},
      firebaseSignOut: async () => {}, reload: () => {}, pendingCount: async () => 0,
    });
    await lifecycle.start();

    await assert.rejects(lifecycle.stop());
    assert.deepEqual(order, ['stop', 'deactivate']);
  });

  test('replacement start waits for finite old engine stop before preparing', async () => {
    const releaseStop = deferred<void>();
    const order: string[] = [];
    let prepareCount = 0;
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(),
      prepare: async () => {
        prepareCount++;
        const id = prepareCount;
        order.push(`prepare:${id}`);
        return { engine: {
          async start() { order.push(`start:${id}`); }, async retryNow() {}, async flushNow() { return { pending: 0 }; }, async pendingCount() { return 0; },
          async stop() { order.push(`stop:${id}`); if (id === 1) await releaseStop.promise; },
        } };
      },
      deactivate: async () => { order.push('deactivate'); }, clear: async () => {},
      firebaseSignOut: async () => {}, reload: () => {}, pendingCount: async () => 0,
    });
    await lifecycle.start();
    const stopping = lifecycle.stop();
    const starting = lifecycle.start();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(order.includes('prepare:2'), false);
    releaseStop.resolve();
    await Promise.all([stopping, starting]);

    assert.deepEqual(order, ['prepare:1', 'start:1', 'stop:1', 'deactivate', 'prepare:2', 'start:2']);
  });

  test('a final stop cancels a start queued behind prior cleanup', async () => {
    const cleanup = deferred<void>();
    const order: string[] = [];
    let prepares = 0;
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(),
      prepare: async () => {
        prepares++;
        order.push(`prepare:${prepares}`);
        return { engine: fakeEngine().engine };
      },
      deactivate: async () => { order.push('deactivate'); await cleanup.promise; }, clear: async () => {},
      firebaseSignOut: async () => {}, reload: () => {}, pendingCount: async () => 0,
    });
    await lifecycle.start();
    const firstStop = lifecycle.stop();
    const queuedStart = lifecycle.start();
    const finalStop = lifecycle.stop();
    cleanup.resolve();
    await Promise.all([firstStop, queuedStart, finalStop]);
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(order, ['prepare:1', 'deactivate']);
  });

  test('a final stop cancels a retry queued behind prior cleanup', async () => {
    const cleanup = deferred<void>();
    const order: string[] = [];
    let prepares = 0;
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(),
      prepare: async () => {
        prepares++;
        order.push(`prepare:${prepares}`);
        return { engine: fakeEngine().engine };
      },
      deactivate: async () => { order.push('deactivate'); await cleanup.promise; }, clear: async () => {},
      firebaseSignOut: async () => {}, reload: () => {}, pendingCount: async () => 0,
    });
    await lifecycle.start();
    const firstStop = lifecycle.stop();
    const queuedRetry = lifecycle.retry();
    const finalStop = lifecycle.stop();
    cleanup.resolve();
    await Promise.all([firstStop, queuedRetry, finalStop]);
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(order, ['prepare:1', 'deactivate']);
  });

  test('stale pending start cleanup cannot deactivate a newer successful start', async () => {
    const oldStartGate = deferred<void>();
    const order: string[] = [];
    let attempts = 0;
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(),
      prepare: async () => {
        attempts++;
        if (attempts === 1) return { engine: {
          async start() { await oldStartGate.promise; }, async retryNow() {}, async flushNow() { return { pending: 0 }; },
          async pendingCount() { return 0; }, async stop() {},
        } };
        return { engine: {
          async start() { order.push('new-start'); }, async retryNow() { order.push('new-retry'); },
          async flushNow() { return { pending: 0 }; }, async pendingCount() { return 0; }, async stop() { order.push('new-stop'); },
        } };
      },
      deactivate: async () => { order.push('deactivate'); }, clear: async () => {},
      firebaseSignOut: async () => {}, reload: () => {}, pendingCount: async () => 0,
    });
    const oldStart = lifecycle.start();
    await Promise.resolve();
    const stopping = lifecycle.stop();
    const newStart = lifecycle.retry();
    oldStartGate.resolve();
    await Promise.all([oldStart, stopping, newStart]);
    await lifecycle.retry();

    assert.deepEqual(order, ['deactivate', 'new-start', 'new-retry']);
  });

  test('double pending-count failure blocks unconfirmed sign-out without cleanup', async () => {
    const order: string[] = [];
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(), prepare: async () => ({ engine: {
        async start() {}, async retryNow() {}, async flushNow() { throw new Error('flush failed'); }, async pendingCount() { return 0; }, async stop() { order.push('stop'); },
      } }),
      deactivate: async () => { order.push('deactivate'); }, clear: async () => { order.push('clear'); },
      firebaseSignOut: async () => { order.push('auth'); }, reload: () => { order.push('reload'); }, pendingCount: async () => { throw new Error('count failed'); },
    });
    await lifecycle.start();

    await assert.rejects(lifecycle.signOut(), error => error instanceof Error && !/flush|count/i.test(error.message));
    assert.deepEqual(order, []);
  });

  test('double pending-count failure proceeds when discard is confirmed', async () => {
    const order: string[] = [];
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(), prepare: async () => ({ engine: {
        async start() {}, async retryNow() {}, async flushNow() { throw new Error('flush failed'); }, async pendingCount() { return 0; }, async stop() { order.push('stop'); },
      }, coordinator: { broadcastSignedOut: () => { order.push('broadcast'); } } }),
      deactivate: async () => { order.push('deactivate'); }, clear: async () => { order.push('clear'); },
      firebaseSignOut: async () => { order.push('auth'); }, reload: () => { order.push('reload'); }, pendingCount: async () => { throw new Error('count failed'); },
    });
    await lifecycle.start();

    await lifecycle.signOut({ discardPending: true });
    assert.deepEqual(order, ['broadcast', 'stop', 'deactivate', 'clear', 'auth', 'reload']);
  });

  test('broadcast failure cannot skip confirmed sign-out cleanup', async () => {
    const order: string[] = [];
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(), prepare: async () => ({ engine: {
        async start() {}, async retryNow() {}, async flushNow() { return { pending: 0 }; }, async pendingCount() { return 0; }, async stop() { order.push('stop'); },
      }, coordinator: { broadcastSignedOut: () => { order.push('broadcast'); throw new Error('broadcast failed'); } } }),
      deactivate: async () => { order.push('deactivate'); }, clear: async () => { order.push('clear'); },
      firebaseSignOut: async () => { order.push('auth'); }, reload: () => { order.push('reload'); }, pendingCount: async () => 0,
    });
    await lifecycle.start();

    await assert.rejects(lifecycle.signOut({ discardPending: true }));
    assert.deepEqual(order, ['broadcast', 'stop', 'deactivate', 'clear', 'auth', 'reload']);
  });

  test('start then stop in the same turn never enters prepare or engine start', async () => {
    const order: string[] = [];
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(),
      prepare: async () => { order.push('prepare'); return { engine: fakeEngine().engine }; },
      deactivate: async () => { order.push('deactivate'); }, clear: async () => {},
      firebaseSignOut: async () => {}, reload: () => {}, pendingCount: async () => 0,
    });

    void lifecycle.start();
    await lifecycle.stop();
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(order, ['deactivate']);
  });

  test('retry then stop in the same turn never enters prepare or engine start', async () => {
    const order: string[] = [];
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(),
      prepare: async () => { order.push('prepare'); return { engine: fakeEngine().engine }; },
      deactivate: async () => { order.push('deactivate'); }, clear: async () => {},
      firebaseSignOut: async () => {}, reload: () => {}, pendingCount: async () => 0,
    });

    void lifecycle.retry();
    await lifecycle.stop();
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(order, ['deactivate']);
  });

  test('never-resolving prepare cannot block stop or a replacement start', async () => {
    const firstPrepare = deferred<{ engine: PrivateProSyncLifecycleEngine }>();
    const order: string[] = [];
    let attempts = 0;
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(),
      prepare: async () => {
        attempts++;
        if (attempts === 1) return firstPrepare.promise;
        order.push('replacement-prepare');
        return { engine: {
          async start() { order.push('replacement-start'); }, async retryNow() {}, async flushNow() { return { pending: 0 }; },
          async pendingCount() { return 0; }, async stop() {},
        } };
      },
      deactivate: async () => { order.push('deactivate'); }, clear: async () => {},
      firebaseSignOut: async () => {}, reload: () => {}, pendingCount: async () => 0,
    });
    void lifecycle.start();
    await Promise.resolve();

    await Promise.race([
      lifecycle.stop(),
      new Promise<never>((_, reject) => setImmediate(() => reject(new Error('stop waited unresolved prepare')))),
    ]);
    await lifecycle.start();

    assert.deepEqual(order, ['deactivate', 'replacement-prepare', 'replacement-start']);
  });

  test('eventual stale prepare resolution stops only its local engine', async () => {
    const firstPrepare = deferred<{ engine: PrivateProSyncLifecycleEngine }>();
    const order: string[] = [];
    let attempts = 0;
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(),
      prepare: async () => {
        attempts++;
        if (attempts === 1) return firstPrepare.promise;
        return { engine: {
          async start() { order.push('new-start'); }, async retryNow() {}, async flushNow() { return { pending: 0 }; },
          async pendingCount() { return 0; }, async stop() { order.push('new-stop'); },
        } };
      },
      deactivate: async () => { order.push('deactivate'); }, clear: async () => {},
      firebaseSignOut: async () => {}, reload: () => {}, pendingCount: async () => 0,
    });
    const oldStart = lifecycle.start();
    await Promise.resolve();
    await lifecycle.stop();
    await lifecycle.start();
    firstPrepare.resolve({ engine: {
      async start() { order.push('old-start'); }, async retryNow() {}, async flushNow() { return { pending: 0 }; },
      async pendingCount() { return 0; }, async stop() { order.push('old-stop'); },
    } });
    await oldStart;

    assert.deepEqual(order, ['deactivate', 'new-start', 'old-stop']);
  });

  test('prepare receives synchronous ownership cancellation before late activation', async () => {
    const gate = deferred<void>();
    const order: string[] = [];
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(),
      prepare: async isCurrent => {
        await gate.promise;
        if (!isCurrent()) throw new Error('cancelled before activation');
        order.push('activate');
        return { engine: fakeEngine().engine };
      },
      deactivate: async () => { order.push('deactivate'); }, clear: async () => {},
      firebaseSignOut: async () => {}, reload: () => {}, pendingCount: async () => 0,
    });
    const starting = lifecycle.start();
    await Promise.resolve();
    await lifecycle.stop();
    gate.resolve();
    await starting;

    assert.deepEqual(order, ['deactivate']);
  });

  test('stop waits for the engine quiescence promise before releasing persistence', async () => {
    const order: string[] = [];
    const stopped = deferred<void>();
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(), prepare: async () => ({ engine: {
        async start() {}, async retryNow() {}, async flushNow() { return { pending: 0 }; }, async pendingCount() { return 0; },
        stop: () => { order.push('stop'); return stopped.promise; },
      } }),
      deactivate: async () => { order.push('deactivate'); }, clear: async () => {},
      firebaseSignOut: async () => {}, reload: () => {}, pendingCount: async () => 0,
    });
    await lifecycle.start();

    const stopping = lifecycle.stop();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, ['stop']);
    stopped.resolve();
    await stopping;

    assert.deepEqual(order, ['stop', 'deactivate']);
  });

  test('pending decision blocks a concurrent start until unconfirmed sign-out releases it', async () => {
    const count = deferred<number>();
    const order: string[] = [];
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(), prepare: async () => {
        order.push('prepare');
        return { engine: { async start() { order.push('start'); }, async retryNow() {}, async flushNow() { return { pending: 0 }; }, async pendingCount() { return 0; }, async stop() {} } };
      },
      deactivate: async () => {}, clear: async () => {}, firebaseSignOut: async () => {}, reload: () => {}, pendingCount: () => count.promise,
    });
    const signingOut = lifecycle.signOut();
    const starting = lifecycle.start();
    await Promise.resolve();
    assert.deepEqual(order, []);
    count.resolve(1);
    await assert.rejects(signingOut, PrivateProUnsyncedChangesError);
    await starting;

    assert.deepEqual(order, ['prepare', 'start']);
  });

  test('a final stop cancels a start queued behind an unconfirmed sign-out decision', async () => {
    const count = deferred<number>();
    const order: string[] = [];
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(),
      prepare: async () => {
        order.push('prepare');
        return { engine: fakeEngine().engine };
      },
      deactivate: async () => { order.push('deactivate'); }, clear: async () => {},
      firebaseSignOut: async () => {}, reload: () => {}, pendingCount: () => count.promise,
    });
    const signingOut = lifecycle.signOut();
    const queuedStart = lifecycle.start();
    await lifecycle.stop();
    count.resolve(1);
    await assert.rejects(signingOut, PrivateProUnsyncedChangesError);
    await queuedStart;
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(order, ['deactivate']);
  });

  test('unconfirmed decision pauses an existing prepare and then lets its attempt commit', async () => {
    const prepareGate = deferred<void>();
    const count = deferred<number>();
    const order: string[] = [];
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(), prepare: async () => {
        order.push('prepare');
        await prepareGate.promise;
        return { engine: {
          async start() { order.push('start'); }, async retryNow() {}, async flushNow() { return { pending: 0 }; },
          async pendingCount() { return 0; }, async stop() { order.push('stop'); },
        } };
      },
      deactivate: async () => {}, clear: async () => {}, firebaseSignOut: async () => {}, reload: () => {}, pendingCount: () => count.promise,
    });
    const starting = lifecycle.start();
    await Promise.resolve();
    const signingOut = lifecycle.signOut();
    prepareGate.resolve();
    await Promise.resolve();
    assert.deepEqual(order, ['prepare']);
    count.resolve(1);
    await assert.rejects(signingOut, PrivateProUnsyncedChangesError);
    await starting;

    assert.deepEqual(order, ['prepare', 'start']);
  });

  test('confirmed sign-out cancels a preparing attempt without waiting and prevents commit', async () => {
    const prepared = deferred<{ engine: PrivateProSyncLifecycleEngine }>();
    const order: string[] = [];
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(), prepare: () => prepared.promise,
      deactivate: async () => { order.push('deactivate'); }, clear: async () => { order.push('clear'); },
      firebaseSignOut: async () => { order.push('auth'); }, reload: () => { order.push('reload'); }, pendingCount: async () => 0,
    });
    const starting = lifecycle.start();
    await Promise.resolve();

    await Promise.race([
      lifecycle.signOut({ discardPending: true }),
      new Promise<never>((_, reject) => setImmediate(() => reject(new Error('sign-out waited prepare')))),
    ]);
    prepared.resolve({ engine: {
      async start() { order.push('old-start'); }, async retryNow() {}, async flushNow() { return { pending: 0 }; },
      async pendingCount() { return 0; }, async stop() { order.push('old-stop'); },
    } });
    await starting;

    assert.deepEqual(order, ['deactivate', 'clear', 'auth', 'reload', 'old-stop']);
  });

  test('confirmed sign-out waits for finite engine stop before destructive clear', async () => {
    const stopped = deferred<void>();
    const order: string[] = [];
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(), prepare: async () => ({ engine: {
        async start() {}, async retryNow() {}, async flushNow() { return { pending: 0 }; }, async pendingCount() { return 0; },
        stop: () => { order.push('stop'); return stopped.promise; },
      } }),
      deactivate: async () => { order.push('deactivate'); }, clear: async () => { order.push('clear'); },
      firebaseSignOut: async () => { order.push('auth'); }, reload: () => { order.push('reload'); }, pendingCount: async () => 0,
    });
    await lifecycle.start();

    const signingOut = lifecycle.signOut({ discardPending: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, ['stop']);
    stopped.resolve();
    await signingOut;

    assert.deepEqual(order, ['stop', 'deactivate', 'clear', 'auth', 'reload']);
  });

  test('stop during confirmed sign-out shares one deactivation and preserves the latest broadcast owner', async () => {
    const flushed = deferred<{ pending: number }>();
    const order: string[] = [];
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(), prepare: async () => ({ engine: {
        async start() {}, async retryNow() {}, flushNow: () => flushed.promise, async pendingCount() { return 0; },
        async stop() { order.push('stop'); },
      }, coordinator: { broadcastSignedOut: () => { order.push('broadcast'); } } }),
      deactivate: async () => { order.push('deactivate'); }, clear: async () => { order.push('clear'); },
      firebaseSignOut: async () => { order.push('auth'); }, reload: () => { order.push('reload'); }, pendingCount: async () => 0,
    });
    await lifecycle.start();
    const signingOut = lifecycle.signOut({ discardPending: true });
    await Promise.resolve();
    await lifecycle.stop();
    flushed.resolve({ pending: 0 });
    await signingOut;

    assert.deepEqual(order, ['stop', 'deactivate', 'broadcast', 'clear', 'auth', 'reload']);
  });

  test('confirmed sign-out after stop reuses cleanup and still broadcasts the detached owner', async () => {
    const cleanup = deferred<void>();
    const order: string[] = [];
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(), prepare: async () => ({ engine: {
        async start() {}, async retryNow() {}, async flushNow() { return { pending: 0 }; }, async pendingCount() { return 0; },
        async stop() { order.push('stop'); },
      }, coordinator: { broadcastSignedOut: () => { order.push('broadcast'); } } }),
      deactivate: async () => { order.push('deactivate'); await cleanup.promise; }, clear: async () => { order.push('clear'); },
      firebaseSignOut: async () => { order.push('auth'); }, reload: () => { order.push('reload'); }, pendingCount: async () => 0,
    });
    await lifecycle.start();
    const stopping = lifecycle.stop();
    const signingOut = lifecycle.signOut({ discardPending: true });
    cleanup.resolve();
    await Promise.all([stopping, signingOut]);

    assert.deepEqual(order, ['stop', 'deactivate', 'broadcast', 'clear', 'auth', 'reload']);
  });

  test('confirmed sign-out broadcasts and deactivates the newest prepared owner', async () => {
    const secondStart = deferred<void>();
    const order: string[] = [];
    const ownerIds = new Map<object | symbol, number>();
    let attempts = 0;
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(), prepare: async (_isCurrent, owner) => {
        const id = ++attempts;
        ownerIds.set(owner, id);
        return { engine: {
          async start() { order.push(`start:${id}`); if (id === 2) await secondStart.promise; },
          async retryNow() {}, async flushNow() { return { pending: 0 }; }, async pendingCount() { return 0; },
          async stop() { order.push(`stop:${id}`); },
        }, coordinator: { broadcastSignedOut: () => { order.push(`broadcast:${id}`); } } };
      },
      deactivate: async (_uid, owner) => { order.push(`deactivate:${ownerIds.get(owner)}`); },
      clear: async () => { order.push('clear'); }, firebaseSignOut: async () => { order.push('auth'); },
      reload: () => { order.push('reload'); }, pendingCount: async () => 0,
    });
    await lifecycle.start();
    await lifecycle.stop();
    order.length = 0;
    const starting = lifecycle.start();
    while (!order.includes('start:2')) await Promise.resolve();

    await lifecycle.signOut({ discardPending: true });
    secondStart.resolve();
    await starting;

    assert.deepEqual(order, ['start:2', 'broadcast:2', 'stop:2', 'deactivate:2', 'clear', 'auth', 'reload']);
  });

  test('sign-out after stopping a newer prepare broadcasts the old owner but awaits the newer cleanup', async () => {
    const secondPrepareStarted = deferred<void>();
    const secondPrepare = deferred<{ engine: PrivateProSyncLifecycleEngine }>();
    const secondCleanup = deferred<void>();
    const order: string[] = [];
    const ownerIds = new Map<object | symbol, number>();
    let attempts = 0;
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(), prepare: async (_isCurrent, owner) => {
        const id = ++attempts;
        ownerIds.set(owner, id);
        if (id === 2) {
          order.push('prepare:2');
          secondPrepareStarted.resolve();
          return secondPrepare.promise;
        }
        return { engine: fakeEngine().engine, coordinator: { broadcastSignedOut: () => { order.push('broadcast:1'); } } };
      },
      deactivate: async (_uid, owner) => {
        const id = ownerIds.get(owner);
        order.push(`deactivate:${id}`);
        if (id === 2) await secondCleanup.promise;
      },
      clear: async () => { order.push('clear'); }, firebaseSignOut: async () => { order.push('auth'); },
      reload: () => { order.push('reload'); }, pendingCount: async () => 0,
    });
    await lifecycle.start();
    await lifecycle.stop();
    order.length = 0;
    const starting = lifecycle.start();
    await secondPrepareStarted.promise;
    const stopping = lifecycle.stop();
    const signingOut = lifecycle.signOut({ discardPending: true });
    let signOutSettled = false;
    void signingOut.finally(() => { signOutSettled = true; });
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(order, ['prepare:2', 'deactivate:2', 'broadcast:1']);
    assert.equal(signOutSettled, false);
    secondCleanup.resolve();
    await Promise.all([stopping, signingOut]);
    secondPrepare.resolve({ engine: fakeEngine().engine });
    await starting;

    assert.deepEqual(order, ['prepare:2', 'deactivate:2', 'broadcast:1', 'clear', 'auth', 'reload']);
  });


  test('account content exposes only email, compact status, retry, and sign-out', () => {
    const markup = renderToStaticMarkup(React.createElement(PrivateProAccountControlContent, {
      email: 'friend@example.com', phase: 'offline', pending: 2, busy: false, confirmDiscard: false,
      onRetry: () => {}, onSignOut: () => {}, onConfirmDiscard: () => {}, onCancelDiscard: () => {},
    }));

    assert.match(markup, /friend@example\.com/);
    assert.match(markup, /Offline/);
    assert.match(markup, /Retry/);
    assert.match(markup, /Sign out/);
    assert.doesNotMatch(markup, /vault|password|recovery|backup|quota|device|wipe|setup|unlock/i);
  });

  test('account content shows compact generic action failure without raw detail', () => {
    const markup = renderToStaticMarkup(React.createElement(PrivateProAccountControlContent, {
      email: 'friend@example.com', phase: 'error', pending: 0, busy: false, confirmDiscard: false,
      actionError: true, onRetry: () => {}, onSignOut: () => {}, onConfirmDiscard: () => {}, onCancelDiscard: () => {},
    }));

    assert.match(markup, /Unable to complete the account action/);
    assert.doesNotMatch(markup, /secret account failure|firebase-project-secret/i);
  });

  test('disabled account control renders nothing without requiring auth or sync contexts', () => {
    const enabled = privateProClientConfig.enabled;
    Object.defineProperty(privateProClientConfig, 'enabled', { configurable: true, value: false });
    try {
      assert.equal(renderToStaticMarkup(React.createElement(PrivateProAccountControl)), '');
    } finally {
      Object.defineProperty(privateProClientConfig, 'enabled', { configurable: true, value: enabled });
    }
  });
});
