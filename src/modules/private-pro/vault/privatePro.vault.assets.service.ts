import { PRIVATE_PRO_VAULT_ASSET_MAX_CIPHERTEXT_CHUNK_BYTES } from './privatePro.vault.assets.crypto';


const RESERVATION_TTL_MS = 15 * 60 * 1000;
const MAX_CHUNKS = 32;
const OPAQUE_ID = /^[A-Za-z0-9_-]{43}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const OPERATION_ID = /^[A-Za-z0-9._:-]{8,160}$/;

export interface PrivateProVaultAssetAccount {
  uid: string;
  active: boolean;
  quotaBytes: number;
  usedBytes: number;
  reservedBytes: number;
}

export interface PrivateProVaultAssetChunkDescriptor {
  opaqueChunkId: string;
  chunkIndex: number;
  ciphertextBytes: number;
  objectBytes: number;
  objectSha256: string;
}

export interface PrivateProVaultAssetRecord {
  uid: string;
  opaqueAssetId: string;
  chunks: PrivateProVaultAssetChunkDescriptor[];
  ciphertextBytes: number;
  descriptorFingerprint: string;
  status: 'ready';
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PrivateProVaultAssetReservation {
  uid: string;
  operationId: string;
  opaqueAssetId: string;
  chunks: PrivateProVaultAssetChunkDescriptor[];
  ciphertextBytes: number;
  descriptorFingerprint: string;
  status: 'reserved' | 'ready' | 'released';
  createdAtMs: number;
  expiresAtMs: number;
  finalizedAtMs?: number;
}

export interface PrivateProVaultStoredObjectMetadata {
  objectPath: string;
  byteSize: number;
  contentType: string;
  objectSha256: string;
}

export interface PrivateProVaultAssetRateWindow {
  uid: string;
  windowId: string;
  requests: number;
  bytes: number;
  expiresAt: Date;
}

export interface PrivateProVaultAssetTransaction {
  getAccount(): Promise<PrivateProVaultAssetAccount>;
  saveAccount(account: PrivateProVaultAssetAccount): Promise<void>;
  getReservation(operationId: string): Promise<PrivateProVaultAssetReservation | null>;
  getActiveReservationForAsset(opaqueAssetId: string): Promise<PrivateProVaultAssetReservation | null>;
  saveReservation(reservation: PrivateProVaultAssetReservation): Promise<void>;
  getAsset(opaqueAssetId: string): Promise<PrivateProVaultAssetRecord | null>;
  saveAsset(asset: PrivateProVaultAssetRecord): Promise<void>;
  getRateWindow(windowId: string): Promise<PrivateProVaultAssetRateWindow | null>;
  saveRateWindow(window: PrivateProVaultAssetRateWindow): Promise<void>;
}

export interface PrivateProVaultAssetPort {
  transaction<T>(uid: string, callback: (transaction: PrivateProVaultAssetTransaction) => Promise<T>): Promise<T>;
  listExpiredReservations(atMs: number, limit: number): Promise<Array<{ uid: string; operationId: string }>>;
  createSignedUpload(objectPath: string, objectSha256: string, objectBytes: number): Promise<{
    uploadUrl: string;
    requiredHeaders: Record<string, string>;
  }>;
  createSignedDownload(objectPath: string): Promise<string>;
  getObjectMetadata(objectPath: string): Promise<PrivateProVaultStoredObjectMetadata>;
  deleteObject(objectPath: string): Promise<void>;
}

export interface PrivateProVaultAssetRateLimitOptions {
  windowMs: number;
  maxRequests: number;
  maxBytes: number;
}

export interface PrivateProVaultAssetsServiceOptions {
  now?: () => number;
  maxAssetCiphertextBytes: number;
  rateLimit?: PrivateProVaultAssetRateLimitOptions;
}

export interface ReservePrivateProVaultAssetInput {
  operationId: string;
  opaqueAssetId: string;
  chunks: PrivateProVaultAssetChunkDescriptor[];
}

export class PrivateProVaultAssetRateLimitError extends Error {
  constructor() {
    super('Private Pro encrypted attachment rate limit exceeded.');
    this.name = 'PrivateProVaultAssetRateLimitError';
  }
}


function objectPath(uid: string, opaqueAssetId: string, opaqueChunkId: string): string {
  return `users/${uid}/vault/assets/${opaqueAssetId}/${opaqueChunkId}`;
}

function rateWindowId(atMs: number, windowMs: number): string {
  return Math.floor(atMs / windowMs).toString(36);
}

function descriptorFingerprint(input: Pick<PrivateProVaultAssetReservation, 'opaqueAssetId' | 'chunks'>): string {
  return JSON.stringify({ opaqueAssetId: input.opaqueAssetId, chunks: input.chunks });
}

function assertSafePositive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
}

