import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import Dexie from 'dexie';

import { deriveVaultSubkey, generateVaultMasterKeyBytes, importVaultMasterKey } from './privatePro.vault.crypto';
import { PrivateProVaultDB } from './privatePro.vault.db';
import {
  createPrivateProVaultEngine,
  type PrivateProVaultEngine,
} from './privatePro.vault.engine';
import type {
  PrivateProVaultConflictPolicy,
  PrivateProVaultSerializer,
  PrivateProPortableMutation,
} from './privatePro.vault.serializers';
import { createPrivateProVaultStore } from './store-private-pro-vault';
import type {
  PrivateProVaultIndexEntry,
  PrivateProVaultTransport,
  PrivateProVaultWriteResult,
} from './privatePro.vault.transport';
import type {
  PrivateProVaultEnvelope,
  PrivateProVaultOperation,
  PrivateProVaultRecordType,
} from './privatePro.vault.types';


const UID = 'uid-vault-engine';
const VAULT_CONTEXT = { vaultId: 'vault-engine-test' } as const;
const CREDENTIAL_ID = 'ccccccccccccccccccccccccccccccccccccccccccc';
const THEME_ID = 'ttttttttttttttttttttttttttttttttttttttt';
const CHAT_ID = 'hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh';

interface TestValue {
  id: string;
  value: string;
}

class TestSerializer implements PrivateProVaultSerializer<TestValue> {
  readonly schemaVersion = 1;
  readonly values = new Map<string, TestValue>();
  readonly conflictCopies: TestValue[] = [];
  private readonly listeners = new Set<(mutation: PrivateProPortableMutation) => void>();

  constructor(
    readonly recordType: PrivateProVaultRecordType,
    readonly conflictPolicy: PrivateProVaultConflictPolicy,
    private readonly recordIds: Map<string, string>,
    private readonly rejectValue?: string,
    private readonly rejectApplyValue?: string,
  ) {}

  async snapshot() {
    return [...this.values].map(([recordId, value]) => ({ recordId, value: structuredClone(value) }));
  }

  async normalize(input: unknown) {
    return structuredClone(input as TestValue);
  }

  async recordIdFor(value: TestValue) {
    return value.id;
  }

  async validate(recordId: string, input: unknown) {
    if (!input || typeof input !== 'object') throw new Error('Test value is invalid.');
    const value = input as TestValue;
    if (typeof value.id !== 'string' || typeof value.value !== 'string') throw new Error('Test value is invalid.');
    if (this.recordIds.get(value.id) !== recordId) throw new Error('Test record ID is invalid.');
    if (value.value === this.rejectValue) throw new Error('Test staged value is rejected.');
    return structuredClone(value);
  }

  async apply(recordId: string, input: TestValue) {
    const value = await this.validate(recordId, input);
    if (value.value === this.rejectApplyValue) throw new Error('Test staged apply failed.');
    this.values.set(recordId, value);
    this.emit({ kind: 'put', recordType: this.recordType, recordId, schemaVersion: this.schemaVersion, value });
  }

  async remove(recordId: string) {
    if (!this.values.delete(recordId)) return;
    this.emit({ kind: 'delete', recordType: this.recordType, recordId, schemaVersion: this.schemaVersion });
  }

  async createConflictCopy(value: TestValue) {
    const copy = { ...structuredClone(value), id: `${value.id}-conflict-${this.conflictCopies.length + 1}` };
    this.conflictCopies.push(copy);
    const recordId = this.recordIds.get(copy.id) ?? `${this.conflictCopies.length}`.repeat(43).slice(0, 43);
    this.recordIds.set(copy.id, recordId);
    return { recordId, value: copy };
  }

  subscribe(listener: (mutation: PrivateProPortableMutation) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async mutate(recordId: string, value: TestValue) {
    await this.apply(recordId, value);
  }

  private emit(mutation: PrivateProPortableMutation) {
    for (const listener of this.listeners) listener(structuredClone(mutation));
  }
}

class TestVaultServer {
  readonly records = new Map<string, { envelope: PrivateProVaultEnvelope; serverUpdatedAtMs: number }>();
  readonly operations: PrivateProVaultOperation[] = [];
  readonly fetches: string[][] = [];
  failAfterCommitOnce = false;
  delayRecordFetch: Promise<void> | null = null;
  delayWrite: Promise<void> | null = null;
  private serverSequence = 0;
  private readonly receipts = new Map<string, { operation: PrivateProVaultOperation; result: PrivateProVaultWriteResult }>();

