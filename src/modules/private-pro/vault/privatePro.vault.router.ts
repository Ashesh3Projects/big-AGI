import { TRPCError } from '@trpc/server';
import * as z from 'zod/v4';

import { createTRPCRouter } from '~/server/trpc/trpc.server';

import { privateProNodePremiumProcedure } from '../auth/privatePro.auth.procedures.server';
import {
  PRIVATE_PRO_VAULT_FIRESTORE_MAX_CIPHERTEXT_BYTES,
  PRIVATE_PRO_VAULT_MAX_INDEX_PAGE_SIZE,
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
const migrationValueSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
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
      baseKeyVersion: baseVersionSchema,
      keyset: PrivateProVaultKeysetSchema,
    }).strict())
    .mutation(({ ctx, input }) => vaultCall(() => service().putKeyset(ctx.privateProIdentity.uid, input))),

  commitMigration: procedure
    .input(z.object({
      operationId: operationIdSchema,
      migrationId: migrationValueSchema,
      basePhase: migrationValueSchema.nullable(),
      phase: migrationValueSchema,
    }).strict())
    .mutation(({ ctx, input }) => vaultCall(() => service().commitMigration(ctx.privateProIdentity.uid, input))),

  revokeDevice: procedure
    .input(z.object({ operationId: operationIdSchema, deviceId: opaqueIdSchema }).strict())
    .mutation(({ ctx, input }) => vaultCall(() => service().revokeDevice(ctx.privateProIdentity.uid, input))),
});
}

export const privateProVaultRouter = createPrivateProVaultRouter();
