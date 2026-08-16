import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import Dexie from 'dexie';

import { PrivateProSyncDB } from './privatePro.sync.db';
import {
  createPrivateProSyncEngine,
  type PrivateProLocalEntity,
  type PrivateProLocalStorePort,
  type PrivateProRemoteEvent,
  type PrivateProSyncTransport,
} from './privatePro.sync.engine';


function createDB(t: TestContext) {
  const name = `private-pro-engine-${crypto.randomUUID()}`;
  const db = new PrivateProSyncDB(name);
  t.after(async () => {
    db.close();
    await Dexie.delete(name);
  });
  return db;
}

function entity(entityType: 'chat' | 'persona', id: string, value: string): PrivateProLocalEntity {
  return {
    entityType,
    entityId: id,
    contentHash: value.padEnd(64, value).slice(0, 64).replace(/[^a-f0-9]/g, 'a'),
    payload: { schemaVersion: 1, value },
  };
}

class FakeStore implements PrivateProLocalStorePort {
  entities = new Map<string, PrivateProLocalEntity>();
  conflicts: PrivateProLocalEntity[] = [];
  listeners = new Set<() => void>();
  applyingRemote = false;

  constructor(initial: PrivateProLocalEntity[] = []) {
    initial.forEach(item => this.entities.set(`${item.entityType}:${item.entityId}`, structuredClone(item)));
  }

  async snapshot() {
    return [...this.entities.values()].map(item => structuredClone(item));
  }

  async get(entityType: 'chat' | 'persona', entityId: string) {
    return structuredClone(this.entities.get(`${entityType}:${entityId}`) ?? null);
  }

  async applyUpsert(entity: PrivateProLocalEntity) {
    this.applyingRemote = true;
    this.entities.set(`${entity.entityType}:${entity.entityId}`, structuredClone(entity));
    this.emit();
    this.applyingRemote = false;
  }

  async applyDelete(entityType: 'chat' | 'persona', entityId: string) {
    this.applyingRemote = true;
    this.entities.delete(`${entityType}:${entityId}`);
    this.emit();
    this.applyingRemote = false;
  }

