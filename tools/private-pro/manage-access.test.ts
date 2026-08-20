import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildPrivateProAccountRecord, diffPrivateProAccess, type PrivateProAccessUser } from './manage-access';


const users: PrivateProAccessUser[] = [
  { uid: 'new', email: 'new@example.com', emailVerified: true, privatePro: false, claimEpoch: null, accountActive: false, accountEpoch: null },
  { uid: 'current', email: 'current@example.com', emailVerified: true, privatePro: true, claimEpoch: 2, accountActive: true, accountEpoch: 2 },
  { uid: 'stale', email: 'stale@example.com', emailVerified: true, privatePro: true, claimEpoch: 1, accountActive: true, accountEpoch: 3 },
  { uid: 'removed', email: 'removed@example.com', emailVerified: true, privatePro: true, claimEpoch: 4, accountActive: true, accountEpoch: 4 },
  { uid: 'unverified', email: 'unverified@example.com', emailVerified: false, privatePro: false, claimEpoch: null, accountActive: false, accountEpoch: null },
  { uid: 'ordinary', email: 'ordinary@example.com', emailVerified: true, privatePro: false, claimEpoch: null, accountActive: false, accountEpoch: null },
];


describe('private Pro access administration', () => {
  test('classifies grant, refresh, revoke, unchanged, and ignored users', () => {
    const result = diffPrivateProAccess(users, new Set([
      'new@example.com',
      'current@example.com',
      'stale@example.com',
      'unverified@example.com',
    ]));

    assert.deepEqual(result, {
      grant: ['new'],
      refresh: ['stale'],
      revoke: ['removed'],
      unchanged: ['current'],
      ignored: ['ordinary', 'unverified'],
    });
  });

  test('writes only the current account fields while preserving creation time', () => {
    const record = buildPrivateProAccountRecord({
      uid: 'uid-a',
      email: 'Friend@Example.com',
      current: { active: true, accessEpoch: 4, createdAtMs: 100, quotaBytes: 1, usedBytes: 2, reservedBytes: 3 },
      nowMs: 500,
    });

    assert.deepEqual(record, {
      uid: 'uid-a', email: 'friend@example.com', active: true, accessEpoch: 4, createdAtMs: 100, updatedAtMs: 500,
    });
  });
});
