import assert from 'node:assert/strict';
import test from 'node:test';


const INCLUDED = {
  providerKey: 'sentinel-provider-api-key',
  providerEndpoint: 'https://sentinel-provider.example/v1',
  customModel: 'sentinel-custom-model',
  customParameter: 'sentinel-custom-parameter',
  theme: 'dark',
  googleKey: 'sentinel-google-key',
  speechKey: 'sentinel-speech-key',
  shareDeletionKey: 'sentinel-share-deletion-key',
  chatConfig: 'sentinel-chat-config',
  purpose: 'sentinel-purpose-config',
  aiPreference: 'resolve',
  uiLanguage: 'sentinel-ui-language',
  beam: 'sentinel-beam-preset',
  browsing: 'wss://sentinel-browse.example/socket',
  image: 'sentinel-image-engine',
  chat: 'sentinel-portable-chat',
  persona: 'sentinel-portable-persona',
  folder: 'sentinel-portable-folder',
  scratch: 'sentinel-scratch-clip',
} as const;

const EXCLUDED = {
  firebaseToken: 'sentinel-firebase-token',
  deviceId: 'sentinel-device-id',
  logger: 'sentinel-logger-data',
  metric: 'sentinel-metric-data',
  fileHandle: 'sentinel-file-handle',
  abortController: 'sentinel-abort-controller',
  incognito: 'sentinel-incognito-chat',
  incomplete: 'sentinel-incomplete-message',
  pane: 'sentinel-pane-state',
  modal: 'sentinel-modal-state',
  nestedSetup: 'sentinel-nested-setup-token',
  nestedAsrx: 'sentinel-nested-asrx-session',
  nestedSpeex: 'sentinel-nested-speex-metrics',
  nestedBenchmark: 'sentinel-nested-benchmark',
  nestedPricing: 'sentinel-nested-pricing',
  nestedParameterSpec: 'sentinel-nested-parameter-spec',
  nestedInitialParameter: 'sentinel-nested-initial-parameter',
  nestedUserPricing: 'sentinel-nested-user-pricing',
  nestedUserParameter: 'sentinel-nested-user-parameter',
  beamOpen: 'sentinel-open-beam-conversation',
  uiInspector: 'sentinel-ui-inspector',
} as const;

const CURRENT_SERVICE_SETUP_FIELDS = {
  alibabaOaiKey: 'alibaba-key', alibabaOaiHost: 'https://alibaba.example',
  anthropicKey: 'anthropic-key', anthropicHost: 'https://anthropic.example', inferenceGeoUS: true,
  azureEndpoint: 'https://azure.example', azureKey: 'azure-key',
  bedrockBearerToken: 'bedrock-bearer', bedrockAccessKeyId: 'bedrock-access', bedrockSecretAccessKey: 'bedrock-secret', bedrockSessionToken: 'bedrock-session', bedrockRegion: 'us-east-1',
  cerebrasKey: 'cerebras-key', cohereKey: 'cohere-key', cohereHost: 'https://cohere.example', deepseekKey: 'deepseek-key', deepseekHost: 'https://deepseek.example',
  geminiKey: 'gemini-key', geminiHost: 'https://gemini.example', minSafetyLevel: 'BLOCK_LOW_AND_ABOVE', groqKey: 'groq-key',
  localAIHost: 'http://localai.example', localAIKey: 'localai-key', mode: 'selfhosted', modularKey: 'modular-key', modularHost: 'https://modular.example', moonshotKey: 'moonshot-key',
  nvidiaKey: 'nvidia-key', nvidiaHost: 'https://nvidia.example', oaiKey: INCLUDED.providerKey, oaiOrg: 'sentinel-openai-org', oaiHost: INCLUDED.providerEndpoint,
  ollamaHost: 'http://ollama.example', perplexityKey: 'perplexity-key', requireParameters: true, sakanaKey: 'sakana-key', sakanaHost: 'https://sakana.example',
  togetherKey: 'together-key', togetherHost: 'https://together.example', togetherFreeTrial: true, xaiKey: 'xai-key', zaiKey: 'zai-key', zaiHost: 'https://zai.example', csf: true,
} as const;


