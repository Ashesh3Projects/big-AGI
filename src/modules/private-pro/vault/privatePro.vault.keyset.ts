import {
  generateVaultMasterKeyBytes,
  importVaultMasterKey,
} from './privatePro.vault.crypto';
import { derivePasswordWrappingKey, derivePasswordWrappingKeyWithCompatibility } from './privatePro.vault.password';
import { generateRecoveryKey, parseRecoveryKey } from './privatePro.vault.recovery';
import {
  PRIVATE_PRO_PBKDF2_MIN_ITERATIONS,
  PRIVATE_PRO_VAULT_ARGON2ID_MIN_ITERATIONS,
  PRIVATE_PRO_VAULT_ARGON2ID_MIN_MEMORY_KIB,
  PRIVATE_PRO_VAULT_ARGON2ID_MIN_PARALLELISM,
  PrivateProVaultKeysetSchema,
} from './privatePro.vault.schemas';
import type {
  PrivateProVaultKeyset,
  PrivateProVaultPasswordEnvelope,
  PrivateProVaultRecoveryEnvelope,
  PrivateProVaultWrappedKeyEnvelope,
} from './privatePro.vault.types';


const WRAP_ALGORITHM = 'AES-GCM';


function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}

function randomBase64(byteLength: number): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function wrapMasterKeyBytes(
  masterKeyBytes: Uint8Array<ArrayBuffer>,
  wrappingKey: CryptoKey,
): Promise<PrivateProVaultWrappedKeyEnvelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const masterKey = await crypto.subtle.importKey('raw', masterKeyBytes, WRAP_ALGORITHM, true, ['wrapKey']);
  const ciphertext = new Uint8Array(await crypto.subtle.wrapKey('raw', masterKey, wrappingKey, {
    name: WRAP_ALGORITHM,
    iv: nonce,
  }));
  return {
    nonceBase64: bytesToBase64(nonce),
    ciphertextBase64: bytesToBase64(ciphertext),
    ciphertextBytes: ciphertext.byteLength,
  };
}

async function unwrapMasterKey(
  envelope: PrivateProVaultWrappedKeyEnvelope,
  wrappingKey: CryptoKey,
): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    'raw',
    base64ToBytes(envelope.ciphertextBase64),
    wrappingKey,
    { name: WRAP_ALGORITHM, iv: base64ToBytes(envelope.nonceBase64) },
    'HKDF',
    false,
    ['deriveKey'],
  );
}

async function recoveryWrappingKey(recoveryKey: string, usage: 'wrapKey' | 'unwrapKey'): Promise<CryptoKey> {
  const bytes = parseRecoveryKey(recoveryKey);
  try {
    return await crypto.subtle.importKey('raw', new Uint8Array(bytes), { name: WRAP_ALGORITHM, length: 256 }, false, [usage]);
  } finally {
    bytes.fill(0);
  }
}

async function passwordWrappingKey(password: string, keyset: PrivateProVaultKeyset): Promise<CryptoKey> {
  const params = keyset.passwordEnvelope.kdf;
  if (params.algorithm === 'argon2id') return derivePasswordWrappingKey(password, params);
  const passwordBytes = new TextEncoder().encode(password);
  try {
    const passwordKey = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: base64ToBytes(params.saltBase64),
      iterations: params.iterations,
    }, passwordKey, { name: WRAP_ALGORITHM, length: 256 }, false, ['unwrapKey']);
  } finally {
    passwordBytes.fill(0);
  }
}

async function createPasswordEnvelope(
  masterKeyBytes: Uint8Array<ArrayBuffer>,
  password: string,
  keyVersion: number,
): Promise<PrivateProVaultPasswordEnvelope> {
  const argon2 = {
    algorithm: 'argon2id' as const,
    memoryKiB: PRIVATE_PRO_VAULT_ARGON2ID_MIN_MEMORY_KIB,
    iterations: PRIVATE_PRO_VAULT_ARGON2ID_MIN_ITERATIONS,
    parallelism: PRIVATE_PRO_VAULT_ARGON2ID_MIN_PARALLELISM,
    saltBase64: randomBase64(16),
  };
  const fallback = {
    algorithm: 'pbkdf2-sha256' as const,
    iterations: PRIVATE_PRO_PBKDF2_MIN_ITERATIONS,
    saltBase64: argon2.saltBase64,
  };
  const wrapping = await derivePasswordWrappingKeyWithCompatibility(password, argon2, fallback);
  return {
    formatVersion: 1,
    keyVersion,
    kdf: wrapping.params,
    ...await wrapMasterKeyBytes(masterKeyBytes, wrapping.key),
  };
}

async function createRecoveryEnvelope(
  masterKeyBytes: Uint8Array<ArrayBuffer>,
  recoveryKey: string,
  keyVersion: number,
  recoveryVersion: number,
): Promise<PrivateProVaultRecoveryEnvelope> {
  return {
    formatVersion: 1,
    keyVersion,
    recoveryVersion,
    ...await wrapMasterKeyBytes(masterKeyBytes, await recoveryWrappingKey(recoveryKey, 'wrapKey')),
  };
}

