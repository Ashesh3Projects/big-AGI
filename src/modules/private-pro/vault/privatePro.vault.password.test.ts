import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as passwordModule from './privatePro.vault.password';
import * as passwordWorkerModule from './privatePro.vault.password.worker';
import {
  derivePasswordWrappingKey,
  derivePasswordWrappingKeyWithCompatibility,
  privateProVaultArgon2idWorkerUrl,
  type VaultPasswordKdfParams,
} from './privatePro.vault.password';
import { realArgon2idWorkerResponse, withVaultPasswordWorker } from '../../../../tools/private-pro/test-helpers/privatePro.vault.password.test-helpers';
import { generateRecoveryKey, parseRecoveryKey } from './privatePro.vault.recovery';
import {
  PRIVATE_PRO_VAULT_ARGON2ID_MIN_ITERATIONS,
  PRIVATE_PRO_VAULT_ARGON2ID_MIN_MEMORY_KIB,
  PRIVATE_PRO_VAULT_ARGON2ID_MIN_PARALLELISM,
} from './privatePro.vault.schemas';


const KNOWN_ANSWER_PARAMS = {
  algorithm: 'argon2id',
  saltBase64: 'AAECAwQFBgcICQoLDA0ODw==',
  memoryKiB: PRIVATE_PRO_VAULT_ARGON2ID_MIN_MEMORY_KIB,
  iterations: PRIVATE_PRO_VAULT_ARGON2ID_MIN_ITERATIONS,
  parallelism: PRIVATE_PRO_VAULT_ARGON2ID_MIN_PARALLELISM,
} as const satisfies VaultPasswordKdfParams;

const KNOWN_MASTER_KEY_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index + 32);
const ZERO_NONCE = new Uint8Array(12);
const KNOWN_WRAPPED_MASTER_KEY_BASE64 = '3Ma73Q7usEYsQk4hIk7p2RtIUbDy735AUL55e89R2BdilVgGNBUlttruijbZueZT';


function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}

async function unwrapKnownMasterKey(password: string): Promise<Uint8Array> {
  const wrappingKey = await withVaultPasswordWorker(
    realArgon2idWorkerResponse,
    () => derivePasswordWrappingKey(password, KNOWN_ANSWER_PARAMS),
  );
  const unwrapped = await crypto.subtle.unwrapKey(
    'raw',
    base64ToBytes(KNOWN_WRAPPED_MASTER_KEY_BASE64),
    wrappingKey,
    { name: 'AES-GCM', iv: ZERO_NONCE },
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt'],
  );
  return new Uint8Array(await crypto.subtle.exportKey('raw', unwrapped));
}


