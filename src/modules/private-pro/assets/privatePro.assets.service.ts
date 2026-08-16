import type {
  PrivateProAssetAccount,
  PrivateProAssetMetadata,
  PrivateProAssetRecord,
  PrivateProAssetReservation,
  PrivateProStoredObjectMetadata,
} from './privatePro.assets.types';

export type {
  PrivateProAssetAccount,
  PrivateProAssetMetadata,
  PrivateProAssetRecord,
  PrivateProAssetReservation,
  PrivateProStoredObjectMetadata,
} from './privatePro.assets.types';


const RESERVATION_TTL_MS = 15 * 60 * 1000;

export interface PrivateProUploadRateLimitOptions {
  windowMs: number;
  maxRequests: number;
  maxBytes: number;
}

export class PrivateProUploadRateLimitError extends Error {
  constructor() {
    super('Private Pro attachment upload rate limit exceeded.');
    this.name = 'PrivateProUploadRateLimitError';
  }
}

export function createPrivateProUploadRateLimiter(options: PrivateProUploadRateLimitOptions, now: () => number = Date.now) {
  const windows = new Map<string, { startedAtMs: number; requests: number; bytes: number }>();
  return {
    consume(uid: string, requestedBytes: number): void {
      const atMs = now();
      let window = windows.get(uid);
      if (!window || atMs - window.startedAtMs >= options.windowMs) {
        window = { startedAtMs: atMs, requests: 0, bytes: 0 };
        windows.set(uid, window);
      }
      if (window.requests + 1 > options.maxRequests || window.bytes + requestedBytes > options.maxBytes)
        throw new PrivateProUploadRateLimitError();
      window.requests++;
      window.bytes += requestedBytes;
    },
  };
}

export interface PrivateProAssetsTransaction {
  getAccount(): Promise<PrivateProAssetAccount>;
  saveAccount(account: PrivateProAssetAccount): Promise<void>;
  getReservation(operationId: string): Promise<PrivateProAssetReservation | null>;
  saveReservation(reservation: PrivateProAssetReservation): Promise<void>;
  getAsset(assetId: string): Promise<PrivateProAssetRecord | null>;
  findAssetByHash(contentHash: string): Promise<PrivateProAssetRecord | null>;
  saveAsset(asset: PrivateProAssetRecord): Promise<void>;
}

export interface PrivateProAssetsPort {
  transaction<T>(uid: string, callback: (transaction: PrivateProAssetsTransaction) => Promise<T>): Promise<T>;
  listExpiredReservations(atMs: number, limit: number): Promise<Array<{ uid: string; operationId: string }>>;
  createSignedUpload(objectPath: string, contentType: string, contentHash: string): Promise<{
    uploadUrl: string;
    requiredHeaders: Record<string, string>;
  }>;
  createSignedDownload(objectPath: string): Promise<string>;
  getObjectMetadata(objectPath: string): Promise<PrivateProStoredObjectMetadata>;
  deleteObject(objectPath: string): Promise<void>;
}

export interface ReserveAssetUploadInput {
  operationId: string;
  assetId: string;
  contentHash: string;
  contentType: string;
  requestedBytes: number;
  metadata: PrivateProAssetMetadata;
}

function assertReserveInput(input: ReserveAssetUploadInput): void {
  if (!input.operationId || !input.assetId) throw new Error('Attachment reservation is missing an identifier.');
  if (!/^[a-f0-9]{64}$/.test(input.contentHash)) throw new Error('Attachment hash must be a SHA-256 digest.');
  if (!input.contentType || !Number.isInteger(input.requestedBytes) || input.requestedBytes <= 0)
    throw new Error('Attachment size and content type are required.');
}

function reservationResponse(reservation: PrivateProAssetReservation, upload: {
  uploadUrl: string;
  requiredHeaders: Record<string, string>;
}) {
  return {
    status: 'upload-required' as const,
    operationId: reservation.operationId,
    assetId: reservation.assetId,
    objectPath: reservation.objectPath,
    expiresAtMs: reservation.expiresAtMs,
    uploadUrl: upload.uploadUrl,
    requiredHeaders: upload.requiredHeaders,
  };
}

