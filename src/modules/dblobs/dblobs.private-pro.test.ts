import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import Dexie from 'dexie';

import {
  activatePrivateProAssetPersistence,
  createPrivateProAssetLocalPort,
  type PrivateProAssetLocalPort,
} from '~/modules/private-pro/assets/privatePro.assets.local';
import { createPrivateProAssetClient, type PrivateProAssetStorageMetadata, type PrivateProAssetStoragePort } from '~/modules/private-pro/assets/privatePro.assets.client';
import { PrivateProSyncDB } from '~/modules/private-pro/sync/privatePro.sync.db';
import { DBlobAssetType, DBlobMimeType, type DBlobDBAsset } from './dblobs.types';


const DB_NAME = `private-pro-dblobs-${crypto.randomUUID()}`;
const syncDB = new PrivateProSyncDB(DB_NAME);
const dbModulePromise = import('./dblobs.db');

function imageAsset(id: string): DBlobDBAsset {
  return {
    id,
    contextId: 'global',
    scopeId: 'app-chat',
    assetType: DBlobAssetType.IMAGE,
    label: `label-${id}`,
    data: { mimeType: DBlobMimeType.IMG_PNG, base64: btoa(`bytes-${id}`) },
    origin: { ot: 'user', source: 'attachment', media: 'file-open', fileName: `${id}.png` },
    metadata: { width: 4, height: 3, description: `description-${id}` },
    createdAt: new Date('2026-08-19T00:00:00.000Z'),
    updatedAt: new Date('2026-08-19T00:01:00.000Z'),
    cache: {},
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(resolve_ => { resolve = resolve_; });
  return { promise, resolve };
}

function delayPort(port: PrivateProAssetLocalPort, method: keyof PrivateProAssetLocalPort, gate: ReturnType<typeof deferred>): PrivateProAssetLocalPort {
  return new Proxy(port, {
    get(target, property, receiver) {
      if (property !== method) return Reflect.get(target, property, receiver);
      return async (...args: unknown[]) => {
        await gate.promise;
        return (target[property] as (...values: unknown[]) => unknown)(...args);
      };
    },
  });
}

after(async () => {
  activatePrivateProAssetPersistence(null, null);
  syncDB.close();
  await Dexie.delete(DB_NAME);
  await Dexie.delete('Big-AGI');
});

test('persists Private Pro DBlobs for one UID across local port instances', async () => {
  const dbModule = await dbModulePromise;
  const firstPort = createPrivateProAssetLocalPort('uid-a', syncDB);
  activatePrivateProAssetPersistence('uid-a', firstPort);
  const asset = imageAsset('asset-durable');

  await dbModule.putDBAsset(asset);
  activatePrivateProAssetPersistence('uid-a', createPrivateProAssetLocalPort('uid-a', syncDB));

  assert.deepEqual(await dbModule.getDBAsset(asset.id), asset);
  assert.ok((await dbModule.getDBAsset(asset.id))?.createdAt instanceof Date);
});

test('does not expose another UID assets after an account switch', async () => {
  const dbModule = await dbModulePromise;
  const asset = imageAsset('asset-isolated');
  activatePrivateProAssetPersistence('uid-a', createPrivateProAssetLocalPort('uid-a', syncDB));
  await dbModule.putDBAsset(asset);

  activatePrivateProAssetPersistence('uid-b', createPrivateProAssetLocalPort('uid-b', syncDB));

  assert.equal(await dbModule.getDBAsset(asset.id), undefined);
});

test('clears only the selected UID asset namespace', async () => {
  const dbModule = await dbModulePromise;
  const assetA = imageAsset('asset-clear-a');
  const assetB = imageAsset('asset-clear-b');
  activatePrivateProAssetPersistence('uid-a', createPrivateProAssetLocalPort('uid-a', syncDB));
  await dbModule.putDBAsset(assetA);
  activatePrivateProAssetPersistence('uid-b', createPrivateProAssetLocalPort('uid-b', syncDB));
  await dbModule.putDBAsset(assetB);

  await dbModule.clearPrivateProPlaintextDBlobPersistence();
  activatePrivateProAssetPersistence('uid-a', createPrivateProAssetLocalPort('uid-a', syncDB));

  assert.deepEqual(await dbModule.getDBAsset(assetA.id), assetA);
  activatePrivateProAssetPersistence('uid-b', createPrivateProAssetLocalPort('uid-b', syncDB));
  assert.equal(await dbModule.getDBAsset(assetB.id), undefined);
});

test('rejects a delayed read after activation switches UID', async () => {
  const dbModule = await dbModulePromise;
  const portA = createPrivateProAssetLocalPort('uid-a', syncDB);
  const asset = imageAsset('asset-race-read');
  await portA.putAsset(asset);
  const gate = deferred();
  activatePrivateProAssetPersistence('uid-a', delayPort(portA, 'getAsset', gate));

  const reading = dbModule.getDBAsset(asset.id);
  activatePrivateProAssetPersistence('uid-b', createPrivateProAssetLocalPort('uid-b', syncDB));
  gate.resolve();

  await assert.rejects(reading, { name: 'AbortError' });
});

for (const operation of ['put', 'update', 'delete', 'gc'] as const) {
  test(`does not commit a delayed ${operation} after activation switches UID`, async () => {
    const dbModule = await dbModulePromise;
    const portA = createPrivateProAssetLocalPort('uid-a', syncDB);
    const asset = imageAsset(`asset-race-${operation}`);
    await portA.putAsset(asset);
    const method = operation === 'put' ? 'putAsset' : operation === 'update' ? 'updateAsset' : operation === 'delete' ? 'deleteAsset' : 'listAssets';
    const gate = deferred();
    activatePrivateProAssetPersistence('uid-a', delayPort(portA, method, gate));
    const pending = operation === 'put' ? dbModule.putDBAsset({ ...asset, label: 'changed' })
      : operation === 'update' ? dbModule.transferDBAssetContextScope(asset.id, 'global', 'app-draw')
        : operation === 'delete' ? dbModule.deleteDBAsset(asset.id)
          : dbModule.gcDBAssetsByScope('global', 'app-chat', null, []);
    activatePrivateProAssetPersistence('uid-b', createPrivateProAssetLocalPort('uid-b', syncDB));
    gate.resolve();

    await assert.rejects(pending, { name: 'AbortError' });
    assert.deepEqual(await portA.getAsset(asset.id), asset);
  });
}

test('routes DBlob delete through canonical manifest deletion and both Storage objects', async () => {
  const dbModule = await dbModulePromise;
  const port = createPrivateProAssetLocalPort('uid-a', syncDB);
  const paths: string[] = [];
  const storage: PrivateProAssetStoragePort = {
    uploadBytesResumable: async () => {}, getBytes: async () => new Uint8Array(),
    getMetadata: async () => ({ contentType: 'image/png', customMetadata: { uid: 'uid-a', assetId: 'asset-delete-route', kind: 'original', sha256: 'a'.repeat(64) } }),
    deleteObject: async path => { paths.push(path); },
  };
  const client = createPrivateProAssetClient('uid-a', storage, { wake: () => {} }, port);
  const asset = imageAsset('asset-delete-route');
  await port.putAsset(asset);
  await client.ensureUploaded([asset.id]);
  const manifestEvents: number[] = [];
  port.subscribe(async () => { manifestEvents.push((await port.listManifests()).length); });
  activatePrivateProAssetPersistence('uid-a', port, (assetId, guard) => client.delete(assetId, guard));

  await dbModule.deleteDBAsset(asset.id);

  assert.equal(await port.getAsset(asset.id), undefined);
  assert.equal(manifestEvents.includes(0), true);
  assert.deepEqual(paths.sort(), [
    'users/uid-a/workspace-v1/assets/asset-delete-route/original',
    'users/uid-a/workspace-v1/assets/asset-delete-route/thumb256',
  ].sort());
});

test('routes DBlob GC through canonical delete', async () => {
  const dbModule = await dbModulePromise;
  const port = createPrivateProAssetLocalPort('uid-a', syncDB);
  const paths: string[] = [];
  const storage: PrivateProAssetStoragePort = {
    uploadBytesResumable: async () => {}, getBytes: async () => new Uint8Array(),
    getMetadata: async () => ({ contentType: 'image/png', customMetadata: { uid: 'uid-a', assetId: 'asset-gc-route', kind: 'original', sha256: 'a'.repeat(64) } }),
    deleteObject: async path => { paths.push(path); },
  };
  const client = createPrivateProAssetClient('uid-a', storage, { wake: () => {} }, port);
  const asset = imageAsset('asset-gc-route');
  await port.putAsset(asset);
  await client.ensureUploaded([asset.id]);
  await Promise.all((await port.listAssets()).filter(value => value.id !== asset.id).map(value => port.deleteAsset(value.id)));
  paths.length = 0;
  activatePrivateProAssetPersistence('uid-a', port, (assetId, guard) => client.delete(assetId, guard));

  await dbModule.gcDBAssetsByScope('global', 'app-chat', null, []);

  assert.equal(await port.getAsset(asset.id), undefined);
  assert.equal(paths.length, 2);
});
