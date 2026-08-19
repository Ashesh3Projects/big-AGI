import * as z from 'zod/v4';

import {
  chatSyncApplyMessage,
  chatSyncApplyMeta,
  chatSyncDelete,
  chatSyncRemoveMessage,
  chatSyncSnapshot,
  chatSyncSubscribe,
} from '~/common/stores/chat/store-chats';
import { serializeSyncChatMessages, serializeSyncChatMeta } from '~/modules/private-pro/sync/privatePro.sync.serialize';
import { SyncChatMessageSchema, SyncChatMetaSchema, type SyncChatMessage, type SyncChatMeta } from '~/modules/private-pro/sync/privatePro.sync.schemas';

import type { PrivateProSyncLogicalSerializer, PrivateProSyncProjection, PrivateProSyncSerializedRecord } from '../privatePro.sync.serializers';


const CHAT_SCHEMA_VERSION = 1;

function messageLogicalId(value: SyncChatMessage): string {
  return `${value.conversationId}\0${value.message.id}`;
}

export const privateProSyncChatMetaSerializer: PrivateProSyncLogicalSerializer<SyncChatMeta> = {
  recordType: 'chat-meta',
  schemaVersion: CHAT_SCHEMA_VERSION,
  conflictPolicy: 'message-identity',
  schema: SyncChatMetaSchema,
  logicalId: value => value.conversationId,
  projectionKey: value => value.conversationId,
  snapshot: () => chatSyncSnapshot().flatMap(conversation => {
    const value = serializeSyncChatMeta(conversation);
    return value ? [{ logicalId: conversation.id, value }] : [];
  }),
  apply: (_logicalId, value) => chatSyncApplyMeta(value),
  remove: logicalId => chatSyncDelete(logicalId),
  subscribe: chatSyncSubscribe,
};

export const privateProSyncChatMessageSerializer: PrivateProSyncLogicalSerializer<SyncChatMessage> = {
  recordType: 'chat-message',
  schemaVersion: CHAT_SCHEMA_VERSION,
  conflictPolicy: 'message-identity',
  schema: SyncChatMessageSchema,
  logicalId: messageLogicalId,
  projectionKey: value => value.conversationId,
  snapshot: () => chatSyncSnapshot().flatMap(conversation => {
    const values = serializeSyncChatMessages(conversation);
    return values ? values.map(value => ({ logicalId: messageLogicalId(value), value })) : [];
  }),
  apply: (_logicalId, value) => chatSyncApplyMessage(value),
  remove: logicalId => {
    const separator = logicalId.indexOf('\0');
    if (separator < 1) return;
    chatSyncRemoveMessage(logicalId.slice(0, separator), logicalId.slice(separator + 1));
  },
  subscribe: chatSyncSubscribe,
};

interface PrivateProSyncChatProjection extends PrivateProSyncProjection {
  stage(record: PrivateProSyncSerializedRecord): Promise<void>;
  removeMessage(conversationId: string, messageId: string): Promise<void>;
}

const stagedRecords = new Map<string, Map<string, PrivateProSyncSerializedRecord>>();

function stageRecord(record: PrivateProSyncSerializedRecord): void {
  const records = stagedRecords.get(record.projectionKey) ?? new Map<string, PrivateProSyncSerializedRecord>();
  records.set(`${record.recordType}\0${record.logicalId}`, structuredClone(record));
  stagedRecords.set(record.projectionKey, records);
}

function materializeStagedProjection(projectionKey: string): boolean {
  const records = [...(stagedRecords.get(projectionKey)?.values() ?? [])];
  const metaRecord = records.find(record => record.recordType === 'chat-meta');
  if (!metaRecord) return false;
  const meta = SyncChatMetaSchema.parse(metaRecord.value);
  chatSyncApplyMeta(meta);
  for (const record of records) {
    if (record.recordType === 'chat-message') chatSyncApplyMessage(SyncChatMessageSchema.parse(record.value));
  }
  return true;
}

export const privateProSyncChatProjection: PrivateProSyncChatProjection = {
  apply: async (projectionKey, records) => {
    const staged = new Map<string, PrivateProSyncSerializedRecord>();
    for (const record of records) {
      if (record.projectionKey === projectionKey)
        staged.set(`${record.recordType}\0${record.logicalId}`, structuredClone(record));
    }
    stagedRecords.set(projectionKey, staged);
    chatSyncDelete(projectionKey);
    materializeStagedProjection(projectionKey);
  },
  remove: async projectionKey => {
    stagedRecords.delete(projectionKey);
    chatSyncDelete(projectionKey);
  },
  stage: async record => {
    if (!isPrivateProSyncChatRecord(record)) throw new TypeError('Chat projection requires a chat record.');
    stageRecord(record);
    materializeStagedProjection(record.projectionKey);
  },
  removeMessage: async (conversationId, messageId) => {
    const records = stagedRecords.get(conversationId);
    records?.delete(`chat-message\0${conversationId}\0${messageId}`);
    chatSyncRemoveMessage(conversationId, messageId);
  },
};

export const PrivateProSyncChatMetaSchema = z.object({
  recordType: z.literal('chat-meta'),
  value: SyncChatMetaSchema,
}).strict();

export const PrivateProSyncChatMessageSchema = z.object({
  recordType: z.literal('chat-message'),
  value: SyncChatMessageSchema,
}).strict();

export function isPrivateProSyncChatRecord(record: PrivateProSyncSerializedRecord): boolean {
  return record.recordType === 'chat-meta' || record.recordType === 'chat-message';
}
