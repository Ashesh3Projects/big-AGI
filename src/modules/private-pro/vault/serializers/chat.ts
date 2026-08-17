import * as z from 'zod/v4';

import { chatSyncDelete, chatSyncSnapshot, chatSyncSubscribe, chatSyncUpsert } from '~/common/stores/chat/store-chats';
import { parseSyncConversation, serializeSyncConversation } from '~/modules/private-pro/sync/privatePro.sync.serialize';
import { SyncConversationSchema, type SyncConversation } from '~/modules/private-pro/sync/privatePro.sync.schemas';

import type { PrivateProVaultLogicalSerializer } from '../privatePro.vault.serializers';


const ChatSchema = SyncConversationSchema.strict();
type ChatValue = z.infer<typeof ChatSchema>;

export const privateProVaultChatSerializer: PrivateProVaultLogicalSerializer<ChatValue> = {
  recordType: 'chat',
  schemaVersion: 4,
  schema: ChatSchema,
  logicalId: value => value.conversation.id,
  snapshot: () => chatSyncSnapshot().flatMap(conversation => {
    const value = serializeSyncConversation(conversation);
    return value ? [{ logicalId: conversation.id, value }] : [];
  }),
  apply: (_logicalId, value) => chatSyncUpsert(parseSyncConversation(value as SyncConversation)),
  remove: chatSyncDelete,
  subscribe: chatSyncSubscribe,
};
