import { createHash, randomBytes } from 'node:crypto';

import {
  PRIVATE_PRO_VAULT_FIRESTORE_MAX_CIPHERTEXT_BYTES,
  PRIVATE_PRO_VAULT_BACKUP_MAX_RECORDS,
  PRIVATE_PRO_VAULT_BACKUP_MAX_TOTAL_CIPHERTEXT_BYTES,
  PRIVATE_PRO_VAULT_MAX_INDEX_PAGE_SIZE,
  type PrivateProVaultOperationOutcome,
  type PrivateProVaultRepository,
} from './privatePro.vault.repository';
import {
  PrivateProVaultEnvelopeSchema,
  PrivateProVaultKeysetSchema,
  PrivateProVaultTombstoneSchema,
} from './privatePro.vault.schemas';
import type { PrivateProVaultEnvelope, PrivateProVaultKeyset, PrivateProVaultTombstone } from './privatePro.vault.types';
import { verifyPrivateProVaultDeviceRegistration } from './privatePro.vault.registration';


const OPAQUE_RECORD_ID = /^[A-Za-z0-9_-]{43}$/;
const OPERATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface PutVaultRecordInput {
  operationId: string;
  opaqueRecordId: string;
  baseRevision: number;
  envelope: PrivateProVaultEnvelope;
}

export type PutVaultRecordResult =
  | { status: 'committed'; revision: number; serverUpdatedAtMs: number }
  | { status: 'unchanged'; revision: number; serverUpdatedAtMs: number }
  | { status: 'conflict'; currentRevision: number };

export interface DeleteVaultRecordInput {
  operationId: string;
  opaqueRecordId: string;
  baseRevision: number;
  tombstone: PrivateProVaultTombstone;
}

export interface PutVaultKeysetInput {
  operationId: string;
  baseWrappingVersion: number;
  keyset: PrivateProVaultKeyset;
  securityEvent?: {
    eventId: string;
    deviceId: string;
    type: 'recovery-password-reset' | 'password-changed';
  };
}

export interface MergeVaultBackupInput {
  operationId: string;
  records: Array<{
    opaqueRecordId: string;
    baseRevision: number;
    envelope: PrivateProVaultEnvelope;
  }>;
}

export interface BeginVaultBackupRestoreInput {
  restoreId: string;
  backupFingerprint: string;
  chunkCount: number;
  recordCount: number;
}

export interface MergeVaultBackupRestoreChunkInput extends MergeVaultBackupInput {
  restoreId: string;
  chunkIndex: number;
  chunkCount: number;
}

export interface FinalizeVaultBackupRestoreInput {
  restoreId: string;
  operationId: string;
}

export type MergeVaultBackupResult =
  | { status: 'committed' | 'unchanged'; records: Array<{ opaqueRecordId: string; revision: number; serverUpdatedAtMs: number }> }
  | { status: 'conflict'; conflicts: Array<{ opaqueRecordId: string; currentRevision: number }> };

export type PutVaultKeysetResult =
  | { status: 'committed'; wrappingVersion: number; serverUpdatedAtMs: number }
  | { status: 'unchanged'; wrappingVersion: number; serverUpdatedAtMs: number }
  | { status: 'conflict'; currentWrappingVersion: number };

export interface RevokeVaultDeviceInput {
  operationId: string;
  deviceId: string;
}

export interface BeginVaultDeviceRegistrationInput {
  deviceId: string;
  keyVersion: number;
}

export interface CompleteVaultDeviceRegistrationInput {
  operationId: string;
  deviceId: string;
  keyVersion: number;
  challengeId: string;
  challengeBase64: string;
  expiresAtMs: number;
  signatureBase64: string;
}

function assertUid(uid: string): void {
  if (!uid || uid.includes('/')) throw new Error('Authenticated UID is invalid.');
}

function assertOperationId(operationId: string): void {
  if (!OPERATION_ID.test(operationId)) throw new Error('Vault operation ID is invalid.');
}

function assertOpaqueRecordId(opaqueRecordId: string, label = 'opaque record ID'): void {
  if (!OPAQUE_RECORD_ID.test(opaqueRecordId)) throw new Error(`Vault ${label} is invalid.`);
}

