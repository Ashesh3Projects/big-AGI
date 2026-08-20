import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  assertFails,
  assertSucceeds,
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
  serverTimestamp,
  setDoc,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import { deleteObject, getBytes, listAll, ref, uploadBytes } from 'firebase/storage';

import { privateProRecordKey } from '../../src/modules/private-pro/sync/privatePro.sync.codec';
import type { PrivateProSyncRecordType } from '../../src/modules/private-pro/sync/privatePro.sync.schemas';


const PROJECT_ID = 'demo-private-pro';
const UID_A = 'uid-a';
const UID_B = 'uid-b';
const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const MUTATION_1 = '123e4567-e89b-42d3-a456-426614174001';
const MUTATION_2 = '123e4567-e89b-42d3-a456-426614174002';
const WRITER_1 = '123e4567-e89b-42d3-a456-426614174011';
const WRITER_2 = '123e4567-e89b-42d3-a456-426614174012';
const ROOT_A = `users/${UID_A}/workspaces/v1`;

const RECORD_KEY_BOUNDARIES = [
  { recordType: 'credential-service', prefixLength: 25, outside: 'Q' },
  { recordType: 'model-service', prefixLength: 18, outside: 'E' },
  { recordType: 'persona', prefixLength: 10, outside: 'E' },
  { recordType: 'folder', prefixLength: 9, outside: 'Q' },
  { recordType: 'scratch', prefixLength: 10, outside: 'E' },
  { recordType: 'chat-meta', prefixLength: 13, outside: 'Q' },
  { recordType: 'chat-message', prefixLength: 17, outside: 'Q' },
] as const satisfies readonly { recordType: PrivateProSyncRecordType; prefixLength: number; outside: string }[];

const LEGACY_FIRESTORE_PATHS = [
  `users/${UID_A}/vault/data/records/encrypted-record`,
  `users/${UID_A}/chats/plaintext-chat`,
] as const;
const LEGACY_STORAGE_PATHS = [
  `users/${UID_A}/vault/assets/encrypted/chunk`,
  `users/${UID_A}/assets/plaintext-asset`,
] as const;

let testEnv: RulesTestEnvironment;

function approvedContext(uid = UID_A, epoch = 1): RulesTestContext {
  return testEnv.authenticatedContext(uid, {
    email: `${uid}@example.com`,
    email_verified: true,
    privatePro: true,
    privateProEpoch: epoch,
  });
}

function canonical(input: {
  recordType?: string;
  logicalId?: string;
  schemaVersion?: number;
  payload?: string;
  contentHash?: string;
  revision?: number;
  mutationId?: string;
  writerId?: string;
  deleted?: boolean;
  extra?: Record<string, unknown>;
}) {
  return {
    recordType: input.recordType ?? 'settings',
    logicalId: input.logicalId ?? 'main',
    schemaVersion: input.schemaVersion ?? 1,
    payload: input.payload ?? '{"theme":"dark"}',
    contentHash: input.contentHash ?? HASH_A,
    revision: input.revision ?? 1,
    mutationId: input.mutationId ?? MUTATION_1,
    writerId: input.writerId ?? WRITER_1,
    deleted: input.deleted ?? false,
    updatedAt: serverTimestamp(),
    ...input.extra,
  };
}

function receipt(input: {
  recordKey: string;
  recordType?: string;
  logicalId?: string;
  kind?: 'put' | 'delete';
  contentHash?: string | null;
  revision?: number;
  mutationId?: string;
  writerId?: string;
  extra?: Record<string, unknown>;
}) {
  return {
    schemaVersion: 1,
    mutationId: input.mutationId ?? MUTATION_1,
    recordKey: input.recordKey,
    recordType: input.recordType ?? 'settings',
    logicalId: input.logicalId ?? 'main',
    kind: input.kind ?? 'put',
    contentHash: input.contentHash === undefined ? HASH_A : input.contentHash,
    revision: input.revision ?? 1,
    writerId: input.writerId ?? WRITER_1,
    committedAt: serverTimestamp(),
    ...input.extra,
  };
}

function tombstone(input: {
  recordKey: string;
  recordType?: string;
  logicalId?: string;
  revision?: number;
  mutationId?: string;
  writerId?: string;
  extra?: Record<string, unknown>;
}) {
  return {
    recordKey: input.recordKey,
    recordType: input.recordType ?? 'settings',
    logicalId: input.logicalId ?? 'main',
    deletedRevision: input.revision ?? 2,
    mutationId: input.mutationId ?? MUTATION_2,
    writerId: input.writerId ?? WRITER_2,
    deletedAt: serverTimestamp(),
    ...input.extra,
  };
}

