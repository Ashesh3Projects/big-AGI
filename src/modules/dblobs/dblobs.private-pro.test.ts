import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import Dexie from 'dexie';

import {
  activatePrivateProAssetPersistence,
  createPrivateProAssetLocalPort,
} from '~/modules/private-pro/assets/privatePro.assets.local';
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
