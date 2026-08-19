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
import {
  createPrivateProVaultEnrollmentAuthority,
  rewrapPrivateProVaultEnrollmentPassword,
  unlockPrivateProVaultEnrollmentKey,
} from './privatePro.vault.registration';


const WRAP_ALGORITHM = 'AES-GCM';


export interface PrivateProRememberedUnlock {
  deviceKey: CryptoKey;
  envelope: PrivateProVaultWrappedKeyEnvelope;
}

export interface PrivateProRememberedUnlockSource {
  envelope: PrivateProVaultWrappedKeyEnvelope;
  wrappingKey: CryptoKey;
}


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

async function recoveryWrappingKey(recoveryKey: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const bytes = parseRecoveryKey(recoveryKey);
  try {
    return await crypto.subtle.importKey('raw', new Uint8Array(bytes), { name: WRAP_ALGORITHM, length: 256 }, false, usages);
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
    }, passwordKey, { name: WRAP_ALGORITHM, length: 256 }, false, ['wrapKey', 'unwrapKey']);
  } finally {
    passwordBytes.fill(0);
  }
}

async function newPasswordWrapping(password: string) {
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
  return derivePasswordWrappingKeyWithCompatibility(password, argon2, fallback);
}

async function createPasswordEnvelope(
  masterKeyBytes: Uint8Array<ArrayBuffer>,
  wrapping: Awaited<ReturnType<typeof newPasswordWrapping>>,
  keyVersion: number,
): Promise<PrivateProVaultPasswordEnvelope> {
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
    ...await wrapMasterKeyBytes(masterKeyBytes, await recoveryWrappingKey(recoveryKey, ['wrapKey'])),
  };
}

