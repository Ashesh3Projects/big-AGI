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
const uploadLease = { port: syncDB, leaseMs: 80, renewEveryMs: 15, retryEveryMs: 2 };

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
  await activatePrivateProAssetPersistence(null, null);
  syncDB.close();
  await Dexie.delete(DB_NAME);
  await Dexie.delete('Big-AGI');
});

test('persists Private Pro DBlobs for one UID across local port instances', async () => {
  const dbModule = await dbModulePromise;
  const firstPort = createPrivateProAssetLocalPort('uid-a', syncDB);
  await activatePrivateProAssetPersistence('uid-a', firstPort);
  const asset = imageAsset('asset-durable');

  await dbModule.putDBAsset(asset);
  await activatePrivateProAssetPersistence('uid-a', createPrivateProAssetLocalPort('uid-a', syncDB));

  assert.deepEqual(await dbModule.getDBAsset(asset.id), asset);
  assert.ok((await dbModule.getDBAsset(asset.id))?.createdAt instanceof Date);
});

test('does not expose another UID assets after an account switch', async () => {
  const dbModule = await dbModulePromise;
  const asset = imageAsset('asset-isolated');
  await activatePrivateProAssetPersistence('uid-a', createPrivateProAssetLocalPort('uid-a', syncDB));
  await dbModule.putDBAsset(asset);

  await activatePrivateProAssetPersistence('uid-b', createPrivateProAssetLocalPort('uid-b', syncDB));

  assert.equal(await dbModule.getDBAsset(asset.id), undefined);
});

test('clears only the selected UID asset namespace', async () => {
  const dbModule = await dbModulePromise;
  const assetA = imageAsset('asset-clear-a');
  const assetB = imageAsset('asset-clear-b');
  await activatePrivateProAssetPersistence('uid-a', createPrivateProAssetLocalPort('uid-a', syncDB));
  await dbModule.putDBAsset(assetA);
  await activatePrivateProAssetPersistence('uid-b', createPrivateProAssetLocalPort('uid-b', syncDB));
  await dbModule.putDBAsset(assetB);

  await dbModule.clearPrivateProPlaintextDBlobPersistence();
  await activatePrivateProAssetPersistence('uid-a', createPrivateProAssetLocalPort('uid-a', syncDB));

  assert.deepEqual(await dbModule.getDBAsset(assetA.id), assetA);
  await activatePrivateProAssetPersistence('uid-b', createPrivateProAssetLocalPort('uid-b', syncDB));
  assert.equal(await dbModule.getDBAsset(assetB.id), undefined);
});

test('rejects a delayed read after activation switches UID', async () => {
  const dbModule = await dbModulePromise;
  const portA = createPrivateProAssetLocalPort('uid-a', syncDB);
  const asset = imageAsset('asset-race-read');
  await portA.putAsset(asset);
  const gate = deferred();
  await activatePrivateProAssetPersistence('uid-a', delayPort(portA, 'getAsset', gate));

  const reading = dbModule.getDBAsset(asset.id);
  const switching = activatePrivateProAssetPersistence('uid-b', createPrivateProAssetLocalPort('uid-b', syncDB));
  gate.resolve();

  await assert.rejects(reading, { name: 'AbortError' });
  await switching;
});

for (const operation of ['put', 'update', 'delete', 'gc'] as const) {
  test(`does not commit a delayed ${operation} after activation switches UID`, async () => {
    const dbModule = await dbModulePromise;
    const portA = createPrivateProAssetLocalPort('uid-a', syncDB);
    const asset = imageAsset(`asset-race-${operation}`);
    await portA.putAsset(asset);
    const method = operation === 'put' ? 'putAsset' : operation === 'update' ? 'updateAsset' : operation === 'delete' ? 'deleteAsset' : 'listAssets';
    const gate = deferred();
    await activatePrivateProAssetPersistence('uid-a', delayPort(portA, method, gate));
    const pending = operation === 'put' ? dbModule.putDBAsset({ ...asset, label: 'changed' })
      : operation === 'update' ? dbModule.transferDBAssetContextScope(asset.id, 'global', 'app-draw')
        : operation === 'delete' ? dbModule.deleteDBAsset(asset.id)
          : dbModule.gcDBAssetsByScope('global', 'app-chat', null, []);
    const switching = activatePrivateProAssetPersistence('uid-b', createPrivateProAssetLocalPort('uid-b', syncDB));
    gate.resolve();

    await assert.rejects(pending, { name: 'AbortError' });
    await switching;
    assert.deepEqual(await portA.getAsset(asset.id), asset);
  });
}

