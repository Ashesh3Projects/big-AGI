import type {
  PrivateProVaultEnvelope,
  PrivateProVaultKeyset,
  PrivateProVaultRecordType,
  PrivateProVaultTombstone,
} from './privatePro.vault.types';


export const PRIVATE_PRO_VAULT_FIRESTORE_MAX_CIPHERTEXT_BYTES = 700 * 1024;
export const PRIVATE_PRO_VAULT_MAX_INDEX_PAGE_SIZE = 500;

export interface PrivateProVaultStoredRecord {
  opaqueRecordId: string;
  revision: number;
  serverUpdatedAtMs: number;
  envelope: PrivateProVaultEnvelope;
}

export interface PrivateProVaultStoredTombstone {
  opaqueRecordId: string;
  revision: number;
  serverUpdatedAtMs: number;
  tombstone: PrivateProVaultTombstone;
}

export interface PrivateProVaultStoredKeyset {
  keyVersion: number;
  serverUpdatedAtMs: number;
  keyset: PrivateProVaultKeyset;
}

export type PrivateProVaultMigrationPhase = string;

export interface PrivateProVaultMigrationState {
  migrationId: string;
  phase: PrivateProVaultMigrationPhase;
  serverUpdatedAtMs: number;
}

export type PrivateProVaultOperationOutcome =
  | { kind: 'record'; status: 'committed'; revision: number; serverUpdatedAtMs: number }
  | { kind: 'record'; status: 'conflict'; currentRevision: number }
  | { kind: 'keyset'; status: 'committed'; keyVersion: number; serverUpdatedAtMs: number }
  | { kind: 'keyset'; status: 'conflict'; currentKeyVersion: number }
  | { kind: 'migration'; status: 'committed'; phase: PrivateProVaultMigrationPhase; serverUpdatedAtMs: number }
  | { kind: 'migration'; status: 'conflict'; currentPhase: PrivateProVaultMigrationPhase | null };

export interface PrivateProVaultOperationReceipt {
  operationId: string;
  requestFingerprint: string;
  outcome: PrivateProVaultOperationOutcome;
}

export type PrivateProVaultIndexEntry = {
  opaqueRecordId: string;
  recordType: PrivateProVaultRecordType;
  revision: number;
  keyVersion: number;
  serverUpdatedAtMs: number;
} & ({
  kind: 'record';
  ciphertextBytes: number;
} | {
  kind: 'tombstone';
});

export interface PrivateProVaultRepositoryTransaction {
  getRecord(opaqueRecordId: string): Promise<PrivateProVaultStoredRecord | null>;
  setRecord(record: PrivateProVaultStoredRecord): Promise<void>;
  deleteRecord(opaqueRecordId: string): Promise<void>;
  getTombstone(opaqueRecordId: string): Promise<PrivateProVaultStoredTombstone | null>;
  setTombstone(tombstone: PrivateProVaultStoredTombstone): Promise<void>;
  deleteTombstone(opaqueRecordId: string): Promise<void>;
  getOperation(operationId: string): Promise<PrivateProVaultOperationReceipt | null>;
  createOperation(operation: PrivateProVaultOperationReceipt): Promise<void>;
  getKeyset(): Promise<PrivateProVaultStoredKeyset | null>;
  setKeyset(keyset: PrivateProVaultStoredKeyset): Promise<void>;
  getMigration(migrationId: string): Promise<PrivateProVaultMigrationState | null>;
  setMigration(migration: PrivateProVaultMigrationState): Promise<void>;
}

export interface PrivateProVaultRepository {
  transaction<T>(uid: string, callback: (transaction: PrivateProVaultRepositoryTransaction) => Promise<T>): Promise<T>;
  listIndexEntries(uid: string, afterOpaqueRecordId: string | null, limit: number): Promise<PrivateProVaultIndexEntry[]>;
  getRecords(uid: string, opaqueRecordIds: readonly string[]): Promise<PrivateProVaultStoredRecord[]>;
}