async function validCreate(firestore: Firestore, options: {
  recordType?: PrivateProSyncRecordType;
  logicalId?: string;
  mutationId?: string;
  writerId?: string;
  payload?: string;
  contentHash?: string;
} = {}): Promise<string> {
  const recordType = options.recordType ?? 'settings';
  const logicalId = options.logicalId ?? 'main';
  const mutationId = options.mutationId ?? MUTATION_1;
  const writerId = options.writerId ?? WRITER_1;
  const payload = options.payload ?? '{"theme":"dark"}';
  const contentHash = options.contentHash ?? HASH_A;
  const recordKey = privateProRecordKey(recordType, logicalId);
  const collectionName = recordType === 'asset' ? 'assets' : 'records';
  const batch = writeBatch(firestore);
  batch.set(doc(firestore, `${ROOT_A}/${collectionName}/${recordKey}`), canonical({ recordType, logicalId, payload, contentHash, mutationId, writerId }));
  batch.set(doc(firestore, `${ROOT_A}/mutationReceipts/${mutationId}`), receipt({ recordKey, recordType, logicalId, contentHash, mutationId, writerId }));
  await batch.commit();
  return recordKey;
}

async function validUpdate(firestore: Firestore, recordKey: string): Promise<void> {
  const batch = writeBatch(firestore);
  batch.set(doc(firestore, `${ROOT_A}/records/${recordKey}`), canonical({
    payload: '{"theme":"light"}', contentHash: HASH_B, revision: 2, mutationId: MUTATION_2, writerId: WRITER_2,
  }));
  batch.set(doc(firestore, `${ROOT_A}/mutationReceipts/${MUTATION_2}`), receipt({
    recordKey, contentHash: HASH_B, revision: 2, mutationId: MUTATION_2, writerId: WRITER_2,
  }));
  await batch.commit();
}

function storageMetadata(uid: string, assetId: string, kind: 'original' | 'thumb256', sha256 = HASH_A, contentType = 'image/png') {
  return { contentType, customMetadata: { uid, assetId, kind, sha256 } };
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
    await setDoc(doc(firestore, `users/${UID_A}`), {
      uid: UID_A, email: 'uid-a@example.com', active: true, accessEpoch: 1,
      createdAtMs: 1, updatedAtMs: 1,
      quotaBytes: 1024, usedBytes: 0, reservedBytes: 0,
    });
    await setDoc(doc(firestore, `users/${UID_B}`), {
      uid: UID_B, email: 'uid-b@example.com', active: true, accessEpoch: 1,
      createdAtMs: 1, updatedAtMs: 1,
    });
    for (const path of LEGACY_FIRESTORE_PATHS) await setDoc(doc(firestore, path), { seeded: true });
    for (const path of LEGACY_STORAGE_PATHS)
      await uploadBytes(ref(context.storage(), path), new Uint8Array([1, 2, 3]), { contentType: 'application/octet-stream' });
  });
});

after(async () => testEnv.cleanup());


describe('Private Pro Firestore current account access', () => {
  test('allows current UID reads and lists for every v1 collection while account documents remain server-only', async () => {
    const firestore = approvedContext().firestore();
    const recordKey = await validCreate(firestore);
    const assetKey = await validCreate(firestore, {
      recordType: 'asset', logicalId: 'asset-1', mutationId: '123e4567-e89b-42d3-a456-426614174003', writerId: WRITER_2,
    });
    const deleteBatch = writeBatch(firestore);
    deleteBatch.set(doc(firestore, `${ROOT_A}/records/${recordKey}`), canonical({
      payload: '', contentHash: EMPTY_HASH, revision: 2, mutationId: MUTATION_2, writerId: WRITER_2, deleted: true,
    }));
    deleteBatch.set(doc(firestore, `${ROOT_A}/mutationReceipts/${MUTATION_2}`), receipt({
      recordKey, kind: 'delete', contentHash: null, revision: 2, mutationId: MUTATION_2, writerId: WRITER_2,
    }));
    deleteBatch.set(doc(firestore, `${ROOT_A}/tombstones/${recordKey}`), tombstone({ recordKey }));
    await assertSucceeds(deleteBatch.commit());

    await assertSucceeds(getDoc(doc(firestore, `${ROOT_A}/records/${recordKey}`)));
    await assertSucceeds(getDoc(doc(firestore, `${ROOT_A}/assets/${assetKey}`)));
    await assertSucceeds(getDocs(collection(firestore, `${ROOT_A}/records`)));
    await assertSucceeds(getDocs(collection(firestore, `${ROOT_A}/assets`)));
    await assertSucceeds(getDocs(collection(firestore, `${ROOT_A}/mutationReceipts`)));
    await assertSucceeds(getDocs(collection(firestore, `${ROOT_A}/tombstones`)));
    await assertFails(getDoc(doc(firestore, `users/${UID_A}`)));
    await assertFails(setDoc(doc(firestore, `users/${UID_A}`), { active: false }, { merge: true }));
  });

  test('denies anonymous, wrong UID, missing claim, missing epoch, stale epoch, and inactive account access', async () => {
    const path = `${ROOT_A}/records/${privateProRecordKey('settings', 'main')}`;
    const contexts = [
      testEnv.unauthenticatedContext(),
      approvedContext(UID_B),
      testEnv.authenticatedContext(UID_A, { privateProEpoch: 1 }),
      testEnv.authenticatedContext(UID_A, { privatePro: true }),
      approvedContext(UID_A, 2),
    ];
    for (const context of contexts) {
      await assertFails(getDoc(doc(context.firestore(), path)));
      await assertFails(setDoc(doc(context.firestore(), path), canonical({})));
    }
    await testEnv.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), `users/${UID_A}`), { active: false }, { merge: true }));
    await assertFails(getDoc(doc(approvedContext().firestore(), path)));
  });

  test('denies broad user and collection-group reads', async () => {
    const firestore = approvedContext().firestore();
    await assertFails(getDocs(collection(firestore, 'users')));
    await assertFails(getDocs(collectionGroup(firestore, 'records')));
    await assertFails(getDocs(collectionGroup(firestore, 'assets')));
  });
});

