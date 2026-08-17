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


const ModelsServiceSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  vId: z.string().min(1),
  setup: z.record(z.string(), z.json()),
}).strip();

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
}).strict();

export type CredentialServiceValue = z.infer<typeof CredentialServiceSchema>;
export type ModelServiceValue = z.infer<typeof ModelServiceSchema>;


export const privateProVaultCredentialSerializer: PrivateProVaultLogicalSerializer<CredentialServiceValue> = {
  recordType: 'credential-service',
  schemaVersion: 5,
  schema: CredentialServiceSchema,
  logicalId: value => value.id,
  snapshot: () => modelsVaultSnapshot().map(({ service }) => ({ logicalId: service.id, value: CredentialServiceSchema.parse(service) })),
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