function validateInput(input: ReservePrivateProVaultAssetInput, maxAssetCiphertextBytes: number) {
  if (!OPERATION_ID.test(input.operationId)) throw new Error('Encrypted asset operation ID is invalid.');
  if (!OPAQUE_ID.test(input.opaqueAssetId)) throw new Error('Encrypted asset ID is invalid.');
  if (!Array.isArray(input.chunks) || input.chunks.length === 0 || input.chunks.length > MAX_CHUNKS)
    throw new Error('Encrypted asset chunk count is invalid.');
  const ids = new Set<string>();
  let ciphertextBytes = 0;
  const chunks = input.chunks.map((chunk, index) => {
    if (!OPAQUE_ID.test(chunk.opaqueChunkId)) throw new Error('Encrypted asset chunk ID is invalid.');
    if (ids.has(chunk.opaqueChunkId)) throw new Error('Encrypted asset chunk IDs must be unique.');
    ids.add(chunk.opaqueChunkId);
    if (chunk.chunkIndex !== index) throw new Error('Encrypted asset chunks must be ordered by index.');
    assertSafePositive(chunk.ciphertextBytes, 'Encrypted asset ciphertext size');
    if (chunk.ciphertextBytes > PRIVATE_PRO_VAULT_ASSET_MAX_CIPHERTEXT_CHUNK_BYTES)
      throw new Error('Encrypted asset chunk size exceeds the limit.');
    assertSafePositive(chunk.objectBytes, 'Encrypted asset object size');
    if (chunk.objectBytes !== chunk.ciphertextBytes + 12)
      throw new Error('Encrypted asset object size must include only its nonce and ciphertext.');
    if (!SHA256_HEX.test(chunk.objectSha256)) throw new Error('Encrypted asset object hash must be SHA-256.');
    ciphertextBytes += chunk.ciphertextBytes;
    if (!Number.isSafeInteger(ciphertextBytes) || ciphertextBytes > maxAssetCiphertextBytes)
      throw new Error('Encrypted asset exceeds the configured ciphertext limit.');
    return { ...chunk };
  });
  return { chunks, ciphertextBytes };
}

async function deleteReservationObjects(
  port: PrivateProVaultAssetPort,
  reservation: Pick<PrivateProVaultAssetReservation, 'uid' | 'opaqueAssetId' | 'chunks'>,
): Promise<void> {
  await Promise.all(reservation.chunks.map(chunk => port.deleteObject(
    objectPath(reservation.uid, reservation.opaqueAssetId, chunk.opaqueChunkId),
  ).catch(() => undefined)));
}

async function releaseReservationState(
  port: PrivateProVaultAssetPort,
  uid: string,
  operationId: string,
): Promise<PrivateProVaultAssetReservation | null> {
  return port.transaction(uid, async transaction => {
    const [account, current] = await Promise.all([
      transaction.getAccount(),
      transaction.getReservation(operationId),
    ]);
    if (!current || current.uid !== uid || current.status !== 'reserved') return null;
    await transaction.saveAccount({
      ...account,
      reservedBytes: Math.max(0, account.reservedBytes - current.ciphertextBytes),
    });
    const released = { ...current, status: 'released' as const };
    await transaction.saveReservation(released);
    return released;
  });
}

