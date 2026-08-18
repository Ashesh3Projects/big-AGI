import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import Dexie from 'dexie';

import { generateVaultMasterKeyBytes, importVaultMasterKey } from './privatePro.vault.crypto';
import { PrivateProVaultDB } from './privatePro.vault.db';
import {
  PRIVATE_PRO_VAULT_MIGRATION_PHASES,
  createPrivateProVaultMigration,
  createPrivateProVaultMigrationLifecycle,
  type PrivateProVaultMigrationLegacyItem,
  type PrivateProVaultMigrationAssetDescriptor,
  type PrivateProVaultMigrationPhase,
} from './privatePro.vault.migration';
import type { PrivateProVaultSerializer } from './privatePro.vault.serializers';
import type { PrivateProVaultEnvelope, PrivateProVaultOperation } from './privatePro.vault.types';
import { renderPrivateProVaultMigrationProgress } from '../ui/PrivateProVaultStatus';


const UID = 'uid-migration-test';
const OTHER_UID = 'uid-migration-other';
const MIGRATION_ID = 'legacy-v1';
const RECORD_ID = 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr';

interface TestValue {
  id: string;
  body: string;
  assetIds: string[];
}

class TestSerializer implements PrivateProVaultSerializer<TestValue> {
  readonly recordType = 'chat' as const;
  readonly schemaVersion = 1;
  readonly conflictPolicy = 'replace' as const;
  readonly values = new Map<string, TestValue>();

  async snapshot() {
    return [...this.values].map(([recordId, value]) => ({ recordId, value: structuredClone(value) }));
  }

  async validate(recordId: string, value: unknown) {
    if (recordId !== RECORD_ID || !value || typeof value !== 'object') throw new Error('Invalid migrated value.');
    const candidate = value as TestValue;
    if (candidate.id !== 'chat-1' || typeof candidate.body !== 'string' || !Array.isArray(candidate.assetIds))
      throw new Error('Invalid migrated value.');
    return structuredClone(candidate);
  }

  async apply(recordId: string, value: TestValue) {
    this.values.set(recordId, await this.validate(recordId, value));
  }

  async remove(recordId: string) {
    this.values.delete(recordId);
  }

  subscribe() {
    return () => {};
  }
}

function createDB(t: TestContext): PrivateProVaultDB {
  const name = `private-pro-vault-migration-test-${crypto.randomUUID()}`;
  const db = new PrivateProVaultDB(name);
  t.after(async () => {
    db.close();
    await Dexie.delete(name);
  });
  return db;
}

