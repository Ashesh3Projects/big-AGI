import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { privateProInitializeAppCheckBeforeAuth, requirePrivateProAppCheckToken } from './firebase.client';


describe('private Pro client App Check token', () => {
  test('initializes App Check before constructing Firebase Auth', () => {
    const order: string[] = [];
    const auth = privateProInitializeAppCheckBeforeAuth(
      () => { order.push('app-check'); return {}; },
      () => { order.push('auth'); return {}; },
    );
    assert.deepEqual(auth, {});
    assert.deepEqual(order, ['app-check', 'auth']);
  });

  test('rejects an empty token when production requires App Check', () => {
    assert.throws(
      () => requirePrivateProAppCheckToken('', true),
      /App Check token/i,
    );
  });

  test('permits an empty token for development and emulator use', () => {
    assert.equal(requirePrivateProAppCheckToken('', false), '');
  });
});
