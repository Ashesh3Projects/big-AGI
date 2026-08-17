import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  PRIVATE_PRO_VAULT_FIRESTORE_MAX_CIPHERTEXT_BYTES,
  comparePrivateProVaultOpaqueIds,
  mergePrivateProVaultIndexEntries,
  type PrivateProVaultMigrationState,
  type PrivateProVaultOperationReceipt,
  type PrivateProVaultRepository,
  type PrivateProVaultRepositoryTransaction,
  type PrivateProVaultStoredKeyset,
  type PrivateProVaultStoredDevice,
  type PrivateProVaultStoredRecord,
  type PrivateProVaultStoredTombstone,
} from './privatePro.vault.repository';
import { createPrivateProVaultService } from './privatePro.vault.service';
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
  migrations: Map<string, PrivateProVaultMigrationState>;
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
        migrations: new Map(),
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
      getMigration: async migrationId => clone(vault.migrations.get(migrationId) ?? null),
      setMigration: async migration => { vault.migrations.set(migration.migrationId, clone(migration)); },
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
  const service = createPrivateProVaultService(repository, () => now++);
  return { repository, service };
}


describe('Private Pro encrypted vault service', () => {
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

  test('bootstraps only opaque remembered-device metadata and preserves revocation', async () => {
    const { service } = serviceFixture();
    const deviceId = 'ddddddddddddddddddddddddddddddddddddddddddd';
    await service.putKeyset(UID_A, { operationId: 'keyset-1', baseWrappingVersion: 0, keyset: keyset(1) });

    assert.deepEqual(await service.bootstrap(UID_A, deviceId), {
      keyset: { keyset: keyset(1), serverUpdatedAtMs: 1_000 },
      device: {
        formatVersion: 1,
        deviceId,
        keyVersion: 1,
        createdAtMs: 1_001,
        lastSeenAtMs: 1_001,
        revokedAtMs: null,
      },
    });
    assert.deepEqual(await service.revokeDevice(UID_A, { operationId: 'revoke-device-1', deviceId }), {
      status: 'committed',
      revokedAtMs: 1_002,
    });
    await assert.rejects(service.bootstrap(UID_A, deviceId), /revoked/i);
    assert.deepEqual(await service.listDevices(UID_A), [{
      formatVersion: 1,
      deviceId,
      keyVersion: 1,
      createdAtMs: 1_001,
      lastSeenAtMs: 1_001,
      revokedAtMs: 1_002,
    }]);
  });

  test('makes device revocation idempotent without accepting device key material', async () => {
    const { repository, service } = serviceFixture();
    const deviceId = 'ddddddddddddddddddddddddddddddddddddddddddd';
    await service.putKeyset(UID_A, { operationId: 'keyset-1', baseWrappingVersion: 0, keyset: keyset(1) });
    await service.bootstrap(UID_A, deviceId);
    const input = { operationId: 'revoke-device-1', deviceId };

    assert.deepEqual(await service.revokeDevice(UID_A, input), { status: 'committed', revokedAtMs: 1_002 });
    assert.deepEqual(await service.revokeDevice(UID_A, input), { status: 'unchanged', revokedAtMs: 1_002 });
    const stored = await repository.transaction(UID_A, transaction => transaction.getDevice(deviceId));
    assert.ok(stored);
    assert.deepEqual(Object.keys(stored).sort(), ['createdAtMs', 'deviceId', 'formatVersion', 'keyVersion', 'lastSeenAtMs', 'revokedAtMs']);
  });

  test('compare-and-swaps migration phases and makes retries idempotent', async () => {
    const { service } = serviceFixture();
    const start = {
      operationId: 'migration-start',
      migrationId: 'legacy-v1',
      basePhase: null,
      phase: 'encrypting',
    };
    assert.deepEqual(await service.commitMigration(UID_A, start), {
      status: 'committed',
      phase: 'encrypting',
      serverUpdatedAtMs: 1_000,
    });
    assert.deepEqual(await service.commitMigration(UID_A, start), {
      status: 'unchanged',
      phase: 'encrypting',
      serverUpdatedAtMs: 1_000,
    });
    assert.deepEqual(await service.commitMigration(UID_A, {
      operationId: 'migration-stale',
      migrationId: 'legacy-v1',
      basePhase: null,
      phase: 'committed',
    }), { status: 'conflict', currentPhase: 'encrypting' });
    assert.deepEqual(await service.commitMigration(UID_A, {
      operationId: 'migration-finish',
      migrationId: 'legacy-v1',
      basePhase: 'encrypting',
      phase: 'committed',
    }), { status: 'committed', phase: 'committed', serverUpdatedAtMs: 1_001 });
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

  test('scopes records, operations, keysets, and migrations by authenticated UID', async () => {
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
    await service.commitMigration(UID_A, {
      operationId: 'same-migration-op', migrationId: 'legacy-v1', basePhase: null, phase: 'encrypting',
    });

    assert.equal((await service.getIndex(UID_A, { pageSize: 10 })).entries.length, 1);
    assert.equal((await service.getIndex(UID_B, { pageSize: 10 })).entries.length, 1);
    assert.equal(await service.getKeyset(UID_B), null);
    assert.equal(await service.getMigration(UID_B, 'legacy-v1'), null);
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
