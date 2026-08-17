import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { PrivateProIdentity } from '../auth/privatePro.auth.types';
import type { PrivateProAccountRecord } from '../auth/privatePro.auth.service';


const UID = 'uid-current';
const OTHER_UID = 'uid-other';
const EMAIL = 'friend@example.com';
const DEVICE_ID = 'ddddddddddddddddddddddddddddddddddddddddddd';
const RECORD_ID = 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr';
const NONCE_BASE64 = 'AAAAAAAAAAAAAAAA';
const CIPHERTEXT_BASE64 = 'AAAAAAAAAAAAAAAAAAAAAA==';

const state: {
  account: PrivateProAccountRecord | null;
  appCheckEnforced: boolean;
  appCheckTokenValid: boolean;
  accountError: Error | null;
  calls: Array<{ method: string; uid: string; input: unknown }>;
} = {
  account: null,
  appCheckEnforced: true,
  appCheckTokenValid: true,
  accountError: null,
  calls: [],
};

const service = {
  bootstrap: async (uid: string, deviceId: string) => {
    state.calls.push({ method: 'bootstrap', uid, input: deviceId });
    return { keyset: null, device: null };
  },
  getIndex: async (uid: string, input: unknown) => {
    state.calls.push({ method: 'getIndex', uid, input });
    return { entries: [], nextCursor: null };
  },
  getRecords: async (uid: string, input: unknown) => {
    state.calls.push({ method: 'getRecords', uid, input });
    return [];
  },
  putRecord: async (uid: string, input: unknown) => {
    state.calls.push({ method: 'putRecord', uid, input });
    return { status: 'committed' as const, revision: 1, serverUpdatedAtMs: 1 };
  },
  deleteRecord: async (uid: string, input: unknown) => {
    state.calls.push({ method: 'deleteRecord', uid, input });
    return { status: 'committed' as const, revision: 1, serverUpdatedAtMs: 1 };
  },
  putKeyset: async (uid: string, input: unknown) => {
    state.calls.push({ method: 'putKeyset', uid, input });
    return { status: 'committed' as const, keyVersion: 1, serverUpdatedAtMs: 1 };
  },
  commitMigration: async (uid: string, input: unknown) => {
    state.calls.push({ method: 'commitMigration', uid, input });
    return { status: 'committed' as const, phase: 'complete', serverUpdatedAtMs: 1 };
  },
  revokeDevice: async (uid: string, input: unknown) => {
    state.calls.push({ method: 'revokeDevice', uid, input });
    return { status: 'committed' as const, revokedAtMs: 1 };
  },
};

let routerPromise: Promise<ReturnType<(typeof import('./privatePro.vault.router'))['createPrivateProVaultRouter']>> | undefined;

function router() {
  if (!routerPromise) {
    process.env.NEXT_PUBLIC_PRIVATE_PRO_ENABLED = 'true';
    process.env.PRIVATE_PRO_ALLOWED_EMAILS = EMAIL;
    routerPromise = Promise.all([
      import('../auth/privatePro.auth.procedures.server'),
      import('./privatePro.vault.router'),
    ]).then(([procedures, routers]) => {
      const procedure = procedures.createPrivateProNodePremiumProcedure({
        async verifyAppCheckToken(token) {
          if (!token) throw new Error('App Check token required.');
          if (!state.appCheckTokenValid) throw new Error('App Check verification failed.');
        },
        async getAccount() {
          if (state.accountError) throw state.accountError;
          return state.account;
        },
      });
      return routers.createPrivateProVaultRouter(procedure, () => service as never);
    });
  }
  return routerPromise;
}

function identity(overrides: Partial<PrivateProIdentity> = {}): PrivateProIdentity {
  return {
    uid: UID,
    email: EMAIL,
    emailVerified: true,
    privatePro: true,
    privateProEpoch: 3,
    issuedAt: 1,
    expiresAt: 2,
    ...overrides,
  };
}

