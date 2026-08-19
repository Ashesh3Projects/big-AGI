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
const CHALLENGE_ID = 'ccccccccccccccccccccccccccccccccccccccccccc';
const CHALLENGE_BASE64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

const state: {
  account: PrivateProAccountRecord | null;
  appCheckEnforced: boolean;
  appCheckTokenValid: boolean;
  accountError: Error | null;
  putKeysetError: Error | null;
  calls: Array<{ method: string; uid: string; input: unknown }>;
  devices: Map<string, { deviceId: string; keyVersion: number; revokedAtMs: number | null }>;
} = {
  account: null,
  appCheckEnforced: true,
  appCheckTokenValid: true,
  accountError: null,
  putKeysetError: null,
  calls: [],
  devices: new Map(),
};

const service = {
  getKeyset: async () => ({ keyset: keyset(1), serverUpdatedAtMs: 1 }),
  bootstrap: async (uid: string, deviceId: string) => {
    state.calls.push({ method: 'bootstrap', uid, input: deviceId });
    return { keyset: null, device: null };
  },
  getIndex: async (uid: string, input: unknown) => {
    state.calls.push({ method: 'getIndex', uid, input });
    return { entries: [], nextCursor: null };
  },
  listDevices: async (uid: string) => {
    state.calls.push({ method: 'listDevices', uid, input: undefined });
    return [...state.devices.values()].map(device => ({
      formatVersion: 1 as const,
      createdAtMs: 1,
      lastSeenAtMs: 1,
      ...device,
    }));
  },
  beginDeviceRegistration: async (uid: string, input: { deviceId: string; keyVersion: number }) => {
    state.calls.push({ method: 'beginDeviceRegistration', uid, input });
    return { formatVersion: 1 as const, challengeId: CHALLENGE_ID, challengeBase64: CHALLENGE_BASE64, expiresAtMs: 301_000, ...input };
  },
  completeDeviceRegistration: async (uid: string, input: { deviceId: string; keyVersion: number; operationId: string; signatureBase64: string }) => {
    state.calls.push({ method: 'completeDeviceRegistration', uid, input });
    state.devices.set(input.deviceId, { deviceId: input.deviceId, keyVersion: input.keyVersion, revokedAtMs: null });
    return { status: 'registered' as const, device: { formatVersion: 1 as const, createdAtMs: 1, lastSeenAtMs: 1, ...state.devices.get(input.deviceId)! } };
  },
  getRecords: async (uid: string, input: unknown) => {
    state.calls.push({ method: 'getRecords', uid, input });
    return [];
  },
  putRecord: async (uid: string, input: unknown) => {
    state.calls.push({ method: 'putRecord', uid, input });
    return { status: 'committed' as const, revision: 1, serverUpdatedAtMs: 1 };
  },
  mergeBackup: async (uid: string, input: unknown) => {
    state.calls.push({ method: 'mergeBackup', uid, input });
    return { status: 'committed' as const, records: [] };
  },
  beginBackupRestore: async (uid: string, input: unknown) => {
    state.calls.push({ method: 'beginBackupRestore', uid, input });
    return { status: 'started' as const };
  },
  getBackupRestoreStatus: async (uid: string, restoreId: string) => {
    state.calls.push({ method: 'getBackupRestoreStatus', uid, input: restoreId });
    return { phase: 'merging' as const, nextChunkIndex: 0 };
  },
  mergeBackupRestoreChunk: async (uid: string, input: unknown) => {
    state.calls.push({ method: 'mergeBackupRestoreChunk', uid, input });
    return { status: 'committed' as const, records: [], nextChunkIndex: 1 };
  },
  getBackupRestoreIndex: async (uid: string, restoreId: string, input: unknown) => {
    state.calls.push({ method: 'getBackupRestoreIndex', uid, input: { restoreId, input } });
    return { entries: [], nextCursor: null };
  },
  getBackupRestoreRecords: async (uid: string, restoreId: string, input: unknown) => {
    state.calls.push({ method: 'getBackupRestoreRecords', uid, input: { restoreId, input } });
    return [];
  },
  sealBackupRestore: async (uid: string, input: unknown) => {
    state.calls.push({ method: 'sealBackupRestore', uid, input });
    return { status: 'sealed' as const, sessionFingerprint: 's'.repeat(43) };
  },
  confirmBackupRestoreVerified: async (uid: string, input: unknown) => {
    state.calls.push({ method: 'confirmBackupRestoreVerified', uid, input });
    return { status: 'completed' as const };
  },
  deleteRecord: async (uid: string, input: unknown) => {
    state.calls.push({ method: 'deleteRecord', uid, input });
    return { status: 'committed' as const, revision: 1, serverUpdatedAtMs: 1 };
  },
  putKeyset: async (uid: string, input: unknown) => {
    state.calls.push({ method: 'putKeyset', uid, input });
    if (state.putKeysetError) throw state.putKeysetError;
    return { status: 'committed' as const, wrappingVersion: 1, serverUpdatedAtMs: 1 };
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

type VaultRouterCaller = ReturnType<Awaited<ReturnType<typeof router>>['createCaller']>;
type AssertFalse<T extends false> = T;
type _CommitMigrationIsNotAProcedure = AssertFalse<'commitMigration' extends keyof VaultRouterCaller ? true : false>;

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
    state.devices.set(DEVICE_ID, { deviceId: DEVICE_ID, keyVersion: 1, revokedAtMs: null });
    state.calls = [];
    const privateProVaultRouter = await router();

    await privateProVaultRouter.createCaller(context(identity())).getIndex({ pageSize: 1 });

    assert.deepEqual(state.calls.slice(-1), [{ method: 'getIndex', uid: UID, input: { pageSize: 1 } }]);
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

    assert.equal('commitMigration' in caller, false);

    await caller.bootstrap({ deviceId: DEVICE_ID });
    await caller.listDevices();
    const challenge = await caller.beginDeviceRegistration({ deviceId: DEVICE_ID, keyVersion: 1 });
    await caller.completeDeviceRegistration({ operationId: 'register-device-1', ...challenge, signatureBase64: 'AA==' });
    await caller.getIndex({ pageSize: 1 });
    await caller.getRecords({ opaqueRecordIds: [RECORD_ID] });
    await caller.putRecord({
      operationId: 'put-record-1',
      opaqueRecordId: RECORD_ID,
      baseRevision: 0,
      envelope: envelope(RECORD_ID, 1),
    });
    await caller.mergeBackup({
      operationId: 'merge-backup-1',
      records: [{ opaqueRecordId: RECORD_ID, baseRevision: 0, envelope: envelope(RECORD_ID, 1) }],
    });
    await caller.beginBackupRestore({
      restoreId: 'restore-1', backupFingerprint: 'f'.repeat(43), backupRecordCount: 1, backupTotalCiphertextBytes: 16,
      chunkCount: 1, recordCount: 1,
      chunkRecordCounts: [1], chunkFingerprints: ['c'.repeat(43)], totalCiphertextBytes: 16,
    });
    await caller.getBackupRestoreStatus({ restoreId: 'restore-1' });
    await caller.mergeBackupRestoreChunk({
      restoreId: 'restore-1', operationId: 'restore-1:0', chunkIndex: 0, chunkFingerprint: 'c'.repeat(43),
      records: [{ opaqueRecordId: RECORD_ID, baseRevision: 0, envelope: envelope(RECORD_ID, 1) }],
    });
    await caller.getBackupRestoreIndex({ restoreId: 'restore-1', pageSize: 1 });
    await caller.getBackupRestoreRecords({ restoreId: 'restore-1', opaqueRecordIds: [RECORD_ID] });
    await caller.sealBackupRestore({ restoreId: 'restore-1', operationId: 'restore-1:seal' });
    await caller.confirmBackupRestoreVerified({
      restoreId: 'restore-1', operationId: 'restore-1:confirm', sessionFingerprint: 's'.repeat(43),
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
    await caller.putKeyset({ operationId: 'put-keyset-1', baseWrappingVersion: 0, keyset: keyset(1) });
    await caller.revokeDevice({ operationId: 'revoke-device-1', deviceId: DEVICE_ID });
  });

  test('does not require obsolete device middleware for legacy vault operations', async () => {
    state.account = account();
    const privateProVaultRouter = await router();

    for (const device of [
      null,
      { deviceId: DEVICE_ID, keyVersion: 1, revokedAtMs: 5 },
      { deviceId: DEVICE_ID, keyVersion: 2, revokedAtMs: null },
    ]) {
      state.devices.clear();
      if (device) state.devices.set(DEVICE_ID, device);
      const caller = privateProVaultRouter.createCaller(context(identity()));
      await caller.getIndex({ pageSize: 1 });
    }
  });

  test('requires explicit matching device registration after the initial keyset commit', async () => {
    state.account = account();
    state.calls = [];
    const caller = (await router()).createCaller(context(identity()));

    await caller.putKeyset({ operationId: 'initial-keyset', baseWrappingVersion: 0, keyset: keyset(1) });
    const challenge = await caller.beginDeviceRegistration({ deviceId: DEVICE_ID, keyVersion: 1 });
    await caller.completeDeviceRegistration({ operationId: 'register-device-initial', ...challenge, signatureBase64: 'AA==' });

    assert.deepEqual(state.calls, [
      { method: 'putKeyset', uid: UID, input: { operationId: 'initial-keyset', baseWrappingVersion: 0, keyset: keyset(1) } },
      { method: 'beginDeviceRegistration', uid: UID, input: { deviceId: DEVICE_ID, keyVersion: 1 } },
      { method: 'completeDeviceRegistration', uid: UID, input: { operationId: 'register-device-initial', formatVersion: 1, deviceId: DEVICE_ID, keyVersion: 1, challengeId: CHALLENGE_ID, challengeBase64: CHALLENGE_BASE64, expiresAtMs: 301_000, signatureBase64: 'AA==' } },
    ]);
  });

  test('returns only the generic vault error when a wrapping rotation violates server invariants', async () => {
    state.account = account();
    state.devices.set(DEVICE_ID, { deviceId: DEVICE_ID, keyVersion: 1, revokedAtMs: null });
    state.putKeysetError = new Error('Vault enrollment authority cannot change during password wrapping rotation.');
    const caller = (await router()).createCaller(context(identity()));

    try {
      await assert.rejects(caller.putKeyset({ operationId: 'malicious-rotation', baseWrappingVersion: 1, keyset: { ...keyset(1), wrappingVersion: 2 } }), error => {
        assert.equal((error as { code?: string }).code, 'INTERNAL_SERVER_ERROR');
        assert.equal((error as Error).message, 'Encrypted vault operation failed.');
        assert.doesNotMatch((error as Error).message, /enrollment authority/i);
        return true;
      });
    } finally {
      state.putKeysetError = null;
    }
  });

  test('validates registration by its explicit input after device headers are removed', async () => {
    state.account = account();
    const caller = (await router()).createCaller(context(identity()));

    await caller.beginDeviceRegistration({ deviceId: RECORD_ID, keyVersion: 1 });
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

  test('rejects malformed restore manifests at the router boundary', async () => {
    state.account = account();
    state.devices.set(DEVICE_ID, { deviceId: DEVICE_ID, keyVersion: 1, revokedAtMs: null });
    const caller = (await router()).createCaller(context(identity()));
    const base = {
      restoreId: 'restore-router-bounds', backupFingerprint: 'f'.repeat(43), backupRecordCount: 1, backupTotalCiphertextBytes: 16,
      chunkCount: 1, recordCount: 1,
      chunkRecordCounts: [1], chunkFingerprints: ['c'.repeat(43)], totalCiphertextBytes: 16,
    };

    await assert.rejects(caller.beginBackupRestore({ ...base, chunkCount: 501 }));
    await assert.rejects(caller.beginBackupRestore({ ...base, recordCount: 100_001 }));
    await assert.rejects(caller.beginBackupRestore({ ...base, totalCiphertextBytes: 128 * 1024 * 1024 + 1 }));
    await assert.rejects(caller.beginBackupRestore({ ...base, chunkRecordCounts: [201] }));
    await assert.rejects(caller.beginBackupRestore({ ...base, chunkFingerprints: ['short'] }));
    await assert.rejects(caller.mergeBackupRestoreChunk({
      restoreId: base.restoreId, operationId: `${base.restoreId}:0`, chunkIndex: 500,
      chunkFingerprint: 'c'.repeat(43), records: [{ opaqueRecordId: RECORD_ID, baseRevision: 0, envelope: envelope(RECORD_ID, 1) }],
    }));
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
    wrappingVersion: 1,
    enrollmentAuthority: {
      algorithm: 'ECDSA-P256-SHA256' as const,
      keyVersion,
      publicJwk: {
        kty: 'EC' as const, crv: 'P-256' as const,
        x: 'DQ9dV0Ox8qzTjqhmlAAmBQJuobtsfi7yGJmudlgj88o',
        y: 'tFuyoZPxIC7Zy05p9pXoCDacjIlJlBNblHjZrDksE1c',
      },
      passwordEnvelope: { nonceBase64: NONCE_BASE64, ciphertextBase64: CIPHERTEXT_BASE64, ciphertextBytes: 16 },
      recoveryEnvelope: { nonceBase64: NONCE_BASE64, ciphertextBase64: CIPHERTEXT_BASE64, ciphertextBytes: 16 },
    },
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