describe('Private Pro Firestore transaction invariants', () => {
  test('accepts the exact codec prefix and length for every record family', async () => {
    const firestore = approvedContext().firestore();
    const recordTypes: readonly PrivateProSyncRecordType[] = [
      'credential-service', 'model-service', 'settings', 'persona', 'folder',
      'scratch', 'chat-meta', 'chat-message', 'asset',
    ];

    for (let index = 0; index < recordTypes.length; index++) {
      const recordType = recordTypes[index];
      await assertSucceeds(validCreate(firestore, {
        recordType,
        logicalId: `${recordType}-${index}`,
        mutationId: `123e4567-e89b-42d3-a456-426614174${String(50 + index).padStart(3, '0')}`,
      }));
    }
  });

  test('denies every partial-family boundary character outside its fixed Base64URL class', async () => {
    const firestore = approvedContext().firestore();
    for (let index = 0; index < RECORD_KEY_BOUNDARIES.length; index++) {
      const boundary = RECORD_KEY_BOUNDARIES[index];
      const logicalId = `boundary-${boundary.recordType}`;
      const validKey = privateProRecordKey(boundary.recordType, logicalId);
      const invalidKey = `${validKey.slice(0, boundary.prefixLength)}${boundary.outside}${validKey.slice(boundary.prefixLength + 1)}`;
      const mutationId = `123e4567-e89b-42d3-a456-426614174${String(70 + index).padStart(3, '0')}`;
      const collectionName = boundary.recordType === 'asset' ? 'assets' : 'records';
      const batch = writeBatch(firestore);
      batch.set(doc(firestore, `${ROOT_A}/${collectionName}/${invalidKey}`), canonical({
        recordType: boundary.recordType,
        logicalId,
        mutationId,
      }));
      batch.set(doc(firestore, `${ROOT_A}/mutationReceipts/${mutationId}`), receipt({
        recordKey: invalidKey,
        recordType: boundary.recordType,
        logicalId,
        mutationId,
      }));
      await assertFails(batch.commit());
    }
  });

  test('denies model AQ boundary probe while settings and asset digest characters remain unrestricted', async () => {
    const firestore = approvedContext().firestore();
    const modelLogicalId = 'model-aq-probe';
    const modelKey = privateProRecordKey('model-service', modelLogicalId);
    const invalidModelKey = `${modelKey.slice(0, 18)}Q${modelKey.slice(19)}`;
    const modelBatch = writeBatch(firestore);
    modelBatch.set(doc(firestore, `${ROOT_A}/records/${invalidModelKey}`), canonical({
      recordType: 'model-service', logicalId: modelLogicalId, mutationId: '123e4567-e89b-42d3-a456-426614174081',
    }));
    modelBatch.set(doc(firestore, `${ROOT_A}/mutationReceipts/123e4567-e89b-42d3-a456-426614174081`), receipt({
      recordKey: invalidModelKey, recordType: 'model-service', logicalId: modelLogicalId,
      mutationId: '123e4567-e89b-42d3-a456-426614174081',
    }));
    await assertFails(modelBatch.commit());

    for (const [recordType, logicalId, mutationId] of [
      ['settings', 'settings-digest-boundary', '123e4567-e89b-42d3-a456-426614174082'],
      ['asset', 'asset-digest-boundary', '123e4567-e89b-42d3-a456-426614174083'],
    ] as const) {
      const validKey = privateProRecordKey(recordType, logicalId);
      assert.match(validKey, recordType === 'settings' ? /^c2V0dGluZ3MA[A-Za-z0-9_-]{43}$/ : /^YXNzZXQA[A-Za-z0-9_-]{43}$/);
      await assertSucceeds(validCreate(firestore, { recordType, logicalId, mutationId }));
    }
  });

  test('accepts revision one create and exact plus-one update only with matching immutable receipts', async () => {
    const firestore = approvedContext().firestore();
    const recordKey = await assertSucceeds(validCreate(firestore));
    await assertSucceeds(validUpdate(firestore, recordKey));
    const snapshot = await getDoc(doc(firestore, `${ROOT_A}/records/${recordKey}`));
    assert.equal(snapshot.data()?.revision, 2);
  });

  test('denies canonical writes without a matching receipt or with a skipped revision', async () => {
    const firestore = approvedContext().firestore();
    const recordKey = privateProRecordKey('settings', 'main');
    await assertFails(setDoc(doc(firestore, `${ROOT_A}/records/${recordKey}`), canonical({})));
    await validCreate(firestore);
    const batch = writeBatch(firestore);
    batch.set(doc(firestore, `${ROOT_A}/records/${recordKey}`), canonical({ revision: 3, mutationId: MUTATION_2, writerId: WRITER_2 }));
    batch.set(doc(firestore, `${ROOT_A}/mutationReceipts/${MUTATION_2}`), receipt({ recordKey, revision: 3, mutationId: MUTATION_2, writerId: WRITER_2 }));
    await assertFails(batch.commit());
  });

  test('denies receipt-only creation against an unchanged canonical record', async () => {
    const firestore = approvedContext().firestore();
    const recordKey = privateProRecordKey('settings', 'receipt-only');
    const mutationId = '123e4567-e89b-42d3-a456-426614174021';
    await testEnv.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), `${ROOT_A}/records/${recordKey}`), {
      recordType: 'settings', logicalId: 'receipt-only', schemaVersion: 1, payload: '{"theme":"dark"}',
      contentHash: HASH_A, revision: 1, mutationId, writerId: WRITER_1, deleted: false, updatedAt: new Date(),
    }));

    await assertFails(setDoc(doc(firestore, `${ROOT_A}/mutationReceipts/${mutationId}`), receipt({
      recordKey,
      logicalId: 'receipt-only',
      revision: 1,
      mutationId,
      writerId: WRITER_1,
    })));
  });

  test('denies tombstone-only creation against an unchanged deleted canonical record', async () => {
    const firestore = approvedContext().firestore();
    const recordKey = await validCreate(firestore);
    const deleteBatch = writeBatch(firestore);
    deleteBatch.set(doc(firestore, `${ROOT_A}/records/${recordKey}`), canonical({
      payload: '', contentHash: EMPTY_HASH, revision: 2, mutationId: MUTATION_2, writerId: WRITER_2, deleted: true,
    }));
    deleteBatch.set(doc(firestore, `${ROOT_A}/mutationReceipts/${MUTATION_2}`), receipt({
      recordKey, kind: 'delete', contentHash: null, revision: 2, mutationId: MUTATION_2, writerId: WRITER_2,
    }));
    deleteBatch.set(doc(firestore, `${ROOT_A}/tombstones/${recordKey}`), tombstone({ recordKey }));
    await deleteBatch.commit();
    await testEnv.withSecurityRulesDisabled(context => deleteDoc(doc(context.firestore(), `${ROOT_A}/tombstones/${recordKey}`)));

    await assertFails(setDoc(doc(firestore, `${ROOT_A}/tombstones/${recordKey}`), tombstone({ recordKey })));
  });

  test('denies reusing an immutable mutation receipt ID for another canonical revision', async () => {
    const firestore = approvedContext().firestore();
    const firstKey = await validCreate(firestore);
    const secondKey = privateProRecordKey('settings', 'other');
    const batch = writeBatch(firestore);
    batch.set(doc(firestore, `${ROOT_A}/records/${secondKey}`), canonical({ logicalId: 'other' }));
    batch.set(doc(firestore, `${ROOT_A}/mutationReceipts/${MUTATION_1}`), receipt({ recordKey: secondKey, logicalId: 'other' }));
    await assertFails(batch.commit());
    assert.equal((await getDoc(doc(firestore, `${ROOT_A}/records/${firstKey}`))).data()?.revision, 1);
    assert.equal((await getDoc(doc(firestore, `${ROOT_A}/records/${secondKey}`))).exists(), false);
  });

  test('denies changed identity, extra keys, wrong collection type, malformed IDs, and invalid bounds', async () => {
    const firestore = approvedContext().firestore();
    const recordKey = await validCreate(firestore);
    const invalidWrites = [
      canonical({ logicalId: 'other', revision: 2, mutationId: MUTATION_2, writerId: WRITER_2 }),
      canonical({ schemaVersion: 2, revision: 2, mutationId: MUTATION_2, writerId: WRITER_2 }),
      canonical({ revision: 2, mutationId: MUTATION_2, writerId: WRITER_2, extra: { unexpected: true } }),
      canonical({ recordType: 'asset', revision: 2, mutationId: MUTATION_2, writerId: WRITER_2 }),
      canonical({ revision: 2, mutationId: 'not-a-uuid', writerId: WRITER_2 }),
    ];
    for (const value of invalidWrites) {
      const batch = writeBatch(firestore);
      batch.set(doc(firestore, `${ROOT_A}/records/${recordKey}`), value);
      batch.set(doc(firestore, `${ROOT_A}/mutationReceipts/${MUTATION_2}`), receipt({ recordKey, revision: 2, mutationId: MUTATION_2, writerId: WRITER_2 }));
      await assertFails(batch.commit());
    }

    const invalidRecordKey = `bad.${'a'.repeat(1022)}`;
    await assertFails(setDoc(doc(firestore, `${ROOT_A}/records/${invalidRecordKey}`), canonical({})));

    const assetKey = privateProRecordKey('asset', 'asset-wrong-collection');
    const wrongCollection = writeBatch(firestore);
    wrongCollection.set(doc(firestore, `${ROOT_A}/records/${assetKey}`), canonical({ recordType: 'asset', logicalId: 'asset-wrong-collection' }));
    wrongCollection.set(doc(firestore, `${ROOT_A}/mutationReceipts/${MUTATION_2}`), receipt({
      recordKey: assetKey, recordType: 'asset', logicalId: 'asset-wrong-collection', mutationId: MUTATION_2,
    }));
    await assertFails(wrongCollection.commit());

    const wrongPrefixKey = privateProRecordKey('persona', 'main');
    const wrongPrefix = writeBatch(firestore);
    wrongPrefix.set(doc(firestore, `${ROOT_A}/records/${wrongPrefixKey}`), canonical({
      logicalId: 'wrong-prefix', mutationId: '123e4567-e89b-42d3-a456-426614174031',
    }));
    wrongPrefix.set(doc(firestore, `${ROOT_A}/mutationReceipts/123e4567-e89b-42d3-a456-426614174031`), receipt({
      recordKey: wrongPrefixKey, logicalId: 'wrong-prefix', mutationId: '123e4567-e89b-42d3-a456-426614174031',
    }));
    await assertFails(wrongPrefix.commit());

    const wrongLengthKey = `${privateProRecordKey('settings', 'wrong-length')}A`;
    const wrongLength = writeBatch(firestore);
    wrongLength.set(doc(firestore, `${ROOT_A}/records/${wrongLengthKey}`), canonical({
      logicalId: 'wrong-length', mutationId: '123e4567-e89b-42d3-a456-426614174032',
    }));
    wrongLength.set(doc(firestore, `${ROOT_A}/mutationReceipts/123e4567-e89b-42d3-a456-426614174032`), receipt({
      recordKey: wrongLengthKey, logicalId: 'wrong-length', mutationId: '123e4567-e89b-42d3-a456-426614174032',
    }));
    await assertFails(wrongLength.commit());
  });

  test('denies non-ASCII, oversized, empty live payloads, wrong hashes, and arbitrary timestamps', async () => {
    const firestore = approvedContext().firestore();
    const cases = [
      { logicalId: 'non-ascii', payload: '{"value":"é"}', contentHash: HASH_A },
      { logicalId: 'oversized', payload: 'x'.repeat(786_433), contentHash: HASH_A },
      { logicalId: 'empty', payload: '', contentHash: HASH_A },
      { logicalId: 'bad-hash', payload: '{}', contentHash: 'A'.repeat(64) },
      { logicalId: 'raw-newline', payload: '{"value":1}\n', contentHash: HASH_A },
      { logicalId: 'raw-tab', payload: '{"value":1}\t', contentHash: HASH_A },
      { logicalId: 'raw-null', payload: '{"value":"\u0000"}', contentHash: HASH_A },
    ];
    for (let index = 0; index < cases.length; index++) {
      const value = cases[index];
      const recordKey = privateProRecordKey('settings', value.logicalId);
      const mutationId = `123e4567-e89b-42d3-a456-4266141741${String(index).padStart(2, '0')}`;
      const batch = writeBatch(firestore);
      batch.set(doc(firestore, `${ROOT_A}/records/${recordKey}`), canonical({ ...value, logicalId: value.logicalId, mutationId }));
      batch.set(doc(firestore, `${ROOT_A}/mutationReceipts/${mutationId}`), receipt({ recordKey, logicalId: value.logicalId, contentHash: value.contentHash, mutationId }));
      await assertFails(batch.commit());
    }

    const recordKey = privateProRecordKey('settings', 'timestamp');
    const batch = writeBatch(firestore);
    batch.set(doc(firestore, `${ROOT_A}/records/${recordKey}`), { ...canonical({ logicalId: 'timestamp' }), updatedAt: new Date(0) });
    batch.set(doc(firestore, `${ROOT_A}/mutationReceipts/${MUTATION_1}`), { ...receipt({ recordKey, logicalId: 'timestamp' }), committedAt: new Date(0) });
    await assertFails(batch.commit());
  });

  test('requires deletion canonical, receipt, and tombstone to match in one atomic write', async () => {
    const firestore = approvedContext().firestore();
    const recordKey = await validCreate(firestore);
    const batch = writeBatch(firestore);
    batch.set(doc(firestore, `${ROOT_A}/records/${recordKey}`), canonical({
      payload: '', contentHash: EMPTY_HASH, revision: 2, mutationId: MUTATION_2, writerId: WRITER_2, deleted: true,
    }));
    batch.set(doc(firestore, `${ROOT_A}/mutationReceipts/${MUTATION_2}`), receipt({
      recordKey, kind: 'delete', contentHash: null, revision: 2, mutationId: MUTATION_2, writerId: WRITER_2,
    }));
    batch.set(doc(firestore, `${ROOT_A}/tombstones/${recordKey}`), tombstone({ recordKey }));
    await assertSucceeds(batch.commit());

    await assertFails(deleteDoc(doc(firestore, `${ROOT_A}/records/${recordKey}`)));
    await assertFails(validUpdate(firestore, recordKey));
    await assertFails(setDoc(doc(firestore, `${ROOT_A}/tombstones/${recordKey}`), { extra: true }, { merge: true }));
    await assertFails(deleteDoc(doc(firestore, `${ROOT_A}/tombstones/${recordKey}`)));
    await assertFails(setDoc(doc(firestore, `${ROOT_A}/mutationReceipts/${MUTATION_2}`), { writerId: WRITER_1 }, { merge: true }));
    await assertFails(deleteDoc(doc(firestore, `${ROOT_A}/mutationReceipts/${MUTATION_2}`)));
  });

  test('denies delete without tombstone and any put while a tombstone exists', async () => {
    const firestore = approvedContext().firestore();
    const recordKey = await validCreate(firestore);
    const missingTombstone = writeBatch(firestore);
    missingTombstone.set(doc(firestore, `${ROOT_A}/records/${recordKey}`), canonical({
      payload: '', contentHash: EMPTY_HASH, revision: 2, mutationId: MUTATION_2, writerId: WRITER_2, deleted: true,
    }));
    missingTombstone.set(doc(firestore, `${ROOT_A}/mutationReceipts/${MUTATION_2}`), receipt({
      recordKey, kind: 'delete', contentHash: null, revision: 2, mutationId: MUTATION_2, writerId: WRITER_2,
    }));
    await assertFails(missingTombstone.commit());

    await testEnv.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), `${ROOT_A}/tombstones/${recordKey}`), {
        recordKey, recordType: 'settings', logicalId: 'main', deletedRevision: 1,
        mutationId: MUTATION_1, writerId: WRITER_1, deletedAt: new Date(),
      });
    });
    await assertFails(validUpdate(firestore, recordKey));
  });

  test('denies receipt and tombstone IDs that do not match their embedded identities', async () => {
    const firestore = approvedContext().firestore();
    const recordKey = privateProRecordKey('settings', 'main');
    const wrongReceipt = writeBatch(firestore);
    wrongReceipt.set(doc(firestore, `${ROOT_A}/records/${recordKey}`), canonical({}));
    wrongReceipt.set(doc(firestore, `${ROOT_A}/mutationReceipts/${MUTATION_2}`), receipt({ recordKey, mutationId: MUTATION_1 }));
    await assertFails(wrongReceipt.commit());
    await assertFails(setDoc(doc(firestore, `${ROOT_A}/tombstones/other-key`), tombstone({ recordKey })));

    const extraReceipt = writeBatch(firestore);
    extraReceipt.set(doc(firestore, `${ROOT_A}/records/${recordKey}`), canonical({}));
    extraReceipt.set(doc(firestore, `${ROOT_A}/mutationReceipts/${MUTATION_1}`), receipt({ recordKey, extra: { unexpected: true } }));
    await assertFails(extraReceipt.commit());

    await validCreate(firestore);
    const extraTombstone = writeBatch(firestore);
    extraTombstone.set(doc(firestore, `${ROOT_A}/records/${recordKey}`), canonical({
      payload: '', contentHash: EMPTY_HASH, revision: 2, mutationId: MUTATION_2, writerId: WRITER_2, deleted: true,
    }));
    extraTombstone.set(doc(firestore, `${ROOT_A}/mutationReceipts/${MUTATION_2}`), receipt({
      recordKey, kind: 'delete', contentHash: null, revision: 2, mutationId: MUTATION_2, writerId: WRITER_2,
    }));
    extraTombstone.set(doc(firestore, `${ROOT_A}/tombstones/${recordKey}`), tombstone({
      recordKey, extra: { unexpected: true },
    }));
    await assertFails(extraTombstone.commit());

    const receiptSchema = writeBatch(firestore);
    const schemaKey = privateProRecordKey('settings', 'receipt-schema');
    receiptSchema.set(doc(firestore, `${ROOT_A}/records/${schemaKey}`), canonical({
      logicalId: 'receipt-schema', mutationId: '123e4567-e89b-42d3-a456-426614174041',
    }));
    receiptSchema.set(doc(firestore, `${ROOT_A}/mutationReceipts/123e4567-e89b-42d3-a456-426614174041`), receipt({
      recordKey: schemaKey,
      logicalId: 'receipt-schema',
      mutationId: '123e4567-e89b-42d3-a456-426614174041',
      extra: { schemaVersion: 1 },
    }));
    await assertSucceeds(receiptSchema.commit());

    const invalidReceiptSchema = writeBatch(firestore);
    const invalidSchemaKey = privateProRecordKey('settings', 'receipt-schema-invalid');
    invalidReceiptSchema.set(doc(firestore, `${ROOT_A}/records/${invalidSchemaKey}`), canonical({
      logicalId: 'receipt-schema-invalid', mutationId: '123e4567-e89b-42d3-a456-426614174042',
    }));
    invalidReceiptSchema.set(doc(firestore, `${ROOT_A}/mutationReceipts/123e4567-e89b-42d3-a456-426614174042`), receipt({
      recordKey: invalidSchemaKey,
      logicalId: 'receipt-schema-invalid',
      mutationId: '123e4567-e89b-42d3-a456-426614174042',
      extra: { schemaVersion: 1.5 },
    }));
    await assertFails(invalidReceiptSchema.commit());
  });
});

