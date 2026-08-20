import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { get, set } from 'idb-keyval';

import {
  PRIVATE_PRO_PORTABLE_LOCAL_STORAGE_KEYS,
  PRIVATE_PRO_SENSITIVE_LOCAL_STORAGE_KEYS,
  activatePrivateProManagedPersistence as activatePrivateProManagedPersistenceOwned,
  clearPrivateProManagedPersistence,
  createPrivateProPortableLocalStorage,
  deactivatePrivateProManagedPersistence as deactivatePrivateProManagedPersistenceOwned,
  isPrivateProManagedPersistenceActive,
  privateProManagedPersistenceOwnership,
  privateProManagedPersistenceUid,
  releasePrivateProManagedPersistence,
} from './privatePro.persistence';


class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();

  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const managedOwners = new Map<string, object>();
const managedOwner = (uid: string) => {
  let owner = managedOwners.get(uid);
  if (!owner) {
    owner = {};
    managedOwners.set(uid, owner);
  }
  return owner;
};
const activatePrivateProManagedPersistence = (uid: string | null) =>
  activatePrivateProManagedPersistenceOwned(uid, uid ? managedOwner(uid) : null);
const deactivatePrivateProManagedPersistence = (uid: string, clearRuntime?: () => void) =>
  deactivatePrivateProManagedPersistenceOwned(uid, managedOwner(uid), clearRuntime);


afterEach(() => activatePrivateProManagedPersistence(null));

