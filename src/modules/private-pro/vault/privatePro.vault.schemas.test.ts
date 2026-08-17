import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  PRIVATE_PRO_VAULT_ARGON2ID_MAX_PARALLELISM,
  PRIVATE_PRO_VAULT_ARGON2ID_MIN_ITERATIONS,
  PRIVATE_PRO_VAULT_ARGON2ID_MIN_MEMORY_KIB,
  PRIVATE_PRO_VAULT_ARGON2ID_MIN_PARALLELISM,
  PRIVATE_PRO_VAULT_MAX_RECORD_CIPHERTEXT_BYTES,
  PRIVATE_PRO_PBKDF2_MIN_ITERATIONS,
  PrivateProVaultEnvelopeSchema,
  PrivateProVaultDeviceRegistrationSchema,
  PrivateProVaultPasswordEnvelopeSchema,
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

const VALID_PASSWORD_ENVELOPE = {
  formatVersion: 1,
  keyVersion: 1,
  kdf: {
    algorithm: 'argon2id',
    saltBase64: 'AAECAwQFBgcICQoLDA0ODw==',
    memoryKiB: PRIVATE_PRO_VAULT_ARGON2ID_MIN_MEMORY_KIB,
    iterations: PRIVATE_PRO_VAULT_ARGON2ID_MIN_ITERATIONS,
    parallelism: PRIVATE_PRO_VAULT_ARGON2ID_MIN_PARALLELISM,
  },
  nonceBase64: 'AAECAwQFBgcICQoL',
  ciphertextBase64: 'AAECAwQFBgcICQoLDA0ODw==',
  ciphertextBytes: 16,
} as const;

const VALID_PBKDF2_PASSWORD_ENVELOPE = {
  ...VALID_PASSWORD_ENVELOPE,
  kdf: {
    algorithm: 'pbkdf2-sha256',
    saltBase64: 'AAECAwQFBgcICQoLDA0ODw==',
    iterations: PRIVATE_PRO_PBKDF2_MIN_ITERATIONS,
  },
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

  test('rejects a base64 alias with nonzero unused ciphertext bits', () => {
    assert.equal(PrivateProVaultEnvelopeSchema.safeParse({
      ...VALID_ENVELOPE,
      ciphertextBase64: 'AAECAwQFBgcICQoLDA0ODx==',
    }).success, false);
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

  test('rejects an Argon2id memory cost below the security floor', () => {
    assert.equal(PrivateProVaultPasswordEnvelopeSchema.safeParse({
      ...VALID_PASSWORD_ENVELOPE,
      kdf: { ...VALID_PASSWORD_ENVELOPE.kdf, memoryKiB: PRIVATE_PRO_VAULT_ARGON2ID_MIN_MEMORY_KIB - 1 },
    }).success, false);
  });

  test('accepts the Argon2id memory security floor', () => {
    assert.equal(PrivateProVaultPasswordEnvelopeSchema.safeParse(VALID_PASSWORD_ENVELOPE).success, true);
  });

  test('rejects Argon2id iterations below the security floor', () => {
    assert.equal(PrivateProVaultPasswordEnvelopeSchema.safeParse({
      ...VALID_PASSWORD_ENVELOPE,
      kdf: { ...VALID_PASSWORD_ENVELOPE.kdf, iterations: PRIVATE_PRO_VAULT_ARGON2ID_MIN_ITERATIONS - 1 },
    }).success, false);
  });

  test('accepts the Argon2id iteration security floor', () => {
    assert.equal(PrivateProVaultPasswordEnvelopeSchema.safeParse(VALID_PASSWORD_ENVELOPE).success, true);
  });

  test('rejects Argon2id parallelism below the security floor', () => {
    assert.equal(PrivateProVaultPasswordEnvelopeSchema.safeParse({
      ...VALID_PASSWORD_ENVELOPE,
      kdf: { ...VALID_PASSWORD_ENVELOPE.kdf, parallelism: PRIVATE_PRO_VAULT_ARGON2ID_MIN_PARALLELISM - 1 },
    }).success, false);
  });

  test('accepts the Argon2id parallelism security floor', () => {
    assert.equal(PrivateProVaultPasswordEnvelopeSchema.safeParse(VALID_PASSWORD_ENVELOPE).success, true);
  });

  test('rejects Argon2id parallelism above the bounded range', () => {
    assert.equal(PrivateProVaultPasswordEnvelopeSchema.safeParse({
      ...VALID_PASSWORD_ENVELOPE,
      kdf: { ...VALID_PASSWORD_ENVELOPE.kdf, parallelism: PRIVATE_PRO_VAULT_ARGON2ID_MAX_PARALLELISM + 1 },
    }).success, false);
  });

  test('rejects PBKDF2 iterations below the compatibility security floor', () => {
    assert.equal(PrivateProVaultPasswordEnvelopeSchema.safeParse({
      ...VALID_PBKDF2_PASSWORD_ENVELOPE,
      kdf: { ...VALID_PBKDF2_PASSWORD_ENVELOPE.kdf, iterations: PRIVATE_PRO_PBKDF2_MIN_ITERATIONS - 1 },
    }).success, false);
  });

  test('accepts the PBKDF2 compatibility security floor', () => {
    assert.equal(PrivateProVaultPasswordEnvelopeSchema.safeParse(VALID_PBKDF2_PASSWORD_ENVELOPE).success, true);
  });

  test('accepts only strict public P-256 registration JWK fields', () => {
    const valid = {
      algorithm: 'ECDSA-P256-SHA256',
      keyVersion: 1,
      publicJwk: {
        kty: 'EC', crv: 'P-256',
        x: 'DQ9dV0Ox8qzTjqhmlAAmBQJuobtsfi7yGJmudlgj88o',
        y: 'tFuyoZPxIC7Zy05p9pXoCDacjIlJlBNblHjZrDksE1c',
      },
      privateKeyEnvelope: { nonceBase64: 'AAECAwQFBgcICQoL', ciphertextBase64: 'AAECAwQFBgcICQoLDA0ODw==', ciphertextBytes: 16 },
    };
    assert.equal(PrivateProVaultDeviceRegistrationSchema.safeParse(valid).success, true);
    assert.equal(PrivateProVaultDeviceRegistrationSchema.safeParse({
      ...valid,
      publicJwk: { ...valid.publicJwk, d: 'private-material' },
    }).success, false);
    assert.equal(PrivateProVaultDeviceRegistrationSchema.safeParse({
      ...valid,
      publicJwk: { ...valid.publicJwk, crv: 'P-384' },
    }).success, false);
  });
});
