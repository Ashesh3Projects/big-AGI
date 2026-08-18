import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  createPrivateProVaultAssetsService,
  PrivateProVaultAssetRateLimitError,
  type PrivateProVaultAssetAccount,
  type PrivateProVaultAssetPort,
  type PrivateProVaultAssetRateWindow,
  type PrivateProVaultAssetRecord,
  type PrivateProVaultAssetReservation,
  type PrivateProVaultAssetTransaction,
  type PrivateProVaultStoredObjectMetadata,
} from './privatePro.vault.assets.service';


const UID = 'uid-vault-assets';
const ASSET_ID = 'A'.repeat(43);
const CHUNK_0 = 'B'.repeat(43);
const CHUNK_1 = 'C'.repeat(43);
const HASH_0 = '1'.repeat(64);
const HASH_1 = '2'.repeat(64);
const NOW = 1_000_000;

const DESCRIPTORS = [
  { opaqueChunkId: CHUNK_0, chunkIndex: 0, ciphertextBytes: 4_000_000, objectBytes: 4_000_012, objectSha256: HASH_0 },
  { opaqueChunkId: CHUNK_1, chunkIndex: 1, ciphertextBytes: 120, objectBytes: 132, objectSha256: HASH_1 },
] as const;

class MemoryPort implements PrivateProVaultAssetPort, PrivateProVaultAssetTransaction {
  account: PrivateProVaultAssetAccount = {
    uid: UID,
    active: true,
    quotaBytes: 20_000_000,
    usedBytes: 0,
    reservedBytes: 0,
  };
  readonly reservations = new Map<string, PrivateProVaultAssetReservation>();
  readonly assets = new Map<string, PrivateProVaultAssetRecord>();
  readonly rateWindows = new Map<string, PrivateProVaultAssetRateWindow>();
  readonly objects = new Map<string, PrivateProVaultStoredObjectMetadata>();
  readonly deleted: string[] = [];
  failSigningAt: number | null = null;
  private signedUploads = 0;

  async transaction<T>(uid: string, callback: (transaction: PrivateProVaultAssetTransaction) => Promise<T>): Promise<T> {
    assert.equal(uid, UID);
    return callback(this);
  }

  async getAccount() { return structuredClone(this.account); }
  async saveAccount(account: PrivateProVaultAssetAccount) { this.account = structuredClone(account); }
  async getReservation(operationId: string) { return structuredClone(this.reservations.get(operationId) ?? null); }
  async getActiveReservationForAsset(opaqueAssetId: string) {
    return structuredClone([...this.reservations.values()].find(reservation => reservation.opaqueAssetId === opaqueAssetId && reservation.status === 'reserved') ?? null);
  }
  async saveReservation(reservation: PrivateProVaultAssetReservation) { this.reservations.set(reservation.operationId, structuredClone(reservation)); }
  async getAsset(opaqueAssetId: string) { return structuredClone(this.assets.get(opaqueAssetId) ?? null); }
  async saveAsset(asset: PrivateProVaultAssetRecord) { this.assets.set(asset.opaqueAssetId, structuredClone(asset)); }
  async getRateWindow(windowId: string) { return structuredClone(this.rateWindows.get(windowId) ?? null); }
  async saveRateWindow(window: PrivateProVaultAssetRateWindow) { this.rateWindows.set(window.windowId, structuredClone(window)); }

  async listExpiredReservations(atMs: number, limit: number) {
    return [...this.reservations.values()]
      .filter(reservation => reservation.status === 'reserved' && reservation.expiresAtMs <= atMs)
      .slice(0, limit)
      .map(reservation => ({ uid: reservation.uid, operationId: reservation.operationId }));
  }

  async createSignedUpload(objectPath: string, objectSha256: string, objectBytes: number) {
    if (this.failSigningAt === this.signedUploads++) throw new Error('injected signing failure');
    return {
      uploadUrl: `https://upload.invalid/${encodeURIComponent(objectPath)}`,
      requiredHeaders: {
        'content-type': 'application/octet-stream',
        'x-goog-meta-sha256': objectSha256,
      },
    };
  }

  async createSignedDownload(objectPath: string) {
    return `https://download.invalid/${encodeURIComponent(objectPath)}`;
  }

  async getObjectMetadata(objectPath: string) {
    const object = this.objects.get(objectPath);
    if (!object) throw new Error('object missing');
    return structuredClone(object);
  }

  async deleteObject(objectPath: string) {
    this.deleted.push(objectPath);
    this.objects.delete(objectPath);
  }
}

function service(port: MemoryPort, overrides: Partial<Parameters<typeof createPrivateProVaultAssetsService>[1]> = {}) {
  return createPrivateProVaultAssetsService(port, {
    now: () => NOW,
    maxAssetCiphertextBytes: 64 * 1024 * 1024,
    rateLimit: { windowMs: 60_000, maxRequests: 10, maxBytes: 64 * 1024 * 1024 },
    ...overrides,
  });
}

