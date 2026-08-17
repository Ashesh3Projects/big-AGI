export type PrivateProVaultRecordType =
  | 'credential-service'
  | 'model-service'
  | 'settings'
  | 'chat'
  | 'persona'
  | 'folder'
  | 'scratch'
  | 'asset-manifest';

export interface PrivateProVaultEnvelope {
  formatVersion: 1;
  recordType: PrivateProVaultRecordType;
  recordId: string;
  schemaVersion: number;
  keyVersion: number;
  revision: number;
  nonceBase64: string;
  ciphertextBase64: string;
  ciphertextBytes: number;
}

export interface PrivateProVaultWrappedKeyEnvelope {
  nonceBase64: string;
  ciphertextBase64: string;
  ciphertextBytes: number;
}

export interface PrivateProVaultPasswordEnvelope extends PrivateProVaultWrappedKeyEnvelope {
  formatVersion: 1;
  keyVersion: number;
  kdf: {
    algorithm: 'argon2id';
    saltBase64: string;
    memoryKiB: number;
    iterations: number;
    parallelism: number;
  } | {
    algorithm: 'pbkdf2-sha256';
    saltBase64: string;
    iterations: number;
  };
}

export interface PrivateProVaultRecoveryEnvelope extends PrivateProVaultWrappedKeyEnvelope {
  formatVersion: 1;
  keyVersion: number;
  recoveryVersion: number;
}

export interface PrivateProVaultKeyset {
  formatVersion: 1;
  keyVersion: number;
  wrappingVersion: number;
  passwordEnvelope: PrivateProVaultPasswordEnvelope;
  recoveryEnvelope: PrivateProVaultRecoveryEnvelope;
}

export interface PrivateProVaultDeviceMetadata {
  formatVersion: 1;
  deviceId: string;
  keyVersion: number;
  createdAtMs: number;
  lastSeenAtMs: number;
  revokedAtMs: number | null;
}

export interface PrivateProVaultRecordIndexEntry {
  recordType: PrivateProVaultRecordType;
  recordId: string;
  revision: number;
  keyVersion: number;
  ciphertextBytes: number;
  serverUpdatedAtMs: number;
}

export interface PrivateProVaultRecordIndex {
  formatVersion: 1;
  entries: PrivateProVaultRecordIndexEntry[];
  nextCursor: string | null;
}

export interface PrivateProVaultTombstone {
  formatVersion: 1;
  recordType: PrivateProVaultRecordType;
  recordId: string;
  revision: number;
  keyVersion: number;
  operationId: string;
  deletedAtMs: number;
}

export interface PrivateProVaultPutOperation {
  formatVersion: 1;
  operationId: string;
  kind: 'put';
  baseRevision: number;
  envelope: PrivateProVaultEnvelope;
}

export interface PrivateProVaultDeleteOperation {
  formatVersion: 1;
  operationId: string;
  kind: 'delete';
  baseRevision: number;
  tombstone: PrivateProVaultTombstone;
}

export type PrivateProVaultOperation = PrivateProVaultPutOperation | PrivateProVaultDeleteOperation;
