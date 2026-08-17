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
  benchmark: z.record(z.string(), z.json()).optional(),
  pricing: z.json().optional(),
  parameterSpecs: z.array(z.json()),
  initialParameters: z.record(z.string(), z.json()),
  sId: z.string().min(1),
  vId: z.string().min(1),
  userLabel: z.string().optional(),
  userHidden: z.boolean().optional(),
  userStarred: z.boolean().optional(),
  userContextTokens: z.number().nullable().optional(),
  userMaxOutputTokens: z.number().nullable().optional(),
  userPricing: z.json().optional(),
  userParameters: z.record(z.string(), z.json()).optional(),
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


export const privateProVaultCredentialSerializer: PrivateProVaultLogicalSerializer<CredentialServiceValue> = {
  recordType: 'credential-service',
  schemaVersion: 5,
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
    value: ModelServiceSchema.parse({ serviceId: service.id, models }),
  })),
  apply: (logicalId, value) => modelsVaultApplyModels(logicalId, value.models as unknown as ModelsVaultServiceState['models']),
  remove: modelsVaultRemoveModels,
  subscribe: modelsVaultSubscribe,
};
