import * as z from 'zod/v4';

import { useAppCallStore } from '../../../../apps/call/state/store-app-call';
import { usePurposeStore } from '../../../../apps/chat/components/persona-selector/store-purposes';
import { useAppChatStore } from '../../../../apps/chat/store-app-chat';
import { useAIPreferencesStore } from '~/common/stores/store-ai';
import { useUIPreferencesStore } from '~/common/stores/store-ui';
import { useUXLabsStore } from '~/common/stores/store-ux-labs';
import { useModuleBeamStore } from '~/modules/beam/store-module-beam';
import { useBrowseStore } from '~/modules/browse/store-module-browsing';
import { useT2IStore } from '~/modules/t2i/store-module-t2i';
import { useFolderStore } from '~/common/stores/folders/store-chat-folders';


export const PRIVATE_PRO_VAULT_SETTINGS_CALL_ID = 'call';
export const PRIVATE_PRO_VAULT_SETTINGS_CHAT_ID = 'chat';
export const PRIVATE_PRO_VAULT_SETTINGS_PURPOSES_ID = 'purposes';
export const PRIVATE_PRO_VAULT_SETTINGS_AI_ID = 'ai-preferences';
export const PRIVATE_PRO_VAULT_SETTINGS_UI_ID = 'ui';
export const PRIVATE_PRO_VAULT_SETTINGS_UX_LABS_ID = 'ux-labs';
export const PRIVATE_PRO_VAULT_SETTINGS_BEAM_ID = 'beam';
export const PRIVATE_PRO_VAULT_SETTINGS_BROWSING_ID = 'browsing';
export const PRIVATE_PRO_VAULT_SETTINGS_IMAGE_ID = 'image';
export const PRIVATE_PRO_VAULT_SETTINGS_FOLDERS_ID = 'folders';

const CallSettingsSchema = z.object({
  group: z.literal(PRIVATE_PRO_VAULT_SETTINGS_CALL_ID),
  grayUI: z.boolean(),
  showConversations: z.boolean(),
  showSupport: z.boolean(),
}).strict();

const ChatSettingsSchema = z.object({
  group: z.literal(PRIVATE_PRO_VAULT_SETTINGS_CHAT_ID),
  autoSpeak: z.enum(['off', 'firstLine', 'all']),
  autoSuggestAttachmentPrompts: z.boolean(),
  autoSuggestDiagrams: z.boolean(),
  autoSuggestHTMLUI: z.boolean(),
  autoSuggestQuestions: z.boolean(),
  autoTitleChat: z.boolean(),
  autoVndAntBreakpoints: z.boolean(),
  chatThinkingPolicy: z.enum(['last-only', 'all', 'discard-all']),
  tokenCountingMethod: z.enum(['accurate', 'approximate']),
  micTimeoutMs: z.number().int().min(500).max(120_000),
  showPersonaIcons2: z.boolean(),
  showRelativeSize: z.boolean(),
  showTextDiff: z.boolean(),
  showSystemMessages: z.boolean(),
  showToolbarNavigation: z.boolean(),
  notificationEnabledModelIds: z.array(z.string().min(1).max(256)).max(1_000),
}).strict();

const PurposesSettingsSchema = z.object({
  group: z.literal(PRIVATE_PRO_VAULT_SETTINGS_PURPOSES_ID),
  hiddenPurposeIDs: z.array(z.string().min(1).max(256)).max(1_000),
}).strict();

const AIPreferencesSettingsSchema = z.object({
  group: z.literal(PRIVATE_PRO_VAULT_SETTINGS_AI_ID),
  vndAntInlineFiles: z.enum(['off', 'inline-file', 'inline-file-and-delete']),
  vndGeminiVertexLinks: z.enum(['as-is', 'resolve']),
}).strict();

