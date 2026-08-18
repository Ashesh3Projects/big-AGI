import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DBlobAssetType, DBlobMimeType, type DBlobDBAsset } from '~/modules/dblobs/dblobs.types';

import { importVaultMasterKey } from './privatePro.vault.crypto';
import {
  createPrivateProVaultAssetClient,
  type PrivateProVaultAssetClientTransport,
  type PrivateProVaultAssetLocalPort,
} from './privatePro.vault.assets.client';
import { PRIVATE_PRO_VAULT_ASSET_MAX_CIPHERTEXT_CHUNK_BYTES } from './privatePro.vault.assets.crypto';


const UID = 'uid-vault-asset-client';
const ASSET_ID = 'dblob-private-client';
const KEY_VERSION = 3;

function asset(byteLength = PRIVATE_PRO_VAULT_ASSET_MAX_CIPHERTEXT_CHUNK_BYTES + 333): DBlobDBAsset {
  const bytes = Uint8Array.from({ length: byteLength }, (_, index) => index % 251);
  return {
    id: ASSET_ID,
    contextId: 'global',
    scopeId: 'app-chat',
    assetType: DBlobAssetType.IMAGE,
    label: 'private-file.png',
    data: { mimeType: DBlobMimeType.IMG_PNG, base64: Buffer.from(bytes).toString('base64') },
    origin: { ot: 'user', source: 'attachment', media: 'file-open', fileName: 'private-file.png' },
    metadata: { width: 640, height: 480, description: 'secret description' },
    createdAt: new Date('2026-08-17T00:00:00.000Z'),
    updatedAt: new Date('2026-08-17T01:00:00.000Z'),
    cache: {},
  };
}

class MemoryLocalPort implements PrivateProVaultAssetLocalPort {
  readonly assets = new Map<string, DBlobDBAsset>();
  maxPlaintextReadBytes = 0;

  async getAsset(assetId: string) { return structuredClone(this.assets.get(assetId)); }
  async putAsset(value: DBlobDBAsset) { this.assets.set(value.id, structuredClone(value)); }
  async hasAsset(assetId: string) { return this.assets.has(assetId); }
  async openAssetSource(value: DBlobDBAsset) {
    const bytes = Uint8Array.from(Buffer.from(value.data.base64, 'base64'));
    let offset = 0;
    return {
      plaintextBytes: bytes.byteLength,
      source: new ReadableStream<Uint8Array>({
        pull: controller => {
          if (offset >= bytes.byteLength) return controller.close();
          const next = bytes.slice(offset, Math.min(offset + 64 * 1024, bytes.byteLength));
          this.maxPlaintextReadBytes = Math.max(this.maxPlaintextReadBytes, next.byteLength);
          offset += next.byteLength;
          controller.enqueue(next);
        },
      }),
    };
  }
}

class MemoryTransport implements PrivateProVaultAssetClientTransport {
  readonly objects = new Map<string, Uint8Array>();
  readonly uploadedIndices: number[] = [];
  readonly downloadedIndices: number[] = [];
  readonly reservations: Array<{ operationId: string; opaqueAssetId: string; chunks: Array<Record<string, unknown>> }> = [];
  releases = 0;
  finalized = 0;
  failUploadAt: number | null = null;
  private ready: { opaqueAssetId: string; ciphertextBytes: number; chunks: any[] } | null = null;

  async reserveUpload(input: { operationId: string; opaqueAssetId: string; chunks: any[] }) {
    this.reservations.push(structuredClone(input));
    const chunks = input.chunks.map((chunk, index) => ({
      ...chunk,
      objectPath: `users/${UID}/vault/assets/${input.opaqueAssetId}/${chunk.opaqueChunkId}`,
      uploadUrl: `memory://upload/${index}`,
      requiredHeaders: {
        'content-type': 'application/octet-stream',
        'content-length': String(chunk.objectBytes),
        'x-goog-meta-sha256': chunk.objectSha256,
      },
    }));
    this.ready = { opaqueAssetId: input.opaqueAssetId, ciphertextBytes: input.chunks.reduce((sum, chunk) => sum + chunk.ciphertextBytes, 0), chunks };
    return { status: 'upload-required' as const, operationId: input.operationId, opaqueAssetId: input.opaqueAssetId, expiresAtMs: Date.now() + 60_000, chunks };
  }

