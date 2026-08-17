import { TRPCError } from '@trpc/server';
import * as z from 'zod/v4';

import { createTRPCRouter } from '~/server/trpc/trpc.server';

import { createPrivateProVaultProcedure, createPrivateProVaultPutKeysetProcedure, privateProNodePremiumProcedure } from '../auth/privatePro.auth.procedures.server';
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
  const accessDependencies = {
    async getVaultAccess(uid, deviceId) {
      const [keyset, devices] = await Promise.all([service().getKeyset(uid), service().listDevices(uid)]);
      return { keyset: keyset?.keyset ?? null, device: devices.find(device => device.deviceId === deviceId) ?? null };
    },
  } satisfies Parameters<typeof createPrivateProVaultProcedure>[1];
  const deviceProcedure = createPrivateProVaultProcedure(procedure, accessDependencies);
  const putKeysetProcedure = createPrivateProVaultPutKeysetProcedure(procedure, accessDependencies);
  return createTRPCRouter({
  bootstrap: procedure
    .input(z.object({ deviceId: opaqueIdSchema }).strict())
    .mutation(({ ctx, input }) => vaultCall(() => service().bootstrap(ctx.privateProIdentity.uid, input.deviceId))),

  listDevices: deviceProcedure.query(({ ctx }) => vaultCall(() => service().listDevices(ctx.privateProIdentity.uid))),

  getIndex: deviceProcedure
    .input(z.object({
      pageSize: z.number().int().min(1).max(PRIVATE_PRO_VAULT_MAX_INDEX_PAGE_SIZE),
      cursor: opaqueIdSchema.nullish(),
    }).strict())
    .query(({ ctx, input }) => vaultCall(() => service().getIndex(ctx.privateProIdentity.uid, input))),

  getRecords: deviceProcedure
    .input(z.object({
      opaqueRecordIds: z.array(opaqueIdSchema).min(1).max(PRIVATE_PRO_VAULT_MAX_INDEX_PAGE_SIZE),
    }).strict())
    .query(({ ctx, input }) => vaultCall(() => service().getRecords(ctx.privateProIdentity.uid, input.opaqueRecordIds))),

  putRecord: deviceProcedure
    .input(z.object({
      operationId: operationIdSchema,
      opaqueRecordId: opaqueIdSchema,
      baseRevision: baseVersionSchema,
      envelope: firestoreEnvelopeSchema,
    }).strict())
    .mutation(({ ctx, input }) => vaultCall(() => service().putRecord(ctx.privateProIdentity.uid, input))),

  deleteRecord: deviceProcedure
    .input(z.object({
      operationId: operationIdSchema,
      opaqueRecordId: opaqueIdSchema,
      baseRevision: baseVersionSchema,
      tombstone: PrivateProVaultTombstoneSchema,
    }).strict())
    .mutation(({ ctx, input }) => vaultCall(() => service().deleteRecord(ctx.privateProIdentity.uid, input))),

  putKeyset: putKeysetProcedure
    .input(z.object({
      operationId: operationIdSchema,
      baseWrappingVersion: baseVersionSchema,
      keyset: PrivateProVaultKeysetSchema,
    }).strict())
    .mutation(async ({ ctx, input }) => vaultCall(async () => {
      const result = await service().putKeyset(ctx.privateProIdentity.uid, input);
      if (input.baseWrappingVersion === 0) {
        const deviceId = ctx.privateProDeviceId;
        if (!deviceId || !/^[A-Za-z0-9_-]{43}$/.test(deviceId))
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Private Pro vault device is not authorized.' });
        await service().bootstrap(ctx.privateProIdentity.uid, deviceId);
      }
      return result;
    })),

  commitMigration: deviceProcedure
    .input(z.object({
      operationId: operationIdSchema,
      migrationId: migrationValueSchema,
      basePhase: migrationValueSchema.nullable(),
      phase: migrationValueSchema,
    }).strict())
    .mutation(({ ctx, input }) => vaultCall(() => service().commitMigration(ctx.privateProIdentity.uid, input))),

  revokeDevice: deviceProcedure
    .input(z.object({ operationId: operationIdSchema, deviceId: opaqueIdSchema }).strict())
    .mutation(({ ctx, input }) => vaultCall(() => service().revokeDevice(ctx.privateProIdentity.uid, input))),
});
}

export const privateProVaultRouter = createPrivateProVaultRouter();
