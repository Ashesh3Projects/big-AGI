import Dexie, { type EntityTable, type Table } from 'dexie';

import { PrivateProVaultEnvelopeSchema } from './privatePro.vault.schemas';
import type {
  PrivateProVaultEnvelope,
  PrivateProVaultOperation,
  PrivateProVaultRecordType,
  PrivateProVaultWrappedKeyEnvelope,
} from './privatePro.vault.types';


export const PRIVATE_PRO_VAULT_DB_VERSION = 1;

export interface PrivateProVaultDeviceKeyRecord {
  uid: string;
  key: CryptoKey;
}

export interface PrivateProVaultWrappedKeyRecord {
  uid: string;
  envelope: PrivateProVaultWrappedKeyEnvelope;
}

export interface PrivateProVaultEncryptedRecord {
  uid: string;
  recordType: PrivateProVaultRecordType;
  recordId: string;
  revision: number;
  envelope: PrivateProVaultEnvelope;
}

export interface PrivateProVaultOutboxRecord {
  uid: string;
  operationId: string;
  operation: PrivateProVaultOperation;
  createdAtMs: number;
  localSequence?: number;
}

export interface PrivateProVaultRevisionRecord {
  uid: string;
  recordType: PrivateProVaultRecordType;
  recordId: string;
  revision: number;
}

export interface PrivateProVaultMigrationRecord {
  uid: string;
  migrationId: string;
  phase: string;
  updatedAtMs: number;
  encryptedError?: PrivateProVaultEnvelope;
}

export interface PrivateProVaultQuarantineRecord {
  id?: number;
  uid: string;
  recordType: PrivateProVaultRecordType;
  recordId: string;
  reasonCode: string;
  envelope: PrivateProVaultEnvelope;
  createdAtMs: number;
}


function hasExactKeyUsages(key: CryptoKey, expectedUsages: readonly KeyUsage[]): boolean {
  return key.usages.length === expectedUsages.length
    && expectedUsages.every(usage => key.usages.includes(usage));
}

function assertRememberedDeviceKey(key: CryptoKey): void {
  const algorithm = key.algorithm;
  if (
    key.type !== 'secret'
    || key.extractable
    || algorithm.name !== 'AES-GCM'
    || !('length' in algorithm)
    || algorithm.length !== 256
    || !hasExactKeyUsages(key, ['wrapKey', 'unwrapKey'])
  )
    throw new Error('Remembered device keys must be non-exportable AES-GCM 256-bit keys with exactly wrapKey and unwrapKey usages.');
}


export class PrivateProVaultDB extends Dexie {
  deviceKeys!: EntityTable<PrivateProVaultDeviceKeyRecord, 'uid'>;
  wrappedKeys!: EntityTable<PrivateProVaultWrappedKeyRecord, 'uid'>;
  records!: Table<PrivateProVaultEncryptedRecord, [string, PrivateProVaultRecordType, string]>;
  outbox!: Table<PrivateProVaultOutboxRecord, [string, string]>;
  revisions!: Table<PrivateProVaultRevisionRecord, [string, PrivateProVaultRecordType, string]>;
  migration!: Table<PrivateProVaultMigrationRecord, [string, string]>;
  quarantine!: EntityTable<PrivateProVaultQuarantineRecord, 'id'>;

  constructor(name = 'private-pro-vault-v1') {
    super(name);
    this.version(PRIVATE_PRO_VAULT_DB_VERSION).stores({
      deviceKeys: '&uid',
      wrappedKeys: '&uid',
      records: '[uid+recordType+recordId], uid, [uid+recordType], revision',
      outbox: '[uid+operationId], uid, createdAtMs',
      revisions: '[uid+recordType+recordId], uid, revision',
      migration: '[uid+migrationId], uid, phase, updatedAtMs',
      quarantine: '++id, uid, [uid+recordType+recordId], createdAtMs',
    });
  }

  async storeDeviceKey(uid: string, key: CryptoKey): Promise<void> {
    assertRememberedDeviceKey(key);
    await this.deviceKeys.put({ uid, key });
  }

  async getDeviceKey(uid: string): Promise<CryptoKey | null> {
    return (await this.deviceKeys.get(uid))?.key ?? null;
  }

  async deleteDeviceUnlock(uid: string): Promise<void> {
    await this.transaction('rw', [this.deviceKeys, this.wrappedKeys], async () => {
      await Promise.all([
        this.deviceKeys.delete(uid),
        this.wrappedKeys.delete(uid),
      ]);
    });
  }

  async putEncryptedRecord(uid: string, envelope: PrivateProVaultEnvelope): Promise<void> {
    const validatedEnvelope = PrivateProVaultEnvelopeSchema.parse(envelope);
    await this.records.put({
      uid,
      recordType: validatedEnvelope.recordType,
      recordId: validatedEnvelope.recordId,
      revision: validatedEnvelope.revision,
      envelope: structuredClone(validatedEnvelope),
    });
  }

  async listEncryptedRecords(uid: string): Promise<PrivateProVaultEnvelope[]> {
    const records = await this.records.where('uid').equals(uid).sortBy('recordId');
    return records.map(record => structuredClone(record.envelope));
  }

  async backfillOutboxLocalSequences(uid: string): Promise<number> {
    return this.transaction('rw', this.outbox, async () => {
      const records = (await this.outbox.where('uid').equals(uid).toArray()).sort((left, right) =>
        left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0);
      let maximum = records.reduce((current, record) =>
        Number.isSafeInteger(record.localSequence) && record.localSequence! > 0
          ? Math.max(current, record.localSequence!)
          : current,
      0);
      for (const record of records) {
        if (Number.isSafeInteger(record.localSequence) && record.localSequence! > 0) continue;
        maximum++;
        await this.outbox.update([uid, record.operationId], { localSequence: maximum });
      }
      return maximum;
    });
  }
}

export const privateProVaultDB = new PrivateProVaultDB();
