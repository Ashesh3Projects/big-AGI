import { create } from 'zustand';


export type PrivateProSyncPhase =
  | 'local'
  | 'binding-conflict'
  | 'syncing'
  | 'synced'
  | 'offline'
  | 'conflict'
  | 'quota-blocked'
  | 'error';

interface PrivateProSyncState {
  phase: PrivateProSyncPhase;
  pendingOperations: number;
  usedBytes: number;
  reservedBytes: number;
  quotaBytes: number;
  lastError: string | null;
  retry: (() => Promise<void>) | null;
  setState: (state: Partial<Omit<PrivateProSyncState, 'setState'>>) => void;
}

export const usePrivateProSyncStore = create<PrivateProSyncState>()(set => ({
  phase: 'local',
  pendingOperations: 0,
  usedBytes: 0,
  reservedBytes: 0,
  quotaBytes: 1024 * 1024 * 1024,
  lastError: null,
  retry: null,
  setState: state => set(state),
}));

export function privateProSyncState() {
  return usePrivateProSyncStore.getState();
}