const UISettingsSchema = z.object({
  group: z.literal(PRIVATE_PRO_VAULT_SETTINGS_UI_ID),
  preferredLanguage: z.string().max(64),
  centerMode: z.enum(['narrow', 'wide', 'full']),
  complexityMode: z.enum(['minimal', 'pro', 'extra']),
  contentScaling: z.enum(['xs', 'sm', 'md']),
  disableMarkdown: z.boolean(),
  doubleClickToEdit: z.boolean(),
  enterIsNewline: z.boolean(),
  messageFullWidth: z.boolean(),
  renderCodeLineNumbers: z.boolean(),
  renderCodeSoftWrap: z.boolean(),
  showPersonaFinder: z.boolean(),
  showModelsFn: z.boolean(),
  showModelsHidden: z.boolean(),
  showModelsStarredOnly: z.boolean(),
  modelsStarredOnTop: z.boolean(),
  composerQuickButton: z.enum(['off', 'call', 'beam']),
  dismissals: z.record(z.string().max(256), z.boolean()),
  actionCounters: z.record(z.string().max(256), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)),
}).strict();

const UXLabsSettingsSchema = z.object({
  group: z.literal(PRIVATE_PRO_VAULT_SETTINGS_UX_LABS_ID),
  labsHighPerformance: z.boolean(),
  labsAutoHideComposer: z.boolean(),
  labsShowShortcutBar: z.boolean(),
  labsComposerAttachmentsInline: z.boolean(),
  labsLosslessImages: z.boolean(),
  labsSingleDollarLatex: z.boolean(),
}).strict();

const BeamConfigSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().max(512),
  rayLlmIds: z.array(z.string().min(1).max(256)).max(128),
  gatherFactoryId: z.string().min(1).max(256).nullable().optional(),
  gatherLlmId: z.string().min(1).max(256).nullable().optional(),
}).strict();

const BeamSettingsSchema = z.object({
  group: z.literal(PRIVATE_PRO_VAULT_SETTINGS_BEAM_ID),
  presets: z.array(BeamConfigSchema).max(256),
  lastConfig: BeamConfigSchema.nullable(),
  cardAdd: z.boolean(),
  cardScrolling: z.boolean(),
  scatterShowLettering: z.boolean(),
  scatterShowPrevMessages: z.boolean(),
  gatherAutoStartAfterScatter: z.boolean(),
  gatherShowAllPrompts: z.boolean(),
}).strict();

const BrowsingSettingsSchema = z.object({
  group: z.literal(PRIVATE_PRO_VAULT_SETTINGS_BROWSING_ID),
  wssEndpoint: z.string().max(2_048),
  pageTransform: z.enum(['html', 'text', 'markdown']),
  enableComposerAttach: z.boolean(),
  enableReactTool: z.boolean(),
  enablePersonaTool: z.boolean(),
}).strict();