describe('private Pro managed persistence gate', () => {
  test('uses volatile storage for an explicit portable key while managed persistence is active', async () => {
    const durable = new MemoryStorage();
    const storage = createPrivateProPortableLocalStorage(() => durable);
    const key = 'app-models';
    const sentinel = 'sentinel-provider-api-key';

    await activatePrivateProManagedPersistence('uid-a');
    storage.setItem(key, sentinel);

    assert.equal(isPrivateProManagedPersistenceActive(), true);
    assert.equal(storage.getItem(key), sentinel);
    assert.equal(durable.getItem(key), null);
  });

  test('keeps Open storage behavior unchanged', async () => {
    const durable = new MemoryStorage();
    const storage = createPrivateProPortableLocalStorage(() => durable);

    await activatePrivateProManagedPersistence(null);
    storage.setItem('app-models', 'open-model-state');

    assert.equal(durable.getItem('app-models'), 'open-model-state');
    assert.equal(storage.getItem('app-models'), 'open-model-state');
  });

  test('fails closed for portable stores outside the inclusion list', async () => {
    const storage = createPrivateProPortableLocalStorage(() => new MemoryStorage());
    await activatePrivateProManagedPersistence('uid-a');

    assert.throws(() => storage.setItem('unregistered-portable-store', 'secret'), /allowlist/i);
  });

  test('declares every Task 11 localStorage persistence key explicitly', () => {
    assert.deepEqual([...PRIVATE_PRO_PORTABLE_LOCAL_STORAGE_KEYS].sort(), [
      'agi-scratch-clip',
      'app-ai-preferences',
      'app-app-call',
      'app-app-chat',
      'app-app-personas',
      'app-folders',
      'app-models',
      'app-module-asrx',
      'app-module-beam',
      'app-module-browse',
      'app-module-google-search',
      'app-module-speex',
      'app-module-t2i',
      'app-purpose',
      'app-sharing',
      'app-ui',
      'app-ux-labs',
      'joy-color-scheme-dark',
      'joy-color-scheme-light',
      'joy-mode',
    ]);
    assert.deepEqual([...PRIVATE_PRO_SENSITIVE_LOCAL_STORAGE_KEYS].sort(), [
      'agi-client-workspace',
      'agi-live-file',
      'agi-logger-log',
      'app-app-chat-panes-2',
      'app-device',
      'app-metrics',
      'app-state',
    ]);
  });

  test('registers every durable source store and routes every included store through the private Pro adapter', () => {
    const sourceRoot = join(process.cwd(), 'src');
    const persistedStores = [
      ['apps/call/state/store-app-call.ts', 'app-app-call', 'portable'],
      ['apps/chat/components/panes/store-panes-manager.ts', 'app-app-chat-panes-2', 'sensitive-device'],
      ['apps/chat/components/persona-selector/store-purposes.ts', 'app-purpose', 'portable'],
      ['apps/chat/store-app-chat.ts', 'app-app-chat', 'portable'],
      ['apps/personas/store-app-personas.ts', 'app-app-personas', 'portable'],
      ['common/layout/optima/scratchclip/store-scratchclip.ts', 'agi-scratch-clip', 'portable'],
      ['common/livefile/store-live-file.ts', 'agi-live-file', 'sensitive-device'],
      ['common/logger/store-logger.ts', 'agi-logger-log', 'sensitive-device'],
      ['common/logic/store-logic-sherpa.ts', 'app-state', 'sensitive-device'],
      ['common/stores/chat/store-chats.ts', 'app-chats', 'portable-idb'],
      ['common/stores/folders/store-chat-folders.ts', 'app-folders', 'portable'],
      ['common/stores/llms/store-llms.ts', 'app-models', 'portable'],
      ['common/stores/metrics/store-metrics.ts', 'app-metrics', 'sensitive-device'],
      ['common/stores/store-ai.ts', 'app-ai-preferences', 'portable'],
      ['common/stores/store-client.ts', 'app-device', 'sensitive-device'],
      ['common/stores/store-ui.ts', 'app-ui', 'portable'],
      ['common/stores/store-ux-labs.ts', 'app-ux-labs', 'portable'],
      ['common/stores/workspace/store-client-workspace.ts', 'agi-client-workspace', 'sensitive-device'],
      ['modules/asrx/store-module-asrx.ts', 'app-module-asrx', 'portable'],
      ['modules/beam/store-module-beam.tsx', 'app-module-beam', 'portable'],
      ['modules/browse/store-module-browsing.tsx', 'app-module-browse', 'portable'],
      ['modules/google/store-module-google.ts', 'app-module-google-search', 'portable'],
      ['modules/speex/store-module-speex.ts', 'app-module-speex', 'portable'],
      ['modules/t2i/store-module-t2i.ts', 'app-module-t2i', 'portable'],
      ['modules/trade/link/store-share-link.ts', 'app-sharing', 'portable'],
    ] as const;
    const actual = new Map<string, string>();
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else if (/\.tsx?$/.test(entry.name)) {
          const source = readFileSync(absolute, 'utf8');
          if (!/\bpersist\s*\(/.test(source) || source.includes('// persist(')) continue;
          const name = source.match(/name:\s*['"]([^'"]+)['"]/)?.[1];
          if (name) actual.set(relative(sourceRoot, absolute).split(sep).join('/'), name);
        }
      }
    };
    visit(sourceRoot);
    assert.deepEqual([...actual].sort(), persistedStores.map(([file, key]) => [file, key]).sort());
    for (const [file, key, classification] of persistedStores) {
      if (classification !== 'portable' && classification !== 'sensitive-device') continue;
      const source = readFileSync(join(sourceRoot, file), 'utf8');
      const expectedAdapter = classification === 'portable'
        ? /createPrivateProPortableLocalStorageOptions/
        : /createPrivateProSensitiveLocalStorageOptions/;
      assert.match(source, expectedAdapter, `${file} must use its private Pro volatile adapter`);
      const expectedKeys = classification === 'portable'
        ? PRIVATE_PRO_PORTABLE_LOCAL_STORAGE_KEYS
        : PRIVATE_PRO_SENSITIVE_LOCAL_STORAGE_KEYS;
      assert.equal(expectedKeys.has(key as never), true, `${key} must be classified`);
    }
  });

  test('inventories every direct durable browser owner outside Zustand persistence', () => {
    const durableOwners = [
      ['common/from-v1/from-v1.ts', 'unrelated'],
      ['common/components/3rdparty/PostHogAnalytics.tsx', 'excluded'],
      ['common/util/idbUtils.ts', 'portable-idb-infrastructure'],
      ['modules/dblobs/dblobs.db.ts', 'portable-asset-legacy'],
      ['modules/private-pro/sync/privatePro.sync.cutover.ts', 'workspace-cutover'],
      ['modules/private-pro/sync/privatePro.sync.db.ts', 'managed-workspace'],
      ['modules/trade/BackupRestore.tsx', 'manual-export-only'],
    ] as const;
    const sourceRoot = join(process.cwd(), 'src');
    const actual = new Set<string>();
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
          const source = readFileSync(absolute, 'utf8');
          const active = source.replace(/^\s*\/\/.*$/gm, '');
          if (/\blocalStorage\.(?:getItem|setItem|removeItem|clear)|typeof\s+localStorage|\bindexedDB\.(?:open|deleteDatabase|databases)|new\s+\w*Dexie\s*\(|extends\s+Dexie\b/.test(active))
            actual.add(relative(sourceRoot, absolute).split(sep).join('/'));
        }
      }
    };
    visit(sourceRoot);
    assert.deepEqual([...actual].sort(), durableOwners.map(([file]) => file).sort());
  });

  test('physically removes allowlisted keys through a real patched Storage prototype while private Pro is active', () => {
    const directory = mkdtempSync(join(tmpdir(), 'big-agi-private-pro-storage-'));
    const storageFile = join(directory, 'local-storage.json');
    const script = `
      await import('fake-indexeddb/auto');
      Object.defineProperty(globalThis, 'window', { value: globalThis });
      process.env.NEXT_PUBLIC_PRIVATE_PRO_ENABLED = 'true';
      import('./src/modules/private-pro/persistence/privatePro.persistence.ts').then(async imported => {
        const module = imported.default ?? imported;
        const nativeSetItem = Storage.prototype.setItem;
        Reflect.apply(nativeSetItem, localStorage, ['app-models', 'plaintext-secret']);
        Reflect.apply(nativeSetItem, localStorage, ['unrelated-feature', 'keep-me']);
        await module.clearPrivateProManagedPersistence('uid-a', { clearUid: async () => {} });
        const nativeGetItem = Storage.prototype.getItem;
        if (Reflect.apply(nativeGetItem, localStorage, ['app-models']) !== null) throw new Error('allowlisted plaintext survived');
        if (Reflect.apply(nativeGetItem, localStorage, ['unrelated-feature']) !== 'keep-me') throw new Error('unrelated key was removed');
      }).catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const result = spawnSync(process.execPath, [
      '--experimental-webstorage', `--localstorage-file=${storageFile}`,
      '--import', 'tsx', '--eval', script,
    ], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'development' } });
    rmSync(directory, { recursive: true, force: true });
    assert.equal(result.status, 0, result.stderr);
  });

  test('removes only allowlisted legacy plaintext keys and chat cells', async () => {
    const durable = new MemoryStorage();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: durable } });
    durable.setItem('app-models', 'sentinel-provider-api-key');
    durable.setItem('app-state', 'sentinel-composer-prefill');
    durable.setItem('app-app-chat-panes-2', 'sentinel-conversation-id');
    durable.setItem('agi-logger-log', 'sentinel-logger-detail');
    durable.setItem('app-metrics', 'sentinel-service-id');
    durable.setItem('unrelated-feature', 'keep-me');
    await set('app-chats', 'sentinel-chat');
    await set('unrelated-cell', 'keep-me');

    await activatePrivateProManagedPersistence('uid-a');
    await clearPrivateProManagedPersistence('uid-a', { clearUid: async () => {} });

    assert.equal(durable.getItem('app-models'), null);
    assert.equal(durable.getItem('app-state'), null);
    assert.equal(durable.getItem('app-app-chat-panes-2'), null);
    assert.equal(durable.getItem('agi-logger-log'), null);
    assert.equal(durable.getItem('app-metrics'), null);
    assert.equal(durable.getItem('unrelated-feature'), 'keep-me');
    assert.equal(await get('app-chats'), undefined);
    assert.equal(await get('unrelated-cell'), 'keep-me');
  });

  test('atomically clears volatile values and only the requested UID sync state', async () => {
    const durable = new MemoryStorage();
    const storage = createPrivateProPortableLocalStorage(() => durable);
    const cleared: string[] = [];
    await activatePrivateProManagedPersistence('uid-a');
    storage.setItem('app-models', 'uid-a-models');

    await clearPrivateProManagedPersistence('uid-a', { clearUid: async uid => { cleared.push(uid); } });

    await activatePrivateProManagedPersistence('uid-a');
    assert.equal(storage.getItem('app-models'), null);
    assert.deepEqual(cleared, ['uid-a']);
  });

  test('stale UID cleanup cannot clear or deactivate the current account runtime', async () => {
    const storage = createPrivateProPortableLocalStorage(() => new MemoryStorage());
    let runtimeClears = 0;
    await activatePrivateProManagedPersistence('uid-b');
    storage.setItem('app-models', 'uid-b-models');

    assert.equal(await deactivatePrivateProManagedPersistence('uid-a', () => { runtimeClears++; }), false);
    assert.equal(storage.getItem('app-models'), 'uid-b-models');
    assert.equal(runtimeClears, 0);
    assert.equal(privateProManagedPersistenceUid(), 'uid-b');
  });

  test('stale same-UID owner cleanup cannot deactivate a replacement runtime', async () => {
    const storage = createPrivateProPortableLocalStorage(() => new MemoryStorage());
    const oldOwner = Symbol('old-owner');
    const replacementOwner = Symbol('replacement-owner');
    let runtimeClears = 0;
    await activatePrivateProManagedPersistenceOwned('uid-a', oldOwner);
    storage.setItem('app-models', 'uid-a-models');
    await activatePrivateProManagedPersistenceOwned('uid-a', replacementOwner);

    assert.equal(await deactivatePrivateProManagedPersistenceOwned('uid-a', oldOwner, () => { runtimeClears++; }), false);
    assert.equal(storage.getItem('app-models'), 'uid-a-models');
    assert.equal(runtimeClears, 0);
    assert.equal(privateProManagedPersistenceUid(), 'uid-a');
  });

  test('ordinary same-UID owner release preserves volatile workspace state for remount', async () => {
    const storage = createPrivateProPortableLocalStorage(() => new MemoryStorage());
    const oldOwner = Symbol('old-owner');
    const replacementOwner = Symbol('replacement-owner');
    await activatePrivateProManagedPersistenceOwned('uid-a', oldOwner);
    storage.setItem('app-models', 'uid-a-models');

    assert.equal(await releasePrivateProManagedPersistence('uid-a', oldOwner), true);
    await activatePrivateProManagedPersistenceOwned('uid-a', replacementOwner);

    assert.equal(storage.getItem('app-models'), 'uid-a-models');
    assert.equal(privateProManagedPersistenceUid(), 'uid-a');
  });

  test('released same-UID state remains discoverable for a later cross-account clear', async () => {
    const oldOwner = Symbol('old-owner');
    await activatePrivateProManagedPersistenceOwned('uid-a', oldOwner);
    await releasePrivateProManagedPersistence('uid-a', oldOwner);

    assert.equal(privateProManagedPersistenceOwnership()?.uid, 'uid-a');
  });

  test('Private Pro deactivation returns to pending-auth volatile storage instead of Open durability', async () => {
    const durable = new MemoryStorage();
    const storage = createPrivateProPortableLocalStorage(() => durable);
    await activatePrivateProManagedPersistence('uid-a');

    assert.equal(await deactivatePrivateProManagedPersistence('uid-a'), true);
    storage.setItem('app-models', 'after-deactivation');

    assert.equal(isPrivateProManagedPersistenceActive(), true);
    assert.equal(privateProManagedPersistenceUid(), null);
    assert.equal(storage.getItem('app-models'), 'after-deactivation');
    assert.equal(durable.getItem('app-models'), null);
  });

  test('Private Pro IDB adapter stays volatile while pending authentication', async () => {
    const { createPrivateProPortableIDBStorage } = await import('./privatePro.persistence');
    const durableValues = new Map<string, unknown>();
    await activatePrivateProManagedPersistence('uid-a');
    await deactivatePrivateProManagedPersistence('uid-a');
    const storage = createPrivateProPortableIDBStorage<{ value: string }>({
      getItem: async name => durableValues.get(name) as never ?? null,
      setItem: async (name, value) => { durableValues.set(name, value); },
      removeItem: async name => { durableValues.delete(name); },
    });
    if (!storage) assert.fail('Expected IndexedDB storage.');

    await storage.setItem('app-chats', { state: { value: 'pending-auth' }, version: 1 });

    assert.deepEqual(await storage.getItem('app-chats'), { state: { value: 'pending-auth' }, version: 1 });
    assert.equal(durableValues.has('app-chats'), false);
  });
});
