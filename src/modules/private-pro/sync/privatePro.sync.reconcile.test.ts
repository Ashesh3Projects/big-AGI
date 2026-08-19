import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import Dexie from 'dexie';
import * as z from 'zod/v4';

import { privateProCanonicalJson, privateProContentHash, privateProRecordKey } from './privatePro.sync.codec';
import { PrivateProSyncDB } from './privatePro.sync.db';
import {
  createPrivateProSyncReconciler,
  type PrivateProSyncLocalOrigin,
} from './privatePro.sync.reconcile';
import type {
  PrivateProSyncProjection,
  PrivateProSyncSerializedRecord,
  PrivateProSyncSerializer,
} from './privatePro.sync.serializers';
import type { PrivateProSyncRemoteRecord } from './privatePro.sync.transport';


const UID = 'uid-1';
const WRITER_ID = '123e4567-e89b-12d3-a456-426614174001';
const OTHER_WRITER_ID = '123e4567-e89b-12d3-a456-426614174002';
const MUTATION_ID = '123e4567-e89b-12d3-a456-426614174003';

const SettingsSchema = z.object({ id: z.string(), value: z.string() }).strict();

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolve_ => { resolve = resolve_; });
  return { promise, resolve };
}

interface ProjectionCall {
  kind: 'apply' | 'remove';
  projectionKey: string;
  records: readonly PrivateProSyncSerializedRecord[];
  suppressed: boolean;
}

function createDB(t: TestContext): PrivateProSyncDB {
  const name = `private-pro-reconcile-test-${crypto.randomUUID()}`;
  const db = new PrivateProSyncDB(name);
  t.after(async () => {
    db.close();
    await Dexie.delete(name);
  });
  return db;
}

function serializer(recordType: 'settings' | 'chat-meta' | 'chat-message', calls: ProjectionCall[], suppression: { active: boolean }): PrivateProSyncSerializer<unknown> {
  const projection: PrivateProSyncProjection = {
    apply: async (projectionKey, records) => { calls.push({ kind: 'apply', projectionKey, records: structuredClone(records), suppressed: suppression.active }); },
    remove: async projectionKey => { calls.push({ kind: 'remove', projectionKey, records: [], suppressed: suppression.active }); },
  };
  return {
    recordType,
    schemaVersion: 1,
    conflictPolicy: recordType === 'settings' ? 'replace' : 'message-identity',
    snapshot: async () => [],
    validate: async (logicalId, input) => {
      if (recordType === 'settings') {
        const value = SettingsSchema.parse(input);
        if (value.id !== logicalId) throw new TypeError('identity');
        return value;
      }
      const value = z.object({ conversationId: z.string(), created: z.number().optional(), id: z.string().optional(), value: z.string().optional() }).strict().parse(input);
      return value;
    },
    project: (logicalId, value) => ({
      projectionKey: recordType === 'settings' ? logicalId : (value as { conversationId: string }).conversationId,
      referencedAssetIds: [],
    }),
    projection,
    subscribe: () => () => {},
  };
}

async function remoteRecord(options: {
  recordType?: 'settings' | 'chat-meta' | 'chat-message';
  logicalId?: string;
  value?: unknown;
  revision?: number;
  mutationId?: string;
  writerId?: string;
} = {}): Promise<PrivateProSyncRemoteRecord> {
  const recordType = options.recordType ?? 'settings';
  const logicalId = options.logicalId ?? 'settings-1';
  const value = options.value ?? { id: logicalId, value: 'remote' };
  const payload = privateProCanonicalJson(value);
  return {
    recordKey: privateProRecordKey(recordType, logicalId),
    recordType,
    logicalId,
    schemaVersion: 1,
    payload,
    contentHash: await privateProContentHash(payload),
    revision: options.revision ?? 1,
    mutationId: options.mutationId ?? MUTATION_ID,
    writerId: options.writerId ?? OTHER_WRITER_ID,
    deleted: false,
    updatedAt: 'server-time',
  };
}

