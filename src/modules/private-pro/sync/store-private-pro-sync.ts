import { createStore, type StoreApi } from 'zustand/vanilla';

import type { PrivateProOutboundErrorCategory } from './privatePro.sync.outbound';


export type PrivateProSyncPhase = 'local' | 'synced' | 'offline' | 'error';

export interface PrivateProSyncState {
  phase: PrivateProSyncPhase;
  pending: number;
  lastCategory: PrivateProOutboundErrorCategory | null;
  retry: (() => Promise<void>) | null;
  lastSuccessfulSyncTime: number | null;
}

export type PrivateProSyncStore = StoreApi<PrivateProSyncState>;

export function createPrivateProSyncStore(): PrivateProSyncStore {
  return createStore<PrivateProSyncState>()(set => ({
    phase: 'local',
    pending: 0,
    lastCategory: null,
    retry: null,
    lastSuccessfulSyncTime: null,
  }));
}

export const privateProSyncStore = createPrivateProSyncStore();