describe('private Pro vault password derivation', () => {
  test('matches the fixed Argon2id wrapping known answer', async () => {
    assert.deepEqual(await unwrapKnownMasterKey('correct horse battery staple'), KNOWN_MASTER_KEY_BYTES);
  });

  test('fails closed when a wrong password unwraps the known answer', async () => {
    await assert.rejects(
      unwrapKnownMasterKey('wrong password'),
      error => error instanceof DOMException && error.name === 'OperationError',
    );
  });

  test('returns a non-exportable 256-bit AES-GCM wrapping key', async () => {
    const key = await withVaultPasswordWorker(
      realArgon2idWorkerResponse,
      () => derivePasswordWrappingKey('correct horse battery staple', KNOWN_ANSWER_PARAMS),
    );

    assert.equal(key.algorithm.name, 'AES-GCM');
    assert.equal('length' in key.algorithm ? key.algorithm.length : undefined, 256);
    assert.equal(key.extractable, false);
    assert.deepEqual(key.usages, ['wrapKey', 'unwrapKey']);
    await assert.rejects(crypto.subtle.exportKey('raw', key));
  });

  test('rejects every Argon2id parameter below the Task 7 floor', async () => {
    for (const params of [
      { ...KNOWN_ANSWER_PARAMS, memoryKiB: PRIVATE_PRO_VAULT_ARGON2ID_MIN_MEMORY_KIB - 1 },
      { ...KNOWN_ANSWER_PARAMS, iterations: PRIVATE_PRO_VAULT_ARGON2ID_MIN_ITERATIONS - 1 },
      { ...KNOWN_ANSWER_PARAMS, parallelism: PRIVATE_PRO_VAULT_ARGON2ID_MIN_PARALLELISM - 1 },
    ]) {
      await assert.rejects(
        derivePasswordWrappingKey('never log this password', params),
        error => error instanceof Error
          && /parameters/i.test(error.message)
          && !error.message.includes('never log this password'),
      );
    }
  });

  test('uses the dedicated bundled worker entry point', () => {
    assert.match(privateProVaultArgon2idWorkerUrl().pathname, /privatePro\.vault\.password\.worker\.ts$/);
  });

  test('does not run Argon2id on a runtime without browser workers', async () => {
    await assert.rejects(
      derivePasswordWrappingKey('never log this password', KNOWN_ANSWER_PARAMS),
      error => error instanceof Error
        && /browser.*worker/i.test(error.message)
        && !error.message.includes('never log this password'),
    );
  });

  test('does not activate PBKDF2 merely because the Worker API is missing', async () => {
    await assert.rejects(
      derivePasswordWrappingKeyWithCompatibility(
        'never log this password',
        KNOWN_ANSWER_PARAMS,
        { algorithm: 'pbkdf2-sha256', iterations: 600_000, saltBase64: KNOWN_ANSWER_PARAMS.saltBase64 },
      ),
      error => error instanceof Error
        && /derivation failed/i.test(error.message)
        && !error.message.includes('never log this password'),
    );
  });

  test('does not expose or honor application-supplied Argon2id derivation controls', async () => {
    assert.equal('VaultPasswordWorkerIncompatibilityError' in passwordModule, false);
    assert.equal('deriveArgon2idBytesInWorker' in passwordWorkerModule, false);

    await assert.rejects(
      (derivePasswordWrappingKey as unknown as (...args: unknown[]) => Promise<CryptoKey>)(
        'never log this password',
        KNOWN_ANSWER_PARAMS,
        async () => new Uint8Array(32),
      ),
      /browser.*worker/i,
    );
  });

  test('ignores an application-supplied compatibility deriver and uses the real worker result', async () => {
    const fallback = { algorithm: 'pbkdf2-sha256', iterations: 600_000, saltBase64: KNOWN_ANSWER_PARAMS.saltBase64 } as const;
    const result = await withVaultPasswordWorker(
      () => ({ protocolVersion: 1, kind: 'incompatible', reason: 'memory-limit' }),
      () => (derivePasswordWrappingKeyWithCompatibility as unknown as (...args: unknown[]) => ReturnType<typeof derivePasswordWrappingKeyWithCompatibility>)(
        'correct horse battery staple',
        KNOWN_ANSWER_PARAMS,
        fallback,
        async () => new Uint8Array(32),
      ),
    );

    assert.deepEqual(result.params, fallback);
  });

  test('does not permit PBKDF2 fallback after an ordinary Argon2id failure', async () => {
    await withVaultPasswordWorker(
      () => ({ protocolVersion: 1, kind: 'failure' }),
      () => assert.rejects(
        derivePasswordWrappingKeyWithCompatibility(
          'never log this password',
          KNOWN_ANSWER_PARAMS,
          { algorithm: 'pbkdf2-sha256', iterations: 600_000, saltBase64: KNOWN_ANSWER_PARAMS.saltBase64 },
        ),
        error => error instanceof Error
          && /derivation failed/i.test(error.message)
          && !error.message.includes('never log this password'),
      ),
    );
  });

  test('uses the versioned PBKDF2 fallback only after supported worker incompatibility', async () => {
    const fallback = { algorithm: 'pbkdf2-sha256', iterations: 600_000, saltBase64: KNOWN_ANSWER_PARAMS.saltBase64 } as const;
    const result = await withVaultPasswordWorker(
      () => ({ protocolVersion: 1, kind: 'incompatible', reason: 'wasm-unavailable' }),
      () => derivePasswordWrappingKeyWithCompatibility(
        'correct horse battery staple',
        KNOWN_ANSWER_PARAMS,
        fallback,
      ),
    );

    assert.deepEqual(result.params, fallback);
    assert.equal(result.key.extractable, false);
    assert.deepEqual(result.key.usages, ['wrapKey', 'unwrapKey']);
  });
});

describe('private Pro vault recovery keys', () => {
  test('generates a printable grouped base32 key that round trips 256 random bits', () => {
    const { display, bytes } = generateRecoveryKey();

    assert.match(display, /^(?:[A-Z2-7]{4}-){13}[A-Z2-7]{4}$/);
    assert.equal(bytes.byteLength, 32);
    assert.deepEqual(parseRecoveryKey(display), bytes);
  });

  test('rejects a recovery-key checksum mutation', () => {
    const { display } = generateRecoveryKey();
    const finalCharacter = display.at(-1);
    assert.ok(finalCharacter);
    const mutated = `${display.slice(0, -1)}${finalCharacter === 'A' ? 'B' : 'A'}`;

    assert.throws(() => parseRecoveryKey(mutated), /checksum/i);
  });

  test('normalizes case, whitespace, and grouping separators', () => {
    const generated = generateRecoveryKey();
    const display = generated.display.toLowerCase().replaceAll('-', ' \n ');

    assert.deepEqual(parseRecoveryKey(display), generated.bytes);
  });
});