  async uploadChunk(input: { chunkIndex: number; objectPath: string; bytes: Uint8Array }) {
    this.uploadedIndices.push(input.chunkIndex);
    if (input.chunkIndex === this.failUploadAt) throw new Error('injected upload failure');
    this.objects.set(input.objectPath, Uint8Array.from(input.bytes));
  }

  async finalizeUpload() {
    this.finalized++;
    if (!this.ready) throw new Error('not reserved');
    return { status: 'ready' as const, opaqueAssetId: this.ready.opaqueAssetId, ciphertextBytes: this.ready.ciphertextBytes };
  }

  async releaseReservation() {
    this.releases++;
    this.objects.clear();
  }

  async getDownload() {
    if (!this.ready) throw new Error('not uploaded');
    return {
      ...this.ready,
      chunks: this.ready.chunks.map(chunk => ({ ...chunk, downloadUrl: `memory://download/${chunk.chunkIndex}` })),
    };
  }

  async downloadChunk(input: { chunkIndex: number; objectPath: string }) {
    this.downloadedIndices.push(input.chunkIndex);
    const bytes = this.objects.get(input.objectPath);
    if (!bytes) throw new Error('missing object');
    return Uint8Array.from(bytes);
  }
}

async function fixture() {
  const masterKey = await importVaultMasterKey(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
  const local = new MemoryLocalPort();
  const transport = new MemoryTransport();
  const original = asset();
  local.assets.set(original.id, original);
  const client = createPrivateProVaultAssetClient({
    vaultId: UID,
    masterKey,
    keyVersion: KEY_VERSION,
    local,
    transport,
    createOperationId: () => 'asset-operation-client',
  });
  return { masterKey, local, transport, original, client };
}

describe('private Pro encrypted vault asset client', () => {
  test('encrypts and uploads referenced DBlobs in chunk order with opaque descriptors only', async () => {
    const { client, local, transport } = await fixture();

    await client.prepareForUpload([ASSET_ID]);

    assert.deepEqual(transport.uploadedIndices, [0, 1]);
    assert.equal(transport.finalized, 1);
    assert.equal(local.maxPlaintextReadBytes <= 64 * 1024, true, 'the source seam streams bounded plaintext reads');
    const visible = JSON.stringify(transport.reservations);
    assert.equal(visible.includes(ASSET_ID), false);
    assert.equal(visible.includes('private-file.png'), false);
    assert.equal(visible.includes('image/png'), false);
    assert.equal(visible.includes('secret description'), false);
    assert.equal(transport.reservations[0].chunks.every(chunk => chunk.objectBytes === Number(chunk.ciphertextBytes) + 12), true);
  });

  test('downloads, verifies, decrypts, and restores a missing DBlob in server order', async () => {
    const { client, local, transport, original } = await fixture();
    await client.prepareForUpload([ASSET_ID]);
    local.assets.clear();

    await client.prepareForHydrate([ASSET_ID]);

    assert.deepEqual(transport.downloadedIndices, [0, 1]);
    assert.deepEqual(local.assets.get(ASSET_ID), original);
  });

  test('releases the reservation and leaves no ready asset after upload failure or abort', async () => {
    const failed = await fixture();
    failed.transport.failUploadAt = 1;
    await assert.rejects(failed.client.prepareForUpload([ASSET_ID]), /upload failure/i);
    assert.equal(failed.transport.releases, 1);
    assert.equal(failed.transport.finalized, 0);
    assert.equal(failed.transport.objects.size, 0);

    const aborted = await fixture();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(aborted.client.prepareForUpload([ASSET_ID], controller.signal), /abort/i);
    assert.equal(aborted.transport.finalized, 0);
  });

  test('exports each encrypted chunk in upload order for the Task 12 backup port', async () => {
    const { client, transport, local, original } = await fixture();
    await client.prepareForUpload([ASSET_ID]);

    const exported = [];
    for await (const chunk of client.exportAssetChunks([ASSET_ID])) exported.push(chunk);

    assert.deepEqual(exported.map(chunk => chunk.chunkIndex), [0, 1]);
    assert.equal(exported.every(chunk => chunk.assetId === transport.reservations[0].opaqueAssetId), true);
    assert.equal(exported.every(chunk => chunk.keyVersion === KEY_VERSION), true);

    local.assets.clear();
    await client.importAssetChunks(exported);
    assert.deepEqual(local.assets.get(ASSET_ID), original);
  });
});
