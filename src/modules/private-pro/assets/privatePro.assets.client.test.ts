import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';
import Dexie from 'dexie';

import { DBlobAssetType, DBlobMimeType, type DBlobDBAsset } from '~/modules/dblobs/dblobs.types';
import { PrivateProSyncDB } from '../sync/privatePro.sync.db';
import {
  createPrivateProAssetClient,
  type PrivateProAssetStorageMetadata,
  type PrivateProAssetStoragePort,
} from './privatePro.assets.client';
import { createPrivateProAssetLocalPort } from './privatePro.assets.local';
import type { PrivateProAssetManifest } from './privatePro.assets.schemas';


const UID = 'uid-a';

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function base64(input: Uint8Array): string {
  let binary = '';
  for (const byte of input) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fixture(id = 'asset-1', withThumb = true): DBlobDBAsset {
  return {
    id,
    contextId: 'global',
    scopeId: 'attachment-drafts',
    assetType: DBlobAssetType.IMAGE,
    label: 'Exact image label',
    data: { mimeType: DBlobMimeType.IMG_PNG, base64: base64(bytes('original bytes')) },
    origin: { ot: 'generated', source: 'ai-text-to-image', generatorName: 'test-generator', prompt: 'test prompt', parameters: { seed: 7, nested: { strength: 0.5 } }, generatedAt: '2026-08-19T01:00:00.000Z' },
    metadata: { width: 1024, height: 768, averageColor: '#123456', tags: ['one', 'two'] },
    createdAt: new Date('2026-08-19T00:00:00.000Z'),
    updatedAt: new Date('2026-08-19T00:05:00.000Z'),
    cache: withThumb ? { thumb256: { mimeType: DBlobMimeType.IMG_WEBP, base64: base64(bytes('thumb bytes')) } } : {},
  };
}

class FakeStorage implements PrivateProAssetStoragePort {
  readonly uploads: Array<{ path: string; bytes: Uint8Array; metadata: PrivateProAssetStorageMetadata }> = [];
  readonly objects = new Map<string, { bytes: Uint8Array; metadata: PrivateProAssetStorageMetadata }>();
  readonly deletes: string[] = [];
  failUploadPath: string | null = null;
  failDeletePaths = new Set<string>();

  async uploadBytesResumable(path: string, input: Uint8Array, metadata: PrivateProAssetStorageMetadata): Promise<void> {
    this.uploads.push({ path, bytes: Uint8Array.from(input), metadata: structuredClone(metadata) });
    if (path === this.failUploadPath) throw new Error('upload unavailable');
    this.objects.set(path, { bytes: Uint8Array.from(input), metadata: structuredClone(metadata) });
  }

  async getBytes(path: string): Promise<Uint8Array> {
    const object = this.objects.get(path);
    if (!object) throw new Error('object unavailable');
    return Uint8Array.from(object.bytes);
  }

  async getMetadata(path: string): Promise<PrivateProAssetStorageMetadata> {
    const object = this.objects.get(path);
    if (!object) throw new Error('metadata unavailable');
    return structuredClone(object.metadata);
  }

  async deleteObject(path: string): Promise<void> {
    this.deletes.push(path);
    if (this.failDeletePaths.has(path)) throw new Error('delete unavailable');
    this.objects.delete(path);
  }
}

class MissingObjectError extends Error {
  readonly code = 'storage/object-not-found';
}

function harness(t: TestContext) {
  const name = `private-pro-assets-${crypto.randomUUID()}`;
  const db = new PrivateProSyncDB(name);
  const local = createPrivateProAssetLocalPort(UID, db);
  const storage = new FakeStorage();
  let wakes = 0;
  const client = createPrivateProAssetClient(UID, storage, { wake: () => { wakes++; } }, local);
  t.after(async () => {
    db.close();
    await Dexie.delete(name);
  });
  return { client, db, local, storage, wakes: () => wakes };
}

describe('Private Pro direct assets', () => {
  test('uploads decoded original and thumbnail bytes before exposing the manifest', async (t) => {
    const { client, local, storage } = harness(t);
    const asset = fixture();
    await local.putAsset(asset);

    await client.ensureUploaded([asset.id]);

    assert.deepEqual(storage.uploads.map(upload => [upload.path, new TextDecoder().decode(upload.bytes)]), [
      [`users/${UID}/workspace-v1/assets/${asset.id}/original`, 'original bytes'],
      [`users/${UID}/workspace-v1/assets/${asset.id}/thumb256`, 'thumb bytes'],
    ]);
    const manifest = await local.getManifest(asset.id);
    assert.equal(manifest?.objects.original.objectId, 'original');
    assert.equal(manifest?.objects.thumb256?.objectId, 'thumb256');
  });

  test('keeps a failed manifest pending and retries the same deterministic object path', async (t) => {
    const { client, local, storage } = harness(t);
    const asset = fixture('asset-retry', false);
    await local.putAsset(asset);
    storage.failUploadPath = `users/${UID}/workspace-v1/assets/${asset.id}/original`;

    await assert.rejects(client.ensureUploaded([asset.id]));
    assert.equal(await local.getManifest(asset.id), undefined);
    storage.failUploadPath = null;
    await client.ensureUploaded([asset.id]);

    assert.deepEqual(storage.uploads.map(upload => upload.path), [
      `users/${UID}/workspace-v1/assets/${asset.id}/original`,
      `users/${UID}/workspace-v1/assets/${asset.id}/original`,
    ]);
  });

  test('hydrates exact DBlob values after validating metadata, hash, size, MIME, and UID', async (t) => {
    const source = harness(t);
    const asset = fixture('asset-hydrate');
    await source.local.putAsset(asset);
    await source.client.ensureUploaded([asset.id]);
    const manifest = await source.local.getManifest(asset.id);
    assert.ok(manifest);
    await source.local.deleteAsset(asset.id);
    await source.local.putManifest(manifest);

    await source.client.hydrate([asset.id]);

    assert.deepEqual(await source.local.getAsset(asset.id), asset);
    assert.deepEqual(await source.local.getManifest(asset.id), manifest);
    assert.ok((await source.local.getAsset(asset.id))?.createdAt instanceof Date);
  });

  test('rejects a cross-account manifest without reading any object', async (t) => {
    const { client, local, storage } = harness(t);
    const manifest = {
      formatVersion: 1,
      schemaVersion: 1,
      uid: 'uid-b',
      assetId: 'asset-cross-account',
      assetType: 'image',
      contextId: 'global',
      scopeId: 'app-chat',
      label: 'invalid',
      origin: { ot: 'user', source: 'attachment', media: 'file-open' },
      createdAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:00.000Z',
      metadata: { width: 1, height: 1 },
      objects: { original: { objectId: 'original', kind: 'original', mimeType: 'image/png', byteSize: 1, sha256: 'a'.repeat(64) } },
    } as PrivateProAssetManifest;
    await assert.rejects(local.putManifest(manifest), /manifest identity/i);
    await assert.rejects(client.hydrate([manifest.assetId]));
    assert.equal(storage.objects.size, 0);
  });

  test('deletes the manifest canonically and attempts both fixed object cleanups', async (t) => {
    const { client, local, storage, wakes } = harness(t);
    const asset = fixture('asset-delete');
    await local.putAsset(asset);
    await client.ensureUploaded([asset.id]);
    storage.failDeletePaths.add(`users/${UID}/workspace-v1/assets/${asset.id}/original`);

    await assert.rejects(client.delete(asset.id), /cleanup failed/i);

    assert.equal(await local.getManifest(asset.id), undefined);
    assert.equal(await local.getAsset(asset.id), undefined);
    assert.deepEqual(storage.deletes.sort(), [
      `users/${UID}/workspace-v1/assets/${asset.id}/original`,
      `users/${UID}/workspace-v1/assets/${asset.id}/thumb256`,
    ].sort());
    assert.ok(wakes() >= 2);
  });

  test('treats already missing fixed objects as an idempotent delete success', async (t) => {
    const { client, local, storage } = harness(t);
    const asset = fixture('asset-delete-missing', false);
    await local.putAsset(asset);
    await client.ensureUploaded([asset.id]);
    storage.deleteObject = async path => { storage.deletes.push(path); throw new MissingObjectError(); };

    await client.delete(asset.id);

    assert.equal(await local.getManifest(asset.id), undefined);
    assert.equal(storage.deletes.length, 2);
  });
});
