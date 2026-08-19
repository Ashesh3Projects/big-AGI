import * as z from 'zod/v4';


const PrivateProSyncLogicalIdSchema = z.string().min(1).max(512);
const PrivateProSyncContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const PrivateProSyncRecordKeySchema = z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/);

export const PrivateProSyncRecordTypeSchema = z.enum([
  'credential-service',
  'model-service',
  'settings',
  'persona',
  'folder',
  'scratch',
  'chat-meta',
  'chat-message',
  'asset',
]);

export const PrivateProSyncMutationKindSchema = z.enum(['put', 'delete']);

export type PrivateProSyncRecordType = z.infer<typeof PrivateProSyncRecordTypeSchema>;
export type PrivateProSyncMutationKind = z.infer<typeof PrivateProSyncMutationKindSchema>;

export interface PrivateProSyncRecordDocument {
  recordType: PrivateProSyncRecordType;
  logicalId: string;
  schemaVersion: number;
  payload: string;
  contentHash: string;
  revision: number;
  mutationId: string;
  writerId: string;
  deleted: boolean;
  updatedAt: unknown;
}

export interface PrivateProSyncTombstoneDocument {
  recordKey: string;
  recordType: PrivateProSyncRecordType;
  logicalId: string;
  deletedRevision: number;
  mutationId: string;
  writerId: string;
  deletedAt: unknown;
}

export const PrivateProSyncRecordDocumentSchema: z.ZodType<PrivateProSyncRecordDocument> = z.object({
  recordType: PrivateProSyncRecordTypeSchema,
  logicalId: PrivateProSyncLogicalIdSchema,
  schemaVersion: z.number().int().positive(),
  payload: z.string(),
  contentHash: PrivateProSyncContentHashSchema,
  revision: z.number().int().positive(),
  mutationId: z.string().uuid(),
  writerId: z.string().uuid(),
  deleted: z.boolean(),
  updatedAt: z.unknown(),
}).strict().superRefine((document, context) => {
  if (!document.deleted && document.payload.length === 0)
    context.addIssue({ code: 'custom', path: ['payload'], message: 'Live records require a payload.' });
  if (document.deleted && document.payload.length !== 0)
    context.addIssue({ code: 'custom', path: ['payload'], message: 'Deleted records require an empty payload.' });
});

export const PrivateProSyncTombstoneDocumentSchema: z.ZodType<PrivateProSyncTombstoneDocument> = z.object({
  recordKey: PrivateProSyncRecordKeySchema,
  recordType: PrivateProSyncRecordTypeSchema,
  logicalId: PrivateProSyncLogicalIdSchema,
  deletedRevision: z.number().int().positive(),
  mutationId: z.string().uuid(),
  writerId: z.string().uuid(),
  deletedAt: z.unknown(),
}).strict();

export const PrivateProSyncMutationReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  mutationId: z.string().uuid(),
  recordKey: PrivateProSyncRecordKeySchema,
  recordType: PrivateProSyncRecordTypeSchema,
  logicalId: PrivateProSyncLogicalIdSchema,
  kind: PrivateProSyncMutationKindSchema,
  contentHash: PrivateProSyncContentHashSchema.nullable(),
  revision: z.number().int().positive(),
  writerId: z.string().uuid(),
  committedAt: z.unknown(),
}).strict().superRefine((receipt, context) => {
  if ((receipt.kind === 'put') !== (receipt.contentHash !== null))
    context.addIssue({ code: 'custom', path: ['contentHash'], message: 'Put receipts require a content hash and delete receipts require null.' });
});

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
}).strict();

export const SyncChatMetaSchema = z.object({
  conversationId: z.string().min(1),
  userTitle: z.string().optional(),
  autoTitle: z.string().optional(),
  isArchived: z.boolean().optional(),
  userSymbol: z.string().optional(),
  systemPurposeId: z.string().min(1),
  created: z.number(),
  updated: z.number().nullable(),
}).strict();

export const SyncChatMessageSchema = z.object({
  conversationId: z.string().min(1),
  message: SyncMessageSchema,
}).strict();

// Compatibility-only shape for the legacy vault serializer pending its removal.
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
    created: z.number(),
    updated: z.number().nullable(),
    tokenCount: z.number(),
  }).strict(),
}).strict();

export const SyncPersonaSchema = z.object({
  schemaVersion: z.literal(1),
  persona: z.object({
    id: z.string().min(1),
    name: z.string().optional(),
    systemPrompt: z.string(),
    creationDate: z.string(),
    pictureUrl: z.string().optional(),
    inputProvenance: z.discriminatedUnion('type', [
      z.object({ type: z.literal('youtube'), url: z.string(), title: z.string().optional(), thumbnailUrl: z.string().optional() }),
      z.object({ type: z.literal('text') }),
    ]).optional(),
    inputText: z.string(),
    llmLabel: z.string().optional(),
  }).strict(),
}).strict();

export const SyncChunkSchema = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  byteLength: z.number().int().nonnegative(),
  hash: PrivateProSyncContentHashSchema,
  payloadBase64: z.string(),
}).strict();

export type SyncConversation = z.infer<typeof SyncConversationSchema>;
export type SyncPersona = z.infer<typeof SyncPersonaSchema>;
export type SyncChunk = z.infer<typeof SyncChunkSchema>;
export type SyncChatMeta = z.infer<typeof SyncChatMetaSchema>;
export type SyncChatMessage = z.infer<typeof SyncChatMessageSchema>;
