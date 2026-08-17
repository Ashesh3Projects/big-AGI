import { deriveVaultSubkey } from './privatePro.vault.crypto';
import { PrivateProVaultDeviceRegistrationSchema } from './privatePro.vault.schemas';
import type { PrivateProVaultDeviceRegistration } from './privatePro.vault.types';


export interface PrivateProVaultDeviceRegistrationInput {
  formatVersion: 1;
  uid: string;
  deviceId: string;
  keyVersion: number;
  operationId: string;
}


function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}

function scalar(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) throw new Error('Vault registration fields must contain Unicode scalar values.');
      const low = value.charCodeAt(++index);
      if (low < 0xdc00 || low > 0xdfff) throw new Error('Vault registration fields must contain Unicode scalar values.');
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('Vault registration fields must contain Unicode scalar values.');
  }
}

function canonicalJwk(jwk: PrivateProVaultDeviceRegistration['publicJwk']): string {
  return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
}

async function registrationAAD(uid: string, keyVersion: number, publicJwk: PrivateProVaultDeviceRegistration['publicJwk']): Promise<Uint8Array<ArrayBuffer>> {
  scalar(uid);
  const thumbprint = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJwk(publicJwk))));
  return new Uint8Array(new TextEncoder().encode(JSON.stringify({ formatVersion: 1, keyVersion, thumbprintBase64: bytesToBase64(thumbprint), uid })));
}

export function privateProVaultDeviceRegistrationPayload(input: PrivateProVaultDeviceRegistrationInput): Uint8Array<ArrayBuffer> {
  scalar(input.uid);
  scalar(input.deviceId);
  scalar(input.operationId);
  if (input.formatVersion !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(input.deviceId) || !Number.isSafeInteger(input.keyVersion) || input.keyVersion <= 0 || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.operationId))
    throw new Error('Vault device registration input is invalid.');
  return new Uint8Array(new TextEncoder().encode(JSON.stringify({
    deviceId: input.deviceId,
    formatVersion: 1,
    keyVersion: input.keyVersion,
    operationId: input.operationId,
    uid: input.uid,
  })));
}

export async function createPrivateProVaultDeviceRegistration(
  masterKey: CryptoKey,
  uid: string,
  keyVersion: number,
): Promise<PrivateProVaultDeviceRegistration> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const rawJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const publicJwk = { kty: 'EC' as const, crv: 'P-256' as const, x: rawJwk.x!, y: rawJwk.y! };
  const privateBytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  try {
    const key = await deriveVaultSubkey(masterKey, 'device-registration-private/v1', uid, ['encrypt']);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
      name: 'AES-GCM',
      iv: nonce,
      additionalData: await registrationAAD(uid, keyVersion, publicJwk),
    }, key, privateBytes));
    return PrivateProVaultDeviceRegistrationSchema.parse({
      algorithm: 'ECDSA-P256-SHA256',
      keyVersion,
      publicJwk,
      privateKeyEnvelope: {
        nonceBase64: bytesToBase64(nonce),
        ciphertextBase64: bytesToBase64(ciphertext),
        ciphertextBytes: ciphertext.byteLength,
      },
    });
  } finally {
    privateBytes.fill(0);
  }
}

export async function unlockPrivateProVaultDeviceRegistrationKey(
  masterKey: CryptoKey,
  uid: string,
  registration: PrivateProVaultDeviceRegistration,
  keyVersion: number,
): Promise<CryptoKey> {
  const parsed = PrivateProVaultDeviceRegistrationSchema.parse(registration);
  if (parsed.keyVersion !== keyVersion) throw new Error('Vault registration key version is invalid.');
  const key = await deriveVaultSubkey(masterKey, 'device-registration-private/v1', uid, ['decrypt']);
  const bytes = new Uint8Array(await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: base64ToBytes(parsed.privateKeyEnvelope.nonceBase64),
    additionalData: await registrationAAD(uid, keyVersion, parsed.publicJwk),
  }, key, base64ToBytes(parsed.privateKeyEnvelope.ciphertextBase64)));
  try {
    return await crypto.subtle.importKey('pkcs8', bytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  } finally {
    bytes.fill(0);
  }
}

export async function signPrivateProVaultDeviceRegistration(
  privateKey: CryptoKey,
  input: PrivateProVaultDeviceRegistrationInput,
): Promise<string> {
  return bytesToBase64(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, privateProVaultDeviceRegistrationPayload(input))));
}

export async function verifyPrivateProVaultDeviceRegistration(
  publicJwk: PrivateProVaultDeviceRegistration['publicJwk'],
  input: PrivateProVaultDeviceRegistrationInput,
  signatureBase64: string,
): Promise<boolean> {
  try {
    const publicKey = await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, base64ToBytes(signatureBase64), privateProVaultDeviceRegistrationPayload(input));
  } catch {
    return false;
  }
}
