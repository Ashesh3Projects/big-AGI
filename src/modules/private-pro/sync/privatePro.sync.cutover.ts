import {
  PRIVATE_PRO_PORTABLE_IDB_KEYS,
  PRIVATE_PRO_PORTABLE_LOCAL_STORAGE_KEYS,
  PRIVATE_PRO_SENSITIVE_LOCAL_STORAGE_KEYS,
  removePrivateProDurableLocalStorageItem,
} from '../persistence/privatePro.persistence';


export const PRIVATE_PRO_WORKSPACE_V1_CUTOVER_MARKER = 'private-pro-cutover:workspace-v1';

const PRIVATE_PRO_LEGACY_DATABASES = [
  'private-pro-vault-v1',
  'private-pro-sync-v1',
] as const;

const PRIVATE_PRO_LEGACY_LOCAL_STORAGE_PREFIXES = [
  'private-pro-vault-device:',
] as const;

export interface PrivateProWorkspaceV1LocalCutoverPort {
  localStorageKeys(): readonly string[];
  getLocalStorageItem(key: string): string | null;
  removeLocalStorageItem(key: string): void;
  setLocalStorageItem(key: string, value: string): void;
  removePortableIDBItem(key: string): Promise<void>;
  deleteDatabase(name: string): Promise<void>;
  clearLegacyAssets(): Promise<void>;
}

interface PrivateProWorkspaceV1BrowserCutoverDependencies {
  storage: Storage;
  indexedDB: Pick<IDBFactory, 'deleteDatabase'>;
  removeDurableLocalStorageItem(storage: Storage, key: string): void;
  removePortableIDBItem(key: string): Promise<void>;
  clearLegacyAssets(): Promise<void>;
}

function deleteIndexedDBDatabase(
  indexedDB: Pick<IDBFactory, 'deleteDatabase'>,
  name: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error('Private Pro legacy database could not be deleted.'));
    request.onblocked = () => reject(new Error('Private Pro legacy database could not be deleted.'));
  });
}

export function createPrivateProWorkspaceV1BrowserCutoverPort(
  dependencies: PrivateProWorkspaceV1BrowserCutoverDependencies,
): PrivateProWorkspaceV1LocalCutoverPort {
  return {
    localStorageKeys: () => Array.from({ length: dependencies.storage.length }, (_, index) => dependencies.storage.key(index))
      .filter((key): key is string => key !== null),
    getLocalStorageItem: key => dependencies.storage.getItem(key),
    removeLocalStorageItem: key => dependencies.removeDurableLocalStorageItem(dependencies.storage, key),
    setLocalStorageItem: (key, value) => dependencies.storage.setItem(key, value),
    removePortableIDBItem: key => dependencies.removePortableIDBItem(key),
    deleteDatabase: name => deleteIndexedDBDatabase(dependencies.indexedDB, name),
    clearLegacyAssets: () => dependencies.clearLegacyAssets(),
  };
}

export async function createPrivateProWorkspaceV1ProductionCutoverPort(): Promise<PrivateProWorkspaceV1LocalCutoverPort> {
  const [{ del }, { clearPrivateProLegacyPlaintextDBlobPersistence }] = await Promise.all([
    import('idb-keyval'),
    import('~/modules/dblobs/dblobs.db'),
  ]);
  return createPrivateProWorkspaceV1BrowserCutoverPort({
    storage: window.localStorage,
    indexedDB: window.indexedDB,
    removeDurableLocalStorageItem: removePrivateProDurableLocalStorageItem,
    removePortableIDBItem: key => del(key),
    clearLegacyAssets: clearPrivateProLegacyPlaintextDBlobPersistence,
  });
}

export async function runPrivateProWorkspaceV1LocalCutover(
  port: PrivateProWorkspaceV1LocalCutoverPort,
): Promise<void> {
  if (port.getLocalStorageItem(PRIVATE_PRO_WORKSPACE_V1_CUTOVER_MARKER) !== null) return;

  for (const key of port.localStorageKeys()) {
    if (
      PRIVATE_PRO_PORTABLE_LOCAL_STORAGE_KEYS.has(key as never)
      || PRIVATE_PRO_SENSITIVE_LOCAL_STORAGE_KEYS.has(key as never)
      || PRIVATE_PRO_LEGACY_LOCAL_STORAGE_PREFIXES.some(prefix => key.startsWith(prefix))
    ) port.removeLocalStorageItem(key);
  }

  for (const key of PRIVATE_PRO_PORTABLE_IDB_KEYS) await port.removePortableIDBItem(key);
  for (const databaseName of PRIVATE_PRO_LEGACY_DATABASES) await port.deleteDatabase(databaseName);
  await port.clearLegacyAssets();
  port.setLocalStorageItem(PRIVATE_PRO_WORKSPACE_V1_CUTOVER_MARKER, '1');
}