export async function createPrivateProVaultKeyset(password: string): Promise<{
  keyset: PrivateProVaultKeyset;
  masterKey: CryptoKey;
  recoveryKey: string;
}> {
  const masterKeyBytes = new Uint8Array(generateVaultMasterKeyBytes());
  const recovery = generateRecoveryKey();
  try {
    const keyVersion = 1;
    const keyset = PrivateProVaultKeysetSchema.parse({
      formatVersion: 1,
      keyVersion,
      passwordEnvelope: await createPasswordEnvelope(masterKeyBytes, password, keyVersion),
      recoveryEnvelope: await createRecoveryEnvelope(masterKeyBytes, recovery.display, keyVersion, 1),
    });
    return { keyset, masterKey: await importVaultMasterKey(masterKeyBytes), recoveryKey: recovery.display };
  } finally {
    masterKeyBytes.fill(0);
    recovery.bytes.fill(0);
  }
}

export async function unlockPrivateProVaultWithPassword(
  keyset: PrivateProVaultKeyset,
  password: string,
): Promise<CryptoKey> {
  try {
    return await unwrapMasterKey(keyset.passwordEnvelope, await passwordWrappingKey(password, keyset));
  } catch {
    throw new Error('Vault password or recovery key is incorrect.');
  }
}

export async function unlockPrivateProVaultWithRecovery(
  keyset: PrivateProVaultKeyset,
  recoveryKey: string,
): Promise<CryptoKey> {
  try {
    return await unwrapMasterKey(keyset.recoveryEnvelope, await recoveryWrappingKey(recoveryKey, 'unwrapKey'));
  } catch {
    throw new Error('Vault password or recovery key is incorrect.');
  }
}

export async function rewrapPrivateProVaultPassword(
  keyset: PrivateProVaultKeyset,
  currentPassword: string,
  newPassword: string,
): Promise<PrivateProVaultKeyset> {
  const currentWrappingKey = await passwordWrappingKey(currentPassword, keyset);
  return rewrapPrivateProVaultPasswordWithKey(keyset, currentWrappingKey, keyset.passwordEnvelope, newPassword);
}

export async function rewrapPrivateProVaultPasswordWithRecovery(
  keyset: PrivateProVaultKeyset,
  recoveryKey: string,
  newPassword: string,
): Promise<PrivateProVaultKeyset> {
  const currentWrappingKey = await recoveryWrappingKey(recoveryKey, 'unwrapKey');
  return rewrapPrivateProVaultPasswordWithKey(keyset, currentWrappingKey, keyset.recoveryEnvelope, newPassword);
}

async function rewrapPrivateProVaultPasswordWithKey(
  keyset: PrivateProVaultKeyset,
  currentWrappingKey: CryptoKey,
  currentEnvelope: PrivateProVaultWrappedKeyEnvelope,
  newPassword: string,
): Promise<PrivateProVaultKeyset> {
  const keyVersion = keyset.keyVersion + 1;
  const passwordKdf = {
    algorithm: 'argon2id' as const,
    memoryKiB: PRIVATE_PRO_VAULT_ARGON2ID_MIN_MEMORY_KIB,
    iterations: PRIVATE_PRO_VAULT_ARGON2ID_MIN_ITERATIONS,
    parallelism: PRIVATE_PRO_VAULT_ARGON2ID_MIN_PARALLELISM,
    saltBase64: randomBase64(16),
  };
  const fallback = {
    algorithm: 'pbkdf2-sha256' as const,
    iterations: PRIVATE_PRO_PBKDF2_MIN_ITERATIONS,
    saltBase64: passwordKdf.saltBase64,
  };
  const passwordWrapping = await derivePasswordWrappingKeyWithCompatibility(newPassword, passwordKdf, fallback);
  try {
    const transientMasterKey = await crypto.subtle.unwrapKey(
      'raw',
      base64ToBytes(currentEnvelope.ciphertextBase64),
      currentWrappingKey,
      { name: WRAP_ALGORITHM, iv: base64ToBytes(currentEnvelope.nonceBase64) },
      { name: WRAP_ALGORITHM, length: 256 },
      true,
      ['wrapKey'],
    );
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const passwordCiphertext = new Uint8Array(await crypto.subtle.wrapKey('raw', transientMasterKey, passwordWrapping.key, {
      name: WRAP_ALGORITHM,
      iv: nonce,
    }));
    return PrivateProVaultKeysetSchema.parse({
      formatVersion: 1,
      keyVersion,
      passwordEnvelope: {
        formatVersion: 1,
        keyVersion,
        kdf: passwordWrapping.params,
        nonceBase64: bytesToBase64(nonce),
        ciphertextBase64: bytesToBase64(passwordCiphertext),
        ciphertextBytes: passwordCiphertext.byteLength,
      },
      recoveryEnvelope: { ...keyset.recoveryEnvelope, keyVersion },
    });
  } catch {
    throw new Error('Vault password or recovery key is incorrect.');
  }
}

export async function createPrivateProRememberedUnlock(masterKey: CryptoKey): Promise<{
  deviceKey: CryptoKey;
  envelope: PrivateProVaultWrappedKeyEnvelope;
}> {
  const deviceKey = await crypto.subtle.generateKey(
    { name: WRAP_ALGORITHM, length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.wrapKey('raw', masterKey, deviceKey, {
    name: WRAP_ALGORITHM,
    iv: nonce,
  }));
  return {
    deviceKey,
    envelope: {
      nonceBase64: bytesToBase64(nonce),
      ciphertextBase64: bytesToBase64(ciphertext),
      ciphertextBytes: ciphertext.byteLength,
    },
  };
}

export function restorePrivateProRememberedUnlock(
  deviceKey: CryptoKey,
  envelope: PrivateProVaultWrappedKeyEnvelope,
): Promise<CryptoKey> {
  return unwrapMasterKey(envelope, deviceKey);
}
