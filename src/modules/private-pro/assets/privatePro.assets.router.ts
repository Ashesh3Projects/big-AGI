import * as z from 'zod/v4';
import { TRPCError } from '@trpc/server';

import { createTRPCRouter } from '~/server/trpc/trpc.server';

import { privateProNodePremiumProcedure } from '../auth/privatePro.auth.procedures.server';
import { getFirebasePrivateProVaultAssetsService } from '../vault/privatePro.vault.assets.firebase';
import { PrivateProVaultAssetRateLimitError } from '../vault/privatePro.vault.assets.service';


const opaqueIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const operationIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{8,160}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const encryptedChunkSchema = z.object({
  opaqueChunkId: opaqueIdSchema,
  chunkIndex: z.number().int().nonnegative().max(31),
  ciphertextBytes: z.number().int().positive().max(4 * 1024 * 1024),
  objectBytes: z.number().int().positive().max(4 * 1024 * 1024 + 12),
  objectSha256: sha256Schema,
}).strict();

export function createPrivateProVaultAssetsRouter(
  procedure: typeof privateProNodePremiumProcedure = privateProNodePremiumProcedure,
  serviceFactory = getFirebasePrivateProVaultAssetsService,
) {
  const removedProcedure = procedure.use(() => {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Private Pro legacy endpoint is unavailable.' });
  });
  const service = () => serviceFactory();
  return createTRPCRouter({
  reserveEncryptedUpload: removedProcedure
    .input(z.object({ operationId: operationIdSchema, opaqueAssetId: opaqueIdSchema, chunks: z.array(encryptedChunkSchema).min(1).max(32) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await service().reserveUpload(ctx.privateProIdentity.uid, input);
      } catch (error) {
        if (error instanceof PrivateProVaultAssetRateLimitError)
          throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: error.message });
        throw error;
      }
    }),
  finalizeEncryptedUpload: removedProcedure.input(z.object({ operationId: operationIdSchema }).strict())
    .mutation(({ ctx, input }) => service().finalizeUpload(ctx.privateProIdentity.uid, input.operationId)),
  getEncryptedDownload: removedProcedure.input(z.object({ opaqueAssetId: opaqueIdSchema }).strict())
    .query(({ ctx, input }) => service().getDownload(ctx.privateProIdentity.uid, input.opaqueAssetId)),
  releaseEncryptedReservation: removedProcedure.input(z.object({ operationId: operationIdSchema }).strict())
    .mutation(({ ctx, input }) => service().releaseReservation(ctx.privateProIdentity.uid, input.operationId)),
});
}

export const privateProVaultAssetsRouter = createPrivateProVaultAssetsRouter();
