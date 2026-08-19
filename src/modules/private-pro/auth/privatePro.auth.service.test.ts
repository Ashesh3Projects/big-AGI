import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  bootstrapPrivateProAccount,
  activatePrivateProAccountRecord,
  PrivateProAccessDeniedError,
  privateProAccountIsCurrent,
  type PrivateProAccountRecord,
  type PrivateProAuthAdminPort,
} from './privatePro.auth.service';
import type { PrivateProIdentity } from './privatePro.auth.types';


const IDENTITY: PrivateProIdentity = {
  uid: 'uid-123',
  email: 'friend@example.com',
  emailVerified: true,
  privatePro: false,
  privateProEpoch: null,
  issuedAt: 100,
  expiresAt: 200,
};

class FakeAdminPort implements PrivateProAuthAdminPort {
  account: PrivateProAccountRecord | null = null;
  claims: { privatePro: true; privateProEpoch: number } | null = null;
  saved = 0;

  async activateAccount(input: { uid: string; email: string; nowMs: number }) {
    this.account = activatePrivateProAccountRecord(this.account, input);
    this.saved++;
    return structuredClone(this.account);
  }

  async setClaims(_uid: string, claims: { privatePro: true; privateProEpoch: number }) {
    this.claims = claims;
  }

  async revokeRefreshTokens() {
    // Not used by bootstrap.
  }
}


describe('private Pro account bootstrap', () => {
  test('creates an active account with epoch one and no attachment quota runtime fields', async () => {
    const admin = new FakeAdminPort();

    const result = await bootstrapPrivateProAccount(IDENTITY, admin, {
      allowedEmails: new Set(['friend@example.com']),
      nowMs: 5000,
    });

    assert.deepEqual(result, {
      uid: IDENTITY.uid,
      email: IDENTITY.email,
      accessEpoch: 1,
    });
    assert.deepEqual(Object.keys(admin.account ?? {}).sort(), ['accessEpoch', 'active', 'createdAtMs', 'email', 'uid', 'updatedAtMs']);
    assert.equal(admin.account?.active, true);
    assert.deepEqual(admin.claims, { privatePro: true, privateProEpoch: 1 });
  });

  test('preserves account creation time and epoch while dropping old quota fields from the current shape', async () => {
    const admin = new FakeAdminPort();
    admin.account = {
      uid: IDENTITY.uid,
      email: IDENTITY.email,
      active: true,
      accessEpoch: 4,
      createdAtMs: 1000,
      updatedAtMs: 2000,
    } as PrivateProAccountRecord;

    const result = await bootstrapPrivateProAccount({ ...IDENTITY, privateProEpoch: 4 }, admin, {
      allowedEmails: new Set(['friend@example.com']),
      nowMs: 5000,
    });

    assert.equal(result.accessEpoch, 4);
    assert.deepEqual(result, { uid: IDENTITY.uid, email: IDENTITY.email, accessEpoch: 4 });
    assert.deepEqual(admin.claims, { privatePro: true, privateProEpoch: 4 });
  });

  test('increments the epoch when reactivating a disabled account', async () => {
    const admin = new FakeAdminPort();
    admin.account = {
      uid: IDENTITY.uid,
      email: IDENTITY.email,
      active: false,
      accessEpoch: 8,
      createdAtMs: 1000,
      updatedAtMs: 2000,
    };

    const result = await bootstrapPrivateProAccount(IDENTITY, admin, {
      allowedEmails: new Set(['friend@example.com']),
      nowMs: 5000,
    });

    assert.equal(result.accessEpoch, 9);
    assert.deepEqual(admin.claims, { privatePro: true, privateProEpoch: 9 });
  });

  test('rejects an identity outside the allowlist', async () => {
    const admin = new FakeAdminPort();

    await assert.rejects(
      bootstrapPrivateProAccount(IDENTITY, admin, {
        allowedEmails: new Set(['other@example.com']),
        nowMs: 5000,
      }),
      error => {
        assert.ok(error instanceof PrivateProAccessDeniedError);
        return true;
      },
    );
    assert.equal(admin.saved, 0);
  });
});

describe('private Pro account session state', () => {
  const account: PrivateProAccountRecord = {
    uid: IDENTITY.uid,
    email: IDENTITY.email,
    active: true,
    accessEpoch: 4,
    createdAtMs: 1000,
    updatedAtMs: 2000,
  };

  test('accepts only an active matching account and claim epoch', () => {
    assert.equal(privateProAccountIsCurrent({ ...IDENTITY, privatePro: true, privateProEpoch: 4 }, account), true);
    assert.equal(privateProAccountIsCurrent({ ...IDENTITY, privatePro: true, privateProEpoch: 3 }, account), false);
    assert.equal(privateProAccountIsCurrent({ ...IDENTITY, privatePro: false, privateProEpoch: 4 }, account), false);
    assert.equal(privateProAccountIsCurrent({ ...IDENTITY, uid: 'other', privatePro: true, privateProEpoch: 4 }, account), false);
    assert.equal(privateProAccountIsCurrent({ ...IDENTITY, privatePro: true, privateProEpoch: 4 }, { ...account, active: false }), false);
  });
});
