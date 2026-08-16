import * as z from 'zod/v4';

import { createTRPCRouter } from '~/server/trpc/trpc.server';

import { privateProNodePremiumProcedure } from '../auth/privatePro.auth.procedures.server';
import { getPrivateProServerConfig } from '../config/privatePro.config.server';
import { FirebasePrivateProAssetsPort } from './privatePro.assets.firebase';
import { createPrivateProAssetsService } from './privatePro.assets.service';


const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z.string().min(1).max(200);

let service: ReturnType<typeof createPrivateProAssetsService> | undefined;
function assetsService() {
  return service ??= createPrivateProAssetsService(new FirebasePrivateProAssetsPort());
}

const metadataSchema = z.object({
  assetType: z.string().min(1).max(40),
  label: z.string().max(500),
  origin: z.json(),
  metadata: z.json(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const privateProAssetsRouter = createTRPCRouter({
  reserveUpload: privateProNodePremiumProcedure
    .input(z.object({
      operationId: z.string().min(8).max(160),
      assetId: idSchema,
      contentHash: sha256Schema,
      contentType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'audio/mpeg', 'audio/wav']),
      requestedBytes: z.number().int().positive(),
      metadata: metadataSchema,
    }))
    .mutation(({ ctx, input }) => {
      const config = getPrivateProServerConfig();
      if (input.requestedBytes > config.maxFileBytes) throw new Error('Attachment exceeds the configured file-size limit.');
      return assetsService().reserveUpload(ctx.privateProIdentity.uid, input);
    }),

  finalizeUpload: privateProNodePremiumProcedure
    .input(z.object({ operationId: z.string().min(8).max(160) }))
    .mutation(({ ctx, input }) => assetsService().finalizeUpload(ctx.privateProIdentity.uid, input.operationId)),

  getDownload: privateProNodePremiumProcedure
    .input(z.object({ assetId: idSchema }))
    .query(({ ctx, input }) => assetsService().getDownload(ctx.privateProIdentity.uid, input.assetId)),

  releaseExpired: privateProNodePremiumProcedure
    .input(z.object({ operationId: z.string().min(8).max(160) }))
    .mutation(({ ctx, input }) => assetsService().releaseExpiredReservation(ctx.privateProIdentity.uid, input.operationId)),

  releaseReservation: privateProNodePremiumProcedure
    .input(z.object({ operationId: z.string().min(8).max(160) }))
    .mutation(({ ctx, input }) => assetsService().releaseReservation(ctx.privateProIdentity.uid, input.operationId)),
});