export async function createPrivateProRememberedUnlock(
  source: PrivateProRememberedUnlockSource,
): Promise<PrivateProRememberedUnlock> {
  const transientMasterKey = await crypto.subtle.unwrapKey(
    'raw',
    base64ToBytes(source.envelope.ciphertextBase64),
    source.wrappingKey,
    { name: WRAP_ALGORITHM, iv: base64ToBytes(source.envelope.nonceBase64) },
    { name: WRAP_ALGORITHM, length: 256 },
    true,
    ['wrapKey'],
  );
  const deviceKey = await crypto.subtle.generateKey(
    { name: WRAP_ALGORITHM, length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.wrapKey('raw', transientMasterKey, deviceKey, {
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

export async function createPrivateProVaultKeyset(password: string, uid: string): Promise<{
  keyset: PrivateProVaultKeyset;
  masterKey: CryptoKey;
  enrollmentKey: CryptoKey;
  rememberedUnlockSource: PrivateProRememberedUnlockSource;
  recoveryKey: string;
}> {
  const masterKeyBytes = new Uint8Array(generateVaultMasterKeyBytes());
  const recovery = generateRecoveryKey();
  try {
    const keyVersion = 1;
    const masterKey = await importVaultMasterKey(masterKeyBytes);
    const passwordWrapping = await newPasswordWrapping(password);
    const recoveryWrapping = await recoveryWrappingKey(recovery.display, ['wrapKey']);
    const enrollment = await createPrivateProVaultEnrollmentAuthority(passwordWrapping.key, recoveryWrapping, uid, keyVersion);
    const passwordEnvelope = await createPasswordEnvelope(masterKeyBytes, passwordWrapping, keyVersion);
    const keyset = PrivateProVaultKeysetSchema.parse({
      formatVersion: 1,
      keyVersion,
      wrappingVersion: 1,
      enrollmentAuthority: enrollment.authority,
      passwordEnvelope,
      recoveryEnvelope: await createRecoveryEnvelope(masterKeyBytes, recovery.display, keyVersion, 1),
    });
    return {
      keyset,
      masterKey,
      enrollmentKey: enrollment.privateKey,
      rememberedUnlockSource: { envelope: passwordEnvelope, wrappingKey: passwordWrapping.key },
      recoveryKey: recovery.display,
    };
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

export async function unlockPrivateProVaultCredentialsWithPassword(
  keyset: PrivateProVaultKeyset,
  password: string,
  uid: string,
): Promise<{ masterKey: CryptoKey; enrollmentKey: CryptoKey; rememberedUnlockSource: PrivateProRememberedUnlockSource }> {
  try {
    const wrappingKey = await passwordWrappingKey(password, keyset);
    return {
      masterKey: await unwrapMasterKey(keyset.passwordEnvelope, wrappingKey),
      enrollmentKey: await unlockPrivateProVaultEnrollmentKey(keyset.enrollmentAuthority, 'password', wrappingKey, uid, keyset.keyVersion),
      rememberedUnlockSource: { envelope: keyset.passwordEnvelope, wrappingKey },
    };
  } catch {
    throw new Error('Vault password or recovery key is incorrect.');
  }
}

export async function unlockPrivateProVaultWithRecovery(
  keyset: PrivateProVaultKeyset,
  recoveryKey: string,
): Promise<CryptoKey> {
  try {
    return await unwrapMasterKey(keyset.recoveryEnvelope, await recoveryWrappingKey(recoveryKey, ['unwrapKey']));
  } catch {
    throw new Error('Vault password or recovery key is incorrect.');
  }
}

export async function unlockPrivateProVaultCredentialsWithRecovery(
  keyset: PrivateProVaultKeyset,
  recoveryKey: string,
  uid: string,
): Promise<{ masterKey: CryptoKey; enrollmentKey: CryptoKey; rememberedUnlockSource: PrivateProRememberedUnlockSource }> {
  try {
    const wrappingKey = await recoveryWrappingKey(recoveryKey, ['unwrapKey']);
    return {
      masterKey: await unwrapMasterKey(keyset.recoveryEnvelope, wrappingKey),
      enrollmentKey: await unlockPrivateProVaultEnrollmentKey(keyset.enrollmentAuthority, 'recovery', wrappingKey, uid, keyset.keyVersion),
      rememberedUnlockSource: { envelope: keyset.recoveryEnvelope, wrappingKey },
    };
  } catch {
    throw new Error('Vault password or recovery key is incorrect.');
  }
}

export async function rewrapPrivateProVaultPassword(
  keyset: PrivateProVaultKeyset,
  currentPassword: string,
  newPassword: string,
  uid: string,
): Promise<PrivateProVaultKeyset> {
  const currentWrappingKey = await passwordWrappingKey(currentPassword, keyset);
  return rewrapPrivateProVaultPasswordWithKey(keyset, currentWrappingKey, keyset.passwordEnvelope, newPassword, uid, 'password');
}

export async function rewrapPrivateProVaultPasswordWithRecovery(
  keyset: PrivateProVaultKeyset,
  recoveryKey: string,
  newPassword: string,
  uid: string,
): Promise<PrivateProVaultKeyset> {
  const currentWrappingKey = await recoveryWrappingKey(recoveryKey, ['unwrapKey']);
  return rewrapPrivateProVaultPasswordWithKey(keyset, currentWrappingKey, keyset.recoveryEnvelope, newPassword, uid, 'recovery');
}

async function rewrapPrivateProVaultPasswordWithKey(
  keyset: PrivateProVaultKeyset,
  currentWrappingKey: CryptoKey,
  currentEnvelope: PrivateProVaultWrappedKeyEnvelope,
  newPassword: string,
  uid: string,
  currentCredential: 'password' | 'recovery',
): Promise<PrivateProVaultKeyset> {
  const wrappingVersion = keyset.wrappingVersion + 1;
  const passwordWrapping = await newPasswordWrapping(newPassword);
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
      keyVersion: keyset.keyVersion,
      wrappingVersion,
      passwordEnvelope: {
        formatVersion: 1,
        keyVersion: keyset.keyVersion,
        kdf: passwordWrapping.params,
        nonceBase64: bytesToBase64(nonce),
        ciphertextBase64: bytesToBase64(passwordCiphertext),
        ciphertextBytes: passwordCiphertext.byteLength,
      },
      recoveryEnvelope: keyset.recoveryEnvelope,
      enrollmentAuthority: await rewrapPrivateProVaultEnrollmentPassword(
        keyset.enrollmentAuthority,
        currentWrappingKey,
        passwordWrapping.key,
        uid,
        keyset.keyVersion,
        currentCredential,
      ),
    });
  } catch {
    throw new Error('Vault password or recovery key is incorrect.');
  }
}

export function restorePrivateProRememberedUnlock(
  deviceKey: CryptoKey,
  envelope: PrivateProVaultWrappedKeyEnvelope,
): Promise<CryptoKey> {
  return unwrapMasterKey(envelope, deviceKey);
}
