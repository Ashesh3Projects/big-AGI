import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  PRIVATE_PRO_VAULT_FIRESTORE_MAX_CIPHERTEXT_BYTES,
  comparePrivateProVaultOpaqueIds,
  mergePrivateProVaultIndexEntries,
  type PrivateProVaultOperationReceipt,
  type PrivateProVaultRegistrationChallenge,
  type PrivateProVaultRepository,
  type PrivateProVaultRepositoryTransaction,
  type PrivateProVaultStoredKeyset,
  type PrivateProVaultStoredDevice,
  type PrivateProVaultStoredRecord,
  type PrivateProVaultStoredTombstone,
} from './privatePro.vault.repository';
import { createPrivateProVaultService, type PrivateProVaultService } from './privatePro.vault.service';
import { createPrivateProVaultEnrollmentAuthority, signPrivateProVaultDeviceRegistration } from './privatePro.vault.registration';
import type {
  PrivateProVaultEnvelope,
  PrivateProVaultKeyset,
  PrivateProVaultRecordType,
  PrivateProVaultTombstone,
} from './privatePro.vault.types';


const UID_A = 'uid-a';
const UID_B = 'uid-b';
const RECORD_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RECORD_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NONCE_BASE64 = 'AAAAAAAAAAAAAAAA';
const CIPHERTEXT_BASE64 = 'AAAAAAAAAAAAAAAAAAAAAA==';

type AssertFalse<T extends false> = T;
type _CommitMigrationIsNotAServiceMethod = AssertFalse<'commitMigration' extends keyof PrivateProVaultService ? true : false>;
type _GetMigrationIsNotAServiceMethod = AssertFalse<'getMigration' extends keyof PrivateProVaultService ? true : false>;


function clone<T>(value: T): T {
  return structuredClone(value);
}

function envelope(
  recordId: string,
  revision: number,
  recordType: PrivateProVaultRecordType = 'settings',
  ciphertextBytes = 16,
): PrivateProVaultEnvelope {
  const ciphertextBase64 = ciphertextBytes === 16
    ? CIPHERTEXT_BASE64
    : Buffer.alloc(ciphertextBytes).toString('base64');
  return {
    formatVersion: 1,
    recordType,
    recordId,
    schemaVersion: 1,
    keyVersion: 1,
    revision,
    nonceBase64: NONCE_BASE64,
    ciphertextBase64,
    ciphertextBytes,
  };
}

function keyset(keyVersion: number, wrappingVersion = keyVersion): PrivateProVaultKeyset {
  return {
    formatVersion: 1,
    keyVersion,
    wrappingVersion,
    enrollmentAuthority: {
      algorithm: 'ECDSA-P256-SHA256',
      keyVersion,
      publicJwk: {
        kty: 'EC', crv: 'P-256',
        x: 'DQ9dV0Ox8qzTjqhmlAAmBQJuobtsfi7yGJmudlgj88o',
        y: 'tFuyoZPxIC7Zy05p9pXoCDacjIlJlBNblHjZrDksE1c',
      },
      passwordEnvelope: { nonceBase64: NONCE_BASE64, ciphertextBase64: CIPHERTEXT_BASE64, ciphertextBytes: 16 },
      recoveryEnvelope: { nonceBase64: NONCE_BASE64, ciphertextBase64: CIPHERTEXT_BASE64, ciphertextBytes: 16 },
    },
    passwordEnvelope: {
      formatVersion: 1,
      keyVersion,
      kdf: {
        algorithm: 'pbkdf2-sha256',
        saltBase64: 'AAAAAAAAAAAAAAAAAAAAAA==',
        iterations: 600_000,
      },
      nonceBase64: NONCE_BASE64,
      ciphertextBase64: CIPHERTEXT_BASE64,
      ciphertextBytes: 16,
    },
    recoveryEnvelope: {
      formatVersion: 1,
      keyVersion,
      recoveryVersion: keyVersion,
      nonceBase64: NONCE_BASE64,
      ciphertextBase64: CIPHERTEXT_BASE64,
      ciphertextBytes: 16,
    },
  };
}

function tombstone(recordId: string, revision: number, operationId: string): PrivateProVaultTombstone {
  return {
    formatVersion: 1,
    recordType: 'settings',
    recordId,
    revision,
    keyVersion: 1,
    operationId,
    deletedAtMs: 900,
  };
}

