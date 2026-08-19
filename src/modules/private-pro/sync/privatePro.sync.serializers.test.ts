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
import { SyncChatMessageSchema } from './privatePro.sync.schemas';
import { createPrivateProAssetSerializer } from './serializers/asset';
import type { PrivateProAssetLocalPort } from '../assets/privatePro.assets.local';
import type { PrivateProAssetManifest } from '../assets/privatePro.assets.schemas';


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
  test('snapshots validated UID-local asset manifests with asset projection identity', async () => {
    const manifest = {
      formatVersion: 1, schemaVersion: 1, uid: 'uid-a', assetId: 'asset-1', contentGeneration: 1, assetType: 'image', contextId: 'global', scopeId: 'app-chat',
      label: 'asset', origin: { ot: 'user', source: 'attachment', media: 'file-open' }, createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:00:00.000Z',
      metadata: { width: 1, height: 1 }, objects: { original: { objectId: 'original', kind: 'original', mimeType: 'image/png', byteSize: 1, sha256: 'a'.repeat(64) } },
    } as PrivateProAssetManifest;
    const local = {
      listManifests: async () => [manifest],
      putManifest: async () => {}, deleteManifest: async () => {}, subscribe: () => () => {},
    } as unknown as PrivateProAssetLocalPort;
    const serializer = createPrivateProAssetSerializer('uid-a', local);

    assert.deepEqual(await serializer.snapshot(), [{
      recordType: 'asset', logicalId: 'asset-1', projectionKey: 'asset-1', schemaVersion: 1,
      value: manifest, referencedAssetIds: ['asset-1'],
    }]);
    assert.deepEqual(serializer.project('asset-1', await serializer.validate('asset-1', manifest)), {
      projectionKey: 'asset-1', referencedAssetIds: ['asset-1'],
    });
  });

  test('recovers the asset subscription queue after a transient list failure', async () => {
    const manifest = {
      formatVersion: 1, schemaVersion: 1, uid: 'uid-a', assetId: 'asset-recovery', contentGeneration: 1, assetType: 'image', contextId: 'global', scopeId: 'app-chat',
      label: 'asset', origin: { ot: 'user', source: 'attachment', media: 'file-open' }, createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:00:00.000Z',
      metadata: { width: 1, height: 1 }, objects: { original: { objectId: 'original', kind: 'original', mimeType: 'image/png', byteSize: 1, sha256: 'a'.repeat(64) } },
    } as PrivateProAssetManifest;
    let listener!: () => Promise<void> | void;
    let calls = 0;
    const local = {
      listManifests: async () => { if (calls++ === 1) throw new Error('transient'); return calls >= 3 ? [manifest] : []; },
      putManifest: async () => {}, deleteManifest: async () => {}, subscribe: (value: () => Promise<void> | void) => { listener = value; return () => {}; },
    } as unknown as PrivateProAssetLocalPort;
    const serializer = createPrivateProAssetSerializer('uid-a', local);
    const mutations: PrivateProSyncLocalMutation[] = [];
    serializer.subscribe(mutation => mutations.push(mutation));
    await new Promise(resolve => setImmediate(resolve));

    await assert.rejects(Promise.resolve(listener()));
    await listener();

    assert.deepEqual(mutations.map(mutation => mutation.kind === 'put' ? mutation.record.logicalId : mutation.logicalId), ['asset-recovery']);
  });
  test('derives trusted projection metadata after validating remote values', async () => {
    const serializer = createPrivateProSyncSerializers().find(candidate => candidate.recordType === 'chat-message');
    if (!serializer) assert.fail('Expected the chat message serializer.');
    const value = SyncChatMessageSchema.parse({
      conversationId: 'chat-1',
      message: { id: 'message-1', role: 'user', fragments: [], tokenCount: 0, created: 1, updated: null },
    });

    assert.deepEqual(serializer.project('chat-1\0message-1', value), {
      projectionKey: 'chat-1',
      referencedAssetIds: [],
    });
  });

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

  test('stages a message before metadata without changing an existing conversation', async () => {
    await resetChat();
    chatSyncUpsert(conversationFixture());
    const before = chatSyncSnapshot();

    await privateProSyncChatProjection.stage(messageRecord('chat-1', 'remote-message', 30));

    assert.deepEqual(chatSyncSnapshot(), before);
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
      snapshot: () => [],
      validate: async (_logicalId: string, value: unknown) => value,
      project: (logicalId: string) => ({ projectionKey: logicalId, referencedAssetIds: [] }),
      projection: { apply: async () => {}, remove: async () => {} },
      subscribe: () => () => {},
    };
    const serializers = createPrivateProSyncSerializers([extra]);

    assert.deepEqual(serializers.map(serializer => serializer.recordType), [
      'credential-service', 'model-service', 'settings', 'chat-meta', 'chat-message', 'persona', 'folder', 'scratch', 'asset',
    ]);
  });

  test('emits projection mutations while synchronous suppression is active', async () => {
    await resetChat();
    let suppressing = true;
    let emittedAfterSuppression = false;
    const serializers = createPrivateProSyncSerializers();
    const snapshot = serializers[0].snapshot();
    assert.equal(snapshot instanceof Promise, true);
    await snapshot;
    const unsubscribe = serializers.map(serializer => serializer.subscribe(() => {
      emittedAfterSuppression ||= !suppressing;
    }));

    const applying = privateProSyncChatProjection.apply('chat-1', [metaRecord('chat-1'), messageRecord('chat-1', 'message-1', 10)]);
    suppressing = false;
    await applying;
    await new Promise(resolve => setTimeout(resolve, 0));
    unsubscribe.forEach(stop => stop());

    assert.equal(emittedAfterSuppression, false);
  });
});