function assertBaseRevision(baseRevision: number): void {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new Error('Vault base revision is invalid.');
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('base64url');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(',')}}`;
}

function equalCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertPasswordWrappingRotation(current: PrivateProVaultKeyset, next: PrivateProVaultKeyset): void {
  if (current.keyVersion !== next.keyVersion)
    throw new Error('Vault master key version cannot change during wrapping rotation.');
  if (!equalCanonical(current.enrollmentAuthority.publicJwk, next.enrollmentAuthority.publicJwk))
    throw new Error('Vault enrollment authority cannot change during password wrapping rotation.');
  if (!equalCanonical(current.enrollmentAuthority.recoveryEnvelope, next.enrollmentAuthority.recoveryEnvelope))
    throw new Error('Vault enrollment recovery envelope cannot change during password wrapping rotation.');
  if (!equalCanonical(current.recoveryEnvelope, next.recoveryEnvelope))
    throw new Error('Vault master recovery envelope cannot change during password wrapping rotation.');
}

function repeatOutcome(outcome: PrivateProVaultOperationOutcome) {
  switch (outcome.kind) {
    case 'record':
      return outcome.status === 'committed'
        ? { status: 'unchanged' as const, revision: outcome.revision, serverUpdatedAtMs: outcome.serverUpdatedAtMs }
        : { status: 'conflict' as const, currentRevision: outcome.currentRevision };
    case 'keyset':
      return outcome.status === 'committed'
        ? { status: 'unchanged' as const, wrappingVersion: outcome.wrappingVersion, serverUpdatedAtMs: outcome.serverUpdatedAtMs }
        : { status: 'conflict' as const, currentWrappingVersion: outcome.currentWrappingVersion };
    case 'device':
      return { status: 'unchanged' as const, revokedAtMs: outcome.revokedAtMs };
    case 'device-registration':
      return { status: 'unchanged' as const, device: outcome.device };
  }
}

async function existingOperation(
  transaction: Parameters<Parameters<PrivateProVaultRepository['transaction']>[1]>[0],
  operationId: string,
  requestFingerprint: string,
) {
  const existing = await transaction.getOperation(operationId);
  if (!existing) return null;
  if (existing.requestFingerprint !== requestFingerprint)
    throw new Error('Vault operation ID is already used by different content.');
  return repeatOutcome(existing.outcome);
}

export function createPrivateProVaultService(
  repository: PrivateProVaultRepository,
  now: () => number = Date.now,
  random: (byteLength: number) => Uint8Array = byteLength => randomBytes(byteLength),
) {
  return {
    async bootstrap(uid: string, deviceId: string) {
      assertUid(uid);
      assertOpaqueRecordId(deviceId, 'device ID');
      return repository.transaction(uid, async transaction => {
        const [storedKeyset, existingDevice] = await Promise.all([
          transaction.getKeyset(),
          transaction.getDevice(deviceId),
        ]);
        return {
          keyset: storedKeyset ? { keyset: storedKeyset.keyset, serverUpdatedAtMs: storedKeyset.serverUpdatedAtMs } : null,
          device: existingDevice,
        };
      });
    },

    async beginDeviceRegistration(uid: string, input: BeginVaultDeviceRegistrationInput) {
      assertUid(uid);
      assertOpaqueRecordId(input.deviceId, 'device ID');
      if (!Number.isSafeInteger(input.keyVersion) || input.keyVersion <= 0) throw new Error('Vault device key version is invalid.');
      return repository.transaction(uid, async transaction => {
        const storedKeyset = await transaction.getKeyset();
        if (!storedKeyset || storedKeyset.keyVersion !== input.keyVersion) throw new Error('Vault device key version is stale.');
        const existing = await transaction.getDevice(input.deviceId);
        if (existing?.revokedAtMs !== null && existing?.revokedAtMs !== undefined) throw new Error('Vault device is revoked.');
        if (existing) throw new Error('Vault device is already registered.');
        const challengeBytes = random(32);
        if (challengeBytes.byteLength !== 32) throw new Error('Vault registration challenge generation failed.');
        const challenge = {
          formatVersion: 1 as const,
          challengeId: Buffer.from(random(32)).toString('base64url'),
          challengeBase64: Buffer.from(challengeBytes).toString('base64'),
          deviceId: input.deviceId,
          keyVersion: input.keyVersion,
          expiresAtMs: now() + 5 * 60 * 1_000,
        };
        assertOpaqueRecordId(challenge.challengeId, 'registration challenge ID');
        await transaction.createRegistrationChallenge(challenge);
        return challenge;
      });
    },

    async completeDeviceRegistration(uid: string, input: CompleteVaultDeviceRegistrationInput) {
      assertUid(uid);
      assertOpaqueRecordId(input.deviceId, 'device ID');
      assertOpaqueRecordId(input.challengeId, 'registration challenge ID');
      assertOperationId(input.operationId);
      if (!Number.isSafeInteger(input.keyVersion) || input.keyVersion <= 0) throw new Error('Vault device key version is invalid.');
      if (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= 0) throw new Error('Vault registration challenge expiry is invalid.');
      if (!/^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/.test(input.challengeBase64)
        || Buffer.from(input.challengeBase64, 'base64').byteLength !== 32)
        throw new Error('Vault registration challenge is invalid.');
      return repository.transaction(uid, async transaction => {
        const requestFingerprint = fingerprint({ kind: 'register-device', ...input });
        const repeated = await existingOperation(transaction, input.operationId, requestFingerprint);
        if (repeated) return repeated as { status: 'unchanged'; device: Awaited<ReturnType<typeof transaction.getDevice>> & object };
        const [storedKeyset, challenge, existing] = await Promise.all([
          transaction.getKeyset(),
          transaction.getRegistrationChallenge(input.challengeId),
          transaction.getDevice(input.deviceId),
        ]);
        if (!storedKeyset || storedKeyset.keyVersion !== input.keyVersion) throw new Error('Vault device key version is stale.');
        if (existing?.revokedAtMs !== null && existing?.revokedAtMs !== undefined) throw new Error('Vault device is revoked.');
        if (!challenge
          || challenge.deviceId !== input.deviceId
          || challenge.keyVersion !== input.keyVersion
          || challenge.challengeBase64 !== input.challengeBase64
          || challenge.expiresAtMs !== input.expiresAtMs)
          throw new Error('Vault registration challenge is invalid.');
        if (challenge.expiresAtMs <= now()) throw new Error('Vault registration challenge expired.');
        if (!await verifyPrivateProVaultDeviceRegistration(storedKeyset.keyset.enrollmentAuthority.publicJwk, {
          formatVersion: 1,
          uid,
          deviceId: input.deviceId,
          keyVersion: input.keyVersion,
          challengeId: input.challengeId,
          challengeBase64: input.challengeBase64,
          expiresAtMs: input.expiresAtMs,
        }, input.signatureBase64)) throw new Error('Vault device registration proof is invalid.');
        if (existing) throw new Error('Vault device is already registered.');
        const timestamp = now();
        const device = {
          formatVersion: 1 as const,
          deviceId: input.deviceId,
          keyVersion: input.keyVersion,
          createdAtMs: timestamp,
          lastSeenAtMs: timestamp,
          revokedAtMs: null,
        };
        await transaction.setDevice(device);
        await transaction.deleteRegistrationChallenge(input.challengeId);
        await transaction.createOperation({ operationId: input.operationId, requestFingerprint, outcome: { kind: 'device-registration', status: 'committed', device } });
        return { status: 'registered' as const, device };
      });
    },

    async listDevices(uid: string) {
      assertUid(uid);
      return repository.transaction(uid, transaction => transaction.listDevices());
    },

    async putRecord(uid: string, input: PutVaultRecordInput): Promise<PutVaultRecordResult> {
      assertUid(uid);
      assertOperationId(input.operationId);
      assertOpaqueRecordId(input.opaqueRecordId);
      assertBaseRevision(input.baseRevision);
      const envelope = PrivateProVaultEnvelopeSchema.parse(input.envelope);
      if (envelope.recordId !== input.opaqueRecordId) throw new Error('Vault envelope record ID disagrees with the route.');
      if (envelope.revision !== input.baseRevision + 1) throw new Error('Vault envelope revision must follow the base revision.');
      if (envelope.ciphertextBytes > PRIVATE_PRO_VAULT_FIRESTORE_MAX_CIPHERTEXT_BYTES)
        throw new Error('Vault record ciphertext exceeds the 700 KiB server limit.');
      const requestFingerprint = fingerprint({ kind: 'put-record', ...input, envelope });

      return repository.transaction(uid, async transaction => {
        if (await transaction.getRestoreSession()) throw new Error('An encrypted backup restore is in progress.');
        const repeated = await existingOperation(transaction, input.operationId, requestFingerprint);
        if (repeated) return repeated as PutVaultRecordResult;
        const [record, tombstone] = await Promise.all([
          transaction.getRecord(input.opaqueRecordId),
          transaction.getTombstone(input.opaqueRecordId),
        ]);
        const currentRevision = Math.max(record?.revision ?? 0, tombstone?.revision ?? 0);
        if (currentRevision !== input.baseRevision) {
          const outcome = { kind: 'record', status: 'conflict', currentRevision } as const;
          await transaction.createOperation({ operationId: input.operationId, requestFingerprint, outcome });
          return { status: 'conflict', currentRevision };
        }
        const serverUpdatedAtMs = now();
        await transaction.setRecord({
          opaqueRecordId: input.opaqueRecordId,
          revision: envelope.revision,
          serverUpdatedAtMs,
          envelope: structuredClone(envelope),
        });
        await transaction.deleteTombstone(input.opaqueRecordId);
        const outcome = { kind: 'record', status: 'committed', revision: envelope.revision, serverUpdatedAtMs } as const;
        await transaction.createOperation({ operationId: input.operationId, requestFingerprint, outcome });
        return { status: 'committed', revision: envelope.revision, serverUpdatedAtMs };
      });
    },

    async deleteRecord(uid: string, input: DeleteVaultRecordInput): Promise<PutVaultRecordResult> {
      assertUid(uid);
      assertOperationId(input.operationId);
      assertOpaqueRecordId(input.opaqueRecordId);
      assertBaseRevision(input.baseRevision);
      const tombstone = PrivateProVaultTombstoneSchema.parse(input.tombstone);
      if (tombstone.recordId !== input.opaqueRecordId) throw new Error('Vault tombstone record ID disagrees with the route.');
      if (tombstone.operationId !== input.operationId) throw new Error('Vault tombstone operation ID disagrees with the request.');
      if (tombstone.revision !== input.baseRevision + 1) throw new Error('Vault tombstone revision must follow the base revision.');
      const requestFingerprint = fingerprint({ kind: 'delete-record', ...input, tombstone });

      return repository.transaction(uid, async transaction => {
        if (await transaction.getRestoreSession()) throw new Error('An encrypted backup restore is in progress.');
        const repeated = await existingOperation(transaction, input.operationId, requestFingerprint);
        if (repeated) return repeated as PutVaultRecordResult;
        const [record, existingTombstone] = await Promise.all([
          transaction.getRecord(input.opaqueRecordId),
          transaction.getTombstone(input.opaqueRecordId),
        ]);
        const currentRevision = Math.max(record?.revision ?? 0, existingTombstone?.revision ?? 0);
        if (currentRevision !== input.baseRevision) {
          const outcome = { kind: 'record', status: 'conflict', currentRevision } as const;
          await transaction.createOperation({ operationId: input.operationId, requestFingerprint, outcome });
          return { status: 'conflict', currentRevision };
        }
        const serverUpdatedAtMs = now();
        await transaction.setTombstone({
          opaqueRecordId: input.opaqueRecordId,
          revision: tombstone.revision,
          serverUpdatedAtMs,
          tombstone: structuredClone(tombstone),
        });
        await transaction.deleteRecord(input.opaqueRecordId);
        const outcome = { kind: 'record', status: 'committed', revision: tombstone.revision, serverUpdatedAtMs } as const;
        await transaction.createOperation({ operationId: input.operationId, requestFingerprint, outcome });
        return { status: 'committed', revision: tombstone.revision, serverUpdatedAtMs };
      });
    },

    async getIndex(uid: string, input: { pageSize: number; cursor?: string | null }) {
      assertUid(uid);
      if (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > PRIVATE_PRO_VAULT_MAX_INDEX_PAGE_SIZE)
        throw new Error('Vault index page size must be between 1 and 500.');
      const cursor = input.cursor ?? null;
      if (cursor !== null) assertOpaqueRecordId(cursor, 'cursor');
      return repository.transaction(uid, async transaction => {
        if (await transaction.getRestoreSession()) throw new Error('An encrypted backup restore is in progress.');
        const entries = await transaction.listIndexEntries(cursor, input.pageSize + 1);
        const hasMore = entries.length > input.pageSize;
        const page = entries.slice(0, input.pageSize);
        return { entries: page, nextCursor: hasMore ? page.at(-1)?.opaqueRecordId ?? null : null };
      });
    },

    async getRecords(uid: string, opaqueRecordIds: readonly string[]) {
      assertUid(uid);
      if (opaqueRecordIds.length > PRIVATE_PRO_VAULT_MAX_INDEX_PAGE_SIZE) throw new Error('Too many vault records requested.');
      opaqueRecordIds.forEach(recordId => assertOpaqueRecordId(recordId));
      return repository.transaction(uid, async transaction => {
        if (await transaction.getRestoreSession()) throw new Error('An encrypted backup restore is in progress.');
        return transaction.getRecords(opaqueRecordIds);
      });
    },

    async putKeyset(uid: string, input: PutVaultKeysetInput): Promise<PutVaultKeysetResult> {
      assertUid(uid);
      assertOperationId(input.operationId);
      if (!Number.isSafeInteger(input.baseWrappingVersion) || input.baseWrappingVersion < 0) throw new Error('Vault base wrapping version is invalid.');
      const keyset = PrivateProVaultKeysetSchema.parse(input.keyset);
      if (input.securityEvent) {
        assertOpaqueRecordId(input.securityEvent.eventId, 'security event ID');
        assertOpaqueRecordId(input.securityEvent.deviceId, 'device ID');
      }
      if (keyset.wrappingVersion !== input.baseWrappingVersion + 1) throw new Error('Vault wrapping version must follow the base wrapping version.');
      const requestFingerprint = fingerprint({ kind: 'put-keyset', ...input, keyset });

      return repository.transaction(uid, async transaction => {
        if (await transaction.getRestoreSession()) throw new Error('An encrypted backup restore is in progress.');
        const repeated = await existingOperation(transaction, input.operationId, requestFingerprint);
        if (repeated) return repeated as PutVaultKeysetResult;
        const current = await transaction.getKeyset();
        const currentWrappingVersion = current?.wrappingVersion ?? 0;
        if (currentWrappingVersion !== input.baseWrappingVersion) {
          const outcome = { kind: 'keyset', status: 'conflict', currentWrappingVersion } as const;
          await transaction.createOperation({ operationId: input.operationId, requestFingerprint, outcome });
          return { status: 'conflict', currentWrappingVersion };
        }
        if (current) assertPasswordWrappingRotation(current.keyset, keyset);
        const serverUpdatedAtMs = now();
        await transaction.setKeyset({ keyVersion: keyset.keyVersion, wrappingVersion: keyset.wrappingVersion, serverUpdatedAtMs, keyset: structuredClone(keyset) });
        if (input.securityEvent) await transaction.createSecurityEvent({
          formatVersion: 1,
          ...input.securityEvent,
          createdAtMs: serverUpdatedAtMs,
        });
        const outcome = { kind: 'keyset', status: 'committed', wrappingVersion: keyset.wrappingVersion, serverUpdatedAtMs } as const;
        await transaction.createOperation({ operationId: input.operationId, requestFingerprint, outcome });
        return { status: 'committed', wrappingVersion: keyset.wrappingVersion, serverUpdatedAtMs };
      });
    },

    async getKeyset(uid: string) {
      assertUid(uid);
      const stored = await repository.transaction(uid, transaction => transaction.getKeyset());
      return stored ? { keyset: stored.keyset, serverUpdatedAtMs: stored.serverUpdatedAtMs } : null;
    },

    async revokeDevice(uid: string, input: RevokeVaultDeviceInput) {
      assertUid(uid);
      assertOperationId(input.operationId);
      assertOpaqueRecordId(input.deviceId, 'device ID');
      const requestFingerprint = fingerprint({ kind: 'revoke-device', ...input });
      return repository.transaction(uid, async transaction => {
        const repeated = await existingOperation(transaction, input.operationId, requestFingerprint);
        if (repeated) return repeated as { status: 'unchanged'; revokedAtMs: number };
        const existing = await transaction.getDevice(input.deviceId);
        if (!existing) throw new Error('Vault device is not registered.');
        const revokedAtMs = existing.revokedAtMs ?? now();
        await transaction.setDevice({ ...existing, revokedAtMs });
        const outcome = { kind: 'device', status: 'committed', revokedAtMs } as const;
        await transaction.createOperation({ operationId: input.operationId, requestFingerprint, outcome });
        return { status: 'committed' as const, revokedAtMs };
      });
    },

    async mergeBackup(uid: string, input: MergeVaultBackupInput): Promise<MergeVaultBackupResult> {
      assertUid(uid);
      assertOperationId(input.operationId);
      if (input.records.length < 1 || input.records.length > PRIVATE_PRO_VAULT_BACKUP_MAX_RECORDS)
        throw new Error('Vault backup merge contains too many records.');
      const seen = new Set<string>();
      let totalCiphertextBytes = 0;
      const records = input.records.map(record => {
        assertOpaqueRecordId(record.opaqueRecordId);
        assertBaseRevision(record.baseRevision);
        const envelope = PrivateProVaultEnvelopeSchema.parse(record.envelope);
        if (seen.has(record.opaqueRecordId)) throw new Error('Vault backup merge contains duplicate records.');
        seen.add(record.opaqueRecordId);
        if (envelope.recordId !== record.opaqueRecordId) throw new Error('Vault envelope record ID disagrees with the route.');
        if (envelope.revision !== record.baseRevision + 1) throw new Error('Vault envelope revision must follow the base revision.');
        if (envelope.ciphertextBytes > PRIVATE_PRO_VAULT_FIRESTORE_MAX_CIPHERTEXT_BYTES)
          throw new Error('Vault record ciphertext exceeds the 700 KiB server limit.');
        totalCiphertextBytes += envelope.ciphertextBytes;
        return { ...record, envelope };
      });
      if (totalCiphertextBytes > PRIVATE_PRO_VAULT_BACKUP_MAX_TOTAL_CIPHERTEXT_BYTES)
        throw new Error('Vault backup merge exceeds the total ciphertext byte limit.');
      const requestFingerprint = fingerprint({ kind: 'merge-backup', operationId: input.operationId, records });

      return repository.transaction(uid, async transaction => {
        if (await transaction.getRestoreSession()) throw new Error('An encrypted backup restore is in progress.');
        const repeated = await transaction.getBackupMerge(input.operationId);
        if (repeated) {
          if (repeated.requestFingerprint !== requestFingerprint)
            throw new Error('Vault operation ID is already used by different content.');
          return { status: 'unchanged', records: repeated.outcome.records };
        }
        const current = await Promise.all(records.map(async record => {
          const [stored, tombstone] = await Promise.all([
            transaction.getRecord(record.opaqueRecordId),
            transaction.getTombstone(record.opaqueRecordId),
          ]);
          return { record, currentRevision: Math.max(stored?.revision ?? 0, tombstone?.revision ?? 0) };
        }));
        const conflicts = current
          .filter(entry => entry.currentRevision !== entry.record.baseRevision)
          .map(entry => ({ opaqueRecordId: entry.record.opaqueRecordId, currentRevision: entry.currentRevision }));
        if (conflicts.length) {
          return { status: 'conflict' as const, conflicts };
        }
        const serverUpdatedAtMs = now();
        const outcomes = records.map(record => ({
          opaqueRecordId: record.opaqueRecordId,
          revision: record.envelope.revision,
          serverUpdatedAtMs,
        }));
        for (const record of records) {
          await transaction.setRecord({
            opaqueRecordId: record.opaqueRecordId,
            revision: record.envelope.revision,
            serverUpdatedAtMs,
            envelope: structuredClone(record.envelope),
          });
          await transaction.deleteTombstone(record.opaqueRecordId);
        }
        const outcome = { status: 'committed' as const, records: outcomes };
        await transaction.createBackupMerge({ operationId: input.operationId, requestFingerprint, outcome });
        return outcome;
      });
    },

    async beginBackupRestore(uid: string, input: BeginVaultBackupRestoreInput) {
      assertUid(uid);
      assertRestoreId(input.restoreId);
      assertRestoreCounts(input.chunkCount, input.recordCount);
      if (!OPAQUE_RECORD_ID.test(input.backupFingerprint)) throw new Error('Vault restore fingerprint is invalid.');
      return repository.transaction(uid, async transaction => {
        const [active, completion] = await Promise.all([
          transaction.getRestoreSession(),
          transaction.getRestoreCompletion(input.restoreId),
        ]);
        if (completion) {
          if (completion.backupFingerprint !== input.backupFingerprint
            || completion.chunkCount !== input.chunkCount
            || completion.recordCount !== input.recordCount)
            throw new Error('Vault restore ID is already used by different content.');
          return { status: 'completed' as const, completion };
        }
        if (active) {
          if (active.restoreId !== input.restoreId
            || active.backupFingerprint !== input.backupFingerprint
            || active.chunkCount !== input.chunkCount
            || active.recordCount !== input.recordCount)
            throw new Error('Another encrypted backup restore is already in progress.');
          return { status: 'unchanged' as const, session: active };
        }
        const session = {
          formatVersion: 1 as const,
          restoreId: input.restoreId,
          backupFingerprint: input.backupFingerprint,
          chunkCount: input.chunkCount,
          recordCount: input.recordCount,
          nextChunkIndex: 0,
          committedRecordCount: 0,
          startedAtMs: now(),
        };
        await transaction.setRestoreSession(session);
        return { status: 'started' as const, session };
      });
    },

    async getBackupRestoreStatus(uid: string, restoreId: string) {
      assertUid(uid);
      assertRestoreId(restoreId);
      return repository.transaction(uid, async transaction => {
        const active = await transaction.getRestoreSession();
        if (active?.restoreId === restoreId) return active;
        const completion = await transaction.getRestoreCompletion(restoreId);
        return completion ? { ...completion, nextChunkIndex: completion.chunkCount } : null;
      });
    },

    async mergeBackupRestoreChunk(uid: string, input: MergeVaultBackupRestoreChunkInput) {
      assertUid(uid);
      assertRestoreId(input.restoreId);
      assertOperationId(input.operationId);
      if (!Number.isSafeInteger(input.chunkCount) || input.chunkCount < 1 || input.chunkCount > 100_000)
        throw new Error('Vault restore chunk count is invalid.');
      if (!Number.isSafeInteger(input.chunkIndex) || input.chunkIndex < 0 || input.chunkIndex >= input.chunkCount)
        throw new Error('Vault restore chunk index is invalid.');
      if (input.records.length < 1 || input.records.length > PRIVATE_PRO_VAULT_BACKUP_MAX_RECORDS)
        throw new Error('Vault backup merge contains too many records.');
      const seen = new Set<string>();
      let totalCiphertextBytes = 0;
      const records = input.records.map(record => {
        assertOpaqueRecordId(record.opaqueRecordId);
        assertBaseRevision(record.baseRevision);
        const envelope = PrivateProVaultEnvelopeSchema.parse(record.envelope);
        if (seen.has(record.opaqueRecordId)) throw new Error('Vault backup merge contains duplicate records.');
        seen.add(record.opaqueRecordId);
        if (envelope.recordId !== record.opaqueRecordId) throw new Error('Vault envelope record ID disagrees with the route.');
        if (envelope.revision !== record.baseRevision + 1) throw new Error('Vault envelope revision must follow the base revision.');
        if (envelope.ciphertextBytes > PRIVATE_PRO_VAULT_FIRESTORE_MAX_CIPHERTEXT_BYTES)
          throw new Error('Vault record ciphertext exceeds the 700 KiB server limit.');
        totalCiphertextBytes += envelope.ciphertextBytes;
        return { ...record, envelope };
      });
      if (totalCiphertextBytes > PRIVATE_PRO_VAULT_BACKUP_MAX_TOTAL_CIPHERTEXT_BYTES)
        throw new Error('Vault backup merge exceeds the total ciphertext byte limit.');
      const requestFingerprint = fingerprint({ kind: 'restore-chunk', ...input, records });
      return repository.transaction(uid, async transaction => {
        const session = await transaction.getRestoreSession();
        if (!session || session.restoreId !== input.restoreId) throw new Error('Encrypted backup restore session is unavailable.');
        if (session.chunkCount !== input.chunkCount) throw new Error('Encrypted backup restore chunk count changed.');
        const repeated = await transaction.getBackupMerge(input.operationId);
        if (repeated) {
          if (repeated.requestFingerprint !== requestFingerprint) throw new Error('Vault operation ID is already used by different content.');
          return { status: 'unchanged' as const, records: repeated.outcome.records, nextChunkIndex: session.nextChunkIndex };
        }
        if (input.chunkIndex !== session.nextChunkIndex) throw new Error('Encrypted backup restore chunk is out of sequence.');
        const current = await Promise.all(records.map(async record => {
          const [stored, tombstone] = await Promise.all([transaction.getRecord(record.opaqueRecordId), transaction.getTombstone(record.opaqueRecordId)]);
          return { record, currentRevision: Math.max(stored?.revision ?? 0, tombstone?.revision ?? 0) };
        }));
        const conflicts = current.filter(entry => entry.currentRevision !== entry.record.baseRevision)
          .map(entry => ({ opaqueRecordId: entry.record.opaqueRecordId, currentRevision: entry.currentRevision }));
        if (conflicts.length) return { status: 'conflict' as const, conflicts, nextChunkIndex: session.nextChunkIndex };
        const serverUpdatedAtMs = now();
        const outcomes = records.map(record => ({ opaqueRecordId: record.opaqueRecordId, revision: record.envelope.revision, serverUpdatedAtMs }));
        for (const record of records) {
          await transaction.setRecord({ opaqueRecordId: record.opaqueRecordId, revision: record.envelope.revision, serverUpdatedAtMs, envelope: structuredClone(record.envelope) });
          await transaction.deleteTombstone(record.opaqueRecordId);
        }
        await transaction.createBackupMerge({ operationId: input.operationId, requestFingerprint, outcome: { status: 'committed', records: outcomes } });
        await transaction.setRestoreSession({
          ...session,
          nextChunkIndex: session.nextChunkIndex + 1,
          committedRecordCount: session.committedRecordCount + records.length,
        });
        return { status: 'committed' as const, records: outcomes, nextChunkIndex: session.nextChunkIndex + 1 };
      });
    },

    async getBackupRestoreIndex(uid: string, restoreId: string, input: { pageSize: number; cursor?: string | null }) {
      assertUid(uid);
      assertRestoreId(restoreId);
      if (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > PRIVATE_PRO_VAULT_MAX_INDEX_PAGE_SIZE)
        throw new Error('Vault index page size must be between 1 and 500.');
      const cursor = input.cursor ?? null;
      if (cursor !== null) assertOpaqueRecordId(cursor, 'cursor');
      return repository.transaction(uid, async transaction => {
        const active = await transaction.getRestoreSession();
        const completion = await transaction.getRestoreCompletion(restoreId);
        if (active?.restoreId !== restoreId && !completion) throw new Error('Encrypted backup restore session is unavailable.');
        const entries = await transaction.listIndexEntries(cursor, input.pageSize + 1);
        const hasMore = entries.length > input.pageSize;
        const page = entries.slice(0, input.pageSize);
        return { entries: page, nextCursor: hasMore ? page.at(-1)?.opaqueRecordId ?? null : null };
      });
    },

    async getBackupRestoreRecords(uid: string, restoreId: string, opaqueRecordIds: readonly string[]) {
      assertUid(uid);
      assertRestoreId(restoreId);
      if (opaqueRecordIds.length > PRIVATE_PRO_VAULT_MAX_INDEX_PAGE_SIZE) throw new Error('Too many vault records requested.');
      opaqueRecordIds.forEach(recordId => assertOpaqueRecordId(recordId));
      return repository.transaction(uid, async transaction => {
        const active = await transaction.getRestoreSession();
        const completion = await transaction.getRestoreCompletion(restoreId);
        if (active?.restoreId !== restoreId && !completion) throw new Error('Encrypted backup restore session is unavailable.');
        return transaction.getRecords(opaqueRecordIds);
      });
    },

    async finalizeBackupRestore(uid: string, input: FinalizeVaultBackupRestoreInput) {
      assertUid(uid);
      assertRestoreId(input.restoreId);
      assertOperationId(input.operationId);
      const requestFingerprint = fingerprint({ kind: 'finalize-restore', ...input });
      return repository.transaction(uid, async transaction => {
        const existing = await transaction.getRestoreCompletion(input.restoreId);
        if (existing) {
          if (existing.operationId !== input.operationId || existing.requestFingerprint !== requestFingerprint)
            throw new Error('Vault operation ID is already used by different content.');
          return { status: 'unchanged' as const, completion: existing };
        }
        const session = await transaction.getRestoreSession();
        if (!session || session.restoreId !== input.restoreId) throw new Error('Encrypted backup restore session is unavailable.');
        if (session.nextChunkIndex !== session.chunkCount) throw new Error('Encrypted backup restore is incomplete.');
        if (session.committedRecordCount !== session.recordCount) throw new Error('Encrypted backup restore record count is incomplete.');
        const completion = {
          formatVersion: 1 as const,
          restoreId: input.restoreId,
          operationId: input.operationId,
          requestFingerprint,
          backupFingerprint: session.backupFingerprint,
          chunkCount: session.chunkCount,
          recordCount: session.recordCount,
          completedAtMs: now(),
        };
        await transaction.createRestoreCompletion(completion);
        await transaction.deleteRestoreSession();
        return { status: 'completed' as const, completion };
      });
    },

  };
}

function assertRestoreId(restoreId: string): void {
  if (!OPERATION_ID.test(restoreId)) throw new Error('Vault restore ID is invalid.');
}

function assertRestoreCounts(chunkCount: number, recordCount: number): void {
  if (!Number.isSafeInteger(chunkCount) || chunkCount < 1 || chunkCount > 100_000)
    throw new Error('Vault restore chunk count is invalid.');
  if (!Number.isSafeInteger(recordCount) || recordCount < 1 || recordCount > 100_000)
    throw new Error('Vault restore record count is invalid.');
}

export type PrivateProVaultService = ReturnType<typeof createPrivateProVaultService>;
