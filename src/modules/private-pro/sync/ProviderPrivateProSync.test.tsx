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
    await lifecycle.stop();
    prepared.resolve({ engine });
    await starting;

    assert.deepEqual(calls, ['stop']);
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

    assert.deepEqual(order, ['stop', 'deactivate', 'clear', 'broadcast', 'firebase-sign-out', 'reload']);
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
