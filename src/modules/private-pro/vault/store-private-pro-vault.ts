import { createStore, type StoreApi } from 'zustand/vanilla';

import type { PrivateProVaultRecordType } from './privatePro.vault.types';


export type PrivateProVaultPhase =
  | 'locked'
  | 'hydrating'
  | 'migrating'
  | 'ready'
  | 'reconnecting'
  | 'conflict'
  | 'rollback-blocked'
  | 'chunk-required'
  | 'error';

export interface PrivateProVaultConflictStatus {
  recordType: PrivateProVaultRecordType;
  recordId: string;
}

export interface PrivateProVaultState {
  phase: PrivateProVaultPhase;
  ready: boolean;
  pendingOperations: number;
  lastError: string | null;
  conflict: PrivateProVaultConflictStatus | null;
  setState(state: Partial<Omit<PrivateProVaultState, 'setState'>>): void;
}

export type PrivateProVaultStore = StoreApi<PrivateProVaultState>;

export function createPrivateProVaultStore(): PrivateProVaultStore {
  return createStore<PrivateProVaultState>()(set => ({
    phase: 'locked',
    ready: false,
    pendingOperations: 0,
    lastError: null,
    conflict: null,
    setState: state => set(state),
  }));
}

export const privateProVaultStore = createPrivateProVaultStore();
