import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import Dexie from 'dexie';

import { createPrivateProVaultBackupSource, importPrivateProVaultBackup } from './privatePro.vault.backup';
import { deriveVaultSubkey, encryptVaultRecord, importVaultMasterKey } from './privatePro.vault.crypto';
import { PrivateProVaultDB } from './privatePro.vault.db';
import type { PrivateProPortableMutation, PrivateProVaultSerializer } from './privatePro.vault.serializers';
import type { PrivateProEncryptedBackupAsset } from '~/modules/trade/privateProEncryptedBackup';
import { createPrivateProEncryptedBackupStream } from '~/modules/trade/privateProEncryptedBackup';
import { createPrivateProVaultKeyset } from './privatePro.vault.keyset';
import type { PrivateProVaultEnvelope } from './privatePro.vault.types';
import { realArgon2idWorkerResponse, withVaultPasswordWorker } from '../../../../tools/private-pro/test-helpers/privatePro.vault.password.test-helpers';


const UID = 'uid-vault-backup';
const RECORD_ID = 'r'.repeat(43);
const PASSWORD = 'correct horse battery staple';

interface ChatValue { id: string; assetIds: string[]; fail?: boolean }

class TestSerializer implements PrivateProVaultSerializer<ChatValue> {
  readonly recordType = 'chat' as const;
  readonly schemaVersion = 1;
  readonly conflictPolicy = 'replace' as const;
  readonly values = new Map<string, ChatValue>();
  private readonly listeners = new Set<(mutation: PrivateProPortableMutation) => void>();

