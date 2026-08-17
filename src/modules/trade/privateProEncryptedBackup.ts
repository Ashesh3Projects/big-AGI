import * as z from 'zod/v4';

import { derivePasswordWrappingKey } from '../private-pro/vault/privatePro.vault.password';
import { parseRecoveryKey } from '../private-pro/vault/privatePro.vault.recovery';
import {
  PRIVATE_PRO_PBKDF2_MIN_ITERATIONS,
  PrivateProVaultEnvelopeSchema,
  PrivateProVaultKeysetSchema,
} from '../private-pro/vault/privatePro.vault.schemas';
import { decryptVaultRecord, deriveVaultSubkey } from '../private-pro/vault/privatePro.vault.crypto';
import type { PrivateProVaultEnvelope, PrivateProVaultKeyset } from '../private-pro/vault/privatePro.vault.types';


export const PRIVATE_PRO_ENCRYPTED_BACKUP_SCHEMA = 'vnd.agi.private-pro-encrypted-backup';
export const PRIVATE_PRO_ENCRYPTED_BACKUP_SCHEMA_VERSION = 1;

const MAX_VAULT_ID_LENGTH = 512;
const MAX_ASSET_ID_LENGTH = 512;
const MAX_CHUNK_ID_LENGTH = 512;
const MAX_ASSET_CIPHERTEXT_BYTES = 64 * 1024 * 1024;
const MAX_BACKUP_LINES = 1_000_000;
const MAX_BACKUP_LINE_BYTES = 96 * 1024 * 1024;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;


const BackupHeaderSchema = z.object({
  schema: z.literal(PRIVATE_PRO_ENCRYPTED_BACKUP_SCHEMA),
  schemaVersion: z.literal(PRIVATE_PRO_ENCRYPTED_BACKUP_SCHEMA_VERSION),
  kind: z.literal('header'),
  vaultId: z.string().min(1).max(MAX_VAULT_ID_LENGTH),
  createdAtMs: z.number().int().nonnegative().safe(),
  keyset: PrivateProVaultKeysetSchema,
}).strict();

const BackupRecordSchema = z.object({
  kind: z.literal('record'),
  envelope: PrivateProVaultEnvelopeSchema,
}).strict();

function canonicalBase64Schema(maximumBytes: number) {
  return z.string().max(Math.ceil(maximumBytes / 3) * 4).refine(value => {
    if (!CANONICAL_BASE64.test(value)) return false;
    try {
      const decoded = atob(value);
      return decoded.length <= maximumBytes && btoa(decoded) === value;
    } catch {
      return false;
    }
  }, 'Encrypted backup ciphertext must use canonical bounded base64.');
}

const BackupAssetSchema = z.object({
  kind: z.literal('asset'),
  formatVersion: z.literal(1),
  assetId: z.string().min(1).max(MAX_ASSET_ID_LENGTH),
  chunkId: z.string().min(1).max(MAX_CHUNK_ID_LENGTH),
  chunkIndex: z.number().int().nonnegative().safe(),
  keyVersion: z.number().int().positive().safe(),
  nonceBase64: canonicalBase64Schema(12).refine(value => atob(value).length === 12, 'Encrypted asset nonces must be 96 bits.'),
  ciphertextBase64: canonicalBase64Schema(MAX_ASSET_CIPHERTEXT_BYTES),
  ciphertextBytes: z.number().int().positive().max(MAX_ASSET_CIPHERTEXT_BYTES).safe(),
}).strict().refine(value => atob(value.ciphertextBase64).length === value.ciphertextBytes, {
  message: 'Encrypted asset ciphertextBytes must match its decoded ciphertext length.',
  path: ['ciphertextBytes'],
});

const BackupEndSchema = z.object({
  kind: z.literal('end'),
  recordCount: z.number().int().nonnegative().safe(),
  assetCount: z.number().int().nonnegative().safe(),
}).strict();


export type PrivateProEncryptedBackupHeader = z.infer<typeof BackupHeaderSchema>;
export type PrivateProEncryptedBackupAsset = z.infer<typeof BackupAssetSchema>;

export interface PrivateProEncryptedBackupSource {
  vaultId: string;
  keyset: PrivateProVaultKeyset;
  createdAtMs?: number;
  records: () => AsyncIterable<PrivateProVaultEnvelope>;
  assets?: () => AsyncIterable<PrivateProEncryptedBackupAsset>;
}

