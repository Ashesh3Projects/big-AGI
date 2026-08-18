import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  assertFails,
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
} from 'firebase/firestore';
import { deleteObject, getBytes, listAll, ref, uploadBytes } from 'firebase/storage';


const PROJECT_ID = 'demo-private-pro';

const ENCRYPTED_FIRESTORE_DOCUMENTS = [
  ['vault data root', 'users/uid-a/vault/data', 'users/uid-a/vault/data-new'],
  ['keyset', 'users/uid-a/vault/data/keysets/current', 'users/uid-a/vault/data/keysets/next'],
  ['former keys', 'users/uid-a/vault/data/keys/current', 'users/uid-a/vault/data/keys/next'],
  ['record', 'users/uid-a/vault/data/records/record-1', 'users/uid-a/vault/data/records/record-new'],
  ['index', 'users/uid-a/vault/data/index/entry-1', 'users/uid-a/vault/data/index/entry-new'],
  ['tombstone', 'users/uid-a/vault/data/tombstones/record-2', 'users/uid-a/vault/data/tombstones/record-new'],
  ['device', 'users/uid-a/vault/data/devices/device-1', 'users/uid-a/vault/data/devices/device-new'],
  ['operation', 'users/uid-a/vault/data/operations/operation-1', 'users/uid-a/vault/data/operations/operation-new'],
  ['backup merge', 'users/uid-a/vault/data/backupMerges/merge-1', 'users/uid-a/vault/data/backupMerges/merge-new'],
  ['registration challenge', 'users/uid-a/vault/data/registrationChallenges/challenge-1', 'users/uid-a/vault/data/registrationChallenges/challenge-new'],
  ['asset metadata', 'users/uid-a/vault/data/assets/asset-1', 'users/uid-a/vault/data/assets/asset-new'],
  ['asset reservation', 'users/uid-a/vault/data/assetReservations/reservation-1', 'users/uid-a/vault/data/assetReservations/reservation-new'],
  ['asset rate window', 'users/uid-a/vault/data/assetRateWindows/window-1', 'users/uid-a/vault/data/assetRateWindows/window-new'],
  ['former migration', 'users/uid-a/vault/data/migrations/legacy-v1', 'users/uid-a/vault/data/migrations/legacy-new'],
  ['unknown nested path', 'users/uid-a/vault/data/unknown/nested/deeper/item-1', 'users/uid-a/vault/data/unknown/nested/deeper/item-new'],
] as const;

const LEGACY_FIRESTORE_DOCUMENTS = [
  ['chat', 'users/uid-a/chats/chat-1', 'users/uid-a/chats/chat-new'],
  ['persona', 'users/uid-a/personas/persona-1', 'users/uid-a/personas/persona-new'],
  ['tombstone', 'users/uid-a/tombstones/chat:deleted', 'users/uid-a/tombstones/chat:new'],
  ['asset metadata', 'users/uid-a/assets/asset-1', 'users/uid-a/assets/asset-new'],
  ['device', 'users/uid-a/devices/device-1', 'users/uid-a/devices/device-new'],
  ['quota reservation', 'users/uid-a/quotaReservations/reservation-1', 'users/uid-a/quotaReservations/reservation-new'],
  ['upload rate window', 'users/uid-a/uploadRateWindows/window-1', 'users/uid-a/uploadRateWindows/window-new'],
  ['chat upload chunk', 'users/uid-a/chatUploads/upload-1/chunks/chunk-1', 'users/uid-a/chatUploads/upload-new/chunks/chunk-new'],
] as const;

const STORAGE_OBJECTS = [
  ['encrypted chunk', 'users/uid-a/vault/assets/opaque-asset-1/opaque-chunk-1'],
  ['former unchunked vault asset', 'users/uid-a/vault/assets/opaque-asset-legacy'],
  ['legacy plaintext asset', 'users/uid-a/assets/asset-1'],
  ['legacy upload chunk', 'users/uid-a/chatUploads/upload-1/chunks/chunk-1'],
] as const;

let testEnv: RulesTestEnvironment;

function approvedContext(uid = 'uid-a', epoch = 1): RulesTestContext {
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

    for (const [, existingPath] of [...ENCRYPTED_FIRESTORE_DOCUMENTS, ...LEGACY_FIRESTORE_DOCUMENTS])
      await setDoc(doc(firestore, existingPath), { seeded: true });

    for (const [, objectPath] of STORAGE_OBJECTS)
      await uploadBytes(ref(context.storage(), objectPath), new Uint8Array([1, 2, 3]), { contentType: 'application/octet-stream' });
  });
});

after(async () => {
  await testEnv.cleanup();
});


describe('private Pro Firestore account rules', () => {
  test('denies the account document because browser bootstrap is server-mediated', async () => {
    await assertFails(getDoc(doc(approvedContext().firestore(), 'users/uid-a')));
  });

  test('denies account reads without a current active same-account entitlement', async () => {
    const accountPath = 'users/uid-a';
    const missingClaim = testEnv.authenticatedContext('uid-a', { privateProEpoch: 1 });
    const missingEpoch = testEnv.authenticatedContext('uid-a', { privatePro: true });

    await assertFails(getDoc(doc(testEnv.unauthenticatedContext().firestore(), accountPath)));
    await assertFails(getDoc(doc(missingClaim.firestore(), accountPath)));
    await assertFails(getDoc(doc(missingEpoch.firestore(), accountPath)));
    await assertFails(getDoc(doc(approvedContext('uid-a', 2).firestore(), accountPath)));
    await assertFails(getDoc(doc(approvedContext('uid-b').firestore(), accountPath)));

    await testEnv.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), accountPath), { active: false }, { merge: true });
    });
    await assertFails(getDoc(doc(approvedContext().firestore(), accountPath)));
  });

  test('denies all browser writes to account metadata', async () => {
    const firestore = approvedContext().firestore();

    await assertFails(setDoc(doc(firestore, 'users/uid-a'), { active: false }, { merge: true }));
    await assertFails(setDoc(doc(firestore, 'users/uid-new'), { active: true }));
    await assertFails(deleteDoc(doc(firestore, 'users/uid-a')));
  });
});

