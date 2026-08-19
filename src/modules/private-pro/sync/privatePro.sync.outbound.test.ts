import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test, type TestContext } from 'node:test';

import Dexie from 'dexie';

import { privateProRecordKey } from './privatePro.sync.codec';
import type { PrivateProSyncLeaderContext } from './privatePro.sync.coordinator';
import { PrivateProSyncDB } from './privatePro.sync.db';
import {
  createPrivateProSyncOutbound,
  privateProClassifySyncError,
  privateProSyncRetryDelay,
  type PrivateProSyncCaptureFailure,
  type PrivateProSyncCaptureNotice,
  type PrivateProSyncCommittedNotice,
  type PrivateProSyncDurableCapture,
} from './privatePro.sync.outbound';
import type {
  PrivateProSyncLocalMutation,
  PrivateProSyncSerializer,
  PrivateProSyncSerializedRecord,
} from './privatePro.sync.serializers';
import {
  PrivateProSyncTransportError,
  type PrivateProSyncRemoteRecord,
  type PrivateProSyncTransport,
  type PrivateProSyncWriteInput,
  type PrivateProSyncWriteResult,
} from './privatePro.sync.transport';


const UID = 'uid-a';
const WRITER_ID = '123e4567-e89b-42d3-a456-426614174001';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolve_ => { resolve = resolve_; });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index++) {
    await Promise.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await settle();
  }
  assert.fail('Timed out waiting for deterministic test state.');
}

class ManualClock {
  nowMs = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now = (): number => this.nowMs;
  setTimeout = (callback: () => void, ms: number): ReturnType<typeof globalThis.setTimeout> => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowMs + Math.max(0, ms), callback });
    return id;
  };
  clearTimeout = (id: ReturnType<typeof globalThis.setTimeout>): void => { this.timers.delete(id); };

  set(value: number): void {
    assert.ok(value >= this.nowMs);
    this.nowMs = value;
  }

  activeTimerCount(): number {
    return this.timers.size;
  }

  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    while (true) {
      await settle();
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      this.nowMs = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await settle();
    }
    this.nowMs = target;
    await settle();
  }
}

class FakeCoordinator {
  private abortController: AbortController | null = null;
  private leadership: Promise<void> | null = null;
  wakeCount = 0;

  async start(runLeader: (context: PrivateProSyncLeaderContext) => Promise<void>): Promise<void> {
    this.abortController = new AbortController();
    this.leadership = runLeader({ signal: this.abortController.signal, coordinatorFence: 7 });
    await settle();
  }

  wake(): void {
    this.wakeCount++;
  }

  async stop(): Promise<void> {
    this.abortController?.abort();
    await this.leadership;
  }

  isLeader(): boolean {
    return !!this.abortController && !this.abortController.signal.aborted;
  }
}

class FakeTransport implements PrivateProSyncTransport {
  readonly writes: PrivateProSyncWriteInput[] = [];
  readonly results: Array<PrivateProSyncWriteResult | Error | Promise<PrivateProSyncWriteResult>> = [];

  async write(input: PrivateProSyncWriteInput): Promise<PrivateProSyncWriteResult> {
    this.writes.push(structuredClone(input));
    const result = this.results.shift() ?? { status: 'accepted' as const, revision: input.baseRevision + 1 };
    if (result instanceof Error) throw result;
    return result;
  }

  listen(): () => void {
    return () => {};
  }
}

class FakeSerializer implements PrivateProSyncSerializer<unknown> {
  readonly recordType;
  readonly schemaVersion = 1;
  private listener: ((mutation: PrivateProSyncLocalMutation) => void) | null = null;

  constructor(
    recordType: 'settings' | 'chat-message' = 'settings',
    readonly conflictPolicy: 'replace' | 'message-identity' = 'replace',
  ) {
    this.recordType = recordType;
  }

  async snapshot(): Promise<readonly PrivateProSyncSerializedRecord[]> {
    return [];
  }

  async validate(_logicalId: string, value: unknown): Promise<unknown> {
    return structuredClone(value);
  }

  project(logicalId: string): { projectionKey: string; referencedAssetIds: readonly string[] } {
    return { projectionKey: logicalId, referencedAssetIds: [] };
  }

  readonly projection = { apply: async () => {}, remove: async () => {} };

