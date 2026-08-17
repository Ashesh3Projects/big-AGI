export interface PrivateProVaultDeviceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}


function storageKey(uid: string): string {
  return `private-pro-vault-device:${uid}`;
}

function bytesToOpaqueId(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function browserStorage(): PrivateProVaultDeviceStorage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

export async function getPrivateProVaultDeviceId(
  uid: string,
  storage: PrivateProVaultDeviceStorage | null = browserStorage(),
): Promise<string> {
  const key = storageKey(uid);
  let seed = storage?.getItem(key);
  if (!seed) {
    seed = bytesToOpaqueId(crypto.getRandomValues(new Uint8Array(32)));
    storage?.setItem(key, seed);
  }
  return bytesToOpaqueId(new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`private-pro-vault-device\0${uid}\0${seed}`),
  )));
}

export async function resolvePrivateProVaultRequestDeviceId(
  uid: string,
  db: { getDeviceUnlock(uid: string): Promise<{ deviceId: string } | null> },
  storage: PrivateProVaultDeviceStorage | null = browserStorage(),
): Promise<string> {
  const remembered = await db.getDeviceUnlock(uid);
  if (remembered) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(remembered.deviceId))
      throw new Error('Remembered vault device identity is invalid.');
    return remembered.deviceId;
  }
  return getPrivateProVaultDeviceId(uid, storage);
}

export function clearPrivateProVaultDeviceId(
  uid: string,
  storage: PrivateProVaultDeviceStorage | null = browserStorage(),
): void {
  storage?.removeItem(storageKey(uid));
}
