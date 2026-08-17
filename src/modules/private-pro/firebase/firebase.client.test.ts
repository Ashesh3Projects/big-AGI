import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { requirePrivateProAppCheckToken } from './firebase.client';


describe('private Pro client App Check token', () => {
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
