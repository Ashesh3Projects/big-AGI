import { PrivateProVaultEnrollmentAuthoritySchema } from './privatePro.vault.schemas';
import type { PrivateProVaultEnrollmentAuthority, PrivateProVaultWrappedKeyEnvelope } from './privatePro.vault.types';


export interface PrivateProVaultDeviceRegistrationInput {
  formatVersion: 1;
  uid: string;
  deviceId: string;
  keyVersion: number;
  challengeId: string;
  challengeBase64: string;
  expiresAtMs: number;
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

function canonicalJwk(jwk: PrivateProVaultEnrollmentAuthority['publicJwk']): string {
  return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
}

async function enrollmentAAD(
  uid: string,
  keyVersion: number,
  publicJwk: PrivateProVaultEnrollmentAuthority['publicJwk'],
  credential: 'password' | 'recovery',
): Promise<Uint8Array<ArrayBuffer>> {
  scalar(uid);
  const thumbprint = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJwk(publicJwk))));
  return new Uint8Array(new TextEncoder().encode(JSON.stringify({ credential, formatVersion: 1, keyVersion, thumbprintBase64: bytesToBase64(thumbprint), uid })));
}

async function wrapEnrollmentPrivateKey(
  privateKey: CryptoKey,
  wrappingKey: CryptoKey,
  uid: string,
  keyVersion: number,
  publicJwk: PrivateProVaultEnrollmentAuthority['publicJwk'],
  credential: 'password' | 'recovery',
): Promise<PrivateProVaultWrappedKeyEnvelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.wrapKey('pkcs8', privateKey, wrappingKey, {
    name: 'AES-GCM',
    iv: nonce,
    additionalData: await enrollmentAAD(uid, keyVersion, publicJwk, credential),
  }));
  return {
    nonceBase64: bytesToBase64(nonce),
    ciphertextBase64: bytesToBase64(ciphertext),
    ciphertextBytes: ciphertext.byteLength,
  };
}

async function unwrapEnrollmentPrivateKey(
  envelope: PrivateProVaultWrappedKeyEnvelope,
  wrappingKey: CryptoKey,
  uid: string,
  keyVersion: number,
  publicJwk: PrivateProVaultEnrollmentAuthority['publicJwk'],
  credential: 'password' | 'recovery',
  extractable: boolean,
): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    'pkcs8',
    base64ToBytes(envelope.ciphertextBase64),
    wrappingKey,
    {
      name: 'AES-GCM',
      iv: base64ToBytes(envelope.nonceBase64),
      additionalData: await enrollmentAAD(uid, keyVersion, publicJwk, credential),
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    extractable,
    ['sign'],
  );
}

export async function createPrivateProVaultEnrollmentAuthority(
  passwordWrappingKey: CryptoKey,
  recoveryWrappingKey: CryptoKey,
  uid: string,
  keyVersion: number,
): Promise<{ authority: PrivateProVaultEnrollmentAuthority; privateKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const rawJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const publicJwk = { kty: 'EC' as const, crv: 'P-256' as const, x: rawJwk.x!, y: rawJwk.y! };
  const authority = PrivateProVaultEnrollmentAuthoritySchema.parse({
    algorithm: 'ECDSA-P256-SHA256',
    keyVersion,
    publicJwk,
    passwordEnvelope: await wrapEnrollmentPrivateKey(pair.privateKey, passwordWrappingKey, uid, keyVersion, publicJwk, 'password'),
    recoveryEnvelope: await wrapEnrollmentPrivateKey(pair.privateKey, recoveryWrappingKey, uid, keyVersion, publicJwk, 'recovery'),
  });
  const privateBytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  try {
    return {
      authority,
      privateKey: await crypto.subtle.importKey('pkcs8', privateBytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']),
    };
  } finally {
    privateBytes.fill(0);
  }
}

export async function unlockPrivateProVaultEnrollmentKey(
  authority: PrivateProVaultEnrollmentAuthority,
  credential: 'password' | 'recovery',
  wrappingKey: CryptoKey,
  uid: string,
  keyVersion: number,
): Promise<CryptoKey> {
  try {
    const parsed = PrivateProVaultEnrollmentAuthoritySchema.parse(authority);
    if (parsed.keyVersion !== keyVersion) throw new Error('stale');
    return await unwrapEnrollmentPrivateKey(
      credential === 'password' ? parsed.passwordEnvelope : parsed.recoveryEnvelope,
      wrappingKey,
      uid,
      keyVersion,
      parsed.publicJwk,
      credential,
      false,
    );
  } catch {
    throw new Error('Vault enrollment credentials are invalid.');
  }
}

export async function rewrapPrivateProVaultEnrollmentPassword(
  authority: PrivateProVaultEnrollmentAuthority,
  currentWrappingKey: CryptoKey,
  newWrappingKey: CryptoKey,
  uid: string,
  keyVersion: number,
  currentCredential: 'password' | 'recovery' = 'password',
): Promise<PrivateProVaultEnrollmentAuthority> {
  try {
    const parsed = PrivateProVaultEnrollmentAuthoritySchema.parse(authority);
    const privateKey = await unwrapEnrollmentPrivateKey(
      currentCredential === 'password' ? parsed.passwordEnvelope : parsed.recoveryEnvelope,
      currentWrappingKey,
      uid,
      keyVersion,
      parsed.publicJwk,
      currentCredential,
      true,
    );
    return PrivateProVaultEnrollmentAuthoritySchema.parse({
      ...parsed,
      passwordEnvelope: await wrapEnrollmentPrivateKey(privateKey, newWrappingKey, uid, keyVersion, parsed.publicJwk, 'password'),
    });
  } catch {
    throw new Error('Vault enrollment credentials are invalid.');
  }
}

export function privateProVaultDeviceRegistrationPayload(input: PrivateProVaultDeviceRegistrationInput): Uint8Array<ArrayBuffer> {
  scalar(input.uid);
  scalar(input.deviceId);
  scalar(input.challengeId);
  scalar(input.challengeBase64);
  if (input.formatVersion !== 1
    || !/^[A-Za-z0-9_-]{43}$/.test(input.deviceId)
    || !/^[A-Za-z0-9_-]{43}$/.test(input.challengeId)
    || !/^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/.test(input.challengeBase64)
    || base64ToBytes(input.challengeBase64).byteLength !== 32
    || !Number.isSafeInteger(input.keyVersion) || input.keyVersion <= 0
    || !Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= 0)
    throw new Error('Vault device registration input is invalid.');
  return new Uint8Array(new TextEncoder().encode(JSON.stringify({
    formatVersion: 1,
    uid: input.uid,
    deviceId: input.deviceId,
    keyVersion: input.keyVersion,
    challengeId: input.challengeId,
    challengeBase64: input.challengeBase64,
    expiresAtMs: input.expiresAtMs,
  })));
}

export async function signPrivateProVaultDeviceRegistration(privateKey: CryptoKey, input: PrivateProVaultDeviceRegistrationInput): Promise<string> {
  return bytesToBase64(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, privateProVaultDeviceRegistrationPayload(input))));
}

export async function verifyPrivateProVaultDeviceRegistration(
  publicJwk: PrivateProVaultEnrollmentAuthority['publicJwk'],
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
