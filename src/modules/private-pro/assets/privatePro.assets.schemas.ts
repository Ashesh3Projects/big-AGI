import { z } from 'zod/v4';


const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const ISODateSchema = z.iso.datetime({ offset: true });
const ShortStringSchema = z.string().max(512);
const LongStringSchema = z.string().max(16_384);
const ParameterKeySchema = z.string().min(1).max(128);

function parameterSchema(depth: number): z.ZodType<unknown> {
  if (depth >= 5) return z.union([z.null(), z.boolean(), z.number().finite(), LongStringSchema]);
  const child = parameterSchema(depth + 1);
  return z.union([
    z.null(), z.boolean(), z.number().finite(), LongStringSchema,
    z.array(child).max(64), z.record(ParameterKeySchema, child).refine(value => Object.keys(value).length <= 64),
  ]);
}
const JsonValueSchema = parameterSchema(0);

const UserOriginSchema = z.strictObject({
  ot: z.literal('user'),
  source: z.literal('attachment'),
  media: ShortStringSchema,
  url: LongStringSchema.optional(),
  fileName: ShortStringSchema.optional(),
});

const GeneratedOriginSchema = z.strictObject({
  ot: z.literal('generated'),
  source: z.literal('ai-text-to-image'),
  generatorName: ShortStringSchema,
  prompt: LongStringSchema,
  parameters: z.record(ParameterKeySchema, JsonValueSchema).refine(value => Object.keys(value).length <= 64),
  generatedAt: ShortStringSchema.optional(),
});

const ImageMetadataSchema = z.strictObject({
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
  averageColor: ShortStringSchema.optional(),
  author: ShortStringSchema.optional(),
  tags: z.array(ShortStringSchema).max(64).optional(),
  description: LongStringSchema.optional(),
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
  contentGeneration: z.number().int().positive(),
  contextId: z.literal('global'),
  scopeId: z.enum(['app-chat', 'app-draw', 'attachment-drafts']),
  label: ShortStringSchema,
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
