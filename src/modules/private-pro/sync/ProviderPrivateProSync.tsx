import * as React from 'react';

import {
  personaSyncDelete,
  personaSyncSnapshot,
  personaSyncSubscribe,
  personaSyncUpsert,
} from '../../../apps/personas/store-app-personas';
import {
  chatSyncDelete,
  chatSyncSnapshot,
  chatSyncSubscribe,
  chatSyncUpsert,
} from '~/common/stores/chat/store-chats';
import { deviceGetGlobalDeviceId } from '~/common/stores/store-client';

import { usePrivateProAuth } from '../auth/ProviderPrivatePro';
import { parseSyncConversation, parseSyncPersona, serializeSyncConversation, serializeSyncPersona } from './privatePro.sync.serialize';
import { privateProHash } from './privatePro.sync.chunk';
import { createPrivateProSyncEngine, type PrivateProLocalEntity, type PrivateProLocalStorePort } from './privatePro.sync.engine';
import { privateProSyncDB } from './privatePro.sync.db';
import { createPrivateProFirebaseTransport } from './privatePro.sync.transport';
import { privateProSyncState } from './store-private-pro-sync';


function createLocalStorePort(): PrivateProLocalStorePort {
  return {
    async snapshot() {
      const chats = await Promise.all(chatSyncSnapshot().map(async conversation => {
        const payload = serializeSyncConversation(conversation);
        if (!payload) return null;
        return {
          entityType: 'chat' as const,
          entityId: conversation.id,
          contentHash: await privateProHash(JSON.stringify(payload)),
          payload,
        };
      }));
      const personas = await Promise.all(personaSyncSnapshot().map(async persona => {
        const payload = serializeSyncPersona(persona);
        return {
          entityType: 'persona' as const,
          entityId: persona.id,
          contentHash: await privateProHash(JSON.stringify(payload)),
          payload,
        };
      }));
      return [...chats.filter((chat): chat is NonNullable<typeof chat> => !!chat), ...personas];
    },

    async get(entityType, entityId) {
      return (await this.snapshot()).find(entity => entity.entityType === entityType && entity.entityId === entityId) ?? null;
    },

    async applyUpsert(entity) {
      if (entity.entityType === 'chat') chatSyncUpsert(parseSyncConversation(entity.payload));
      else personaSyncUpsert(parseSyncPersona(entity.payload));
    },

    async applyDelete(entityType, entityId) {
      if (entityType === 'chat') chatSyncDelete(entityId);
      else personaSyncDelete(entityId);
    },

    async createConflictCopy(source: PrivateProLocalEntity) {
      if (source.entityType === 'chat') {
        const conversation = parseSyncConversation(source.payload);
        conversation.id = `${conversation.id}-conflict-${crypto.randomUUID()}`;
        conversation.userTitle = `${conversation.userTitle || conversation.autoTitle || 'Chat'} (conflict copy)`;
        conversation.updated = Date.now();
        chatSyncUpsert(conversation);
      } else {
        const persona = parseSyncPersona(source.payload);
        persona.id = `${persona.id}-conflict-${crypto.randomUUID()}`;
        persona.name = `${persona.name || 'Persona'} (conflict copy)`;
        personaSyncUpsert(persona);
      }
      privateProSyncState().setState({ phase: 'conflict' });
    },

    subscribe(listener) {
      const unsubscribeChats = chatSyncSubscribe(listener);
      const unsubscribePersonas = personaSyncSubscribe(listener);
      return () => {
        unsubscribeChats();
        unsubscribePersonas();
      };
    },
  };
}

export function ProviderPrivateProSync(props: { children: React.ReactNode }) {
  const { state, user } = usePrivateProAuth();

  React.useEffect(() => {
    if (state !== 'signed-in' || !user) return;
    const syncState = privateProSyncState();
    syncState.setState({ phase: 'migrating', lastError: null });
    const engine = createPrivateProSyncEngine({
      uid: user.uid,
      deviceId: deviceGetGlobalDeviceId(),
      db: privateProSyncDB,
      store: createLocalStorePort(),
      transport: createPrivateProFirebaseTransport(user.uid),
    });
    void engine.start().then(result => {
      syncState.setState({ phase: result === 'binding-conflict' ? 'binding-conflict' : 'syncing' });
      if (result === 'started') void engine.whenIdle().then(() => syncState.setState({ phase: 'synced' }));
    }).catch(error => syncState.setState({
      phase: 'error',
      lastError: error instanceof Error ? error.message : 'Private sync failed to start.',
    }));
    return () => engine.stop();
  }, [state, user]);

  return props.children;
}