describe('Private Pro legacy path denial', () => {
  test('keeps encrypted and former plaintext Firestore and Storage paths denied', async () => {
    const context = approvedContext();
    for (const path of LEGACY_FIRESTORE_PATHS) {
      await assertFails(getDoc(doc(context.firestore(), path)));
      await assertFails(setDoc(doc(context.firestore(), path), { changed: true }));
      await assertFails(deleteDoc(doc(context.firestore(), path)));
    }
    for (const path of LEGACY_STORAGE_PATHS) {
      await assertFails(getBytes(ref(context.storage(), path)));
      await assertFails(uploadBytes(ref(context.storage(), path), new Uint8Array([4])));
      await assertFails(deleteObject(ref(context.storage(), path)));
    }
  });
});

describe('Private Pro Storage v1 rules', () => {
  test('allows current UID create, read, update, and delete at the two fixed object names', async () => {
    const storage = approvedContext().storage();
    const original = ref(storage, `users/${UID_A}/workspace-v1/assets/asset-1/original`);
    const thumb = ref(storage, `users/${UID_A}/workspace-v1/assets/asset-1/thumb256`);
    await assertSucceeds(uploadBytes(original, new Uint8Array([1, 2, 3]), storageMetadata(UID_A, 'asset-1', 'original')));
    await assertSucceeds(getBytes(original));
    await assertSucceeds(uploadBytes(original, new Uint8Array([4, 5]), storageMetadata(UID_A, 'asset-1', 'original')));
    await assertSucceeds(uploadBytes(thumb, new Uint8Array([6]), storageMetadata(UID_A, 'asset-1', 'thumb256', HASH_B, 'image/webp')));
    await assertSucceeds(getBytes(thumb));
    await assertSucceeds(deleteObject(original));
    await assertSucceeds(deleteObject(thumb));
  });

  test('allows zero-byte original objects as an explicit protocol decision', async () => {
    const storage = approvedContext().storage();
    const original = ref(storage, `users/${UID_A}/workspace-v1/assets/asset-empty/original`);

    await assertSucceeds(uploadBytes(original, new Uint8Array(), storageMetadata(UID_A, 'asset-empty', 'original')));
    assert.equal((await getBytes(original)).byteLength, 0);
  });

  test('allows metadata replacement on update only when the strict shape remains valid', async () => {
    const storage = approvedContext().storage();
    const original = ref(storage, `users/${UID_A}/workspace-v1/assets/asset-metadata-update/original`);
    await uploadBytes(original, new Uint8Array([1]), storageMetadata(UID_A, 'asset-metadata-update', 'original'));

    await assertSucceeds(uploadBytes(
      original,
      new Uint8Array([2]),
      storageMetadata(UID_A, 'asset-metadata-update', 'original', HASH_B, 'image/webp'),
    ));
    await assertFails(uploadBytes(original, new Uint8Array([3]), {
      ...storageMetadata(UID_A, 'asset-metadata-update', 'original'),
      customMetadata: {
        ...storageMetadata(UID_A, 'asset-metadata-update', 'original').customMetadata,
        extra: 'invalid',
      },
    }));
  });

  test('denies wrong UID, missing claim, stale epoch, inactive account, arbitrary names, and listing', async () => {
    const path = `users/${UID_A}/workspace-v1/assets/asset-1/original`;
    for (const context of [
      testEnv.unauthenticatedContext(), approvedContext(UID_B),
      testEnv.authenticatedContext(UID_A, { privateProEpoch: 1 }), approvedContext(UID_A, 2),
    ]) {
      await assertFails(uploadBytes(ref(context.storage(), path), new Uint8Array([1]), storageMetadata(UID_A, 'asset-1', 'original')));
    }
    await testEnv.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), `users/${UID_A}`), { active: false }, { merge: true }));
    await assertFails(uploadBytes(ref(approvedContext().storage(), path), new Uint8Array([1]), storageMetadata(UID_A, 'asset-1', 'original')));

    const storage = approvedContext().storage();
    await assertFails(uploadBytes(ref(storage, `users/${UID_A}/workspace-v1/assets/asset-1/preview`), new Uint8Array([1]), storageMetadata(UID_A, 'asset-1', 'original')));
    await assertFails(uploadBytes(ref(storage, `users/${UID_A}/workspace-v1/assets/asset-1/original/nested`), new Uint8Array([1]), storageMetadata(UID_A, 'asset-1', 'original')));
    await assertFails(listAll(ref(storage, `users/${UID_A}/workspace-v1/assets/asset-1`)));
    await assertFails(listAll(ref(storage, `users/${UID_A}/workspace-v1/assets`)));
  });

  test('denies missing or extra metadata, path mismatches, invalid hashes and MIME types', async () => {
    const storage = approvedContext().storage();
    const path = `users/${UID_A}/workspace-v1/assets/asset-1/original`;
    await assertFails(uploadBytes(ref(storage, path), new Uint8Array([1]), { contentType: 'image/png' }));
    await assertFails(uploadBytes(ref(storage, path), new Uint8Array([1]), {
      ...storageMetadata(UID_A, 'asset-1', 'original'), customMetadata: { ...storageMetadata(UID_A, 'asset-1', 'original').customMetadata, extra: 'no' },
    }));
    await assertFails(uploadBytes(ref(storage, path), new Uint8Array([1]), storageMetadata(UID_B, 'asset-1', 'original')));
    await assertFails(uploadBytes(ref(storage, path), new Uint8Array([1]), storageMetadata(UID_A, 'other', 'original')));
    await assertFails(uploadBytes(ref(storage, path), new Uint8Array([1]), storageMetadata(UID_A, 'asset-1', 'thumb256')));
    await assertFails(uploadBytes(ref(storage, path), new Uint8Array([1]), storageMetadata(UID_A, 'asset-1', 'original', 'A'.repeat(64))));
    await assertFails(uploadBytes(ref(storage, path), new Uint8Array([1]), storageMetadata(UID_A, 'asset-1', 'original', HASH_A, 'application/pdf')));

    await assertSucceeds(uploadBytes(ref(storage, path), new Uint8Array([1]), storageMetadata(UID_A, 'asset-1', 'original')));
    await assertFails(uploadBytes(ref(storage, path), new Uint8Array([2]), storageMetadata(UID_A, 'asset-1', 'original', HASH_B, 'application/pdf')));
    await assertSucceeds(getBytes(ref(storage, path)));
  });

  test('denies original and thumbnail objects above their exact byte bounds', async () => {
    const storage = approvedContext().storage();
    await assertFails(uploadBytes(
      ref(storage, `users/${UID_A}/workspace-v1/assets/asset-large/original`),
      new Uint8Array(64 * 1024 * 1024 + 1),
      storageMetadata(UID_A, 'asset-large', 'original'),
    ));
    await assertFails(uploadBytes(
      ref(storage, `users/${UID_A}/workspace-v1/assets/asset-thumb/thumb256`),
      new Uint8Array(2 * 1024 * 1024 + 1),
      storageMetadata(UID_A, 'asset-thumb', 'thumb256', HASH_B, 'image/jpeg'),
    ));
  });
});

test('rules-disabled seeding still reaches denied legacy data', async () => {
  await testEnv.withSecurityRulesDisabled(async context => {
    assert.equal((await getDoc(doc(context.firestore(), LEGACY_FIRESTORE_PATHS[0]))).data()?.seeded, true);
    assert.deepEqual([...new Uint8Array(await getBytes(ref(context.storage(), LEGACY_STORAGE_PATHS[0])))], [1, 2, 3]);
  });
});
