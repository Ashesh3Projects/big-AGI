import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { privateProClientConfig } from '../config/privatePro.config';
import {
  createPrivateProSyncLifecycle,
  createPrivateProBufferedSyncLifecycle,
  createPrivateProStartupMutationBuffer,
  preparePrivateProPersistenceOwner,
  PrivateProUnsyncedChangesError,
  ProviderPrivateProSync,
  ProviderPrivateProSyncAccount,
  type PrivateProSyncLifecycleEngine,
  waitForPrivateProSyncLifecycleOwner,
} from './ProviderPrivateProSync';
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
    assert.deepEqual(buffer.mutations(), [first]);
    assert.deepEqual(buffer.mutations(), [first]);
    buffer.acknowledge(first);
    assert.deepEqual(buffer.mutations(), []);
    emit(first);
    emit(replacement);
    assert.deepEqual(buffer.mutations(), [replacement]);

    buffer.stop();
    assert.equal(buffer.active(), false);
    emit(first);
    assert.deepEqual(buffer.mutations(), [replacement]);
  });

  test('production persistence prepare runs the global local cutover before managed and asset activation', async () => {
    const order: string[] = [];

    await preparePrivateProPersistenceOwner({
      uid: 'uid-a', owner: Symbol('owner'), previousOwnership: null, isCurrent: () => true,
      runLocalCutover: async () => { order.push('cutover'); },
      activateManaged: async () => { order.push('activate-managed'); },
      deactivateManaged: async () => {},
      deactivateAssets: async () => {},
      prepareAssets: async () => { order.push('activate-assets'); return 'prepared'; },
    });

    assert.deepEqual(order, ['cutover', 'activate-managed', 'activate-assets']);
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
      mutations: () => [], acknowledge: () => {},
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
