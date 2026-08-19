import { TRPCError } from '@trpc/server';
import * as z from 'zod/v4';

import { createTRPCRouter } from '~/server/trpc/trpc.server';

import { privateProNodePremiumProcedure } from '../auth/privatePro.auth.procedures.server';
import {
  PRIVATE_PRO_VAULT_FIRESTORE_MAX_CIPHERTEXT_BYTES,
  PRIVATE_PRO_VAULT_BACKUP_MAX_CHUNKS,
  PRIVATE_PRO_VAULT_BACKUP_MAX_RECORDS,
  PRIVATE_PRO_VAULT_MAX_INDEX_PAGE_SIZE,
  PRIVATE_PRO_VAULT_RESTORE_MAX_RECORDS,
  PRIVATE_PRO_VAULT_RESTORE_MAX_TOTAL_CIPHERTEXT_BYTES,
} from './privatePro.vault.repository';
import { getFirebasePrivateProVaultService } from './privatePro.vault.repository.firebase';
import {
  PrivateProVaultEnvelopeSchema,
  PrivateProVaultKeysetSchema,
  PrivateProVaultTombstoneSchema,
} from './privatePro.vault.schemas';
import type { PrivateProVaultService } from './privatePro.vault.service';


const opaqueIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const operationIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const baseVersionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const firestoreEnvelopeSchema = PrivateProVaultEnvelopeSchema.refine(
  envelope => envelope.ciphertextBytes <= PRIVATE_PRO_VAULT_FIRESTORE_MAX_CIPHERTEXT_BYTES,
  'Vault record ciphertext exceeds the server limit.',
);

async function vaultCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Encrypted vault operation failed.' });
  }
}