export function createPrivateProVaultAssetsService(
  port: PrivateProVaultAssetPort,
  options: PrivateProVaultAssetsServiceOptions,
) {
  assertSafePositive(options.maxAssetCiphertextBytes, 'Encrypted asset limit');
  const now = options.now ?? Date.now;

  const service = {
    async reserveUpload(uid: string, input: ReservePrivateProVaultAssetInput) {
      const validated = validateInput(input, options.maxAssetCiphertextBytes);
      const reservation = await port.transaction(uid, async transaction => {
        const [account, existing, asset, activeReservation] = await Promise.all([
          transaction.getAccount(),
          transaction.getReservation(input.operationId),
          transaction.getAsset(input.opaqueAssetId),
          transaction.getActiveReservationForAsset(input.opaqueAssetId),
        ]);
        if (!account.active || account.uid !== uid) throw new Error('Private Pro account is inactive.');
        const fingerprint = descriptorFingerprint({ opaqueAssetId: input.opaqueAssetId, chunks: validated.chunks });
        if (asset) {
          if (asset.descriptorFingerprint !== fingerprint)
            throw new Error('Encrypted asset ID is already used by different ciphertext descriptors.');
          return { status: 'already-uploaded' as const, opaqueAssetId: asset.opaqueAssetId, ciphertextBytes: asset.ciphertextBytes };
        }
        if (existing) {
          if (existing.descriptorFingerprint !== fingerprint)
            throw new Error('Encrypted asset operation ID is already used by different ciphertext.');
          if (existing.status === 'ready')
            return { status: 'already-uploaded' as const, opaqueAssetId: existing.opaqueAssetId, ciphertextBytes: existing.ciphertextBytes };
          if (existing.status === 'reserved') return existing;
          throw new Error('Encrypted asset operation ID is no longer active.');
        }
        if (activeReservation)
          throw new Error('Encrypted asset already has an active reservation.');

        if (options.rateLimit) {
          const atMs = now();
          const windowId = rateWindowId(atMs, options.rateLimit.windowMs);
          const window = await transaction.getRateWindow(windowId);
          const requests = (window?.requests ?? 0) + 1;
          const bytes = (window?.bytes ?? 0) + validated.ciphertextBytes;
          if (requests > options.rateLimit.maxRequests || bytes > options.rateLimit.maxBytes)
            throw new PrivateProVaultAssetRateLimitError();
          await transaction.saveRateWindow({
            uid,
            windowId,
            requests,
            bytes,
            expiresAt: new Date((Math.floor(atMs / options.rateLimit.windowMs) + 2) * options.rateLimit.windowMs),
          });
        }
        if (account.usedBytes + account.reservedBytes + validated.ciphertextBytes > account.quotaBytes)
          throw new Error('Private Pro encrypted attachment quota exceeded.');

        const createdAtMs = now();
        const created: PrivateProVaultAssetReservation = {
          uid,
          operationId: input.operationId,
          opaqueAssetId: input.opaqueAssetId,
          chunks: validated.chunks,
          ciphertextBytes: validated.ciphertextBytes,
          descriptorFingerprint: fingerprint,
          status: 'reserved',
          createdAtMs,
          expiresAtMs: createdAtMs + RESERVATION_TTL_MS,
        };
        await transaction.saveAccount({ ...account, reservedBytes: account.reservedBytes + validated.ciphertextBytes });
        await transaction.saveReservation(created);
        return created;
      });

      if (reservation.status === 'already-uploaded') return reservation;
      try {
        const chunks = [];
        for (const chunk of reservation.chunks) {
          const path = objectPath(uid, reservation.opaqueAssetId, chunk.opaqueChunkId);
          const signed = await port.createSignedUpload(path, chunk.objectSha256, chunk.objectBytes);
          chunks.push({ ...chunk, objectPath: path, ...signed });
        }
        return {
          status: 'upload-required' as const,
          operationId: reservation.operationId,
          opaqueAssetId: reservation.opaqueAssetId,
          expiresAtMs: reservation.expiresAtMs,
          chunks,
        };
      } catch (error) {
        const released = await releaseReservationState(port, uid, input.operationId);
        if (released) await deleteReservationObjects(port, released);
        throw error;
      }
    },

    async finalizeUpload(uid: string, operationId: string) {
      const reservation = await port.transaction(uid, transaction => transaction.getReservation(operationId));
      if (!reservation || reservation.uid !== uid) throw new Error('Encrypted asset reservation was not found.');
      if (reservation.status === 'ready')
        return { status: 'ready' as const, opaqueAssetId: reservation.opaqueAssetId, ciphertextBytes: reservation.ciphertextBytes };
      if (reservation.status !== 'reserved') throw new Error('Encrypted asset reservation is no longer active.');

      let objects: PrivateProVaultStoredObjectMetadata[];
      try {
        objects = await Promise.all(reservation.chunks.map(chunk => port.getObjectMetadata(
          objectPath(uid, reservation.opaqueAssetId, chunk.opaqueChunkId),
        )));
      } catch (error) {
        const released = await releaseReservationState(port, uid, operationId);
        if (released) await deleteReservationObjects(port, released);
        throw error;
      }

      const matches = objects.every((object, index) => {
        const chunk = reservation.chunks[index];
        return object.objectPath === objectPath(uid, reservation.opaqueAssetId, chunk.opaqueChunkId)
          && object.contentType === 'application/octet-stream'
          && object.objectSha256 === chunk.objectSha256
          && object.byteSize === chunk.objectBytes;
      });
      if (!matches) {
        const released = await releaseReservationState(port, uid, operationId);
        if (released) await deleteReservationObjects(port, released);
        throw new Error('Uploaded encrypted attachment does not match its reservation.');
      }

      try {
        return await port.transaction(uid, async transaction => {
        const [account, current, existingAsset] = await Promise.all([
          transaction.getAccount(),
          transaction.getReservation(operationId),
          transaction.getAsset(reservation.opaqueAssetId),
        ]);
        if (!current) throw new Error('Encrypted asset reservation was not found.');
        if (current.status === 'ready')
          return { status: 'ready' as const, opaqueAssetId: current.opaqueAssetId, ciphertextBytes: current.ciphertextBytes };
        if (current.status !== 'reserved') throw new Error('Encrypted asset reservation is no longer active.');
        if (existingAsset) throw new Error('Encrypted asset already exists.');
        if (account.usedBytes + current.ciphertextBytes > account.quotaBytes)
          throw new Error('Private Pro encrypted attachment quota exceeded during finalization.');

        const updatedAtMs = now();
        await transaction.saveAsset({
          uid,
          opaqueAssetId: current.opaqueAssetId,
          chunks: current.chunks.map(chunk => ({ ...chunk })),
          ciphertextBytes: current.ciphertextBytes,
          descriptorFingerprint: current.descriptorFingerprint,
          status: 'ready',
          createdAtMs: current.createdAtMs,
          updatedAtMs,
        });
        await transaction.saveAccount({
          ...account,
          reservedBytes: Math.max(0, account.reservedBytes - current.ciphertextBytes),
          usedBytes: account.usedBytes + current.ciphertextBytes,
        });
        await transaction.saveReservation({ ...current, status: 'ready', finalizedAtMs: updatedAtMs });
        return { status: 'ready' as const, opaqueAssetId: current.opaqueAssetId, ciphertextBytes: current.ciphertextBytes };
        });
      } catch (error) {
        const released = await releaseReservationState(port, uid, operationId);
        if (released) await deleteReservationObjects(port, released);
        throw error;
      }
    },

    async getDownload(uid: string, opaqueAssetId: string) {
      if (!OPAQUE_ID.test(opaqueAssetId)) throw new Error('Encrypted asset ID is invalid.');
      const asset = await port.transaction(uid, transaction => transaction.getAsset(opaqueAssetId));
      if (!asset || asset.uid !== uid || asset.status !== 'ready') throw new Error('Encrypted attachment was not found.');
      const chunks = [];
      for (const chunk of asset.chunks) {
        const path = objectPath(uid, asset.opaqueAssetId, chunk.opaqueChunkId);
        chunks.push({ ...chunk, objectPath: path, downloadUrl: await port.createSignedDownload(path) });
      }
      return { opaqueAssetId: asset.opaqueAssetId, ciphertextBytes: asset.ciphertextBytes, chunks };
    },

    async releaseReservation(uid: string, operationId: string) {
      const released = await releaseReservationState(port, uid, operationId);
      if (!released) return false;
      await deleteReservationObjects(port, released);
      return true;
    },

    async releaseExpiredReservation(uid: string, operationId: string, atMs = now()) {
      const reservation = await port.transaction(uid, transaction => transaction.getReservation(operationId));
      if (!reservation || reservation.status !== 'reserved' || reservation.expiresAtMs > atMs) return false;
      return service.releaseReservation(uid, operationId);
    },

    async sweepExpiredReservations(atMs = now(), limit = 100) {
      const expired = await port.listExpiredReservations(atMs, limit);
      let released = 0;
      for (const reservation of expired) {
        if (await service.releaseExpiredReservation(reservation.uid, reservation.operationId, atMs)) released++;
      }
      return { released };
    },
  };

  return service;
}

export type PrivateProVaultAssetsService = ReturnType<typeof createPrivateProVaultAssetsService>;
