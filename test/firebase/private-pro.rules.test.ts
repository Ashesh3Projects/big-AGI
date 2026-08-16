import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc } from 'firebase/firestore';
import { getBytes, ref, uploadBytes } from 'firebase/storage';


const PROJECT_ID = 'demo-private-pro';
let testEnv: RulesTestEnvironment;

function approvedContext(uid = 'uid-a', epoch = 1) {
  return testEnv.authenticatedContext(uid, {
    email: `${uid}@example.com`,
    email_verified: true,
    privatePro: true,
    privateProEpoch: epoch,
  });
}

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: await readFile('firestore.rules', 'utf8') },
    storage: { rules: await readFile('storage.rules', 'utf8') },
  });
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.clearStorage();
  await testEnv.withSecurityRulesDisabled(async context => {
    const firestore = context.firestore();
    await setDoc(doc(firestore, 'users/uid-a'), {
      uid: 'uid-a', active: true, accessEpoch: 1, quotaBytes: 1024, usedBytes: 0, reservedBytes: 0,
    });
    await setDoc(doc(firestore, 'users/uid-b'), {
      uid: 'uid-b', active: true, accessEpoch: 1, quotaBytes: 1024, usedBytes: 0, reservedBytes: 0,
    });
    await setDoc(doc(firestore, 'users/uid-a/chats/chat-1'), {
      chatId: 'chat-1', revision: 1, operationId: 'operation-1', contentHash: 'a'.repeat(64),
      chunkIds: ['000000'], byteLength: 3, deviceId: 'device-a', updatedAtMs: 100,
    });
    await setDoc(doc(firestore, 'users/uid-a/personas/persona-1'), {
      personaId: 'persona-1', revision: 1, contentHash: 'b'.repeat(64), payload: { schemaVersion: 1 }, deviceId: 'device-a', updatedAtMs: 100,
    });
    await setDoc(doc(firestore, 'users/uid-a/tombstones/chat:deleted'), {
      entityType: 'chat', entityId: 'deleted', revision: 2, operationId: 'delete-1', deviceId: 'device-a', deletedAtMs: 100,
    });
    await setDoc(doc(firestore, 'users/uid-a/assets/asset-1'), {
      uid: 'uid-a', assetId: 'asset-1', contentHash: 'c'.repeat(64), contentType: 'image/png', byteSize: 3,
      objectPath: 'users/uid-a/assets/asset-1', status: 'ready', metadata: {}, createdAtMs: 100, updatedAtMs: 100,
    });
    await uploadBytes(ref(context.storage(), 'users/uid-a/assets/asset-1'), new Uint8Array([1, 2, 3]), { contentType: 'image/png' });
  });
});

after(async () => {
  await testEnv.cleanup();
});


describe('private Pro Firestore rules', () => {
  test('allows an approved user to read only its own synchronized records', async () => {
    const firestore = approvedContext().firestore();

    await assertSucceeds(getDoc(doc(firestore, 'users/uid-a')));
    await assertSucceeds(getDoc(doc(firestore, 'users/uid-a/chats/chat-1')));
    await assertSucceeds(getDoc(doc(firestore, 'users/uid-a/personas/persona-1')));
    await assertSucceeds(getDoc(doc(firestore, 'users/uid-a/tombstones/chat:deleted')));
    await assertSucceeds(getDoc(doc(firestore, 'users/uid-a/assets/asset-1')));
    await assertFails(getDoc(doc(firestore, 'users/uid-b')));
  });

  test('rejects missing, stale, and inactive entitlements', async () => {
    await assertFails(getDoc(doc(testEnv.unauthenticatedContext().firestore(), 'users/uid-a/chats/chat-1')));
    await assertFails(getDoc(doc(testEnv.authenticatedContext('uid-a', { privatePro: false, privateProEpoch: 1 }).firestore(), 'users/uid-a/chats/chat-1')));
    await assertFails(getDoc(doc(approvedContext('uid-a', 2).firestore(), 'users/uid-a/chats/chat-1')));

    await testEnv.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'users/uid-a'), { active: false }, { merge: true });
    });
    await assertFails(getDoc(doc(approvedContext().firestore(), 'users/uid-a/chats/chat-1')));
  });

  test('denies every browser write in the synchronized vault', async () => {
    const firestore = approvedContext().firestore();

    await assertFails(setDoc(doc(firestore, 'users/uid-a/chats/new-chat'), { revision: 1 }));
    await assertFails(setDoc(doc(firestore, 'users/uid-a/personas/new-persona'), { revision: 1 }));
    await assertFails(setDoc(doc(firestore, 'users/uid-a/quotaReservations/op-1'), { requestedBytes: 1 }));
    await assertFails(deleteDoc(doc(firestore, 'users/uid-a/chats/chat-1')));
  });
});

describe('private Pro Storage rules', () => {
  test('allows an entitled user to read only its own attachment', async () => {
    await assertSucceeds(getBytes(ref(approvedContext().storage(), 'users/uid-a/assets/asset-1')));
    await assertFails(getBytes(ref(approvedContext('uid-b').storage(), 'users/uid-a/assets/asset-1')));
    await assertFails(getBytes(ref(testEnv.unauthenticatedContext().storage(), 'users/uid-a/assets/asset-1')));
  });

  test('denies direct browser uploads even for an approved user', async () => {
    await assertFails(uploadBytes(ref(approvedContext().storage(), 'users/uid-a/assets/direct-upload'), new Uint8Array([4])));
  });

  test('requires a private Pro claim and numeric epoch for reads', async () => {
    const noClaim = testEnv.authenticatedContext('uid-a', { privatePro: false, privateProEpoch: 1 });
    const noEpoch = testEnv.authenticatedContext('uid-a', { privatePro: true });
    await assertFails(getBytes(ref(noClaim.storage(), 'users/uid-a/assets/asset-1')));
    await assertFails(getBytes(ref(noEpoch.storage(), 'users/uid-a/assets/asset-1')));
  });
});

test('seeded storage object is readable with rules disabled', async () => {
  await testEnv.withSecurityRulesDisabled(async context => {
    const bytes = new Uint8Array(await getBytes(ref(context.storage(), 'users/uid-a/assets/asset-1')));
    assert.deepEqual([...bytes], [1, 2, 3]);
  });
});
