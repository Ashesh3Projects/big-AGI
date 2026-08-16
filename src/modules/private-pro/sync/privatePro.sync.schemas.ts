import * as z from 'zod/v4';


export const SyncJsonValueSchema = z.json();

export const SyncMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant', 'system']),
  fragments: z.array(SyncJsonValueSchema),
  purposeId: z.string().optional(),
  metadata: SyncJsonValueSchema.optional(),
  generator: SyncJsonValueSchema.optional(),
  userFlags: z.array(z.string()).optional(),
  tokenCount: z.number(),
  created: z.number(),
  updated: z.number().nullable(),
});

export const SyncConversationSchema = z.object({
  schemaVersion: z.literal(1),
  conversation: z.object({
    id: z.string().min(1),
    messages: z.array(SyncMessageSchema),
    userTitle: z.string().optional(),
    autoTitle: z.string().optional(),
    isArchived: z.boolean().optional(),
    userSymbol: z.string().optional(),
    systemPurposeId: z.string().min(1),
    tokenCount: z.number(),
    created: z.number(),
    updated: z.number().nullable(),
  }),
});

export const SyncPersonaSchema = z.object({
  schemaVersion: z.literal(1),
  persona: z.object({
    id: z.string().min(1),
    name: z.string().optional(),
    systemPrompt: z.string(),
    creationDate: z.string(),
    pictureUrl: z.string().optional(),
    inputProvenance: z.discriminatedUnion('type', [
      z.object({
        type: z.literal('youtube'),
        url: z.string(),
        title: z.string().optional(),
        thumbnailUrl: z.string().optional(),
      }),
      z.object({ type: z.literal('text') }),
    ]).optional(),
    inputText: z.string(),
    llmLabel: z.string().optional(),
  }),
});

export const SyncChunkSchema = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  byteLength: z.number().int().nonnegative(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  payloadBase64: z.string(),
});

export type SyncConversation = z.infer<typeof SyncConversationSchema>;
export type SyncPersona = z.infer<typeof SyncPersonaSchema>;
export type SyncChunk = z.infer<typeof SyncChunkSchema>;
