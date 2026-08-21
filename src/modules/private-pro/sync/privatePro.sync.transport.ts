import type {
  PrivateProSyncMutationKind,
  PrivateProSyncRecordDocument,
  PrivateProSyncRecordType,
  PrivateProSyncTombstoneDocument,
} from './privatePro.sync.schemas';


export interface PrivateProSyncRemoteRecord extends PrivateProSyncRecordDocument {
  recordKey: string;
}

export interface PrivateProSyncWriteInput {
  recordKey: string;
  recordType: PrivateProSyncRecordType;
  logicalId: string;
  schemaVersion: number;
  kind: PrivateProSyncMutationKind;
  payload: string;
  contentHash: string | null;
  baseRevision: number;
  mutationId: string;
  writerId: string;
}

export type PrivateProSyncWriteResult =
  | { status: 'accepted'; revision: number }
  | { status: 'already-committed'; revision: number }
  | { status: 'already-absent' }
  | { status: 'conflict'; canonical: PrivateProSyncRemoteRecord }
  | { status: 'deleted'; canonical: PrivateProSyncRemoteRecord };

export type PrivateProSyncErrorCategory = 'permission' | 'offline' | 'quota' | 'unknown';
export type PrivateProSyncCollection = 'records' | 'assets' | 'tombstones';

export class PrivateProSyncTransportError extends Error {
  constructor(readonly category: PrivateProSyncErrorCategory) {
    super(`Private Pro sync transport error: ${category}.`);
    this.name = 'PrivateProSyncTransportError';
  }
}

export type PrivateProSyncRemoteEvent =
  | { type: 'record'; canonical: PrivateProSyncRemoteRecord }
  | { type: 'tombstone'; tombstone: PrivateProSyncTombstoneDocument }
  | { type: 'current'; collection: PrivateProSyncCollection }
  | { type: 'invalid-document'; collection: PrivateProSyncCollection; recordKey: string; reason: 'invalid-document' }
  | { type: 'error'; collection: PrivateProSyncCollection; category: PrivateProSyncErrorCategory };

export interface PrivateProSyncTransport {
  write(input: PrivateProSyncWriteInput): Promise<PrivateProSyncWriteResult>;
  listen(listener: (event: PrivateProSyncRemoteEvent) => void): () => void;
}
