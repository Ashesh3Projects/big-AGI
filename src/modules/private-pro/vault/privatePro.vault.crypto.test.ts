import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  decryptVaultRecord,
  deriveVaultSubkey,
  encryptVaultRecord,
  generateVaultMasterKeyBytes,
  hmacVaultIdentifier,
  importVaultMasterKey,
  PRIVATE_PRO_VAULT_CIPHER_SUITE,
  vaultRecordAAD,
  type PrivateProVaultContext,
  type VaultRecordAADInput,
} from './privatePro.vault.crypto';
import type { PrivateProVaultEnvelope } from './privatePro.vault.types';


const VAULT_CONTEXT: PrivateProVaultContext = { vaultId: 'uid-derived-vault-a' };
const RECORD_AAD: VaultRecordAADInput = {
  ...VAULT_CONTEXT,
  formatVersion: 1,
  recordType: 'settings',
  recordId: 'preferences',
  schemaVersion: 3,
  keyVersion: 2,
  revision: 7,
};
const PLAINTEXT = new TextEncoder().encode('private settings');


async function recordKey(aad: VaultRecordAADInput = RECORD_AAD): Promise<CryptoKey> {
  const masterKey = await importVaultMasterKey(new Uint8Array(32).fill(0x42));
  return deriveVaultSubkey(masterKey, 'record-encryption', `${aad.recordType}/${aad.recordId}`, ['encrypt', 'decrypt']);
}

function mutateBase64Byte(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  bytes[0] ^= 1;
  let binary = '';
  for (const byte of bytes)
    binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function assertDecryptRejects(envelope: PrivateProVaultEnvelope, context = VAULT_CONTEXT): Promise<void> {
  await assert.rejects(decryptVaultRecord(await recordKey(), envelope, context));
}


describe('private Pro vault cryptography', () => {
  test('encrypts and decrypts a record with canonical envelope metadata', async () => {
    const key = await recordKey();
    const envelope = await encryptVaultRecord(key, RECORD_AAD, PLAINTEXT);

    assert.deepEqual(await decryptVaultRecord(key, envelope, VAULT_CONTEXT), PLAINTEXT);
    assert.equal(envelope.ciphertextBytes, PLAINTEXT.byteLength + 16);
    assert.equal(btoa(atob(envelope.nonceBase64)), envelope.nonceBase64);
    assert.equal(btoa(atob(envelope.ciphertextBase64)), envelope.ciphertextBase64);
  });

  test('rejects a correct ciphertext under a different UID-derived vault context', async () => {
    const key = await recordKey();
    const envelope = await encryptVaultRecord(key, RECORD_AAD, PLAINTEXT);

    await assertDecryptRejects(envelope, { vaultId: 'uid-derived-vault-b' });
  });

  test('rejects tampering with every authenticated envelope field', async () => {
    const key = await recordKey();
    const envelope = await encryptVaultRecord(key, RECORD_AAD, PLAINTEXT);
    const tamperedEnvelopes: PrivateProVaultEnvelope[] = [
      { ...envelope, formatVersion: 2 } as unknown as PrivateProVaultEnvelope,
      { ...envelope, recordType: 'chat' },
      { ...envelope, recordId: 'other-record' },
      { ...envelope, schemaVersion: envelope.schemaVersion + 1 },
      { ...envelope, keyVersion: envelope.keyVersion + 1 },
      { ...envelope, revision: envelope.revision + 1 },
      { ...envelope, nonceBase64: mutateBase64Byte(envelope.nonceBase64) },
      { ...envelope, ciphertextBase64: mutateBase64Byte(envelope.ciphertextBase64) },
      { ...envelope, ciphertextBytes: envelope.ciphertextBytes + 1 },
    ];

    for (const tamperedEnvelope of tamperedEnvelopes)
      await assertDecryptRejects(tamperedEnvelope);
  });

  test('binds the cipher suite into record authenticated data', () => {
    const aad = new TextDecoder().decode(vaultRecordAAD(RECORD_AAD));

    assert.match(aad, new RegExp(PRIVATE_PRO_VAULT_CIPHER_SUITE.replaceAll('+', '\\+')));
  });

  test('uses a unique 96-bit nonce across 10,000 encryptions', async () => {
    const key = await recordKey();
    const nonces = new Set<string>();

    for (let index = 0; index < 10_000; index++) {
      const envelope = await encryptVaultRecord(key, RECORD_AAD, PLAINTEXT);
      assert.equal(atob(envelope.nonceBase64).length, 12);
      nonces.add(envelope.nonceBase64);
    }

    assert.equal(nonces.size, 10_000);
  });

  test('generates and imports a non-exportable 256-bit master key by default', async () => {
    const bytes = generateVaultMasterKeyBytes();
    const key = await importVaultMasterKey(bytes);

    assert.equal(bytes.byteLength, 32);
    assert.equal(key.extractable, false);
    await assert.rejects(crypto.subtle.exportKey('raw', key));
  });

  test('rejects an extractable HKDF master key request', async () => {
    await assert.rejects(
      importVaultMasterKey(new Uint8Array(32).fill(0x11), true),
      /HKDF master keys cannot be extractable/,
    );
  });

  test('derives deterministic non-exportable subkeys with purpose and ID domain separation', async () => {
    const masterKey = await importVaultMasterKey(new Uint8Array(32).fill(0x24));
    const identifierKeyA = await deriveVaultSubkey(masterKey, 'identifier', 'namespace-a', ['sign']);
    const identifierKeyA2 = await deriveVaultSubkey(masterKey, 'identifier', 'namespace-a', ['sign']);
    const identifierKeyOtherPurpose = await deriveVaultSubkey(masterKey, 'other-purpose', 'namespace-a', ['sign']);
    const identifierKeyOtherId = await deriveVaultSubkey(masterKey, 'identifier', 'namespace-b', ['sign']);

    assert.equal(identifierKeyA.extractable, false);
    assert.equal(await hmacVaultIdentifier(identifierKeyA, 'service', 'secret'), await hmacVaultIdentifier(identifierKeyA2, 'service', 'secret'));
    assert.notEqual(await hmacVaultIdentifier(identifierKeyA, 'service', 'secret'), await hmacVaultIdentifier(identifierKeyOtherPurpose, 'service', 'secret'));
    assert.notEqual(await hmacVaultIdentifier(identifierKeyA, 'service', 'secret'), await hmacVaultIdentifier(identifierKeyOtherId, 'service', 'secret'));
  });

  test('matches the HKDF and HMAC known-answer vector', async () => {
    const masterKey = await importVaultMasterKey(new Uint8Array(32).fill(0x24));
    const identifierKey = await deriveVaultSubkey(masterKey, 'identifier', 'namespace-a', ['sign']);

    assert.equal(
      await hmacVaultIdentifier(identifierKey, 'service', 'secret'),
      'I1VUdIejzIEc1d0fCz7j_p3AAv-8cJPPKk8BSSss22A',
    );
  });

  test('domain-separates HMAC identifiers by namespace and value', async () => {
    const masterKey = await importVaultMasterKey(new Uint8Array(32).fill(0x55));
    const key = await deriveVaultSubkey(masterKey, 'identifier', 'vault', ['sign']);
    const identifier = await hmacVaultIdentifier(key, 'credential-service', 'same-value');

    assert.match(identifier, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(identifier, await hmacVaultIdentifier(key, 'model-service', 'same-value'));
    assert.notEqual(identifier, await hmacVaultIdentifier(key, 'credential-service', 'different-value'));
  });
});
