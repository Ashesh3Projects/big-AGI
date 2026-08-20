import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  PRIVATE_PRO_WORKSPACE_V1_CUTOVER_MARKER,
  createPrivateProWorkspaceV1BrowserCutoverPort,
  runPrivateProWorkspaceV1LocalCutover,
  type PrivateProWorkspaceV1LocalCutoverPort,
} from './privatePro.sync.cutover';


class MemoryCutoverPort implements PrivateProWorkspaceV1LocalCutoverPort {
  readonly localStorage = new Map<string, string>();
  readonly portableIDB = new Map<string, unknown>();
  readonly databases = new Set<string>();
  readonly deletedDatabases: string[] = [];
  readonly removedPortableIDBKeys: string[] = [];
  clearedLegacyAssets = 0;

  localStorageKeys(): string[] {
    return [...this.localStorage.keys()];
  }

  getLocalStorageItem(key: string): string | null {
    return this.localStorage.get(key) ?? null;
  }

  removeLocalStorageItem(key: string): void {
    this.localStorage.delete(key);
  }

  setLocalStorageItem(key: string, value: string): void {
    this.localStorage.set(key, value);
  }

  async deleteDatabase(name: string): Promise<void> {
    this.deletedDatabases.push(name);
    this.databases.delete(name);
  }

  async removePortableIDBItem(key: string): Promise<void> {
    this.removedPortableIDBKeys.push(key);
    this.portableIDB.delete(key);
  }

  async clearLegacyAssets(): Promise<void> {
    this.clearedLegacyAssets++;
  }
}

function seededPort(): MemoryCutoverPort {
  const port = new MemoryCutoverPort();
  port.databases.add('private-pro-vault-v1');
  port.databases.add('private-pro-sync-v1');
  port.databases.add('private-pro-workspace-v1');
  port.portableIDB.set('app-chats', { legacy: true });
  port.portableIDB.set('app-chats-v3', { legacy: true });
  port.portableIDB.set('unrelated-cell', 'keep-me');
  for (const [key, value] of [
    ['app-models', 'legacy-provider-api-key'],
    ['app-state', 'legacy-sensitive-state'],
    ['private-pro-vault-device:uid-a', 'remembered-device'],
    ['private-pro-vault-device:uid-b', 'other-remembered-device'],
    ['firebase:authUser:browser-key:[DEFAULT]', 'firebase-auth-session'],
    ['firebase:previous_websocket_failure', 'firebase-heartbeat-state'],
    ['unrelated-feature', 'keep-me'],
  ] as const) port.localStorage.set(key, value);
  return port;
}

