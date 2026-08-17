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


function assertRememberedDeviceKey(key: CryptoKey): void {
  const algorithm = key.algorithm;
  if (
    key.type !== 'secret'
    || key.extractable
    || algorithm.name !== 'AES-GCM'
    || !('length' in algorithm)
    || algorithm.length !== 256
    || !key.usages.includes('wrapKey')
    || !key.usages.includes('unwrapKey')
  )
    throw new Error('Remembered device keys must be non-exportable AES-GCM 256-bit keys with wrapKey and unwrapKey usage.');
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
}

export const privateProVaultDB = new PrivateProVaultDB();
