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
  async validate(recordId: string, input: unknown) {
    const value = input as ChatValue;
    if (recordId !== RECORD_ID || value.id !== 'chat' || !Array.isArray(value.assetIds)) throw new Error('invalid chat');
    return structuredClone(value);
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
});
