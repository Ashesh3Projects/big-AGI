import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  PRIVATE_PRO_VAULT_MAX_RECORD_CIPHERTEXT_BYTES,
  PrivateProVaultEnvelopeSchema,
} from './privatePro.vault.schemas';


const VALID_ENVELOPE = {
  formatVersion: 1,
  recordType: 'settings',
  recordId: 'record-1',
  schemaVersion: 1,
  keyVersion: 1,
  revision: 1,
  nonceBase64: 'AAECAwQFBgcICQoL',
  ciphertextBase64: 'AAECAwQFBgcICQoLDA0ODw==',
  ciphertextBytes: 16,
} as const;


describe('private Pro vault schemas', () => {
  test('accepts a valid encrypted record envelope', () => {
    assert.deepEqual(PrivateProVaultEnvelopeSchema.parse(VALID_ENVELOPE), VALID_ENVELOPE);
  });

  test('rejects an unknown record type', () => {
    assert.equal(PrivateProVaultEnvelopeSchema.safeParse({ ...VALID_ENVELOPE, recordType: 'unknown' }).success, false);
  });

  test('rejects a zero revision', () => {
    assert.equal(PrivateProVaultEnvelopeSchema.safeParse({ ...VALID_ENVELOPE, revision: 0 }).success, false);
  });

  test('rejects a negative revision', () => {
    assert.equal(PrivateProVaultEnvelopeSchema.safeParse({ ...VALID_ENVELOPE, revision: -1 }).success, false);
  });

  test('rejects malformed base64', () => {
    assert.equal(PrivateProVaultEnvelopeSchema.safeParse({ ...VALID_ENVELOPE, ciphertextBase64: 'not base64!' }).success, false);
  });

  test('rejects oversized ciphertext', () => {
    assert.equal(PrivateProVaultEnvelopeSchema.safeParse({
      ...VALID_ENVELOPE,
      ciphertextBytes: PRIVATE_PRO_VAULT_MAX_RECORD_CIPHERTEXT_BYTES + 1,
    }).success, false);
  });

  test('rejects unexpected envelope fields', () => {
    assert.equal(PrivateProVaultEnvelopeSchema.safeParse({ ...VALID_ENVELOPE, plaintext: 'must not be accepted' }).success, false);
  });
});