interface MemoryVault {
  records: Map<string, PrivateProVaultStoredRecord>;
  tombstones: Map<string, PrivateProVaultStoredTombstone>;
  operations: Map<string, PrivateProVaultOperationReceipt>;
  keyset: PrivateProVaultStoredKeyset | null;
  devices: Map<string, PrivateProVaultStoredDevice>;
  registrationChallenges: Map<string, PrivateProVaultRegistrationChallenge>;
}

class MemoryVaultRepository implements PrivateProVaultRepository {
  private readonly vaults = new Map<string, MemoryVault>();

  private vault(uid: string): MemoryVault {
    let vault = this.vaults.get(uid);
    if (!vault) {
      vault = {
        records: new Map(),
        tombstones: new Map(),
        operations: new Map(),
        keyset: null,
        devices: new Map(),
        registrationChallenges: new Map(),
      };
      this.vaults.set(uid, vault);
    }
    return vault;
  }

  async transaction<T>(uid: string, callback: (transaction: PrivateProVaultRepositoryTransaction) => Promise<T>): Promise<T> {
    const vault = this.vault(uid);
    const transaction: PrivateProVaultRepositoryTransaction = {
      getRecord: async opaqueRecordId => clone(vault.records.get(opaqueRecordId) ?? null),
      setRecord: async record => { vault.records.set(record.opaqueRecordId, clone(record)); },
      deleteRecord: async opaqueRecordId => { vault.records.delete(opaqueRecordId); },
      getTombstone: async opaqueRecordId => clone(vault.tombstones.get(opaqueRecordId) ?? null),
      setTombstone: async value => { vault.tombstones.set(value.opaqueRecordId, clone(value)); },
      deleteTombstone: async opaqueRecordId => { vault.tombstones.delete(opaqueRecordId); },
      getOperation: async operationId => clone(vault.operations.get(operationId) ?? null),
      createOperation: async operation => {
        if (vault.operations.has(operation.operationId)) throw new Error('Operation already exists.');
        vault.operations.set(operation.operationId, clone(operation));
      },
      getKeyset: async () => clone(vault.keyset),
      setKeyset: async value => { vault.keyset = clone(value); },
      getDevice: async deviceId => clone(vault.devices.get(deviceId) ?? null),
      setDevice: async device => { vault.devices.set(device.deviceId, clone(device)); },
      listDevices: async () => clone([...vault.devices.values()]),
      getRegistrationChallenge: async challengeId => clone(vault.registrationChallenges.get(challengeId) ?? null),
      createRegistrationChallenge: async challenge => {
        if (vault.registrationChallenges.has(challenge.challengeId)) throw new Error('Registration challenge already exists.');
        vault.registrationChallenges.set(challenge.challengeId, clone(challenge));
      },
      deleteRegistrationChallenge: async challengeId => { vault.registrationChallenges.delete(challengeId); },
    };
    return callback(transaction);
  }

  async listIndexEntries(uid: string, afterOpaqueRecordId: string | null, limit: number) {
    const vault = this.vault(uid);
    const entries = [
      ...[...vault.records.values()].map(record => ({
        kind: 'record' as const,
        opaqueRecordId: record.opaqueRecordId,
        recordType: record.envelope.recordType,
        revision: record.revision,
        keyVersion: record.envelope.keyVersion,
        ciphertextBytes: record.envelope.ciphertextBytes,
        serverUpdatedAtMs: record.serverUpdatedAtMs,
      })),
      ...[...vault.tombstones.values()].map(value => ({
        kind: 'tombstone' as const,
        opaqueRecordId: value.opaqueRecordId,
        recordType: value.tombstone.recordType,
        revision: value.revision,
        keyVersion: value.tombstone.keyVersion,
        serverUpdatedAtMs: value.serverUpdatedAtMs,
      })),
    ].filter(entry => afterOpaqueRecordId === null || comparePrivateProVaultOpaqueIds(entry.opaqueRecordId, afterOpaqueRecordId) > 0)
      .sort((left, right) => comparePrivateProVaultOpaqueIds(left.opaqueRecordId, right.opaqueRecordId));
    return clone(entries.slice(0, limit));
  }