  async createConflictCopy(source: PrivateProLocalEntity) {
    const copy = structuredClone(source);
    copy.entityId = `${source.entityId}-conflict-${this.conflicts.length + 1}`;
    copy.contentHash = 'f'.repeat(64 - String(this.conflicts.length + 1).length) + String(this.conflicts.length + 1);
    this.conflicts.push(copy);
    this.entities.set(`${copy.entityType}:${copy.entityId}`, copy);
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  putLocal(item: PrivateProLocalEntity) {
    this.entities.set(`${item.entityType}:${item.entityId}`, structuredClone(item));
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}

class FakeTransport implements PrivateProSyncTransport {
  online = true;
  remote = new Map<string, PrivateProRemoteEvent>();
  writes: string[] = [];
  listener: ((event: PrivateProRemoteEvent) => void) | null = null;

  async upsert(operation: { entityType: 'chat' | 'persona'; entityId: string; contentHash: string; payload: unknown; baseRevision: number }) {
    if (!this.online) throw new TypeError('offline');
    const key = `${operation.entityType}:${operation.entityId}`;
    const current = this.remote.get(key);
    const currentRevision = current?.revision ?? 0;
    const currentHash = current?.kind === 'upsert' ? current.entity.contentHash : null;
    if (currentRevision !== operation.baseRevision)
      return { status: 'conflict' as const, currentRevision, currentHash };
    const revision = operation.baseRevision + 1;
    const event: PrivateProRemoteEvent = {
      kind: 'upsert',
      revision,
      entity: {
        entityType: operation.entityType,
        entityId: operation.entityId,
        contentHash: operation.contentHash,
        payload: structuredClone(operation.payload),
      },
    };
    this.remote.set(key, event);
    this.writes.push(key);
    return { status: 'committed' as const, revision };
  }

  async delete(operation: { entityType: 'chat' | 'persona'; entityId: string; baseRevision: number }) {
    if (!this.online) throw new TypeError('offline');
    const key = `${operation.entityType}:${operation.entityId}`;
    const current = this.remote.get(key);
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== operation.baseRevision)
      return { status: 'conflict' as const, currentRevision, currentHash: current?.kind === 'upsert' ? current.entity.contentHash : null };
    const revision = operation.baseRevision + 1;
    this.remote.set(key, { kind: 'delete', entityType: operation.entityType, entityId: operation.entityId, revision });
    this.writes.push(key);
    return { status: 'deleted' as const, revision };
  }

  async fetch(entityType: 'chat' | 'persona', entityId: string) {
    return structuredClone(this.remote.get(`${entityType}:${entityId}`) ?? null);
  }

  subscribe(_uid: string, listener: (event: PrivateProRemoteEvent) => void) {
    this.listener = listener;
    return () => { this.listener = null; };
  }

  emit(event: PrivateProRemoteEvent) {
    this.remote.set(event.kind === 'upsert'
      ? `${event.entity.entityType}:${event.entity.entityId}`
      : `${event.entityType}:${event.entityId}`, structuredClone(event));
    this.listener?.(structuredClone(event));
  }
}


describe('private Pro sync engine', () => {
  test('automatically migrates existing local entities and resumes idempotently', async (t) => {
    const db = createDB(t);
    const store = new FakeStore([entity('chat', 'chat-1', 'a'), entity('persona', 'persona-1', 'b')]);
    const transport = new FakeTransport();
    const engine = createPrivateProSyncEngine({ uid: 'uid-a', deviceId: 'device-a', db, store, transport, now: () => 1000 });

    assert.equal(await engine.start(), 'started');
    await engine.whenIdle();

    assert.deepEqual(transport.writes.sort(), ['chat:chat-1', 'persona:persona-1']);
    assert.equal(await db.outboxCount('uid-a'), 0);
    assert.equal((await db.getMigrationItem('uid-a', 'chat:chat-1'))?.status, 'complete');

    await engine.scanNow();
    await engine.whenIdle();
    assert.equal(transport.writes.length, 2);
    engine.stop();
  });

  test('blocks a different account from the same local vault', async (t) => {
    const db = createDB(t);
    assert.deepEqual(await db.bindVault('uid-a'), { status: 'bound', uid: 'uid-a' });
    const engine = createPrivateProSyncEngine({
      uid: 'uid-b', deviceId: 'device-b', db, store: new FakeStore(), transport: new FakeTransport(), now: () => 1000,
    });

    assert.equal(await engine.start(), 'binding-conflict');
  });

  test('keeps an offline operation and drains it after reconnect', async (t) => {
    const db = createDB(t);
    const store = new FakeStore([entity('chat', 'chat-1', 'a')]);
    const transport = new FakeTransport();
    transport.online = false;
    const engine = createPrivateProSyncEngine({ uid: 'uid-a', deviceId: 'device-a', db, store, transport, now: () => 1000 });

    await engine.start();
    await engine.whenIdle();
    assert.equal(await db.outboxCount('uid-a'), 1);

    transport.online = true;
    await engine.retryNow();
    await engine.whenIdle();
    assert.equal(await db.outboxCount('uid-a'), 0);
    assert.deepEqual(transport.writes, ['chat:chat-1']);
    engine.stop();
  });

  test('applies remote updates without echo-uploading them', async (t) => {
    const db = createDB(t);
    const store = new FakeStore();
    const transport = new FakeTransport();
    const engine = createPrivateProSyncEngine({ uid: 'uid-a', deviceId: 'device-a', db, store, transport, now: () => 1000 });
    await engine.start();

    transport.emit({ kind: 'upsert', revision: 3, entity: entity('chat', 'remote-chat', 'c') });
    await engine.whenIdle();

    assert.equal((await store.get('chat', 'remote-chat'))?.contentHash, entity('chat', 'remote-chat', 'c').contentHash);
    assert.equal(transport.writes.length, 0);
    assert.equal(await db.outboxCount('uid-a'), 0);
    engine.stop();
  });

  test('preserves unsynced local edits before applying a remote deletion', async (t) => {
    const db = createDB(t);
    const original = entity('chat', 'chat-1', 'a');
    const store = new FakeStore([original]);
    await db.putEntityState({
      uid: 'uid-a', entityKey: 'chat:chat-1', entityType: 'chat', entityId: 'chat-1',
      remoteRevision: 1, localHash: original.contentHash, remoteHash: original.contentHash, updatedAtMs: 100,
    });
    const transport = new FakeTransport();
    transport.remote.set('chat:chat-1', { kind: 'upsert', revision: 1, entity: original });
    const engine = createPrivateProSyncEngine({ uid: 'uid-a', deviceId: 'device-a', db, store, transport, now: () => 1000 });
    await engine.start();
    await engine.whenIdle();
    transport.online = false;
    store.putLocal(entity('chat', 'chat-1', 'd'));

    transport.emit({ kind: 'delete', entityType: 'chat', entityId: 'chat-1', revision: 2 });
    await engine.whenIdle();

    assert.equal(await store.get('chat', 'chat-1'), null);
    assert.equal(store.conflicts.length, 1);
    assert.equal(store.conflicts[0].payload && (store.conflicts[0].payload as { value: string }).value, 'd');
    engine.stop();
  });

  test('preserves a local conflict and replaces the canonical entity with the remote winner', async (t) => {
    const db = createDB(t);
    const local = entity('chat', 'chat-1', 'a');
    const remote = entity('chat', 'chat-1', 'b');
    const store = new FakeStore([local]);
    const transport = new FakeTransport();
    transport.remote.set('chat:chat-1', { kind: 'upsert', revision: 2, entity: remote });
    const engine = createPrivateProSyncEngine({ uid: 'uid-a', deviceId: 'device-a', db, store, transport, now: () => 1000 });

    await engine.start();
    await engine.whenIdle();

    assert.equal(store.conflicts.length, 1);
    assert.equal((await store.get('chat', 'chat-1'))?.contentHash, remote.contentHash);
    assert.equal(await db.outboxCount('uid-a'), 0);
    engine.stop();
  });

  test('quarantines an invalid remote event without changing local state', async (t) => {
    const db = createDB(t);
    const store = new FakeStore();
    const transport = new FakeTransport();
    const engine = createPrivateProSyncEngine({ uid: 'uid-a', deviceId: 'device-a', db, store, transport, now: () => 1000 });
    await engine.start();

    transport.listener?.({ kind: 'upsert', revision: 1, entity: { entityType: 'chat', entityId: '', contentHash: 'bad', payload: null } });
    await engine.whenIdle();

    assert.equal((await db.listQuarantine('uid-a')).length, 1);
    assert.equal((await store.snapshot()).length, 0);
    engine.stop();
  });
});