const T2ICredentialsSchema = z.object({
  type: z.literal('llms-service'),
  serviceId: z.string().min(1).max(256),
}).strict();
const DalleProfileSchema = z.object({
  dialect: z.literal('dalle'),
  dalleModelId: z.enum(['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini', 'dall-e-3', 'dall-e-2']).nullable(),
  dalleNoRewrite: z.boolean(),
  dalleSizeGI: z.enum(['1024x1024', '1536x1024', '1024x1536']),
  dalleQualityGI: z.enum(['high', 'medium', 'low']),
  dalleBackgroundGI: z.enum(['auto', 'transparent', 'opaque']),
  dalleOutputFormatGI: z.enum(['png', 'jpeg', 'webp']),
  dalleOutputCompressionGI: z.number().int().min(0).max(100),
  dalleModerationGI: z.enum(['auto', 'low']),
  dalleSizeD3: z.enum(['1024x1024', '1792x1024', '1024x1792']),
  dalleQualityD3: z.enum(['hd', 'standard']),
  dalleStyleD3: z.enum(['vivid', 'natural']),
  dalleSizeD2: z.enum(['256x256', '512x512', '1024x1024']),
}).strict();
const OpenRouterProfileSchema = z.object({
  dialect: z.literal('openrouter'),
  imageModelId: z.string().min(1).max(512).nullable(),
}).strict();
const T2IEngineBaseSchema = z.object({
  engineId: z.string().min(1).max(256),
  label: z.string().max(512),
  isAutoDetected: z.boolean(),
  isAutoLinked: z.boolean(),
  isDeleted: z.boolean(),
  credentials: T2ICredentialsSchema,
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
const T2IEngineSchema = z.discriminatedUnion('vendorType', [
  T2IEngineBaseSchema.extend({ vendorType: z.literal('openai'), profile: DalleProfileSchema }).strict(),
  T2IEngineBaseSchema.extend({ vendorType: z.literal('azure'), profile: DalleProfileSchema }).strict(),
  T2IEngineBaseSchema.extend({ vendorType: z.literal('localai'), profile: DalleProfileSchema }).strict(),
  T2IEngineBaseSchema.extend({ vendorType: z.literal('openrouter'), profile: OpenRouterProfileSchema }).strict(),
]);
const ImageSettingsSchema = z.object({
  group: z.literal(PRIVATE_PRO_VAULT_SETTINGS_IMAGE_ID),
  engines: z.record(z.string().min(1).max(256), T2IEngineSchema),
  activeEngineId: z.string().min(1).max(256).nullable(),
}).strict();

const FoldersSettingsSchema = z.object({
  group: z.literal(PRIVATE_PRO_VAULT_SETTINGS_FOLDERS_ID),
  enableFolders: z.boolean(),
}).strict();

export const PrivateProPortableAppSettingsSchema = z.discriminatedUnion('group', [
  CallSettingsSchema,
  ChatSettingsSchema,
  PurposesSettingsSchema,
  AIPreferencesSettingsSchema,
  UISettingsSchema,
  UXLabsSettingsSchema,
  BeamSettingsSchema,
  BrowsingSettingsSchema,
  ImageSettingsSchema,
  FoldersSettingsSchema,
]);

export type PrivateProPortableAppSettings = z.infer<typeof PrivateProPortableAppSettingsSchema>;

type Store<TState> = {
  getState(): TState;
  getInitialState(): TState;
  setState(state: Partial<TState>): void;
  subscribe(listener: (state: TState, previous: TState) => void): () => void;
};

function subscribeProjected<TState, TValue>(
  store: Store<TState>,
  project: (state: TState) => TValue,
  listener: () => void,
): () => void {
  return store.subscribe((state, previous) => {
    if (JSON.stringify(project(state)) !== JSON.stringify(project(previous))) listener();
  });
}

const callState = (state: ReturnType<typeof useAppCallStore.getState>) => ({
  grayUI: state.grayUI,
  showConversations: state.showConversations,
  showSupport: state.showSupport,
});

const chatState = (state: ReturnType<typeof useAppChatStore.getState>) => ({
  autoSpeak: state.autoSpeak,
  autoSuggestAttachmentPrompts: state.autoSuggestAttachmentPrompts,
  autoSuggestDiagrams: state.autoSuggestDiagrams,
  autoSuggestHTMLUI: state.autoSuggestHTMLUI,
  autoSuggestQuestions: state.autoSuggestQuestions,
  autoTitleChat: state.autoTitleChat,
  autoVndAntBreakpoints: state.autoVndAntBreakpoints,
  chatThinkingPolicy: state.chatThinkingPolicy,
  tokenCountingMethod: state.tokenCountingMethod,
  micTimeoutMs: state.micTimeoutMs,
  showPersonaIcons2: state.showPersonaIcons2,
  showRelativeSize: state.showRelativeSize,
  showTextDiff: state.showTextDiff,
  showSystemMessages: state.showSystemMessages,
  showToolbarNavigation: state.showToolbarNavigation,
  notificationEnabledModelIds: state.notificationEnabledModelIds,
});

const purposesState = (state: ReturnType<typeof usePurposeStore.getState>) => ({ hiddenPurposeIDs: state.hiddenPurposeIDs });
const aiState = (state: ReturnType<typeof useAIPreferencesStore.getState>) => ({
  vndAntInlineFiles: state.vndAntInlineFiles,
  vndGeminiVertexLinks: state.vndGeminiVertexLinks,
});
const uiState = (state: ReturnType<typeof useUIPreferencesStore.getState>) => ({
  preferredLanguage: state.preferredLanguage,
  centerMode: state.centerMode,
  complexityMode: state.complexityMode,
  contentScaling: state.contentScaling,
  disableMarkdown: state.disableMarkdown,
  doubleClickToEdit: state.doubleClickToEdit,
  enterIsNewline: state.enterIsNewline,
  messageFullWidth: state.messageFullWidth,
  renderCodeLineNumbers: state.renderCodeLineNumbers,
  renderCodeSoftWrap: state.renderCodeSoftWrap,
  showPersonaFinder: state.showPersonaFinder,
  showModelsFn: state.showModelsFn,
  showModelsHidden: state.showModelsHidden,
  showModelsStarredOnly: state.showModelsStarredOnly,
  modelsStarredOnTop: state.modelsStarredOnTop,
  composerQuickButton: state.composerQuickButton,
  dismissals: state.dismissals,
  actionCounters: state.actionCounters,
});
const uxLabsState = (state: ReturnType<typeof useUXLabsStore.getState>) => ({
  labsHighPerformance: state.labsHighPerformance,
  labsAutoHideComposer: state.labsAutoHideComposer,
  labsShowShortcutBar: state.labsShowShortcutBar,
  labsComposerAttachmentsInline: state.labsComposerAttachmentsInline,
  labsLosslessImages: state.labsLosslessImages,
  labsSingleDollarLatex: state.labsSingleDollarLatex,
});
const beamState = (state: ReturnType<typeof useModuleBeamStore.getState>) => ({
  presets: state.presets,
  lastConfig: state.lastConfig,
  cardAdd: state.cardAdd,
  cardScrolling: state.cardScrolling,
  scatterShowLettering: state.scatterShowLettering,
  scatterShowPrevMessages: state.scatterShowPrevMessages,
  gatherAutoStartAfterScatter: state.gatherAutoStartAfterScatter,
  gatherShowAllPrompts: state.gatherShowAllPrompts,
});
const browsingState = (state: ReturnType<typeof useBrowseStore.getState>) => ({
  wssEndpoint: state.wssEndpoint,
  pageTransform: state.pageTransform,
  enableComposerAttach: state.enableComposerAttach,
  enableReactTool: state.enableReactTool,
  enablePersonaTool: state.enablePersonaTool,
});
const imageState = (state: ReturnType<typeof useT2IStore.getState>) => ({
  engines: state.engines,
  activeEngineId: state.activeEngineId,
});
const foldersState = (state: ReturnType<typeof useFolderStore.getState>) => ({ enableFolders: state.enableFolders });

export function privateProPortableAppSettingsSnapshot(): PrivateProPortableAppSettings[] {
  return PrivateProPortableAppSettingsSchema.array().parse([
    { group: PRIVATE_PRO_VAULT_SETTINGS_CALL_ID, ...callState(useAppCallStore.getState()) },
    { group: PRIVATE_PRO_VAULT_SETTINGS_CHAT_ID, ...chatState(useAppChatStore.getState()) },
    { group: PRIVATE_PRO_VAULT_SETTINGS_PURPOSES_ID, ...purposesState(usePurposeStore.getState()) },
    { group: PRIVATE_PRO_VAULT_SETTINGS_AI_ID, ...aiState(useAIPreferencesStore.getState()) },
    { group: PRIVATE_PRO_VAULT_SETTINGS_UI_ID, ...uiState(useUIPreferencesStore.getState()) },
    { group: PRIVATE_PRO_VAULT_SETTINGS_UX_LABS_ID, ...uxLabsState(useUXLabsStore.getState()) },
    { group: PRIVATE_PRO_VAULT_SETTINGS_BEAM_ID, ...beamState(useModuleBeamStore.getState()) },
    { group: PRIVATE_PRO_VAULT_SETTINGS_BROWSING_ID, ...browsingState(useBrowseStore.getState()) },
    { group: PRIVATE_PRO_VAULT_SETTINGS_IMAGE_ID, ...imageState(useT2IStore.getState()) },
    { group: PRIVATE_PRO_VAULT_SETTINGS_FOLDERS_ID, ...foldersState(useFolderStore.getState()) },
  ]);
}

export function privateProPortableAppSettingsApply(value: PrivateProPortableAppSettings): void {
  const parsed = PrivateProPortableAppSettingsSchema.parse(value);
  switch (parsed.group) {
    case PRIVATE_PRO_VAULT_SETTINGS_CALL_ID: {
      const { group: _group, ...state } = parsed;
      useAppCallStore.setState(state);
      return;
    }
    case PRIVATE_PRO_VAULT_SETTINGS_CHAT_ID: {
      const { group: _group, ...state } = parsed;
      useAppChatStore.setState(state);
      return;
    }
    case PRIVATE_PRO_VAULT_SETTINGS_PURPOSES_ID: {
      const { group: _group, ...state } = parsed;
      usePurposeStore.setState(state);
      return;
    }
    case PRIVATE_PRO_VAULT_SETTINGS_AI_ID: {
      const { group: _group, ...state } = parsed;
      useAIPreferencesStore.setState(state);
      return;
    }
    case PRIVATE_PRO_VAULT_SETTINGS_UI_ID: {
      const { group: _group, ...state } = parsed;
      useUIPreferencesStore.setState(state);
      return;
    }
    case PRIVATE_PRO_VAULT_SETTINGS_UX_LABS_ID: {
      const { group: _group, ...state } = parsed;
      useUXLabsStore.setState(state);
      return;
    }
    case PRIVATE_PRO_VAULT_SETTINGS_BEAM_ID: {
      const { group: _group, ...state } = parsed;
      useModuleBeamStore.setState(state);
      return;
    }
    case PRIVATE_PRO_VAULT_SETTINGS_BROWSING_ID: {
      const { group: _group, ...state } = parsed;
      useBrowseStore.setState(state);
      return;
    }
    case PRIVATE_PRO_VAULT_SETTINGS_IMAGE_ID: {
      const { group: _group, ...state } = parsed;
      useT2IStore.setState({ ...state, hasInitializedLlms: true });
      return;
    }
    case PRIVATE_PRO_VAULT_SETTINGS_FOLDERS_ID: {
      const { group: _group, ...state } = parsed;
      useFolderStore.setState(state);
      return;
    }
  }
}

export function privateProPortableAppSettingsReset(group: PrivateProPortableAppSettings['group']): void {
  switch (group) {
    case PRIVATE_PRO_VAULT_SETTINGS_CALL_ID: useAppCallStore.setState(callState(useAppCallStore.getInitialState())); return;
    case PRIVATE_PRO_VAULT_SETTINGS_CHAT_ID: useAppChatStore.setState(chatState(useAppChatStore.getInitialState())); return;
    case PRIVATE_PRO_VAULT_SETTINGS_PURPOSES_ID: usePurposeStore.setState(purposesState(usePurposeStore.getInitialState())); return;
    case PRIVATE_PRO_VAULT_SETTINGS_AI_ID: useAIPreferencesStore.setState(aiState(useAIPreferencesStore.getInitialState())); return;
    case PRIVATE_PRO_VAULT_SETTINGS_UI_ID: useUIPreferencesStore.setState(uiState(useUIPreferencesStore.getInitialState())); return;
    case PRIVATE_PRO_VAULT_SETTINGS_UX_LABS_ID: useUXLabsStore.setState(uxLabsState(useUXLabsStore.getInitialState())); return;
    case PRIVATE_PRO_VAULT_SETTINGS_BEAM_ID: useModuleBeamStore.setState(beamState(useModuleBeamStore.getInitialState())); return;
    case PRIVATE_PRO_VAULT_SETTINGS_BROWSING_ID: useBrowseStore.setState(browsingState(useBrowseStore.getInitialState())); return;
    case PRIVATE_PRO_VAULT_SETTINGS_IMAGE_ID: useT2IStore.setState({ ...imageState(useT2IStore.getInitialState()), hasInitializedLlms: false }); return;
    case PRIVATE_PRO_VAULT_SETTINGS_FOLDERS_ID: useFolderStore.setState(foldersState(useFolderStore.getInitialState())); return;
  }
}

export function privateProPortableAppSettingsSubscribe(listener: () => void): () => void {
  const unsubscribers = [
    subscribeProjected(useAppCallStore, callState, listener),
    subscribeProjected(useAppChatStore, chatState, listener),
    subscribeProjected(usePurposeStore, purposesState, listener),
    subscribeProjected(useAIPreferencesStore, aiState, listener),
    subscribeProjected(useUIPreferencesStore, uiState, listener),
    subscribeProjected(useUXLabsStore, uxLabsState, listener),
    subscribeProjected(useModuleBeamStore, beamState, listener),
    subscribeProjected(useBrowseStore, browsingState, listener),
    subscribeProjected(useT2IStore, imageState, listener),
    subscribeProjected(useFolderStore, foldersState, listener),
  ];
  return () => unsubscribers.forEach(unsubscribe => unsubscribe());
}