async function createHarness(t: TestContext) {
  const db = createDB(t);
  const masterKey = await importVaultMasterKey(generateVaultMasterKeyBytes());
  const serializer = new TestSerializer();
  const value: TestValue = { id: 'chat-1', body: 'private migration text', assetIds: ['asset-private'] };
  let localItems: PrivateProVaultMigrationLegacyItem[] = [{
    source: 'local',
    sourceId: 'local-chat-1',
    sourceVersion: 'local-v1',
    recordType: 'chat',
    recordId: RECORD_ID,
    schemaVersion: 1,
    value: structuredClone(value),
    assetIds: ['asset-private'],
  }];
  let cloudItems: PrivateProVaultMigrationLegacyItem[] = [{
    source: 'cloud',
    sourceId: 'cloud-chat-1',
    sourceVersion: 'cloud-v3',
    recordType: 'chat',
    recordId: RECORD_ID,
    schemaVersion: 1,
    value: structuredClone(value),
    assetIds: ['asset-private'],
  }];
  let uploaded: PrivateProVaultEnvelope | null = null;
  let exportConfirmed = true;
  let committed = false;
  let localCleanup = 0;
  let cloudCleanup = 0;
  let verifyCount = 0;
  let uploadEffects = 0;
  let operationSequence = 0;
  let assetDescriptor: PrivateProVaultMigrationAssetDescriptor = {
    assetId: 'asset-private', plaintextBytes: 32, contentSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64),
  };
  let faultPoint: string | null = null;
  let faultThrown = false;
  const operations: string[] = [];
  const uploadReceipts = new Set<string>();
  const localCleanupReceipts = new Set<string>();
  const cloudCleanupReceipts = new Set<string>();

  const create = () => createPrivateProVaultMigration({
    uid: UID,
    migrationId: MIGRATION_ID,
    keyVersion: 1,
    masterKey,
    db,
    serializers: [serializer],
    inventory: {
      async listLocal() { return structuredClone(localItems); },
      async listCloud() { return structuredClone(cloudItems); },
      async currentVersion(item) {
        return [...localItems, ...cloudItems].find(candidate => candidate.source === item.source && candidate.sourceId === item.sourceId)?.sourceVersion ?? null;
      },
    },
    records: {
      async upload(operation: PrivateProVaultOperation) {
        operations.push(operation.operationId);
        if (operation.kind !== 'put') throw new Error('Unexpected delete.');
        if (!uploadReceipts.has(operation.operationId)) {
          uploadReceipts.add(operation.operationId);
          uploadEffects++;
          uploaded = structuredClone(operation.envelope);
        }
        return { status: 'committed' as const, revision: 1 };
      },
      async download(recordIds) {
        return uploaded && recordIds.includes(uploaded.recordId) ? [structuredClone(uploaded)] : [];
      },
    },
    assets: {
      async describe() { return [structuredClone(assetDescriptor)]; },
      async prepareForUpload() {},
      async verifyCloud() { verifyCount++; },
      async deleteLocal() {},
    },
    server: {
      async commit(input) {
        committed = true;
        return { status: 'committed' as const, phase: input.phase };
      },
    },
    exportGate: {
      async getConfirmation(binding) {
        return exportConfirmed ? { ...binding, exportDigest: 'e'.repeat(64) } : null;
      },
    },
    cleanup: {
      async local(_item, operationId) {
        if (localCleanupReceipts.has(operationId)) return;
        localCleanupReceipts.add(operationId);
        localCleanup++;
      },
      async cloud(_item, operationId) {
        if (cloudCleanupReceipts.has(operationId)) return;
        cloudCleanupReceipts.add(operationId);
        cloudCleanup++;
      },
    },
    collectAssetIds: (_recordType, input) => (input as TestValue).assetIds,
    createOperationId: purpose => `migration-${purpose}-${++operationSequence}`,
    async afterEffect(point) {
      if (!faultThrown && faultPoint === point) {
        faultThrown = true;
        throw new Error(`injected fault after ${point}`);
      }
    },
    now: () => 1_000,
  });

  return {
    db,
    create,
    value,
    operations,
    get uploaded() { return uploaded; },
    setUploaded(next: PrivateProVaultEnvelope | null) { uploaded = next; },
    setLocalItems(items: PrivateProVaultMigrationLegacyItem[]) { localItems = items; },
    setCloudItems(items: PrivateProVaultMigrationLegacyItem[]) { cloudItems = items; },
    setAssetDescriptor(next: PrivateProVaultMigrationAssetDescriptor) { assetDescriptor = next; },
    injectFault(point: string) { faultPoint = point; faultThrown = false; },
    setExportConfirmed(next: boolean) { exportConfirmed = next; },
    get committed() { return committed; },
    get localCleanup() { return localCleanup; },
    get cloudCleanup() { return cloudCleanup; },
    get verifyCount() { return verifyCount; },
    get uploadEffects() { return uploadEffects; },
  };
}

