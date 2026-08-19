import * as z from 'zod/v4';

import { themeVaultApply, themeVaultReset, themeVaultSnapshot, themeVaultSubscribe } from '~/common/stores/store-ui';
import { asrxVaultApply, asrxVaultReset, asrxVaultSnapshot, asrxVaultSubscribe } from '~/modules/asrx/store-module-asrx';
import type { DASRxCredentialsAny, DASRxProfileAny } from '~/modules/asrx/asrx.types';
import { googleVaultApply, googleVaultReset, googleVaultSnapshot, googleVaultSubscribe } from '~/modules/google/store-module-google';
import { speexVaultApply, speexVaultReset, speexVaultSnapshot, speexVaultSubscribe } from '~/modules/speex/store-module-speex';
import type { DSpeexCredentialsAny, DSpeexVoiceAny } from '~/modules/speex/speex.types';
import { shareVaultApply, shareVaultReset, shareVaultSnapshot, shareVaultSubscribe } from '~/modules/trade/link/store-share-link';

import type { PrivateProSyncLogicalSerializer } from '../privatePro.sync.serializers';
import {
  PrivateProPortableAppSettingsSchema,
  privateProPortableAppSettingsApply,
  privateProPortableAppSettingsReset,
  privateProPortableAppSettingsSnapshot,
  privateProPortableAppSettingsSubscribe,
} from './settings.portable';


export const PRIVATE_PRO_SYNC_SETTINGS_THEME_ID = 'theme';
export const PRIVATE_PRO_SYNC_SETTINGS_GOOGLE_ID = 'google-search';
export const PRIVATE_PRO_SYNC_SETTINGS_SPEECH_ID = 'speech';
export const PRIVATE_PRO_SYNC_SETTINGS_SHARE_ID = 'share-credentials';

const ThemeSettingsSchema = z.object({ group: z.literal('theme'), mode: z.enum(['light', 'dark', 'system']) }).strict();
const GoogleSettingsSchema = z.object({
  group: z.literal('google-search'),
  googleCloudApiKey: z.string(),
  googleCSEId: z.string(),
  restrictToDomain: z.string(),
}).strict();
const ApiKeyCredentialsSchema = z.object({ type: z.literal('api-key'), apiKey: z.string(), apiHost: z.string().optional() }).strict();
const LlmsServiceCredentialsSchema = z.object({ type: z.literal('llms-service'), serviceId: z.string().min(1) }).strict();
const NoCredentialsSchema = z.object({ type: z.literal('none') }).strict();
const ASRxProfileSchema = z.discriminatedUnion('dialect', [
  z.object({
    dialect: z.literal('deepgram'), asrModel: z.string().optional(), language: z.string().optional(), smartFormat: z.boolean().optional(),
    diarize: z.boolean().optional(), utterances: z.boolean().optional(), keyterms: z.array(z.string()).optional(), topics: z.boolean().optional(), sentiment: z.boolean().optional(),
  }).strict(),
  z.object({
    dialect: z.literal('openai'), asrModel: z.string().optional(), language: z.string().optional(), prompt: z.string().optional(),
    keywords: z.array(z.string()).optional(), temperature: z.number().optional(), diarize: z.boolean().optional(),
  }).strict(),
]);
const ASRxEngineSchema = z.object({
  engineId: z.string().min(1), vendorType: z.enum(['deepgram', 'openai']), label: z.string(), isAutoDetected: z.boolean(),
  isAutoLinked: z.boolean(), isDeleted: z.boolean(), credentials: z.union([ApiKeyCredentialsSchema, LlmsServiceCredentialsSchema]),
  profile: ASRxProfileSchema, createdAt: z.number(), updatedAt: z.number(),
}).strict();
const SpeexVoiceSchema = z.discriminatedUnion('dialect', [
  z.object({ dialect: z.literal('elevenlabs'), ttsModel: z.string().optional(), ttsVoiceId: z.string().optional() }).strict(),
  z.object({ dialect: z.literal('inworld'), ttsModel: z.string().optional(), ttsVoiceId: z.string().optional(), ttsTemperature: z.number().optional(), ttsSpeakingRate: z.number().optional() }).strict(),
  z.object({ dialect: z.literal('localai'), ttsBackend: z.string().optional(), ttsModel: z.string().optional(), ttsLanguage: z.string().optional() }).strict(),
  z.object({ dialect: z.literal('openai'), ttsModel: z.string(), ttsVoiceId: z.string().optional(), ttsSpeed: z.number().optional(), ttsInstruction: z.string().optional() }).strict(),
  z.object({ dialect: z.literal('webspeech'), ttsVoiceURI: z.string().optional(), ttsSpeed: z.number().optional(), ttsPitch: z.number().optional() }).strict(),
]);
const SpeexEngineSchema = z.object({
  engineId: z.string().min(1), vendorType: z.enum(['elevenlabs', 'inworld', 'localai', 'openai', 'webspeech']), label: z.string(), isAutoDetected: z.boolean(),
  isAutoLinked: z.boolean(), isDeleted: z.boolean(), credentials: z.union([ApiKeyCredentialsSchema, LlmsServiceCredentialsSchema, NoCredentialsSchema]),
  voice: SpeexVoiceSchema, createdAt: z.number(), updatedAt: z.number(),
}).strict();
const SpeechSettingsSchema = z.object({
  group: z.literal('speech'),
  asrx: z.object({
    engines: z.record(z.string(), ASRxEngineSchema),
    activeEngineId: z.string().nullable(),
  }).strict(),
  speex: z.object({
    engines: z.record(z.string(), SpeexEngineSchema),
    activeEngineId: z.string().nullable(),
    ttsCharLimit: z.number().nullable(),
  }).strict(),
}).strict();
const ShareSettingsSchema = z.object({
  group: z.literal('share-credentials'),
  chatLinkItems: z.array(z.object({
    chatTitle: z.string().optional(),
    objectId: z.string().min(1),
    createdAt: z.string(),
    expiresAt: z.string().nullable(),
    deletionKey: z.string(),
  }).strict()),
}).strict();

