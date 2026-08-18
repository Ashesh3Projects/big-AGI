import type { PrivateProSyncPhase } from '../sync/store-private-pro-sync';


const labels: Record<PrivateProSyncPhase, string> = {
  local: 'Local only',
  syncing: 'Syncing',
  synced: 'Synced',
  offline: 'Offline',
  conflict: 'Conflict copy saved',
  'quota-blocked': 'Storage full',
  'binding-conflict': 'Different account on this browser',
  error: 'Sync error',
};

export function privateProSyncLabel(phase: PrivateProSyncPhase): string {
  return labels[phase];
}
