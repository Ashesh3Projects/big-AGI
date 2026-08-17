import * as z from 'zod/v4';

import {
  modelsVaultApplyModels,
  modelsVaultApplyService,
  modelsVaultRemove,
  modelsVaultRemoveModels,
  modelsVaultSnapshot,
  modelsVaultSubscribe,
  type ModelsVaultServiceState,
} from '~/common/stores/llms/store-llms';
import { DModelParameterRegistry, type DModelParameterId, type DModelParameterSpecAny, type DModelParameterValues } from '~/common/stores/llms/llms.parameters';
import type { DModelPricing, DPricingChatGenerate } from '~/common/stores/llms/llms.pricing';
import type { DLLM } from '~/common/stores/llms/llms.types';

import type { PrivateProVaultLogicalSerializer } from '../privatePro.vault.serializers';


const SERVICE_SETUP_KEYS = new Set([
  'alibabaOaiKey', 'alibabaOaiHost',
  'anthropicKey', 'anthropicHost', 'inferenceGeoUS',
  'azureEndpoint', 'azureKey',
  'bedrockBearerToken', 'bedrockAccessKeyId', 'bedrockSecretAccessKey', 'bedrockSessionToken', 'bedrockRegion',
  'cerebrasKey', 'cohereKey', 'cohereHost', 'deepseekKey', 'deepseekHost',
  'geminiKey', 'geminiHost', 'minSafetyLevel', 'groqKey',
  'localAIHost', 'localAIKey', 'mode', 'modularKey', 'modularHost', 'moonshotKey',
  'nvidiaKey', 'nvidiaHost', 'oaiKey', 'oaiOrg', 'oaiHost', 'ollamaHost',
  'perplexityKey', 'requireParameters', 'sakanaKey', 'sakanaHost',
  'togetherKey', 'togetherHost', 'togetherFreeTrial', 'xaiKey', 'zaiKey', 'zaiHost',
  'csf',
]);

function projectServiceSetup(value: unknown): Record<string, string | boolean> {
  if (!value || typeof value !== 'object') return {};
  const projected: Record<string, string | boolean> = {};
  for (const [key, field] of Object.entries(value)) {
    if (SERVICE_SETUP_KEYS.has(key) && (typeof field === 'string' || typeof field === 'boolean'))
      projected[key] = field;
  }
  return projected;
}

const ServiceSetupSchema = z.record(z.string(), z.union([z.string(), z.boolean()])).superRefine((setup, context) => {
  for (const key of Object.keys(setup)) {
    if (!SERVICE_SETUP_KEYS.has(key))
      context.addIssue({ code: 'custom', message: `Unknown model service setup field: ${key}` });
  }
});

const ModelsServiceSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  vId: z.string().min(1),
  setup: ServiceSetupSchema,
}).strict();

const MODEL_PARAMETER_IDS = Object.keys(DModelParameterRegistry) as [DModelParameterId, ...DModelParameterId[]];
const ModelParameterIdSchema = z.enum(MODEL_PARAMETER_IDS);
const ModelParameterValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const ModelParameterValuesSchema = z.partialRecord(ModelParameterIdSchema, ModelParameterValueSchema);
const ModelParameterSpecSchema = z.object({
  paramId: ModelParameterIdSchema,
  required: z.boolean().optional(),
  hidden: z.boolean().optional(),
  initialValue: ModelParameterValueSchema.optional(),
  rangeOverride: z.tuple([z.number(), z.number()]).optional(),
  enumValues: z.array(ModelParameterValueSchema).optional(),
}).strict();

const PriceValueSchema = z.union([z.number(), z.literal('free')]);
const TieredPriceSchema = z.union([
  PriceValueSchema,
  z.array(z.object({ upTo: z.number().nullable(), price: PriceValueSchema }).strict()),
]);
const ChatPricingSchema = z.object({
  input: TieredPriceSchema.optional(),
  output: TieredPriceSchema.optional(),
  cache: z.union([
    z.object({ cType: z.literal('ant-bp'), read: TieredPriceSchema, write: TieredPriceSchema, duration: z.number() }).strict(),
    z.object({ cType: z.literal('oai-ac'), read: TieredPriceSchema }).strict(),
  ]).optional(),
  _isFree: z.boolean().optional(),
}).strict();
const ModelPricingSchema = z.object({ chat: ChatPricingSchema.optional() }).strict();
const BenchmarkSchema = z.object({ cbaElo: z.number().optional() }).strict();

const ModelSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  created: z.number(),
  updated: z.number().optional(),
  pubDate: z.string().optional(),
  description: z.string(),
  hidden: z.boolean(),
  contextTokens: z.number().nullable(),
  maxOutputTokens: z.number().nullable(),
  interfaces: z.array(z.string()),
  benchmark: BenchmarkSchema.optional(),
  pricing: ModelPricingSchema.optional(),
  parameterSpecs: z.array(ModelParameterSpecSchema),
  initialParameters: ModelParameterValuesSchema,
  sId: z.string().min(1),
  vId: z.string().min(1),
  userLabel: z.string().optional(),
  userHidden: z.boolean().optional(),
  userStarred: z.boolean().optional(),
  userContextTokens: z.number().nullable().optional(),
  userMaxOutputTokens: z.number().nullable().optional(),
  userPricing: ModelPricingSchema.optional(),
  userParameters: ModelParameterValuesSchema.optional(),
  isUserClone: z.boolean().optional(),
  cloneSourceId: z.string().optional(),
}).strip();

