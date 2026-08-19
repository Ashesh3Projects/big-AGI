import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import Dexie from 'dexie';

import {
  PrivateProSyncDB,
  type PrivateProRemoteBaseState,
} from './privatePro.sync.db';
import type { PrivateProSyncPreparedRecord } from './privatePro.sync.serializers';


const UID_A = 'uid-a';
const UID_B = 'uid-b';

function preparedRecord(recordKey: string, payload: string): PrivateProSyncPreparedRecord {
  return {
    recordType: 'settings',
    logicalId: recordKey,
    recordKey,
    projectionKey: `projection-${recordKey}`,
    schemaVersion: 1,
    payload,
    contentHash: 'a'.repeat(64),
    referencedAssetIds: [],
  };
}

function remoteBase(revision: number): PrivateProRemoteBaseState {
  return { revision, mutationId: `mutation-${revision}`, deleted: false };
}

function createDB(t: TestContext): PrivateProSyncDB {
  const name = `private-pro-sync-test-${crypto.randomUUID()}`;
  const db = new PrivateProSyncDB(name);
  t.after(async () => {
    db.close();
    await Dexie.delete(name);
  });
  return db;
}

async function seedUid(db: PrivateProSyncDB, uid: string): Promise<void> {
  await db.recordLocalPut(uid, preparedRecord(`key-${uid}`, `{"uid":"${uid}"}`), 1_000);
}


describe('Private Pro seamless sync database', () => {
  test('replaces payload and increments generation inside one 60-second window', async (t) => {
    const db = createDB(t);
    const first = preparedRecord('record-1', '{"value":1}');
    const second = preparedRecord('record-1', '{"value":2}');

    await db.recordLocalPut(UID_A, first, 1_000);
    await db.recordLocalPut(UID_A, second, 2_000);

    const pending = await db.getOutbox(UID_A, second.recordKey);
    assert.equal(pending?.generation, 2);
    assert.equal(pending?.payload, second.payload);
    assert.equal(pending?.dueAtMs, 61_000);
  });

  test('acknowledges only the generation that was sent', async (t) => {
    const db = createDB(t);
    const first = preparedRecord('record-1', '{"value":1}');
    const second = preparedRecord('record-1', '{"value":2}');

    const sent = await db.recordLocalPut(UID_A, first, 1_000);
    await db.recordLocalPut(UID_A, second, 2_000);
    await db.acknowledge(UID_A, sent.recordKey, sent.generation, remoteBase(1), 61_000);

    const pending = await db.getOutbox(UID_A, sent.recordKey);
    assert.equal(pending?.generation, 2);
    assert.equal(pending?.payload, second.payload);
    assert.equal(pending?.baseRevision, 1);
    assert.equal(pending?.dueAtMs, 121_000);
  });

  test('clears only one UID namespace', async (t) => {
    const db = createDB(t);

    await seedUid(db, UID_A);
    await seedUid(db, UID_B);
    await db.clearUid(UID_A);

    assert.equal((await db.listLocalRecords(UID_A)).length, 0);
    assert.notEqual((await db.listLocalRecords(UID_B)).length, 0);
  });

  test('leases due work once until the lease expires', async (t) => {
    const db = createDB(t);
    await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":1}'), 1_000);

    const leased = await db.leaseDue(UID_A, 61_000, 5_000);
    assert.equal(leased?.recordKey, 'record-1');
    assert.equal(leased?.leaseUntilMs, 66_000);
    assert.equal(await db.leaseDue(UID_A, 61_000, 5_000), null);
  });

  test('increments coordinator fences for each acquired UID lease', async (t) => {
    const db = createDB(t);

    const first = await db.acquireCoordinatorLease(UID_A, 'sync', 1_000, 5_000);
    const second = await db.acquireCoordinatorLease(UID_A, 'sync', 6_000, 5_000);

    assert.equal(first?.fence, 1);
    assert.equal(second?.fence, 2);
  });

  test('does not let a stale coordinator fence renew a lease', async (t) => {
    const db = createDB(t);
    const first = await db.acquireCoordinatorLease(UID_A, 'sync', 1_000, 5_000);
    const second = await db.acquireCoordinatorLease(UID_A, 'sync', 6_000, 5_000);
    if (!first || !second) assert.fail('Expected coordinator lease acquisition.');

    assert.equal(await db.renewCoordinatorLease(UID_A, 'sync', first.fence, 7_000, 5_000), null);
    const renewed = await db.renewCoordinatorLease(UID_A, 'sync', second.fence, 7_000, 5_000);
    assert.equal(renewed?.fence, second.fence);
    assert.equal(renewed?.expiresAtMs, 12_000);
  });
});
