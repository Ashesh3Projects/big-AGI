export interface PrivateProAssetMetadata {
  assetType: string;
  label: string;
  origin: unknown;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface PrivateProAssetAccount {
  uid: string;
  active: boolean;
  accessEpoch: number;
  quotaBytes: number;
  usedBytes: number;
  reservedBytes: number;
}

export interface PrivateProAssetRecord {
  uid: string;
  assetId: string;
  contentHash: string;
  contentType: string;
  byteSize: number;
  objectPath: string;
  status: 'ready';
  metadata: PrivateProAssetMetadata;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PrivateProAssetReservation {
  uid: string;
  operationId: string;
  assetId: string;
  contentHash: string;
  contentType: string;
  requestedBytes: number;
  objectPath: string;
  metadata: PrivateProAssetMetadata;
  status: 'reserved' | 'ready' | 'released';
  createdAtMs: number;
  expiresAtMs: number;
  finalizedBytes?: number;
}

export interface PrivateProStoredObjectMetadata {
  objectPath: string;
  byteSize: number;
  contentType: string;
  contentHash: string;
}
