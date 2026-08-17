import * as z from 'zod/v4';

import { themeVaultApply, themeVaultReset, themeVaultSnapshot, themeVaultSubscribe } from '~/common/stores/store-ui';
import { asrxVaultApply, asrxVaultReset, asrxVaultSnapshot, asrxVaultSubscribe } from '~/modules/asrx/store-module-asrx';
import { googleVaultApply, googleVaultReset, googleVaultSnapshot, googleVaultSubscribe } from '~/modules/google/store-module-google';
import { speexVaultApply, speexVaultReset, speexVaultSnapshot, speexVaultSubscribe } from '~/modules/speex/store-module-speex';
import { shareVaultApply, shareVaultReset, shareVaultSnapshot, shareVaultSubscribe } from '~/modules/trade/link/store-share-link';

import type { PrivateProVaultLogicalSerializer } from '../privatePro.vault.serializers';


export const PRIVATE_PRO_VAULT_SETTINGS_THEME_ID = 'theme';
export const PRIVATE_PRO_VAULT_SETTINGS_GOOGLE_ID = 'google-search';
export const PRIVATE_PRO_VAULT_SETTINGS_SPEECH_ID = 'speech';
export const PRIVATE_PRO_VAULT_SETTINGS_SHARE_ID = 'share-credentials';

const ThemeSettingsSchema = z.object({ group: z.literal('theme'), mode: z.enum(['light', 'dark', 'system']) }).strict();
const GoogleSettingsSchema = z.object({
  group: z.literal('google-search'),
  googleCloudApiKey: z.string(),
  googleCSEId: z.string(),
  restrictToDomain: z.string(),
}).strict();
const SpeechSettingsSchema = z.object({
  group: z.literal('speech'),
  asrx: z.object({
    engines: z.record(z.string(), z.json()),
    activeEngineId: z.string().nullable(),
  }).strict(),
  speex: z.object({
    engines: z.record(z.string(), z.json()),
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
]);
type SettingsValue = z.infer<typeof SettingsSchema>;


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

export const privateProVaultSettingsSerializer: PrivateProVaultLogicalSerializer<SettingsValue> = {
  recordType: 'settings',
  schemaVersion: 2,
  schema: SettingsSchema,
  logicalId: value => value.group,
  snapshot: () => {
    const google = googleVaultSnapshot();
    const speech = { group: 'speech', asrx: asrxVaultSnapshot(), speex: speexVaultSnapshot() } as const;
    const share = shareVaultSnapshot();
    return [
      { logicalId: PRIVATE_PRO_VAULT_SETTINGS_THEME_ID, value: ThemeSettingsSchema.parse({ group: 'theme', mode: themeVaultSnapshot() }) },
      ...(google.googleCloudApiKey || google.googleCSEId || google.restrictToDomain
        ? [{ logicalId: PRIVATE_PRO_VAULT_SETTINGS_GOOGLE_ID, value: GoogleSettingsSchema.parse({ group: 'google-search', ...google }) }]
        : []),
      ...(Object.keys(speech.asrx.engines).length || Object.keys(speech.speex.engines).length || speech.asrx.activeEngineId || speech.speex.activeEngineId
        ? [{ logicalId: PRIVATE_PRO_VAULT_SETTINGS_SPEECH_ID, value: SpeechSettingsSchema.parse(speech) }]
        : []),
      ...(share.chatLinkItems.length
        ? [{ logicalId: PRIVATE_PRO_VAULT_SETTINGS_SHARE_ID, value: ShareSettingsSchema.parse({ group: 'share-credentials', ...share }) }]
        : []),
    ];
  },
  apply: (_logicalId, value) => {
    switch (value.group) {
      case 'theme': return themeVaultApply(value.mode);
      case 'google-search': return googleVaultApply(value);
      case 'speech': return speechVaultApply(value);
      case 'share-credentials': return shareVaultApply(value);
    }
  },
  remove: logicalId => {
    switch (logicalId) {
      case PRIVATE_PRO_VAULT_SETTINGS_THEME_ID: return themeVaultReset();
      case PRIVATE_PRO_VAULT_SETTINGS_GOOGLE_ID: return googleVaultReset();
      case PRIVATE_PRO_VAULT_SETTINGS_SPEECH_ID: return speechVaultReset();
      case PRIVATE_PRO_VAULT_SETTINGS_SHARE_ID: return shareVaultReset();
    }
  },
  subscribe: listener => {
    const unsubscribers = [themeVaultSubscribe(listener), googleVaultSubscribe(listener), speechVaultSubscribe(listener), shareVaultSubscribe(listener)];
    return () => unsubscribers.forEach(unsubscribe => unsubscribe());
  },
};