function account(overrides: Partial<PrivateProAccountRecord> = {}): PrivateProAccountRecord {
  return {
    uid: UID,
    email: EMAIL,
    active: true,
    accessEpoch: 3,
    quotaBytes: 1,
    usedBytes: 0,
    reservedBytes: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

function context(privateProIdentity: PrivateProIdentity | null, appCheckToken: string | null = 'app-check') {
  return {
    hostName: 'localhost',
    reqSignal: new AbortController().signal,
    privateProIdentity,
    privateProAuthError: null,
    privateProAppCheckToken: appCheckToken,
  };
}

describe('private Pro vault router authorization', () => {
  test('rejects unauthenticated, missing App Check, wrong UID, stale epoch, and inactive callers', async () => {
    const privateProVaultRouter = await router();
    const cases = [
      { name: 'unauthenticated', identity: null, token: 'app-check', stored: account() },
      { name: 'missing App Check', identity: identity(), token: null, stored: account() },
      { name: 'wrong UID', identity: identity(), token: 'app-check', stored: account({ uid: OTHER_UID }) },
      { name: 'stale epoch', identity: identity({ privateProEpoch: 2 }), token: 'app-check', stored: account() },
      { name: 'inactive account', identity: identity(), token: 'app-check', stored: account({ active: false }) },
    ] as const;

    for (const entry of cases) {
      state.account = entry.stored;
      const caller = privateProVaultRouter.createCaller(context(entry.identity, entry.token));
      await assert.rejects(caller.getIndex({ pageSize: 1 }), entry.name);
    }
  });

  test('allows the current entitled caller and derives UID only from context', async () => {
    state.account = account();
    state.calls = [];
    const privateProVaultRouter = await router();

    await privateProVaultRouter.createCaller(context(identity())).getIndex({ pageSize: 1 });

    assert.deepEqual(state.calls, [{ method: 'getIndex', uid: UID, input: { pageSize: 1 } }]);
  });

  test('does not expose authorization storage errors', async () => {
    state.accountError = new Error('firebase-project-secret-detail');
    const caller = (await router()).createCaller(context(identity()));

    await assert.rejects(caller.getIndex({ pageSize: 1 }), error => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /firebase-project-secret-detail/);
      return true;
    });
    state.accountError = null;
  });
});

describe('private Pro vault router input bounds', () => {
  test('exposes every protected vault procedure for a current account', async () => {
    state.account = account();
    const caller = (await router()).createCaller(context(identity()));

    await caller.bootstrap({ deviceId: DEVICE_ID });
    await caller.getIndex({ pageSize: 1 });
    await caller.getRecords({ opaqueRecordIds: [RECORD_ID] });
    await caller.putRecord({
      operationId: 'put-record-1',
      opaqueRecordId: RECORD_ID,
      baseRevision: 0,
      envelope: envelope(RECORD_ID, 1),
    });
    await caller.deleteRecord({
      operationId: 'delete-record-1',
      opaqueRecordId: RECORD_ID,
      baseRevision: 0,
      tombstone: {
        formatVersion: 1,
        recordType: 'settings',
        recordId: RECORD_ID,
        revision: 1,
        keyVersion: 1,
        operationId: 'delete-record-1',
        deletedAtMs: 1,
      },
    });
    await caller.putKeyset({ operationId: 'put-keyset-1', baseKeyVersion: 0, keyset: keyset(1) });
    await caller.commitMigration({ operationId: 'migration-1', migrationId: 'legacy-v1', basePhase: null, phase: 'complete' });
    await caller.revokeDevice({ operationId: 'revoke-device-1', deviceId: DEVICE_ID });
  });

  test('rejects UID injection, oversized pages/counts/ciphertext, and malformed operation IDs', async () => {
    state.account = account();
    const caller = (await router()).createCaller(context(identity()));

    await assert.rejects(caller.getIndex({ pageSize: 501 }));
    await assert.rejects(caller.getRecords({ opaqueRecordIds: Array.from({ length: 501 }, () => RECORD_ID) }));
    await assert.rejects(caller.putRecord({
      operationId: 'put-record-1',
      opaqueRecordId: RECORD_ID,
      baseRevision: 0,
      envelope: envelope(RECORD_ID, 1, 700 * 1024 + 1),
    }));
    await assert.rejects(caller.revokeDevice({ operationId: 'spaces are invalid', deviceId: DEVICE_ID }));
    await assert.rejects((caller.getIndex as (input: unknown) => Promise<unknown>)({ pageSize: 1, uid: OTHER_UID }));
  });
});

function envelope(recordId: string, revision: number, ciphertextBytes = 16) {
  return {
    formatVersion: 1 as const,
    recordType: 'settings' as const,
    recordId,
    schemaVersion: 1,
    keyVersion: 1,
    revision,
    nonceBase64: NONCE_BASE64,
    ciphertextBase64: ciphertextBytes === 16 ? CIPHERTEXT_BASE64 : Buffer.alloc(ciphertextBytes).toString('base64'),
    ciphertextBytes,
  };
}

function keyset(keyVersion: number) {
  return {
    formatVersion: 1 as const,
    keyVersion,
    passwordEnvelope: {
      formatVersion: 1 as const,
      keyVersion,
      kdf: { algorithm: 'pbkdf2-sha256' as const, saltBase64: 'AAAAAAAAAAAAAAAAAAAAAA==', iterations: 600_000 },
      nonceBase64: NONCE_BASE64,
      ciphertextBase64: CIPHERTEXT_BASE64,
      ciphertextBytes: 16,
    },
    recoveryEnvelope: {
      formatVersion: 1 as const,
      keyVersion,
      recoveryVersion: 1,
      nonceBase64: NONCE_BASE64,
      ciphertextBase64: CIPHERTEXT_BASE64,
      ciphertextBytes: 16,
    },
  };
}