test('portable serializer registry reconstructs every explicit portable group on PC B', async () => {
  const localStorageValues = new Map<string, string>([['joy-mode', INCLUDED.theme]]);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => localStorageValues.get(key) ?? null,
      setItem: (key: string, value: string) => localStorageValues.set(key, value),
      removeItem: (key: string) => localStorageValues.delete(key),
    },
  });

  const [
    { createPrivateProVaultSerializers },
    { deriveVaultSubkey, generateVaultMasterKeyBytes, importVaultMasterKey },
    { useModelsStore },
    { chatSyncResetAll, chatSyncUpsert },
    { personaSyncResetAll, personaSyncUpsert },
    { folderVaultApply, folderVaultResetAll },
    { scratchClipVaultApply, scratchClipVaultReset },
    { googleVaultApply },
    { useASRxStore },
    { useSpeexStore },
    { shareVaultApply },
    { useAppCallStore },
    { setIsNotificationEnabledForModel },
    { usePurposeStore },
    { useAIPreferencesStore },
    { useUIPreferencesStore },
    { useUXLabsStore },
    { useModuleBeamStore },
    { useBrowseStore },
    { useT2IStore },
  ] = await Promise.all([
    import('./privatePro.vault.serializers'),
    import('./privatePro.vault.crypto'),
    import('../../../common/stores/llms/store-llms'),
    import('../../../common/stores/chat/store-chats'),
    import('../../../apps/personas/store-app-personas'),
    import('../../../common/stores/folders/store-chat-folders'),
    import('../../../common/layout/optima/scratchclip/store-scratchclip'),
    import('../../google/store-module-google'),
    import('../../asrx/store-module-asrx'),
    import('../../speex/store-module-speex'),
    import('../../trade/link/store-share-link'),
    import('../../../apps/call/state/store-app-call'),
    import('../../../apps/chat/store-app-chat'),
    import('../../../apps/chat/components/persona-selector/store-purposes'),
    import('../../../common/stores/store-ai'),
    import('../../../common/stores/store-ui'),
    import('../../../common/stores/store-ux-labs'),
    import('../../beam/store-module-beam'),
    import('../../browse/store-module-browsing'),
    import('../../t2i/store-module-t2i'),
  ]);

  const { setPrivateProEncryptedPersistenceActive, privateProPortableLocalStorage } = await import('../persistence/privatePro.persistence');
  setPrivateProEncryptedPersistenceActive(true);
  privateProPortableLocalStorage.setItem('joy-mode', INCLUDED.theme);

  useModelsStore.setState({
    sources: [{
      id: 'openai',
      label: 'OpenAI compatible',
      vId: 'openai',
      setup: {
        ...CURRENT_SERVICE_SETUP_FIELDS,
        runtime: { firebaseToken: EXCLUDED.nestedSetup },
      },
      firebaseToken: EXCLUDED.firebaseToken,
      loggerData: EXCLUDED.logger,
    } as never],
    llms: [{
      id: INCLUDED.customModel,
      label: 'Custom model',
      created: 1,
      description: '',
      hidden: false,
      contextTokens: 128000,
      maxOutputTokens: 4096,
      interfaces: ['oai-chat'],
      benchmark: { cbaElo: 1337, runtime: { logs: EXCLUDED.nestedBenchmark } },
      pricing: {
        chat: {
          input: [{ upTo: 100000, price: 1.25 }, { upTo: null, price: 'free' }],
          output: 4.5,
          cache: { cType: 'ant-bp', read: 0.1, write: 0.2, duration: 300 },
          _isFree: false,
          metrics: EXCLUDED.nestedPricing,
        },
      },
      parameterSpecs: [{
        paramId: 'llmVndOaiEffort', required: true, hidden: false, initialValue: 'high', enumValues: ['low', 'medium', 'high'],
        runtime: { deviceId: EXCLUDED.nestedParameterSpec },
      }, {
        paramId: 'llmVndGeminiThinkingBudget', rangeOverride: [0, 24576],
      }],
      initialParameters: {
        llmRef: 'upstream-model', llmTemperature: 0.5, llmResponseTokens: 4096, llmVndOaiEffort: 'medium',
        runtime: { token: EXCLUDED.nestedInitialParameter },
      },
      userPricing: {
        chat: { input: 'free', output: 8, cache: { cType: 'oai-ac', read: 0.25 }, runtime: EXCLUDED.nestedUserPricing },
      },
      userParameters: {
        llmTemperature: 0.73, llmRef: INCLUDED.customParameter, llmForceNoStream: true, llmVndGeminiGoogleSearch: '1w',
        runtime: { logger: EXCLUDED.nestedUserParameter },
      },
      sId: 'openai',
      vId: 'openai',
      deviceId: EXCLUDED.deviceId,
    } as never],
    modelAssignments: {},
    confServiceId: null,
  });

  chatSyncResetAll();
  const completeConversation = {
    id: 'chat-portable',
    messages: [{
      id: 'message-portable',
      role: 'assistant',
      fragments: [{ ft: 'content', fId: 'fragment-portable', part: { pt: 'text', text: INCLUDED.chat } }],
      generator: { mgt: 'named', name: 'web', metrics: { sentinel: EXCLUDED.metric } },
      tokenCount: 3,
      created: 1,
      updated: 2,
    }],
    systemPurposeId: 'purpose-default',
    tokenCount: 3,
    created: 1,
    updated: 2,
    _abortController: Object.assign(new AbortController(), { sentinel: EXCLUDED.abortController }),
    fileHandle: { name: EXCLUDED.fileHandle },
    paneState: EXCLUDED.pane,
    modalState: EXCLUDED.modal,
  };
  chatSyncUpsert(completeConversation as never);
  chatSyncUpsert({
    ...structuredClone(completeConversation),
    id: 'chat-incognito',
    _isIncognito: true,
    _abortController: null,
    messages: [{ ...structuredClone(completeConversation.messages[0]), fragments: [{ ft: 'content', fId: 'incognito', part: { pt: 'text', text: EXCLUDED.incognito } }] }],
  } as never);
  chatSyncUpsert({
    ...structuredClone(completeConversation),
    id: 'chat-incomplete',
    _abortController: null,
    messages: [{ ...structuredClone(completeConversation.messages[0]), pendingIncomplete: true, fragments: [{ ft: 'content', fId: 'incomplete', part: { pt: 'text', text: EXCLUDED.incomplete } }] }],
  } as never);

  personaSyncResetAll();
  personaSyncUpsert({
    id: 'persona-portable',
    name: INCLUDED.persona,
    systemPrompt: 'Be precise.',
    creationDate: '2026-08-17T00:00:00.000Z',
    inputText: 'source',
  });

  folderVaultResetAll();
  folderVaultApply({ id: 'folder-portable', title: INCLUDED.folder, conversationIds: ['chat-portable'], color: '#123456' });
  scratchClipVaultReset();
  scratchClipVaultApply({ history: [{ id: 'clip-portable', text: INCLUDED.scratch, timestamp: 1, source: 'textarea' }] });
  googleVaultApply({ googleCloudApiKey: INCLUDED.googleKey, googleCSEId: 'sentinel-cse', restrictToDomain: 'example.com' });
  useASRxStore.setState({
      engines: {
        'asrx-portable': {
          engineId: 'asrx-portable', vendorType: 'deepgram', label: 'Transcription', isAutoDetected: false,
          isAutoLinked: false, isDeleted: false,
          credentials: { type: 'api-key', apiKey: 'sentinel-asrx-key', apiHost: 'https://sentinel-asrx.example', session: EXCLUDED.nestedAsrx },
          profile: { dialect: 'deepgram', asrModel: 'nova-3', language: 'en', smartFormat: true, runtime: { deviceId: EXCLUDED.deviceId } },
          createdAt: 1, updatedAt: 2,
          authSession: EXCLUDED.nestedAsrx,
        },
      },
      activeEngineId: 'asrx-portable',
      hasInitializedLlms: true,
  } as never);
  useSpeexStore.setState({
      engines: {
        'speech-portable': {
          engineId: 'speech-portable', vendorType: 'elevenlabs', label: 'Speech', isAutoDetected: false,
          isAutoLinked: false, isDeleted: false, credentials: { type: 'api-key', apiKey: INCLUDED.speechKey },
          voice: { dialect: 'elevenlabs', ttsVoiceId: 'voice', logs: EXCLUDED.nestedSpeex },
          metrics: { value: EXCLUDED.nestedSpeex }, createdAt: 1, updatedAt: 2,
        },
      },
      activeEngineId: 'speech-portable',
      ttsCharLimit: 4096,
      hasInitializedLlms: true,
  } as never);
  shareVaultApply({
    chatLinkItems: [{
      chatTitle: 'Shared', objectId: 'share-portable', createdAt: '2026-08-17T00:00:00.000Z',
      expiresAt: null, deletionKey: INCLUDED.shareDeletionKey,
    }],
  });
  useAppCallStore.setState({ grayUI: true, showConversations: false, showSupport: false });
  setIsNotificationEnabledForModel(INCLUDED.chatConfig, true);
  usePurposeStore.setState({ hiddenPurposeIDs: [INCLUDED.purpose] });
  useAIPreferencesStore.setState({ vndAntInlineFiles: 'inline-file-and-delete', vndGeminiVertexLinks: INCLUDED.aiPreference });
  useUIPreferencesStore.setState({
    preferredLanguage: INCLUDED.uiLanguage,
    centerMode: 'wide',
    complexityMode: 'extra',
    contentScaling: 'md',
    disableMarkdown: true,
    doubleClickToEdit: true,
    enterIsNewline: true,
    messageFullWidth: true,
    renderCodeLineNumbers: true,
    renderCodeSoftWrap: true,
    showPersonaFinder: true,
    showModelsFn: true,
    showModelsHidden: false,
    showModelsStarredOnly: true,
    modelsStarredOnTop: false,
    composerQuickButton: 'call',
    aixInspector: true,
    dismissals: { portable: true },
    actionCounters: { portable: 7 },
    panelGroupCollapseStates: { [EXCLUDED.uiInspector]: true },
  });
  useUXLabsStore.setState({
    labsHighPerformance: true,
    labsAutoHideComposer: true,
    labsShowShortcutBar: false,
    labsComposerAttachmentsInline: true,
    labsLosslessImages: true,
    labsSingleDollarLatex: true,
  });
  useModuleBeamStore.setState({
    presets: [{ id: 'beam-preset', name: INCLUDED.beam, rayLlmIds: ['model-a'], gatherFactoryId: 'fuse', gatherLlmId: 'model-b' }],
    lastConfig: { id: 'current', name: INCLUDED.beam, rayLlmIds: ['model-a'] },
    cardAdd: false,
    cardScrolling: true,
    scatterShowLettering: true,
    scatterShowPrevMessages: true,
    gatherAutoStartAfterScatter: true,
    gatherShowAllPrompts: true,
    openBeamConversationIds: { [EXCLUDED.beamOpen]: true },
  });
  useBrowseStore.setState({
    wssEndpoint: INCLUDED.browsing,
    pageTransform: 'markdown',
    enableComposerAttach: false,
    enableReactTool: false,
    enablePersonaTool: false,
  });
  useT2IStore.setState({
    engines: {
      [INCLUDED.image]: {
        engineId: INCLUDED.image,
        vendorType: 'openrouter',
        label: 'Portable image engine',
        isAutoDetected: false,
        isAutoLinked: true,
        isDeleted: false,
        credentials: { type: 'llms-service', serviceId: 'openrouter' },
        profile: { dialect: 'openrouter', imageModelId: 'google/gemini-3-pro-image' },
        createdAt: 1,
        updatedAt: 2,
      },
    },
    activeEngineId: INCLUDED.image,
    hasInitializedLlms: true,
  });

  const masterKey = await importVaultMasterKey(generateVaultMasterKeyBytes());
  const identifierKey = await deriveVaultSubkey(masterKey, 'record-identifiers', 'portable-state', ['sign']);
  const serializers = createPrivateProVaultSerializers(identifierKey);
  const snapshot = (await Promise.all(serializers.map(async serializer => ({
    recordType: serializer.recordType,
    records: await serializer.snapshot(),
  })))).flatMap(group => group.records.map(record => ({ ...group, ...record })));
  const json = JSON.stringify(snapshot);

  const modelSerializer = serializers.find(serializer => serializer.recordType === 'model-service');
  const modelRecord = snapshot.find(record => record.recordType === 'model-service');
  assert(modelSerializer && modelRecord);
  const crossServiceValue = structuredClone(modelRecord.value) as { serviceId: string; models: Array<{ sId: string }> };
  crossServiceValue.models[0].sId = 'other-service';
  await assert.rejects(modelSerializer.apply(modelRecord.recordId, crossServiceValue), /serviceId|service ID/);

  for (const sentinel of Object.values(INCLUDED))
    assert.equal(json.includes(sentinel), true, `expected portable sentinel ${sentinel}`);
  for (const value of Object.values(CURRENT_SERVICE_SETUP_FIELDS))
    assert.equal(json.includes(String(value)), true, `expected current model service setup value ${value}`);
  for (const value of ['1337', '100000', '1.25', '4.5', 'ant-bp', '0.1', '0.2', '300', 'llmVndOaiEffort', 'high', 'llmVndGeminiThinkingBudget', '24576', '4096', 'medium', 'oai-ac', '0.25', 'llmForceNoStream', 'llmVndGeminiGoogleSearch', '1w'])
    assert.equal(json.includes(value), true, `expected legitimate model nested value ${value}`);
  for (const sentinel of Object.values(EXCLUDED))
    assert.equal(json.includes(sentinel), false, `unexpected non-portable sentinel ${sentinel}`);

  assert(snapshot.length > 0);
  for (const record of snapshot) {
    assert.match(record.recordId, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(record.recordId.includes('openai'), false);
    assert.equal(record.recordId.includes('chat-portable'), false);
  }
  const openAiCredentialId = snapshot.find(record => record.recordType === 'credential-service')?.recordId;
  const openAiModelId = snapshot.find(record => record.recordType === 'model-service')?.recordId;
  assert(openAiCredentialId && openAiModelId);
  assert.notEqual(openAiCredentialId, openAiModelId, 'record families must be domain-separated');

  const roundTripRecords = await Promise.all(serializers.map(serializer => serializer.snapshot()));
  for (let index = 0; index < serializers.length; index++) {
    const serializer = serializers[index];
    const records = roundTripRecords[index];
    for (const record of records)
      await serializer.remove(record.recordId);
  }
  const removedJson = JSON.stringify(await Promise.all(serializers.map(serializer => serializer.snapshot())));
  for (const sentinel of Object.values(INCLUDED))
    assert.equal(removedJson.includes(sentinel), false, `removed portable sentinel ${sentinel}`);
  for (let index = 0; index < serializers.length; index++) {
    const serializer = serializers[index];
    const records = roundTripRecords[index];
    for (const record of records)
      await serializer.apply(record.recordId, structuredClone(record.value));
  }
  for (let index = 0; index < serializers.length; index++) {
    const serializer = serializers[index];
    const records = roundTripRecords[index];
    const actual = await serializer.snapshot();
    assert.deepEqual([...actual].sort((a, b) => a.recordId.localeCompare(b.recordId)), [...records].sort((a, b) => a.recordId.localeCompare(b.recordId)));
  }
});
