import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  PRIVATE_PRO_SYNC_MAX_PAYLOAD_BYTES,
  PRIVATE_PRO_SYNC_WINDOW_MS,
} from '../config/privatePro.config';
import {
  assertPrivateProPayloadSize,
  privateProCanonicalJson,
  privateProContentHash,
  privateProParseCanonicalJson,
  privateProRecordKey,
} from './privatePro.sync.codec';
import {
  PrivateProSyncMutationReceiptSchema,
  PrivateProSyncRecordDocumentSchema,
  PrivateProSyncRecordKeySchema,
  PrivateProSyncTombstoneDocumentSchema,
  SyncChatMessageSchema,
  SyncChatMetaSchema,
} from './privatePro.sync.schemas';


const recordTypes = [
  'credential-service', 'model-service', 'settings', 'persona', 'folder',
  'scratch', 'chat-meta', 'chat-message', 'asset',
] as const;

const mutationId = '123e4567-e89b-12d3-a456-426614174000';
const writerId = '123e4567-e89b-12d3-a456-426614174001';
const contentHash = 'a'.repeat(64);


describe('Private Pro sync v1 protocol', () => {
  test('uses the exact v1 timing and payload bounds', () => {
    assert.equal(PRIVATE_PRO_SYNC_WINDOW_MS, 60_000);
    assert.equal(PRIVATE_PRO_SYNC_MAX_PAYLOAD_BYTES, 786_432);
  });

  test('builds deterministic slash-free keys for every record family', () => {
    for (const recordType of recordTypes) {
      const key = privateProRecordKey(recordType, 'chat/a\0message/b');
      assert.equal(key, privateProRecordKey(recordType, 'chat/a\0message/b'));
      assert.doesNotMatch(key, /\//);
      assert.match(key, /^[A-Za-z0-9_-]+$/);
    }
  });

  test('bounds non-ASCII logical IDs into valid deterministic record keys', () => {
    const logicalId = '\u2603'.repeat(512);
    const key = privateProRecordKey('settings', logicalId);

    assert.equal(key, privateProRecordKey('settings', logicalId));
    assert.notEqual(key, privateProRecordKey('settings', `${logicalId.slice(0, -1)}a`));
    assert.equal(PrivateProSyncRecordKeySchema.parse(key), key);
  });

  test('canonical JSON is ASCII and stable across object key order', () => {
    const left = privateProCanonicalJson({ z: 'cafe', a: '\u2603' });
    const right = privateProCanonicalJson({ a: '\u2603', z: 'cafe' });
    assert.equal(left, right);
    assert.equal([...left].every(character => character.charCodeAt(0) <= 0x7f), true);
  });

  test('matches JSON serialization for undefined object fields and array items', () => {
    assert.equal(
      privateProCanonicalJson({ group: 'beam', gatherLlmId: undefined, rayLlmIds: ['model-1'] }),
      '{"group":"beam","rayLlmIds":["model-1"]}',
    );
    assert.equal(privateProCanonicalJson(['model-1', undefined]), '["model-1",null]');
    assert.throws(() => privateProCanonicalJson(undefined), /requires a JSON value/i);
  });

  test('parses canonical JSON through its schema', () => {
    assert.deepEqual(privateProParseCanonicalJson('{"conversationId":"chat-1","created":1,"systemPurposeId":"system","updated":null}', SyncChatMetaSchema), {
      conversationId: 'chat-1',
      systemPurposeId: 'system',
      created: 1,
      updated: null,
    });
  });

  test('hashes canonical payloads with SHA-256', async () => {
    assert.equal(await privateProContentHash('{"a":1}'), '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862');
  });

  test('rejects payloads over the exact v1 bound', () => {
    const payload = `"${'a'.repeat(PRIVATE_PRO_SYNC_MAX_PAYLOAD_BYTES)}"`;
    assert.throws(() => assertPrivateProPayloadSize(payload), /too large/i);
  });

  test('validates record documents and deleted empty payloads', () => {
    for (const recordType of recordTypes) {
      assert.equal(PrivateProSyncRecordDocumentSchema.parse({
        recordType,
        logicalId: 'record-1',
        schemaVersion: 1,
        payload: '{"ok":true}',
        contentHash,
        revision: 1,
        mutationId,
        writerId,
        deleted: false,
        updatedAt: null,
      }).recordType, recordType);
    }

    assert.throws(() => PrivateProSyncRecordDocumentSchema.parse({
      recordType: 'settings', logicalId: 'record-1', schemaVersion: 1, payload: '', contentHash,
      revision: 1, mutationId, writerId, deleted: false, updatedAt: null,
    }));
    assert.doesNotThrow(() => PrivateProSyncRecordDocumentSchema.parse({
      recordType: 'settings', logicalId: 'record-1', schemaVersion: 1, payload: '', contentHash,
      revision: 1, mutationId, writerId, deleted: true, updatedAt: null,
    }));
  });

  test('validates tombstones and receipt identity', () => {
    assert.equal(PrivateProSyncTombstoneDocumentSchema.parse({
      recordKey: privateProRecordKey('settings', 'record-1'), recordType: 'settings', logicalId: 'record-1',
      deletedRevision: 1, mutationId, writerId, deletedAt: null,
    }).recordType, 'settings');

    assert.doesNotThrow(() => PrivateProSyncMutationReceiptSchema.parse({
      schemaVersion: 1, mutationId, recordKey: privateProRecordKey('settings', 'record-1'),
      recordType: 'settings', logicalId: 'record-1', kind: 'delete', contentHash: null,
      revision: 1, writerId, committedAt: null,
    }));
    assert.throws(() => PrivateProSyncMutationReceiptSchema.parse({
      schemaVersion: 1, mutationId, recordKey: privateProRecordKey('settings', 'record-1'),
      recordType: 'settings', logicalId: 'record-1', kind: 'put', contentHash: null,
      revision: 1, writerId, committedAt: null,
    }));
  });

  test('keeps chat metadata and messages as separate strict payloads', () => {
    assert.deepEqual(SyncChatMetaSchema.parse({
      conversationId: 'chat-1', systemPurposeId: 'system', created: 1, updated: null,
    }), { conversationId: 'chat-1', systemPurposeId: 'system', created: 1, updated: null });
    assert.equal(SyncChatMessageSchema.parse({
      conversationId: 'chat-1', message: {
        id: 'message-1', role: 'user', fragments: [], tokenCount: 0, created: 1, updated: null,
      },
    }).message.id, 'message-1');
  });
});
