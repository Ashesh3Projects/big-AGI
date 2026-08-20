import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';

import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, setDoc } from 'firebase/firestore';

import { privateProContentHash, privateProRecordKey } from '../../src/modules/private-pro/sync/privatePro.sync.codec';
import { createPrivateProFirebaseSyncTransportWithFirestore } from '../../src/modules/private-pro/sync/privatePro.sync.firebase';
import type { PrivateProSyncRemoteEvent, PrivateProSyncTransport, PrivateProSyncWriteInput } from '../../src/modules/private-pro/sync/privatePro.sync.transport';


const PROJECT_ID = 'demo-private-pro-sync';
const UID = 'transport-user';
const ROOT = `users/${UID}/workspaces/v1`;
const WRITER_A = '123e4567-e89b-42d3-a456-426614174101';
const WRITER_B = '123e4567-e89b-42d3-a456-426614174102';

let testEnv: RulesTestEnvironment;

function context() {
  return testEnv.authenticatedContext(UID, {
    email: 'transport@example.com',
    email_verified: true,
    privatePro: true,
    privateProEpoch: 7,
  });
}

async function putInput(
  recordType: PrivateProSyncWriteInput['recordType'],
  logicalId: string,
  payload: string,
  baseRevision: number,
  mutationId: string,
  writerId: string,
): Promise<PrivateProSyncWriteInput> {
  return {
    recordKey: privateProRecordKey(recordType, logicalId),
    recordType,
    logicalId,
    schemaVersion: 1,
    kind: 'put',
    payload,
    contentHash: await privateProContentHash(payload),
    baseRevision,
    mutationId,
    writerId,
  };
}

function listen(transport: PrivateProSyncTransport) {
  const events: PrivateProSyncRemoteEvent[] = [];
  const current = new Set<string>();
  let resolveCurrent!: () => void;
  let rejectCurrent!: (error: Error) => void;
  const currentPromise = new Promise<void>((resolve, reject) => { resolveCurrent = resolve; rejectCurrent = reject; });
  const unsubscribe = transport.listen(event => {
    events.push(event);
    if (event.type === 'error') rejectCurrent(new Error(`listener denied: ${event.collection}:${event.category}`));
    if (event.type === 'current') {
      current.add(event.collection);
      if (current.size === 3) resolveCurrent();
    }
  });
  return { events, currentPromise, unsubscribe };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for Firebase emulator listener state.');
}

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: await readFile('firestore.rules', 'utf8') },
  });
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(context_ => setDoc(doc(context_.firestore(), `users/${UID}`), {
    uid: UID,
    email: 'transport@example.com',
    active: true,
    accessEpoch: 7,
    createdAtMs: 1,
    updatedAtMs: 1,
  }));
});

after(async () => testEnv.cleanup());


test('real Firebase transport converges two current-UID clients through revisions and tombstones', async () => {
  const clientA = context();
  const clientB = context();
  const transportA = createPrivateProFirebaseSyncTransportWithFirestore(UID, clientA.firestore());
  const transportB = createPrivateProFirebaseSyncTransportWithFirestore(UID, clientB.firestore());
  const listenerA = listen(transportA);
  const listenerB = listen(transportB);
  try {
    await Promise.all([listenerA.currentPromise, listenerB.currentPromise]);

    const messageA = await putInput(
      'chat-message', 'chat-1:message-a', '{"message":"from-a"}', 0,
      '123e4567-e89b-42d3-a456-426614174111', WRITER_A,
    );
    const messageB = await putInput(
      'chat-message', 'chat-1:message-b', '{"message":"from-b"}', 0,
      '123e4567-e89b-42d3-a456-426614174112', WRITER_B,
    );
    assert.deepEqual(await Promise.all([transportA.write(messageA), transportB.write(messageB)]), [
      { status: 'accepted', revision: 1 },
      { status: 'accepted', revision: 1 },
    ]);
    await waitFor(() => [listenerA.events, listenerB.events].every(events =>
      events.some(event => event.type === 'record' && event.canonical.recordKey === messageA.recordKey) &&
      events.some(event => event.type === 'record' && event.canonical.recordKey === messageB.recordKey),
    ));
    const messageDocuments = (await getDocs(collection(clientA.firestore(), `${ROOT}/records`))).docs
      .filter(snapshot => snapshot.data().recordType === 'chat-message');
    assert.deepEqual(messageDocuments.map(snapshot => snapshot.id).sort(), [messageA.recordKey, messageB.recordKey].sort());

    const settingsA = await putInput(
      'settings', 'main', '{"theme":"dark"}', 0,
      '123e4567-e89b-42d3-a456-426614174121', WRITER_A,
    );
    const settingsB = await putInput(
      'settings', 'main', '{"theme":"light"}', 0,
      '123e4567-e89b-42d3-a456-426614174122', WRITER_B,
    );
    const firstSettings = await transportA.write(settingsA);
    assert.deepEqual(firstSettings, { status: 'accepted', revision: 1 });
    const conflict = await transportB.write(settingsB);
    assert.equal(conflict.status, 'conflict');
    assert.deepEqual(await transportB.write({ ...settingsB, baseRevision: 1 }), { status: 'accepted', revision: 2 });
    const settingsSnapshot = await getDoc(doc(clientA.firestore(), `${ROOT}/records/${settingsA.recordKey}`));
    assert.equal(settingsSnapshot.data()?.revision, 2);

    const deleteInput: PrivateProSyncWriteInput = {
      ...settingsA,
      kind: 'delete',
      payload: '',
      contentHash: null,
      baseRevision: 2,
      mutationId: '123e4567-e89b-42d3-a456-426614174123',
      writerId: WRITER_A,
    };
    assert.deepEqual(await transportA.write(deleteInput), { status: 'accepted', revision: 3 });
    const stalePut = await putInput(
      'settings', 'main', '{"theme":"stale"}', 2,
      '123e4567-e89b-42d3-a456-426614174124', WRITER_B,
    );
    const staleResult = await transportB.write(stalePut);
    assert.equal(staleResult.status, 'deleted');
    if (staleResult.status === 'deleted') assert.equal(staleResult.canonical.revision, 3);

    const duplicate = await putInput(
      'scratch', 'duplicate', '{"text":"once"}', 0,
      '123e4567-e89b-42d3-a456-426614174131', WRITER_A,
    );
    assert.deepEqual(await transportA.write(duplicate), { status: 'accepted', revision: 1 });
    assert.deepEqual(await transportB.write(duplicate), { status: 'already-committed', revision: 1 });
    assert.equal((await getDoc(doc(clientA.firestore(), `${ROOT}/records/${duplicate.recordKey}`))).data()?.revision, 1);
    assert.equal((await getDocs(collection(clientA.firestore(), `${ROOT}/mutationReceipts`))).docs
      .filter(snapshot => snapshot.id === duplicate.mutationId).length, 1);
  } finally {
    listenerA.unsubscribe();
    listenerB.unsubscribe();
  }
});
