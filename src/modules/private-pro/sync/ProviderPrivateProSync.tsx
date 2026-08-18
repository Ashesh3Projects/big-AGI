import * as React from 'react';
import { Alert, Button, CircularProgress, Sheet, Stack, Typography } from '@mui/joy';

import {
  personaSyncDelete,
  personaSyncExists,
  personaSyncSnapshot,
  personaSyncSubscribe,
  personaSyncUpsert,
} from '../../../apps/personas/store-app-personas';
import {
  chatSyncDelete,
  chatSyncExists,
  chatSyncSnapshot,
  chatSyncSubscribe,
  chatSyncUpsert,
} from '~/common/stores/chat/store-chats';
import { deviceGetGlobalDeviceId } from '~/common/stores/store-client';
import { collectFragmentAssetIds } from '~/common/stores/chat/chat.gc';

import { usePrivateProAuth } from '../auth/ProviderPrivatePro';
import { parseSyncConversation, parseSyncPersona, serializeSyncConversation, serializeSyncPersona } from './privatePro.sync.serialize';
import { privateProHash } from './privatePro.sync.chunk';
import { createPrivateProSyncEngine, type PrivateProLocalEntity, type PrivateProLocalStorePort } from './privatePro.sync.engine';
import { privateProSyncDB } from './privatePro.sync.db';
import { createPrivateProFirebaseTransport } from './privatePro.sync.transport';
import { privateProSyncState } from './store-private-pro-sync';
import { privateProHydrateDBAsset, privateProUploadDBAsset } from '../assets/privatePro.assets.client';
import { PrivateProVaultResetDialog } from '../ui/PrivateProVaultResetDialog';


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
          assetIds: [...conversation.messages.reduce((assetIds, message) => {
            collectFragmentAssetIds(message.fragments, assetIds);
            return assetIds;
          }, new Set<string>())],
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

    async exists(entityType, entityId) {
      return entityType === 'chat' ? chatSyncExists(entityId) : personaSyncExists(entityId);
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

    async prepareForUpload(entity) {
      for (const assetId of entity.assetIds ?? []) await privateProUploadDBAsset(assetId);
    },

    async prepareForRemoteApply(entity) {
      for (const assetId of entity.assetIds ?? []) await privateProHydrateDBAsset(assetId);
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
  const { state, user, bootstrap, signOut } = usePrivateProAuth();
  const [bindingGate, setBindingGate] = React.useState<{ uid: string; status: 'checking' | 'ready' | 'conflict' } | null>(null);

  React.useEffect(() => {
    if (state !== 'signed-in' || !user) {
      setBindingGate(null);
      return;
    }
    let cancelled = false;
    setBindingGate({ uid: user.uid, status: 'checking' });
    const syncState = privateProSyncState();
    syncState.setState({
      phase: 'syncing',
      lastError: null,
      usedBytes: bootstrap?.usedBytes ?? 0,
      reservedBytes: bootstrap?.reservedBytes ?? 0,
      quotaBytes: bootstrap?.quotaBytes ?? 1024 * 1024 * 1024,
    });
    const engine = createPrivateProSyncEngine({
      uid: user.uid,
      deviceId: deviceGetGlobalDeviceId(),
      db: privateProSyncDB,
      store: createLocalStorePort(),
      transport: createPrivateProFirebaseTransport(user.uid),
      onStatus: ({ phase, error }) => privateProSyncState().setState({ phase, lastError: error }),
    });
    syncState.setState({
      retry: async () => {
        syncState.setState({ phase: 'syncing', lastError: null });
        await engine.retryNow();
      },
    });
    let statusTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshStatus = async () => {
      if (cancelled) return;
      const pendingOperations = await privateProSyncDB.outboxCount(user.uid);
      if (cancelled) return;
      const current = privateProSyncState();
      current.setState({
        pendingOperations,
        ...(current.phase !== 'binding-conflict' && current.phase !== 'conflict' && current.phase !== 'error' && current.phase !== 'quota-blocked'
          ? { phase: pendingOperations ? 'syncing' : 'synced' }
          : {}),
      });
      statusTimer = setTimeout(() => void refreshStatus(), pendingOperations ? 2000 : 30000);
    };
    void engine.start().then(result => {
      if (cancelled) return;
      setBindingGate({ uid: user.uid, status: result === 'binding-conflict' ? 'conflict' : 'ready' });
      syncState.setState({ phase: result === 'binding-conflict' ? 'binding-conflict' : 'syncing' });
      if (result === 'started') {
        void engine.whenIdle().then(refreshStatus);
      }
    }).catch(error => {
      if (cancelled) return;
      syncState.setState({
        phase: 'error',
        lastError: error instanceof Error ? error.message : 'Private sync failed to start.',
      });
    });
    return () => {
      cancelled = true;
      if (statusTimer) clearTimeout(statusTimer);
      engine.stop();
      privateProSyncState().setState({ retry: null });
    };
  }, [bootstrap, state, user]);

  if (state === 'signed-in' && user && (bindingGate?.uid !== user.uid || bindingGate.status === 'checking')) {
    return (
      <Sheet sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <Stack spacing={1.5} alignItems='center'>
          <CircularProgress />
          <Typography textColor='text.secondary'>Opening your private vault...</Typography>
        </Stack>
      </Sheet>
    );
  }

  if (state === 'signed-in' && user && bindingGate?.uid === user.uid && bindingGate.status === 'conflict') {
    return (
      <Sheet sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2 }}>
        <Stack spacing={2} sx={{ width: 'min(100%, 520px)' }}>
          <Typography level='h2'>Different account on this browser</Typography>
          <Alert color='warning'>This browser contains a local vault bound to another Google account. Its chats are hidden to prevent uploading or exposing them to the current account.</Alert>
          <Button variant='soft' color='neutral' onClick={() => void signOut()}>Sign out and use the original account</Button>
          <PrivateProVaultResetDialog onDone={() => setBindingGate({ uid: user.uid, status: 'checking' })} />
        </Stack>
      </Sheet>
    );
  }

  return props.children;
}
