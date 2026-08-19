import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { privateProClientConfig } from '../config/privatePro.config';
import {
  createPrivateProSyncLifecycle,
  PrivateProUnsyncedChangesError,
  ProviderPrivateProSync,
  ProviderPrivateProSyncAccount,
  type PrivateProSyncLifecycleEngine,
} from './ProviderPrivateProSync';
import { createPrivateProSyncStore } from './store-private-pro-sync';
import { PrivateProAccountControlContent } from '../ui/PrivateProAccountControl';
import { PrivateProAccountControl } from '../ui/PrivateProAccountControl';


function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolve_ => { resolve = resolve_; });
  return { promise, resolve };
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

    assert.deepEqual(calls, ['start']);
    assert.deepEqual(deactivated, []);
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
        } };
      },
      deactivate: async () => { order.push('deactivate'); }, clear: async () => {},
      firebaseSignOut: async () => {}, reload: () => {}, pendingCount: async () => 0,
    });

    await lifecycle.start();
    assert.deepEqual(order, ['start:1', 'stop:1', 'deactivate']);
    await lifecycle.retry();

    assert.deepEqual(order, ['start:1', 'stop:1', 'deactivate', 'start:2']);
    assert.equal(store.getState().phase, 'local');
  });

  test('stop failure cannot skip deactivation and reports only after cleanup', async () => {
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

    await assert.rejects(lifecycle.stop(), error => error instanceof Error && !/secret/i.test(error.message));
    assert.deepEqual(order, ['stop', 'deactivate']);
  });

  test('start waits for a blocked stop before preparing a replacement engine', async () => {
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
