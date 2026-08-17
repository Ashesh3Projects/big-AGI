import type { SimplePersona } from '../../../apps/personas/store-app-personas';
import type { DConversation } from '~/common/stores/chat/chat.conversation';
import type { DMessage } from '~/common/stores/chat/chat.message';

import {
  SyncConversationSchema,
  SyncPersonaSchema,
  type SyncConversation,
  type SyncPersona,
} from './privatePro.sync.schemas';


function serializeMessage(message: DMessage) {
  const generator = message.generator ? structuredClone(message.generator) : undefined;
  if (generator) delete generator.metrics;
  return {
    id: message.id,
    role: message.role,
    fragments: structuredClone(message.fragments),
    ...(message.purposeId !== undefined && { purposeId: message.purposeId }),
    ...(message.metadata !== undefined && { metadata: structuredClone(message.metadata) }),
    ...(generator !== undefined && { generator }),
    ...(message.userFlags !== undefined && { userFlags: [...message.userFlags] }),
    tokenCount: message.tokenCount,
    created: message.created,
    updated: message.updated,
  };
}

export function serializeSyncConversation(conversation: DConversation): SyncConversation | null {
  if (conversation._isIncognito || conversation.messages.some(message => message.pendingIncomplete)) return null;

  return SyncConversationSchema.parse({
    schemaVersion: 1,
    conversation: {
      id: conversation.id,
      messages: conversation.messages.map(serializeMessage),
      ...(conversation.userTitle !== undefined && { userTitle: conversation.userTitle }),
      ...(conversation.autoTitle !== undefined && { autoTitle: conversation.autoTitle }),
      ...(conversation.isArchived !== undefined && { isArchived: conversation.isArchived }),
      ...(conversation.userSymbol !== undefined && { userSymbol: conversation.userSymbol }),
      systemPurposeId: conversation.systemPurposeId,
      tokenCount: conversation.tokenCount,
      created: conversation.created,
      updated: conversation.updated,
    },
  });
}

export function parseSyncConversation(value: unknown): DConversation {
  const { conversation } = SyncConversationSchema.parse(value);
  return {
    ...structuredClone(conversation),
    messages: conversation.messages.map(message => ({
      ...structuredClone(message),
      fragments: structuredClone(message.fragments) as DMessage['fragments'],
      metadata: message.metadata as DMessage['metadata'],
      generator: message.generator as DMessage['generator'],
      userFlags: message.userFlags as DMessage['userFlags'],
    })),
    systemPurposeId: conversation.systemPurposeId as DConversation['systemPurposeId'],
    _abortController: null,
  };
}

export function serializeSyncPersona(persona: SimplePersona): SyncPersona {
  return SyncPersonaSchema.parse({
    schemaVersion: 1,
    persona: {
      id: persona.id,
      ...(persona.name !== undefined && { name: persona.name }),
      systemPrompt: persona.systemPrompt,
      creationDate: persona.creationDate,
      ...(persona.pictureUrl !== undefined && { pictureUrl: persona.pictureUrl }),
      ...(persona.inputProvenance !== undefined && { inputProvenance: structuredClone(persona.inputProvenance) }),
      inputText: persona.inputText,
      ...(persona.llmLabel !== undefined && { llmLabel: persona.llmLabel }),
    },
  });
}

export function parseSyncPersona(value: unknown): SimplePersona {
  return structuredClone(SyncPersonaSchema.parse(value).persona);
}
