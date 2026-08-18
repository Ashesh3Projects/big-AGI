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
import type { PrivateProVaultAssetPlaintextSource } from './privatePro.vault.assets.crypto';


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
  readonly hydrated = new Map<string, Set<string>>();
  maxPlaintextReadBytes = 0;
  sourceOpenCount = 0;
  failPut = false;
  blockNextSourceRead = false;
  blockedSourceReadStarted: Promise<void> | null = null;
  private resolveBlockedSourceReadStarted: (() => void) | null = null;

  async getAsset(assetId: string) { return structuredClone(this.assets.get(assetId)); }
  async putAsset(value: DBlobDBAsset) {
    if (this.failPut) throw new Error('injected asset put failure');
    this.assets.set(value.id, structuredClone(value));
  }
  async deleteAsset(assetId: string) { this.assets.delete(assetId); }
  async hasAsset(assetId: string) { return this.assets.has(assetId); }
  async listHydratedAssetIds(uid: string) { return [...(this.hydrated.get(uid) ?? [])]; }
  async markHydratedAsset(uid: string, assetId: string) {
    const ids = this.hydrated.get(uid) ?? new Set<string>();
    ids.add(assetId);
    this.hydrated.set(uid, ids);
  }
  async unmarkHydratedAsset(uid: string, assetId: string) { this.hydrated.get(uid)?.delete(assetId); }
  async openAssetSource(value: DBlobDBAsset): Promise<{ plaintextBytes: number; source: PrivateProVaultAssetPlaintextSource }> {
    this.sourceOpenCount++;
    const bytes = Uint8Array.from(Buffer.from(value.data.base64, 'base64'));
    let offset = 0;
    if (this.blockNextSourceRead) {
      this.blockNextSourceRead = false;
      this.blockedSourceReadStarted = new Promise(resolve => { this.resolveBlockedSourceReadStarted = resolve; });
      return {
        plaintextBytes: bytes.byteLength,
        source: {
          [Symbol.asyncIterator]: () => ({
            next: () => {
              this.resolveBlockedSourceReadStarted?.();
              return new Promise<IteratorResult<Uint8Array>>(() => undefined);
            },
            return: async () => ({ done: true as const, value: undefined }),
          }),
        },
      };
    }
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
  abortUploadAt: number | null = null;
  abortController: AbortController | null = null;
  autoAbortBeforeObjectHash = false;
  hashCalls = 0;
  rejectDivergentReady = true;
  private ready: { opaqueAssetId: string; ciphertextBytes: number; chunks: any[] } | null = null;

  async reserveUpload(input: { operationId: string; opaqueAssetId: string; chunks: any[] }) {
    this.reservations.push(structuredClone(input));
    if (this.ready?.opaqueAssetId === input.opaqueAssetId) {
      const readyDescriptors = this.ready.chunks.map(({ opaqueChunkId, chunkIndex, ciphertextBytes, objectBytes, objectSha256 }) => ({
        opaqueChunkId, chunkIndex, ciphertextBytes, objectBytes, objectSha256,
      }));
      if (JSON.stringify(readyDescriptors) === JSON.stringify(input.chunks)) return {
        status: 'already-uploaded' as const,
        opaqueAssetId: input.opaqueAssetId,
        ciphertextBytes: this.ready.ciphertextBytes,
      };
      if (this.rejectDivergentReady) throw new Error('Encrypted asset already exists with different ciphertext descriptors.');
    }
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
    if (input.chunkIndex === this.abortUploadAt) {
      this.abortController?.abort();
      throw abortErrorForTest();
    }
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
    this.ready = null;
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

  async hashBytes(bytes: Uint8Array, signal?: AbortSignal) {
    this.hashCalls++;
    if (this.autoAbortBeforeObjectHash) this.abortController?.abort();
    if (signal?.aborted) throw abortErrorForTest();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
    return [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
  }
}

function abortErrorForTest(): DOMException {
  return new DOMException('The encrypted attachment operation was aborted.', 'AbortError');
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
    assert.equal(local.sourceOpenCount, 1, 'upload preparation must consume exactly one source snapshot');
  });

  test('downloads, verifies, decrypts, and restores a missing DBlob in server order', async () => {
    const { client, local, transport, original } = await fixture();
    await client.prepareForUpload([ASSET_ID]);
    local.assets.clear();

    await client.prepareForHydrate([ASSET_ID]);

    assert.deepEqual(transport.downloadedIndices, [0, 1]);
    assert.deepEqual(local.assets.get(ASSET_ID), original);
    assert.deepEqual(await local.listHydratedAssetIds(UID), [ASSET_ID]);
  });

  test('clears only vault-hydrated plaintext assets for this account', async () => {
    const { client, local, original } = await fixture();
    const unrelated = { ...structuredClone(original), id: 'preexisting-unrelated' };
    local.assets.set(unrelated.id, unrelated);
    await client.prepareForUpload([ASSET_ID]);
    local.assets.delete(ASSET_ID);
    await client.prepareForHydrate([ASSET_ID]);

    await client.clearHydratedAssets();

    assert.equal(local.assets.has(ASSET_ID), false);
    assert.deepEqual(local.assets.get(unrelated.id), unrelated);
    assert.deepEqual(await local.listHydratedAssetIds(UID), []);
  });

  test('preserves a preexisting local asset and rolls back failed hydration materialization', async () => {
    const preexisting = await fixture();
    await preexisting.client.prepareForUpload([ASSET_ID]);
    await preexisting.client.prepareForHydrate([ASSET_ID]);
    assert.deepEqual(await preexisting.local.listHydratedAssetIds(UID), [], 'existing local assets are not claimed by vault hydration');

    const failed = await fixture();
    await failed.client.prepareForUpload([ASSET_ID]);
    failed.local.assets.delete(ASSET_ID);
    failed.local.failPut = true;
    await assert.rejects(failed.client.prepareForHydrate([ASSET_ID]), /put failure/i);
    assert.equal(failed.local.assets.has(ASSET_ID), false);
    assert.deepEqual(await failed.local.listHydratedAssetIds(UID), []);
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

  test('aborts promptly during plaintext source preparation without reserving or uploading', async () => {
    const { client, local, transport } = await fixture();
    local.blockNextSourceRead = true;
    const controller = new AbortController();
    const upload = client.prepareForUpload([ASSET_ID], controller.signal);
    await local.blockedSourceReadStarted;

    controller.abort();

    await assert.rejects(Promise.race([
      upload,
      new Promise((_, reject) => setTimeout(() => reject(new Error('abort timed out')), 250)),
    ]), error => error instanceof DOMException && error.name === 'AbortError');
    assert.equal(transport.reservations.length, 0);
    assert.deepEqual(transport.uploadedIndices, []);
    assert.equal(transport.finalized, 0);
  });

  test('aborts promptly when iterator cleanup never settles', async () => {
    const { client, local, transport } = await fixture();
    local.blockNextSourceRead = true;
    const originalOpen = local.openAssetSource.bind(local);
    local.openAssetSource = async value => {
      const opened = await originalOpen(value);
      if (!('getReader' in opened.source) && !(opened.source instanceof Uint8Array) && !(opened.source instanceof Blob)) {
        const iterator = opened.source[Symbol.asyncIterator]();
        opened.source = {
          [Symbol.asyncIterator]: () => ({
            next: () => iterator.next(),
            return: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
          }),
        } as PrivateProVaultAssetPlaintextSource;
      }
      return opened;
    };
    const controller = new AbortController();
    const upload = client.prepareForUpload([ASSET_ID], controller.signal);
    await local.blockedSourceReadStarted;

    controller.abort();

    await assert.rejects(Promise.race([
      upload,
      new Promise((_, reject) => setTimeout(() => reject(new Error('abort timed out')), 250)),
    ]), error => error instanceof DOMException && error.name === 'AbortError');
    assert.equal(transport.reservations.length, 0);
    assert.equal(transport.objects.size, 0);
    assert.equal(transport.finalized, 0);
  });

  test('aborts promptly during chunk encryption without reserving or leaving stale objects', async () => {
    const { client, transport } = await fixture();
    const OriginalWorker = globalThis.Worker;
    let terminated = false;
    let messagePosted: (() => void) | null = null;
    const posted = new Promise<void>(resolve => { messagePosted = resolve; });
    class BlockingWorker {
      addEventListener() { /* the synthetic crypto job never resolves */ }
      postMessage() { messagePosted?.(); }
      terminate() { terminated = true; }
    }
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: BlockingWorker });
    try {
      const controller = new AbortController();
      const upload = client.prepareForUpload([ASSET_ID], controller.signal);
      await posted;

      controller.abort();

      await assert.rejects(Promise.race([
        upload,
        new Promise((_, reject) => setTimeout(() => reject(new Error('abort timed out')), 250)),
      ]), error => error instanceof DOMException && error.name === 'AbortError');
      assert.equal(terminated, true);
      assert.equal(transport.reservations.length, 0);
      assert.equal(transport.objects.size, 0);
      assert.equal(transport.finalized, 0);
    } finally {
      Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: OriginalWorker });
    }
  });

  test('aborts during descriptor hashing before reservation or stale effects', async () => {
    const { client, transport } = await fixture();
    const controller = new AbortController();
    transport.autoAbortBeforeObjectHash = true;
    transport.abortController = controller;

    await assert.rejects(client.prepareForUpload([ASSET_ID], controller.signal), /abort/i);

    assert.equal(transport.hashCalls, 1);
    assert.equal(transport.reservations.length, 0);
    assert.equal(transport.objects.size, 0);
    assert.equal(transport.finalized, 0);
  });

  test('reuses exact descriptors for unchanged chat sync and later backup preparation', async () => {
    const { client, transport } = await fixture();

    await client.prepareForUpload([ASSET_ID]);
    const uploaded = [...transport.uploadedIndices];
    await client.prepareForUpload([ASSET_ID]);

    assert.deepEqual(transport.reservations[1].chunks, transport.reservations[0].chunks);
    assert.deepEqual(transport.uploadedIndices, uploaded);
    assert.equal(transport.finalized, 1);
  });

  test('retries an interrupted upload with the exact same ciphertext descriptors', async () => {
    const { client, transport } = await fixture();
    const controller = new AbortController();
    transport.abortUploadAt = 1;
    transport.abortController = controller;

    await assert.rejects(client.prepareForUpload([ASSET_ID], controller.signal), /abort/i);
    const firstDescriptors = structuredClone(transport.reservations[0].chunks);
    transport.abortUploadAt = null;
    transport.abortController = null;

    await client.prepareForUpload([ASSET_ID]);

    assert.deepEqual(transport.reservations[1].chunks, firstDescriptors);
    assert.equal(transport.releases, 1);
    assert.equal(transport.finalized, 1);
  });

  test('rejects changed payload or metadata under the immutable logical asset ID', async () => {
    const payloadChanged = await fixture();
    await payloadChanged.client.prepareForUpload([ASSET_ID]);
    const changedBytes = Uint8Array.from(Buffer.from(payloadChanged.original.data.base64, 'base64'));
    changedBytes[0] ^= 0x80;
    const changedAsset = structuredClone(payloadChanged.original);
    changedAsset.data.base64 = Buffer.from(changedBytes).toString('base64');
    payloadChanged.local.assets.set(ASSET_ID, changedAsset);
    await assert.rejects(payloadChanged.client.prepareForUpload([ASSET_ID]), /different ciphertext|descriptor/i);

    const metadataChanged = await fixture();
    await metadataChanged.client.prepareForUpload([ASSET_ID]);
    metadataChanged.local.assets.set(ASSET_ID, { ...metadataChanged.original, label: 'renamed-private-file.png' });
    await assert.rejects(metadataChanged.client.prepareForUpload([ASSET_ID]), /different ciphertext|descriptor/i);
  });

  test('encrypts the current source snapshot once even if later opens would change same-length bytes', async () => {
    const first = await fixture();
    await first.client.prepareForUpload([ASSET_ID]);
    const secondLocal = new MemoryLocalPort();
    secondLocal.assets.set(ASSET_ID, structuredClone(first.original));
    const originalOpen = secondLocal.openAssetSource.bind(secondLocal);
    secondLocal.openAssetSource = async (value): Promise<{ plaintextBytes: number; source: PrivateProVaultAssetPlaintextSource }> => {
      const opened = await originalOpen(value);
      if (secondLocal.sourceOpenCount > 1) {
        const changed = Uint8Array.from(Buffer.from(value.data.base64, 'base64'));
        changed[0] ^= 0x80;
        return { plaintextBytes: changed.byteLength, source: changed };
      }
      return opened;
    };
    const secondClient = createPrivateProVaultAssetClient({
      vaultId: UID,
      masterKey: first.masterKey,
      keyVersion: KEY_VERSION,
      local: secondLocal,
      transport: first.transport,
      createOperationId: () => 'asset-operation-mutable-source',
    });

    await secondClient.prepareForUpload([ASSET_ID]);

    assert.equal(secondLocal.sourceOpenCount, 1);
    assert.deepEqual(first.transport.reservations[1].chunks, first.transport.reservations[0].chunks);
  });

  test('derives the same opaque descriptors on a fresh device with no local vault mapping', async () => {
    const first = await fixture();
    await first.client.prepareForUpload([ASSET_ID]);
    const freshLocal = new MemoryLocalPort();
    freshLocal.assets.set(ASSET_ID, structuredClone(first.original));
    const freshClient = createPrivateProVaultAssetClient({
      vaultId: UID,
      masterKey: first.masterKey,
      keyVersion: KEY_VERSION,
      local: freshLocal,
      transport: first.transport,
      createOperationId: () => 'asset-operation-fresh-device',
    });

    await freshClient.prepareForUpload([ASSET_ID]);

    assert.equal(first.transport.reservations[1].opaqueAssetId, first.transport.reservations[0].opaqueAssetId);
    assert.deepEqual(first.transport.reservations[1].chunks, first.transport.reservations[0].chunks);
    assert.equal(first.transport.finalized, 1);
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
