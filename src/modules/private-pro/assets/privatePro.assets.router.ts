import * as z from 'zod/v4';
import { TRPCError } from '@trpc/server';

import { createTRPCRouter } from '~/server/trpc/trpc.server';

import { privateProNodePremiumProcedure } from '../auth/privatePro.auth.procedures.server';
import { createPrivateProVaultProcedure } from '../auth/privatePro.auth.procedures.server';
import { getPrivateProServerConfig } from '../config/privatePro.config.server';
import { getFirebasePrivateProVaultService } from '../vault/privatePro.vault.repository.firebase';
import { getFirebasePrivateProVaultAssetsService } from '../vault/privatePro.vault.assets.firebase';
import { PrivateProVaultAssetRateLimitError } from '../vault/privatePro.vault.assets.service';

import { getFirebasePrivateProAssetsService } from './privatePro.assets.firebase';
import { PrivateProUploadRateLimitError } from './privatePro.assets.service';


const idSchema = z.string().min(1).max(200);

const metadataSchema = z.object({
  assetType: z.string().min(1).max(40),
  label: z.string().max(500),
  origin: z.json(),
  metadata: z.json(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

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

const vaultService = () => getFirebasePrivateProVaultService();
const vaultProcedure = createPrivateProVaultProcedure(privateProNodePremiumProcedure, {
  async getVaultAccess(uid, deviceId) {
    const [keyset, devices] = await Promise.all([vaultService().getKeyset(uid), vaultService().listDevices(uid)]);
    return { keyset: keyset?.keyset ?? null, device: devices.find(device => device.deviceId === deviceId) ?? null };
  },
});

export const privateProAssetsRouter = createTRPCRouter({
  reserveEncryptedUpload: vaultProcedure
    .input(z.object({
      operationId: operationIdSchema,
      opaqueAssetId: opaqueIdSchema,
      chunks: z.array(encryptedChunkSchema).min(1).max(32),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await getFirebasePrivateProVaultAssetsService().reserveUpload(ctx.privateProIdentity.uid, input);
      } catch (error) {
        if (error instanceof PrivateProVaultAssetRateLimitError)
          throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: error.message });
        throw error;
      }
    }),

  finalizeEncryptedUpload: vaultProcedure
    .input(z.object({ operationId: operationIdSchema }).strict())
    .mutation(({ ctx, input }) => getFirebasePrivateProVaultAssetsService().finalizeUpload(ctx.privateProIdentity.uid, input.operationId)),

  getEncryptedDownload: vaultProcedure
    .input(z.object({ opaqueAssetId: opaqueIdSchema }).strict())
    .query(({ ctx, input }) => getFirebasePrivateProVaultAssetsService().getDownload(ctx.privateProIdentity.uid, input.opaqueAssetId)),

  releaseEncryptedReservation: vaultProcedure
    .input(z.object({ operationId: operationIdSchema }).strict())
    .mutation(({ ctx, input }) => getFirebasePrivateProVaultAssetsService().releaseReservation(ctx.privateProIdentity.uid, input.operationId)),

  reserveUpload: privateProNodePremiumProcedure
    .input(z.object({
      operationId: z.string().min(8).max(160),
      assetId: idSchema,
      contentHash: sha256Schema,
      contentType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'audio/mpeg', 'audio/wav']),
      requestedBytes: z.number().int().positive(),
      metadata: metadataSchema,
    }))
    .mutation(async ({ ctx, input }) => {
      const config = getPrivateProServerConfig();
      if (input.requestedBytes > config.maxFileBytes) throw new Error('Attachment exceeds the configured file-size limit.');
      try {
        return await getFirebasePrivateProAssetsService().reserveUpload(ctx.privateProIdentity.uid, input);
      } catch (error) {
        if (error instanceof PrivateProUploadRateLimitError)
          throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: error.message });
        throw error;
      }
    }),

  finalizeUpload: privateProNodePremiumProcedure
    .input(z.object({ operationId: z.string().min(8).max(160) }))
    .mutation(({ ctx, input }) => getFirebasePrivateProAssetsService().finalizeUpload(ctx.privateProIdentity.uid, input.operationId)),

  getDownload: privateProNodePremiumProcedure
    .input(z.object({ assetId: idSchema }))
    .query(({ ctx, input }) => getFirebasePrivateProAssetsService().getDownload(ctx.privateProIdentity.uid, input.assetId)),

  releaseExpired: privateProNodePremiumProcedure
    .input(z.object({ operationId: z.string().min(8).max(160) }))
    .mutation(({ ctx, input }) => getFirebasePrivateProAssetsService().releaseExpiredReservation(ctx.privateProIdentity.uid, input.operationId)),

  releaseReservation: privateProNodePremiumProcedure
    .input(z.object({ operationId: z.string().min(8).max(160) }))
    .mutation(({ ctx, input }) => getFirebasePrivateProAssetsService().releaseReservation(ctx.privateProIdentity.uid, input.operationId)),

});
