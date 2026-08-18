import * as z from 'zod/v4';

import { createTRPCRouter } from '~/server/trpc/trpc.server';

import { privateProNodePremiumProcedure } from '../auth/privatePro.auth.procedures.server';
import { FirebasePrivateProSyncRepository } from './privatePro.sync.repository.firebase';
import { createPrivateProSyncService } from './privatePro.sync.service';
import { SyncChunkSchema, SyncPersonaSchema } from './privatePro.sync.schemas';


const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const operationIdSchema = z.string().min(8).max(160);
const entityIdSchema = z.string().min(1).max(200);
const deviceIdSchema = z.string().min(1).max(100);
const baseRevisionSchema = z.number().int().nonnegative();

let service: ReturnType<typeof createPrivateProSyncService> | undefined;

function privateProSyncService() {
  return service ??= createPrivateProSyncService(new FirebasePrivateProSyncRepository());
}

export const privateProSyncRouter = createTRPCRouter({
  prepareChat: privateProNodePremiumProcedure
    .input(z.object({
      operationId: operationIdSchema,
      chatId: entityIdSchema,
      baseRevision: baseRevisionSchema,
      contentHash: sha256Schema,
      chunks: z.array(z.object({
        id: z.string().min(1).max(40),
        index: z.number().int().nonnegative(),
        byteLength: z.number().int().nonnegative().max(256 * 1024),
        hash: sha256Schema,
      })).min(1).max(400),
      deviceId: deviceIdSchema,
    }))
    .mutation(({ ctx, input }) => privateProSyncService().prepareChat(ctx.privateProIdentity, input)),

  putChatChunk: privateProNodePremiumProcedure
    .input(z.object({ operationId: operationIdSchema, chunk: SyncChunkSchema }))
    .mutation(({ ctx, input }) => privateProSyncService().putChatChunk(ctx.privateProIdentity, input)),

  commitChat: privateProNodePremiumProcedure
    .input(z.object({ operationId: operationIdSchema }))
    .mutation(({ ctx, input }) => privateProSyncService().commitChat(ctx.privateProIdentity, input)),

  deleteChat: privateProNodePremiumProcedure
    .input(z.object({
      operationId: operationIdSchema,
      entityId: entityIdSchema,
      baseRevision: baseRevisionSchema,
      deviceId: deviceIdSchema,
    }))
    .mutation(({ ctx, input }) => privateProSyncService().deleteChat(ctx.privateProIdentity, input)),

  putPersona: privateProNodePremiumProcedure
    .input(z.object({
      personaId: entityIdSchema,
      baseRevision: baseRevisionSchema,
      contentHash: sha256Schema,
      payload: SyncPersonaSchema,
      deviceId: deviceIdSchema,
    }))
    .mutation(({ ctx, input }) => privateProSyncService().putPersona(ctx.privateProIdentity, input)),

  deletePersona: privateProNodePremiumProcedure
    .input(z.object({
      operationId: operationIdSchema,
      entityId: entityIdSchema,
      baseRevision: baseRevisionSchema,
      deviceId: deviceIdSchema,
    }))
    .mutation(({ ctx, input }) => privateProSyncService().deletePersona(ctx.privateProIdentity, input)),

  cleanupMigratedEntity: privateProNodePremiumProcedure
    .input(z.object({
      operationId: operationIdSchema,
      entityType: z.enum(['chat', 'persona']),
      entityId: entityIdSchema,
      sourceVersion: z.string().regex(/^\d+:[a-f0-9]{64}$/),
    }).strict())
    .mutation(({ ctx, input }) => privateProSyncService().cleanupMigratedEntity(ctx.privateProIdentity, input)),
});
