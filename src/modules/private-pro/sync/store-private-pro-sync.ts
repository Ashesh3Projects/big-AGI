import { create } from 'zustand';


export type PrivateProSyncPhase =
  | 'local'
  | 'binding-conflict'
  | 'migrating'
  | 'syncing'
  | 'synced'
  | 'offline'
  | 'conflict'
  | 'quota-blocked'
  | 'error';

interface PrivateProSyncState {
  phase: PrivateProSyncPhase;
  pendingOperations: number;
  lastError: string | null;
  setState: (state: Partial<Omit<PrivateProSyncState, 'setState'>>) => void;
}

export const usePrivateProSyncStore = create<PrivateProSyncState>()(set => ({
  phase: 'local',
  pendingOperations: 0,
  lastError: null,
  setState: state => set(state),
}));

export function privateProSyncState() {
  return usePrivateProSyncStore.getState();
}
