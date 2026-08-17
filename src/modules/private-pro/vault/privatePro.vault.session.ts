import { privateProVaultDB, type PrivateProVaultDB } from './privatePro.vault.db';


interface PrivateProVaultUnlockedSession {
  uid: string;
  masterKey: CryptoKey;
}


function hasExactKeyUsages(key: CryptoKey, expectedUsages: readonly KeyUsage[]): boolean {
  return key.usages.length === expectedUsages.length
    && expectedUsages.every(usage => key.usages.includes(usage));
}

function assertMasterKey(key: CryptoKey): void {
  const algorithm = key.algorithm;
  if (
    key.type !== 'secret'
    || key.extractable
    || algorithm.name !== 'HKDF'
    || !hasExactKeyUsages(key, ['deriveKey'])
  )
    throw new Error('Vault sessions require a non-exportable HKDF master key with exactly deriveKey usage.');
}


export class PrivateProVaultSession {
  private unlocked: PrivateProVaultUnlockedSession | null = null;

  constructor(private readonly db: PrivateProVaultDB = privateProVaultDB) {}

  unlock(uid: string, masterKey: CryptoKey): void {
    assertMasterKey(masterKey);
    this.unlocked = { uid, masterKey };
  }

  getMasterKey(uid: string): CryptoKey | null {
    return this.unlocked?.uid === uid ? this.unlocked.masterKey : null;
  }

  lock(): void {
    this.unlocked = null;
  }

  async logoutAndClear(uid: string): Promise<void> {
    if (this.unlocked?.uid === uid)
      this.lock();
    await this.db.deleteDeviceUnlock(uid);
  }
}

export const privateProVaultSession = new PrivateProVaultSession();