  index(): PrivateProVaultIndexEntry[] {
    return [...this.records.values()].map(record => ({
      kind: 'record' as const,
      opaqueRecordId: record.envelope.recordId,
      recordType: record.envelope.recordType,
      revision: record.envelope.revision,
      keyVersion: record.envelope.keyVersion,
      ciphertextBytes: record.envelope.ciphertextBytes,
      serverUpdatedAtMs: record.serverUpdatedAtMs,
    })).sort((left, right) => left.opaqueRecordId < right.opaqueRecordId ? -1 : left.opaqueRecordId > right.opaqueRecordId ? 1 : 0);
  }

  async getRecords(recordIds: readonly string[]) {
    this.fetches.push([...recordIds]);
    await this.delayRecordFetch;
    return recordIds.flatMap(recordId => {
      const record = this.records.get(recordId);
      return record ? [structuredClone(record.envelope)] : [];
    });
  }

  async write(operation: PrivateProVaultOperation): Promise<PrivateProVaultWriteResult> {
    this.operations.push(structuredClone(operation));
    await this.delayWrite;
    const receipt = this.receipts.get(operation.operationId);
    if (receipt) {
      assert.deepEqual(operation, receipt.operation, 'an operation ID must replay identical encrypted content');
      return receipt.result.status === 'committed'
        ? { status: 'unchanged', revision: receipt.result.revision, serverUpdatedAtMs: receipt.result.serverUpdatedAtMs }
        : structuredClone(receipt.result);
    }

    const recordId = operation.kind === 'put' ? operation.envelope.recordId : operation.tombstone.recordId;
    const currentRevision = this.records.get(recordId)?.envelope.revision ?? 0;
    if (currentRevision !== operation.baseRevision) {
      const result = { status: 'conflict' as const, currentRevision };
      this.receipts.set(operation.operationId, { operation: structuredClone(operation), result });
      return result;
    }

    if (operation.kind === 'put') {
      this.records.set(recordId, {
        envelope: structuredClone(operation.envelope),
        serverUpdatedAtMs: ++this.serverSequence,
      });
    } else {
      this.records.delete(recordId);
    }
    const result = { status: 'committed' as const, revision: currentRevision + 1, serverUpdatedAtMs: this.serverSequence };
    this.receipts.set(operation.operationId, { operation: structuredClone(operation), result });
    if (this.failAfterCommitOnce) {
      this.failAfterCommitOnce = false;
      throw new TypeError('offline after commit');
    }
    return result;
  }
}

class TestTransport implements PrivateProVaultTransport {
  online = true;
  private readonly listeners = new Set<(online: boolean) => void>();

  constructor(readonly server: TestVaultServer) {}

  isOnline() {
    return this.online;
  }

