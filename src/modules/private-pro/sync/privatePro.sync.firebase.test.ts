import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { privateProRecordKey } from './privatePro.sync.codec';
import {
  createPrivateProFirebaseSyncTransport,
  type PrivateProFirestorePort,
  type PrivateProFirestoreTransactionPort,
} from './privatePro.sync.firebase';
import { PrivateProSyncTransportError, type PrivateProSyncWriteInput } from './privatePro.sync.transport';


const UID = 'user-1';
const MUTATION_ID = '123e4567-e89b-12d3-a456-426614174000';
const OTHER_MUTATION_ID = '123e4567-e89b-12d3-a456-426614174002';
const WRITER_ID = '123e4567-e89b-12d3-a456-426614174001';
const CONTENT_HASH = 'a'.repeat(64);
const EMPTY_CONTENT_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ROOT = `users/${UID}/workspaces/v1`;

type Listener = {
  next: (changes: readonly {
    type: 'added' | 'modified' | 'removed';
    id: string;
    data: unknown;
    hasPendingWrites: boolean;
  }[], current?: boolean) => void;
  error: (error: unknown) => void;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

class FakeFirestore implements PrivateProFirestorePort {
  readonly documents = new Map<string, unknown>();
  readonly writes: Array<{ path: string; data: unknown }> = [];
  readonly listeners = new Map<string, Listener>();
  readonly unsubscribed: string[] = [];
  transactionError: unknown = null;
  transactionCalls = 0;

  async runTransaction<T>(callback: (transaction: PrivateProFirestoreTransactionPort) => Promise<T>): Promise<T> {
    this.transactionCalls++;
    if (this.transactionError) throw this.transactionError;
    const pending: Array<{ path: string; data: unknown }> = [];
    const result = await callback({
      get: async path => this.documents.has(path) ? clone(this.documents.get(path)) : null,
      set: (path, data) => { pending.push({ path, data: clone(data) }); },
    });
    for (const write of pending) {
      this.documents.set(write.path, clone(write.data));
      this.writes.push(write);
    }
    return result;
  }

  listenCollection(path: string, options: { includeMetadataChanges: true }, listener: Listener): () => void {
    assert.deepEqual(options, { includeMetadataChanges: true });
    this.listeners.set(path, listener);
    return () => { this.unsubscribed.push(path); };
  }

  serverTimestamp(): unknown {
    return 'server-time';
  }
}

function putInput(overrides: Partial<PrivateProSyncWriteInput> = {}): PrivateProSyncWriteInput {
  const logicalId = overrides.logicalId ?? 'settings-main';
  const recordType = overrides.recordType ?? 'settings';
  return {
    recordKey: privateProRecordKey(recordType, logicalId),
    recordType,
    logicalId,
    schemaVersion: 1,
    kind: 'put',
    payload: '{"value":1}',
    contentHash: CONTENT_HASH,
    baseRevision: 0,
    mutationId: MUTATION_ID,
    writerId: WRITER_ID,
    ...overrides,
  };
}

function canonical(input: PrivateProSyncWriteInput, revision: number, deleted = false) {
  return {
    recordType: input.recordType,
    logicalId: input.logicalId,
    schemaVersion: input.schemaVersion,
    payload: deleted ? '' : input.payload,
    contentHash: deleted ? EMPTY_CONTENT_HASH : input.contentHash,
    revision,
    mutationId: input.mutationId,
    writerId: input.writerId,
    deleted,
    updatedAt: 'server-time',
  };
}

describe('Private Pro direct Firebase sync transport', () => {
  test('creates revision 1 from a missing record at base revision 0', async () => {
    const firestore = new FakeFirestore();
    const input = putInput();
    const transport = createPrivateProFirebaseSyncTransport(UID, firestore);

    assert.deepEqual(await transport.write(input), { status: 'accepted', revision: 1 });
    assert.deepEqual(firestore.documents.get(`${ROOT}/records/${input.recordKey}`), canonical(input, 1));
    assert.deepEqual(firestore.documents.get(`${ROOT}/mutationReceipts/${MUTATION_ID}`), {
      schemaVersion: 1,
      mutationId: MUTATION_ID,
      recordKey: input.recordKey,
      recordType: 'settings',
      logicalId: 'settings-main',
      kind: 'put',
      contentHash: CONTENT_HASH,
      revision: 1,
      writerId: WRITER_ID,
      committedAt: 'server-time',
    });
  });

  test('writes exactly the next revision when the base matches', async () => {
    const firestore = new FakeFirestore();
    const input = putInput({ baseRevision: 3 });
    firestore.documents.set(`${ROOT}/records/${input.recordKey}`, canonical({ ...input, mutationId: OTHER_MUTATION_ID }, 3));

    assert.deepEqual(await createPrivateProFirebaseSyncTransport(UID, firestore).write(input), { status: 'accepted', revision: 4 });
    assert.equal((firestore.documents.get(`${ROOT}/records/${input.recordKey}`) as { revision: number }).revision, 4);
  });

  test('uses the dedicated assets collection for asset records', async () => {
    const firestore = new FakeFirestore();
    const input = putInput({ recordType: 'asset', logicalId: 'asset-1' });
    input.recordKey = privateProRecordKey(input.recordType, input.logicalId);

    assert.deepEqual(await createPrivateProFirebaseSyncTransport(UID, firestore).write(input), { status: 'accepted', revision: 1 });
    assert.equal(firestore.documents.has(`${ROOT}/assets/${input.recordKey}`), true);
    assert.equal(firestore.documents.has(`${ROOT}/records/${input.recordKey}`), false);
  });

  test('returns an exact existing mutation receipt without rewriting', async () => {
    const firestore = new FakeFirestore();
    const input = putInput({ baseRevision: 2 });
    firestore.documents.set(`${ROOT}/mutationReceipts/${MUTATION_ID}`, {
      schemaVersion: 1, mutationId: MUTATION_ID, recordKey: input.recordKey, recordType: input.recordType,
      logicalId: input.logicalId, kind: 'put', contentHash: CONTENT_HASH, revision: 3,
      writerId: WRITER_ID, committedAt: 'earlier-server-time',
    });

    assert.deepEqual(await createPrivateProFirebaseSyncTransport(UID, firestore).write(input), { status: 'already-committed', revision: 3 });
    assert.equal(firestore.writes.length, 0);
  });

  test('rejects a reused mutation ID whose immutable identity differs', async () => {
    const firestore = new FakeFirestore();
    const input = putInput();
    firestore.documents.set(`${ROOT}/mutationReceipts/${MUTATION_ID}`, {
      schemaVersion: 1, mutationId: MUTATION_ID, recordKey: input.recordKey, recordType: input.recordType,
      logicalId: input.logicalId, kind: 'put', contentHash: 'b'.repeat(64), revision: 1,
      writerId: WRITER_ID, committedAt: 'earlier-server-time',
    });

    await assert.rejects(createPrivateProFirebaseSyncTransport(UID, firestore).write(input), error => {
      assert.equal((error as PrivateProSyncTransportError).category, 'unknown');
      assert.doesNotMatch(String(error), /contentHash|receipt identity|bbbb/);
      return true;
    });
    assert.equal(firestore.writes.length, 0);
  });

  test('rejects a valid receipt whose revision is not this requested next revision', async () => {
    const firestore = new FakeFirestore();
    const input = putInput({ baseRevision: 2 });
    firestore.documents.set(`${ROOT}/mutationReceipts/${MUTATION_ID}`, {
      schemaVersion: 1, mutationId: MUTATION_ID, recordKey: input.recordKey, recordType: input.recordType,
      logicalId: input.logicalId, kind: 'put', contentHash: CONTENT_HASH, revision: 4,
      writerId: WRITER_ID, committedAt: 'earlier-server-time',
    });

    await assert.rejects(createPrivateProFirebaseSyncTransport(UID, firestore).write(input), PrivateProSyncTransportError);
    assert.equal(firestore.writes.length, 0);
  });

  test('rejects a mutation receipt that fails the strict receipt schema', async () => {
    const firestore = new FakeFirestore();
    const input = putInput();
    firestore.documents.set(`${ROOT}/mutationReceipts/${MUTATION_ID}`, {
      schemaVersion: 1, mutationId: MUTATION_ID, recordKey: input.recordKey, recordType: input.recordType,
      logicalId: input.logicalId, kind: 'put', contentHash: CONTENT_HASH, revision: 1,
      writerId: WRITER_ID, committedAt: 'earlier-server-time', unexpected: true,
    });

    await assert.rejects(createPrivateProFirebaseSyncTransport(UID, firestore).write(input), PrivateProSyncTransportError);
    assert.equal(firestore.writes.length, 0);
  });

  test('returns the parsed canonical record on a base revision conflict', async () => {
    const firestore = new FakeFirestore();
    const input = putInput();
    const remote = canonical({ ...input, mutationId: OTHER_MUTATION_ID }, 2);
    firestore.documents.set(`${ROOT}/records/${input.recordKey}`, remote);

    assert.deepEqual(await createPrivateProFirebaseSyncTransport(UID, firestore).write(input), {
      status: 'conflict', canonical: { recordKey: input.recordKey, ...remote },
    });
    assert.equal(firestore.writes.length, 0);
  });

  test('returns deleted for a put against a deleted canonical record', async () => {
    const firestore = new FakeFirestore();
    const input = putInput({ baseRevision: 2 });
    const remote = canonical({ ...input, mutationId: OTHER_MUTATION_ID }, 2, true);
    firestore.documents.set(`${ROOT}/records/${input.recordKey}`, remote);

    assert.deepEqual(await createPrivateProFirebaseSyncTransport(UID, firestore).write(input), {
      status: 'deleted', canonical: { recordKey: input.recordKey, ...remote },
    });
    assert.equal(firestore.writes.length, 0);
  });

  test('returns deleted for a put when the immutable tombstone and deleted canonical record exist', async () => {
    const firestore = new FakeFirestore();
    const input = putInput({ baseRevision: 2 });
    const remote = canonical({ ...input, mutationId: OTHER_MUTATION_ID }, 2, true);
    firestore.documents.set(`${ROOT}/records/${input.recordKey}`, remote);
    firestore.documents.set(`${ROOT}/tombstones/${input.recordKey}`, {
      recordKey: input.recordKey, recordType: input.recordType, logicalId: input.logicalId,
      deletedRevision: 2, mutationId: OTHER_MUTATION_ID, writerId: WRITER_ID, deletedAt: 'server-time',
    });

    assert.deepEqual(await createPrivateProFirebaseSyncTransport(UID, firestore).write(input), {
      status: 'deleted', canonical: { recordKey: input.recordKey, ...remote },
    });
    assert.equal(firestore.writes.length, 0);
  });

  test('rejects a put when a tombstone exists without a matching deleted canonical record', async () => {
    const firestore = new FakeFirestore();
    const input = putInput();
    firestore.documents.set(`${ROOT}/tombstones/${input.recordKey}`, {
      recordKey: input.recordKey, recordType: input.recordType, logicalId: input.logicalId,
      deletedRevision: 1, mutationId: OTHER_MUTATION_ID, writerId: WRITER_ID, deletedAt: 'server-time',
    });

    await assert.rejects(createPrivateProFirebaseSyncTransport(UID, firestore).write(input), PrivateProSyncTransportError);
    assert.equal(firestore.writes.length, 0);
  });

  test('rejects a put when a tombstone exists beside a live canonical record', async () => {
    const firestore = new FakeFirestore();
    const input = putInput({ baseRevision: 1 });
    firestore.documents.set(`${ROOT}/records/${input.recordKey}`, canonical({ ...input, mutationId: OTHER_MUTATION_ID }, 1));
    firestore.documents.set(`${ROOT}/tombstones/${input.recordKey}`, {
      recordKey: input.recordKey, recordType: input.recordType, logicalId: input.logicalId,
      deletedRevision: 1, mutationId: OTHER_MUTATION_ID, writerId: WRITER_ID, deletedAt: 'server-time',
    });

    await assert.rejects(createPrivateProFirebaseSyncTransport(UID, firestore).write(input), PrivateProSyncTransportError);
    assert.equal(firestore.writes.length, 0);
  });

  test('deletes by updating the canonical record and creating one tombstone', async () => {
    const firestore = new FakeFirestore();
    const input = putInput({ kind: 'delete', baseRevision: 1, payload: '', contentHash: null });
    firestore.documents.set(`${ROOT}/records/${input.recordKey}`, canonical({ ...putInput(), mutationId: OTHER_MUTATION_ID }, 1));

    assert.deepEqual(await createPrivateProFirebaseSyncTransport(UID, firestore).write(input), { status: 'accepted', revision: 2 });
    assert.deepEqual(firestore.documents.get(`${ROOT}/records/${input.recordKey}`), canonical({ ...input, contentHash: EMPTY_CONTENT_HASH }, 2, true));
    assert.deepEqual(firestore.documents.get(`${ROOT}/tombstones/${input.recordKey}`), {
      recordKey: input.recordKey, recordType: input.recordType, logicalId: input.logicalId,
      deletedRevision: 2, mutationId: MUTATION_ID, writerId: WRITER_ID, deletedAt: 'server-time',
    });
    assert.equal(firestore.writes.filter(write => write.path.includes('/tombstones/')).length, 1);
  });

  test('does not overwrite a pre-existing tombstone', async () => {
    const firestore = new FakeFirestore();
    const input = putInput({ kind: 'delete', baseRevision: 1, payload: '', contentHash: null });
    firestore.documents.set(`${ROOT}/records/${input.recordKey}`, canonical({ ...putInput(), mutationId: OTHER_MUTATION_ID }, 1));
    firestore.documents.set(`${ROOT}/tombstones/${input.recordKey}`, { invalid: 'existing' });

    await assert.rejects(createPrivateProFirebaseSyncTransport(UID, firestore).write(input), PrivateProSyncTransportError);
    assert.equal(firestore.writes.length, 0);
  });

  test('rejects canonical identity that does not match the requested path', async () => {
    const firestore = new FakeFirestore();
    const input = putInput();
    firestore.documents.set(`${ROOT}/records/${input.recordKey}`, {
      ...canonical({ ...input, mutationId: OTHER_MUTATION_ID }, 1), logicalId: 'other-settings',
    });

    await assert.rejects(createPrivateProFirebaseSyncTransport(UID, firestore).write(input), PrivateProSyncTransportError);
  });

  test('ignores pending listener echoes and emits schema-parsed committed events', () => {
    const firestore = new FakeFirestore();
    const input = putInput();
    const events: unknown[] = [];
    const transport = createPrivateProFirebaseSyncTransport(UID, firestore);
    const unsubscribe = transport.listen(event => events.push(event));

    firestore.listeners.get(`${ROOT}/records`)!.next([
      { type: 'added', id: input.recordKey, data: canonical(input, 1), hasPendingWrites: true },
      { type: 'modified', id: input.recordKey, data: canonical(input, 2), hasPendingWrites: false },
    ]);
    firestore.listeners.get(`${ROOT}/tombstones`)!.next([{
      type: 'added', id: input.recordKey, hasPendingWrites: false,
      data: { recordKey: input.recordKey, recordType: input.recordType, logicalId: input.logicalId, deletedRevision: 3, mutationId: MUTATION_ID, writerId: WRITER_ID, deletedAt: 'server-time' },
    }]);

    assert.deepEqual(events, [
      { type: 'record', canonical: { recordKey: input.recordKey, ...canonical(input, 2) } },
      { type: 'tombstone', tombstone: { recordKey: input.recordKey, recordType: input.recordType, logicalId: input.logicalId, deletedRevision: 3, mutationId: MUTATION_ID, writerId: WRITER_ID, deletedAt: 'server-time' } },
    ]);
    firestore.listeners.get(`${ROOT}/assets`)!.next([{
      type: 'added', id: input.recordKey, data: { secret: 'not a record' }, hasPendingWrites: false,
    }]);
    assert.deepEqual(events.at(-1), { type: 'invalid-document', collection: 'assets', recordKey: input.recordKey, reason: 'invalid-document' });

    unsubscribe();
    assert.deepEqual(firestore.unsubscribed.sort(), [`${ROOT}/assets`, `${ROOT}/records`, `${ROOT}/tombstones`]);
  });

  test('emits current only after each committed collection snapshot', () => {
    const firestore = new FakeFirestore();
    const events: unknown[] = [];
    createPrivateProFirebaseSyncTransport(UID, firestore).listen(event => events.push(event));

    firestore.listeners.get(`${ROOT}/records`)!.next([], true);
    firestore.listeners.get(`${ROOT}/assets`)!.next([], true);
    firestore.listeners.get(`${ROOT}/tombstones`)!.next([], true);

    assert.deepEqual(events, [
      { type: 'current', collection: 'records' },
      { type: 'current', collection: 'assets' },
      { type: 'current', collection: 'tombstones' },
    ]);
    firestore.listeners.get(`${ROOT}/records`)!.next([], true);
    assert.equal(events.length, 3);
  });

  test('continues a record batch after malformed committed record data', () => {
    const firestore = new FakeFirestore();
    const input = putInput();
    const events: unknown[] = [];
    createPrivateProFirebaseSyncTransport(UID, firestore).listen(event => events.push(event));

    firestore.listeners.get(`${ROOT}/records`)!.next([
      { type: 'added', id: input.recordKey, data: { secret: 'not a record' }, hasPendingWrites: false },
      { type: 'modified', id: input.recordKey, data: canonical(input, 2), hasPendingWrites: false },
    ]);

    assert.deepEqual(events, [
      { type: 'invalid-document', collection: 'records', recordKey: input.recordKey, reason: 'invalid-document' },
      { type: 'record', canonical: { recordKey: input.recordKey, ...canonical(input, 2) } },
    ]);
  });

  test('continues a tombstone batch after malformed committed tombstone identity', () => {
    const firestore = new FakeFirestore();
    const input = putInput();
    const events: unknown[] = [];
    createPrivateProFirebaseSyncTransport(UID, firestore).listen(event => events.push(event));

    firestore.listeners.get(`${ROOT}/tombstones`)!.next([
      {
        type: 'added', id: input.recordKey, hasPendingWrites: false,
        data: { recordKey: privateProRecordKey('settings', 'other'), recordType: input.recordType, logicalId: input.logicalId, deletedRevision: 1, mutationId: MUTATION_ID, writerId: WRITER_ID, deletedAt: 'server-time' },
      },
      {
        type: 'modified', id: input.recordKey, hasPendingWrites: false,
        data: { recordKey: input.recordKey, recordType: input.recordType, logicalId: input.logicalId, deletedRevision: 2, mutationId: MUTATION_ID, writerId: WRITER_ID, deletedAt: 'server-time' },
      },
    ]);

    assert.deepEqual(events, [
      { type: 'invalid-document', collection: 'tombstones', recordKey: input.recordKey, reason: 'invalid-document' },
      { type: 'tombstone', tombstone: { recordKey: input.recordKey, recordType: input.recordType, logicalId: input.logicalId, deletedRevision: 2, mutationId: MUTATION_ID, writerId: WRITER_ID, deletedAt: 'server-time' } },
    ]);
  });

  test('continues an asset batch after committed collection identity mismatch', () => {
    const firestore = new FakeFirestore();
    const recordInput = putInput();
    const assetInput = putInput({ recordType: 'asset', logicalId: 'asset-1' });
    assetInput.recordKey = privateProRecordKey(assetInput.recordType, assetInput.logicalId);
    const events: unknown[] = [];
    createPrivateProFirebaseSyncTransport(UID, firestore).listen(event => events.push(event));

    firestore.listeners.get(`${ROOT}/assets`)!.next([
      { type: 'added', id: recordInput.recordKey, data: canonical(recordInput, 1), hasPendingWrites: false },
      { type: 'modified', id: assetInput.recordKey, data: canonical(assetInput, 2), hasPendingWrites: false },
    ]);

    assert.deepEqual(events, [
      { type: 'invalid-document', collection: 'assets', recordKey: recordInput.recordKey, reason: 'invalid-document' },
      { type: 'record', canonical: { recordKey: assetInput.recordKey, ...canonical(assetInput, 2) } },
    ]);
  });

  test('sanitizes listener errors into allowed categories', () => {
    const firestore = new FakeFirestore();
    const events: unknown[] = [];
    createPrivateProFirebaseSyncTransport(UID, firestore).listen(event => events.push(event));

    firestore.listeners.get(`${ROOT}/records`)!.error({ code: 'permission-denied', message: 'raw credential content' });
    firestore.listeners.get(`${ROOT}/assets`)!.error({ code: 'unavailable', message: 'raw offline detail' });
    firestore.listeners.get(`${ROOT}/tombstones`)!.error({ code: 'resource-exhausted', message: 'raw quota detail' });
    firestore.listeners.get(`${ROOT}/records`)!.error(new Error('raw unknown detail'));

    assert.deepEqual(events, [
      { type: 'error', collection: 'records', category: 'permission' },
      { type: 'error', collection: 'assets', category: 'offline' },
      { type: 'error', collection: 'tombstones', category: 'quota' },
      { type: 'error', collection: 'records', category: 'unknown' },
    ]);
    assert.doesNotMatch(JSON.stringify(events), /raw|credential|detail/);
  });

  test('sanitizes transaction failures without exposing Firebase messages', async () => {
    const firestore = new FakeFirestore();
    firestore.transactionError = { code: 'permission-denied', message: 'raw credential and payload detail' };

    await assert.rejects(createPrivateProFirebaseSyncTransport(UID, firestore).write(putInput()), error => {
      assert.equal((error as PrivateProSyncTransportError).category, 'permission');
      assert.equal(String(error), 'PrivateProSyncTransportError: Private Pro sync transport error: permission.');
      assert.doesNotMatch(JSON.stringify(error), /raw|credential|payload|detail/);
      return true;
    });
  });

  test('validates mutation path identity before opening a transaction', async () => {
    const firestore = new FakeFirestore();

    await assert.rejects(
      createPrivateProFirebaseSyncTransport(UID, firestore).write(putInput({ mutationId: 'invalid/path' })),
      PrivateProSyncTransportError,
    );
    assert.equal(firestore.transactionCalls, 0);
  });
});
