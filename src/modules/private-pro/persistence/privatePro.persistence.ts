import type { PersistStorage, StorageValue } from 'zustand/middleware';

import { createIDBPersistStorage } from '~/common/util/idbUtils';


export const PRIVATE_PRO_PORTABLE_LOCAL_STORAGE_KEYS = new Set([
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
] as const);

export const PRIVATE_PRO_PORTABLE_IDB_KEYS = new Set(['app-chats', 'app-chats-v3'] as const);

export const PRIVATE_PRO_SENSITIVE_LOCAL_STORAGE_KEYS = new Set([
  'agi-client-workspace',
  'agi-live-file',
  'agi-logger-log',
  'app-app-chat-panes-2',
  'app-device',
  'app-metrics',
  'app-state',
] as const);

const encryptedBuild = process.env.NEXT_PUBLIC_PRIVATE_PRO_ENABLED === 'true';
let encryptedPersistenceActive = encryptedBuild;
const volatileLocalStorage = new Map<string, string>();
const volatilePersistStorage = new Map<string, StorageValue<unknown>>();
const pendingPortableAssets = new Set<string>();
const patchedStorage = Symbol.for('big-agi.private-pro-portable-storage');
let rawLocalStorageRemoveItem: ((storage: Storage, key: string) => void) | null = null;


function assertPortableLocalStorageKey(key: string): void {
  if (!PRIVATE_PRO_PORTABLE_LOCAL_STORAGE_KEYS.has(key as never))
    throw new Error(`Private Pro portable localStorage key is outside the allowlist: ${key}`);
}

function assertSensitiveLocalStorageKey(key: string): void {
  if (!PRIVATE_PRO_SENSITIVE_LOCAL_STORAGE_KEYS.has(key as never))
    throw new Error(`Private Pro sensitive localStorage key is outside the allowlist: ${key}`);
}

function isPrivateProVolatileLocalStorageKey(key: string): boolean {
  return PRIVATE_PRO_PORTABLE_LOCAL_STORAGE_KEYS.has(key as never)
    || PRIVATE_PRO_SENSITIVE_LOCAL_STORAGE_KEYS.has(key as never);
}

function assertPortableIDBKey(key: string): void {
  if (!PRIVATE_PRO_PORTABLE_IDB_KEYS.has(key as never))
    throw new Error(`Private Pro portable IndexedDB key is outside the allowlist: ${key}`);
}

function browserLocalStorage(): Storage | null {
  return typeof window === 'undefined' ? null : window.localStorage;
}

function cloneStorageValue<S>(value: StorageValue<S>): StorageValue<S> {
  return JSON.parse(JSON.stringify(value)) as StorageValue<S>;
}

export function isPrivateProEncryptedPersistenceActive(): boolean {
  return encryptedPersistenceActive;
}

export function setPrivateProEncryptedPersistenceActive(active: boolean): void {
  encryptedPersistenceActive = active;
  if (!encryptedPersistenceActive) clearPrivateProVolatilePortableState();
}

export function clearPrivateProVolatilePortableState(): void {
  volatileLocalStorage.clear();
  volatilePersistStorage.clear();
  pendingPortableAssets.clear();
}

export function markPrivateProPortableAssetPending(assetId: string): void {
  if (encryptedPersistenceActive) pendingPortableAssets.add(assetId);
}

export function markPrivateProPortableAssetEncrypted(assetId: string): void {
  pendingPortableAssets.delete(assetId);
}

export function hasPrivateProPendingPortableAssets(): boolean {
  return encryptedPersistenceActive && pendingPortableAssets.size > 0;
}

export function privateProPortableAssetBeforeUnload(event: Pick<BeforeUnloadEvent, 'preventDefault' | 'returnValue'>): string | undefined {
  if (!hasPrivateProPendingPortableAssets()) return undefined;
  const message = 'Encrypted attachments are still being saved.';
  event.preventDefault();
  event.returnValue = message;
  return message;
}

export function createPrivateProPortableLocalStorage(
  getDurableStorage: () => Storage | null = browserLocalStorage,
): Storage {
  return {
    get length() {
      return encryptedPersistenceActive ? volatileLocalStorage.size : getDurableStorage()?.length ?? 0;
    },
    clear() {
      if (encryptedPersistenceActive) {
        volatileLocalStorage.clear();
        return;
      }
      getDurableStorage()?.clear();
    },
    getItem(key) {
      if (encryptedPersistenceActive) {
        assertPortableLocalStorageKey(key);
        return volatileLocalStorage.get(key) ?? null;
      }
      return getDurableStorage()?.getItem(key) ?? null;
    },
    key(index) {
      if (encryptedPersistenceActive) return [...volatileLocalStorage.keys()][index] ?? null;
      return getDurableStorage()?.key(index) ?? null;
    },
    removeItem(key) {
      if (encryptedPersistenceActive) {
        assertPortableLocalStorageKey(key);
        volatileLocalStorage.delete(key);
        return;
      }
      getDurableStorage()?.removeItem(key);
    },
    setItem(key, value) {
      if (encryptedPersistenceActive) {
        assertPortableLocalStorageKey(key);
        volatileLocalStorage.set(key, value);
        return;
      }
      getDurableStorage()?.setItem(key, value);
    },
  };
}

