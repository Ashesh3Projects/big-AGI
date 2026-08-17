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
} as const;


test('portable serializer registry includes only explicit portable state', async () => {
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
    { speechVaultApply },
    { shareVaultApply },
  ] = await Promise.all([
    import('./privatePro.vault.serializers'),
    import('./privatePro.vault.crypto'),
    import('../../../common/stores/llms/store-llms'),
    import('../../../common/stores/chat/store-chats'),
    import('../../../apps/personas/store-app-personas'),
    import('../../../common/stores/folders/store-chat-folders'),
    import('../../../common/layout/optima/scratchclip/store-scratchclip'),
    import('../../google/store-module-google'),
    import('./serializers/settings'),
    import('../../trade/link/store-share-link'),
  ]);

  useModelsStore.setState({
    sources: [{
      id: 'openai',
      label: 'OpenAI compatible',
      vId: 'openai',
      setup: { oaiKey: INCLUDED.providerKey, oaiHost: INCLUDED.providerEndpoint },
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
      parameterSpecs: [],
      initialParameters: { llmRef: 'upstream-model' },
      userParameters: { llmTemperature: 0.73, llmRef: INCLUDED.customParameter },
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
  speechVaultApply({
    asrx: { engines: {}, activeEngineId: null },
    speex: {
      engines: {
        'speech-portable': {
          engineId: 'speech-portable', vendorType: 'elevenlabs', label: 'Speech', isAutoDetected: false,
          isAutoLinked: false, isDeleted: false, credentials: { type: 'api-key', apiKey: INCLUDED.speechKey },
          voice: { dialect: 'elevenlabs', ttsVoiceId: 'voice' }, createdAt: 1, updatedAt: 2,
        },
      },
      activeEngineId: 'speech-portable',
      ttsCharLimit: 4096,
    },
  });
  shareVaultApply({
    chatLinkItems: [{
      chatTitle: 'Shared', objectId: 'share-portable', createdAt: '2026-08-17T00:00:00.000Z',
      expiresAt: null, deletionKey: INCLUDED.shareDeletionKey,
    }],
  });

  const masterKey = await importVaultMasterKey(generateVaultMasterKeyBytes());
  const identifierKey = await deriveVaultSubkey(masterKey, 'record-identifiers', 'portable-state', ['sign']);
  const serializers = createPrivateProVaultSerializers(identifierKey);
  const snapshot = (await Promise.all(serializers.map(async serializer => ({
    recordType: serializer.recordType,
    records: await serializer.snapshot(),
  })))).flatMap(group => group.records.map(record => ({ ...group, ...record })));
  const json = JSON.stringify(snapshot);

  for (const sentinel of Object.values(INCLUDED))
    assert.equal(json.includes(sentinel), true, `expected portable sentinel ${sentinel}`);
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
