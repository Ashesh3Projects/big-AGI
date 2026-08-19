import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import Dexie from 'dexie';

import {
  PrivateProSyncDB,
  type PrivateProRemoteBaseState,
} from './privatePro.sync.db';
import type { PrivateProSyncPreparedRecord } from './privatePro.sync.serializers';
import { privateProRecordKey } from './privatePro.sync.codec';


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
  for (const kind of ['put', 'delete'] as const) {
    test(`aborts a local ${kind} transaction when capture ownership is cancelled during the final write`, async (t) => {
      const db = createDB(t);
      const controller = new AbortController();
      const record = preparedRecord(`abort-${kind}`, '{"value":1}');
      const abort = () => controller.abort();
      db.localRecords.hook('creating').subscribe(abort);

      const writing = kind === 'put'
        ? db.recordLocalPut(UID_A, record, 1_000, controller.signal)
        : db.recordLocalDelete(UID_A, record, 1_000, controller.signal);
      await assert.rejects(writing, { name: 'AbortError' });
      db.localRecords.hook('creating').unsubscribe(abort);

      assert.equal(await db.getLocalRecord(UID_A, record.recordKey), null);
      assert.equal(await db.getOutbox(UID_A, record.recordKey), null);
    });
  }

  for (const operation of ['observe', 'effective', 'record', 'tombstone', 'discard', 'quarantine'] as const) {
    test(`aborts a remote ${operation} transaction when reconciliation stops during its final write`, async (t) => {
      const db = createDB(t);
      const controller = new AbortController();
      const record = preparedRecord(`abort-remote-${operation}`, '{"value":1}');
      const remote = operation === 'tombstone' || operation === 'discard'
        ? { revision: 2, mutationId: `mutation-${operation}`, deleted: true } as const
        : { revision: 2, mutationId: `mutation-${operation}`, deleted: false } as const;
      if (operation === 'discard') {
        await db.recordLocalPut(UID_A, record, 1_000);
        await db.localRecords.update([UID_A, record.recordKey], { baseRevision: 1 });
        await db.outbox.update([UID_A, record.recordKey], { baseRevision: 1 });
      }
      const hookTable = operation === 'quarantine' ? db.quarantine : db.remoteBases;
      const abort = () => controller.abort();
      hookTable.hook('creating').subscribe(abort);

      const writing = operation === 'observe' ? db.observeRemoteBase(UID_A, record.recordKey, remote, controller.signal)
        : operation === 'effective' ? db.setEffectiveRemoteBase(UID_A, record.recordKey, remote, controller.signal)
          : operation === 'record' ? db.commitRemoteRecord(UID_A, record, remote, 2_000, controller.signal)
            : operation === 'tombstone' ? db.commitRemoteTombstone(UID_A, record, remote, 2_000, controller.signal)
              : operation === 'discard' ? db.discardAcrossTombstone(UID_A, record.recordKey, remote, controller.signal)
                : db.quarantineRemote(UID_A, record.recordKey, 'invalid-payload', 2_000, controller.signal);
      await assert.rejects(writing, { name: 'AbortError' });
      hookTable.hook('creating').unsubscribe(abort);

      assert.equal(await db.getRemoteBase(UID_A, record.recordKey), null);
      if (operation === 'record' || operation === 'tombstone') assert.equal(await db.getLocalRecord(UID_A, record.recordKey), null);
      if (operation === 'discard') {
        assert.notEqual(await db.getLocalRecord(UID_A, record.recordKey), null);
        assert.notEqual(await db.getOutbox(UID_A, record.recordKey), null);
      }
      if (operation === 'quarantine') assert.equal(await db.quarantine.where('uid').equals(UID_A).count(), 0);
    });
  }

  test('observes a deleted remote base without rebasing pre-delete pending work', async (t) => {
    const db = createDB(t);
    const pending = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":1}'), 1_000);
    await db.localRecords.update([UID_A, pending.recordKey], { baseRevision: 1 });
    await db.outbox.update([UID_A, pending.recordKey], { baseRevision: 1 });

    await db.observeRemoteBase(UID_A, pending.recordKey, { revision: 2, mutationId: 'delete-2', deleted: true });

    assert.deepEqual(await db.getRemoteBase(UID_A, pending.recordKey), { revision: 2, mutationId: 'delete-2', deleted: true });
    assert.equal((await db.getLocalRecord(UID_A, pending.recordKey))?.baseRevision, 1);
    assert.equal((await db.getOutbox(UID_A, pending.recordKey))?.baseRevision, 1);
  });

  test('discards pre-delete pending put after observe-only deletion but preserves genuine post-tombstone work', async (t) => {
    const db = createDB(t);
    const stale = await db.recordLocalPut(UID_A, preparedRecord('stale', '{"value":1}'), 1_000);
    await db.localRecords.update([UID_A, stale.recordKey], { baseRevision: 1 });
    await db.outbox.update([UID_A, stale.recordKey], { baseRevision: 1 });
    const deletion = { revision: 2, mutationId: 'delete-2', deleted: true } as const;
    await db.observeRemoteBase(UID_A, stale.recordKey, deletion);
    await db.discardAcrossTombstone(UID_A, stale.recordKey, deletion);

    const post = await db.recordLocalPut(UID_A, preparedRecord('post', '{"value":2}'), 2_000);
    await db.localRecords.update([UID_A, post.recordKey], { baseRevision: 2 });
    await db.outbox.update([UID_A, post.recordKey], { baseRevision: 2 });
    await db.observeRemoteBase(UID_A, post.recordKey, deletion);
    await db.discardAcrossTombstone(UID_A, post.recordKey, deletion);

    assert.equal(await db.getLocalRecord(UID_A, stale.recordKey), null);
    assert.equal(await db.getOutbox(UID_A, stale.recordKey), null);
    assert.equal((await db.getOutbox(UID_A, post.recordKey))?.baseRevision, 2);
  });
  test('persists a committed remote record and lists its live projection', async (t) => {
    const db = createDB(t);
    const record = preparedRecord('record-remote', '{"value":4}');

    await db.commitRemoteRecord(UID_A, record, remoteBase(4), 4_000);

    assert.deepEqual(await db.listProjectionRecords(UID_A, record.projectionKey), [{
      uid: UID_A, ...record, generation: 0, baseRevision: 4, deleted: false, updatedAtMs: 4_000,
    }]);
  });

  test('preserves a newer local value while advancing its committed remote base', async (t) => {
    const db = createDB(t);
    const local = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":5}'), 5_000);

    await db.commitRemoteRecord(UID_A, preparedRecord('record-1', '{"value":4}'), remoteBase(4), 6_000);

    const stored = await db.getLocalRecord(UID_A, local.recordKey);
    assert.equal(stored?.payload, '{"value":5}');
    assert.equal(stored?.generation, 1);
    assert.equal(stored?.baseRevision, 4);
  });

  test('persists a remote tombstone without deleting a local mutation based at that tombstone', async (t) => {
    const db = createDB(t);
    const local = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":5}'), 5_000);
    await db.localRecords.update([UID_A, local.recordKey], { baseRevision: 4 });
    await db.outbox.update([UID_A, local.recordKey], { baseRevision: 4 });

    await db.commitRemoteTombstone(UID_A, local, { revision: 4, mutationId: 'mutation-4', deleted: true }, 6_000);
    await db.discardAcrossTombstone(UID_A, local.recordKey, { revision: 4, mutationId: 'mutation-4', deleted: true });

    assert.equal((await db.getLocalRecord(UID_A, local.recordKey))?.payload, '{"value":5}');
    assert.equal((await db.getOutbox(UID_A, local.recordKey))?.generation, 1);
  });

  test('counts blocked and unblocked pending work and quarantines only a reason code', async (t) => {
    const db = createDB(t);
    const pending = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"secret":"payload"}'), 1_000);
    await db.outbox.update([UID_A, pending.recordKey], { blocked: true });

    await db.quarantineRemote(UID_A, pending.recordKey, 'invalid-payload', 2_000);

    assert.equal(await db.pendingCount(UID_A), 1);
    assert.deepEqual(await db.quarantine.where('uid').equals(UID_A).toArray(), [{
      id: 1, uid: UID_A, recordKey: pending.recordKey, reasonCode: 'invalid-payload', createdAtMs: 2_000,
    }]);
  });

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
    await db.outbox.update([UID_A, first.recordKey], { retryAttempt: 3, errorCode: 'prior', blocked: false });
    const lease = await db.leaseDue(UID_A, 61_000, 5_000, 1);
    if (!lease?.leaseToken || lease.leaseFence === null) assert.fail('Expected lease.');
    await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":2}'), 62_000);
    await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":3}'), 63_000);
    await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":4}'), 64_000);
    assert.equal((await db.getOutbox(UID_A, first.recordKey))?.dueAtMs, 122_000);

    await db.acknowledge(UID_A, first.recordKey, first.generation, lease.leaseToken, lease.leaseFence, remoteBase(1), 61_000);

    assert.equal((await db.getOutbox(UID_A, first.recordKey))?.dueAtMs, 122_000);
  });

  test('preserves the first post-lease delete deadline through repeated local mutations', async (t) => {
    const db = createDB(t);
    const first = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":1}'), 1_000);
    const lease = await db.leaseDue(UID_A, 61_000, 5_000, 1);
    if (!lease?.leaseToken || lease.leaseFence === null) assert.fail('Expected lease.');
    const identity = {
      recordType: first.recordType,
      logicalId: first.logicalId,
      recordKey: first.recordKey,
      projectionKey: first.projectionKey,
      schemaVersion: first.schemaVersion,
    };

    await db.recordLocalDelete(UID_A, identity, 62_000);
    await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":2}'), 63_000);
    await db.recordLocalDelete(UID_A, identity, 64_000);

    const pending = await db.getOutbox(UID_A, first.recordKey);
    assert.equal(pending?.kind, 'delete');
    assert.equal(pending?.dueAtMs, 122_000);
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

  test('keeps asset upload leases UID-scoped, monotonic, and fenced against delayed stale owners', async (t) => {
    const db = createDB(t);
    const first = await db.acquireAssetUploadLease(UID_A, 'asset-1', 1_000, 5_000);
    const otherUid = await db.acquireAssetUploadLease(UID_B, 'asset-1', 1_000, 5_000);
    const current = await db.acquireAssetUploadLease(UID_A, 'asset-1', 6_000, 5_000);
    if (!first || !otherUid || !current) assert.fail('Expected durable asset upload leases.');

    await db.releaseAssetUploadLease(UID_A, 'asset-1', first.fence, first.ownerToken);
    assert.equal(await db.renewAssetUploadLease(UID_A, 'asset-1', first.fence, first.ownerToken, 7_000, 5_000), null);
    const renewed = await db.renewAssetUploadLease(UID_A, 'asset-1', current.fence, current.ownerToken, 7_000, 5_000);

    assert.ok(current.fence > first.fence);
    assert.notEqual(current.ownerToken, first.ownerToken);
    assert.equal(otherUid.fence, 1);
    assert.equal(renewed?.ownerToken, current.ownerToken);
    assert.equal(renewed?.expiresAtMs, 12_000);
  });

  test('does not let a delayed asset renewal resurrect an owner after release', async (t) => {
    const db = createDB(t);
    const stopped = await db.acquireAssetUploadLease(UID_A, 'asset-stopped', 1_000, 5_000);
    if (!stopped) assert.fail('Expected the stopped asset lease.');

    await db.releaseAssetUploadLease(UID_A, 'asset-stopped', stopped.fence, stopped.ownerToken);
    const delayedRenewal = await db.renewAssetUploadLease(UID_A, 'asset-stopped', stopped.fence, stopped.ownerToken, 2_000, 5_000);
    const replacement = await db.acquireAssetUploadLease(UID_A, 'asset-stopped', 2_000, 5_000);

    assert.equal(delayedRenewal, null);
    assert.ok(replacement && replacement.fence > stopped.fence);
    assert.notEqual(replacement?.ownerToken, stopped.ownerToken);
  });

  test('verifies the exact current asset upload lease identity and expiry', async (t) => {
    const db = createDB(t);
    const first = await db.acquireAssetUploadLease(UID_A, 'asset-owned', 1_000, 5_000);
    if (!first) assert.fail('Expected the first asset upload lease.');

    assert.equal(await db.ownsAssetUploadLease(UID_A, 'asset-owned', first.fence, first.ownerToken, first.expiresAtMs, 2_000), true);
    assert.equal(await db.ownsAssetUploadLease(UID_A, 'asset-owned', first.fence, first.ownerToken, first.expiresAtMs + 1, 2_000), false);
    const successor = await db.acquireAssetUploadLease(UID_A, 'asset-owned', first.expiresAtMs, 5_000);
    if (!successor) assert.fail('Expected the successor asset upload lease.');

    assert.equal(await db.ownsAssetUploadLease(UID_A, 'asset-owned', first.fence, first.ownerToken, first.expiresAtMs, first.expiresAtMs), false);
    assert.equal(await db.ownsAssetUploadLease(UID_A, 'asset-owned', successor.fence, successor.ownerToken, successor.expiresAtMs, first.expiresAtMs + 1), true);
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

  test('a stale retry releases the inherited lease without changing the newer generation', async (t) => {
    const db = createDB(t);
    const sent = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":1}'), 1_000);
    const lease = await db.leaseDue(UID_A, 61_000, 5_000, 1);
    if (!lease?.leaseToken || lease.leaseFence === null) assert.fail('Expected a sent lease.');
    const latest = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":2}'), 62_000);
    await db.outbox.update([UID_A, sent.recordKey], { retryAttempt: 4, errorCode: 'prior', blocked: true });

    await db.retry(UID_A, sent.recordKey, sent.generation, lease.leaseToken, lease.leaseFence, 63_000, 1_000, 'offline');
    const pending = await db.getOutbox(UID_A, sent.recordKey);
    assert.equal(pending?.generation, latest.generation);
    assert.equal(pending?.payload, '{"value":2}');
    assert.equal(pending?.dueAtMs, 122_000);
    assert.equal(pending?.retryAttempt, 4);
    assert.equal(pending?.errorCode, 'prior');
    assert.equal(pending?.blocked, true);
    assert.equal(pending?.leaseToken, null);
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

  test('leases due asset manifests before other rows at the same due time', async (t) => {
    const db = createDB(t);
    await db.recordLocalPut(UID_A, preparedRecord('chat-1', '{"value":1}'), 1_000);
    await db.recordLocalPut(UID_A, { ...preparedRecord('asset-1', '{"value":2}'), recordType: 'asset' }, 2_000);

    const lease = await db.leaseDue(UID_A, 62_000, 5_000, 1);

    assert.equal(lease?.recordType, 'asset');
  });

  test('defers a referenced row until every asset manifest has a live acknowledged revision', async (t) => {
    const db = createDB(t);
    const referenced = privateProRecordKey('asset', 'asset-1');
    const row = await db.recordLocalPut(UID_A, { ...preparedRecord('chat-1', '{"value":1}'), referencedAssetIds: ['asset-1'] }, 1_000);
    const lease = await db.leaseDue(UID_A, 61_000, 5_000, 1);
    if (!lease?.leaseToken || lease.leaseFence === null) assert.fail('Expected reference lease.');

    assert.equal(await db.referencedAssetsReady(UID_A, row.referencedAssetIds), false);
    await db.deferLease(UID_A, row.recordKey, row.generation, lease.leaseToken, lease.leaseFence, 62_000);
    assert.equal((await db.getOutbox(UID_A, row.recordKey))?.dueAtMs, 62_000);
    await db.assets.put({
      uid: UID_A, assetId: 'asset-1', contentGeneration: 1, publishedContentGeneration: 1, publishedManifestHash: 'a'.repeat(64),
      manifest: {
        formatVersion: 1, schemaVersion: 1, uid: UID_A, assetId: 'asset-1', contentGeneration: 1, assetType: 'image', contextId: 'global', scopeId: 'app-chat',
        label: 'asset', origin: { ot: 'user', source: 'attachment', media: 'file-open' }, createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:00:00.000Z',
        metadata: { width: 1, height: 1 }, objects: { original: { objectId: 'original', kind: 'original', mimeType: 'image/png', byteSize: 1, sha256: 'b'.repeat(64) } },
      },
      uploadStatus: 'ready', hydrationStatus: 'ready', updatedAtMs: 1,
    });
    await db.localRecords.put({
      uid: UID_A, recordKey: referenced, recordType: 'asset', logicalId: 'asset-1', projectionKey: 'asset-1', schemaVersion: 1,
      payload: '{}', contentHash: 'a'.repeat(64), referencedAssetIds: ['asset-1'], generation: 1, baseRevision: 1, deleted: false, updatedAtMs: 1,
    });
    await db.remoteBases.put({ uid: UID_A, recordKey: referenced, revision: 1, mutationId: 'asset-put', deleted: false });
    assert.equal(await db.referencedAssetsReady(UID_A, row.referencedAssetIds), true);

    await db.outbox.put({
      uid: UID_A, recordKey: referenced, recordType: 'asset', logicalId: 'asset-1', projectionKey: 'asset-1', schemaVersion: 1,
      kind: 'put', payload: '{}', contentHash: 'a'.repeat(64), referencedAssetIds: ['asset-1'], mutationId: 'pending-asset', generation: 2,
      baseRevision: 1, dueAtMs: 120_000, retryAttempt: 0, leaseUntilMs: null, leaseToken: null, leaseFence: null, leasedGeneration: null, blocked: false, errorCode: null,
    });
    assert.equal(await db.referencedAssetsReady(UID_A, row.referencedAssetIds), false);
    await db.outbox.delete([UID_A, referenced]);
    await db.assets.update([UID_A, 'asset-1'], { contentGeneration: 2, publishedContentGeneration: undefined, publishedManifestHash: undefined });
    assert.equal(await db.referencedAssetsReady(UID_A, row.referencedAssetIds), false);
  });

  test('synthetic acknowledgement makes only the current published asset ready', async (t) => {
    const db = createDB(t);
    const assetId = 'asset-synthetic-ready';
    const recordKey = privateProRecordKey('asset', assetId);
    await db.assets.put({
      uid: UID_A, assetId, contentGeneration: 1, publishedContentGeneration: 1, publishedManifestHash: 'c'.repeat(64),
      manifest: {
        formatVersion: 1, schemaVersion: 1, uid: UID_A, assetId, contentGeneration: 1, assetType: 'image', contextId: 'global', scopeId: 'app-chat',
        label: 'asset', origin: { ot: 'user', source: 'attachment', media: 'file-open' }, createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:00:00.000Z',
        metadata: { width: 1, height: 1 }, objects: { original: { objectId: 'original', kind: 'original', mimeType: 'image/png', byteSize: 1, sha256: 'd'.repeat(64) } },
      }, uploadStatus: 'ready', hydrationStatus: 'ready', updatedAtMs: 1,
    });
    const pending = await db.recordLocalPut(UID_A, {
      recordType: 'asset', logicalId: assetId, recordKey, projectionKey: assetId, schemaVersion: 1,
      payload: '{}', contentHash: 'c'.repeat(64), referencedAssetIds: [assetId],
    }, 1_000);
    const lease = await db.leaseDue(UID_A, 61_000, 5_000, 1);
    if (!lease?.leaseToken || lease.leaseFence === null) assert.fail('Expected asset lease.');

    await db.acknowledge(UID_A, recordKey, pending.generation, lease.leaseToken, lease.leaseFence, { revision: 1, mutationId: pending.mutationId, deleted: false }, 61_000);

    assert.equal(await db.referencedAssetsReady(UID_A, [assetId]), true);
  });

  test('reports the later of due time and active lease expiry', async (t) => {
    const db = createDB(t);
    await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":1}'), 1_000);
    const lease = await db.leaseDue(UID_A, 61_000, 30_000, 1);
    if (!lease?.leaseToken || lease.leaseFence === null) assert.fail('Expected lease.');
    await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":2}'), 62_000);

    assert.equal(await db.nextDueAt(UID_A), 122_000);
  });

  test('persists conflict retry timing while rebasing the exact leased generation', async (t) => {
    const db = createDB(t);
    const pending = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":1}'), 1_000);
    const lease = await db.leaseDue(UID_A, 61_000, 5_000, 1);
    if (!lease?.leaseToken || lease.leaseFence === null) assert.fail('Expected lease.');

    await db.rebase(UID_A, pending.recordKey, pending.generation, lease.leaseToken, lease.leaseFence, remoteBase(3), 61_000, 500);

    assert.equal((await db.getOutbox(UID_A, pending.recordKey))?.dueAtMs, 61_500);
    assert.equal((await db.getOutbox(UID_A, pending.recordKey))?.retryAttempt, 1);
  });

  test('persists retry attempts across leases and resets them on a fresh local generation', async (t) => {
    const db = createDB(t);
    const pending = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":1}'), 1_000);
    const firstLease = await db.leaseDue(UID_A, 61_000, 5_000, 1);
    if (!firstLease?.leaseToken || firstLease.leaseFence === null) assert.fail('Expected first lease.');
    await db.retry(UID_A, pending.recordKey, pending.generation, firstLease.leaseToken, firstLease.leaseFence, 61_000, 500, 'offline');
    assert.equal((await db.getOutbox(UID_A, pending.recordKey))?.retryAttempt, 1);

    const secondLease = await db.leaseDue(UID_A, 61_500, 5_000, 2);
    if (!secondLease?.leaseToken || secondLease.leaseFence === null) assert.fail('Expected second lease.');
    await db.retry(UID_A, pending.recordKey, pending.generation, secondLease.leaseToken, secondLease.leaseFence, 61_500, 1_000, 'offline');
    assert.equal((await db.getOutbox(UID_A, pending.recordKey))?.retryAttempt, 2);

    await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":2}'), 62_000);
    assert.equal((await db.getOutbox(UID_A, pending.recordKey))?.retryAttempt, 0);
  });

  test('fenced tombstone discard releases late generation N without deleting generation N plus one', async (t) => {
    const db = createDB(t);
    const first = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":1}'), 1_000);
    const lease = await db.leaseDue(UID_A, 61_000, 5_000, 1);
    if (!lease?.leaseToken || lease.leaseFence === null) assert.fail('Expected lease.');
    const latest = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":2}'), 62_000);

    await db.discardLeasedAcrossTombstone(UID_A, first.recordKey, first.generation, lease.leaseToken, lease.leaseFence, {
      revision: 2, mutationId: 'tombstone-2', deleted: true,
    });

    const pending = await db.getOutbox(UID_A, first.recordKey);
    assert.equal(pending?.generation, latest.generation);
    assert.equal(pending?.payload, '{"value":2}');
    assert.equal(pending?.leaseToken, null);
    assert.equal(await db.getRemoteBase(UID_A, first.recordKey), null);
  });

  test('fenced tombstone discard cannot affect a re-leased owner', async (t) => {
    const db = createDB(t);
    const pending = await db.recordLocalPut(UID_A, preparedRecord('record-1', '{"value":1}'), 1_000);
    const oldLease = await db.leaseDue(UID_A, 61_000, 5_000, 1);
    const currentLease = await db.leaseDue(UID_A, 66_000, 5_000, 2);
    if (!oldLease?.leaseToken || oldLease.leaseFence === null || !currentLease?.leaseToken || currentLease.leaseFence === null)
      assert.fail('Expected both leases.');

    await db.discardLeasedAcrossTombstone(UID_A, pending.recordKey, pending.generation, oldLease.leaseToken, oldLease.leaseFence, {
      revision: 2, mutationId: 'tombstone-2', deleted: true,
    });

    const current = await db.getOutbox(UID_A, pending.recordKey);
    assert.equal(current?.leaseToken, currentLease.leaseToken);
    assert.equal(await db.getRemoteBase(UID_A, pending.recordKey), null);
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

    assert.equal(await db.block(UID_A, pending.recordKey, pending.generation, oldLease.leaseToken, oldLease.leaseFence, 'permission'), false);
    assert.equal((await db.getOutbox(UID_A, pending.recordKey))?.blocked, false);
    assert.equal(await db.block(UID_A, pending.recordKey, pending.generation, currentLease.leaseToken, currentLease.leaseFence, 'permission'), true);

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

    assert.equal(await db.quarantineLeased(UID_A, pending.recordKey, pending.generation, lease.leaseToken, lease.leaseFence, 'message-id-collision', 62_000), true);

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

    assert.equal(await db.quarantineLeased(UID_A, first.recordKey, first.generation, lease.leaseToken, lease.leaseFence, 'message-id-collision', 63_000), false);

    const pending = await db.getOutbox(UID_A, first.recordKey);
    assert.equal(pending?.generation, latest.generation);
    assert.equal(pending?.blocked, false);
    assert.equal(pending?.leaseToken, null);
    assert.equal(await db.quarantine.where('uid').equals(UID_A).count(), 0);
  });
});