  async snapshot() { return [...this.values].map(([recordId, value]) => ({ recordId, value: structuredClone(value) })); }
  async normalize(input: unknown) {
    const value = input as ChatValue;
    if (value.id !== 'chat' || !Array.isArray(value.assetIds)) throw new Error('invalid chat');
    return structuredClone(value);
  }
  async recordIdFor() { return RECORD_ID; }
  async validate(recordId: string, input: unknown) {
    if (recordId !== RECORD_ID) throw new Error('invalid chat');
    return this.normalize(input);
  }
  async apply(recordId: string, value: ChatValue) {
    if (value.fail) throw new Error('record apply failed');
    this.values.set(recordId, await this.validate(recordId, value));
  }
  async remove(recordId: string) { this.values.delete(recordId); }
  subscribe(listener: (mutation: PrivateProPortableMutation) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}

function createDB(t: TestContext) {
  const name = `private-pro-vault-backup-${crypto.randomUUID()}`;
  const db = new PrivateProVaultDB(name);
  t.after(async () => { db.close(); await Dexie.delete(name); });
  return db;
}

async function envelope(masterKey: CryptoKey, value: ChatValue) {
  const key = await deriveVaultSubkey(masterKey, 'record-encryption', `chat:${RECORD_ID}`, ['encrypt']);
  return encryptVaultRecord(key, {
    vaultId: UID,
    formatVersion: 1,
    recordType: 'chat',
    recordId: RECORD_ID,
    schemaVersion: 1,
    keyVersion: 1,
    revision: 1,
  }, new TextEncoder().encode(JSON.stringify(value)));
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const response = new Response(stream);
  return new Uint8Array(await response.arrayBuffer());
}

function stream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

describe('private Pro vault backup orchestration', () => {
  test('derives export assets from the frozen encrypted records, not a pending live edit or delete', async (t) => {
    const created = await withVaultPasswordWorker(realArgon2idWorkerResponse, () => createPrivateProVaultKeyset(PASSWORD, UID));
    const db = createDB(t);
    const serializer = new TestSerializer();
    await db.putEncryptedRecord(UID, await envelope(created.masterKey, { id: 'chat', assetIds: ['asset-frozen'] }));
    serializer.values.set(RECORD_ID, { id: 'chat', assetIds: ['asset-live-edit'] });
    let prepared: readonly string[] = [];
    let exported: readonly string[] = [];
    const assets = {
      async prepareForUpload(ids: readonly string[]) { prepared = [...ids]; },
      async *exportAssetChunks(ids: readonly string[]) { exported = [...ids]; },
    } as never;

    const source = await createPrivateProVaultBackupSource({
      uid: UID,
      masterKey: created.masterKey,
      keyset: created.keyset,
      db,
      serializers: [serializer],
      assets,
      collectAssetIds: (_type, value) => (value as ChatValue).assetIds,
    });
    serializer.values.delete(RECORD_ID);
    for await (const _asset of source.assets!()) { /* exhaust */ }

    assert.deepEqual(prepared, ['asset-frozen']);
    assert.deepEqual(exported, ['asset-frozen']);
  });

  test('imports assets before records and rolls back materialized plaintext and records when apply fails', async (t) => {
    const created = await withVaultPasswordWorker(realArgon2idWorkerResponse, () => createPrivateProVaultKeyset(PASSWORD, UID));
    const sourceDB = createDB(t);
    const targetDB = createDB(t);
    const sourceSerializer = new TestSerializer();
    const targetSerializer = new TestSerializer();
    const importedEnvelope = await envelope(created.masterKey, { id: 'chat', assetIds: ['asset-imported'], fail: true });
    await sourceDB.putEncryptedRecord(UID, importedEnvelope);
    const assetChunk = {
      kind: 'asset', formatVersion: 1, assetId: 'opaque-asset', chunkId: 'chunk-0', chunkIndex: 0,
      keyVersion: 1, nonceBase64: 'AAAAAAAAAAAAAAAA', ciphertextBase64: 'AAAAAAAAAAAAAAAAAAAAAA==', ciphertextBytes: 16,
    } satisfies PrivateProEncryptedBackupAsset;
    const source = {
      vaultId: UID,
      keyset: created.keyset,
      masterKey: created.masterKey,
      records: async function* () { yield importedEnvelope; },
      assets: async function* () { yield assetChunk; },
    };
    const bytes = await collect(createPrivateProEncryptedBackupStream(source));
    const order: string[] = [];
    const assets = {
      async importAssetChunks() { order.push('assets'); return ['asset-imported']; },
      async rollbackImportedAssets(ids: readonly string[]) { order.push(`rollback:${ids.join(',')}`); },
    } as never;

    await assert.rejects(withVaultPasswordWorker(realArgon2idWorkerResponse, () => importPrivateProVaultBackup(
      stream(bytes),
      { kind: 'password', password: PASSWORD },
      { uid: UID, db: targetDB, serializers: [targetSerializer], createAssetClient: () => assets },
    )), /record apply failed/i);

    assert.deepEqual(order, ['assets', 'rollback:asset-imported']);
    assert.equal(targetSerializer.values.size, 0);
    assert.equal(await targetDB.records.where('uid').equals(UID).count(), 0);
  });

  test('merges backup records into cloud under the active vault key before runtime hydration', async (t) => {
    const backup = await withVaultPasswordWorker(realArgon2idWorkerResponse, () => createPrivateProVaultKeyset(PASSWORD, UID));
    const activeMasterKey = await importVaultMasterKey(Uint8Array.from({ length: 32 }, (_, index) => 0xa0 + index));
    const sourceDB = createDB(t);
    const targetDB = createDB(t);
    const serializer = new TestSerializer();
    const importedValue = {
      id: 'chat',
      assetIds: ['asset-imported'],
      messages: [{ fragments: [{ part: { dataRef: { reftype: 'dblob', dblobAssetId: 'asset-imported' } } }] }],
    } as unknown as ChatValue;
    const importedEnvelope = await envelope(backup.masterKey, importedValue);
    await sourceDB.putEncryptedRecord(UID, importedEnvelope);
    const bytes = await collect(createPrivateProEncryptedBackupStream({
      vaultId: UID,
      keyset: backup.keyset,
      masterKey: backup.masterKey,
      records: async function* () { yield importedEnvelope; },
      assets: async function* () { /* no chunks needed for the ordering port */ },
    }));
    const remote = new Map<string, PrivateProVaultEnvelope>();
    const existingId = 'e'.repeat(43);
    remote.set(existingId, { ...importedEnvelope, recordId: existingId });
    const order: string[] = [];
    const backupAssets = {
      async importAssetChunks() { order.push('backup-assets'); return ['asset-imported']; },
      async rollbackImportedAssets() { order.push('rollback-assets'); },
    } as never;
    const activeAssets = { async prepareForUpload(ids: readonly string[]) { order.push(`active-assets:${ids.join(',')}`); } } as never;
    const transport = {
      isOnline: () => true,
      subscribeConnectivity: () => () => undefined,
      async getIndex() { return [...remote.values()].map(value => ({ kind: 'record' as const, recordType: value.recordType, opaqueRecordId: value.recordId, revision: value.revision, keyVersion: value.keyVersion, ciphertextBytes: value.ciphertextBytes, serverUpdatedAtMs: 1 })); },
      async getRecords(ids: readonly string[]) { return ids.flatMap(id => remote.has(id) ? [structuredClone(remote.get(id)!)] : []); },
      async mergeBackup(operation: any) {
        order.push('merge-backup');
        for (const record of operation.records) remote.set(record.envelope.recordId, structuredClone(record.envelope));
        return {
          status: 'committed' as const,
          records: operation.records.map((record: any) => ({ opaqueRecordId: record.opaqueRecordId, revision: record.envelope.revision, serverUpdatedAtMs: 2 })),
        };
      },
      async write() { throw new Error('sequential backup writes are forbidden'); },
    };

    await withVaultPasswordWorker(realArgon2idWorkerResponse, () => importPrivateProVaultBackup(
      stream(bytes),
      { kind: 'password', password: PASSWORD },
      {
        uid: UID, db: targetDB, serializers: [serializer],
        activeMasterKey, activeKeyVersion: 7, activeAssets, transport,
        createBackupAssetClient: () => backupAssets,
        createOperationId: () => 'restore-operation-1',
      },
    ));

    assert.deepEqual(order, ['backup-assets', 'active-assets:asset-imported', 'merge-backup']);
    assert.equal(remote.has(existingId), true, 'merge must not delete an existing cloud record');
    const restored = remote.get(RECORD_ID)!;
    assert.equal(restored.keyVersion, 7);
    const activeKey = await deriveVaultSubkey(activeMasterKey, 'record-encryption', `chat:${RECORD_ID}`, ['decrypt']);
    const { decryptVaultRecord } = await import('./privatePro.vault.crypto');
    const plaintext = await decryptVaultRecord(activeKey, restored, { vaultId: UID });
    assert.deepEqual(JSON.parse(new TextDecoder().decode(plaintext)), importedValue);
    assert.equal(serializer.values.size, 0, 'cloud merge must not report a local-only runtime apply');
    assert.equal(await targetDB.records.where('uid').equals(UID).count(), 0, 'engine hydration owns the atomic cache apply');
  });

  test('detects exact post-commit value mismatch instead of accepting valid shape', async (t) => {
    const backup = await withVaultPasswordWorker(realArgon2idWorkerResponse, () => createPrivateProVaultKeyset(PASSWORD, UID));
    const activeMasterKey = await importVaultMasterKey(Uint8Array.from({ length: 32 }, (_, index) => 0xb0 + index));
    const targetDB = createDB(t);
    const serializer = new TestSerializer();
    const importedEnvelope = await envelope(backup.masterKey, { id: 'chat', assetIds: [] });
    const bytes = await collect(createPrivateProEncryptedBackupStream({
      vaultId: UID, keyset: backup.keyset, masterKey: backup.masterKey,
      records: async function* () { yield importedEnvelope; },
    }));
    let committed: PrivateProVaultEnvelope | null = null;
    const transport = {
      isOnline: () => true,
      subscribeConnectivity: () => () => undefined,
      async getIndex() { return committed ? [{ kind: 'record' as const, recordType: committed.recordType, opaqueRecordId: committed.recordId, revision: committed.revision, keyVersion: committed.keyVersion, ciphertextBytes: committed.ciphertextBytes, serverUpdatedAtMs: 2 }] : []; },
      async getRecords() {
        if (!committed) return [];
        const key = await deriveVaultSubkey(activeMasterKey, 'record-encryption', `chat:${RECORD_ID}`, ['encrypt']);
        return [await encryptVaultRecord(key, {
          vaultId: UID,
          formatVersion: committed.formatVersion,
          recordType: committed.recordType,
          recordId: committed.recordId,
          schemaVersion: committed.schemaVersion,
          keyVersion: committed.keyVersion,
          revision: committed.revision,
        }, new TextEncoder().encode(JSON.stringify({ id: 'chat', assetIds: ['different'] })))];
      },
      async mergeBackup(operation: any) {
        const next = structuredClone(operation.records[0].envelope) as PrivateProVaultEnvelope;
        committed = next;
        return { status: 'committed' as const, records: [{ opaqueRecordId: RECORD_ID, revision: next.revision, serverUpdatedAtMs: 2 }] };
      },
      async write() { throw new Error('sequential backup writes are forbidden'); },
    };
    const assets = {
      async importAssetChunks() { return []; },
      async rollbackImportedAssets() {},
    } as never;

    await assert.rejects(withVaultPasswordWorker(realArgon2idWorkerResponse, () => importPrivateProVaultBackup(
      stream(bytes), { kind: 'password', password: PASSWORD }, {
        uid: UID, db: targetDB, serializers: [serializer], activeMasterKey, activeKeyVersion: 7,
        activeAssets: { async prepareForUpload() {} } as never,
        transport, createBackupAssetClient: () => assets, createOperationId: () => 'restore-exact-mismatch',
      },
    )), /verification mismatch/i);
  });

  test('replays one atomic operation after an ambiguous post-commit response', async (t) => {
    const backup = await withVaultPasswordWorker(realArgon2idWorkerResponse, () => createPrivateProVaultKeyset(PASSWORD, UID));
    const activeMasterKey = await importVaultMasterKey(Uint8Array.from({ length: 32 }, (_, index) => 0xc0 + index));
    const targetDB = createDB(t);
    const serializer = new TestSerializer();
    const importedValue = { id: 'chat', assetIds: [] };
    const importedEnvelope = await envelope(backup.masterKey, importedValue);
    const bytes = await collect(createPrivateProEncryptedBackupStream({
      vaultId: UID, keyset: backup.keyset, masterKey: backup.masterKey,
      records: async function* () { yield importedEnvelope; },
    }));
    const remote = new Map<string, PrivateProVaultEnvelope>();
    const operationIds: string[] = [];
    let first = true;
    const transport = {
      isOnline: () => true,
      subscribeConnectivity: () => () => undefined,
      async getIndex() { return [...remote.values()].map(value => ({ kind: 'record' as const, recordType: value.recordType, opaqueRecordId: value.recordId, revision: value.revision, keyVersion: value.keyVersion, ciphertextBytes: value.ciphertextBytes, serverUpdatedAtMs: 2 })); },
      async getRecords(ids: readonly string[]) { return ids.flatMap(id => remote.has(id) ? [structuredClone(remote.get(id)!)] : []); },
      async mergeBackup(operation: any) {
        operationIds.push(operation.operationId);
        if (first) {
          first = false;
          remote.set(RECORD_ID, structuredClone(operation.records[0].envelope));
          throw new TypeError('response lost after commit');
        }
        return { status: 'unchanged' as const, records: [{ opaqueRecordId: RECORD_ID, revision: operation.records[0].envelope.revision, serverUpdatedAtMs: 2 }] };
      },
      async write() { throw new Error('sequential backup writes are forbidden'); },
    };
    const assets = { async importAssetChunks() { return []; }, async rollbackImportedAssets() {} } as never;

    await withVaultPasswordWorker(realArgon2idWorkerResponse, () => importPrivateProVaultBackup(
      stream(bytes), { kind: 'password', password: PASSWORD }, {
        uid: UID, db: targetDB, serializers: [serializer], activeMasterKey, activeKeyVersion: 7,
        activeAssets: { async prepareForUpload() {} } as never,
        transport, createBackupAssetClient: () => assets, createOperationId: () => 'restore-ambiguous',
      },
    ));

    assert.deepEqual(operationIds, ['restore-ambiguous', 'restore-ambiguous']);
  });
});