export const privateProPortableLocalStorage = createPrivateProPortableLocalStorage();

function createPrivateProVolatileZustandStorage<S>(assertKey: (key: string) => void): PersistStorage<S> {
  return {
    getItem(name) {
      if (encryptedPersistenceActive) {
        assertKey(name);
        const value = volatilePersistStorage.get(name) as StorageValue<S> | undefined;
        return value === undefined ? null : cloneStorageValue(value);
      }
      const raw = browserLocalStorage()?.getItem(name);
      return raw === null || raw === undefined ? null : JSON.parse(raw) as StorageValue<S>;
    },
    setItem(name, value) {
      if (encryptedPersistenceActive) {
        assertKey(name);
        volatilePersistStorage.set(name, cloneStorageValue(value) as StorageValue<unknown>);
        return;
      }
      browserLocalStorage()?.setItem(name, JSON.stringify(value));
    },
    removeItem(name) {
      if (encryptedPersistenceActive) {
        assertKey(name);
        volatilePersistStorage.delete(name);
        return;
      }
      browserLocalStorage()?.removeItem(name);
    },
  };
}

export function createPrivateProPortableZustandStorage<S>(): PersistStorage<S> {
  return createPrivateProVolatileZustandStorage(assertPortableLocalStorageKey);
}

export function createPrivateProPortableLocalStorageOptions<S>(): { storage: PersistStorage<S> } {
  return { storage: createPrivateProPortableZustandStorage<S>() };
}

export function createPrivateProSensitiveLocalStorageOptions<S>(): { storage: PersistStorage<S> } {
  return { storage: createPrivateProVolatileZustandStorage<S>(assertSensitiveLocalStorageKey) };
}

export function createPrivateProPortableIDBStorage<S>(): PersistStorage<S> | undefined {
  const durable = createIDBPersistStorage<S>();
  if (!durable) return undefined;
  return {
    getItem(name) {
      if (encryptedPersistenceActive) {
        assertPortableIDBKey(name);
        const value = volatilePersistStorage.get(name) as StorageValue<S> | undefined;
        return value === undefined ? null : cloneStorageValue(value);
      }
      return durable.getItem(name);
    },
    setItem(name, value) {
      if (encryptedPersistenceActive) {
        assertPortableIDBKey(name);
        volatilePersistStorage.set(name, cloneStorageValue(value) as StorageValue<unknown>);
        return;
      }
      return durable.setItem(name, value);
    },
    removeItem(name) {
      if (encryptedPersistenceActive) {
        assertPortableIDBKey(name);
        volatilePersistStorage.delete(name);
        return;
      }
      return durable.removeItem(name);
    },
  };
}

export async function clearPrivateProPlaintextPortablePersistence(): Promise<void> {
  clearPrivateProVolatilePortableState();
  if (typeof window === 'undefined') return;
  for (const key of [...PRIVATE_PRO_PORTABLE_LOCAL_STORAGE_KEYS, ...PRIVATE_PRO_SENSITIVE_LOCAL_STORAGE_KEYS]) {
    if (rawLocalStorageRemoveItem) rawLocalStorageRemoveItem(window.localStorage, key);
    else window.localStorage.removeItem(key);
  }
  const { del } = await import('idb-keyval');
  const { clearPrivateProPlaintextDBlobPersistence } = await import('~/modules/dblobs/dblobs.db');
  await Promise.all([
    ...[...PRIVATE_PRO_PORTABLE_IDB_KEYS].map(key => del(key)),
    clearPrivateProPlaintextDBlobPersistence(),
  ]);
}

function installPrivateProStoragePrototypeGate(): void {
  if (!encryptedBuild || typeof window === 'undefined' || typeof Storage === 'undefined') return;
  const prototype = Storage.prototype as Storage & { [patchedStorage]?: true };
  if (prototype[patchedStorage]) return;
  const descriptor = (name: 'getItem' | 'setItem' | 'removeItem') => {
    const value = Object.getOwnPropertyDescriptor(Storage.prototype, name)?.value;
    if (typeof value !== 'function') throw new Error(`Storage.${name} is unavailable.`);
    return value as (...args: unknown[]) => unknown;
  };
  const getItem = descriptor('getItem');
  const setItem = descriptor('setItem');
  const removeItem = descriptor('removeItem');
  rawLocalStorageRemoveItem = (storage, key) => { Reflect.apply(removeItem, storage, [key]); };
  Object.defineProperty(prototype, patchedStorage, { value: true });
  prototype.getItem = function(key: string) {
    if (encryptedPersistenceActive && isPrivateProVolatileLocalStorageKey(key))
      return volatileLocalStorage.get(key) ?? null;
    return Reflect.apply(getItem, this, [key]) as string | null;
  };
  prototype.setItem = function(key: string, value: string) {
    if (encryptedPersistenceActive && isPrivateProVolatileLocalStorageKey(key)) {
      volatileLocalStorage.set(key, value);
      return;
    }
    Reflect.apply(setItem, this, [key, value]);
  };
  prototype.removeItem = function(key: string) {
    if (encryptedPersistenceActive && isPrivateProVolatileLocalStorageKey(key)) {
      volatileLocalStorage.delete(key);
      return;
    }
    Reflect.apply(removeItem, this, [key]);
  };
}

installPrivateProStoragePrototypeGate();