function reserveInput(operationId = 'asset-operation-1') {
  return { operationId, opaqueAssetId: ASSET_ID, chunks: DESCRIPTORS.map(chunk => ({ ...chunk })) };
}

function installObjects(port: MemoryPort) {
  for (const chunk of DESCRIPTORS) {
    const objectPath = `users/${UID}/vault/assets/${ASSET_ID}/${chunk.opaqueChunkId}`;
    port.objects.set(objectPath, {
      objectPath,
      byteSize: chunk.objectBytes,
      contentType: 'application/octet-stream',
      objectSha256: chunk.objectSha256,
    });
  }
}

describe('private Pro encrypted vault asset service', () => {
  test('reserves opaque ordered chunks at the fixed vault path and counts ciphertext quota', async () => {
    const port = new MemoryPort();
    const result = await service(port).reserveUpload(UID, reserveInput());

    assert.equal(result.status, 'upload-required');
    if (result.status !== 'upload-required') return;
    assert.deepEqual(result.chunks.map(chunk => chunk.objectPath), [
      `users/${UID}/vault/assets/${ASSET_ID}/${CHUNK_0}`,
      `users/${UID}/vault/assets/${ASSET_ID}/${CHUNK_1}`,
    ]);
    assert.equal(result.chunks.every(chunk => chunk.requiredHeaders['content-type'] === 'application/octet-stream'), true);
    assert.deepEqual(result.chunks.map(chunk => chunk.requiredHeaders['x-goog-meta-sha256']), [HASH_0, HASH_1]);
    assert.equal(result.chunks.every(chunk => chunk.requiredHeaders['content-length'] === undefined), true, 'browser uploads cannot set Content-Length');
    assert.equal(port.account.reservedBytes, 4_000_120, 'nonce object bytes must not inflate ciphertext quota');
    assert.equal(JSON.stringify(result).includes('image/png'), false);
    assert.equal(JSON.stringify(result).includes('filename'), false);
  });

  test('finalizes only exact ordered object sizes, hashes, paths, and octet-stream content type', async () => {
    const port = new MemoryPort();
    const assets = service(port);
    await assets.reserveUpload(UID, reserveInput());
    installObjects(port);

    const result = await assets.finalizeUpload(UID, 'asset-operation-1');
    const download = await assets.getDownload(UID, ASSET_ID);

    assert.deepEqual(result, { status: 'ready', opaqueAssetId: ASSET_ID, ciphertextBytes: 4_000_120 });
    assert.equal(port.account.reservedBytes, 0);
    assert.equal(port.account.usedBytes, 4_000_120);
    assert.deepEqual(download.chunks.map(chunk => chunk.chunkIndex), [0, 1]);
    assert.deepEqual(download.chunks.map(chunk => chunk.objectSha256), [HASH_0, HASH_1]);
    assert.equal(download.chunks.every(chunk => chunk.downloadUrl.startsWith('https://download.invalid/')), true);
  });

  test('deletes every partial object and releases quota after finalization mismatch', async () => {
    const port = new MemoryPort();
    const assets = service(port);
    await assets.reserveUpload(UID, reserveInput());
    installObjects(port);
    const badPath = `users/${UID}/vault/assets/${ASSET_ID}/${CHUNK_1}`;
    port.objects.set(badPath, { ...port.objects.get(badPath)!, objectSha256: 'f'.repeat(64) });

    await assert.rejects(assets.finalizeUpload(UID, 'asset-operation-1'), /match|uploaded/i);

    assert.equal(port.reservations.get('asset-operation-1')?.status, 'released');
    assert.equal(port.account.reservedBytes, 0);
    assert.equal(port.account.usedBytes, 0);
    assert.deepEqual(new Set(port.deleted), new Set(DESCRIPTORS.map(chunk => `users/${UID}/vault/assets/${ASSET_ID}/${chunk.opaqueChunkId}`)));
  });

  test('enforces ciphertext quota and per-UID request and byte rate windows', async () => {
    const quotaPort = new MemoryPort();
    quotaPort.account.quotaBytes = 4_000_119;
    await assert.rejects(service(quotaPort).reserveUpload(UID, reserveInput()), /quota/i);

    const requestPort = new MemoryPort();
    const requestLimited = service(requestPort, { rateLimit: { windowMs: 60_000, maxRequests: 1, maxBytes: 64 * 1024 * 1024 } });
    await requestLimited.reserveUpload(UID, reserveInput('asset-operation-1'));
    await requestLimited.releaseReservation(UID, 'asset-operation-1');
    await assert.rejects(requestLimited.reserveUpload(UID, reserveInput('asset-operation-2')), PrivateProVaultAssetRateLimitError);

    const bytePort = new MemoryPort();
    const byteLimited = service(bytePort, { rateLimit: { windowMs: 60_000, maxRequests: 10, maxBytes: 4_000_119 } });
    await assert.rejects(byteLimited.reserveUpload(UID, reserveInput()), PrivateProVaultAssetRateLimitError);
  });

  test('rejects reordered, duplicate, oversized, and replay-conflicting descriptors', async () => {
    const port = new MemoryPort();
    const assets = service(port);
    await assert.rejects(assets.reserveUpload(UID, { ...reserveInput(), chunks: [...DESCRIPTORS].reverse() }), /order|index/i);
    await assert.rejects(assets.reserveUpload(UID, { ...reserveInput(), chunks: [{ ...DESCRIPTORS[0] }, { ...DESCRIPTORS[1], opaqueChunkId: CHUNK_0 }] }), /unique|duplicate/i);
    await assert.rejects(assets.reserveUpload(UID, { ...reserveInput(), chunks: [{ ...DESCRIPTORS[0], ciphertextBytes: 4 * 1024 * 1024 + 1, objectBytes: 4 * 1024 * 1024 + 13 }] }), /chunk|size/i);

    await assets.reserveUpload(UID, reserveInput());
    await assert.rejects(assets.reserveUpload(UID, { ...reserveInput(), chunks: [{ ...DESCRIPTORS[0] }] }), /operation ID|different/i);
  });

  test('releases reservations and deletes possible partial objects when signing or upload aborts', async () => {
    const signingPort = new MemoryPort();
    signingPort.failSigningAt = 1;
    await assert.rejects(service(signingPort).reserveUpload(UID, reserveInput()), /signing/i);
    assert.equal(signingPort.account.reservedBytes, 0);
    assert.equal(signingPort.reservations.get('asset-operation-1')?.status, 'released');
    assert.deepEqual(new Set(signingPort.deleted), new Set(DESCRIPTORS.map(chunk => `users/${UID}/vault/assets/${ASSET_ID}/${chunk.opaqueChunkId}`)));

    const abortPort = new MemoryPort();
    const assets = service(abortPort);
    await assets.reserveUpload(UID, reserveInput());
    installObjects(abortPort);
    assert.equal(await assets.releaseReservation(UID, 'asset-operation-1'), true);
    assert.equal(abortPort.account.reservedBytes, 0);
    assert.equal(abortPort.objects.size, 0);
  });

  test('reactivates an exact released operation and rejects a divergent descriptor replay', async () => {
    const port = new MemoryPort();
    const assets = service(port);
    await assets.reserveUpload(UID, reserveInput());
    assert.equal(await assets.releaseReservation(UID, 'asset-operation-1'), true);

    const resumed = await assets.reserveUpload(UID, reserveInput());
    assert.equal(resumed.status, 'upload-required');
    assert.equal(port.reservations.get('asset-operation-1')?.status, 'reserved');
    assert.equal(port.account.reservedBytes, 4_000_120);
    await assert.rejects(assets.reserveUpload(UID, {
      ...reserveInput(),
      chunks: [{ ...DESCRIPTORS[0], objectSha256: 'f'.repeat(64) }, { ...DESCRIPTORS[1] }],
    }), /different ciphertext|operation ID|descriptor/i);
  });

  test('prevents concurrent reservations from overwriting the same opaque chunk paths', async () => {
    const port = new MemoryPort();
    const assets = service(port);
    await assets.reserveUpload(UID, reserveInput('asset-operation-1'));

    await assert.rejects(assets.reserveUpload(UID, reserveInput('asset-operation-2')), /already reserved|active/i);
    assert.equal(port.account.reservedBytes, 4_000_120);
  });

  test('accepts an exact ready-asset descriptor replay and rejects divergent ciphertext for the same opaque ID', async () => {
    const port = new MemoryPort();
    const assets = service(port);
    await assets.reserveUpload(UID, reserveInput('asset-operation-1'));
    installObjects(port);
    await assets.finalizeUpload(UID, 'asset-operation-1');

    assert.deepEqual(await assets.reserveUpload(UID, reserveInput('asset-operation-2')), {
      status: 'already-uploaded',
      opaqueAssetId: ASSET_ID,
      ciphertextBytes: 4_000_120,
    });
    await assert.rejects(assets.reserveUpload(UID, {
      ...reserveInput('asset-operation-3'),
      chunks: [{ ...DESCRIPTORS[0], objectSha256: 'f'.repeat(64) }, { ...DESCRIPTORS[1] }],
    }), /different ciphertext|descriptor/i);
  });

  test('releases uploaded objects when quota changes before finalization', async () => {
    const port = new MemoryPort();
    const assets = service(port);
    await assets.reserveUpload(UID, reserveInput());
    installObjects(port);
    port.account.quotaBytes = 1;

    await assert.rejects(assets.finalizeUpload(UID, 'asset-operation-1'), /quota/i);

    assert.equal(port.account.reservedBytes, 0);
    assert.equal(port.objects.size, 0);
    assert.equal(port.reservations.get('asset-operation-1')?.status, 'released');
  });
});