  subscribe(listener: (mutation: PrivateProSyncLocalMutation) => void): () => void {
    this.listener = listener;
    return () => { this.listener = null; };
  }

  emitPut(value: string, logicalId = 'main'): void {
    this.listener?.({ kind: 'put', record: {
      recordType: this.recordType,
      logicalId,
      projectionKey: logicalId,
      schemaVersion: 1,
      value: { value },
      referencedAssetIds: [],
    } });
  }
}

interface Harness {
  db: PrivateProSyncDB;
  clock: ManualClock;
  coordinator: FakeCoordinator;
  serializer: FakeSerializer;
  transport: FakeTransport;
  notices: PrivateProSyncCaptureNotice[];
  captured: PrivateProSyncDurableCapture[];
  failed: PrivateProSyncCaptureFailure[];
  committed: PrivateProSyncCommittedNotice[];
  statuses: string[];
  assetCalls: readonly string[][];
  outbound: ReturnType<typeof createPrivateProSyncOutbound>;
}

function remote(input: PrivateProSyncWriteInput, revision: number, contentHash = input.contentHash!): PrivateProSyncRemoteRecord {
  return {
    recordKey: input.recordKey,
    recordType: input.recordType,
    logicalId: input.logicalId,
    schemaVersion: input.schemaVersion,
    payload: input.payload,
    contentHash,
    revision,
    mutationId: '123e4567-e89b-42d3-a456-426614174002',
    writerId: WRITER_ID,
    deleted: false,
    updatedAt: 'server-time',
  };
}

function createHarness(t: TestContext, serializer = new FakeSerializer()): Harness {
  const name = `private-pro-sync-outbound-test-${crypto.randomUUID()}`;
  const db = new PrivateProSyncDB(name);
  const clock = new ManualClock();
  const coordinator = new FakeCoordinator();
  const transport = new FakeTransport();
  const notices: PrivateProSyncCaptureNotice[] = [];
  const captured: PrivateProSyncDurableCapture[] = [];
  const failed: PrivateProSyncCaptureFailure[] = [];
  const committed: PrivateProSyncCommittedNotice[] = [];
  const statuses: string[] = [];
  const assetCalls: string[][] = [];
  const outbound = createPrivateProSyncOutbound({
    uid: UID,
    writerId: WRITER_ID,
    serializers: [serializer],
    db,
    coordinator,
    transport,
    assets: { ensureUploaded: async assetIds => { assetCalls.push([...assetIds]); } },
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random: () => 0,
    onCapture: notice => notices.push(notice),
    onCaptured: notice => captured.push(notice),
    onCaptureFailed: notice => failed.push(notice),
    onCommitted: notice => committed.push(notice),
    onStatus: status => statuses.push(status.category),
  });
  t.after(async () => {
    await outbound.stop();
    db.close();
    await Dexie.delete(name);
  });
  return { db, clock, coordinator, serializer, transport, notices, captured, failed, committed, statuses, assetCalls, outbound };
}

