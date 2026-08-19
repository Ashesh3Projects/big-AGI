import { z } from 'zod/v4';


const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const ISODateSchema = z.iso.datetime({ offset: true });

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(),
  z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema),
]));

const UserOriginSchema = z.strictObject({
  ot: z.literal('user'),
  source: z.literal('attachment'),
  media: z.string(),
  url: z.string().optional(),
  fileName: z.string().optional(),
});

const GeneratedOriginSchema = z.strictObject({
  ot: z.literal('generated'),
  source: z.literal('ai-text-to-image'),
  generatorName: z.string(),
  prompt: z.string(),
  parameters: z.record(z.string(), JsonValueSchema),
  generatedAt: z.string().optional(),
});

const ImageMetadataSchema = z.strictObject({
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
  averageColor: z.string().optional(),
  author: z.string().optional(),
  tags: z.array(z.string()).optional(),
  description: z.string().optional(),
});

const AudioMetadataSchema = z.strictObject({
  duration: z.number().finite().nonnegative(),
  sampleRate: z.number().finite().nonnegative(),
  bitrate: z.number().finite().nonnegative().optional(),
  channels: z.number().int().positive().optional(),
});

export const PrivateProAssetObjectKindSchema = z.enum(['original', 'thumb256']);
export type PrivateProAssetObjectKind = z.infer<typeof PrivateProAssetObjectKindSchema>;

export const PrivateProAssetObjectManifestSchema = z.strictObject({
  objectId: PrivateProAssetObjectKindSchema,
  kind: PrivateProAssetObjectKindSchema,
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'audio/mpeg', 'audio/wav']),
  byteSize: z.number().int().nonnegative(),
  sha256: Sha256Schema,
}).refine(value => value.objectId === value.kind, { message: 'Asset object identity is invalid.' });

const ManifestCommonSchema = z.strictObject({
  formatVersion: z.literal(1),
  schemaVersion: z.literal(1),
  uid: z.string().min(1),
  assetId: z.string().min(1),
  contextId: z.literal('global'),
  scopeId: z.enum(['app-chat', 'app-draw', 'attachment-drafts']),
  label: z.string(),
  origin: z.union([UserOriginSchema, GeneratedOriginSchema]),
  createdAt: ISODateSchema,
  updatedAt: ISODateSchema,
});

const ImageManifestSchema = ManifestCommonSchema.extend({
  assetType: z.literal('image'),
  metadata: ImageMetadataSchema,
  objects: z.strictObject({
    original: PrivateProAssetObjectManifestSchema.refine(value => value.kind === 'original' && value.mimeType.startsWith('image/')),
    thumb256: PrivateProAssetObjectManifestSchema.refine(value => value.kind === 'thumb256' && (value.mimeType === 'image/webp' || value.mimeType === 'image/jpeg')).optional(),
  }),
});

const AudioManifestSchema = ManifestCommonSchema.extend({
  assetType: z.literal('audio'),
  metadata: AudioMetadataSchema,
  objects: z.strictObject({
    original: PrivateProAssetObjectManifestSchema.refine(value => value.kind === 'original' && value.mimeType.startsWith('audio/')),
    thumb256: z.never().optional(),
  }),
});

export const PrivateProAssetManifestSchema = z.discriminatedUnion('assetType', [ImageManifestSchema, AudioManifestSchema]);
export type PrivateProAssetManifest = z.infer<typeof PrivateProAssetManifestSchema>;

export const PrivateProAssetStorageCustomMetadataSchema = z.strictObject({
  uid: z.string().min(1),
  assetId: z.string().min(1),
  kind: PrivateProAssetObjectKindSchema,
  sha256: Sha256Schema,
});
