import { createHash } from 'node:crypto';

import {
  PRIVATE_PRO_VAULT_FIRESTORE_MAX_CIPHERTEXT_BYTES,
  PRIVATE_PRO_VAULT_MAX_INDEX_PAGE_SIZE,
  type PrivateProVaultMigrationPhase,
  type PrivateProVaultOperationOutcome,
  type PrivateProVaultRepository,
} from './privatePro.vault.repository';
import {
  PrivateProVaultEnvelopeSchema,
  PrivateProVaultKeysetSchema,
  PrivateProVaultTombstoneSchema,
} from './privatePro.vault.schemas';
import type { PrivateProVaultEnvelope, PrivateProVaultKeyset, PrivateProVaultTombstone } from './privatePro.vault.types';


const OPAQUE_RECORD_ID = /^[A-Za-z0-9_-]{43}$/;
const OPERATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MIGRATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

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
}

export type PutVaultKeysetResult =
  | { status: 'committed'; wrappingVersion: number; serverUpdatedAtMs: number }
  | { status: 'unchanged'; wrappingVersion: number; serverUpdatedAtMs: number }
  | { status: 'conflict'; currentWrappingVersion: number };

export interface CommitVaultMigrationInput {
  operationId: string;
  migrationId: string;
  basePhase: PrivateProVaultMigrationPhase | null;
  phase: PrivateProVaultMigrationPhase;
}

export interface RevokeVaultDeviceInput {
  operationId: string;
  deviceId: string;
}

export interface RegisterVaultDeviceInput {
  deviceId: string;
  keyVersion: number;
}

export type CommitVaultMigrationResult =
  | { status: 'committed'; phase: PrivateProVaultMigrationPhase; serverUpdatedAtMs: number }
  | { status: 'unchanged'; phase: PrivateProVaultMigrationPhase; serverUpdatedAtMs: number }
  | { status: 'conflict'; currentPhase: PrivateProVaultMigrationPhase | null };

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
    case 'migration':
      return outcome.status === 'committed'
        ? { status: 'unchanged' as const, phase: outcome.phase, serverUpdatedAtMs: outcome.serverUpdatedAtMs }
        : { status: 'conflict' as const, currentPhase: outcome.currentPhase };
    case 'device':
      return { status: 'unchanged' as const, revokedAtMs: outcome.revokedAtMs };
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

export function createPrivateProVaultService(repository: PrivateProVaultRepository, now: () => number = Date.now) {
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

    async registerDevice(uid: string, input: RegisterVaultDeviceInput) {
      assertUid(uid);
      assertOpaqueRecordId(input.deviceId, 'device ID');
      if (!Number.isSafeInteger(input.keyVersion) || input.keyVersion <= 0) throw new Error('Vault device key version is invalid.');
      return repository.transaction(uid, async transaction => {
        const [storedKeyset, existing] = await Promise.all([transaction.getKeyset(), transaction.getDevice(input.deviceId)]);
        if (!storedKeyset || storedKeyset.keyVersion !== input.keyVersion) throw new Error('Vault device key version is stale.');
        if (existing?.revokedAtMs !== null && existing?.revokedAtMs !== undefined) throw new Error('Vault device is revoked.');
        if (existing) return { status: 'registered' as const, device: existing };
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
      const entries = await repository.listIndexEntries(uid, cursor, input.pageSize + 1);
      const hasMore = entries.length > input.pageSize;
      const page = entries.slice(0, input.pageSize);
      return { entries: page, nextCursor: hasMore ? page.at(-1)?.opaqueRecordId ?? null : null };
    },

    async getRecords(uid: string, opaqueRecordIds: readonly string[]) {
      assertUid(uid);
      if (opaqueRecordIds.length > PRIVATE_PRO_VAULT_MAX_INDEX_PAGE_SIZE) throw new Error('Too many vault records requested.');
      opaqueRecordIds.forEach(recordId => assertOpaqueRecordId(recordId));
      return repository.getRecords(uid, opaqueRecordIds);
    },

    async putKeyset(uid: string, input: PutVaultKeysetInput): Promise<PutVaultKeysetResult> {
      assertUid(uid);
      assertOperationId(input.operationId);
      if (!Number.isSafeInteger(input.baseWrappingVersion) || input.baseWrappingVersion < 0) throw new Error('Vault base wrapping version is invalid.');
      const keyset = PrivateProVaultKeysetSchema.parse(input.keyset);
      if (keyset.wrappingVersion !== input.baseWrappingVersion + 1) throw new Error('Vault wrapping version must follow the base wrapping version.');
      const requestFingerprint = fingerprint({ kind: 'put-keyset', ...input, keyset });

      return repository.transaction(uid, async transaction => {
        const repeated = await existingOperation(transaction, input.operationId, requestFingerprint);
        if (repeated) return repeated as PutVaultKeysetResult;
        const current = await transaction.getKeyset();
        const currentWrappingVersion = current?.wrappingVersion ?? 0;
        if (currentWrappingVersion !== input.baseWrappingVersion) {
          const outcome = { kind: 'keyset', status: 'conflict', currentWrappingVersion } as const;
          await transaction.createOperation({ operationId: input.operationId, requestFingerprint, outcome });
          return { status: 'conflict', currentWrappingVersion };
        }
        if (current && current.keyVersion !== keyset.keyVersion) throw new Error('Vault master key version cannot change during wrapping rotation.');
        const serverUpdatedAtMs = now();
        await transaction.setKeyset({ keyVersion: keyset.keyVersion, wrappingVersion: keyset.wrappingVersion, serverUpdatedAtMs, keyset: structuredClone(keyset) });
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

    async commitMigration(uid: string, input: CommitVaultMigrationInput): Promise<CommitVaultMigrationResult> {
      assertUid(uid);
      assertOperationId(input.operationId);
      if (!MIGRATION_ID.test(input.migrationId) || !input.phase || input.phase.length > 128)
        throw new Error('Vault migration input is invalid.');
      const requestFingerprint = fingerprint({ kind: 'migration', ...input });

      return repository.transaction(uid, async transaction => {
        const repeated = await existingOperation(transaction, input.operationId, requestFingerprint);
        if (repeated) return repeated as CommitVaultMigrationResult;
        const current = await transaction.getMigration(input.migrationId);
        const currentPhase = current?.phase ?? null;
        if (currentPhase !== input.basePhase) {
          const outcome = { kind: 'migration', status: 'conflict', currentPhase } as const;
          await transaction.createOperation({ operationId: input.operationId, requestFingerprint, outcome });
          return { status: 'conflict', currentPhase };
        }
        const serverUpdatedAtMs = now();
        await transaction.setMigration({ migrationId: input.migrationId, phase: input.phase, serverUpdatedAtMs });
        const outcome = { kind: 'migration', status: 'committed', phase: input.phase, serverUpdatedAtMs } as const;
        await transaction.createOperation({ operationId: input.operationId, requestFingerprint, outcome });
        return { status: 'committed', phase: input.phase, serverUpdatedAtMs };
      });
    },

    async getMigration(uid: string, migrationId: string) {
      assertUid(uid);
      if (!MIGRATION_ID.test(migrationId)) throw new Error('Vault migration ID is invalid.');
      return repository.transaction(uid, transaction => transaction.getMigration(migrationId));
    },
  };
}

export type PrivateProVaultService = ReturnType<typeof createPrivateProVaultService>;
