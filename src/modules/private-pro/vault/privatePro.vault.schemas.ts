import * as z from 'zod/v4';

import type {
  PrivateProVaultDeleteOperation,
  PrivateProVaultDeviceMetadata,
  PrivateProVaultEnvelope,
  PrivateProVaultKeyset,
  PrivateProVaultOperation,
  PrivateProVaultPasswordEnvelope,
  PrivateProVaultPutOperation,
  PrivateProVaultRecordIndex,
  PrivateProVaultRecordIndexEntry,
  PrivateProVaultRecoveryEnvelope,
  PrivateProVaultTombstone,
  PrivateProVaultWrappedKeyEnvelope,
} from './privatePro.vault.types';


export const PRIVATE_PRO_VAULT_MAX_RECORD_CIPHERTEXT_BYTES = 16 * 1024 * 1024;
export const PRIVATE_PRO_VAULT_MAX_WRAPPED_KEY_CIPHERTEXT_BYTES = 8 * 1024;
export const PRIVATE_PRO_VAULT_MAX_RECORD_INDEX_ENTRIES = 500;
export const PRIVATE_PRO_VAULT_ARGON2ID_MIN_MEMORY_KIB = 64 * 1024;
export const PRIVATE_PRO_VAULT_ARGON2ID_MIN_ITERATIONS = 3;
export const PRIVATE_PRO_VAULT_ARGON2ID_MIN_PARALLELISM = 1;
export const PRIVATE_PRO_VAULT_ARGON2ID_MAX_MEMORY_KIB = 1024 * 1024;
export const PRIVATE_PRO_VAULT_ARGON2ID_MAX_ITERATIONS = 100;
export const PRIVATE_PRO_VAULT_ARGON2ID_MAX_PARALLELISM = 4;
export const PRIVATE_PRO_PBKDF2_MIN_ITERATIONS = 600_000;

const PRIVATE_PRO_VAULT_MAX_IDENTIFIER_LENGTH = 256;
const PRIVATE_PRO_VAULT_MAX_CURSOR_LENGTH = 512;
const PRIVATE_PRO_VAULT_MAX_OPERATION_ID_LENGTH = 128;
const PRIVATE_PRO_VAULT_MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const PRIVATE_PRO_VAULT_AES_GCM_TAG_BYTES = 16;
const PRIVATE_PRO_VAULT_NONCE_BYTES = 12;
const PRIVATE_PRO_VAULT_SALT_MIN_BYTES = 16;
const PRIVATE_PRO_VAULT_SALT_MAX_BYTES = 64;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;


function maxBase64Length(maxBytes: number): number {
  return 4 * Math.ceil(maxBytes / 3);
}

function decodedBase64ByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return base64.length / 4 * 3 - padding;
}

function isCanonicalBase64(base64: string): boolean {
  try {
    return btoa(atob(base64)) === base64;
  } catch {
    return false;
  }
}

function base64Schema(minBytes: number, maxBytes: number) {
  return z.string()
    .min(4)
    .max(maxBase64Length(maxBytes))
    .regex(CANONICAL_BASE64, 'Expected canonical base64.')
    .refine(isCanonicalBase64, 'Expected canonical base64.')
    .refine(value => {
      const decodedBytes = decodedBase64ByteLength(value);
      return decodedBytes >= minBytes && decodedBytes <= maxBytes;
    }, `Expected ${minBytes}-${maxBytes} decoded bytes.`);
}

function boundedPositiveInteger(maximum = PRIVATE_PRO_VAULT_MAX_SAFE_INTEGER) {
  return z.number().int().positive().max(maximum);
}

function boundedNonnegativeInteger(maximum = PRIVATE_PRO_VAULT_MAX_SAFE_INTEGER) {
  return z.number().int().nonnegative().max(maximum);
}


export const PrivateProVaultRecordTypeSchema = z.enum([
  'credential-service',
  'model-service',
  'settings',
  'chat',
  'persona',
  'folder',
  'scratch',
  'asset-manifest',
]);

export const PrivateProVaultNonceSchema = base64Schema(PRIVATE_PRO_VAULT_NONCE_BYTES, PRIVATE_PRO_VAULT_NONCE_BYTES);
export const PrivateProVaultSaltSchema = base64Schema(PRIVATE_PRO_VAULT_SALT_MIN_BYTES, PRIVATE_PRO_VAULT_SALT_MAX_BYTES);

function ciphertextSchema(maximumBytes: number) {
  return base64Schema(PRIVATE_PRO_VAULT_AES_GCM_TAG_BYTES, maximumBytes);
}