export function createPrivateProAssetsService(port: PrivateProAssetsPort, now: () => number = Date.now) {
  const service = {
    async reserveUpload(uid: string, input: ReserveAssetUploadInput) {
      assertReserveInput(input);
      const reservation = await port.transaction(uid, async transaction => {
        const [account, existingReservation, duplicate] = await Promise.all([
          transaction.getAccount(),
          transaction.getReservation(input.operationId),
          transaction.findAssetByHash(input.contentHash),
        ]);
        if (!account.active || account.uid !== uid) throw new Error('Private Pro account is inactive.');
        if (duplicate) {
          if (duplicate.assetId !== input.assetId) {
            const updatedAtMs = now();
            await transaction.saveAsset({
              ...duplicate,
              assetId: input.assetId,
              metadata: structuredClone(input.metadata),
              createdAtMs: updatedAtMs,
              updatedAtMs,
            });
          }
          return { status: 'already-uploaded' as const, assetId: input.assetId, byteSize: duplicate.byteSize };
        }
        if (existingReservation) {
          if (
            existingReservation.assetId !== input.assetId ||
            existingReservation.contentHash !== input.contentHash ||
            existingReservation.contentType !== input.contentType ||
            existingReservation.requestedBytes !== input.requestedBytes
          ) throw new Error('Attachment operation ID is already used by different content.');
          if (existingReservation.status === 'ready')
            return { status: 'already-uploaded' as const, assetId: existingReservation.assetId, byteSize: existingReservation.finalizedBytes ?? 0 };
          if (existingReservation.status === 'reserved') return existingReservation;
        }
        if (account.usedBytes + account.reservedBytes + input.requestedBytes > account.quotaBytes)
          throw new Error('Private Pro attachment quota exceeded.');

        const createdAtMs = now();
        const created: PrivateProAssetReservation = {
          uid,
          operationId: input.operationId,
          assetId: input.assetId,
          contentHash: input.contentHash,
          contentType: input.contentType,
          requestedBytes: input.requestedBytes,
          objectPath: `users/${uid}/assets/${input.assetId}`,
          metadata: structuredClone(input.metadata),
          status: 'reserved',
          createdAtMs,
          expiresAtMs: createdAtMs + RESERVATION_TTL_MS,
        };
        await transaction.saveAccount({ ...account, reservedBytes: account.reservedBytes + input.requestedBytes });
        await transaction.saveReservation(created);
        return created;
      });

      if ('status' in reservation && reservation.status === 'already-uploaded') return reservation;
      const upload = await port.createSignedUpload(reservation.objectPath, reservation.contentType, reservation.contentHash);
      return reservationResponse(reservation, upload);
    },

    async finalizeUpload(uid: string, operationId: string) {
      const reservation = await port.transaction(uid, transaction => transaction.getReservation(operationId));
      if (!reservation || reservation.uid !== uid) throw new Error('Attachment reservation was not found.');
      if (reservation.status === 'ready')
        return { status: 'ready' as const, assetId: reservation.assetId, byteSize: reservation.finalizedBytes ?? 0 };
      if (reservation.status !== 'reserved') throw new Error('Attachment reservation is no longer active.');

      let object: PrivateProStoredObjectMetadata;
      try {
        object = await port.getObjectMetadata(reservation.objectPath);
      } catch (error) {
        await port.transaction(uid, async transaction => {
          const account = await transaction.getAccount();
          const current = await transaction.getReservation(operationId);
          if (current?.status === 'reserved') {
            await transaction.saveAccount({ ...account, reservedBytes: Math.max(0, account.reservedBytes - current.requestedBytes) });
            await transaction.saveReservation({ ...current, status: 'released' });
          }
        });
        throw error;
      }

      const matches = object.objectPath === reservation.objectPath &&
        object.contentType === reservation.contentType &&
        object.contentHash === reservation.contentHash &&
        object.byteSize > 0 &&
        object.byteSize <= reservation.requestedBytes;
      if (!matches) {
        await port.deleteObject(reservation.objectPath).catch(() => undefined);
        await port.transaction(uid, async transaction => {
          const account = await transaction.getAccount();
          const current = await transaction.getReservation(operationId);
          if (current?.status === 'reserved') {
            await transaction.saveAccount({ ...account, reservedBytes: Math.max(0, account.reservedBytes - current.requestedBytes) });
            await transaction.saveReservation({ ...current, status: 'released' });
          }
        });
        throw new Error('Uploaded attachment does not match its reservation.');
      }

      return port.transaction(uid, async transaction => {
        const [account, current] = await Promise.all([
          transaction.getAccount(),
          transaction.getReservation(operationId),
        ]);
        if (!current) throw new Error('Attachment reservation was not found.');
        if (current.status === 'ready')
          return { status: 'ready' as const, assetId: current.assetId, byteSize: current.finalizedBytes ?? 0 };
        if (account.usedBytes + object.byteSize > account.quotaBytes)
          throw new Error('Private Pro attachment quota exceeded during finalization.');

        const updatedAtMs = now();
        await transaction.saveAsset({
          uid,
          assetId: current.assetId,
          contentHash: current.contentHash,
          contentType: current.contentType,
          byteSize: object.byteSize,
          objectPath: current.objectPath,
          status: 'ready',
          metadata: structuredClone(current.metadata),
          createdAtMs: current.createdAtMs,
          updatedAtMs,
        });
        await transaction.saveAccount({
          ...account,
          reservedBytes: Math.max(0, account.reservedBytes - current.requestedBytes),
          usedBytes: account.usedBytes + object.byteSize,
        });
        await transaction.saveReservation({ ...current, status: 'ready', finalizedBytes: object.byteSize });
        return { status: 'ready' as const, assetId: current.assetId, byteSize: object.byteSize };
      });
    },

    async getDownload(uid: string, assetId: string) {
      const asset = await port.transaction(uid, transaction => transaction.getAsset(assetId));
      if (!asset || asset.uid !== uid || asset.status !== 'ready') throw new Error('Attachment was not found.');
      return { downloadUrl: await port.createSignedDownload(asset.objectPath), asset };
    },

    async releaseExpiredReservation(uid: string, operationId: string, atMs = now()) {
      const objectPath = await port.transaction(uid, async transaction => {
        const [account, reservation] = await Promise.all([
          transaction.getAccount(),
          transaction.getReservation(operationId),
        ]);
        if (!reservation || reservation.status !== 'reserved' || reservation.expiresAtMs > atMs) return null;
        await transaction.saveAccount({ ...account, reservedBytes: Math.max(0, account.reservedBytes - reservation.requestedBytes) });
        await transaction.saveReservation({ ...reservation, status: 'released' });
        return reservation.objectPath;
      });
      if (!objectPath) return false;
      await port.deleteObject(objectPath).catch(() => undefined);
      return true;
    },

    async releaseReservation(uid: string, operationId: string) {
      const objectPath = await port.transaction(uid, async transaction => {
        const [account, reservation] = await Promise.all([
          transaction.getAccount(),
          transaction.getReservation(operationId),
        ]);
        if (!reservation || reservation.status !== 'reserved') return null;
        await transaction.saveAccount({ ...account, reservedBytes: Math.max(0, account.reservedBytes - reservation.requestedBytes) });
        await transaction.saveReservation({ ...reservation, status: 'released' });
        return reservation.objectPath;
      });
      if (!objectPath) return false;
      await port.deleteObject(objectPath).catch(() => undefined);
      return true;
    },

    async sweepExpiredReservations(atMs = now(), limit = 100) {
      const reservations = await port.listExpiredReservations(atMs, limit);
      let released = 0;
      for (const reservation of reservations) {
        if (await service.releaseExpiredReservation(reservation.uid, reservation.operationId, atMs)) released++;
      }
      return { released };
    },
  };
  return service;
}

export type PrivateProAssetsService = ReturnType<typeof createPrivateProAssetsService>;