  subscribeConnectivity(listener: (online: boolean) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setOnline(online: boolean) {
    this.online = online;
    for (const listener of this.listeners) listener(online);
  }

  async getIndex() {
    if (!this.online) throw new TypeError('offline');
    return this.server.index();
  }

  async getRecords(recordIds: readonly string[]) {
    if (!this.online) throw new TypeError('offline');
    return this.server.getRecords(recordIds);
  }

  async write(operation: PrivateProVaultOperation) {
    if (!this.online) throw new TypeError('offline');
    return this.server.write(operation);
  }
}

interface TestClient {
  db: PrivateProVaultDB;
  engine: PrivateProVaultEngine;
  serializers: Map<PrivateProVaultRecordType, TestSerializer>;
  store: ReturnType<typeof createPrivateProVaultStore>;
  transport: TestTransport;
}

async function createClient(
  t: TestContext,
  server: TestVaultServer,
  masterKey: CryptoKey,
  name: string,
  options: {
    now?: () => number;
    operationPrefix?: string;
    rejectThemeValue?: string;
    rejectThemeApplyValue?: string;
    clearSession?: () => Promise<void>;
    beforeAcknowledgeCommit?: () => Promise<void>;
    assets?: {
      referencedAssetIds(recordType: PrivateProVaultRecordType, value: unknown): readonly string[];
      prepareForUpload(assetIds: readonly string[], signal: AbortSignal): Promise<void>;
      prepareForHydrate(assetIds: readonly string[], signal: AbortSignal): Promise<void>;
      clearHydratedAssets(): Promise<void>;
    };
    persistCurrent?: (
      index: readonly PrivateProVaultIndexEntry[],
      envelopes: readonly PrivateProVaultEnvelope[],
      persist: () => Promise<void>,
    ) => Promise<void>;
  } = {},
): Promise<TestClient> {
  const dbName = `private-pro-vault-engine-${name}-${crypto.randomUUID()}`;
  const db = new PrivateProVaultDB(dbName);
  t.after(async () => {
    db.close();
    await Dexie.delete(dbName);
  });
  const recordIds = new Map([
    ['openai', CREDENTIAL_ID],
    ['theme', THEME_ID],
    ['chat', CHAT_ID],
  ]);
  const serializers = new Map<PrivateProVaultRecordType, TestSerializer>([
    ['credential-service', new TestSerializer('credential-service', 'replace', recordIds)],
    ['settings', new TestSerializer('settings', 'replace', recordIds, options.rejectThemeValue, options.rejectThemeApplyValue)],
    ['chat', new TestSerializer('chat', 'conflict-copy', recordIds)],
  ]);
  const store = createPrivateProVaultStore();
  let operationSequence = 0;
  const transport = new TestTransport(server);
  const engine = createPrivateProVaultEngine({
    uid: UID,
    keyVersion: 1,
    masterKey,
    vaultContext: VAULT_CONTEXT,
    db,
    serializers: [...serializers.values()],
    transport,
    store,
    now: options.now ?? (() => 1),
    createOperationId: () => `${options.operationPrefix ?? name}-${++operationSequence}`,
    clearSession: options.clearSession,
    beforeAcknowledgeCommit: options.beforeAcknowledgeCommit,
    persistCurrent: options.persistCurrent,
    assets: options.assets,
  });
  return { db, engine, serializers, store, transport };
}

function serializer(client: TestClient, recordType: PrivateProVaultRecordType): TestSerializer {
  const value = client.serializers.get(recordType);
  if (!value) throw new Error(`Missing ${recordType} test serializer.`);
  return value;
}

async function openClient(client: TestClient) {
  await client.engine.hydrateBeforeOpen();
  await client.engine.start();
  await client.engine.whenCurrent();
}

async function encryptedEnvelope(
  masterKey: CryptoKey,
  recordType: PrivateProVaultRecordType,
  recordId: string,
  revision: number,
  value: TestValue,
) {
  const { encryptVaultRecord } = await import('./privatePro.vault.crypto');
  const key = await deriveVaultSubkey(masterKey, 'record-encryption', `${recordType}:${recordId}`, ['encrypt']);
  return encryptVaultRecord(key, {
    ...VAULT_CONTEXT,
    formatVersion: 1,
    recordType,
    recordId,
    schemaVersion: 1,
    keyVersion: 1,
    revision,
  }, new TextEncoder().encode(JSON.stringify(value)));
}


describe('private Pro blocking multi-device vault engine', () => {
  test('hydrates referenced assets before applying a remote chat', async (t) => {
    const masterKey = await importVaultMasterKey(generateVaultMasterKeyBytes());
    const server = new TestVaultServer();
    const order: string[] = [];
    let releaseAssets = () => {};
    const assetGate = new Promise<void>(resolve => releaseAssets = resolve);
    const client = await createClient(t, server, masterKey, 'asset-hydrate', {
      assets: {
        referencedAssetIds: recordType => recordType === 'chat' ? ['asset-private'] : [],
        async prepareForHydrate(assetIds) {
          order.push(`hydrate:${assetIds.join(',')}`);
          await assetGate;
        },
        async prepareForUpload() {},
        async clearHydratedAssets() {},
      },
    });
    const chatSerializer = serializer(client, 'chat');
    const originalApply = chatSerializer.apply.bind(chatSerializer);
    chatSerializer.apply = async (recordId, value) => {
      order.push('apply:chat');
      await originalApply(recordId, value);
    };
    server.records.set(CHAT_ID, {
      envelope: await encryptedEnvelope(masterKey, 'chat', CHAT_ID, 1, { id: 'chat', value: 'remote' }),
      serverUpdatedAtMs: 1,
    });

    const hydration = client.engine.hydrateBeforeOpen();
    while (order.length === 0) await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(order, ['hydrate:asset-private']);
    assert.equal(chatSerializer.values.size, 0);
    releaseAssets();
    await hydration;

    assert.deepEqual(order, ['hydrate:asset-private', 'apply:chat']);
  });

  test('uploads referenced assets before writing a local encrypted chat record', async (t) => {
    const masterKey = await importVaultMasterKey(generateVaultMasterKeyBytes());
    const server = new TestVaultServer();
    const order: string[] = [];
    const originalWrite = server.write.bind(server);
    server.write = async operation => {
      order.push('write:chat');
      return originalWrite(operation);
    };
    const client = await createClient(t, server, masterKey, 'asset-upload', {
      assets: {
        referencedAssetIds: recordType => recordType === 'chat' ? ['asset-private'] : [],
        async prepareForHydrate() {},
        async prepareForUpload(assetIds) { order.push(`upload:${assetIds.join(',')}`); },
        async clearHydratedAssets() {},
      },
    });
    await openClient(client);

    await serializer(client, 'chat').mutate(CHAT_ID, { id: 'chat', value: 'local' });
    await client.engine.whenCurrent();

    assert.deepEqual(order, ['upload:asset-private', 'write:chat']);
  });

  test('stop aborts an in-flight asset upload before any remote write or acknowledgement', async (t) => {
    const masterKey = await importVaultMasterKey(generateVaultMasterKeyBytes());
    const server = new TestVaultServer();
    let uploadStarted = false;
    let uploadAborted = false;
    const client = await createClient(t, server, masterKey, 'asset-upload-abort', {
      assets: {
        referencedAssetIds: recordType => recordType === 'chat' ? ['asset-private'] : [],
        async prepareForHydrate() {},
        async prepareForUpload(_assetIds, signal) {
          uploadStarted = true;
          await new Promise<void>((resolve, reject) => {
            signal.addEventListener('abort', () => {
              uploadAborted = true;
              reject(new DOMException('aborted', 'AbortError'));
            }, { once: true });
          });
        },
        async clearHydratedAssets() {},
      },
    });
    await openClient(client);

    await serializer(client, 'chat').mutate(CHAT_ID, { id: 'chat', value: 'local' });
    while (!uploadStarted) await new Promise(resolve => setTimeout(resolve, 0));
    await client.engine.stopAndWait();

    assert.equal(uploadAborted, true);
    assert.equal(server.operations.length, 0);
    assert.equal(await client.db.outbox.where('uid').equals(UID).count(), 1);
  });

  test('stop aborts in-flight asset hydration and prevents stale apply or persistence', async (t) => {
    const masterKey = await importVaultMasterKey(generateVaultMasterKeyBytes());
    const server = new TestVaultServer();
    let hydrateStarted = false;
    let hydrateAborted = false;
    const client = await createClient(t, server, masterKey, 'asset-hydrate-abort', {
      assets: {
        referencedAssetIds: recordType => recordType === 'chat' ? ['asset-private'] : [],
        async prepareForUpload() {},
        async prepareForHydrate(_assetIds, signal) {
          hydrateStarted = true;
          await new Promise<void>((resolve, reject) => {
            signal.addEventListener('abort', () => {
              hydrateAborted = true;
              reject(new DOMException('aborted', 'AbortError'));
            }, { once: true });
          });
        },
        async clearHydratedAssets() {},
      },
    });
    server.records.set(CHAT_ID, {
      envelope: await encryptedEnvelope(masterKey, 'chat', CHAT_ID, 1, { id: 'chat', value: 'remote' }),
      serverUpdatedAtMs: 1,
    });

    const hydration = client.engine.hydrateBeforeOpen();
    while (!hydrateStarted) await new Promise(resolve => setTimeout(resolve, 0));
    await client.engine.stopAndWait();
    await Promise.allSettled([hydration]);

    assert.equal(hydrateAborted, true);
    assert.equal(serializer(client, 'chat').values.size, 0);
    assert.equal(await client.db.records.where('uid').equals(UID).count(), 0);
  });

  test('PC B downloads and applies PC A credentials before ready, then changes theme independently', async (t) => {
    const masterKey = await importVaultMasterKey(generateVaultMasterKeyBytes());
    const server = new TestVaultServer();
    const pcA = await createClient(t, server, masterKey, 'pc-a');
    await openClient(pcA);

    await serializer(pcA, 'credential-service').mutate(CREDENTIAL_ID, { id: 'openai', value: 'sentinel-api-key' });
    await pcA.engine.whenCurrent();
    const credentialBeforeTheme = structuredClone(server.records.get(CREDENTIAL_ID));
    assert.equal(credentialBeforeTheme?.envelope.revision, 1);

    const pcB = await createClient(t, server, masterKey, 'pc-b');
    await serializer(pcB, 'credential-service').mutate(CREDENTIAL_ID, { id: 'openai', value: 'older-key' });
    let releaseDownload = () => {};
    server.delayRecordFetch = new Promise<void>(resolve => releaseDownload = resolve);

    const hydration = pcB.engine.hydrateBeforeOpen();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(pcB.store.getState().phase, 'hydrating');
    assert.equal(pcB.store.getState().ready, false);
    assert.equal(serializer(pcB, 'credential-service').values.get(CREDENTIAL_ID)?.value, 'older-key');

    releaseDownload();
    await hydration;
    assert.equal(pcB.store.getState().phase, 'ready');
    assert.equal(serializer(pcB, 'credential-service').values.get(CREDENTIAL_ID)?.value, 'sentinel-api-key');
    await pcB.engine.start();

    server.delayRecordFetch = null;
    await serializer(pcB, 'settings').mutate(THEME_ID, { id: 'theme', value: 'dark' });
    await pcB.engine.whenCurrent();

    assert.deepEqual(server.records.get(CREDENTIAL_ID), credentialBeforeTheme);
    assert.equal(server.records.get(THEME_ID)?.envelope.revision, 1);
  });

  test('blocks offline startup without applying the stale cache', async (t) => {
    const masterKey = await importVaultMasterKey(generateVaultMasterKeyBytes());
    const server = new TestVaultServer();
    const client = await createClient(t, server, masterKey, 'offline');
    await serializer(client, 'settings').mutate(THEME_ID, { id: 'theme', value: 'stale' });
    const transport = new TestTransport(server);
    transport.online = false;
    const offlineStore = createPrivateProVaultStore();
    const engine = createPrivateProVaultEngine({
      uid: UID, keyVersion: 1, masterKey, vaultContext: VAULT_CONTEXT, db: client.db,
      serializers: [...client.serializers.values()], transport, store: offlineStore,
    });

    await assert.rejects(engine.hydrateBeforeOpen(), /online|network|connect/i);

    assert.equal(offlineStore.getState().phase, 'reconnecting');
    assert.equal(offlineStore.getState().ready, false);
    assert.equal(serializer(client, 'settings').values.get(THEME_ID)?.value, 'stale');
  });

  test('uses server revisions instead of device clocks and refetches before exact same-record replay', async (t) => {
    const masterKey = await importVaultMasterKey(generateVaultMasterKeyBytes());
    const server = new TestVaultServer();
    const pcA = await createClient(t, server, masterKey, 'clock-a', { now: () => Number.MAX_SAFE_INTEGER });
    const pcB = await createClient(t, server, masterKey, 'clock-b', { now: () => 0 });
    await openClient(pcA);
    await serializer(pcA, 'settings').mutate(THEME_ID, { id: 'theme', value: 'light' });
    await pcA.engine.whenCurrent();
    await openClient(pcB);

    await serializer(pcA, 'settings').mutate(THEME_ID, { id: 'theme', value: 'system' });
    await pcA.engine.whenCurrent();
    const fetchCountBeforeConflict = server.fetches.length;
    await serializer(pcB, 'settings').mutate(THEME_ID, { id: 'theme', value: 'dark' });
    await pcB.engine.whenCurrent();

    assert.equal(server.records.get(THEME_ID)?.envelope.revision, 3);
    assert.equal(serializer(pcB, 'settings').values.get(THEME_ID)?.value, 'dark');
    assert(server.fetches.length > fetchCountBeforeConflict, 'stale-base conflicts must refetch canonical ciphertext');
  });

  test('replays the identical encrypted operation after an ambiguous network failure', async (t) => {
    const masterKey = await importVaultMasterKey(generateVaultMasterKeyBytes());
    const server = new TestVaultServer();
    const client = await createClient(t, server, masterKey, 'replay');
    await openClient(client);
    server.failAfterCommitOnce = true;

    await serializer(client, 'settings').mutate(THEME_ID, { id: 'theme', value: 'dark' });
    await client.engine.whenCurrent();
    assert.equal(client.store.getState().phase, 'reconnecting');
    assert.equal(await client.db.outbox.where('uid').equals(UID).count(), 1);

    await client.engine.start();
    await client.engine.whenCurrent();

    assert.equal(server.operations.length, 2);
    assert.deepEqual(server.operations[1], server.operations[0]);
    assert.equal(await client.db.outbox.where('uid').equals(UID).count(), 0);
  });

  test('blocks a remote index rollback before applying older ciphertext', async (t) => {
    const masterKey = await importVaultMasterKey(generateVaultMasterKeyBytes());
    const server = new TestVaultServer();
    server.records.set(THEME_ID, {
      envelope: await encryptedEnvelope(masterKey, 'settings', THEME_ID, 2, { id: 'theme', value: 'dark' }),
      serverUpdatedAtMs: 10,
    });
    const client = await createClient(t, server, masterKey, 'rollback');
    await client.engine.hydrateBeforeOpen();
    server.records.set(THEME_ID, {
      envelope: await encryptedEnvelope(masterKey, 'settings', THEME_ID, 1, { id: 'theme', value: 'light' }),
      serverUpdatedAtMs: 999,
    });

    await assert.rejects(client.engine.hydrateBeforeOpen(), /rollback|regression/i);

    assert.equal(client.store.getState().phase, 'rollback-blocked');
    assert.equal(serializer(client, 'settings').values.get(THEME_ID)?.value, 'dark');
  });

  test('validates the full decrypted stage before applying any record', async (t) => {
    const masterKey = await importVaultMasterKey(generateVaultMasterKeyBytes());
    const server = new TestVaultServer();
    server.records.set(CREDENTIAL_ID, {
      envelope: await encryptedEnvelope(masterKey, 'credential-service', CREDENTIAL_ID, 1, { id: 'openai', value: 'sentinel-api-key' }),
      serverUpdatedAtMs: 1,
    });
    server.records.set(THEME_ID, {
      envelope: await encryptedEnvelope(masterKey, 'settings', THEME_ID, 1, { id: 'theme', value: 'reject-stage' }),
      serverUpdatedAtMs: 2,
    });
    const client = await createClient(t, server, masterKey, 'atomic-stage', { rejectThemeValue: 'reject-stage' });

    await assert.rejects(client.engine.hydrateBeforeOpen(), /rejected/i);

    assert.equal(serializer(client, 'credential-service').values.size, 0);
    assert.equal(serializer(client, 'settings').values.size, 0);
    assert.equal(client.store.getState().ready, false);
  });

  test('rolls runtime stores back without uploads when a staged apply fails', async (t) => {
    const masterKey = await importVaultMasterKey(generateVaultMasterKeyBytes());
    const server = new TestVaultServer();
    server.records.set(CREDENTIAL_ID, {
      envelope: await encryptedEnvelope(masterKey, 'credential-service', CREDENTIAL_ID, 1, { id: 'openai', value: 'sentinel-api-key' }),
      serverUpdatedAtMs: 1,
    });
    server.records.set(THEME_ID, {
      envelope: await encryptedEnvelope(masterKey, 'settings', THEME_ID, 1, { id: 'theme', value: 'apply-fails' }),
      serverUpdatedAtMs: 2,
    });
    const client = await createClient(t, server, masterKey, 'atomic-apply', { rejectThemeApplyValue: 'apply-fails' });

    await assert.rejects(client.engine.hydrateBeforeOpen(), /apply failed/i);

    assert.equal(serializer(client, 'credential-service').values.size, 0);
    assert.equal(serializer(client, 'settings').values.size, 0);
    assert.equal(server.operations.length, 0);
  });

  test('restores runtime and leaves encrypted cache unchanged when hydration persistence fails', async (t) => {
    const masterKey = await importVaultMasterKey(generateVaultMasterKeyBytes());
    const server = new TestVaultServer();
    const client = await createClient(t, server, masterKey, 'persist-failure', {
      persistCurrent: async (_index, _envelopes, persist) => {
        await persist();
        throw new Error('injected durable commit failure');
      },
    });
    const oldEnvelope = await encryptedEnvelope(masterKey, 'settings', THEME_ID, 1, { id: 'theme', value: 'light' });
    await client.db.putEncryptedRecord(UID, oldEnvelope);
    await client.db.revisions.put({ uid: UID, recordType: 'settings', recordId: THEME_ID, revision: 1 });
    await serializer(client, 'settings').mutate(THEME_ID, { id: 'theme', value: 'light' });
    server.records.set(THEME_ID, {
      envelope: await encryptedEnvelope(masterKey, 'settings', THEME_ID, 2, { id: 'theme', value: 'dark' }),
      serverUpdatedAtMs: 2,
    });
    await assert.rejects(client.engine.hydrateBeforeOpen(), /durable commit failure/i);

    assert.equal(serializer(client, 'settings').values.get(THEME_ID)?.value, 'light');
    assert.deepEqual(await client.db.listEncryptedRecords(UID), [oldEnvelope]);
    assert.equal((await client.db.revisions.get([UID, 'settings', THEME_ID]))?.revision, 1);
    assert.equal(client.store.getState().phase, 'error');
    assert.equal(client.store.getState().ready, false);
  });

  test('stop invalidates a deferred upload before local acknowledgement or status changes', async (t) => {
    const masterKey = await importVaultMasterKey(generateVaultMasterKeyBytes());
    const server = new TestVaultServer();
    const client = await createClient(t, server, masterKey, 'stop-upload');
    await openClient(client);
    let releaseWrite = () => {};
    server.delayWrite = new Promise<void>(resolve => releaseWrite = resolve);

    await serializer(client, 'settings').mutate(THEME_ID, { id: 'theme', value: 'dark' });
    while (server.operations.length === 0) await new Promise(resolve => setTimeout(resolve, 0));
    const stopResult = client.engine.stop();
    assert.equal(stopResult, undefined);
    let stopSettled = false;
    const stopping = client.engine.stopAndWait().then(() => stopSettled = true);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(stopSettled, false);
    releaseWrite();
    await stopping;

    assert.equal(await client.db.outbox.where('uid').equals(UID).count(), 1);
    assert.equal(await client.db.revisions.get([UID, 'settings', THEME_ID]), undefined);
    assert.equal(client.store.getState().phase, 'ready');
    assert.equal(client.store.getState().ready, true);
  });

  test('stop waits for a started acknowledgement transaction to commit atomically', async (t) => {
    const masterKey = await importVaultMasterKey(generateVaultMasterKeyBytes());
    const server = new TestVaultServer();
    let signalAcknowledgeStarted = () => {};
    const acknowledgeStarted = new Promise<void>(resolve => signalAcknowledgeStarted = resolve);
    let signalStopRequested = () => {};
    const stopRequested = new Promise<void>(resolve => signalStopRequested = resolve);
    let signalStopBlocked = (_blocked: boolean) => {};
    const stopBlocked = new Promise<boolean>(resolve => signalStopBlocked = resolve);
    let releaseAcknowledge = () => {};
    const acknowledgeGate = new Promise<void>(resolve => releaseAcknowledge = resolve);
    let stopSettled = false;
    const client = await createClient(t, server, masterKey, 'stop-acknowledge', {
      beforeAcknowledgeCommit: async () => {
        signalAcknowledgeStarted();
        await stopRequested;
        signalStopBlocked(!stopSettled);
        await acknowledgeGate;
      },
    });
    await openClient(client);

    await serializer(client, 'settings').mutate(THEME_ID, { id: 'theme', value: 'dark' });
    await acknowledgeStarted;
    const stopResult = client.engine.stop();
    assert.equal(stopResult, undefined);
    const stopping = client.engine.stopAndWait().then(() => stopSettled = true);
    signalStopRequested();
    assert.equal(await stopBlocked, true);

    releaseAcknowledge();
    await stopping;

    assert.equal(await client.db.outbox.where('uid').equals(UID).count(), 0);
    assert.equal((await client.db.revisions.get([UID, 'settings', THEME_ID]))?.revision, 1);
    assert.equal((await client.db.records.get([UID, 'settings', THEME_ID]))?.revision, 1);
    assert.equal(client.store.getState().phase, 'ready');
    assert.equal(client.store.getState().ready, true);
  });

  test('logout waits for deferred hydration cancellation and cannot be repopulated by the late fetch', async (t) => {
    const masterKey = await importVaultMasterKey(generateVaultMasterKeyBytes());
    const server = new TestVaultServer();
    server.records.set(THEME_ID, {
      envelope: await encryptedEnvelope(masterKey, 'settings', THEME_ID, 1, { id: 'theme', value: 'dark' }),
      serverUpdatedAtMs: 1,
    });
    let sessionClears = 0;
    const client = await createClient(t, server, masterKey, 'logout-fetch', {
      clearSession: async () => { sessionClears++; },
    });
    await client.db.outbox.put({
      uid: UID,
      operationId: 'existing-outbox',
      operation: {
        formatVersion: 1,
        operationId: 'existing-outbox',
        kind: 'delete',
        baseRevision: 0,
        tombstone: {
          formatVersion: 1,
          recordType: 'settings',
          recordId: THEME_ID,
          revision: 1,
          keyVersion: 1,
          operationId: 'existing-outbox',
          deletedAtMs: 999,
        },
      },
      createdAtMs: 999,
    });
    let releaseFetch = () => {};
    server.delayRecordFetch = new Promise<void>(resolve => releaseFetch = resolve);

    const hydration = client.engine.hydrateBeforeOpen();
    while (server.fetches.length === 0) await new Promise(resolve => setTimeout(resolve, 0));
    let logoutSettled = false;
    const logout = client.engine.logoutAndClear().then(() => logoutSettled = true);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(logoutSettled, false);
    releaseFetch();
    await Promise.allSettled([hydration, logout]);

    assert.equal(sessionClears, 1);
    assert.equal(await client.db.records.where('uid').equals(UID).count(), 0);
    assert.equal(await client.db.revisions.where('uid').equals(UID).count(), 0);
    assert.equal(await client.db.outbox.where('uid').equals(UID).count(), 0);
    assert.equal(serializer(client, 'settings').values.size, 0);
    assert.equal(client.store.getState().phase, 'locked');
    assert.equal(client.store.getState().ready, false);
  });

  test('encrypts a local mutation that races with disconnect and drains it only after refetch', async (t) => {
    const masterKey = await importVaultMasterKey(generateVaultMasterKeyBytes());
    const server = new TestVaultServer();
    const client = await createClient(t, server, masterKey, 'disconnect-race');
    await openClient(client);
    client.transport.setOnline(false);

    await serializer(client, 'settings').mutate(THEME_ID, { id: 'theme', value: 'dark' });
    await client.engine.whenCurrent();

    assert.equal(await client.db.outbox.where('uid').equals(UID).count(), 1);
    assert.equal(server.operations.length, 0);
    const fetchesBeforeReconnect = server.fetches.length;
    client.transport.setOnline(true);
    await client.engine.whenCurrent();
    assert(server.fetches.length > fetchesBeforeReconnect, 'reconnect must refetch the current index and records before draining');
    assert.equal(server.records.get(THEME_ID)?.envelope.revision, 1);
    assert.equal(serializer(client, 'settings').values.get(THEME_ID)?.value, 'dark');
  });

  test('preserves local mutation order when the device clock moves backwards', async (t) => {
    const masterKey = await importVaultMasterKey(generateVaultMasterKeyBytes());
    const server = new TestVaultServer();
    let clock = 100;
    const client = await createClient(t, server, masterKey, 'clock-backwards', { now: () => clock });
    await openClient(client);
    client.transport.setOnline(false);

    await serializer(client, 'settings').mutate(THEME_ID, { id: 'theme', value: 'dark' });
    await client.engine.whenCurrent();
    clock = 0;
    await serializer(client, 'settings').mutate(THEME_ID, { id: 'theme', value: 'light' });
    await client.engine.whenCurrent();
    client.transport.setOnline(true);
    await client.engine.whenCurrent();

    assert.equal(serializer(client, 'settings').values.get(THEME_ID)?.value, 'light');
    assert.equal(server.records.get(THEME_ID)?.envelope.revision, 2);
  });

  test('backfills mixed legacy outbox rows by primary key after sequenced rows and ignores timestamps', async (t) => {
    const masterKey = await importVaultMasterKey(generateVaultMasterKeyBytes());
    const server = new TestVaultServer();
    const client = await createClient(t, server, masterKey, 'legacy-sequence', { now: () => 0 });
    await openClient(client);
    client.transport.setOnline(false);
    await serializer(client, 'settings').mutate(THEME_ID, { id: 'theme', value: 'dark' });
    await client.engine.whenCurrent();
    const legacyOperation = (operationId: string, recordId: string, deletedAtMs: number): PrivateProVaultOperation => ({
      formatVersion: 1,
      operationId,
      kind: 'delete',
      baseRevision: 0,
      tombstone: {
        formatVersion: 1,
        recordType: 'settings',
        recordId,
        revision: 1,
        keyVersion: 1,
        operationId,
        deletedAtMs,
      },
    });
    const legacyAId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const legacyBId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    await client.db.outbox.bulkPut([
      { uid: UID, operationId: 'legacy-b', operation: legacyOperation('legacy-b', legacyBId, 0), createdAtMs: 0, localSequence: 0 },
      { uid: UID, operationId: 'legacy-a', operation: legacyOperation('legacy-a', legacyAId, Number.MAX_SAFE_INTEGER), createdAtMs: Number.MAX_SAFE_INTEGER },
    ]);

    client.transport.setOnline(true);
    await client.engine.whenCurrent();

    assert.deepEqual(server.operations.map(operation => operation.operationId), ['legacy-sequence-1', 'legacy-a', 'legacy-b']);
  });

  test('preserves both chat versions by uploading a conflict copy', async (t) => {
    const masterKey = await importVaultMasterKey(generateVaultMasterKeyBytes());
    const server = new TestVaultServer();
    const pcA = await createClient(t, server, masterKey, 'chat-a');
    const pcB = await createClient(t, server, masterKey, 'chat-b');
    await openClient(pcA);
    await serializer(pcA, 'chat').mutate(CHAT_ID, { id: 'chat', value: 'base' });
    await pcA.engine.whenCurrent();
    await openClient(pcB);

    await serializer(pcA, 'chat').mutate(CHAT_ID, { id: 'chat', value: 'remote' });
    await pcA.engine.whenCurrent();
    await serializer(pcB, 'chat').mutate(CHAT_ID, { id: 'chat', value: 'local' });
    await pcB.engine.whenCurrent();

    assert.equal(server.records.get(CHAT_ID)?.envelope.revision, 2);
    assert.equal(serializer(pcB, 'chat').values.get(CHAT_ID)?.value, 'remote');
    assert.equal(serializer(pcB, 'chat').conflictCopies[0]?.value, 'local');
    assert.equal(server.records.size, 2);
  });

  test('keeps an oversized encrypted outbox record and blocks with chunk-required without uploading', async (t) => {
    const masterKey = await importVaultMasterKey(generateVaultMasterKeyBytes());
    const server = new TestVaultServer();
    const client = await createClient(t, server, masterKey, 'chunk-required');
    await openClient(client);

    await serializer(client, 'settings').mutate(THEME_ID, { id: 'theme', value: 'x'.repeat(701 * 1024) });
    await client.engine.whenCurrent();

    assert.equal(client.store.getState().phase, 'chunk-required');
    assert.equal(client.store.getState().ready, false);
    assert.equal(server.operations.length, 0);
    const outbox = await client.db.outbox.where('uid').equals(UID).first();
    assert(outbox?.operation.kind === 'put');
    assert(outbox.operation.envelope.ciphertextBytes > 700 * 1024);
    assert.equal(JSON.stringify(outbox).includes('x'.repeat(100)), false, 'outbox must not contain plaintext fragments');
  });
});