export type SpeechVaultState = z.infer<typeof SpeechSettingsSchema>;

const SettingsSchema = z.discriminatedUnion('group', [
  ThemeSettingsSchema,
  GoogleSettingsSchema,
  SpeechSettingsSchema,
  ShareSettingsSchema,
  ...PrivateProPortableAppSettingsSchema.options,
]);
type SettingsValue = z.infer<typeof SettingsSchema>;

function projectCredentials(credentials: DASRxCredentialsAny | DSpeexCredentialsAny) {
  switch (credentials.type) {
    case 'api-key': return ApiKeyCredentialsSchema.parse({ type: 'api-key', apiKey: credentials.apiKey, apiHost: credentials.apiHost });
    case 'llms-service': return LlmsServiceCredentialsSchema.parse({ type: 'llms-service', serviceId: credentials.serviceId });
    case 'none': return NoCredentialsSchema.parse({ type: 'none' });
    default: throw new Error('Unknown speech credentials type.');
  }
}

function projectASRxProfile(profile: DASRxProfileAny) {
  switch (profile.dialect) {
    case 'deepgram': return ASRxProfileSchema.parse({
      dialect: 'deepgram', asrModel: profile.asrModel, language: profile.language, smartFormat: profile.smartFormat,
      diarize: profile.diarize, utterances: profile.utterances, keyterms: profile.keyterms, topics: profile.topics, sentiment: profile.sentiment,
    });
    case 'openai': return ASRxProfileSchema.parse({
      dialect: 'openai', asrModel: profile.asrModel, language: profile.language, prompt: profile.prompt,
      keywords: profile.keywords, temperature: profile.temperature, diarize: profile.diarize,
    });
    default: throw new Error('Unknown ASRx profile dialect.');
  }
}

function projectSpeexVoice(voice: DSpeexVoiceAny) {
  switch (voice.dialect) {
    case 'elevenlabs': return SpeexVoiceSchema.parse({ dialect: 'elevenlabs', ttsModel: voice.ttsModel, ttsVoiceId: voice.ttsVoiceId });
    case 'inworld': return SpeexVoiceSchema.parse({ dialect: 'inworld', ttsModel: voice.ttsModel, ttsVoiceId: voice.ttsVoiceId, ttsTemperature: voice.ttsTemperature, ttsSpeakingRate: voice.ttsSpeakingRate });
    case 'localai': return SpeexVoiceSchema.parse({ dialect: 'localai', ttsBackend: voice.ttsBackend, ttsModel: voice.ttsModel, ttsLanguage: voice.ttsLanguage });
    case 'openai': return SpeexVoiceSchema.parse({ dialect: 'openai', ttsModel: voice.ttsModel, ttsVoiceId: voice.ttsVoiceId, ttsSpeed: voice.ttsSpeed, ttsInstruction: voice.ttsInstruction });
    case 'webspeech': return SpeexVoiceSchema.parse({ dialect: 'webspeech', ttsVoiceURI: voice.ttsVoiceURI, ttsSpeed: voice.ttsSpeed, ttsPitch: voice.ttsPitch });
    default: throw new Error('Unknown Speex voice dialect.');
  }
}

function projectASRxEngine(engine: ReturnType<typeof asrxVaultSnapshot>['engines'][string]) {
  return ASRxEngineSchema.parse({
    engineId: engine.engineId, vendorType: engine.vendorType, label: engine.label, isAutoDetected: engine.isAutoDetected,
    isAutoLinked: engine.isAutoLinked, isDeleted: engine.isDeleted, credentials: projectCredentials(engine.credentials), profile: projectASRxProfile(engine.profile),
    createdAt: engine.createdAt, updatedAt: engine.updatedAt,
  });
}

