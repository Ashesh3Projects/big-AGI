import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import Dexie from 'dexie';

import { PrivateProSyncDB } from './privatePro.sync.db';


function createDB(t: TestContext) {
  const name = `private-pro-test-${crypto.randomUUID()}`;
  const db = new PrivateProSyncDB(name);
  t.after(async () => {
    db.close();
    await Dexie.delete(name);
  });
  return db;
}


describe('private Pro sync database', () => {
  test('binds once and blocks a different account', async (t) => {
    const db = createDB(t);

    assert.deepEqual(await db.bindVault('uid-a'), { status: 'bound', uid: 'uid-a' });
    assert.deepEqual(await db.bindVault('uid-a'), { status: 'already-bound', uid: 'uid-a' });
    assert.deepEqual(await db.bindVault('uid-b'), { status: 'binding-conflict', uid: 'uid-a' });
  });

  test('deduplicates the same entity content operation', async (t) => {
    const db = createDB(t);
    const operation = {
      uid: 'uid-a',
      entityType: 'chat' as const,
      entityId: 'chat-1',
      kind: 'upsert' as const,
      baseRevision: 0,
      contentHash: 'a'.repeat(64),
      payload: { schemaVersion: 1 },
      deviceId: 'device-1',
      createdAtMs: 100,
    };

    const firstId = await db.enqueueOperation(operation);
    const secondId = await db.enqueueOperation(operation);

    assert.equal(secondId, firstId);
    assert.equal(await db.outboxCount('uid-a'), 1);
  });

  test('leases one due operation exclusively and recovers an expired lease', async (t) => {
    const db = createDB(t);
    await db.enqueueOperation({
      uid: 'uid-a', entityType: 'persona', entityId: 'persona-1', kind: 'upsert', baseRevision: 0,
      contentHash: 'b'.repeat(64), payload: { schemaVersion: 1 }, deviceId: 'device-1', createdAtMs: 100,
    });

    const firstLease = await db.leaseNextOperation('uid-a', 1000, 500);
    const overlappingLease = await db.leaseNextOperation('uid-a', 1200, 500);
    const recoveredLease = await db.leaseNextOperation('uid-a', 1600, 500);

    assert.notEqual(firstLease, null);
    assert.equal(overlappingLease, null);
    assert.equal(recoveredLease?.id, firstLease?.id);
  });

  test('schedules retries and increments attempts', async (t) => {
    const db = createDB(t);
    const id = await db.enqueueOperation({
      uid: 'uid-a', entityType: 'chat', entityId: 'chat-1', kind: 'delete', baseRevision: 2,
      contentHash: 'delete', payload: null, deviceId: 'device-1', createdAtMs: 100,
    });
    await db.leaseNextOperation('uid-a', 1000, 500);

    await db.retryOperation(id, 'offline', 1100, 3000);
    const operation = await db.getOutboxOperation(id);

    assert.equal(operation?.attempts, 1);
    assert.equal(operation?.availableAtMs, 4100);
    assert.equal(operation?.leaseUntilMs, 0);
    assert.equal(operation?.lastError, 'offline');
  });

  test('acknowledges an operation and updates entity state atomically', async (t) => {
    const db = createDB(t);
    const id = await db.enqueueOperation({
      uid: 'uid-a', entityType: 'chat', entityId: 'chat-1', kind: 'upsert', baseRevision: 0,
      contentHash: 'c'.repeat(64), payload: { schemaVersion: 1 }, deviceId: 'device-1', createdAtMs: 100,
    });

    await db.ackOperation(id, {
      uid: 'uid-a', entityKey: 'chat:chat-1', entityType: 'chat', entityId: 'chat-1', remoteRevision: 1,
      localHash: 'c'.repeat(64), remoteHash: 'c'.repeat(64), updatedAtMs: 200,
    });

    assert.equal(await db.getOutboxOperation(id), undefined);
    assert.equal((await db.getEntityState('uid-a', 'chat:chat-1'))?.remoteRevision, 1);
  });

  test('persists resumable migration and quarantine records', async (t) => {
    const db = createDB(t);

    await db.recordMigrationItem({
      uid: 'uid-a', entityType: 'chat', entityId: 'chat-1', status: 'pending', updatedAtMs: 100,
    });
    await db.recordMigrationItem({
      uid: 'uid-a', entityType: 'chat', entityId: 'chat-1', status: 'complete', updatedAtMs: 200,
    });
    await db.quarantineRemoteRecord({
      uid: 'uid-a', entityKey: 'chat:chat-bad', reason: 'invalid schema', payload: { bad: true }, createdAtMs: 300,
    });

    assert.equal((await db.getMigrationItem('uid-a', 'chat:chat-1'))?.status, 'complete');
    assert.equal((await db.listQuarantine('uid-a')).length, 1);
  });
});