describe('private Pro plaintext-to-encrypted migration', () => {
  test('publishes the exact monotonic migration phase contract', () => {
    assert.deepEqual(PRIVATE_PRO_VAULT_MIGRATION_PHASES, [
      'inventory', 'encrypt-local', 'upload', 'verify-cloud', 'commit', 'cleanup-local', 'cleanup-cloud', 'complete',
    ]);
  });

  test('rejects server migration phase regression even when the CAS base matches', async () => {
    const { createPrivateProVaultService } = await import('./privatePro.vault.service');
    type Tx = Parameters<Parameters<typeof createPrivateProVaultService>[0]['transaction']>[1] extends (transaction: infer T) => Promise<unknown> ? T : never;
    const migrations = new Map<string, { migrationId: string; phase: string; serverUpdatedAtMs: number }>();
    const operations = new Map<string, unknown>();
    const transaction = {
      getMigration: async (migrationId: string) => migrations.get(migrationId) ?? null,
      setMigration: async (migration: { migrationId: string; phase: string; serverUpdatedAtMs: number }) => { migrations.set(migration.migrationId, migration); },
      getOperation: async (operationId: string) => operations.get(operationId) ?? null,
      createOperation: async (operation: { operationId: string }) => { operations.set(operation.operationId, operation); },
    } as unknown as Tx;
    const repository = { transaction: async <T>(_uid: string, callback: (tx: Tx) => Promise<T>) => callback(transaction) };
    const service = createPrivateProVaultService(repository as Parameters<typeof createPrivateProVaultService>[0], () => 1_000);

    await service.commitMigration(UID, { operationId: 'phase-1', migrationId: MIGRATION_ID, basePhase: null, phase: 'commit' });
    await assert.rejects(
      service.commitMigration(UID, { operationId: 'phase-2', migrationId: MIGRATION_ID, basePhase: 'commit', phase: 'inventory' }),
      /phase regression/i,
    );
  });

  for (const phase of PRIVATE_PRO_VAULT_MIGRATION_PHASES) {
    test(`resumes idempotently after interruption in ${phase}`, async (t) => {
      const harness = await createHarness(t);
      let interrupted = false;
      const first = harness.create();
      first.subscribe(progress => {
        if (!interrupted && progress.phase === phase) {
          interrupted = true;
          first.stop();
        }
      });
      await assert.rejects(first.run(), /cancelled/i);
      const mayHaveCleanedLocal = phase === 'cleanup-cloud' || phase === 'complete';
      assert.equal(harness.localCleanup, mayHaveCleanedLocal ? 1 : 0, 'cleanup must not run before its gated phase');
      assert.equal(harness.cloudCleanup, phase === 'complete' ? 1 : 0, 'cloud cleanup must not run before its gated phase');

      const resumed = harness.create();
      await resumed.run();
      assert.equal(resumed.getProgress().phase, 'complete');
      assert.equal(harness.localCleanup, 1);
      assert.equal(harness.cloudCleanup, 1);
      assert.equal(new Set(harness.operations).size, harness.operations.length, 'operation replay must remain idempotent');
    });
  }

  test('blocks commit when a frozen source changes after inventory', async (t) => {
    const harness = await createHarness(t);
    const migration = harness.create();
    migration.subscribe(progress => {
      if (progress.phase !== 'upload') return;
      harness.setLocalItems([{
        source: 'local', sourceId: 'local-chat-1', sourceVersion: 'local-v2', recordType: 'chat', recordId: RECORD_ID,
        schemaVersion: 1, value: { ...harness.value, body: 'late edit' }, assetIds: ['asset-private'],
      }]);
    });

    await assert.rejects(migration.run(), /changed after inventory/i);
    assert.equal(harness.committed, false);
    assert.equal(harness.localCleanup, 0);
  });

  test('rejects corrupted downloaded ciphertext and preserves every plaintext source', async (t) => {
    const harness = await createHarness(t);
    const migration = harness.create();
    migration.subscribe(progress => {
      const uploaded = harness.uploaded;
      if (progress.phase === 'verify-cloud' && uploaded)
        harness.setUploaded({ ...uploaded, ciphertextBase64: `A${uploaded.ciphertextBase64.slice(1)}` });
    });

    await assert.rejects(migration.run());
    assert.equal(harness.committed, false);
    assert.equal(harness.localCleanup, 0);
    assert.equal(harness.cloudCleanup, 0);
  });

  test('requires explicit encrypted export confirmation before commit and cleanup', async (t) => {
    const harness = await createHarness(t);
    harness.setExportConfirmed(false);

    await assert.rejects(harness.create().run(), /encrypted export/i);
    assert.equal(harness.committed, false);
    assert.equal(harness.localCleanup, 0);
    assert.equal(harness.cloudCleanup, 0);
  });

  test('persists explicit encrypted-export confirmation and resumes cleanup', async (t) => {
    const harness = await createHarness(t);
    harness.setExportConfirmed(false);
    const migration = harness.create();
    await assert.rejects(migration.run(), /encrypted export/i);

    const binding = await migration.getEncryptedExportBinding();
    const confirmation = { ...binding, exportDigest: 'e'.repeat(64) };
    await migration.registerEncryptedExport(confirmation);
    await migration.confirmEncryptedExport(confirmation);
    await migration.run();

    assert.equal(migration.getProgress().phase, 'complete');
    assert.equal(harness.localCleanup, 1);
    assert.equal(harness.cloudCleanup, 1);
  });

  for (const point of ['upload', 'verify-cloud', 'commit', 'cleanup-local', 'cleanup-cloud', 'complete'] as const) {
    test(`checkpoints ${point} before a post-effect crash and resumes without repeating it`, async (t) => {
      const harness = await createHarness(t);
      const migration = harness.create();
      harness.injectFault(point);

      await assert.rejects(migration.run(), new RegExp(`injected fault after ${point}`));
      const before = {
        uploads: harness.uploadEffects,
        verifications: harness.verifyCount,
        localCleanup: harness.localCleanup,
        cloudCleanup: harness.cloudCleanup,
      };
      await harness.create().run();
      assert.equal(harness.uploadEffects, before.uploads);
      const expectedVerifications = point === 'upload'
        ? before.verifications + 1
        : point === 'verify-cloud'
          ? before.verifications + 1
          : before.verifications;
      assert.equal(harness.verifyCount, expectedVerifications);
      assert.equal(harness.localCleanup, 1);
      assert.equal(harness.cloudCleanup, 1);
      if (point === 'cleanup-local') assert.equal(before.localCleanup, 1);
      if (point === 'cleanup-cloud') assert.equal(before.cloudCleanup, 1);
    });
  }

  test('blocks a local source added after inventory', async (t) => {
    const harness = await createHarness(t);
    const migration = harness.create();
    migration.subscribe(progress => {
      if (progress.phase !== 'upload') return;
      harness.setLocalItems([
        { source: 'local', sourceId: 'local-chat-1', sourceVersion: 'local-v1', recordType: 'chat', recordId: RECORD_ID, schemaVersion: 1, value: harness.value, assetIds: ['asset-private'] },
        { source: 'local', sourceId: 'late-chat', sourceVersion: 'late-v1', recordType: 'chat', recordId: RECORD_ID, schemaVersion: 1, value: harness.value, assetIds: ['asset-private'] },
      ]);
    });
    await assert.rejects(migration.run(), /inventory changed/i);
    assert.equal(harness.committed, false);
  });

  test('blocks a cloud source added after inventory', async (t) => {
    const harness = await createHarness(t);
    const migration = harness.create();
    migration.subscribe(progress => {
      if (progress.phase !== 'upload') return;
      harness.setCloudItems([
        { source: 'cloud', sourceId: 'cloud-chat-1', sourceVersion: 'cloud-v3', recordType: 'chat', recordId: RECORD_ID, schemaVersion: 1, value: harness.value, assetIds: ['asset-private'] },
        { source: 'cloud', sourceId: 'late-cloud', sourceVersion: 'cloud-v1', recordType: 'chat', recordId: RECORD_ID, schemaVersion: 1, value: harness.value, assetIds: ['asset-private'] },
      ]);
    });
    await assert.rejects(migration.run(), /inventory changed/i);
  });

  test('blocks changed asset bytes or metadata even when the source version is unchanged', async (t) => {
    const harness = await createHarness(t);
    const migration = harness.create();
    migration.subscribe(progress => {
      if (progress.phase === 'upload') harness.setAssetDescriptor({
        assetId: 'asset-private', plaintextBytes: 32, contentSha256: 'c'.repeat(64), manifestSha256: 'd'.repeat(64),
      });
    });
    await assert.rejects(migration.run(), /asset.*changed|inventory changed/i);
    assert.equal(harness.localCleanup, 0);
  });

  test('blocks a newly referenced asset that was absent from the frozen inventory', async (t) => {
    const harness = await createHarness(t);
    const migration = harness.create();
    migration.subscribe(progress => {
      if (progress.phase !== 'upload') return;
      harness.setLocalItems([{
        source: 'local', sourceId: 'local-chat-1', sourceVersion: 'local-v1', recordType: 'chat', recordId: RECORD_ID,
        schemaVersion: 1, value: { ...harness.value, assetIds: ['asset-private', 'late-asset'] }, assetIds: ['asset-private', 'late-asset'],
      }]);
    });
    await assert.rejects(migration.run(), /inventory changed/i);
    assert.equal(harness.localCleanup, 0);
  });

  test('preserves a shared asset still referenced by a post-inventory source', async (t) => {
    const harness = await createHarness(t);
    const migration = harness.create();
    migration.subscribe(progress => {
      if (progress.phase !== 'upload') return;
      harness.setCloudItems([
        { source: 'cloud', sourceId: 'cloud-chat-1', sourceVersion: 'cloud-v3', recordType: 'chat', recordId: RECORD_ID, schemaVersion: 1, value: harness.value, assetIds: ['asset-private'] },
        { source: 'cloud', sourceId: 'shared-late', sourceVersion: 'cloud-v1', recordType: 'chat', recordId: RECORD_ID, schemaVersion: 1, value: harness.value, assetIds: ['asset-private'] },
      ]);
    });
    await assert.rejects(migration.run(), /inventory changed/i);
    assert.equal(harness.localCleanup, 0);
  });

  test('rejects wrong or stale encrypted-export bindings', async (t) => {
    const harness = await createHarness(t);
    harness.setExportConfirmed(false);
    const migration = harness.create();
    await assert.rejects(migration.run(), /encrypted export/i);
    const binding = await migration.getEncryptedExportBinding();
    const confirmation = { ...binding, exportDigest: 'e'.repeat(64) };
    await migration.registerEncryptedExport(confirmation);
    await assert.rejects(migration.confirmEncryptedExport({ ...binding, inventoryDigest: 'f'.repeat(64), exportDigest: 'e'.repeat(64) }), /binding|digest/i);
    await assert.rejects(migration.confirmEncryptedExport({ ...binding, migrationId: 'wrong', exportDigest: 'e'.repeat(64) }), /binding|migration/i);
    await assert.rejects(migration.confirmEncryptedExport({ ...binding, exportDigest: 'd'.repeat(64) }), /binding|digest/i);
    assert.equal(harness.localCleanup, 0);
  });

  test('does not enter destructive phases unless the server migration commit succeeds', async (t) => {
    const harness = await createHarness(t);
    const db = createDB(t);
    const masterKey = await importVaultMasterKey(generateVaultMasterKeyBytes());
    const serializer = new TestSerializer();
    const value = harness.value;
    const blocked = createPrivateProVaultMigration({
      uid: UID, migrationId: 'server-gate', keyVersion: 1, masterKey, db, serializers: [serializer],
      inventory: {
        listLocal: async () => [{ source: 'local', sourceId: 'local', sourceVersion: '1', recordType: 'chat', recordId: RECORD_ID, schemaVersion: 1, value }],
        listCloud: async () => [],
        currentVersion: async () => '1',
      },
      records: {
        upload: async operation => ({ status: 'committed' as const, revision: operation.kind === 'put' ? operation.envelope.revision : 1 }),
        download: async recordIds => (await db.listEncryptedRecords(UID)).filter(envelope => recordIds.includes(envelope.recordId)),
      },
      assets: { describe: async () => [], prepareForUpload: async () => {}, verifyCloud: async () => {} },
      server: { commit: async () => ({ status: 'conflict' as const, currentPhase: 'inventory' as const }) },
      exportGate: { getConfirmation: async binding => ({ ...binding, exportDigest: 'e'.repeat(64) }) },
      cleanup: { local: async () => assert.fail('local cleanup must remain gated'), cloud: async () => assert.fail('cloud cleanup must remain gated') },
      collectAssetIds: () => [], createOperationId: purpose => `gate-${purpose}`,
    });

    await assert.rejects(blocked.run(), /server journal conflicts/i);
  });

  test('keeps account journals isolated and serialized without plaintext leakage', async (t) => {
    const harness = await createHarness(t);
    await harness.create().run();
    await harness.db.migration.put({ uid: OTHER_UID, migrationId: MIGRATION_ID, phase: 'inventory', revision: 1, updatedAtMs: 2_000 });

    const own = await harness.db.migration.get([UID, MIGRATION_ID]);
    const other = await harness.db.migration.get([OTHER_UID, MIGRATION_ID]);
    assert.equal(other?.phase, 'inventory');
    assert.ok(own);
    const serialized = JSON.stringify(own);
    for (const forbidden of ['private migration text', 'chat-1', 'sentinel-asset-name-never-in-ciphertext-metadata-918273645', 'password', 'masterKey', 'raw error'])
      assert.equal(serialized.includes(forbidden), false, forbidden);
  });

  test('aborts without cleanup and cannot repopulate after stop', async (t) => {
    const harness = await createHarness(t);
    const migration = harness.create();
    migration.subscribe(progress => {
      if (progress.phase === 'encrypt-local') migration.stop();
    });

    await assert.rejects(migration.run(), /cancelled/i);
    await migration.stopAndWait();
    const phase = migration.getProgress().phase;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(migration.getProgress().phase, phase);
    assert.equal(harness.localCleanup, 0);
    assert.equal(harness.cloudCleanup, 0);
  });

  test('verifies canonical portable records and referenced assets before cleanup', async (t) => {
    const harness = await createHarness(t);
    await harness.create().run();
    assert.ok(harness.uploaded);
    assert.equal(harness.localCleanup, 1);
  });

  test('lifecycle blocks normal vault readiness until migration completes and exposes retry progress', async () => {
    const phases: string[] = [];
    let attempts = 0;
    let stopped = 0;
    const migration = {
      getProgress: () => ({ phase: 'upload' as const, revision: 2, completedItems: 1, totalItems: 2, error: null }),
      subscribe: (listener: (progress: { phase: 'upload'; revision: number; completedItems: number; totalItems: number; error: null }) => void) => {
        listener({ phase: 'upload', revision: 2, completedItems: 1, totalItems: 2, error: null });
        return () => {};
      },
      async run() {
        attempts++;
        if (attempts === 1) throw new Error('temporary migration failure');
      },
      async getEncryptedExportBinding() { return { migrationId: 'test', inventoryDigest: 'a'.repeat(64) }; },
      async registerEncryptedExport() {},
      async confirmEncryptedExport() {},
      stop() { stopped++; },
      async stopAndWait() { stopped++; },
    };
    let engineStarted = 0;
    const lifecycle = createPrivateProVaultMigrationLifecycle({
      migration,
      startEngine: async () => { engineStarted++; },
      onProgress: progress => phases.push(`${progress.phase}:${progress.error ?? 'ok'}`),
    });

    await assert.rejects(lifecycle.start(), /temporary migration failure/);
    assert.equal(engineStarted, 0);
    await lifecycle.retry();
    assert.equal(engineStarted, 1);
    assert.equal(phases.some(phase => phase.startsWith('upload:')), true);
    lifecycle.stop();
    assert.equal(stopped, 1);
  });

  test('renders resumable migration progress with retry and export actions', () => {
    const markup = renderPrivateProVaultMigrationProgress({
      phase: 'commit', revision: 7, completedItems: 4, totalItems: 6, error: 'Encrypted vault migration needs attention.',
    });

    assert.match(markup, /Commit encrypted migration/);
    assert.match(markup, /4 of 6/);
    assert.match(markup, /Retry migration/);
    assert.match(markup, /Create encrypted export/);
  });

  test('provider activation starts the vault engine only after migration completes', async () => {
    const order: string[] = [];
    const runtime = {
      engine: null,
      keyset: null,
      masterKey: null,
      devices: [],
      assets: null,
      migration: null,
    };
    const { activatePrivateProVaultRuntime } = await import('./ProviderPrivateProVault');

    await activatePrivateProVaultRuntime(runtime, {
      createMigration: () => ({
        getProgress: () => ({ phase: 'inventory' as const, revision: 0, completedItems: 0, totalItems: 1, error: null }),
        subscribe: () => () => {},
        run: async () => { order.push('migration'); },
        getEncryptedExportBinding: async () => ({ migrationId: 'test', inventoryDigest: 'a'.repeat(64) }),
        registerEncryptedExport: async () => {},
        confirmEncryptedExport: async () => {},
        stop: () => {},
        stopAndWait: async () => {},
      }),
      createEngine: () => ({
        hydrateBeforeOpen: async () => { order.push('hydrate'); },
        start: async () => { order.push('start'); },
        stop: () => {},
        stopAndWait: async () => {},
        whenCurrent: async () => {},
        logoutAndClear: async () => {},
      }),
      onMigrationProgress: () => {},
    });

    assert.deepEqual(order, ['migration', 'hydrate', 'start']);
  });

  test('provider activation joins a failed migration before returning', async () => {
    const order: string[] = [];
    const runtime = { engine: null, keyset: null, masterKey: null, devices: [], assets: null, migration: null };
    const { activatePrivateProVaultRuntime } = await import('./ProviderPrivateProVault');
    await assert.rejects(activatePrivateProVaultRuntime(runtime, {
      createMigration: () => ({
        getProgress: () => ({ phase: 'upload' as const, revision: 1, completedItems: 0, totalItems: 1, error: null }),
        subscribe: () => () => {},
        run: async () => { order.push('run'); throw new Error('injected activation failure'); },
        getEncryptedExportBinding: async () => ({ migrationId: 'test', inventoryDigest: 'a'.repeat(64) }),
        registerEncryptedExport: async () => {}, confirmEncryptedExport: async () => {}, stop: () => {},
        stopAndWait: async () => { order.push('stop'); },
      }),
      createEngine: () => assert.fail('engine must not start'),
      onMigrationProgress: () => {},
    }), /activation failure/);
    assert.deepEqual(order, ['run', 'stop']);
  });

  test('provider teardown joins an in-flight migration and suppresses stale progress', async () => {
    const order: string[] = [];
    let publishStaleProgress = () => {};
    let releaseRun: (() => void) | null = null;
    const runtime = { engine: null, keyset: null, masterKey: null, devices: [], assets: null, migration: null };
    const { activatePrivateProVaultRuntime, stopPrivateProVaultMigrationActivation } = await import('./ProviderPrivateProVault');
    const activation = activatePrivateProVaultRuntime(runtime, {
      createMigration: () => ({
        getProgress: () => ({ phase: 'upload' as const, revision: 1, completedItems: 0, totalItems: 1, error: null }),
        subscribe: callback => {
          publishStaleProgress = () => callback({ phase: 'upload', revision: 2, completedItems: 0, totalItems: 1, error: null });
          return () => { publishStaleProgress = () => {}; };
        },
        run: () => new Promise<void>(resolve => { releaseRun = resolve; }),
        getEncryptedExportBinding: async () => ({ migrationId: 'test', inventoryDigest: 'a'.repeat(64) }),
        registerEncryptedExport: async () => {}, confirmEncryptedExport: async () => {}, stop: () => {},
        stopAndWait: async () => { order.push('stop'); releaseRun?.(); },
      }),
      createEngine: () => assert.fail('engine must not start after teardown'),
      onMigrationProgress: () => order.push('progress'),
    });
    const cancelled = assert.rejects(
      activation,
      error => error instanceof DOMException && error.name === 'AbortError',
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    await stopPrivateProVaultMigrationActivation(runtime);
    publishStaleProgress();
    await cancelled;
    assert.deepEqual(order, ['stop']);
  });
});