test('does not expose the new UID until the old native transaction settles', async () => {
  const dbModule = await dbModulePromise;
  const portA = createPrivateProAssetLocalPort('uid-a', syncDB);
  const portB = createPrivateProAssetLocalPort('uid-b', syncDB);
  await activatePrivateProAssetPersistence('uid-a', portA);
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const slow = new Proxy(portA, {
    get(target, property, receiver) {
      if (property !== 'putAsset') return Reflect.get(target, property, receiver);
      return async (...args: unknown[]) => { started(); await gate; return target.putAsset(...args as Parameters<typeof target.putAsset>); };
    },
  });
  await activatePrivateProAssetPersistence('uid-a', slow);
  const writing = dbModule.putDBAsset(imageAsset('asset-transition-barrier'));
  await startedPromise;
  let switched = false;
  const switching = activatePrivateProAssetPersistence('uid-b', portB).then(() => { switched = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(switched, false);
  release();
  await assert.rejects(writing, { name: 'AbortError' });
  await switching;
  assert.equal(switched, true);
  assert.equal(await dbModule.getDBAsset('asset-transition-barrier'), undefined);
});

test('routes a DBlob operation through the latest chained activation without contaminating Open Dexie', async () => {
  const dbModule = await dbModulePromise;
  await activatePrivateProAssetPersistence(null, null);
  await dbModule.clearPrivateProPlaintextDBlobPersistence();
  const portA = createPrivateProAssetLocalPort('uid-a', syncDB);
  const portB = createPrivateProAssetLocalPort('uid-b', syncDB);
  const portC = createPrivateProAssetLocalPort('uid-c', syncDB);
  const gate = deferred();
  const started = deferred();
  const slow = new Proxy(portA, {
    get(target, property, receiver) {
      if (property !== 'putAsset') return Reflect.get(target, property, receiver);
      return async (...args: unknown[]) => {
        started.resolve();
        await gate.promise;
        return target.putAsset(...args as Parameters<typeof target.putAsset>);
      };
    },
  });
  await activatePrivateProAssetPersistence('uid-a', slow);
  const blocking = dbModule.putDBAsset(imageAsset('asset-transition-blocker'));
  await started.promise;

  const switchingToB = activatePrivateProAssetPersistence('uid-b', portB);
  const asset = imageAsset('asset-transition-chained');
  const writing = dbModule.putDBAsset(asset);
  const switchingToC = activatePrivateProAssetPersistence('uid-c', portC);
  gate.resolve();

  await assert.rejects(blocking, { name: 'AbortError' });
  await Promise.all([switchingToB, switchingToC, writing]);
  const routedAsset = await portC.getAsset(asset.id);
  await activatePrivateProAssetPersistence(null, null);
  const openAsset = await dbModule.getDBAsset(asset.id);

  assert.deepEqual(routedAsset, asset);
  assert.equal(openAsset, undefined);
});

test('routes DBlob delete through canonical manifest deletion and both Storage objects', async () => {
  const dbModule = await dbModulePromise;
  const port = createPrivateProAssetLocalPort('uid-a', syncDB);
  const paths: string[] = [];
  const storage: PrivateProAssetStoragePort = {
    uploadBytesResumable: async () => {}, getBytes: async () => new Uint8Array(),
    getMetadata: async () => ({ contentType: 'image/png', customMetadata: { uid: 'uid-a', assetId: 'asset-delete-route', kind: 'original', sha256: 'a'.repeat(64) } }),
    deleteObject: async path => { paths.push(path); },
  };
  const client = createPrivateProAssetClient('uid-a', storage, { wake: () => {} }, port, undefined, uploadLease);
  const asset = imageAsset('asset-delete-route');
  await port.putAsset(asset);
  await client.ensureUploaded([asset.id]);
  const manifestEvents: number[] = [];
  port.subscribe(async () => { manifestEvents.push((await port.listManifests()).length); });
  await activatePrivateProAssetPersistence('uid-a', port, (assetId, guard) => client.delete(assetId, guard));

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
  const client = createPrivateProAssetClient('uid-a', storage, { wake: () => {} }, port, undefined, uploadLease);
  const asset = imageAsset('asset-gc-route');
  await port.putAsset(asset);
  await client.ensureUploaded([asset.id]);
  await Promise.all((await port.listAssets()).filter(value => value.id !== asset.id).map(value => port.deleteAsset(value.id)));
  paths.length = 0;
  await activatePrivateProAssetPersistence('uid-a', port, (assetId, guard) => client.delete(assetId, guard));

  await dbModule.gcDBAssetsByScope('global', 'app-chat', null, []);

  assert.equal(await port.getAsset(asset.id), undefined);
  assert.equal(paths.length, 2);
});

for (const operation of ['put', 'update', 'delete', 'gc', 'clear'] as const) {
  test(`rolls back ${operation} when activation switches inside the Dexie request`, async () => {
    const dbModule = await dbModulePromise;
    const asset = imageAsset(`asset-hook-${operation}`);
    const portA = createPrivateProAssetLocalPort('uid-a', syncDB);
    const portB = createPrivateProAssetLocalPort('uid-b', syncDB);
    await portA.clear();
    if (operation !== 'put') await portA.putAsset(asset);
    const event = operation === 'put' ? 'creating' : operation === 'update' ? 'updating' : 'deleting';
    const hook = () => { void activatePrivateProAssetPersistence('uid-b', portB); };
    syncDB.assets.hook(event).subscribe(hook);
    await activatePrivateProAssetPersistence('uid-a', portA);
    const pending = operation === 'put' ? dbModule.putDBAsset(asset)
      : operation === 'update' ? dbModule.transferDBAssetContextScope(asset.id, 'global', 'app-draw')
        : operation === 'delete' ? dbModule.deleteDBAsset(asset.id)
          : operation === 'gc' ? dbModule.gcDBAssetsByScope('global', 'app-chat', null, [])
            : dbModule.clearPrivateProPlaintextDBlobPersistence();

    await assert.rejects(pending);
    syncDB.assets.hook(event).unsubscribe(hook);
    const staleCommitted = operation === 'put' ? !!await portA.getAsset(asset.id)
      : operation === 'update' ? (await portA.getAsset(asset.id))?.scopeId === 'app-draw'
        : operation === 'clear' ? !await portA.getAsset(asset.id)
          : !await portA.getAsset(asset.id);
    assert.equal(staleCommitted, false);
  });
}
