import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  personaSyncDelete,
  personaSyncSnapshot,
  personaSyncUpsert,
  type SimplePersona,
} from '../../../apps/personas/store-app-personas';
import { createDConversation, type DConversation } from '~/common/stores/chat/chat.conversation';
import { createDMessageTextContent } from '~/common/stores/chat/chat.message';
import { chatSyncDelete, chatSyncSnapshot, chatSyncUpsert, useChatStore } from '~/common/stores/chat/store-chats';

import {
  parseSyncConversation,
  parseSyncPersona,
  serializeSyncConversation,
  serializeSyncPersona,
} from './privatePro.sync.serialize';


function createConversation(): DConversation {
  const conversation = createDConversation();
  conversation.id = 'chat-1';
  conversation.userTitle = 'Test chat';
  conversation.messages = [createDMessageTextContent('user', 'hello')];
  conversation.messages[0].id = 'message-1';
  conversation.messages[0].updated = 100;
  conversation.created = 10;
  conversation.updated = 100;
  return conversation;
}

const PERSONA: SimplePersona = {
  id: 'persona-1',
  name: 'Architect',
  systemPrompt: 'Be precise.',
  creationDate: '2026-08-16T00:00:00.000Z',
  inputText: 'Source notes',
  llmLabel: 'Model',
  inputProvenance: { type: 'text' },
};


describe('private Pro sync serialization', () => {
  test('excludes incognito conversations', () => {
    const conversation = createConversation();
    conversation._isIncognito = true;

    assert.equal(serializeSyncConversation(conversation), null);
  });

  test('waits for incomplete generations to finish', () => {
    const conversation = createConversation();
    conversation.messages[0].pendingIncomplete = true;

    assert.equal(serializeSyncConversation(conversation), null);
  });

  test('strips transient and unrelated local fields', () => {
    const conversation = createConversation() as DConversation & {
      apiKey?: string;
      modelSettings?: object;
      scratchClip?: object;
    };
    conversation._abortController = new AbortController();
    conversation.apiKey = 'secret-key';
    conversation.modelSettings = { temperature: 2 };
    conversation.scratchClip = { history: ['private note'] };

    const serialized = serializeSyncConversation(conversation);
    assert.notEqual(serialized, null);
    const json = JSON.stringify(serialized);

    assert.equal(json.includes('secret-key'), false);
    assert.equal(json.includes('modelSettings'), false);
    assert.equal(json.includes('scratchClip'), false);
    assert.equal(json.includes('_abortController'), false);
    assert.equal(json.includes('pendingIncomplete'), false);

    const parsed = parseSyncConversation(serialized);
    assert.equal(parsed._abortController, null);
    assert.equal(parsed.messages[0].pendingIncomplete, undefined);
    assert.equal(parsed.userTitle, 'Test chat');
  });

  test('round-trips an explicitly shaped persona', () => {
    const serialized = serializeSyncPersona({ ...PERSONA, apiKey: 'secret' } as SimplePersona & { apiKey: string });
    assert.equal(JSON.stringify(serialized).includes('secret'), false);
    assert.deepEqual(parseSyncPersona(serialized), PERSONA);
  });
});
describe('private Pro store adapters', () => {
  test('exposes only eligible chat snapshots and explicit remote mutations', () => {
    const eligible = createConversation();
    eligible.id = 'sync-eligible';
    const incognito = createConversation();
    incognito.id = 'sync-incognito';
    incognito._isIncognito = true;
    const incomplete = createConversation();
    incomplete.id = 'sync-incomplete';
    incomplete.messages[0].pendingIncomplete = true;

    useChatStore.setState(state => ({
      conversations: [eligible, incognito, incomplete, ...state.conversations],
    }));

    assert.deepEqual(chatSyncSnapshot().filter(c => c.id.startsWith('sync-')).map(c => c.id), ['sync-eligible']);

    chatSyncDelete(eligible.id);
    chatSyncDelete(incognito.id);
    chatSyncDelete(incomplete.id);
    assert.equal(chatSyncSnapshot().some(c => c.id === eligible.id), false);
  });

  test('upserts and deletes personas by stable ID', () => {
    personaSyncUpsert(PERSONA);
    personaSyncUpsert({ ...PERSONA, name: 'Updated' });

    assert.equal(personaSyncSnapshot().find(persona => persona.id === PERSONA.id)?.name, 'Updated');

    personaSyncDelete(PERSONA.id);
    assert.equal(personaSyncSnapshot().some(persona => persona.id === PERSONA.id), false);
  });
});
