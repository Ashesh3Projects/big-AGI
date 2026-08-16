import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { privateProSyncLabel } from './privatePro.ui';


describe('private Pro sync labels', () => {
  test('maps every sync phase to concise user-facing copy', () => {
    assert.deepEqual({
      local: privateProSyncLabel('local'),
      migrating: privateProSyncLabel('migrating'),
      syncing: privateProSyncLabel('syncing'),
      synced: privateProSyncLabel('synced'),
      offline: privateProSyncLabel('offline'),
      conflict: privateProSyncLabel('conflict'),
      quotaBlocked: privateProSyncLabel('quota-blocked'),
      bindingConflict: privateProSyncLabel('binding-conflict'),
      error: privateProSyncLabel('error'),
    }, {
      local: 'Local only',
      migrating: 'Uploading this device',
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
