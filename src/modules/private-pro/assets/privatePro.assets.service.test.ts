import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  createPrivateProAssetsService,
  type PrivateProAssetAccount,
  type PrivateProAssetMetadata,
  type PrivateProAssetRecord,
  type PrivateProAssetReservation,
  type PrivateProAssetsPort,
  type PrivateProAssetsTransaction,
  type PrivateProStoredObjectMetadata,
} from './privatePro.assets.service';


const ACCOUNT: PrivateProAssetAccount = {
  uid: 'uid-a',
  active: true,
  accessEpoch: 1,
  quotaBytes: 1000,
  usedBytes: 100,
  reservedBytes: 50,
};

const ASSET_METADATA: PrivateProAssetMetadata = {
  assetType: 'image',
  label: 'Image',
  origin: { ot: 'user', source: 'attachment', media: 'file-open' },
  metadata: { width: 10, height: 20 },
  createdAt: '2026-08-16T00:00:00.000Z',
  updatedAt: '2026-08-16T00:00:00.000Z',
};

class MemoryAssetsPort implements PrivateProAssetsPort {
  account = structuredClone(ACCOUNT);
  reservations = new Map<string, PrivateProAssetReservation>();
  assets = new Map<string, PrivateProAssetRecord>();
  objects = new Map<string, PrivateProStoredObjectMetadata>();
  deletedObjects: string[] = [];

  async transaction<T>(_uid: string, callback: (transaction: PrivateProAssetsTransaction) => Promise<T>) {
    const account = structuredClone(this.account);
    const reservations = new Map([...this.reservations].map(([key, value]) => [key, structuredClone(value)]));
    const assets = new Map([...this.assets].map(([key, value]) => [key, structuredClone(value)]));
    const transaction: PrivateProAssetsTransaction = {
      getAccount: async () => account,
      saveAccount: async next => { Object.assign(account, structuredClone(next)); },
      getReservation: async operationId => reservations.get(operationId) ?? null,
      saveReservation: async reservation => { reservations.set(reservation.operationId, structuredClone(reservation)); },
      getAsset: async assetId => assets.get(assetId) ?? null,
      findAssetByHash: async hash => [...assets.values()].find(asset => asset.contentHash === hash && asset.status === 'ready') ?? null,
      saveAsset: async asset => { assets.set(asset.assetId, structuredClone(asset)); },
    };
    const result = await callback(transaction);
    this.account = account;
    this.reservations = reservations;
    this.assets = assets;
    return result;
  }

  async createSignedUpload(objectPath: string, contentType: string, contentHash: string) {
    return { uploadUrl: `https://upload.invalid/${objectPath}`, requiredHeaders: { 'content-type': contentType, 'x-goog-meta-sha256': contentHash } };
  }

  async createSignedDownload(objectPath: string) {
    return `https://download.invalid/${objectPath}`;
  }

  async getObjectMetadata(objectPath: string) {
    const metadata = this.objects.get(objectPath);
    if (!metadata) throw new Error('object missing');
    return metadata;
  }

  async deleteObject(objectPath: string) {
    this.deletedObjects.push(objectPath);
    this.objects.delete(objectPath);
  }
}


function reserveInput(overrides: Partial<Parameters<ReturnType<typeof createPrivateProAssetsService>['reserveUpload']>[1]> = {}) {
  return {
    operationId: 'asset-op-1',
    assetId: 'asset-1',
    contentHash: 'a'.repeat(64),
    contentType: 'image/png',
    requestedBytes: 200,
    metadata: ASSET_METADATA,
    ...overrides,
  };
}


