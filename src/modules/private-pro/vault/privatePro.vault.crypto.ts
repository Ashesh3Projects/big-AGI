import { PrivateProVaultEnvelopeSchema } from './privatePro.vault.schemas';
import type { PrivateProVaultEnvelope, PrivateProVaultRecordType } from './privatePro.vault.types';


export const PRIVATE_PRO_VAULT_CIPHER_SUITE = 'AES-256-GCM+HKDF-SHA-256';

const AES_GCM_NONCE_BYTES = 12;
const MASTER_KEY_BYTES = 32;
const AES_GCM_KEY_BITS = 256;
const HMAC_KEY_BITS = 256;
const HKDF_SALT = utf8('big-agi/private-pro/vault/hkdf-sha256/v1');


export interface PrivateProVaultContext {
  vaultId: string;
}

export interface VaultRecordAADInput extends PrivateProVaultContext {
  formatVersion: 1;
  recordType: PrivateProVaultRecordType;
  recordId: string;
  schemaVersion: number;
  keyVersion: number;
  revision: number;
}


function utf8(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

function lengthPrefixed(...values: string[]): Uint8Array<ArrayBuffer> {
  return utf8(values.map(value => `${utf8(value).byteLength}:${value}`).join('|'));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes)
    binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function recordAADFromEnvelope(envelope: PrivateProVaultEnvelope, context: PrivateProVaultContext): VaultRecordAADInput {
  return {
    ...context,
    formatVersion: envelope.formatVersion,
    recordType: envelope.recordType,
    recordId: envelope.recordId,
    schemaVersion: envelope.schemaVersion,
    keyVersion: envelope.keyVersion,
    revision: envelope.revision,
  };
}


export function generateVaultMasterKeyBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(MASTER_KEY_BYTES));
}

export async function importVaultMasterKey(bytes: Uint8Array, extractable = false): Promise<CryptoKey> {
  if (bytes.byteLength !== MASTER_KEY_BYTES)
    throw new Error(`Vault master keys must be ${MASTER_KEY_BYTES} bytes.`);
  if (extractable)
    throw new Error('HKDF master keys cannot be extractable.');

  return crypto.subtle.importKey('raw', new Uint8Array(bytes), 'HKDF', false, ['deriveKey']);
}

export function vaultRecordAAD(input: VaultRecordAADInput): Uint8Array<ArrayBuffer> {
  return lengthPrefixed(
    'big-agi/private-pro/vault/record-aad/v1',
    String(input.formatVersion),
    input.vaultId,
    input.recordType,
    input.recordId,
    String(input.schemaVersion),
    String(input.keyVersion),
    String(input.revision),
    PRIVATE_PRO_VAULT_CIPHER_SUITE,
  );
}

export async function encryptVaultRecord(
  key: CryptoKey,
  aad: VaultRecordAADInput,
  plaintext: Uint8Array,
): Promise<PrivateProVaultEnvelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_BYTES));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv: nonce,
    additionalData: vaultRecordAAD(aad),
  }, key, new Uint8Array(plaintext)));

  return PrivateProVaultEnvelopeSchema.parse({
    formatVersion: aad.formatVersion,
    recordType: aad.recordType,
    recordId: aad.recordId,
    schemaVersion: aad.schemaVersion,
    keyVersion: aad.keyVersion,
    revision: aad.revision,
    nonceBase64: bytesToBase64(nonce),
    ciphertextBase64: bytesToBase64(ciphertext),
    ciphertextBytes: ciphertext.byteLength,
  });
}

export async function decryptVaultRecord(
  key: CryptoKey,
  envelope: PrivateProVaultEnvelope,
  context: PrivateProVaultContext,
): Promise<Uint8Array> {
  const validatedEnvelope = PrivateProVaultEnvelopeSchema.parse(envelope);
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: base64ToBytes(validatedEnvelope.nonceBase64),
    additionalData: vaultRecordAAD(recordAADFromEnvelope(validatedEnvelope, context)),
  }, key, base64ToBytes(validatedEnvelope.ciphertextBase64));
  return new Uint8Array(plaintext);
}

export function deriveVaultSubkey(
  masterKey: CryptoKey,
  purpose: string,
  id: string,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  if (!purpose || !id)
    throw new Error('Vault subkey purpose and ID must be non-empty.');

  const usageSet = new Set(usages);
  const isAesKey = usages.length > 0 && usages.every(usage =>
    usage === 'encrypt' || usage === 'decrypt' || usage === 'wrapKey' || usage === 'unwrapKey');
  const isHmacKey = usages.length > 0 && usages.every(usage => usage === 'sign' || usage === 'verify');
  if ((!isAesKey && !isHmacKey) || usageSet.size !== usages.length)
    throw new Error('Vault subkeys require unique AES-GCM or HMAC usages.');

  const keyDomain = isAesKey ? 'aes-256-gcm' : 'hmac-sha-256';
  const derivedKeyType: AesDerivedKeyParams | HmacImportParams = isAesKey
    ? { name: 'AES-GCM', length: AES_GCM_KEY_BITS }
    : { name: 'HMAC', hash: 'SHA-256', length: HMAC_KEY_BITS };

  return crypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: HKDF_SALT,
    info: lengthPrefixed('big-agi/private-pro/vault/subkey/v1', keyDomain, purpose, id),
  }, masterKey, derivedKeyType, false, usages);
}

export async function hmacVaultIdentifier(key: CryptoKey, namespace: string, value: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', key, lengthPrefixed(
    'big-agi/private-pro/vault/identifier/v1',
    namespace,
    value,
  ));
  return bytesToBase64Url(new Uint8Array(signature));
}