function encryptedFieldsSchema(maximumBytes: number) {
  return z.object({
    nonceBase64: PrivateProVaultNonceSchema,
    ciphertextBase64: ciphertextSchema(maximumBytes),
    ciphertextBytes: boundedPositiveInteger(maximumBytes),
  }).strict().refine(value => decodedBase64ByteLength(value.ciphertextBase64) === value.ciphertextBytes, {
    message: 'ciphertextBytes must match the decoded ciphertext length.',
    path: ['ciphertextBytes'],
  });
}

const PrivateProVaultIdentifierSchema = z.string().min(1).max(PRIVATE_PRO_VAULT_MAX_IDENTIFIER_LENGTH);
const PrivateProVaultOperationIdSchema = z.string().min(1).max(PRIVATE_PRO_VAULT_MAX_OPERATION_ID_LENGTH);
const PrivateProVaultTimestampSchema = boundedNonnegativeInteger();


export const PrivateProVaultEnvelopeSchema = z.object({
  formatVersion: z.literal(1),
  recordType: PrivateProVaultRecordTypeSchema,
  recordId: PrivateProVaultIdentifierSchema,
  schemaVersion: boundedPositiveInteger(),
  keyVersion: boundedPositiveInteger(),
  revision: boundedPositiveInteger(),
  ...encryptedFieldsSchema(PRIVATE_PRO_VAULT_MAX_RECORD_CIPHERTEXT_BYTES).shape,
}).strict().refine(value => decodedBase64ByteLength(value.ciphertextBase64) === value.ciphertextBytes, {
  message: 'ciphertextBytes must match the decoded ciphertext length.',
  path: ['ciphertextBytes'],
}) satisfies z.ZodType<PrivateProVaultEnvelope>;

export const PrivateProVaultWrappedKeyEnvelopeSchema = encryptedFieldsSchema(PRIVATE_PRO_VAULT_MAX_WRAPPED_KEY_CIPHERTEXT_BYTES) satisfies z.ZodType<PrivateProVaultWrappedKeyEnvelope>;

const PrivateProVaultArgon2idSchema = z.object({
  algorithm: z.literal('argon2id'),
  saltBase64: PrivateProVaultSaltSchema,
  memoryKiB: z.number().int().min(PRIVATE_PRO_VAULT_ARGON2ID_MIN_MEMORY_KIB).max(PRIVATE_PRO_VAULT_ARGON2ID_MAX_MEMORY_KIB),
  iterations: z.number().int().min(PRIVATE_PRO_VAULT_ARGON2ID_MIN_ITERATIONS).max(PRIVATE_PRO_VAULT_ARGON2ID_MAX_ITERATIONS),
  parallelism: z.number().int().min(PRIVATE_PRO_VAULT_ARGON2ID_MIN_PARALLELISM).max(PRIVATE_PRO_VAULT_ARGON2ID_MAX_PARALLELISM),
}).strict();

const PrivateProVaultPbkdf2Schema = z.object({
  algorithm: z.literal('pbkdf2-sha256'),
  saltBase64: PrivateProVaultSaltSchema,
  iterations: z.number().int().min(PRIVATE_PRO_PBKDF2_MIN_ITERATIONS).max(10_000_000),
}).strict();

export const PrivateProVaultPasswordEnvelopeSchema = z.object({
  formatVersion: z.literal(1),
  keyVersion: boundedPositiveInteger(),
  kdf: z.discriminatedUnion('algorithm', [PrivateProVaultArgon2idSchema, PrivateProVaultPbkdf2Schema]),
  ...encryptedFieldsSchema(PRIVATE_PRO_VAULT_MAX_WRAPPED_KEY_CIPHERTEXT_BYTES).shape,
}).strict().refine(value => decodedBase64ByteLength(value.ciphertextBase64) === value.ciphertextBytes, {
  message: 'ciphertextBytes must match the decoded ciphertext length.',
  path: ['ciphertextBytes'],
}) satisfies z.ZodType<PrivateProVaultPasswordEnvelope>;

export const PrivateProVaultRecoveryEnvelopeSchema = z.object({
  formatVersion: z.literal(1),
  keyVersion: boundedPositiveInteger(),
  recoveryVersion: boundedPositiveInteger(),
  ...encryptedFieldsSchema(PRIVATE_PRO_VAULT_MAX_WRAPPED_KEY_CIPHERTEXT_BYTES).shape,
}).strict().refine(value => decodedBase64ByteLength(value.ciphertextBase64) === value.ciphertextBytes, {
  message: 'ciphertextBytes must match the decoded ciphertext length.',
  path: ['ciphertextBytes'],
}) satisfies z.ZodType<PrivateProVaultRecoveryEnvelope>;

