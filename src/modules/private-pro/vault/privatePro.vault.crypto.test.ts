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

function generateAesKey(length: 128 | 192 | 256, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length }, false, usages) as Promise<CryptoKey>;
}

function generateHmacKey(hash: 'SHA-256' | 'SHA-384', usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'HMAC', hash }, false, usages) as Promise<CryptoKey>;
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

  test('rejects record encryption keys with the wrong algorithm, length, or usage', async () => {
    const hmacKey = await generateHmacKey('SHA-256', ['sign']);
    const aes128Key = await generateAesKey(128, ['encrypt']);
    const aes192Key = await generateAesKey(192, ['encrypt']);
    const decryptOnlyKey = await generateAesKey(256, ['decrypt']);

    await assert.rejects(encryptVaultRecord(hmacKey, RECORD_AAD, PLAINTEXT), /AES-GCM 256-bit key with encrypt usage/);
    await assert.rejects(encryptVaultRecord(aes128Key, RECORD_AAD, PLAINTEXT), /AES-GCM 256-bit key with encrypt usage/);
    await assert.rejects(encryptVaultRecord(aes192Key, RECORD_AAD, PLAINTEXT), /AES-GCM 256-bit key with encrypt usage/);
    await assert.rejects(encryptVaultRecord(decryptOnlyKey, RECORD_AAD, PLAINTEXT), /AES-GCM 256-bit key with encrypt usage/);
  });

  test('rejects record decryption keys with the wrong algorithm, length, or usage', async () => {
    const key = await recordKey();
    const envelope = await encryptVaultRecord(key, RECORD_AAD, PLAINTEXT);
    const hmacKey = await generateHmacKey('SHA-256', ['sign']);
    const aes128Key = await generateAesKey(128, ['decrypt']);
    const aes192Key = await generateAesKey(192, ['decrypt']);
    const encryptOnlyKey = await generateAesKey(256, ['encrypt']);

    await assert.rejects(decryptVaultRecord(hmacKey, envelope, VAULT_CONTEXT), /AES-GCM 256-bit key with decrypt usage/);
    await assert.rejects(decryptVaultRecord(aes128Key, envelope, VAULT_CONTEXT), /AES-GCM 256-bit key with decrypt usage/);
    await assert.rejects(decryptVaultRecord(aes192Key, envelope, VAULT_CONTEXT), /AES-GCM 256-bit key with decrypt usage/);
    await assert.rejects(decryptVaultRecord(encryptOnlyKey, envelope, VAULT_CONTEXT), /AES-GCM 256-bit key with decrypt usage/);
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

  test('rejects subkey derivation keys with the wrong algorithm or usage', async () => {
    const aesKey = await generateAesKey(256, ['encrypt']);
    const deriveBitsOnlyKey = await crypto.subtle.importKey('raw', new Uint8Array(32), 'HKDF', false, ['deriveBits']);

    await assert.rejects(deriveVaultSubkey(aesKey, 'identifier', 'vault', ['sign']), /HKDF key with deriveKey usage/);
    await assert.rejects(deriveVaultSubkey(deriveBitsOnlyKey, 'identifier', 'vault', ['sign']), /HKDF key with deriveKey usage/);
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

  test('rejects HMAC identifier keys with the wrong algorithm, hash, or usage', async () => {
    const aesKey = await generateAesKey(256, ['encrypt']);
    const sha384Key = await generateHmacKey('SHA-384', ['sign']);
    const verifyOnlyKey = await generateHmacKey('SHA-256', ['verify']);

    await assert.rejects(hmacVaultIdentifier(aesKey, 'service', 'secret'), /HMAC SHA-256 key with sign usage/);
    await assert.rejects(hmacVaultIdentifier(sha384Key, 'service', 'secret'), /HMAC SHA-256 key with sign usage/);
    await assert.rejects(hmacVaultIdentifier(verifyOnlyKey, 'service', 'secret'), /HMAC SHA-256 key with sign usage/);
  });

  test('rejects unpaired UTF-16 surrogates in authenticated-data strings', () => {
    for (const surrogate of ['\uD800', '\uDC00']) {
      assert.throws(() => vaultRecordAAD({ ...RECORD_AAD, vaultId: surrogate }), /Unicode scalar values/);
      assert.throws(() => vaultRecordAAD({ ...RECORD_AAD, recordId: surrogate }), /Unicode scalar values/);
      assert.throws(() => vaultRecordAAD({ ...RECORD_AAD, recordType: surrogate as VaultRecordAADInput['recordType'] }), /Unicode scalar values/);
    }
  });

  test('rejects unpaired UTF-16 surrogates in HKDF purpose and ID', async () => {
    const masterKey = await importVaultMasterKey(new Uint8Array(32).fill(0x66));

    for (const surrogate of ['\uD800', '\uDC00']) {
      await assert.rejects(deriveVaultSubkey(masterKey, surrogate, 'vault', ['sign']), /Unicode scalar values/);
      await assert.rejects(deriveVaultSubkey(masterKey, 'identifier', surrogate, ['sign']), /Unicode scalar values/);
    }
  });

  test('rejects unpaired UTF-16 surrogates in HMAC namespace and value', async () => {
    const masterKey = await importVaultMasterKey(new Uint8Array(32).fill(0x77));
    const key = await deriveVaultSubkey(masterKey, 'identifier', 'vault', ['sign']);

    for (const surrogate of ['\uD800', '\uDC00']) {
      await assert.rejects(hmacVaultIdentifier(key, surrogate, 'secret'), /Unicode scalar values/);
      await assert.rejects(hmacVaultIdentifier(key, 'service', surrogate), /Unicode scalar values/);
    }
  });

  test('accepts U+FFFD as a distinct Unicode scalar value', async () => {
    const masterKey = await importVaultMasterKey(new Uint8Array(32).fill(0x78));
    const key = await deriveVaultSubkey(masterKey, 'identifier', '\uFFFD', ['sign']);
    const replacementIdentifier = await hmacVaultIdentifier(key, '\uFFFD', '\uFFFD');
    const ordinaryIdentifier = await hmacVaultIdentifier(key, 'replacement', 'replacement');

    assert.notEqual(replacementIdentifier, ordinaryIdentifier);
    assert.notDeepEqual(vaultRecordAAD({ ...RECORD_AAD, vaultId: '\uFFFD' }), vaultRecordAAD(RECORD_AAD));
  });
});
