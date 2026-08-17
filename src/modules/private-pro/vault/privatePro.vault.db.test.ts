import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';

import Dexie from 'dexie';

import { PrivateProVaultDB } from './privatePro.vault.db';
import { PrivateProVaultSession } from './privatePro.vault.session';
import type { PrivateProVaultEnvelope, PrivateProVaultWrappedKeyEnvelope } from './privatePro.vault.types';


const UID_A = 'uid-a';
const UID_B = 'uid-b';

const ENVELOPE_A: PrivateProVaultEnvelope = {
  formatVersion: 1,
  recordType: 'settings',
  recordId: 'theme',
  schemaVersion: 1,
  keyVersion: 1,
  revision: 2,
  nonceBase64: 'AAAAAAAAAAAAAAAA',
  ciphertextBase64: 'AAAAAAAAAAAAAAAAAAAAAA==',
  ciphertextBytes: 16,
};

const ENVELOPE_B: PrivateProVaultEnvelope = {
  ...ENVELOPE_A,
  recordId: 'language',
  revision: 3,
  ciphertextBase64: 'AQEBAQEBAQEBAQEBAQEBAQ==',
};

const WRAPPED_KEY_A: PrivateProVaultWrappedKeyEnvelope = {
  nonceBase64: 'AAAAAAAAAAAAAAAA',
  ciphertextBase64: 'AAAAAAAAAAAAAAAAAAAAAA==',
  ciphertextBytes: 16,
};

const WRAPPED_KEY_B: PrivateProVaultWrappedKeyEnvelope = {
  nonceBase64: 'AQEBAQEBAQEBAQEB',
  ciphertextBase64: 'AQEBAQEBAQEBAQEBAQEBAQ==',
  ciphertextBytes: 16,
};


function createDB(t: TestContext): PrivateProVaultDB {
  const name = `private-pro-vault-test-${crypto.randomUUID()}`;
  const db = new PrivateProVaultDB(name);
  t.after(async () => {
    db.close();
    await Dexie.delete(name);
  });
  return db;
}

function generateDeviceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  ) as Promise<CryptoKey>;
}

function importMasterKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    'HKDF',
    false,
    ['deriveKey'],
  );
}


describe('private Pro encrypted vault database', () => {
  test('opens the deliberately versioned ciphertext-only table set', async (t) => {
    const db = createDB(t);

    await db.open();

    assert.equal(db.verno, 1);
    assert.deepEqual(
      db.tables.map(table => table.name).sort(),
      ['deviceKeys', 'migration', 'outbox', 'quarantine', 'records', 'revisions', 'wrappedKeys'].sort(),
    );
  });

  test('structured-clones a non-exportable device key that can unwrap a master key', async (t) => {
    const db = createDB(t);
    const deviceKey = await generateDeviceKey();
    const masterKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    ) as CryptoKey;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrappedMasterKey = await crypto.subtle.wrapKey('raw', masterKey, deviceKey, { name: 'AES-GCM', iv });

    await db.storeDeviceKey(UID_A, deviceKey);
    db.close();
    await db.open();

    const retrievedKey = await db.getDeviceKey(UID_A);
    if (!retrievedKey) assert.fail('Expected the remembered device key to persist.');
    assert.equal(retrievedKey.extractable, false);
    await assert.rejects(crypto.subtle.exportKey('raw', retrievedKey), /key is not extractable/i);

    const unwrappedMasterKey = await crypto.subtle.unwrapKey(
      'raw',
      wrappedMasterKey,
      retrievedKey,
      { name: 'AES-GCM', iv },
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode('vault master key works');
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, unwrappedMasterKey, plaintext);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, unwrappedMasterKey, ciphertext);

    assert.deepEqual(new Uint8Array(decrypted), plaintext);
  });

  test('scopes device keys and encrypted records by UID', async (t) => {
    const db = createDB(t);
    const deviceKeyA = await generateDeviceKey();
    const deviceKeyB = await generateDeviceKey();

    await db.storeDeviceKey(UID_A, deviceKeyA);
    await db.storeDeviceKey(UID_B, deviceKeyB);
    await db.putEncryptedRecord(UID_A, ENVELOPE_A);
    await db.putEncryptedRecord(UID_B, ENVELOPE_B);

    assert.equal((await db.getDeviceKey(UID_A))?.usages.includes('unwrapKey'), true);
    assert.equal((await db.getDeviceKey(UID_B))?.usages.includes('unwrapKey'), true);
    assert.deepEqual(await db.listEncryptedRecords(UID_A), [ENVELOPE_A]);
    assert.deepEqual(await db.listEncryptedRecords(UID_B), [ENVELOPE_B]);
  });

  test('rejects plaintext fields instead of persisting them with an encrypted record', async (t) => {
    const db = createDB(t);
    const recordWithPlaintext = {
      ...ENVELOPE_A,
      plaintext: { theme: 'dark' },
    } as unknown as PrivateProVaultEnvelope;

    await assert.rejects(db.putEncryptedRecord(UID_A, recordWithPlaintext));
    assert.deepEqual(await db.listEncryptedRecords(UID_A), []);
  });

  test('logout locks the in-memory master key and deletes automatic unlock data only for that UID', async (t) => {
    const db = createDB(t);
    const session = new PrivateProVaultSession(db);
    const masterKey = await importMasterKey();

    await db.storeDeviceKey(UID_A, await generateDeviceKey());
    await db.storeDeviceKey(UID_B, await generateDeviceKey());
    await db.wrappedKeys.put({ uid: UID_A, envelope: WRAPPED_KEY_A });
    await db.wrappedKeys.put({ uid: UID_B, envelope: WRAPPED_KEY_B });
    session.unlock(UID_A, masterKey);

    assert.equal(session.getMasterKey(UID_A), masterKey);
    assert.equal(session.getMasterKey(UID_B), null);

    await session.logoutAndClear(UID_A);

    assert.equal(session.getMasterKey(UID_A), null);
    assert.equal(await db.getDeviceKey(UID_A), null);
    assert.equal(await db.wrappedKeys.get(UID_A), undefined);
    assert.notEqual(await db.getDeviceKey(UID_B), null);
    assert.notEqual(await db.wrappedKeys.get(UID_B), undefined);
  });

  test('lock drops the master key without deleting remembered unlock data', async (t) => {
    const db = createDB(t);
    const session = new PrivateProVaultSession(db);
    const masterKey = await importMasterKey();
    await db.storeDeviceKey(UID_A, await generateDeviceKey());
    session.unlock(UID_A, masterKey);

    session.lock();

    assert.equal(session.getMasterKey(UID_A), null);
    assert.notEqual(await db.getDeviceKey(UID_A), null);
  });
});
