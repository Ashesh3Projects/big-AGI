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
    const lease = await db.leaseDue(UID_A, 61_000, 5_000, 1);
    if (!lease?.leaseToken || lease.leaseFence === null) assert.fail('Expected a leased outbox row.');
    await db.recordLocalPut(UID_A, second, 2_000);
    await db.acknowledge(UID_A, sent.recordKey, sent.generation, lease.leaseToken, lease.leaseFence, remoteBase(1), 61_000);

    const pending = await db.getOutbox(UID_A, sent.recordKey);
    assert.equal(pending?.generation, 2);
    assert.equal(pending?.payload, second.payload);
    assert.equal(pending?.baseRevision, 1);
    assert.equal(pending?.dueAtMs, 62_000);
    assert.equal(pending?.leaseUntilMs, null);
    assert.equal(pending?.leaseToken, null);
    assert.equal(pending?.leaseFence, null);
    assert.equal(pending?.leasedGeneration, null);
  });

  test('starts and preserves a newer generation first-window deadline while the older generation is leased', async (t) => {
    const db = createDB(t);
    const first = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":1}'), 1_000);
    const lease = await db.leaseDue(UID_A, 61_000, 5_000, 1);
    if (!lease?.leaseToken || lease.leaseFence === null) assert.fail('Expected lease.');
    await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":2}'), 62_000);
    assert.equal((await db.getOutbox(UID_A, first.recordKey))?.dueAtMs, 122_000);

    await db.acknowledge(UID_A, first.recordKey, first.generation, lease.leaseToken, lease.leaseFence, remoteBase(1), 61_000);

    assert.equal((await db.getOutbox(UID_A, first.recordKey))?.dueAtMs, 122_000);
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

    const leased = await db.leaseDue(UID_A, 61_000, 5_000, 1);
    assert.equal(leased?.recordKey, 'record-1');
    assert.equal(leased?.leaseUntilMs, 66_000);
    assert.equal(leased?.leaseFence, 1);
    assert.notEqual(leased?.leaseToken, null);
    assert.equal(leased?.leasedGeneration, leased?.generation);
    assert.equal(await db.leaseDue(UID_A, 61_000, 5_000, 1), null);
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

    assert.equal(await db.renewCoordinatorLease(UID_A, 'sync', first.fence, first.ownerToken, 7_000, 5_000), null);
    const renewed = await db.renewCoordinatorLease(UID_A, 'sync', second.fence, second.ownerToken, 7_000, 5_000);
    assert.equal(renewed?.fence, second.fence);
    assert.equal(renewed?.expiresAtMs, 12_000);
  });

  test('does not let a stale outbox lease retry, rebase, or acknowledge after re-lease', async (t) => {
    const db = createDB(t);
    await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":1}'), 1_000);
    const oldLease = await db.leaseDue(UID_A, 61_000, 5_000, 1);
    const currentLease = await db.leaseDue(UID_A, 66_000, 5_000, 2);
    if (!oldLease?.leaseToken || oldLease.leaseFence === null || !currentLease?.leaseToken || currentLease.leaseFence === null)
      assert.fail('Expected both outbox leases.');

    await db.retry(UID_A, oldLease.recordKey, oldLease.generation, oldLease.leaseToken, oldLease.leaseFence, 67_000, 1_000, 'offline');
    await db.rebase(UID_A, oldLease.recordKey, oldLease.generation, oldLease.leaseToken, oldLease.leaseFence, remoteBase(4), 67_000);
    await db.acknowledge(UID_A, oldLease.recordKey, oldLease.generation, oldLease.leaseToken, oldLease.leaseFence, remoteBase(5), 67_000);

    const pending = await db.getOutbox(UID_A, oldLease.recordKey);
    assert.equal(pending?.leaseToken, currentLease.leaseToken);
    assert.equal(pending?.leaseFence, 2);
    assert.equal(pending?.dueAtMs, 61_000);
    assert.equal(pending?.baseRevision, 0);
    assert.equal(await db.getRemoteBase(UID_A, oldLease.recordKey), null);
  });

  test('retries and rebases the newest pending generation after an older sent generation changes locally', async (t) => {
    const db = createDB(t);
    const sent = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":1}'), 1_000);
    const lease = await db.leaseDue(UID_A, 61_000, 5_000, 1);
    if (!lease?.leaseToken || lease.leaseFence === null) assert.fail('Expected a sent lease.');
    const latest = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":2}'), 62_000);

    await db.retry(UID_A, sent.recordKey, sent.generation, lease.leaseToken, lease.leaseFence, 63_000, 1_000, 'offline');
    let pending = await db.getOutbox(UID_A, sent.recordKey);
    assert.equal(pending?.generation, latest.generation);
    assert.equal(pending?.payload, '{"value":2}');
    assert.equal(pending?.dueAtMs, 64_000);
    assert.equal(pending?.leaseToken, null);
    assert.equal(pending?.leasedGeneration, null);

    const rebaseLease = await db.leaseDue(UID_A, 64_000, 5_000, 1);
    if (!rebaseLease?.leaseToken || rebaseLease.leaseFence === null) assert.fail('Expected rebase lease.');
    await db.rebase(UID_A, latest.recordKey, rebaseLease.generation, rebaseLease.leaseToken, rebaseLease.leaseFence, remoteBase(4), 65_000);
    pending = await db.getOutbox(UID_A, latest.recordKey);
    assert.equal(pending?.generation, latest.generation);
    assert.equal(pending?.payload, '{"value":2}');
    assert.equal(pending?.baseRevision, 4);
    assert.equal(pending?.dueAtMs, 65_000);
    assert.equal(pending?.leaseUntilMs, null);
    assert.equal(pending?.leaseToken, null);
    assert.equal(pending?.leaseFence, null);
    assert.equal(pending?.leasedGeneration, null);
  });

  test('preserves coordinator fence tombstones across clearUid and rejects the old owner', async (t) => {
    const db = createDB(t);
    const first = await db.acquireCoordinatorLease(UID_A, 'sync', 1_000, 5_000);
    if (!first) assert.fail('Expected the first coordinator lease.');

    await db.clearUid(UID_A);
    const second = await db.acquireCoordinatorLease(UID_A, 'sync', 2_000, 5_000);
    if (!second) assert.fail('Expected the post-clear coordinator lease.');
    await db.releaseCoordinatorLease(UID_A, 'sync', first.fence, first.ownerToken);

    assert.ok(second.fence > first.fence);
    assert.equal(await db.renewCoordinatorLease(UID_A, 'sync', first.fence, first.ownerToken, 3_000, 5_000), null);
    assert.notEqual(await db.renewCoordinatorLease(UID_A, 'sync', second.fence, second.ownerToken, 3_000, 5_000), null);
  });

  test('keeps a higher remote base when lower rebase and acknowledgement callbacks arrive', async (t) => {
    const db = createDB(t);
    await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":1}'), 1_000);
    const firstLease = await db.leaseDue(UID_A, 61_000, 5_000, 1);
    if (!firstLease?.leaseToken || firstLease.leaseFence === null) assert.fail('Expected first lease.');
    await db.rebase(UID_A, firstLease.recordKey, firstLease.generation, firstLease.leaseToken, firstLease.leaseFence, remoteBase(5), 61_000);
    const next = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":2}'), 62_000);
    const nextLease = await db.leaseDue(UID_A, 62_000, 5_000, 1);
    if (!nextLease?.leaseToken || nextLease.leaseFence === null) assert.fail('Expected next lease.');

    await db.rebase(UID_A, next.recordKey, next.generation, nextLease.leaseToken, nextLease.leaseFence, remoteBase(1), 63_000);
    assert.equal((await db.getOutbox(UID_A, next.recordKey))?.baseRevision, 5);
    const final = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":3}'), 64_000);
    const finalLease = await db.leaseDue(UID_A, 64_000, 5_000, 1);
    if (!finalLease?.leaseToken || finalLease.leaseFence === null) assert.fail('Expected final lease.');
    await db.acknowledge(UID_A, final.recordKey, final.generation, finalLease.leaseToken, finalLease.leaseFence, remoteBase(1), 64_000);

    assert.deepEqual(await db.getRemoteBase(UID_A, next.recordKey), remoteBase(5));
    assert.equal((await db.getLocalRecord(UID_A, final.recordKey))?.baseRevision, 5);
  });

  test('does not reuse a generation after tombstone discard or accept delayed callbacks', async (t) => {
    const db = createDB(t);
    const first = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":1}'), 1_000);
    const oldLease = await db.leaseDue(UID_A, 61_000, 5_000, 1);
    if (!oldLease?.leaseToken || oldLease.leaseFence === null) assert.fail('Expected old lease.');
    await db.discardAcrossTombstone(UID_A, first.recordKey, { revision: 2, mutationId: 'tombstone-2', deleted: true });
    const recreated = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":2}'), 62_000);
    const currentLease = await db.leaseDue(UID_A, 122_000, 5_000, 2);
    if (!currentLease?.leaseToken || currentLease.leaseFence === null) assert.fail('Expected recreated lease.');

    await db.retry(UID_A, first.recordKey, first.generation, oldLease.leaseToken, oldLease.leaseFence, 123_000, 1_000, 'offline');
    await db.rebase(UID_A, first.recordKey, first.generation, oldLease.leaseToken, oldLease.leaseFence, remoteBase(99), 123_000);
    await db.acknowledge(UID_A, first.recordKey, first.generation, oldLease.leaseToken, oldLease.leaseFence, remoteBase(100), 123_000);

    const pending = await db.getOutbox(UID_A, first.recordKey);
    assert.ok(recreated.generation > first.generation);
    assert.equal(pending?.generation, recreated.generation);
    assert.equal(pending?.leaseToken, currentLease.leaseToken);
    assert.equal(pending?.baseRevision, 2);
    assert.deepEqual(await db.getRemoteBase(UID_A, first.recordKey), { revision: 2, mutationId: 'tombstone-2', deleted: true });
  });

  test('expedites only unblocked pending rows and reports the next schedulable due time', async (t) => {
    const db = createDB(t);
    const first = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":1}'), 1_000);
    await db.recordLocalPut(UID_A, preparedRecord('record-2', '{"value":2}'), 2_000);
    const lease = await db.leaseDue(UID_A, 61_000, 5_000, 1);
    if (!lease?.leaseToken || lease.leaseFence === null) assert.fail('Expected first lease.');
    await db.block(UID_A, first.recordKey, first.generation, lease.leaseToken, lease.leaseFence, 'permission');

    assert.equal(await db.nextDueAt(UID_A), 62_000);
    await db.expedite(UID_A, 10_000);
    assert.equal(await db.nextDueAt(UID_A), 10_000);
    assert.equal((await db.getOutbox(UID_A, first.recordKey))?.dueAtMs, 61_000);
  });

  test('reports a leased row at its expiry so a restarted leader can recover it', async (t) => {
    const db = createDB(t);
    await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":1}'), 1_000);
    await db.leaseDue(UID_A, 61_000, 5_000, 1);

    assert.equal(await db.nextDueAt(UID_A), 66_000);
  });

  test('persists conflict retry timing while rebasing the exact leased generation', async (t) => {
    const db = createDB(t);
    const pending = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":1}'), 1_000);
    const lease = await db.leaseDue(UID_A, 61_000, 5_000, 1);
    if (!lease?.leaseToken || lease.leaseFence === null) assert.fail('Expected lease.');

    await db.rebase(UID_A, pending.recordKey, pending.generation, lease.leaseToken, lease.leaseFence, remoteBase(3), 61_000, 500);

    assert.equal((await db.getOutbox(UID_A, pending.recordKey))?.dueAtMs, 61_500);
  });

  test('does not rebase a newer generation from an older leased conflict', async (t) => {
    const db = createDB(t);
    const first = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":1}'), 1_000);
    const lease = await db.leaseDue(UID_A, 61_000, 5_000, 1);
    if (!lease?.leaseToken || lease.leaseFence === null) assert.fail('Expected lease.');
    const latest = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":2}'), 62_000);

    await db.rebase(UID_A, first.recordKey, first.generation, lease.leaseToken, lease.leaseFence, remoteBase(3), 63_000, 500);

    const pending = await db.getOutbox(UID_A, first.recordKey);
    assert.equal(pending?.generation, latest.generation);
    assert.equal(pending?.baseRevision, 0);
    assert.equal(pending?.leaseToken, null);
    assert.equal(await db.getRemoteBase(UID_A, first.recordKey), null);
  });

  test('blocks a terminal failure only while its exact generation and fence are leased', async (t) => {
    const db = createDB(t);
    const pending = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":1}'), 1_000);
    const oldLease = await db.leaseDue(UID_A, 61_000, 5_000, 1);
    const currentLease = await db.leaseDue(UID_A, 66_000, 5_000, 2);
    if (!oldLease?.leaseToken || oldLease.leaseFence === null || !currentLease?.leaseToken || currentLease.leaseFence === null)
      assert.fail('Expected both leases.');

    await db.block(UID_A, pending.recordKey, pending.generation, oldLease.leaseToken, oldLease.leaseFence, 'permission');
    assert.equal((await db.getOutbox(UID_A, pending.recordKey))?.blocked, false);
    await db.block(UID_A, pending.recordKey, pending.generation, currentLease.leaseToken, currentLease.leaseFence, 'permission');

    const blocked = await db.getOutbox(UID_A, pending.recordKey);
    assert.equal(blocked?.blocked, true);
    assert.equal(blocked?.errorCode, 'permission');
    assert.equal(blocked?.leaseToken, null);
    assert.equal(await db.leaseDue(UID_A, 100_000, 5_000, 3), null);
  });

  test('quarantines and blocks only the exact leased message generation', async (t) => {
    const db = createDB(t);
    const pending = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":1}'), 1_000);
    const lease = await db.leaseDue(UID_A, 61_000, 5_000, 4);
    if (!lease?.leaseToken || lease.leaseFence === null) assert.fail('Expected lease.');

    await db.quarantineLeased(UID_A, pending.recordKey, pending.generation, lease.leaseToken, lease.leaseFence, 'message-id-collision', 62_000);

    assert.equal((await db.getOutbox(UID_A, pending.recordKey))?.blocked, true);
    assert.deepEqual(await db.quarantine.where('uid').equals(UID_A).toArray(), [{
      id: 1,
      uid: UID_A,
      recordKey: pending.recordKey,
      reasonCode: 'message-id-collision',
      createdAtMs: 62_000,
    }]);
  });

  test('does not quarantine a newer generation from an older leased collision', async (t) => {
    const db = createDB(t);
    const first = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":1}'), 1_000);
    const lease = await db.leaseDue(UID_A, 61_000, 5_000, 4);
    if (!lease?.leaseToken || lease.leaseFence === null) assert.fail('Expected lease.');
    const latest = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":2}'), 62_000);

    await db.quarantineLeased(UID_A, first.recordKey, first.generation, lease.leaseToken, lease.leaseFence, 'message-id-collision', 63_000);

    const pending = await db.getOutbox(UID_A, first.recordKey);
    assert.equal(pending?.generation, latest.generation);
    assert.equal(pending?.blocked, false);
    assert.equal(pending?.leaseToken, null);
    assert.equal(await db.quarantine.where('uid').equals(UID_A).count(), 0);
  });
});