describe('private Pro encrypted Firestore vault rules', () => {
  for (const [family, existingPath, newPath] of ENCRYPTED_FIRESTORE_DOCUMENTS) {
    test(`denies direct reads and writes for the ${family} family`, async () => {
      const firestore = approvedContext().firestore();

      await assertFails(getDoc(doc(firestore, existingPath)));
      await assertFails(setDoc(doc(firestore, newPath), { browserCreated: true }));
      await assertFails(setDoc(doc(firestore, existingPath), { browserUpdated: true }, { merge: true }));
      await assertFails(deleteDoc(doc(firestore, existingPath)));
    });
  }

  test('denies unauthenticated and cross-account encrypted vault reads', async () => {
    const recordPath = 'users/uid-a/vault/data/records/record-1';

    await assertFails(getDoc(doc(testEnv.unauthenticatedContext().firestore(), recordPath)));
    await assertFails(getDoc(doc(approvedContext('uid-b').firestore(), recordPath)));
  });

  test('denies direct list queries and collection-group scans', async () => {
    const firestore = approvedContext().firestore();

    await assertFails(getDocs(collection(firestore, 'users/uid-a/vault/data/records')));
    await assertFails(getDocs(collection(firestore, 'users/uid-a/vault/data/devices')));
    await assertFails(getDocs(collectionGroup(firestore, 'records')));
    await assertFails(getDocs(collectionGroup(firestore, 'assetReservations')));
  });
});

describe('private Pro former plaintext Firestore rules', () => {
  for (const [family, existingPath, newPath] of LEGACY_FIRESTORE_DOCUMENTS) {
    test(`denies direct reads and writes for the former ${family} family`, async () => {
      const firestore = approvedContext().firestore();

      await assertFails(getDoc(doc(firestore, existingPath)));
      await assertFails(setDoc(doc(firestore, newPath), { browserCreated: true }));
      await assertFails(setDoc(doc(firestore, existingPath), { browserUpdated: true }, { merge: true }));
      await assertFails(deleteDoc(doc(firestore, existingPath)));
    });
  }

  test('denies broad same-account and recursive legacy list queries', async () => {
    const firestore = approvedContext().firestore();

    await assertFails(getDocs(collection(firestore, 'users')));
    await assertFails(getDocs(collection(firestore, 'users/uid-a/chats')));
    await assertFails(getDocs(collection(firestore, 'users/uid-a/personas')));
    await assertFails(getDocs(collectionGroup(firestore, 'chunks')));
  });
});

describe('private Pro Storage rules', () => {
  for (const [family, objectPath] of STORAGE_OBJECTS) {
    test(`denies direct read, write, and delete for the ${family} path`, async () => {
      const storageReference = ref(approvedContext().storage(), objectPath);

      await assertFails(getBytes(storageReference));
      await assertFails(uploadBytes(storageReference, new Uint8Array([4])));
      await assertFails(deleteObject(storageReference));
    });
  }

  test('denies encrypted chunk reads for every browser entitlement state', async () => {
    const objectPath = 'users/uid-a/vault/assets/opaque-asset-1/opaque-chunk-1';
    const missingClaim = testEnv.authenticatedContext('uid-a', { privateProEpoch: 1 });
    const missingEpoch = testEnv.authenticatedContext('uid-a', { privatePro: true });

    await assertFails(getBytes(ref(testEnv.unauthenticatedContext().storage(), objectPath)));
    await assertFails(getBytes(ref(missingClaim.storage(), objectPath)));
    await assertFails(getBytes(ref(missingEpoch.storage(), objectPath)));
    await assertFails(getBytes(ref(approvedContext('uid-a', 2).storage(), objectPath)));
    await assertFails(getBytes(ref(approvedContext('uid-b').storage(), objectPath)));
  });

  test('denies list access to encrypted, legacy, and broad user prefixes', async () => {
    const storage = approvedContext().storage();

    await assertFails(listAll(ref(storage, 'users/uid-a/vault/assets/opaque-asset-1')));
    await assertFails(listAll(ref(storage, 'users/uid-a/vault/assets')));
    await assertFails(listAll(ref(storage, 'users/uid-a/assets')));
    await assertFails(listAll(ref(storage, 'users/uid-a')));
  });
});

test('rules-disabled seeding can read encrypted Firestore and Storage data', async () => {
  await testEnv.withSecurityRulesDisabled(async context => {
    const record = await getDoc(doc(context.firestore(), 'users/uid-a/vault/data/records/record-1'));
    const bytes = new Uint8Array(await getBytes(ref(context.storage(), 'users/uid-a/vault/assets/opaque-asset-1/opaque-chunk-1')));

    assert.equal(record.data()?.seeded, true);
    assert.deepEqual([...bytes], [1, 2, 3]);
  });
});