export type PrivateProEncryptedBackupCredential = {
  kind: 'password';
  password: string;
} | {
  kind: 'recovery';
  recoveryKey: string;
};

export interface PrivateProEncryptedBackupRecordValidationInput {
  header: PrivateProEncryptedBackupHeader;
  envelope: PrivateProVaultEnvelope;
  plaintext: Uint8Array;
}

export interface PrivateProEncryptedBackupApplyInput {
  header: PrivateProEncryptedBackupHeader;
  masterKey: CryptoKey;
  records: readonly PrivateProVaultEnvelope[];
  assets: readonly PrivateProEncryptedBackupAsset[];
}

export type PrivateProEncryptedBackupRecordValidator = (
  input: PrivateProEncryptedBackupRecordValidationInput,
) => void | Promise<void>;

export type PrivateProEncryptedBackupApply = (
  input: PrivateProEncryptedBackupApplyInput,
) => void | Promise<void>;


function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}

async function derivePbkdf2WrappingKey(password: string, saltBase64: string, iterations: number): Promise<CryptoKey> {
  if (iterations < PRIVATE_PRO_PBKDF2_MIN_ITERATIONS)
    throw new Error('Private Pro encrypted backup credentials are invalid.');
  const passwordBytes = new TextEncoder().encode(password);
  try {
    const passwordKey = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: base64ToBytes(saltBase64),
      iterations,
    }, passwordKey, { name: 'AES-GCM', length: 256 }, false, ['unwrapKey']);
  } finally {
    passwordBytes.fill(0);
  }
}

async function recoveryWrappingKey(display: string): Promise<CryptoKey> {
  const recoveryBytes = parseRecoveryKey(display);
  try {
    return await crypto.subtle.importKey(
      'raw',
      new Uint8Array(recoveryBytes),
      { name: 'AES-GCM', length: 256 },
      false,
      ['unwrapKey'],
    );
  } finally {
    recoveryBytes.fill(0);
  }
}

async function unlockMasterKey(
  keyset: PrivateProVaultKeyset,
  credential: PrivateProEncryptedBackupCredential,
): Promise<CryptoKey> {
  try {
    const envelope = credential.kind === 'password' ? keyset.passwordEnvelope : keyset.recoveryEnvelope;
    let wrappingKey: CryptoKey;
    if (credential.kind === 'recovery') {
      wrappingKey = await recoveryWrappingKey(credential.recoveryKey);
    } else if (keyset.passwordEnvelope.kdf.algorithm === 'argon2id') {
      wrappingKey = await derivePasswordWrappingKey(credential.password, keyset.passwordEnvelope.kdf);
    } else {
      wrappingKey = await derivePbkdf2WrappingKey(
        credential.password,
        keyset.passwordEnvelope.kdf.saltBase64,
        keyset.passwordEnvelope.kdf.iterations,
      );
    }

    return await crypto.subtle.unwrapKey(
      'raw',
      base64ToBytes(envelope.ciphertextBase64),
      wrappingKey,
      { name: 'AES-GCM', iv: base64ToBytes(envelope.nonceBase64) },
      'HKDF',
      false,
      ['deriveKey'],
    );
  } catch {
    throw new Error('Private Pro encrypted backup credentials are invalid.');
  }
}

function encodeLine(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

async function* backupLines(source: PrivateProEncryptedBackupSource): AsyncGenerator<Uint8Array> {
  const header = BackupHeaderSchema.parse({
    schema: PRIVATE_PRO_ENCRYPTED_BACKUP_SCHEMA,
    schemaVersion: PRIVATE_PRO_ENCRYPTED_BACKUP_SCHEMA_VERSION,
    kind: 'header',
    vaultId: source.vaultId,
    createdAtMs: source.createdAtMs ?? Date.now(),
    keyset: source.keyset,
  });
  yield encodeLine(header);

  let recordCount = 0;
  for await (const envelope of source.records()) {
    yield encodeLine(BackupRecordSchema.parse({ kind: 'record', envelope }));
    recordCount++;
  }

  let assetCount = 0;
  if (source.assets) {
    for await (const asset of source.assets()) {
      yield encodeLine(BackupAssetSchema.parse(asset));
      assetCount++;
    }
  }

  yield encodeLine(BackupEndSchema.parse({ kind: 'end', recordCount, assetCount }));
}

export function createPrivateProEncryptedBackupStream(source: PrivateProEncryptedBackupSource): ReadableStream<Uint8Array> {
  const iterator = backupLines(source)[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.(undefined);
    },
  });
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffered = '';
  let bufferedLineBytes = 0;
  let lineCount = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      for (const byte of result.value) {
        if (byte === 0x0a) bufferedLineBytes = 0;
        else if (++bufferedLineBytes > MAX_BACKUP_LINE_BYTES)
          throw new Error('Private Pro encrypted backup contains an oversized line.');
      }
      buffered += decoder.decode(result.value, { stream: true });
      let newlineIndex = buffered.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffered.slice(0, newlineIndex);
        buffered = buffered.slice(newlineIndex + 1);
        lineCount++;
        if (lineCount > MAX_BACKUP_LINES)
          throw new Error('Private Pro encrypted backup contains too many lines.');
        if (line.trim()) yield line;
        newlineIndex = buffered.indexOf('\n');
      }
    }
    buffered += decoder.decode();
    if (buffered.trim()) yield buffered;
  } finally {
    reader.releaseLock();
  }
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error('Private Pro encrypted backup contains invalid JSON.');
  }
}

