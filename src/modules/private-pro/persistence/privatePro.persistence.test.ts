import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { get, set } from 'idb-keyval';

import {
  PRIVATE_PRO_PORTABLE_LOCAL_STORAGE_KEYS,
  clearPrivateProPlaintextPortablePersistence,
  createPrivateProPortableLocalStorage,
  isPrivateProEncryptedPersistenceActive,
  setPrivateProEncryptedPersistenceActive,
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


afterEach(() => setPrivateProEncryptedPersistenceActive(false));

describe('private Pro portable persistence gate', () => {
  test('uses volatile storage for an explicit portable key while encrypted persistence is active', () => {
    const durable = new MemoryStorage();
    const storage = createPrivateProPortableLocalStorage(() => durable);
    const key = 'app-models';
    const sentinel = 'sentinel-provider-api-key';

    setPrivateProEncryptedPersistenceActive(true);
    storage.setItem(key, sentinel);

    assert.equal(isPrivateProEncryptedPersistenceActive(), true);
    assert.equal(storage.getItem(key), sentinel);
    assert.equal(durable.getItem(key), null);
  });

  test('keeps Open storage behavior unchanged', () => {
    const durable = new MemoryStorage();
    const storage = createPrivateProPortableLocalStorage(() => durable);

    setPrivateProEncryptedPersistenceActive(false);
    storage.setItem('app-models', 'open-model-state');

    assert.equal(durable.getItem('app-models'), 'open-model-state');
    assert.equal(storage.getItem('app-models'), 'open-model-state');
  });

  test('fails closed for portable stores outside the inclusion list', () => {
    const storage = createPrivateProPortableLocalStorage(() => new MemoryStorage());
    setPrivateProEncryptedPersistenceActive(true);

    assert.throws(() => storage.setItem('unregistered-portable-store', 'secret'), /allowlist/i);
  });

  test('declares every Task 11 localStorage persistence key explicitly', () => {
    assert.deepEqual([...PRIVATE_PRO_PORTABLE_LOCAL_STORAGE_KEYS].sort(), [
      'agi-scratch-clip',
      'app-app-personas',
      'app-folders',
      'app-models',
      'app-module-asrx',
      'app-module-google-search',
      'app-module-speex',
      'app-sharing',
      'joy-color-scheme-dark',
      'joy-color-scheme-light',
      'joy-mode',
    ]);
  });

  test('removes only allowlisted legacy plaintext keys and chat cells', async () => {
    const durable = new MemoryStorage();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: durable } });
    durable.setItem('app-models', 'sentinel-provider-api-key');
    durable.setItem('unrelated-feature', 'keep-me');
    await set('app-chats', 'sentinel-chat');
    await set('unrelated-cell', 'keep-me');

    await clearPrivateProPlaintextPortablePersistence();

    assert.equal(durable.getItem('app-models'), null);
    assert.equal(durable.getItem('unrelated-feature'), 'keep-me');
    assert.equal(await get('app-chats'), undefined);
    assert.equal(await get('unrelated-cell'), 'keep-me');
  });
});
