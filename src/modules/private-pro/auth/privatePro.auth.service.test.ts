import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  bootstrapPrivateProAccount,
  activatePrivateProAccountRecord,
  PrivateProAccessDeniedError,
  PrivateProResetInProgressError,
  privateProAccountIsCurrent,
  privateProBootstrapErrorCode,
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolve_ => { resolve = resolve_; });
  return { promise, resolve };
}

class FakeAdminPort implements PrivateProAuthAdminPort {
  account: PrivateProAccountRecord | null = null;
  claims: { privatePro: true; privateProEpoch: number } | null = null;
  saved = 0;
  resetState: 'absent' | 'running' | 'complete' = 'absent';
  resetStates: Array<'absent' | 'running' | 'complete'> = [];

  async getWorkspaceResetState() {
    return this.resetStates.shift() ?? this.resetState;
  }

  async activateAccount(input: { uid: string; email: string; nowMs: number }) {
    this.account = activatePrivateProAccountRecord(this.account, input);
    this.saved++;
    return structuredClone(this.account);
  }

  async activateAccountIfResetIdle(input: { uid: string; email: string; nowMs: number }) {
    if (await this.getWorkspaceResetState() === 'running') throw new PrivateProResetInProgressError();
    return this.activateAccount(input);
  }

  async setClaims(_uid: string, claims: { privatePro: true; privateProEpoch: number }) {
    this.claims = claims;
  }

  async revokeRefreshTokens() {
    // Not used by bootstrap.
  }

  async clearClaims() {
    this.claims = null;
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

  test('blocks bootstrap while the workspace reset journal is running', async () => {
    const admin = new FakeAdminPort();
    admin.resetState = 'running';
    await assert.rejects(
      bootstrapPrivateProAccount(IDENTITY, admin, { allowedEmails: new Set(['friend@example.com']), nowMs: 5000 }),
      error => error instanceof PrivateProResetInProgressError,
    );
    assert.equal(admin.saved, 0);
  });

  test('allows bootstrap after the workspace reset journal is complete', async () => {
    const admin = new FakeAdminPort();
    admin.resetState = 'complete';
    await bootstrapPrivateProAccount(IDENTITY, admin, { allowedEmails: new Set(['friend@example.com']), nowMs: 5000 });
    assert.equal(admin.saved, 1);
  });

  test('rechecks reset journal after account activation and before claims', async () => {
    const admin = new FakeAdminPort();
    admin.resetStates = ['absent', 'absent', 'running'];
    await assert.rejects(
      bootstrapPrivateProAccount(IDENTITY, admin, { allowedEmails: new Set(['friend@example.com']), nowMs: 5000 }),
      error => error instanceof PrivateProResetInProgressError,
    );
    assert.equal(admin.saved, 1);
    assert.equal(admin.claims, null);
  });

  test('does not commit activation when reset begins before the atomic activation transaction commits', async () => {
    const admin = new FakeAdminPort();
    const transactionEntered = deferred<void>();
    const releaseTransaction = deferred<void>();
    admin.activateAccount = async input => {
      transactionEntered.resolve();
      await releaseTransaction.promise;
      admin.account = activatePrivateProAccountRecord(admin.account, input);
      admin.saved++;
      return structuredClone(admin.account);
    };
    admin.activateAccountIfResetIdle = async input => {
      transactionEntered.resolve();
      await releaseTransaction.promise;
      if (admin.resetState === 'running') throw new PrivateProResetInProgressError();
      admin.account = activatePrivateProAccountRecord(admin.account, input);
      admin.saved++;
      return structuredClone(admin.account);
    };

    const bootstrap = bootstrapPrivateProAccount(IDENTITY, admin, {
      allowedEmails: new Set(['friend@example.com']),
      nowMs: 5000,
    });
    await transactionEntered.promise;
    admin.resetState = 'running';
    releaseTransaction.resolve();

    await assert.rejects(bootstrap, error => error instanceof PrivateProResetInProgressError);
    assert.equal(admin.saved, 0);
    assert.equal(admin.account, null);
    assert.equal(admin.claims, null);
  });

  test('clears newly issued claims and revokes tokens when reset starts after claim issuance', async () => {
    const admin = new FakeAdminPort();
    let revoked = 0;
    admin.resetStates = ['absent', 'absent', 'absent', 'running'];
    admin.revokeRefreshTokens = async () => { revoked++; };

    await assert.rejects(
      bootstrapPrivateProAccount(IDENTITY, admin, { allowedEmails: new Set(['friend@example.com']), nowMs: 5000 }),
      error => error instanceof PrivateProResetInProgressError,
    );

    assert.equal(admin.claims, null);
    assert.equal(revoked, 1);
  });

  test('maps claim cleanup failures to reset unavailability without exposing raw errors', async () => {
    const admin = new FakeAdminPort();
    admin.resetStates = ['absent', 'absent', 'absent', 'running'];
    admin.clearClaims = async () => { throw new Error('secret claims failure'); };
    admin.revokeRefreshTokens = async () => { throw new Error('secret revoke failure'); };

    await assert.rejects(
      bootstrapPrivateProAccount(IDENTITY, admin, { allowedEmails: new Set(['friend@example.com']), nowMs: 5000 }),
      error => error instanceof PrivateProResetInProgressError && !error.message.includes('secret'),
    );
  });

  test('maps reset lock to sanitized temporary unavailability', () => {
    assert.equal(privateProBootstrapErrorCode(new PrivateProResetInProgressError()), 'SERVICE_UNAVAILABLE');
    assert.equal(privateProBootstrapErrorCode(new PrivateProAccessDeniedError()), 'UNAUTHORIZED');
    assert.equal(privateProBootstrapErrorCode(new Error('secret')), null);
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