function createHarness(t: TestContext) {
  const db = createDB(t);
  const calls: ProjectionCall[] = [];
  const suppression = { active: false };
  const localOrigins = new Map<string, PrivateProSyncLocalOrigin>();
  const committed: Array<{ mutationId: string; revision: number }> = [];
  const serializers = [
    serializer('settings', calls, suppression),
    serializer('chat-meta', calls, suppression),
    serializer('chat-message', calls, suppression),
  ];
  const reconciler = createPrivateProSyncReconciler({
    uid: UID,
    writerId: WRITER_ID,
    serializers,
    db,
    localOrigins,
    outbound: { handleCommitted: async (mutationId, revision) => { committed.push({ mutationId, revision }); } },
    runSuppressed: async (_projectionKey, callback) => {
      suppression.active = true;
      try { return await callback(); }
      finally { suppression.active = false; }
    },
    now: () => 9_000,
  });
  return { db, calls, localOrigins, committed, reconciler };
}

describe('Private Pro sync reconciler', () => {
  test('aborted remote validation cannot mutate local records, outbox, or remote bases', async (t) => {
    const db = createDB(t);
    const calls: ProjectionCall[] = [];
    const suppression = { active: false };
    const validationStarted = deferred<void>();
    const releaseValidation = deferred<void>();
    const settings = serializer('settings', calls, suppression);
    settings.validate = async (logicalId, input) => {
      validationStarted.resolve();
      await releaseValidation.promise;
      const value = SettingsSchema.parse(input);
      if (value.id !== logicalId) throw new TypeError('identity');
      return value;
    };
    const reconciler = createPrivateProSyncReconciler({
      uid: UID,
      writerId: WRITER_ID,
      serializers: [settings],
      db,
      localOrigins: new Map(),
      outbound: { handleCommitted: async () => {} },
      runSuppressed: async (_projectionKey, callback) => callback(),
      now: () => 9_000,
    });
    const canonical = await remoteRecord();
    const controller = new AbortController();
    const handling = reconciler.handle({ type: 'record', canonical }, 1, controller.signal);
    await validationStarted.promise;

    controller.abort();
    releaseValidation.resolve();
    await handling;

    assert.equal(await db.getLocalRecord(UID, canonical.recordKey), null);
    assert.equal(await db.getOutbox(UID, canonical.recordKey), null);
    assert.equal(await db.getRemoteBase(UID, canonical.recordKey), null);
    assert.deepEqual(calls, []);
  });

  test('applies cached records under suppression', async (t) => {
    const { db, calls, reconciler } = createHarness(t);
    await db.commitRemoteRecord(UID, {
      recordType: 'settings', logicalId: 'settings-1', recordKey: privateProRecordKey('settings', 'settings-1'), projectionKey: 'settings-1', schemaVersion: 1,
      payload: '{"id":"settings-1","value":"cached"}', contentHash: 'a'.repeat(64), referencedAssetIds: [],
    }, { revision: 1, mutationId: MUTATION_ID, deleted: false }, 1_000);

    await reconciler.applyCached();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].suppressed, true);
    assert.equal((calls[0].records[0].value as { value: string }).value, 'cached');
  });

  test('does not overwrite an edit captured before cache hydration', async (t) => {
    const { db, calls, localOrigins, reconciler } = createHarness(t);
    const recordKey = privateProRecordKey('settings', 'settings-1');
    await db.commitRemoteRecord(UID, {
      recordType: 'settings', logicalId: 'settings-1', recordKey, projectionKey: 'settings-1', schemaVersion: 1,
      payload: '{"id":"settings-1","value":"cached"}', contentHash: 'a'.repeat(64), referencedAssetIds: [],
    }, { revision: 1, mutationId: MUTATION_ID, deleted: false }, 1_000);
    localOrigins.set(recordKey, { captureId: crypto.randomUUID(), projectionKey: 'settings-1', editVersion: 1, generation: null, mutationId: null, dirty: true });

    await reconciler.applyCached();

    assert.equal(calls.length, 0);
  });

  test('persists and applies a committed remote record when this tab has no newer origin', async (t) => {
    const { db, calls, reconciler } = createHarness(t);
    const canonical = await remoteRecord();

    await reconciler.handle({ type: 'record', canonical });

    assert.equal((await db.getRemoteBase(UID, canonical.recordKey))?.revision, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].suppressed, true);
  });

  test('updates the durable base but not runtime when a newer local origin exists', async (t) => {
    const { db, calls, localOrigins, reconciler } = createHarness(t);
    const canonical = await remoteRecord({ revision: 2 });
    localOrigins.set(canonical.recordKey, { captureId: crypto.randomUUID(), projectionKey: 'settings-1', editVersion: 2, generation: 3, mutationId: crypto.randomUUID(), dirty: true });

    await reconciler.handle({ type: 'record', canonical });

    assert.equal((await db.getRemoteBase(UID, canonical.recordKey))?.revision, 2);
    assert.equal(calls.length, 0);
  });

  test('ignores a stale lower-revision record without rematerializing runtime', async (t) => {
    const { calls, reconciler } = createHarness(t);
    await reconciler.handle({ type: 'record', canonical: await remoteRecord({ revision: 2, value: { id: 'settings-1', value: 'newer' } }) });
    calls.length = 0;

    await reconciler.handle({ type: 'record', canonical: await remoteRecord({ revision: 1, value: { id: 'settings-1', value: 'older' }, mutationId: crypto.randomUUID() }) });

    assert.equal(calls.length, 0);
  });

  test('acknowledges a same-tab committed mutation without applying its snapshot', async (t) => {
    const { calls, localOrigins, committed, reconciler } = createHarness(t);
    const canonical = await remoteRecord({ writerId: WRITER_ID });
    localOrigins.set(canonical.recordKey, { captureId: crypto.randomUUID(), projectionKey: 'settings-1', editVersion: 1, generation: 1, mutationId: canonical.mutationId, dirty: true });

    await reconciler.handle({ type: 'record', canonical });

    assert.deepEqual(committed, [{ mutationId: canonical.mutationId, revision: 1 }]);
    assert.equal(calls.length, 0);
    assert.equal(localOrigins.has(canonical.recordKey), false);
  });

  test('applies the same committed mutation in a sibling tab with no local origin', async (t) => {
    const { calls, reconciler } = createHarness(t);
    const canonical = await remoteRecord({ writerId: WRITER_ID });

    await reconciler.handle({ type: 'record', canonical });

    assert.equal(calls.length, 1);
  });

  test('applies remote canonical data in a sibling tab even while shared Dexie has pending work', async (t) => {
    const { db, calls, reconciler } = createHarness(t);
    const canonical = await remoteRecord({ value: { id: 'settings-1', value: 'remote' } });
    await db.recordLocalPut(UID, {
      recordType: 'settings', logicalId: 'settings-1', recordKey: canonical.recordKey, projectionKey: 'settings-1', schemaVersion: 1,
      payload: '{"id":"settings-1","value":"sibling-local"}', contentHash: 'a'.repeat(64), referencedAssetIds: [],
    }, 1_000);

    await reconciler.handle({ type: 'record', canonical });

    assert.equal((calls[0].records[0].value as { value: string }).value, 'remote');
    assert.equal((await db.getOutbox(UID, canonical.recordKey))?.payload, '{"id":"settings-1","value":"sibling-local"}');
  });

  test('does not let delayed cache hydration overwrite an already-applied remote record', async (t) => {
    const { db, calls, reconciler } = createHarness(t);
    const canonical = await remoteRecord({ value: { id: 'settings-1', value: 'remote' } });
    await db.recordLocalPut(UID, {
      recordType: 'settings', logicalId: 'settings-1', recordKey: canonical.recordKey, projectionKey: 'settings-1', schemaVersion: 1,
      payload: '{"id":"settings-1","value":"cached-local"}', contentHash: 'a'.repeat(64), referencedAssetIds: [],
    }, 1_000);
    const listProjectionRecords = db.listProjectionRecords.bind(db);
    let releaseCache!: () => void;
    let cacheReadStarted!: () => void;
    const cacheStarted = new Promise<void>(resolve => { cacheReadStarted = resolve; });
    const cacheGate = new Promise<void>(resolve => { releaseCache = resolve; });
    let projectionReads = 0;
    db.listProjectionRecords = async (uid, projectionKey) => {
      projectionReads++;
      if (projectionReads === 1) {
        cacheReadStarted();
        await cacheGate;
      }
      return listProjectionRecords(uid, projectionKey);
    };

    const cache = reconciler.applyCached();
    await cacheStarted;
    await reconciler.handle({ type: 'record', canonical });
    releaseCache();
    await cache;

    assert.equal((calls.at(-1)?.records[0].value as { value: string }).value, 'remote');
  });

  test('a local edit during a remote projection read prevents the apply', async (t) => {
    const { db, calls, localOrigins, reconciler } = createHarness(t);
    const canonical = await remoteRecord();
    const listProjectionRecords = db.listProjectionRecords.bind(db);
    let release!: () => void;
    let started!: () => void;
    const readStarted = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    db.listProjectionRecords = async (uid, projectionKey) => {
      started();
      await gate;
      return listProjectionRecords(uid, projectionKey);
    };

    const handling = reconciler.handle({ type: 'record', canonical });
    await readStarted;
    localOrigins.set(canonical.recordKey, { captureId: crypto.randomUUID(), projectionKey: 'settings-1', editVersion: 1, generation: null, mutationId: null, dirty: true });
    release();
    await handling;

    assert.equal(calls.length, 0);
  });

  test('a local edit during remote DB commit prevents the later projection apply', async (t) => {
    const db = createDB(t);
    const calls: ProjectionCall[] = [];
    const suppression = { active: false };
    const localOrigins = new Map<string, PrivateProSyncLocalOrigin>();
    const projectionVersions = new Map<string, number>();
    const canonical = await remoteRecord();
    const commitRemoteRecord = db.commitRemoteRecord.bind(db);
    let release!: () => void;
    let started!: () => void;
    const commitStarted = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    db.commitRemoteRecord = async (...args) => {
      started();
      await gate;
      return commitRemoteRecord(...args);
    };
    const reconciler = createPrivateProSyncReconciler({
      uid: UID, writerId: WRITER_ID, serializers: [serializer('settings', calls, suppression)], db,
      localOrigins, projectionVersions, outbound: { handleCommitted: async () => {} },
      runSuppressed: async (_projectionKey, callback) => callback(), now: () => 9_000,
    });

    const handling = reconciler.handle({ type: 'record', canonical });
    await commitStarted;
    projectionVersions.set('settings-1', 1);
    localOrigins.set(canonical.recordKey, { captureId: crypto.randomUUID(), projectionKey: 'settings-1', editVersion: 1, generation: null, mutationId: null, dirty: true });
    release();
    await handling;

    assert.equal(calls.length, 0);
  });

  test('a local edit during the initial cache list prevents hydration apply', async (t) => {
    const db = createDB(t);
    const calls: ProjectionCall[] = [];
    const suppression = { active: false };
    const localOrigins = new Map<string, PrivateProSyncLocalOrigin>();
    const projectionVersions = new Map<string, number>();
    const recordKey = privateProRecordKey('settings', 'settings-1');
    await db.commitRemoteRecord(UID, {
      recordType: 'settings', logicalId: 'settings-1', recordKey, projectionKey: 'settings-1', schemaVersion: 1,
      payload: '{"id":"settings-1","value":"cached"}', contentHash: 'a'.repeat(64), referencedAssetIds: [],
    }, { revision: 1, mutationId: MUTATION_ID, deleted: false }, 1_000);
    const listLocalRecords = db.listLocalRecords.bind(db);
    let release!: () => void;
    let started!: () => void;
    const listStarted = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    db.listLocalRecords = async uid => {
      started();
      await gate;
      return listLocalRecords(uid);
    };
    const reconciler = createPrivateProSyncReconciler({
      uid: UID, writerId: WRITER_ID, serializers: [serializer('settings', calls, suppression)], db,
      localOrigins, projectionVersions, outbound: { handleCommitted: async () => {} },
      runSuppressed: async (_projectionKey, callback) => callback(), now: () => 9_000,
    });

    const hydration = reconciler.applyCached();
    await listStarted;
    projectionVersions.set('settings-1', 1);
    localOrigins.set(recordKey, { captureId: crypto.randomUUID(), projectionKey: 'settings-1', editVersion: 1, generation: null, mutationId: null, dirty: true });
    release();
    await hydration;

    assert.equal(calls.length, 0);
  });

  test('quarantines a sanitized invalid-document event by record key', async (t) => {
    const { db, reconciler } = createHarness(t);

    await reconciler.handle({ type: 'invalid-document', collection: 'records', recordKey: 'bad-key', reason: 'invalid-document' });

    assert.deepEqual(await db.quarantine.where('uid').equals(UID).toArray(), [{
      id: 1, uid: UID, recordKey: 'bad-key', reasonCode: 'invalid-document', createdAtMs: 9_000,
    }]);
  });

  test('an exact synthetic commit marker suppresses its listener but a higher revision applies', async (t) => {
    const db = createDB(t);
    const calls: ProjectionCall[] = [];
    const suppression = { active: false };
    const committedMarkers = new Map();
    const mutationId = crypto.randomUUID();
    const recordKey = privateProRecordKey('settings', 'settings-1');
    committedMarkers.set(recordKey, { recordKey, generation: 1, mutationId, revision: 1, deleted: false });
    const reconciler = createPrivateProSyncReconciler({
      uid: UID, writerId: WRITER_ID, serializers: [serializer('settings', calls, suppression)], db,
      localOrigins: new Map(), committedMarkers, outbound: { handleCommitted: async () => {} },
      runSuppressed: async (_projectionKey, callback) => callback(), now: () => 9_000,
    });

    await reconciler.handle({ type: 'record', canonical: await remoteRecord({ writerId: WRITER_ID, mutationId, revision: 1 }) });
    await reconciler.handle({ type: 'record', canonical: await remoteRecord({ writerId: WRITER_ID, mutationId: crypto.randomUUID(), revision: 2, value: { id: 'settings-1', value: 'newer' } }) });

    assert.equal(calls.length, 1);
    assert.equal((calls[0].records[0].value as { value: string }).value, 'newer');
  });

  test('deleted canonical records before or after tombstones are idempotent and never quarantined', async (t) => {
    const { db, calls, reconciler } = createHarness(t);
    const live = await remoteRecord();
    await reconciler.handle({ type: 'record', canonical: live });
    calls.length = 0;
    const deleted = { ...live, payload: '', contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', revision: 2, mutationId: crypto.randomUUID(), deleted: true };
    const tombstone = {
      recordKey: live.recordKey, recordType: live.recordType, logicalId: live.logicalId,
      deletedRevision: 2, mutationId: deleted.mutationId, writerId: deleted.writerId, deletedAt: 'server-time',
    };

    await reconciler.handle({ type: 'record', canonical: deleted });
    await reconciler.handle({ type: 'tombstone', tombstone });
    await reconciler.handle({ type: 'record', canonical: deleted });

    assert.equal((await db.quarantine.where('uid').equals(UID).count()), 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'remove');
  });

  test('deleted canonical observation does not protect a pre-delete pending put from its tombstone', async (t) => {
    const { db, reconciler } = createHarness(t);
    const live = await remoteRecord();
    await reconciler.handle({ type: 'record', canonical: live });
    const pending = await db.recordLocalPut(UID, {
      recordType: 'settings', logicalId: live.logicalId, recordKey: live.recordKey, projectionKey: live.logicalId, schemaVersion: 1,
      payload: '{"id":"settings-1","value":"stale-put"}', contentHash: 'a'.repeat(64), referencedAssetIds: [],
    }, 2_000);
    await db.localRecords.update([UID, pending.recordKey], { baseRevision: 1 });
    await db.outbox.update([UID, pending.recordKey], { baseRevision: 1 });
    const mutationId = crypto.randomUUID();

    await reconciler.handle({ type: 'record', canonical: {
      ...live, payload: '', contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      revision: 2, mutationId, deleted: true,
    } });
    await reconciler.handle({ type: 'tombstone', tombstone: {
      recordKey: live.recordKey, recordType: live.recordType, logicalId: live.logicalId,
      deletedRevision: 2, mutationId, writerId: live.writerId, deletedAt: 'server-time',
    } });

    assert.equal(await db.getLocalRecord(UID, live.recordKey), null);
    assert.equal(await db.getOutbox(UID, live.recordKey), null);
    assert.deepEqual(await db.getRemoteBase(UID, live.recordKey), { revision: 2, mutationId, deleted: true });
    await reconciler.handle({ type: 'record', canonical: live });
    assert.deepEqual(await db.getRemoteBase(UID, live.recordKey), { revision: 2, mutationId, deleted: true });
  });

  test('an exact synthetic delete marker suppresses tombstone removal and a higher tombstone proceeds', async (t) => {
    const db = createDB(t);
    const calls: ProjectionCall[] = [];
    const suppression = { active: false };
    const mutationId = crypto.randomUUID();
    const recordKey = privateProRecordKey('settings', 'settings-1');
    const committedMarkers = new Map([[recordKey, { recordKey, generation: 1, mutationId, revision: 2, deleted: true }]]);
    const reconciler = createPrivateProSyncReconciler({
      uid: UID, writerId: WRITER_ID, serializers: [serializer('settings', calls, suppression)], db,
      localOrigins: new Map(), committedMarkers, outbound: { handleCommitted: async () => {} },
      runSuppressed: async (_projectionKey, callback) => callback(), now: () => 9_000,
    });

    await reconciler.handle({ type: 'tombstone', tombstone: {
      recordKey, recordType: 'settings', logicalId: 'settings-1', deletedRevision: 2,
      mutationId, writerId: WRITER_ID, deletedAt: 'server-time',
    } });
    assert.equal(calls.length, 0);
    await reconciler.handle({ type: 'tombstone', tombstone: {
      recordKey, recordType: 'settings', logicalId: 'settings-1', deletedRevision: 3,
      mutationId: crypto.randomUUID(), writerId: WRITER_ID, deletedAt: 'server-time',
    } });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'remove');
  });

  test('stages chat messages until metadata exists and keeps two message IDs sorted', async (t) => {
    const { calls, reconciler } = createHarness(t);
    const second = await remoteRecord({ recordType: 'chat-message', logicalId: 'chat-1\0message-2', value: { conversationId: 'chat-1', id: 'message-2', created: 20, value: 'second' } });
    const first = await remoteRecord({ recordType: 'chat-message', logicalId: 'chat-1\0message-1', value: { conversationId: 'chat-1', id: 'message-1', created: 10, value: 'first' }, mutationId: crypto.randomUUID() });
    const meta = await remoteRecord({ recordType: 'chat-meta', logicalId: 'chat-1', value: { conversationId: 'chat-1' }, mutationId: crypto.randomUUID() });

    await reconciler.handle({ type: 'record', canonical: second });
    await reconciler.handle({ type: 'record', canonical: first });
    assert.equal(calls.length, 0);
    await reconciler.handle({ type: 'record', canonical: meta });

    assert.deepEqual(calls[0].records.map(record => record.logicalId), ['chat-1', 'chat-1\0message-1', 'chat-1\0message-2']);
  });

  test('persists a tombstone, discards stale pending work, and removes its projection', async (t) => {
    const { db, calls, reconciler } = createHarness(t);
    const canonical = await remoteRecord();
    await reconciler.handle({ type: 'record', canonical });
    calls.length = 0;

    await reconciler.handle({ type: 'tombstone', tombstone: {
      recordKey: canonical.recordKey, recordType: canonical.recordType, logicalId: canonical.logicalId,
      deletedRevision: 2, mutationId: crypto.randomUUID(), writerId: OTHER_WRITER_ID, deletedAt: 'server-time',
    } });

    assert.equal((await db.getRemoteBase(UID, canonical.recordKey))?.deleted, true);
    assert.equal(calls[0].kind, 'remove');
    assert.equal(calls[0].suppressed, true);
  });

  test('does not remove runtime for a tombstone when this tab has a newer local origin', async (t) => {
    const { calls, localOrigins, reconciler } = createHarness(t);
    const canonical = await remoteRecord();
    await reconciler.handle({ type: 'record', canonical });
    calls.length = 0;
    localOrigins.set(canonical.recordKey, { captureId: crypto.randomUUID(), projectionKey: 'settings-1', editVersion: 2, generation: 2, mutationId: crypto.randomUUID(), dirty: true });

    await reconciler.handle({ type: 'tombstone', tombstone: {
      recordKey: canonical.recordKey, recordType: canonical.recordType, logicalId: canonical.logicalId,
      deletedRevision: 2, mutationId: crypto.randomUUID(), writerId: OTHER_WRITER_ID, deletedAt: 'server-time',
    } });

    assert.equal(calls.length, 0);
  });

  test('a local edit during tombstone persistence prevents runtime removal', async (t) => {
    const db = createDB(t);
    const calls: ProjectionCall[] = [];
    const suppression = { active: false };
    const localOrigins = new Map<string, PrivateProSyncLocalOrigin>();
    const projectionVersions = new Map<string, number>();
    const canonical = await remoteRecord();
    const reconciler = createPrivateProSyncReconciler({
      uid: UID, writerId: WRITER_ID, serializers: [serializer('settings', calls, suppression)], db,
      localOrigins, projectionVersions, outbound: { handleCommitted: async () => {} },
      runSuppressed: async (_projectionKey, callback) => callback(), now: () => 9_000,
    });
    await reconciler.handle({ type: 'record', canonical });
    calls.length = 0;
    const commitRemoteTombstone = db.commitRemoteTombstone.bind(db);
    let release!: () => void;
    let started!: () => void;
    const commitStarted = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    db.commitRemoteTombstone = async (...args) => {
      started();
      await gate;
      return commitRemoteTombstone(...args);
    };
    const handling = reconciler.handle({ type: 'tombstone', tombstone: {
      recordKey: canonical.recordKey, recordType: canonical.recordType, logicalId: canonical.logicalId,
      deletedRevision: 2, mutationId: crypto.randomUUID(), writerId: OTHER_WRITER_ID, deletedAt: 'server-time',
    } });
    await commitStarted;
    projectionVersions.set('settings-1', 2);
    localOrigins.set(canonical.recordKey, { captureId: crypto.randomUUID(), projectionKey: 'settings-1', editVersion: 2, generation: null, mutationId: null, dirty: true });
    release();
    await handling;

    assert.equal(calls.length, 0);
  });

  test('removes runtime for a sibling-tab tombstone while preserving post-tombstone shared pending work', async (t) => {
    const { db, calls, reconciler } = createHarness(t);
    const canonical = await remoteRecord();
    await reconciler.handle({ type: 'record', canonical });
    calls.length = 0;
    await db.recordLocalPut(UID, {
      recordType: 'settings', logicalId: canonical.logicalId, recordKey: canonical.recordKey, projectionKey: canonical.logicalId, schemaVersion: 1,
      payload: '{"id":"settings-1","value":"sibling-local"}', contentHash: 'a'.repeat(64), referencedAssetIds: [],
    }, 2_000);
    await db.localRecords.update([UID, canonical.recordKey], { baseRevision: 2 });
    await db.outbox.update([UID, canonical.recordKey], { baseRevision: 2 });

    await reconciler.handle({ type: 'tombstone', tombstone: {
      recordKey: canonical.recordKey, recordType: canonical.recordType, logicalId: canonical.logicalId,
      deletedRevision: 2, mutationId: crypto.randomUUID(), writerId: OTHER_WRITER_ID, deletedAt: 'server-time',
    } });

    assert.equal(calls[0].kind, 'remove');
    assert.equal((await db.getOutbox(UID, canonical.recordKey))?.payload, '{"id":"settings-1","value":"sibling-local"}');
  });

  test('removes a chat projection when its metadata tombstone arrives', async (t) => {
    const { calls, reconciler } = createHarness(t);
    const meta = await remoteRecord({ recordType: 'chat-meta', logicalId: 'chat-1', value: { conversationId: 'chat-1' } });
    await reconciler.handle({ type: 'record', canonical: meta });
    calls.length = 0;

    await reconciler.handle({ type: 'tombstone', tombstone: {
      recordKey: meta.recordKey, recordType: meta.recordType, logicalId: meta.logicalId,
      deletedRevision: 2, mutationId: crypto.randomUUID(), writerId: OTHER_WRITER_ID, deletedAt: 'server-time',
    } });

    assert.equal(calls[0].kind, 'remove');
    assert.equal(calls[0].projectionKey, 'chat-1');
  });

  test('quarantines a same-message-ID collision and invalid payload without retaining payload text', async (t) => {
    const { db, calls, reconciler } = createHarness(t);
    const first = await remoteRecord({ recordType: 'chat-message', logicalId: 'chat-1\0message-1', value: { conversationId: 'chat-1', id: 'message-1', created: 10, value: 'first' } });
    await reconciler.handle({ type: 'record', canonical: first });
    const collision = await remoteRecord({ recordType: 'chat-message', logicalId: first.logicalId, value: { conversationId: 'chat-1', id: 'message-1', created: 10, value: 'SECRET' }, revision: 2, mutationId: crypto.randomUUID() });
    await reconciler.handle({ type: 'record', canonical: collision });
    await reconciler.handle({ type: 'record', canonical: { ...collision, recordKey: privateProRecordKey('chat-message', 'bad'), logicalId: 'bad', payload: 'SECRET invalid json', mutationId: crypto.randomUUID() } });

    assert.equal(calls.length, 0);
    const quarantine = await db.quarantine.where('uid').equals(UID).toArray();
    assert.deepEqual(quarantine.map(item => item.reasonCode), ['message-id-collision', 'invalid-payload']);
    assert.doesNotMatch(JSON.stringify(quarantine), /SECRET/);
  });

  test('quarantines non-canonical or hash-mismatched remote payloads', async (t) => {
    const { db, reconciler } = createHarness(t);
    const canonical = await remoteRecord();

    await reconciler.handle({ type: 'record', canonical: { ...canonical, payload: '{"value":"remote","id":"settings-1"}' } });

    assert.deepEqual((await db.quarantine.where('uid').equals(UID).toArray()).map(item => item.reasonCode), ['invalid-payload']);
  });
});