describe('Private Pro workspace v1 local cutover', () => {
  test('deletes only proven legacy Private Pro state and preserves the current workspace and Firebase persistence', async () => {
    const port = seededPort();

    await runPrivateProWorkspaceV1LocalCutover(port);

    assert.deepEqual(port.deletedDatabases, ['private-pro-vault-v1', 'private-pro-sync-v1']);
    assert.deepEqual([...port.databases].sort(), ['private-pro-workspace-v1']);
    assert.equal(port.localStorage.has('app-models'), false);
    assert.equal(port.localStorage.has('app-state'), false);
    assert.equal(port.localStorage.has('private-pro-vault-device:uid-a'), false);
    assert.equal(port.localStorage.has('private-pro-vault-device:uid-b'), false);
    assert.equal(port.localStorage.get('firebase:authUser:browser-key:[DEFAULT]'), 'firebase-auth-session');
    assert.equal(port.localStorage.get('firebase:previous_websocket_failure'), 'firebase-heartbeat-state');
    assert.equal(port.localStorage.get('unrelated-feature'), 'keep-me');
    assert.deepEqual(port.removedPortableIDBKeys, ['app-chats', 'app-chats-v3']);
    assert.equal(port.portableIDB.has('app-chats'), false);
    assert.equal(port.portableIDB.has('app-chats-v3'), false);
    assert.equal(port.portableIDB.get('unrelated-cell'), 'keep-me');
    assert.equal(port.clearedLegacyAssets, 1);
    assert.equal(port.localStorage.get(PRIVATE_PRO_WORKSPACE_V1_CUTOVER_MARKER), '1');
  });

  test('uses the global build marker as an idempotent no-op after successful cleanup', async () => {
    const port = seededPort();
    await runPrivateProWorkspaceV1LocalCutover(port);
    port.databases.add('private-pro-vault-v1');
    port.localStorage.set('app-models', 'new-current-value');

    await runPrivateProWorkspaceV1LocalCutover(port);

    assert.deepEqual(port.deletedDatabases, ['private-pro-vault-v1', 'private-pro-sync-v1']);
    assert.equal(port.databases.has('private-pro-vault-v1'), true);
    assert.equal(port.localStorage.get('app-models'), 'new-current-value');
    assert.equal(port.clearedLegacyAssets, 1);
  });

  test('writes no marker when cleanup fails and safely retries the whole allowlisted cleanup', async () => {
    const port = seededPort();
    let failuresRemaining = 1;
    port.clearLegacyAssets = async () => {
      port.clearedLegacyAssets++;
      if (failuresRemaining--) throw new Error('simulated legacy asset clear failure');
    };

    await assert.rejects(runPrivateProWorkspaceV1LocalCutover(port));
    assert.equal(port.localStorage.has(PRIVATE_PRO_WORKSPACE_V1_CUTOVER_MARKER), false);

    await runPrivateProWorkspaceV1LocalCutover(port);

    assert.equal(port.localStorage.get(PRIVATE_PRO_WORKSPACE_V1_CUTOVER_MARKER), '1');
    assert.equal(port.clearedLegacyAssets, 2);
    assert.deepEqual(port.deletedDatabases, [
      'private-pro-vault-v1',
      'private-pro-sync-v1',
      'private-pro-vault-v1',
      'private-pro-sync-v1',
    ]);
    assert.deepEqual(port.removedPortableIDBKeys, [
      'app-chats', 'app-chats-v3',
      'app-chats', 'app-chats-v3',
    ]);
  });

  test('browser database deletion resolves only on success', async () => {
    const requests: Array<{
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
      onblocked: (() => void) | null;
      error: DOMException | null;
    }> = [];
    const port = createPrivateProWorkspaceV1BrowserCutoverPort({
      storage: new MemoryCutoverPort() as unknown as Storage,
      indexedDB: {
        deleteDatabase() {
          const request = { onsuccess: null, onerror: null, onblocked: null, error: null };
          requests.push(request);
          return request as unknown as IDBOpenDBRequest;
        },
      },
      removeDurableLocalStorageItem: () => {},
      removePortableIDBItem: async () => {},
      clearLegacyAssets: async () => {},
    });

    let settled = false;
    const deletion = port.deleteDatabase('private-pro-vault-v1').finally(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);

    requests[0].onsuccess?.();
    await deletion;
    assert.equal(settled, true);
  });

  test('browser database deletion rejects on errors and blocked requests', async () => {
    for (const event of ['error', 'blocked'] as const) {
      let request!: {
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onblocked: (() => void) | null;
        error: DOMException | null;
      };
      const port = createPrivateProWorkspaceV1BrowserCutoverPort({
        storage: new MemoryCutoverPort() as unknown as Storage,
        indexedDB: {
          deleteDatabase() {
            request = { onsuccess: null, onerror: null, onblocked: null, error: new DOMException('raw browser detail') };
            return request as unknown as IDBOpenDBRequest;
          },
        },
        removeDurableLocalStorageItem: () => {},
        removePortableIDBItem: async () => {},
        clearLegacyAssets: async () => {},
      });

      const deletion = port.deleteDatabase('private-pro-vault-v1');
      if (event === 'error') request.onerror?.();
      else request.onblocked?.();

      await assert.rejects(deletion, /legacy database could not be deleted/i);
    }
  });
});
