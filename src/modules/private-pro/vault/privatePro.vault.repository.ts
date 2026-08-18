import type {
  PrivateProVaultDeviceMetadata,
  PrivateProVaultEnvelope,
  PrivateProVaultKeyset,
  PrivateProVaultRecordType,
  PrivateProVaultTombstone,
} from './privatePro.vault.types';


export const PRIVATE_PRO_VAULT_FIRESTORE_MAX_CIPHERTEXT_BYTES = 700 * 1024;
export const PRIVATE_PRO_VAULT_MAX_INDEX_PAGE_SIZE = 500;
export const PRIVATE_PRO_VAULT_BACKUP_MAX_RECORDS = 200;
export const PRIVATE_PRO_VAULT_BACKUP_MAX_TOTAL_CIPHERTEXT_BYTES = 4 * 1024 * 1024;

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
  wrappingVersion: number;
  serverUpdatedAtMs: number;
  keyset: PrivateProVaultKeyset;
}

export type PrivateProVaultStoredDevice = PrivateProVaultDeviceMetadata;

export interface PrivateProVaultSecurityEvent {
  formatVersion: 1;
  eventId: string;
  deviceId: string;
  type: 'recovery-password-reset' | 'password-changed';
  createdAtMs: number;
}

export interface PrivateProVaultRegistrationChallenge {
  formatVersion: 1;
  challengeId: string;
  challengeBase64: string;
  deviceId: string;
  keyVersion: number;
  expiresAtMs: number;
}

export type PrivateProVaultOperationOutcome =
  | { kind: 'record'; status: 'committed'; revision: number; serverUpdatedAtMs: number }
  | { kind: 'record'; status: 'conflict'; currentRevision: number }
  | { kind: 'keyset'; status: 'committed'; wrappingVersion: number; serverUpdatedAtMs: number }
  | { kind: 'keyset'; status: 'conflict'; currentWrappingVersion: number }
  | { kind: 'device'; status: 'committed'; revokedAtMs: number }
  | { kind: 'device-registration'; status: 'committed'; device: PrivateProVaultStoredDevice };

export interface PrivateProVaultBackupMergeRecordOutcome {
  opaqueRecordId: string;
  revision: number;
  serverUpdatedAtMs: number;
}

export type PrivateProVaultBackupMergeOutcome = {
  status: 'committed';
  records: PrivateProVaultBackupMergeRecordOutcome[];
};

export interface PrivateProVaultOperationReceipt {
  operationId: string;
  requestFingerprint: string;
  outcome: PrivateProVaultOperationOutcome;
}

export interface PrivateProVaultBackupMergeReceipt {
  operationId: string;
  requestFingerprint: string;
  outcome: PrivateProVaultBackupMergeOutcome;
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
  getBackupMerge(operationId: string): Promise<PrivateProVaultBackupMergeReceipt | null>;
  createBackupMerge(receipt: PrivateProVaultBackupMergeReceipt): Promise<void>;
  getKeyset(): Promise<PrivateProVaultStoredKeyset | null>;
  setKeyset(keyset: PrivateProVaultStoredKeyset): Promise<void>;
  getDevice(deviceId: string): Promise<PrivateProVaultStoredDevice | null>;
  setDevice(device: PrivateProVaultStoredDevice): Promise<void>;
  listDevices(): Promise<PrivateProVaultStoredDevice[]>;
  getRegistrationChallenge(challengeId: string): Promise<PrivateProVaultRegistrationChallenge | null>;
  createRegistrationChallenge(challenge: PrivateProVaultRegistrationChallenge): Promise<void>;
  deleteRegistrationChallenge(challengeId: string): Promise<void>;
  createSecurityEvent(event: PrivateProVaultSecurityEvent): Promise<void>;
}

export interface PrivateProVaultRepository {
  transaction<T>(uid: string, callback: (transaction: PrivateProVaultRepositoryTransaction) => Promise<T>): Promise<T>;
  listIndexEntries(uid: string, afterOpaqueRecordId: string | null, limit: number): Promise<PrivateProVaultIndexEntry[]>;
  getRecords(uid: string, opaqueRecordIds: readonly string[]): Promise<PrivateProVaultStoredRecord[]>;
}

export function comparePrivateProVaultOpaqueIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function recordIndexEntry(record: PrivateProVaultStoredRecord): PrivateProVaultIndexEntry {
  return {
    kind: 'record',
    opaqueRecordId: record.opaqueRecordId,
    recordType: record.envelope.recordType,
    revision: record.revision,
    keyVersion: record.envelope.keyVersion,
    ciphertextBytes: record.envelope.ciphertextBytes,
    serverUpdatedAtMs: record.serverUpdatedAtMs,
  };
}

function tombstoneIndexEntry(tombstone: PrivateProVaultStoredTombstone): PrivateProVaultIndexEntry {
  return {
    kind: 'tombstone',
    opaqueRecordId: tombstone.opaqueRecordId,
    recordType: tombstone.tombstone.recordType,
    revision: tombstone.revision,
    keyVersion: tombstone.tombstone.keyVersion,
    serverUpdatedAtMs: tombstone.serverUpdatedAtMs,
  };
}

export function mergePrivateProVaultIndexEntries(
  records: readonly PrivateProVaultStoredRecord[],
  tombstones: readonly PrivateProVaultStoredTombstone[],
  limit: number,
): PrivateProVaultIndexEntry[] {
  return [
    ...records.map(recordIndexEntry),
    ...tombstones.map(tombstoneIndexEntry),
  ].sort((left, right) => comparePrivateProVaultOpaqueIds(left.opaqueRecordId, right.opaqueRecordId)).slice(0, limit);
}