export const PrivateProVaultKeysetSchema = z.object({
  formatVersion: z.literal(1),
  keyVersion: boundedPositiveInteger(),
  passwordEnvelope: PrivateProVaultPasswordEnvelopeSchema,
  recoveryEnvelope: PrivateProVaultRecoveryEnvelopeSchema,
}).strict().refine(value =>
  value.keyVersion === value.passwordEnvelope.keyVersion && value.keyVersion === value.recoveryEnvelope.keyVersion,
{
  message: 'Keyset envelope versions must match keyVersion.',
  path: ['keyVersion'],
}) satisfies z.ZodType<PrivateProVaultKeyset>;

export const PrivateProVaultDeviceMetadataSchema = z.object({
  formatVersion: z.literal(1),
  deviceId: PrivateProVaultIdentifierSchema,
  keyVersion: boundedPositiveInteger(),
  createdAtMs: PrivateProVaultTimestampSchema,
  lastSeenAtMs: PrivateProVaultTimestampSchema,
  revokedAtMs: PrivateProVaultTimestampSchema.nullable(),
}).strict().refine(value => value.lastSeenAtMs >= value.createdAtMs, {
  message: 'lastSeenAtMs must not precede createdAtMs.',
  path: ['lastSeenAtMs'],
}) satisfies z.ZodType<PrivateProVaultDeviceMetadata>;

export const PrivateProVaultRecordIndexEntrySchema = z.object({
  recordType: PrivateProVaultRecordTypeSchema,
  recordId: PrivateProVaultIdentifierSchema,
  revision: boundedPositiveInteger(),
  keyVersion: boundedPositiveInteger(),
  ciphertextBytes: boundedPositiveInteger(PRIVATE_PRO_VAULT_MAX_RECORD_CIPHERTEXT_BYTES),
  serverUpdatedAtMs: PrivateProVaultTimestampSchema,
}).strict() satisfies z.ZodType<PrivateProVaultRecordIndexEntry>;

export const PrivateProVaultRecordIndexSchema = z.object({
  formatVersion: z.literal(1),
  entries: z.array(PrivateProVaultRecordIndexEntrySchema).max(PRIVATE_PRO_VAULT_MAX_RECORD_INDEX_ENTRIES),
  nextCursor: z.string().min(1).max(PRIVATE_PRO_VAULT_MAX_CURSOR_LENGTH).nullable(),
}).strict().refine(value => {
  const keys = new Set(value.entries.map(entry => `${entry.recordType}:${entry.recordId}`));
  return keys.size === value.entries.length;
}, {
  message: 'Record index must not contain duplicate records.',
  path: ['entries'],
}) satisfies z.ZodType<PrivateProVaultRecordIndex>;

export const PrivateProVaultTombstoneSchema = z.object({
  formatVersion: z.literal(1),
  recordType: PrivateProVaultRecordTypeSchema,
  recordId: PrivateProVaultIdentifierSchema,
  revision: boundedPositiveInteger(),
  keyVersion: boundedPositiveInteger(),
  operationId: PrivateProVaultOperationIdSchema,
  deletedAtMs: PrivateProVaultTimestampSchema,
}).strict() satisfies z.ZodType<PrivateProVaultTombstone>;

export const PrivateProVaultPutOperationSchema = z.object({
  formatVersion: z.literal(1),
  operationId: PrivateProVaultOperationIdSchema,
  kind: z.literal('put'),
  baseRevision: boundedNonnegativeInteger(),
  envelope: PrivateProVaultEnvelopeSchema,
}).strict().refine(value => value.envelope.revision === value.baseRevision + 1, {
  message: 'Envelope revision must target baseRevision + 1.',
  path: ['envelope', 'revision'],
}) satisfies z.ZodType<PrivateProVaultPutOperation>;

export const PrivateProVaultDeleteOperationSchema = z.object({
  formatVersion: z.literal(1),
  operationId: PrivateProVaultOperationIdSchema,
  kind: z.literal('delete'),
  baseRevision: boundedNonnegativeInteger(),
  tombstone: PrivateProVaultTombstoneSchema,
}).strict().refine(value => {
  return value.tombstone.operationId === value.operationId && value.tombstone.revision === value.baseRevision + 1;
}, {
  message: 'Tombstone must target baseRevision + 1 and use the operation ID.',
  path: ['tombstone'],
}) satisfies z.ZodType<PrivateProVaultDeleteOperation>;

export const PrivateProVaultOperationSchema = z.discriminatedUnion('kind', [
  PrivateProVaultPutOperationSchema,
  PrivateProVaultDeleteOperationSchema,
]) satisfies z.ZodType<PrivateProVaultOperation>;