const CredentialServiceSchema = ModelsServiceSchema;
const ModelServiceSchema = z.object({
  serviceId: z.string().min(1),
  models: z.array(ModelSchema),
}).strict().superRefine((value, context) => {
  value.models.forEach((model, index) => {
    if (model.sId !== value.serviceId)
      context.addIssue({ code: 'custom', path: ['models', index, 'sId'], message: 'Model sId must match the model-service serviceId.' });
  });
});

export type CredentialServiceValue = z.infer<typeof CredentialServiceSchema>;
export type ModelServiceValue = z.infer<typeof ModelServiceSchema>;

function projectParameterValues(values: DModelParameterValues | undefined): DModelParameterValues | undefined {
  if (!values) return undefined;
  return Object.fromEntries(Object.entries(values).filter(([key, value]) =>
    key in DModelParameterRegistry && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null),
  )) as DModelParameterValues;
}

function projectParameterSpec(spec: DModelParameterSpecAny): DModelParameterSpecAny {
  return ModelParameterSpecSchema.parse({
    paramId: spec.paramId,
    required: spec.required,
    hidden: spec.hidden,
    initialValue: spec.initialValue,
    rangeOverride: spec.rangeOverride,
    enumValues: spec.enumValues,
  }) as DModelParameterSpecAny;
}

function projectTieredPrice(value: DPricingChatGenerate['input']) {
  if (Array.isArray(value)) return value.map(tier => ({ upTo: tier.upTo, price: tier.price }));
  return value;
}

function projectPricing(pricing: DModelPricing | undefined): DModelPricing | undefined {
  const chat = pricing?.chat;
  if (!chat) return undefined;
  return ModelPricingSchema.parse({
    chat: {
      input: projectTieredPrice(chat.input),
      output: projectTieredPrice(chat.output),
      cache: !chat.cache ? undefined : chat.cache.cType === 'ant-bp' ? {
        cType: 'ant-bp', read: projectTieredPrice(chat.cache.read), write: projectTieredPrice(chat.cache.write), duration: chat.cache.duration,
      } : { cType: 'oai-ac', read: projectTieredPrice(chat.cache.read) },
      _isFree: chat._isFree,
    },
  }) as DModelPricing;
}

function projectModel(model: DLLM): DLLM {
  return ModelSchema.parse({
    id: model.id, label: model.label, created: model.created, updated: model.updated, pubDate: model.pubDate,
    description: model.description, hidden: model.hidden, contextTokens: model.contextTokens, maxOutputTokens: model.maxOutputTokens,
    interfaces: model.interfaces, benchmark: model.benchmark ? { cbaElo: model.benchmark.cbaElo } : undefined,
    pricing: projectPricing(model.pricing), parameterSpecs: model.parameterSpecs.map(projectParameterSpec), initialParameters: projectParameterValues(model.initialParameters) ?? {},
    sId: model.sId, vId: model.vId, userLabel: model.userLabel, userHidden: model.userHidden, userStarred: model.userStarred,
    userContextTokens: model.userContextTokens, userMaxOutputTokens: model.userMaxOutputTokens, userPricing: projectPricing(model.userPricing),
    userParameters: projectParameterValues(model.userParameters), isUserClone: model.isUserClone, cloneSourceId: model.cloneSourceId,
  }) as DLLM;
}


export const privateProVaultCredentialSerializer: PrivateProVaultLogicalSerializer<CredentialServiceValue> = {
  recordType: 'credential-service',
  schemaVersion: 5,
  conflictPolicy: 'replace',
  schema: CredentialServiceSchema,
  logicalId: value => value.id,
  snapshot: () => modelsVaultSnapshot().map(({ service }) => ({
    logicalId: service.id,
    value: CredentialServiceSchema.parse({ id: service.id, label: service.label, vId: service.vId, setup: projectServiceSetup(service.setup) }),
  })),
  apply: (_logicalId, value) => modelsVaultApplyService(value as ModelsVaultServiceState['service']),
  remove: modelsVaultRemove,
  subscribe: modelsVaultSubscribe,
};

export const privateProVaultModelSerializer: PrivateProVaultLogicalSerializer<ModelServiceValue> = {
  recordType: 'model-service',
  schemaVersion: 5,
  schema: ModelServiceSchema,
  logicalId: value => value.serviceId,
  snapshot: () => modelsVaultSnapshot().filter(({ models }) => models.length > 0).map(({ service, models }) => ({
    logicalId: service.id,
    value: ModelServiceSchema.parse({ serviceId: service.id, models: models.map(projectModel) }),
  })),
  apply: (logicalId, value) => modelsVaultApplyModels(logicalId, value.models as unknown as ModelsVaultServiceState['models']),
  remove: modelsVaultRemoveModels,
  subscribe: modelsVaultSubscribe,
};