export async function importPrivateProEncryptedBackup(
  stream: ReadableStream<Uint8Array>,
  credential: PrivateProEncryptedBackupCredential,
  validateRecord: PrivateProEncryptedBackupRecordValidator,
  apply: PrivateProEncryptedBackupApply,
): Promise<{ recordCount: number; assetCount: number; reloadRequired: true }> {
  let header: PrivateProEncryptedBackupHeader | null = null;
  let end: z.infer<typeof BackupEndSchema> | null = null;
  const records: PrivateProVaultEnvelope[] = [];
  const assets: PrivateProEncryptedBackupAsset[] = [];
  const recordIds = new Set<string>();
  const assetChunkIds = new Set<string>();

  for await (const line of readLines(stream)) {
    const value = parseJsonLine(line);
    if (!header) {
      header = BackupHeaderSchema.parse(value);
      continue;
    }
    if (end)
      throw new Error('Private Pro encrypted backup contains data after its end marker.');

    const kind = typeof value === 'object' && value !== null && 'kind' in value ? value.kind : undefined;
    if (kind === 'record') {
      const record = BackupRecordSchema.parse(value).envelope;
      const recordIdentity = `${record.recordType}\u0000${record.recordId}`;
      if (recordIds.has(recordIdentity))
        throw new Error('Private Pro encrypted backup contains a duplicate record.');
      recordIds.add(recordIdentity);
      records.push(record);
    }
    else if (kind === 'asset') {
      const asset = BackupAssetSchema.parse(value);
      const assetChunkIdentity = `${asset.assetId}\u0000${asset.chunkId}`;
      if (assetChunkIds.has(assetChunkIdentity))
        throw new Error('Private Pro encrypted backup contains a duplicate asset chunk.');
      assetChunkIds.add(assetChunkIdentity);
      assets.push(asset);
    }
    else if (kind === 'end') end = BackupEndSchema.parse(value);
    else throw new Error('Private Pro encrypted backup contains an unknown line type.');
  }

  if (!header) throw new Error('Private Pro encrypted backup header is missing.');
  if (!end) throw new Error('Private Pro encrypted backup end marker is missing.');
  if (end.recordCount !== records.length || end.assetCount !== assets.length)
    throw new Error('Private Pro encrypted backup item counts do not match its contents.');

  const masterKey = await unlockMasterKey(header.keyset, credential);
  for (const envelope of records) {
    if (envelope.keyVersion !== header.keyset.keyVersion)
      throw new Error('Private Pro encrypted backup record key version does not match its keyset.');
    const recordKey = await deriveVaultSubkey(
      masterKey,
      'record-encryption',
      `${envelope.recordType}/${envelope.recordId}`,
      ['encrypt', 'decrypt'],
    );
    const plaintext = await decryptVaultRecord(recordKey, envelope, { vaultId: header.vaultId });
    try {
      await validateRecord({ header, envelope, plaintext });
    } finally {
      plaintext.fill(0);
    }
  }
  for (const asset of assets) {
    if (asset.keyVersion !== header.keyset.keyVersion)
      throw new Error('Private Pro encrypted backup asset key version does not match its keyset.');
  }

  await apply({ header, masterKey, records, assets });
  return { recordCount: records.length, assetCount: assets.length, reloadRequired: true };
}

export function privateProEncryptedBackupResponse(source: PrivateProEncryptedBackupSource): Response {
  return new Response(createPrivateProEncryptedBackupStream(source), {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
  });
}