function projectSpeexEngine(engine: ReturnType<typeof speexVaultSnapshot>['engines'][string]) {
  return SpeexEngineSchema.parse({
    engineId: engine.engineId, vendorType: engine.vendorType, label: engine.label, isAutoDetected: engine.isAutoDetected,
    isAutoLinked: engine.isAutoLinked, isDeleted: engine.isDeleted, credentials: projectCredentials(engine.credentials), voice: projectSpeexVoice(engine.voice),
    createdAt: engine.createdAt, updatedAt: engine.updatedAt,
  });
}

function speechVaultSnapshot() {
  const asrx = asrxVaultSnapshot();
  const speex = speexVaultSnapshot();
  return {
    asrx: { engines: Object.fromEntries(Object.entries(asrx.engines).map(([id, engine]) => [id, projectASRxEngine(engine)])), activeEngineId: asrx.activeEngineId },
    speex: { engines: Object.fromEntries(Object.entries(speex.engines).map(([id, engine]) => [id, projectSpeexEngine(engine)])), activeEngineId: speex.activeEngineId, ttsCharLimit: speex.ttsCharLimit },
  };
}


export function speechVaultApply(value: Omit<SpeechVaultState, 'group'>): void {
  const parsed = SpeechSettingsSchema.parse({ group: 'speech', ...value });
  asrxVaultApply(parsed.asrx as unknown as ReturnType<typeof asrxVaultSnapshot>);
  speexVaultApply(parsed.speex as unknown as ReturnType<typeof speexVaultSnapshot>);
}

function speechVaultReset(): void {
  asrxVaultReset();
  speexVaultReset();
}

function speechVaultSubscribe(listener: () => void): () => void {
  const unsubAsrx = asrxVaultSubscribe(listener);
  const unsubSpeex = speexVaultSubscribe(listener);
  return () => {
    unsubAsrx();
    unsubSpeex();
  };
}

export const privateProSyncSettingsSerializer: PrivateProSyncLogicalSerializer<SettingsValue> = {
  recordType: 'settings',
  schemaVersion: 2,
  conflictPolicy: 'replace',
  schema: SettingsSchema,
  logicalId: value => value.group,
  projectionKey: value => value.group,
  snapshot: () => {
    const google = googleVaultSnapshot();
    const speech = { group: 'speech', ...speechVaultSnapshot() } as const;
    const share = shareVaultSnapshot();
    return [
      { logicalId: PRIVATE_PRO_SYNC_SETTINGS_THEME_ID, value: ThemeSettingsSchema.parse({ group: 'theme', mode: themeVaultSnapshot() }) },
      ...(google.googleCloudApiKey || google.googleCSEId || google.restrictToDomain
        ? [{ logicalId: PRIVATE_PRO_SYNC_SETTINGS_GOOGLE_ID, value: GoogleSettingsSchema.parse({ group: 'google-search', ...google }) }]
        : []),
      ...(Object.keys(speech.asrx.engines).length || Object.keys(speech.speex.engines).length || speech.asrx.activeEngineId || speech.speex.activeEngineId
        ? [{ logicalId: PRIVATE_PRO_SYNC_SETTINGS_SPEECH_ID, value: SpeechSettingsSchema.parse(speech) }]
        : []),
      ...(share.chatLinkItems.length
        ? [{ logicalId: PRIVATE_PRO_SYNC_SETTINGS_SHARE_ID, value: ShareSettingsSchema.parse({ group: 'share-credentials', ...share }) }]
        : []),
      ...privateProPortableAppSettingsSnapshot().map(value => ({ logicalId: value.group, value })),
    ];
  },
  apply: (_logicalId, value) => {
    switch (value.group) {
      case 'theme': return themeVaultApply(value.mode);
      case 'google-search': return googleVaultApply(value);
      case 'speech': return speechVaultApply(value);
      case 'share-credentials': return shareVaultApply(value);
      default: return privateProPortableAppSettingsApply(PrivateProPortableAppSettingsSchema.parse(value));
    }
  },
  remove: logicalId => {
    switch (logicalId) {
      case PRIVATE_PRO_SYNC_SETTINGS_THEME_ID: return themeVaultReset();
      case PRIVATE_PRO_SYNC_SETTINGS_GOOGLE_ID: return googleVaultReset();
      case PRIVATE_PRO_SYNC_SETTINGS_SPEECH_ID: return speechVaultReset();
      case PRIVATE_PRO_SYNC_SETTINGS_SHARE_ID: return shareVaultReset();
      default: return privateProPortableAppSettingsReset(logicalId as Parameters<typeof privateProPortableAppSettingsReset>[0]);
    }
  },
  subscribe: listener => {
    const unsubscribers = [themeVaultSubscribe(listener), googleVaultSubscribe(listener), speechVaultSubscribe(listener), shareVaultSubscribe(listener), privateProPortableAppSettingsSubscribe(listener)];
    return () => unsubscribers.forEach(unsubscribe => unsubscribe());
  },
};
