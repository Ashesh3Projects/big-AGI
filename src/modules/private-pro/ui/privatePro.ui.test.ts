import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { privateProSyncLabel } from './privatePro.ui';
import type { PrivateProSyncPhase } from '../sync/store-private-pro-sync';


type AssertFalse<T extends false> = T;
type _MigratingIsNotASyncPhase = AssertFalse<'migrating' extends PrivateProSyncPhase ? true : false>;


describe('private Pro sync labels', () => {
  test('maps every sync phase to concise user-facing copy', () => {
    assert.deepEqual({
      local: privateProSyncLabel('local'),
      syncing: privateProSyncLabel('syncing'),
      synced: privateProSyncLabel('synced'),
      offline: privateProSyncLabel('offline'),
      conflict: privateProSyncLabel('conflict'),
      quotaBlocked: privateProSyncLabel('quota-blocked'),
      bindingConflict: privateProSyncLabel('binding-conflict'),
      error: privateProSyncLabel('error'),
    }, {
      local: 'Local only',
      syncing: 'Syncing',
      synced: 'Synced',
      offline: 'Offline',
      conflict: 'Conflict copy saved',
      quotaBlocked: 'Storage full',
      bindingConflict: 'Different account on this browser',
      error: 'Sync error',
    });
  });
});