export function createPrivateProVaultRouter(
  procedure: typeof privateProNodePremiumProcedure = privateProNodePremiumProcedure,
  serviceFactory: () => PrivateProVaultService = getFirebasePrivateProVaultService,
) {
  const service = () => serviceFactory();
  return createTRPCRouter({
  bootstrap: procedure
    .input(z.object({ deviceId: opaqueIdSchema }).strict())
    .mutation(({ ctx, input }) => vaultCall(() => service().bootstrap(ctx.privateProIdentity.uid, input.deviceId))),

  listDevices: procedure.query(({ ctx }) => vaultCall(() => service().listDevices(ctx.privateProIdentity.uid))),

  beginDeviceRegistration: procedure
    .input(z.object({
      deviceId: opaqueIdSchema,
      keyVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    }).strict())
    .mutation(({ ctx, input }) => vaultCall(() => service().beginDeviceRegistration(ctx.privateProIdentity.uid, input))),

  completeDeviceRegistration: procedure
    .input(z.object({
      operationId: operationIdSchema,
      formatVersion: z.literal(1),
      deviceId: opaqueIdSchema,
      keyVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      challengeId: opaqueIdSchema,
      challengeBase64: z.string().min(44).max(44),
      expiresAtMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      signatureBase64: z.string().min(1).max(256),
    }).strict())
    .mutation(({ ctx, input }) => vaultCall(() => service().completeDeviceRegistration(ctx.privateProIdentity.uid, input))),

  getIndex: procedure
    .input(z.object({
      pageSize: z.number().int().min(1).max(PRIVATE_PRO_VAULT_MAX_INDEX_PAGE_SIZE),
      cursor: opaqueIdSchema.nullish(),
    }).strict())
    .query(({ ctx, input }) => vaultCall(() => service().getIndex(ctx.privateProIdentity.uid, input))),

  getRecords: procedure
    .input(z.object({
      opaqueRecordIds: z.array(opaqueIdSchema).min(1).max(PRIVATE_PRO_VAULT_MAX_INDEX_PAGE_SIZE),
    }).strict())
    .query(({ ctx, input }) => vaultCall(() => service().getRecords(ctx.privateProIdentity.uid, input.opaqueRecordIds))),

  putRecord: procedure
    .input(z.object({
      operationId: operationIdSchema,
      opaqueRecordId: opaqueIdSchema,
      baseRevision: baseVersionSchema,
      envelope: firestoreEnvelopeSchema,
    }).strict())
    .mutation(({ ctx, input }) => vaultCall(() => service().putRecord(ctx.privateProIdentity.uid, input))),

  mergeBackup: procedure
    .input(z.object({
      operationId: operationIdSchema,
      records: z.array(z.object({
        opaqueRecordId: opaqueIdSchema,
        baseRevision: baseVersionSchema,
        envelope: firestoreEnvelopeSchema,
      }).strict()).min(1).max(PRIVATE_PRO_VAULT_BACKUP_MAX_RECORDS),
    }).strict())
    .mutation(({ ctx, input }) => vaultCall(() => service().mergeBackup(ctx.privateProIdentity.uid, input))),

  beginBackupRestore: procedure
    .input(z.object({
      restoreId: operationIdSchema,
      backupFingerprint: opaqueIdSchema,
      backupRecordCount: z.number().int().min(0).max(PRIVATE_PRO_VAULT_RESTORE_MAX_RECORDS),
      backupTotalCiphertextBytes: z.number().int().min(0).max(PRIVATE_PRO_VAULT_RESTORE_MAX_TOTAL_CIPHERTEXT_BYTES),
      chunkCount: z.number().int().min(0).max(PRIVATE_PRO_VAULT_BACKUP_MAX_CHUNKS),
      recordCount: z.number().int().min(0).max(PRIVATE_PRO_VAULT_RESTORE_MAX_RECORDS),
      chunkRecordCounts: z.array(z.number().int().min(1).max(PRIVATE_PRO_VAULT_BACKUP_MAX_RECORDS)).max(PRIVATE_PRO_VAULT_BACKUP_MAX_CHUNKS),
      chunkFingerprints: z.array(opaqueIdSchema).max(PRIVATE_PRO_VAULT_BACKUP_MAX_CHUNKS),
      totalCiphertextBytes: z.number().int().min(0).max(PRIVATE_PRO_VAULT_RESTORE_MAX_TOTAL_CIPHERTEXT_BYTES),
    }).strict())
    .mutation(({ ctx, input }) => vaultCall(() => service().beginBackupRestore(ctx.privateProIdentity.uid, input))),

  getBackupRestoreStatus: procedure
    .input(z.object({ restoreId: operationIdSchema }).strict())
    .query(({ ctx, input }) => vaultCall(() => service().getBackupRestoreStatus(ctx.privateProIdentity.uid, input.restoreId))),

  mergeBackupRestoreChunk: procedure
    .input(z.object({
      restoreId: operationIdSchema,
      operationId: operationIdSchema,
      chunkIndex: z.number().int().min(0).max(PRIVATE_PRO_VAULT_BACKUP_MAX_CHUNKS - 1),
      chunkFingerprint: opaqueIdSchema,
      records: z.array(z.object({
        opaqueRecordId: opaqueIdSchema,
        baseRevision: baseVersionSchema,
        envelope: firestoreEnvelopeSchema,
      }).strict()).min(1).max(PRIVATE_PRO_VAULT_BACKUP_MAX_RECORDS),
    }).strict())
    .mutation(({ ctx, input }) => vaultCall(() => service().mergeBackupRestoreChunk(ctx.privateProIdentity.uid, input))),

  getBackupRestoreIndex: procedure
    .input(z.object({
      restoreId: operationIdSchema,
      pageSize: z.number().int().min(1).max(PRIVATE_PRO_VAULT_MAX_INDEX_PAGE_SIZE),
      cursor: opaqueIdSchema.nullish(),
    }).strict())
    .query(({ ctx, input }) => vaultCall(() => service().getBackupRestoreIndex(ctx.privateProIdentity.uid, input.restoreId, input))),

  getBackupRestoreRecords: procedure
    .input(z.object({
      restoreId: operationIdSchema,
      opaqueRecordIds: z.array(opaqueIdSchema).min(1).max(PRIVATE_PRO_VAULT_MAX_INDEX_PAGE_SIZE),
    }).strict())
    .query(({ ctx, input }) => vaultCall(() => service().getBackupRestoreRecords(ctx.privateProIdentity.uid, input.restoreId, input.opaqueRecordIds))),

  sealBackupRestore: procedure
    .input(z.object({ restoreId: operationIdSchema, operationId: operationIdSchema }).strict())
    .mutation(({ ctx, input }) => vaultCall(() => service().sealBackupRestore(ctx.privateProIdentity.uid, input))),

  confirmBackupRestoreVerified: procedure
    .input(z.object({ restoreId: operationIdSchema, operationId: operationIdSchema, sessionFingerprint: opaqueIdSchema }).strict())
    .mutation(({ ctx, input }) => vaultCall(() => service().confirmBackupRestoreVerified(ctx.privateProIdentity.uid, input))),

  deleteRecord: procedure
    .input(z.object({
      operationId: operationIdSchema,
      opaqueRecordId: opaqueIdSchema,
      baseRevision: baseVersionSchema,
      tombstone: PrivateProVaultTombstoneSchema,
    }).strict())
    .mutation(({ ctx, input }) => vaultCall(() => service().deleteRecord(ctx.privateProIdentity.uid, input))),

  putKeyset: procedure
    .input(z.object({
      operationId: operationIdSchema,
      baseWrappingVersion: baseVersionSchema,
      keyset: PrivateProVaultKeysetSchema,
      securityEvent: z.object({
        eventId: opaqueIdSchema,
        deviceId: opaqueIdSchema,
        type: z.enum(['recovery-password-reset', 'password-changed']),
      }).strict().optional(),
    }).strict())
    .mutation(({ ctx, input }) => vaultCall(() => service().putKeyset(ctx.privateProIdentity.uid, input))),

  revokeDevice: procedure
    .input(z.object({ operationId: operationIdSchema, deviceId: opaqueIdSchema }).strict())
    .mutation(({ ctx, input }) => vaultCall(() => service().revokeDevice(ctx.privateProIdentity.uid, input))),

});
}

export const privateProVaultRouter = createPrivateProVaultRouter();
