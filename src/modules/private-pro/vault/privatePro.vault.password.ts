import {
  PRIVATE_PRO_VAULT_ARGON2ID_MAX_ITERATIONS,
  PRIVATE_PRO_VAULT_ARGON2ID_MAX_MEMORY_KIB,
  PRIVATE_PRO_VAULT_ARGON2ID_MAX_PARALLELISM,
  PRIVATE_PRO_VAULT_ARGON2ID_MIN_ITERATIONS,
  PRIVATE_PRO_VAULT_ARGON2ID_MIN_MEMORY_KIB,
  PRIVATE_PRO_VAULT_ARGON2ID_MIN_PARALLELISM,
  PRIVATE_PRO_PBKDF2_MIN_ITERATIONS,
} from './privatePro.vault.schemas';
import type { VaultArgon2idWorkerRequest } from './privatePro.vault.password.worker';


export interface VaultPasswordKdfParams {
  algorithm: 'argon2id';
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  saltBase64: string;
}

export interface VaultPasswordPbkdf2V1CompatibilityParams {
  algorithm: 'pbkdf2-sha256';
  iterations: number;
  saltBase64: string;
}

const SALT_MIN_BYTES = 16;
const SALT_MAX_BYTES = 64;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;


class VaultPasswordWorkerIncompatibilityError extends Error {
  constructor() {
    super('This browser cannot run the required vault password derivation worker.');
    this.name = 'VaultPasswordWorkerIncompatibilityError';
  }
}

class VaultPasswordWorkerUnavailableError extends Error {
  constructor() {
    super('Vault password derivation failed because the browser worker is unavailable.');
    this.name = 'VaultPasswordWorkerUnavailableError';
  }
}

function decodeCanonicalBase64(value: string): Uint8Array<ArrayBuffer> {
  if (!CANONICAL_BASE64.test(value))
    throw new Error('Vault password derivation parameters are invalid.');
  try {
    const binary = atob(value);
    if (btoa(binary) !== value)
      throw new Error('non-canonical');
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    throw new Error('Vault password derivation parameters are invalid.');
  }
}

function encodePassword(password: string): Uint8Array<ArrayBuffer> {
  for (let index = 0; index < password.length; index++) {
    const codeUnit = password.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const low = password.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff)
        throw new Error('Vault passwords must contain valid Unicode text.');
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error('Vault passwords must contain valid Unicode text.');
    }
  }
  return new TextEncoder().encode(password);
}

function validateArgon2idParams(params: VaultPasswordKdfParams): Uint8Array<ArrayBuffer> {
  const saltBytes = decodeCanonicalBase64(params.saltBase64);
  if (
    params.algorithm !== 'argon2id'
    || !Number.isInteger(params.memoryKiB)
    || params.memoryKiB < PRIVATE_PRO_VAULT_ARGON2ID_MIN_MEMORY_KIB
    || params.memoryKiB > PRIVATE_PRO_VAULT_ARGON2ID_MAX_MEMORY_KIB
    || !Number.isInteger(params.iterations)
    || params.iterations < PRIVATE_PRO_VAULT_ARGON2ID_MIN_ITERATIONS
    || params.iterations > PRIVATE_PRO_VAULT_ARGON2ID_MAX_ITERATIONS
    || !Number.isInteger(params.parallelism)
    || params.parallelism < PRIVATE_PRO_VAULT_ARGON2ID_MIN_PARALLELISM
    || params.parallelism > PRIVATE_PRO_VAULT_ARGON2ID_MAX_PARALLELISM
    || saltBytes.byteLength < SALT_MIN_BYTES
    || saltBytes.byteLength > SALT_MAX_BYTES
  )
    throw new Error('Vault password derivation parameters are invalid.');
  return saltBytes;
}

export function privateProVaultArgon2idWorkerUrl(): URL {
  return new URL('./privatePro.vault.password.worker.ts', import.meta.url);
}

function deriveArgon2idInBrowserWorker(request: VaultArgon2idWorkerRequest): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof Worker === 'undefined')
    return Promise.reject(new VaultPasswordWorkerUnavailableError());

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./privatePro.vault.password.worker.ts', import.meta.url), {
      name: 'private-pro-vault-password',
      type: 'module',
    });
    const finish = (action: () => void) => {
      worker.terminate();
      action();
    };
    worker.addEventListener('message', event => {
      const response = event.data as Record<string, unknown> | null;
      if (response?.protocolVersion === 1 && response.kind === 'success' && response.keyBytes instanceof Uint8Array) {
        const keyBytes = Uint8Array.from(response.keyBytes);
        finish(() => resolve(keyBytes));
      }
      else if (
        response?.protocolVersion === 1
        && response.kind === 'incompatible'
        && (response.reason === 'wasm-unavailable' || response.reason === 'memory-limit')
      )
        finish(() => reject(new VaultPasswordWorkerIncompatibilityError()));
      else
        finish(() => reject(new Error('Vault password derivation failed.')));
    }, { once: true });
    worker.addEventListener('error', () => finish(() => reject(new Error('Vault password derivation failed.'))), { once: true });
    worker.postMessage(request, [request.passwordBytes.buffer]);
  });
}

async function importWrappingKey(keyBytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (keyBytes.byteLength !== 32)
    throw new Error('Vault password derivation failed.');
  try {
    return await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
  } finally {
    keyBytes.fill(0);
  }
}

export async function derivePasswordWrappingKey(
  password: string,
  params: VaultPasswordKdfParams,
): Promise<CryptoKey> {
  const saltBytes = validateArgon2idParams(params);
  const passwordBytes = encodePassword(password);
  try {
    const derivedBytes = await deriveArgon2idInBrowserWorker({
      passwordBytes,
      saltBytes,
      memoryKiB: params.memoryKiB,
      iterations: params.iterations,
      parallelism: params.parallelism,
    });
    return await importWrappingKey(derivedBytes);
  } catch (error) {
    if (error instanceof VaultPasswordWorkerIncompatibilityError || error instanceof VaultPasswordWorkerUnavailableError)
      throw error;
    throw new Error('Vault password derivation failed.');
  } finally {
    if (passwordBytes.buffer.byteLength > 0)
      passwordBytes.fill(0);
  }
}

export async function derivePasswordWrappingKeyWithCompatibility(
  password: string,
  params: VaultPasswordKdfParams,
  fallback: VaultPasswordPbkdf2V1CompatibilityParams,
): Promise<{ key: CryptoKey; params: VaultPasswordKdfParams | VaultPasswordPbkdf2V1CompatibilityParams }> {
  try {
    return { key: await derivePasswordWrappingKey(password, params), params };
  } catch (error) {
    if (!(error instanceof VaultPasswordWorkerIncompatibilityError))
      throw error;
  }

  const saltBytes = decodeCanonicalBase64(fallback.saltBase64);
  if (
    fallback.algorithm !== 'pbkdf2-sha256'
    || !Number.isInteger(fallback.iterations)
    || fallback.iterations < PRIVATE_PRO_PBKDF2_MIN_ITERATIONS
    || fallback.iterations > 10_000_000
    || saltBytes.byteLength < SALT_MIN_BYTES
    || saltBytes.byteLength > SALT_MAX_BYTES
  )
    throw new Error('Vault password derivation parameters are invalid.');

  const passwordBytes = encodePassword(password);
  try {
    const passwordKey = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: saltBytes,
      iterations: fallback.iterations,
    }, passwordKey, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
    return { key, params: fallback };
  } finally {
    passwordBytes.fill(0);
  }
}