  async getRecords(uid: string, opaqueRecordIds: readonly string[]) {
    const vault = this.vault(uid);
    return opaqueRecordIds.flatMap(opaqueRecordId => {
      const record = vault.records.get(opaqueRecordId);
      return record ? [clone(record)] : [];
    });
  }
}

function serviceFixture() {
  const repository = new MemoryVaultRepository();
  let now = 1_000;
  let randomFill = 1;
  const service = createPrivateProVaultService(repository, () => now++, byteLength => new Uint8Array(byteLength).fill(randomFill++));
  return { repository, service, setNow: (value: number) => { now = value; } };
}

async function registrationFixture() {
  const passwordWrapping = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(0x11), 'AES-GCM', false, ['wrapKey', 'unwrapKey']);
  const recoveryWrapping = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(0x22), 'AES-GCM', false, ['wrapKey', 'unwrapKey']);
  const enrollment = await createPrivateProVaultEnrollmentAuthority(passwordWrapping, recoveryWrapping, UID_A, 1);
  return {
    keyset: { ...keyset(1), enrollmentAuthority: enrollment.authority },
    privateKey: enrollment.privateKey,
  };
}


describe('Private Pro encrypted vault service', () => {
  test('does not expose legacy migration operations', () => {
    const { service } = serviceFixture();

    assert.equal('commitMigration' in service, false);
    assert.equal('getMigration' in service, false);
  });

  test('commits the first record write with a server revision and timestamp', async () => {
    const { service } = serviceFixture();

    const result = await service.putRecord(UID_A, {
      operationId: 'put-record-a-1',
      opaqueRecordId: RECORD_A,
      baseRevision: 0,
      envelope: envelope(RECORD_A, 1),
    });

    assert.deepEqual(result, { status: 'committed', revision: 1, serverUpdatedAtMs: 1_000 });
    assert.deepEqual(await service.getRecords(UID_A, [RECORD_A]), [{
      opaqueRecordId: RECORD_A,
      revision: 1,
      serverUpdatedAtMs: 1_000,
      envelope: envelope(RECORD_A, 1),
    }]);
  });

  test('returns unchanged for an exact idempotent record retry', async () => {
    const { service } = serviceFixture();
    const input = {
      operationId: 'put-record-a-1',
      opaqueRecordId: RECORD_A,
      baseRevision: 0,
      envelope: envelope(RECORD_A, 1),
    };
    await service.putRecord(UID_A, input);

    assert.deepEqual(await service.putRecord(UID_A, {
      envelope: input.envelope,
      baseRevision: input.baseRevision,
      opaqueRecordId: input.opaqueRecordId,
      operationId: input.operationId,
    }), {
      status: 'unchanged',
      revision: 1,
      serverUpdatedAtMs: 1_000,
    });
  });

  test('rejects an operation ID reused with different content', async () => {
    const { service } = serviceFixture();
    await service.putRecord(UID_A, {
      operationId: 'shared-operation',
      opaqueRecordId: RECORD_A,
      baseRevision: 0,
      envelope: envelope(RECORD_A, 1),
    });

    await assert.rejects(service.putRecord(UID_A, {
      operationId: 'shared-operation',
      opaqueRecordId: RECORD_B,
      baseRevision: 0,
      envelope: envelope(RECORD_B, 1),
    }), /operation ID.*different/i);
  });

  test('returns a conflict for a stale record base revision', async () => {
    const { service } = serviceFixture();
    await service.putRecord(UID_A, {
      operationId: 'put-record-a-1',
      opaqueRecordId: RECORD_A,
      baseRevision: 0,
      envelope: envelope(RECORD_A, 1),
    });

    assert.deepEqual(await service.putRecord(UID_A, {
      operationId: 'put-record-a-stale',
      opaqueRecordId: RECORD_A,
      baseRevision: 0,
      envelope: envelope(RECORD_A, 1),
    }), { status: 'conflict', currentRevision: 1 });
  });

  test('keeps revisions independent between opaque records', async () => {
    const { service } = serviceFixture();
    await service.putRecord(UID_A, {
      operationId: 'put-record-a-1',
      opaqueRecordId: RECORD_A,
      baseRevision: 0,
      envelope: envelope(RECORD_A, 1),
    });
    await service.putRecord(UID_A, {
      operationId: 'put-record-a-2',
      opaqueRecordId: RECORD_A,
      baseRevision: 1,
      envelope: envelope(RECORD_A, 2),
    });

    assert.deepEqual(await service.putRecord(UID_A, {
      operationId: 'put-record-b-1',
      opaqueRecordId: RECORD_B,
      baseRevision: 0,
      envelope: envelope(RECORD_B, 1, 'credential-service'),
    }), { status: 'committed', revision: 1, serverUpdatedAtMs: 1_002 });
  });

  test('commits a tombstone and removes the canonical record', async () => {
    const { service } = serviceFixture();
    await service.putRecord(UID_A, {
      operationId: 'put-record-a-1',
      opaqueRecordId: RECORD_A,
      baseRevision: 0,
      envelope: envelope(RECORD_A, 1),
    });

    assert.deepEqual(await service.deleteRecord(UID_A, {
      operationId: 'delete-record-a-2',
      opaqueRecordId: RECORD_A,
      baseRevision: 1,
      tombstone: tombstone(RECORD_A, 2, 'delete-record-a-2'),
    }), { status: 'committed', revision: 2, serverUpdatedAtMs: 1_001 });
    assert.deepEqual(await service.getRecords(UID_A, [RECORD_A]), []);
    assert.deepEqual((await service.getIndex(UID_A, { pageSize: 10 })).entries, [{
      kind: 'tombstone',
      opaqueRecordId: RECORD_A,
      recordType: 'settings',
      revision: 2,
      keyVersion: 1,
      serverUpdatedAtMs: 1_001,
    }]);
  });

  test('returns a bounded keyset-paged opaque record index', async () => {
    const { service } = serviceFixture();
    for (const [index, recordId] of [RECORD_A, RECORD_B].entries()) {
      await service.putRecord(UID_A, {
        operationId: `put-index-${index}`,
        opaqueRecordId: recordId,
        baseRevision: 0,
        envelope: envelope(recordId, 1),
      });
    }

    const first = await service.getIndex(UID_A, { pageSize: 1 });
    assert.equal(first.entries.length, 1);
    assert.equal(first.entries[0].opaqueRecordId, RECORD_A);
    assert.equal(first.nextCursor, RECORD_A);
    const second = await service.getIndex(UID_A, { pageSize: 1, cursor: first.nextCursor });
    assert.equal(second.entries.length, 1);
    assert.equal(second.entries[0].opaqueRecordId, RECORD_B);
    assert.equal(second.nextCursor, null);
    await assert.rejects(service.getIndex(UID_A, { pageSize: 501 }), /page size/i);
    await assert.rejects(service.getIndex(UID_A, { pageSize: 1, cursor: 'records/not-opaque' }), /cursor/i);
  });

  test('pages mixed-case opaque IDs in Firestore document ID order without skipping', async () => {
    const { service } = serviceFixture();
    const recordIds = [`A${'x'.repeat(42)}`, `Z${'x'.repeat(42)}`, `a${'x'.repeat(42)}`];
    for (const [index, recordId] of recordIds.entries()) {
      await service.putRecord(UID_A, {
        operationId: `put-mixed-case-${index}`,
        opaqueRecordId: recordId,
        baseRevision: 0,
        envelope: envelope(recordId, 1),
      });
    }
    await service.deleteRecord(UID_A, {
      operationId: 'delete-mixed-case-z',
      opaqueRecordId: recordIds[1],
      baseRevision: 1,
      tombstone: tombstone(recordIds[1], 2, 'delete-mixed-case-z'),
    });

    const traversed: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await service.getIndex(UID_A, { pageSize: 1, cursor });
      traversed.push(...page.entries.map(entry => entry.opaqueRecordId));
      cursor = page.nextCursor;
    } while (cursor !== null);

    assert.deepEqual(traversed, recordIds);
  });

  test('merges record and tombstone snapshots with one deterministic bounded ordering', () => {
    const record = {
      opaqueRecordId: `a${'x'.repeat(42)}`,
      revision: 1,
      serverUpdatedAtMs: 1,
      envelope: envelope(`a${'x'.repeat(42)}`, 1),
    };
    const deletedId = `Z${'x'.repeat(42)}`;
    const deleted = {
      opaqueRecordId: deletedId,
      revision: 1,
      serverUpdatedAtMs: 2,
      tombstone: tombstone(deletedId, 1, 'delete-z'),
    };

    assert.deepEqual(mergePrivateProVaultIndexEntries([record], [deleted], 2).map(entry => entry.opaqueRecordId), [
      deletedId,
      record.opaqueRecordId,
    ]);
    assert.deepEqual(mergePrivateProVaultIndexEntries([record], [deleted], 1).map(entry => entry.opaqueRecordId), [deletedId]);
  });

  test('compare-and-swaps wrapping revisions without changing the master key version', async () => {
    const { service } = serviceFixture();
    assert.deepEqual(await service.putKeyset(UID_A, {
      operationId: 'keyset-1',
      baseWrappingVersion: 0,
      keyset: keyset(1, 1),
    }), { status: 'committed', wrappingVersion: 1, serverUpdatedAtMs: 1_000 });
    assert.deepEqual(await service.putKeyset(UID_A, {
      operationId: 'keyset-stale',
      baseWrappingVersion: 0,
      keyset: keyset(1, 1),
    }), { status: 'conflict', currentWrappingVersion: 1 });
    assert.deepEqual(await service.putKeyset(UID_A, {
      operationId: 'keyset-2',
      baseWrappingVersion: 1,
      keyset: keyset(1, 2),
    }), { status: 'committed', wrappingVersion: 2, serverUpdatedAtMs: 1_001 });
    assert.deepEqual(await service.getKeyset(UID_A), {
      keyset: keyset(1, 2),
      serverUpdatedAtMs: 1_001,
    });
  });

  test('rejects wrapping rotations that replace enrollment or recovery authority without changing stored state', async () => {
    const attacks: Array<[string, (current: PrivateProVaultKeyset) => PrivateProVaultKeyset]> = [
      ['master key version', current => ({
        ...current,
        keyVersion: 2,
        enrollmentAuthority: { ...current.enrollmentAuthority, keyVersion: 2 },
        passwordEnvelope: { ...current.passwordEnvelope, keyVersion: 2 },
        recoveryEnvelope: { ...current.recoveryEnvelope, keyVersion: 2 },
      })],
      ['enrollment public key', current => ({
        ...current,
        enrollmentAuthority: {
          ...current.enrollmentAuthority,
          publicJwk: { ...current.enrollmentAuthority.publicJwk, x: 'EQ9dV0Ox8qzTjqhmlAAmBQJuobtsfi7yGJmudlgj88o' },
        },
      })],
      ['recovery enrollment envelope', current => ({
        ...current,
        enrollmentAuthority: {
          ...current.enrollmentAuthority,
          recoveryEnvelope: { ...current.enrollmentAuthority.recoveryEnvelope, nonceBase64: 'AQAAAAAAAAAAAAAA' },
        },
      })],
      ['recovery master envelope', current => ({
        ...current,
        recoveryEnvelope: { ...current.recoveryEnvelope, recoveryVersion: 2, nonceBase64: 'AQAAAAAAAAAAAAAA' },
      })],
    ];

    for (const [name, mutate] of attacks) {
      const { service } = serviceFixture();
      const initial = keyset(1, 1);
      await service.putKeyset(UID_A, { operationId: `initial-${name.replaceAll(' ', '-')}`, baseWrappingVersion: 0, keyset: initial });
      const attack = mutate({ ...clone(initial), wrappingVersion: 2 });

      await assert.rejects(
        service.putKeyset(UID_A, { operationId: `attack-${name.replaceAll(' ', '-')}`, baseWrappingVersion: 1, keyset: attack }),
        /cannot change during (?:password )?wrapping rotation/i,
      );
      assert.deepEqual(await service.getKeyset(UID_A), { keyset: initial, serverUpdatedAtMs: 1_000 });
    }
  });

  test('accepts password and recovery-reset rewraps when recovery authority remains stable', async () => {
    for (const operationId of ['password-rotation', 'recovery-password-reset']) {
      const { service } = serviceFixture();
      const initial = keyset(1, 1);
      await service.putKeyset(UID_A, { operationId: `initial-${operationId}`, baseWrappingVersion: 0, keyset: initial });
      const rotated: PrivateProVaultKeyset = {
        ...clone(initial),
        wrappingVersion: 2,
        passwordEnvelope: {
          ...initial.passwordEnvelope,
          kdf: { ...initial.passwordEnvelope.kdf, saltBase64: 'AQAAAAAAAAAAAAAAAAAAAA==' },
          nonceBase64: 'AQAAAAAAAAAAAAAA',
        },
        enrollmentAuthority: {
          ...initial.enrollmentAuthority,
          passwordEnvelope: { ...initial.enrollmentAuthority.passwordEnvelope, nonceBase64: 'AQAAAAAAAAAAAAAA' },
        },
      };

      assert.deepEqual(await service.putKeyset(UID_A, {
        operationId,
        baseWrappingVersion: 1,
        keyset: rotated,
      }), { status: 'committed', wrappingVersion: 2, serverUpdatedAtMs: 1_001 });
      assert.deepEqual((await service.getKeyset(UID_A))?.keyset, rotated);
    }
  });

  test('does not register an unknown device during bootstrap and preserves known revocation', async () => {
    const { service } = serviceFixture();
    const deviceId = 'ddddddddddddddddddddddddddddddddddddddddddd';
    const registration = await registrationFixture();
    await service.putKeyset(UID_A, { operationId: 'keyset-1', baseWrappingVersion: 0, keyset: registration.keyset });

    assert.deepEqual(await service.bootstrap(UID_A, deviceId), {
      keyset: { keyset: registration.keyset, serverUpdatedAtMs: 1_000 },
      device: null,
    });
    const challenge = await service.beginDeviceRegistration(UID_A, { deviceId, keyVersion: 1 });
    const input = {
      operationId: 'register-device-1',
      ...challenge,
      signatureBase64: await signPrivateProVaultDeviceRegistration(registration.privateKey, { uid: UID_A, ...challenge }),
    };
    assert.deepEqual(await service.completeDeviceRegistration(UID_A, input), {
      status: 'registered',
      device: {
        formatVersion: 1,
        deviceId,
        keyVersion: 1,
        createdAtMs: 1_003,
        lastSeenAtMs: 1_003,
        revokedAtMs: null,
      },
    });
    assert.deepEqual(await service.revokeDevice(UID_A, { operationId: 'revoke-device-1', deviceId }), {
      status: 'committed',
      revokedAtMs: 1_004,
    });
    await assert.rejects(service.beginDeviceRegistration(UID_A, { deviceId, keyVersion: 1 }), /revoked/i);
    assert.deepEqual(await service.bootstrap(UID_A, deviceId), {
      keyset: { keyset: registration.keyset, serverUpdatedAtMs: 1_000 },
      device: {
        formatVersion: 1,
        deviceId,
        keyVersion: 1,
        createdAtMs: 1_003,
        lastSeenAtMs: 1_003,
        revokedAtMs: 1_004,
      },
    });
    assert.deepEqual(await service.listDevices(UID_A), [{
      formatVersion: 1,
      deviceId,
      keyVersion: 1,
      createdAtMs: 1_003,
      lastSeenAtMs: 1_003,
      revokedAtMs: 1_004,
    }]);
  });

  test('rejects challenge tampering, expiry, replay, and operation collisions', async () => {
    const { service, setNow } = serviceFixture();
    const deviceId = 'ddddddddddddddddddddddddddddddddddddddddddd';
    const registration = await registrationFixture();
    await service.putKeyset(UID_A, { operationId: 'keyset-proof', baseWrappingVersion: 0, keyset: registration.keyset });
    const challenge = await service.beginDeviceRegistration(UID_A, { deviceId, keyVersion: 1 });
    const valid = {
      operationId: 'register-device-proof',
      ...challenge,
      signatureBase64: await signPrivateProVaultDeviceRegistration(registration.privateKey, { uid: UID_A, ...challenge }),
    };

    for (const tampered of [
      { ...valid, deviceId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
      { ...valid, keyVersion: 2 },
      { ...valid, challengeId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
      { ...valid, challengeBase64: Buffer.alloc(32, 9).toString('base64') },
      { ...valid, expiresAtMs: valid.expiresAtMs + 1 },
      { ...valid, signatureBase64: '' },
    ]) await assert.rejects(service.completeDeviceRegistration(UID_A, tampered), /challenge|proof|version/i);

    const expiredChallenge = await service.beginDeviceRegistration(UID_A, { deviceId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', keyVersion: 1 });
    const expired = {
      operationId: 'register-device-expired',
      ...expiredChallenge,
      signatureBase64: await signPrivateProVaultDeviceRegistration(registration.privateKey, { uid: UID_A, ...expiredChallenge }),
    };
    setNow(expired.expiresAtMs);
    await assert.rejects(service.completeDeviceRegistration(UID_A, expired), /expired/i);
    setNow(2_000);

    assert.equal((await service.completeDeviceRegistration(UID_A, valid)).status, 'registered');
    assert.equal((await service.completeDeviceRegistration(UID_A, valid)).status, 'unchanged');
    await assert.rejects(service.completeDeviceRegistration(UID_A, { ...valid, operationId: 'register-device-replay' }), /challenge/i);
    await assert.rejects(service.completeDeviceRegistration(UID_A, { ...valid, deviceId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }), /operation ID/i);
  });

  test('makes device revocation idempotent without accepting device key material', async () => {
    const { repository, service } = serviceFixture();
    const deviceId = 'ddddddddddddddddddddddddddddddddddddddddddd';
    const registration = await registrationFixture();
    await service.putKeyset(UID_A, { operationId: 'keyset-1', baseWrappingVersion: 0, keyset: registration.keyset });
    const challenge = await service.beginDeviceRegistration(UID_A, { deviceId, keyVersion: 1 });
    await service.completeDeviceRegistration(UID_A, {
      operationId: 'register-device-idempotent',
      ...challenge,
      signatureBase64: await signPrivateProVaultDeviceRegistration(registration.privateKey, { uid: UID_A, ...challenge }),
    });
    const input = { operationId: 'revoke-device-1', deviceId };

    assert.deepEqual(await service.revokeDevice(UID_A, input), { status: 'committed', revokedAtMs: 1_004 });
    assert.deepEqual(await service.revokeDevice(UID_A, input), { status: 'unchanged', revokedAtMs: 1_004 });
    const stored = await repository.transaction(UID_A, transaction => transaction.getDevice(deviceId));
    assert.ok(stored);
    assert.deepEqual(Object.keys(stored).sort(), ['createdAtMs', 'deviceId', 'formatVersion', 'keyVersion', 'lastSeenAtMs', 'revokedAtMs']);
  });

  test('rejects records above the Firestore-safe ciphertext bound', async () => {
    const { service } = serviceFixture();

    await assert.rejects(service.putRecord(UID_A, {
      operationId: 'oversized-record',
      opaqueRecordId: RECORD_A,
      baseRevision: 0,
      envelope: envelope(RECORD_A, 1, 'settings', PRIVATE_PRO_VAULT_FIRESTORE_MAX_CIPHERTEXT_BYTES + 1),
    }), /ciphertext.*700 KiB/i);
  });

  test('scopes records, operations, and keysets by authenticated UID', async () => {
    const { service } = serviceFixture();
    const input = {
      operationId: 'same-operation-id',
      opaqueRecordId: RECORD_A,
      baseRevision: 0,
      envelope: envelope(RECORD_A, 1),
    };
    await service.putRecord(UID_A, input);
    await service.putRecord(UID_B, input);
    await service.putKeyset(UID_A, { operationId: 'same-keyset-op', baseWrappingVersion: 0, keyset: keyset(1) });

    assert.equal((await service.getIndex(UID_A, { pageSize: 10 })).entries.length, 1);
    assert.equal((await service.getIndex(UID_B, { pageSize: 10 })).entries.length, 1);
    assert.equal(await service.getKeyset(UID_B), null);
  });

  test('rejects visible record metadata that disagrees with the route', async () => {
    const { service } = serviceFixture();

    await assert.rejects(service.putRecord(UID_A, {
      operationId: 'mismatched-record',
      opaqueRecordId: RECORD_A,
      baseRevision: 0,
      envelope: envelope(RECORD_B, 1),
    }), /record ID.*route/i);
    await assert.rejects(service.putRecord(UID_A, {
      operationId: 'mismatched-revision',
      opaqueRecordId: RECORD_A,
      baseRevision: 0,
      envelope: envelope(RECORD_A, 2),
    }), /revision.*base revision/i);
  });
});