describe('private Pro attachment quota service', () => {
  test('reserves bytes when finalized plus reserved usage remains within quota', async () => {
    const port = new MemoryAssetsPort();
    const service = createPrivateProAssetsService(port, () => 1000);

    const result = await service.reserveUpload('uid-a', reserveInput());

    assert.equal(result.status, 'upload-required');
    assert.equal(port.account.reservedBytes, 250);
    assert.equal(port.reservations.get('asset-op-1')?.requestedBytes, 200);
  });

  test('rejects a reservation one byte over the account quota', async () => {
    const port = new MemoryAssetsPort();
    const service = createPrivateProAssetsService(port, () => 1000);

    await assert.rejects(
      service.reserveUpload('uid-a', reserveInput({ requestedBytes: 851 })),
      /quota exceeded/i,
    );
    assert.equal(port.account.reservedBytes, 50);
  });

  test('deduplicates a ready asset with the same content hash', async () => {
    const port = new MemoryAssetsPort();
    port.assets.set('existing', {
      uid: 'uid-a', assetId: 'existing', contentHash: 'a'.repeat(64), contentType: 'image/png',
      byteSize: 200, objectPath: 'users/uid-a/assets/existing', status: 'ready', metadata: ASSET_METADATA,
      createdAtMs: 500, updatedAtMs: 500,
    });
    const service = createPrivateProAssetsService(port, () => 1000);

    assert.deepEqual(await service.reserveUpload('uid-a', reserveInput()), {
      status: 'already-uploaded',
      assetId: 'existing',
      byteSize: 200,
    });
    assert.equal(port.account.reservedBytes, 50);
  });

  test('reuses the same reservation operation idempotently', async () => {
    const port = new MemoryAssetsPort();
    const service = createPrivateProAssetsService(port, () => 1000);

    const first = await service.reserveUpload('uid-a', reserveInput());
    const second = await service.reserveUpload('uid-a', reserveInput());

    assert.deepEqual(second, first);
    assert.equal(port.account.reservedBytes, 250);
  });

  test('finalizes using authoritative object metadata and moves bytes exactly once', async () => {
    const port = new MemoryAssetsPort();
    const service = createPrivateProAssetsService(port, () => 1000);
    const reservation = await service.reserveUpload('uid-a', reserveInput());
    assert.equal(reservation.status, 'upload-required');
    port.objects.set(reservation.objectPath, {
      objectPath: reservation.objectPath,
      byteSize: 180,
      contentType: 'image/png',
      contentHash: 'a'.repeat(64),
    });

    assert.deepEqual(await service.finalizeUpload('uid-a', 'asset-op-1'), { status: 'ready', assetId: 'asset-1', byteSize: 180 });
    assert.deepEqual(await service.finalizeUpload('uid-a', 'asset-op-1'), { status: 'ready', assetId: 'asset-1', byteSize: 180 });
    assert.equal(port.account.reservedBytes, 50);
    assert.equal(port.account.usedBytes, 280);
  });

  test('deletes a mismatched object and releases the reservation', async () => {
    const port = new MemoryAssetsPort();
    const service = createPrivateProAssetsService(port, () => 1000);
    const reservation = await service.reserveUpload('uid-a', reserveInput());
    assert.equal(reservation.status, 'upload-required');
    port.objects.set(reservation.objectPath, {
      objectPath: reservation.objectPath,
      byteSize: 200,
      contentType: 'image/jpeg',
      contentHash: 'b'.repeat(64),
    });

    await assert.rejects(service.finalizeUpload('uid-a', 'asset-op-1'), /does not match/i);
    assert.deepEqual(port.deletedObjects, [reservation.objectPath]);
    assert.equal(port.account.reservedBytes, 50);
    assert.equal(port.account.usedBytes, 100);
  });

  test('expires a stale reservation and deletes its orphan object', async () => {
    const port = new MemoryAssetsPort();
    const service = createPrivateProAssetsService(port, () => 1000);
    const reservation = await service.reserveUpload('uid-a', reserveInput());
    assert.equal(reservation.status, 'upload-required');
    port.objects.set(reservation.objectPath, {
      objectPath: reservation.objectPath,
      byteSize: 200,
      contentType: 'image/png',
      contentHash: 'a'.repeat(64),
    });

    assert.equal(await service.releaseExpiredReservation('uid-a', 'asset-op-1', 1000 + 16 * 60 * 1000), true);
    assert.equal(port.account.reservedBytes, 50);
    assert.deepEqual(port.deletedObjects, [reservation.objectPath]);
  });
});