describe('Private Pro seamless sync outbound', () => {
  test('continuous typing emits one write at the end of the first minute', async (t) => {
    const { outbound, serializer, transport, clock, db } = createHarness(t);
    await outbound.start();

    for (let second = 0; second < 60; second++) {
      clock.set(second * 1_000);
      serializer.emitPut(`value-${second}`);
      await waitFor(async () => (await db.getOutbox(UID, privateProRecordKey('settings', 'main')))?.generation === second + 1);
    }
    assert.equal(transport.writes.length, 0);
    await clock.advance(1_000);

    assert.equal(transport.writes.length, 1);
    assert.match(transport.writes[0].payload, /value-59/);
  });

  test('capturing a later record does not delay an earlier record deadline', async (t) => {
    const { outbound, transport, clock } = createHarness(t);
    await outbound.start();
    await outbound.capture({ kind: 'put', record: {
      recordType: 'settings', logicalId: 'first', projectionKey: 'first', schemaVersion: 1,
      value: { value: 'first' }, referencedAssetIds: [],
    } });
    clock.set(30_000);
    await outbound.capture({ kind: 'put', record: {
      recordType: 'settings', logicalId: 'second', projectionKey: 'second', schemaVersion: 1,
      value: { value: 'second' }, referencedAssetIds: [],
    } });

    await clock.advance(30_000);
    assert.deepEqual(transport.writes.map(write => write.logicalId), ['first']);
  });

  test('a transaction acknowledgement updates the base without clearing a newer generation', async (t) => {
    const { outbound, transport, clock, db } = createHarness(t);
    const write = deferred<PrivateProSyncWriteResult>();
    transport.results.push(write.promise);
    await outbound.start();
    const first = await outbound.capture({ kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { value: 'first' }, referencedAssetIds: [],
    } });
    await clock.advance(60_000);
    await outbound.capture({ kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { value: 'second' }, referencedAssetIds: [],
    } });
    write.resolve({ status: 'accepted', revision: 1 });
    await settle();

    const pending = await db.getOutbox(UID, first.recordKey);
    assert.equal(pending?.generation, 2);
    assert.match(pending?.payload ?? '', /second/);
    assert.equal(pending?.baseRevision, 1);
  });

  test('notifies local origin synchronously before durable capture completes', async (t) => {
    const { outbound, notices, captured, coordinator } = createHarness(t);
    let returned = false;
    const capture = outbound.capture({ kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { value: 'local' }, referencedAssetIds: [],
    } });
    returned = true;

    assert.equal(returned, true);
    assert.equal(notices.length, 1);
    assert.match(notices[0].captureId, /^[0-9a-f-]{36}$/);
    assert.equal(coordinator.wakeCount, 0);
    const durable = await capture;
    assert.equal(durable.generation, 1);
    assert.equal(captured[0].captureId, notices[0].captureId);
    assert.equal(coordinator.wakeCount, 1);
  });

  test('correlates a failed capture and the next successful capture by unique capture ID', async (t) => {
    const { outbound, notices, captured, failed } = createHarness(t);
    await assert.rejects(outbound.capture({ kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 2,
      value: { value: 'invalid' }, referencedAssetIds: [],
    } }));
    const valid = await outbound.capture({ kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { value: 'valid' }, referencedAssetIds: [],
    } });

    assert.equal(new Set(notices.map(notice => notice.captureId)).size, 2);
    assert.equal(failed[0].captureId, notices[0].captureId);
    assert.equal(failed[0].category, 'schema');
    assert.equal(captured[0].captureId, notices[1].captureId);
    assert.equal(captured[0].generation, valid.generation);
  });

  test('reports exact synthetic commit identity after accepted write', async (t) => {
    const { outbound, transport, clock, committed } = createHarness(t);
    await outbound.start();
    const pending = await outbound.capture({ kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { value: 'commit' }, referencedAssetIds: [],
    } });
    transport.results.push({ status: 'accepted', revision: 3 });

    await clock.advance(60_000);

    assert.deepEqual(committed, [{
      recordKey: pending.recordKey, generation: pending.generation, mutationId: pending.mutationId,
      revision: 3, deleted: false,
    }]);
  });

  test('retryNow preserves the normal first-minute deadline', async (t) => {
    const { outbound, transport, clock, db } = createHarness(t);
    await outbound.start();
    const pending = await outbound.capture({ kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { value: 'later' }, referencedAssetIds: [],
    } });

    await outbound.retryNow();

    assert.equal(transport.writes.length, 0);
    assert.equal((await db.getOutbox(UID, pending.recordKey))?.dueAtMs, 60_000);
    await clock.advance(60_000);
    assert.equal(transport.writes.length, 1);
  });

  test('sign-out flush drains a normal write before its first minute', async (t) => {
    const { outbound, transport, clock } = createHarness(t);
    await outbound.start();
    await outbound.capture({ kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { value: 'sign-out' }, referencedAssetIds: [],
    } });

    await outbound.flushNow();
    assert.equal(clock.nowMs, 0);
    assert.equal(transport.writes.length, 1);
  });

  test('retries an offline write with deterministic capped backoff', async (t) => {
    const { outbound, transport, clock } = createHarness(t);
    transport.results.push(new PrivateProSyncTransportError('offline'), { status: 'accepted', revision: 1 });
    await outbound.start();
    await outbound.capture({ kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { value: 'retry' }, referencedAssetIds: [],
    } });

    await clock.advance(60_000);
    assert.equal(transport.writes.length, 1);
    await clock.advance(499);
    assert.equal(transport.writes.length, 1);
    await clock.advance(1);
    assert.equal(transport.writes.length, 2);
    assert.equal(privateProSyncRetryDelay(99, () => 1), 60_000);
  });

  test('continues durable retry attempts after an outbound restart', async (t) => {
    const name = `private-pro-sync-outbound-restart-${crypto.randomUUID()}`;
    const db = new PrivateProSyncDB(name);
    const clock = new ManualClock();
    const serializer = new FakeSerializer();
    const firstCoordinator = new FakeCoordinator();
    const firstTransport = new FakeTransport();
    firstTransport.results.push(new PrivateProSyncTransportError('offline'));
    const first = createPrivateProSyncOutbound({
      uid: UID, writerId: WRITER_ID, serializers: [serializer], db, coordinator: firstCoordinator,
      transport: firstTransport, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      random: () => 0,
    });
    t.after(async () => {
      await first.stop();
      db.close();
      await Dexie.delete(name);
    });
    await first.start();
    const pending = await first.capture({ kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { value: 'retry' }, referencedAssetIds: [],
    } });
    await clock.advance(60_000);
    assert.equal((await db.getOutbox(UID, pending.recordKey))?.retryAttempt, 1);
    await first.stop();

    const secondCoordinator = new FakeCoordinator();
    const secondTransport = new FakeTransport();
    secondTransport.results.push(new PrivateProSyncTransportError('offline'));
    const second = createPrivateProSyncOutbound({
      uid: UID, writerId: WRITER_ID, serializers: [], db, coordinator: secondCoordinator,
      transport: secondTransport, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      random: () => 0,
    });
    await second.start();
    await clock.advance(500);

    const retried = await db.getOutbox(UID, pending.recordKey);
    assert.equal(secondTransport.writes.length, 1);
    assert.equal(retried?.retryAttempt, 2);
    assert.equal(retried?.dueAtMs, 61_500);
    await second.stop();
  });

  test('durably blocks a permission failure and reports only its sanitized category', async (t) => {
    const { outbound, transport, clock, db, statuses } = createHarness(t);
    transport.results.push(new PrivateProSyncTransportError('permission'));
    await outbound.start();
    const pending = await outbound.capture({ kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { value: 'private' }, referencedAssetIds: [],
    } });
    await clock.advance(60_000);

    const blocked = await db.getOutbox(UID, pending.recordKey);
    assert.equal(blocked?.blocked, true);
    assert.equal(blocked?.errorCode, 'permission');
    assert.deepEqual(statuses, ['permission']);
  });

  test('does not report a stale permission failure after a newer generation is captured', async (t) => {
    const { outbound, transport, clock, db, statuses } = createHarness(t);
    const write = deferred<PrivateProSyncWriteResult>();
    transport.results.push(write.promise);
    await outbound.start();
    const first = await outbound.capture({ kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { value: 'first' }, referencedAssetIds: [],
    } });
    await clock.advance(60_000);
    const latest = await outbound.capture({ kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { value: 'second' }, referencedAssetIds: [],
    } });
    write.resolve(Promise.reject(new PrivateProSyncTransportError('permission')));
    await settle();

    const pending = await db.getOutbox(UID, first.recordKey);
    assert.equal(pending?.generation, latest.generation);
    assert.equal(pending?.blocked, false);
    assert.deepEqual(statuses, []);
  });

  test('does not report or quarantine a stale message collision after a newer generation', async (t) => {
    const serializer = new FakeSerializer('chat-message', 'message-identity');
    const { outbound, transport, clock, db, statuses } = createHarness(t, serializer);
    const write = deferred<PrivateProSyncWriteResult>();
    transport.results.push(write.promise);
    await outbound.start();
    const first = await outbound.capture({ kind: 'put', record: {
      recordType: 'chat-message', logicalId: 'chat-1\0message-1', projectionKey: 'chat-1', schemaVersion: 1,
      value: { value: 'first' }, referencedAssetIds: [],
    } });
    await clock.advance(60_000);
    const latest = await outbound.capture({ kind: 'put', record: {
      recordType: 'chat-message', logicalId: 'chat-1\0message-1', projectionKey: 'chat-1', schemaVersion: 1,
      value: { value: 'second' }, referencedAssetIds: [],
    } });
    const input = transport.writes[0];
    write.resolve({ status: 'conflict', canonical: remote(input, 1, 'b'.repeat(64)) });
    await settle();

    const pending = await db.getOutbox(UID, first.recordKey);
    assert.equal(pending?.generation, latest.generation);
    assert.equal(pending?.blocked, false);
    assert.equal(await db.quarantine.where('uid').equals(UID).count(), 0);
    assert.deepEqual(statuses, []);
  });

  test('does not report a stale asset permission failure after a newer generation', async (t) => {
    const name = `private-pro-sync-outbound-stale-assets-${crypto.randomUUID()}`;
    const db = new PrivateProSyncDB(name);
    const clock = new ManualClock();
    const coordinator = new FakeCoordinator();
    const upload = deferred<void>();
    const statuses: string[] = [];
    const outbound = createPrivateProSyncOutbound({
      uid: UID, writerId: WRITER_ID, serializers: [new FakeSerializer()], db, coordinator,
      transport: new FakeTransport(), assets: { ensureUploaded: () => upload.promise },
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      onStatus: status => statuses.push(status.category),
    });
    t.after(async () => {
      upload.resolve();
      await outbound.stop();
      db.close();
      await Dexie.delete(name);
    });
    await outbound.start();
    const first = await outbound.capture({ kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { value: 'first' }, referencedAssetIds: ['asset-1'],
    } });
    await clock.advance(60_000);
    const latest = await outbound.capture({ kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { value: 'second' }, referencedAssetIds: ['asset-1'],
    } });
    upload.resolve(Promise.reject(new PrivateProSyncTransportError('permission')));
    await settle();

    const pending = await db.getOutbox(UID, first.recordKey);
    assert.equal(pending?.generation, latest.generation);
    assert.equal(pending?.blocked, false);
    assert.deepEqual(statuses, []);
  });

  test('rebases a replace record and retries from the canonical revision', async (t) => {
    const { outbound, transport, clock } = createHarness(t);
    await outbound.start();
    const pending = await outbound.capture({ kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { value: 'local' }, referencedAssetIds: [],
    } });
    const firstInput: PrivateProSyncWriteInput = {
      recordKey: pending.recordKey, recordType: 'settings', logicalId: 'main', schemaVersion: 1,
      kind: 'put', payload: pending.payload, contentHash: pending.contentHash, baseRevision: 0,
      mutationId: pending.mutationId, writerId: WRITER_ID,
    };
    transport.results.push({ status: 'conflict', canonical: remote(firstInput, 3) }, { status: 'accepted', revision: 4 });

    await clock.advance(60_000);
    await clock.advance(500);
    assert.deepEqual(transport.writes.map(write => write.baseRevision), [0, 3]);
  });

  test('quarantines a message identity collision with different canonical content', async (t) => {
    const serializer = new FakeSerializer('chat-message', 'message-identity');
    const { outbound, transport, clock, db } = createHarness(t, serializer);
    await outbound.start();
    const pending = await outbound.capture({ kind: 'put', record: {
      recordType: 'chat-message', logicalId: 'chat-1\0message-1', projectionKey: 'chat-1', schemaVersion: 1,
      value: { value: 'local' }, referencedAssetIds: [],
    } });
    const input: PrivateProSyncWriteInput = {
      recordKey: pending.recordKey, recordType: 'chat-message', logicalId: 'chat-1\0message-1', schemaVersion: 1,
      kind: 'put', payload: pending.payload, contentHash: pending.contentHash, baseRevision: 0,
      mutationId: pending.mutationId, writerId: WRITER_ID,
    };
    transport.results.push({ status: 'conflict', canonical: remote(input, 1, 'b'.repeat(64)) });
    await clock.advance(60_000);

    assert.equal((await db.getOutbox(UID, pending.recordKey))?.blocked, true);
    assert.equal((await db.quarantine.where('uid').equals(UID).first())?.reasonCode, 'message-id-collision');
  });

  test('discards a stale put when the canonical record is deleted', async (t) => {
    const { outbound, transport, clock, db } = createHarness(t);
    await outbound.start();
    const pending = await outbound.capture({ kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { value: 'stale' }, referencedAssetIds: [],
    } });
    const input: PrivateProSyncWriteInput = {
      recordKey: pending.recordKey, recordType: 'settings', logicalId: 'main', schemaVersion: 1,
      kind: 'put', payload: pending.payload, contentHash: pending.contentHash, baseRevision: 0,
      mutationId: pending.mutationId, writerId: WRITER_ID,
    };
    transport.results.push({ status: 'deleted', canonical: { ...remote(input, 2), payload: '', deleted: true } });
    await clock.advance(60_000);

    assert.equal(await db.getOutbox(UID, pending.recordKey), null);
    assert.equal(await db.getLocalRecord(UID, pending.recordKey), null);
    assert.deepEqual(await db.getRemoteBase(UID, pending.recordKey), { revision: 2, mutationId: '123e4567-e89b-42d3-a456-426614174002', deleted: true });
  });

  test('acknowledges a delete when the canonical record is already deleted', async (t) => {
    const { outbound, transport, clock, db } = createHarness(t);
    await outbound.start();
    const pending = await outbound.capture({
      kind: 'delete', recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
    });
    const input: PrivateProSyncWriteInput = {
      recordKey: pending.recordKey, recordType: 'settings', logicalId: 'main', schemaVersion: 1,
      kind: 'delete', payload: '', contentHash: null, baseRevision: 0,
      mutationId: pending.mutationId, writerId: WRITER_ID,
    };
    transport.results.push({ status: 'deleted', canonical: { ...remote(input, 2, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'), payload: '', deleted: true } });
    await clock.advance(60_000);

    assert.equal(await db.getOutbox(UID, pending.recordKey), null);
    assert.deepEqual(await db.getRemoteBase(UID, pending.recordKey), { revision: 2, mutationId: '123e4567-e89b-42d3-a456-426614174002', deleted: true });
  });

  test('uploads referenced assets before writing and releases an aborted lease immediately', async (t) => {
    const { outbound, transport, clock, db, assetCalls } = createHarness(t);
    const write = deferred<PrivateProSyncWriteResult>();
    transport.results.push(write.promise);
    await outbound.start();
    const pending = await outbound.capture({ kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { value: 'asset' }, referencedAssetIds: ['asset-1'],
    } });
    await clock.advance(60_000);
    assert.deepEqual(assetCalls, [['asset-1']]);

    await outbound.stop();
    const released = await db.getOutbox(UID, pending.recordKey);
    assert.equal(released?.leaseUntilMs, null);
    assert.equal(released?.dueAtMs, 60_000);
    assert.equal(clock.activeTimerCount(), 0);
  });

  test('stop releases a lease without waiting for a stalled asset upload', async (t) => {
    const name = `private-pro-sync-outbound-assets-${crypto.randomUUID()}`;
    const db = new PrivateProSyncDB(name);
    const clock = new ManualClock();
    const coordinator = new FakeCoordinator();
    const transport = new FakeTransport();
    const stalled = deferred<void>();
    const outbound = createPrivateProSyncOutbound({
      uid: UID, writerId: WRITER_ID, serializers: [new FakeSerializer()], db, coordinator, transport,
      assets: { ensureUploaded: () => stalled.promise },
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    });
    t.after(async () => {
      stalled.resolve();
      await outbound.stop();
      db.close();
      await Dexie.delete(name);
    });
    await outbound.start();
    const pending = await outbound.capture({ kind: 'put', record: {
      recordType: 'settings', logicalId: 'main', projectionKey: 'main', schemaVersion: 1,
      value: { value: 'asset' }, referencedAssetIds: ['asset-1'],
    } });
    await clock.advance(60_000);

    await outbound.stop();
    const released = await db.getOutbox(UID, pending.recordKey);
    assert.equal(released?.leaseToken, null);
    assert.equal(released?.retryAttempt, 0);
    assert.equal(released?.dueAtMs, 60_000);
    assert.equal(transport.writes.length, 0);
  });

  test('classifies only fixed safe error categories', () => {
    assert.equal(privateProClassifySyncError(new PrivateProSyncTransportError('offline')), 'offline');
    assert.equal(privateProClassifySyncError(new RangeError('secret payload detail')), 'schema');
    assert.equal(privateProClassifySyncError(new Error('secret network detail')), 'offline');
  });

  test('has no runtime apply capability or runtime store import', async () => {
    const source = await readFile(new URL('./privatePro.sync.outbound.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\.apply\s*\(/);
    assert.doesNotMatch(source, /(?:common\/stores|store-[A-Za-z0-9_-]+)/);
  });
});
