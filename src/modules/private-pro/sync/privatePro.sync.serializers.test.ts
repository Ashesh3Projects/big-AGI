import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  chatSyncExists,
  chatSyncResetAll,
  chatSyncSnapshot,
  chatSyncUpsert,
} from '~/common/stores/chat/store-chats';
import {
  createPrivateProSyncSerializers,
  privateProSyncChatProjection,
  type PrivateProSyncSerializedRecord,
} from './privatePro.sync.serializers';


function conversationFixture() {
  return {
    id: 'chat-1',
    messages: [
      { id: 'message-1', role: 'user' as const, fragments: [], tokenCount: 3, created: 10, updated: 10 },
      { id: 'message-2', role: 'assistant' as const, fragments: [], tokenCount: 5, created: 20, updated: 20 },
    ],
    systemPurposeId: 'default',
    tokenCount: 8,
    created: 1,
    updated: 20,
    _abortController: null,
  };
}

function metaRecord(conversationId: string): PrivateProSyncSerializedRecord {
  return {
    recordType: 'chat-meta',
    logicalId: conversationId,
    projectionKey: conversationId,
    schemaVersion: 1,
    value: { conversationId, systemPurposeId: 'default', created: 1, updated: 20 },
    referencedAssetIds: [],
  };
}

function messageRecord(conversationId: string, messageId: string, created: number): PrivateProSyncSerializedRecord {
  return {
    recordType: 'chat-message',
    logicalId: `${conversationId}\0${messageId}`,
    projectionKey: conversationId,
    schemaVersion: 1,
    value: {
      conversationId,
      message: { id: messageId, role: 'assistant', fragments: [], tokenCount: 2, created, updated: created },
    },
    referencedAssetIds: [],
  };
}

async function snapshotChatRecords() {
  const serializers = createPrivateProSyncSerializers();
  const chatSerializers = serializers.filter(serializer => serializer.recordType === 'chat-meta' || serializer.recordType === 'chat-message');
  return (await Promise.all(chatSerializers.map(serializer => serializer.snapshot()))).flat();
}

async function resetChat(): Promise<void> {
  await privateProSyncChatProjection.remove('chat-1');
  chatSyncResetAll();
}

afterEach(resetChat);

describe('Private Pro sync serializers', () => {
  test('splits one conversation into one metadata record and finalized message records', async () => {
    await resetChat();
    chatSyncUpsert(conversationFixture());

    const records = await snapshotChatRecords();

    assert.deepEqual(records.filter(record => record.projectionKey === 'chat-1').map(record => record.recordType), ['chat-meta', 'chat-message', 'chat-message']);
  });

  test('materializes messages when listener delivery arrives before metadata', async () => {
    await resetChat();
    await privateProSyncChatProjection.stage(messageRecord('chat-1', 'message-2', 20));
    assert.equal(chatSyncExists('chat-1'), false);

    await privateProSyncChatProjection.stage(metaRecord('chat-1'));
    assert.deepEqual(chatSyncSnapshot()[0].messages.map(message => message.id), ['message-2']);
  });

  test('merges concurrent message IDs deterministically', async () => {
    await resetChat();
    await privateProSyncChatProjection.stage(metaRecord('chat-1'));
    await privateProSyncChatProjection.stage(messageRecord('chat-1', 'b', 10));
    await privateProSyncChatProjection.stage(messageRecord('chat-1', 'a', 10));

    assert.deepEqual(chatSyncSnapshot()[0].messages.map(message => message.id), ['a', 'b']);
  });

  test('rematerializes token counts after a message removal', async () => {
    await resetChat();
    await privateProSyncChatProjection.stage(metaRecord('chat-1'));
    await privateProSyncChatProjection.stage(messageRecord('chat-1', 'message-1', 10));
    await privateProSyncChatProjection.stage(messageRecord('chat-1', 'message-2', 20));
    await privateProSyncChatProjection.removeMessage('chat-1', 'message-1');

    assert.deepEqual(chatSyncSnapshot()[0].messages.map(message => message.id), ['message-2']);
    assert.equal(chatSyncSnapshot()[0].tokenCount, 2);
  });

  test('replaces a chat projection without retaining absent messages', async () => {
    await resetChat();
    await privateProSyncChatProjection.apply('chat-1', [metaRecord('chat-1'), messageRecord('chat-1', 'message-1', 10), messageRecord('chat-1', 'message-2', 20)]);
    await privateProSyncChatProjection.apply('chat-1', [metaRecord('chat-1'), messageRecord('chat-1', 'message-2', 20)]);

    assert.deepEqual(chatSyncSnapshot()[0].messages.map(message => message.id), ['message-2']);
  });

  test('includes every existing portable state family and accepts future serializers', () => {
    const extra = {
      recordType: 'asset' as const,
      schemaVersion: 1,
      conflictPolicy: 'replace' as const,
      snapshot: async () => [],
      validate: async (_logicalId: string, value: unknown) => value,
      subscribe: () => () => {},
    };
    const serializers = createPrivateProSyncSerializers([extra]);

    assert.deepEqual(serializers.map(serializer => serializer.recordType), [
      'credential-service', 'model-service', 'settings', 'chat-meta', 'chat-message', 'persona', 'folder', 'scratch', 'asset',
    ]);
  });
});
