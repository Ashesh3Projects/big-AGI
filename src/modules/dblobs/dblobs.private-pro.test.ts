import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import Dexie from 'dexie';

import { setPrivateProEncryptedPersistenceActive } from '~/modules/private-pro/persistence/privatePro.persistence';
import { DBlobAssetType, DBlobMimeType, type DBlobDBAsset } from './dblobs.types';


let dbModule: typeof import('./dblobs.db');

before(async () => {
  setPrivateProEncryptedPersistenceActive(true);
  dbModule = await import('./dblobs.db');
});

after(async () => {
  setPrivateProEncryptedPersistenceActive(false);
  await Dexie.delete('Big-AGI');
});

test('keeps private Pro DBlobs in volatile runtime state and out of the plaintext Dexie table', async () => {
  const sentinel = 'sentinel-asset-metadata';
  const asset: DBlobDBAsset = {
    id: 'asset-private-pro',
    contextId: 'global',
    scopeId: 'app-chat',
    assetType: DBlobAssetType.IMAGE,
    label: sentinel,
    data: { mimeType: DBlobMimeType.IMG_PNG, base64: Buffer.from(sentinel).toString('base64') },
    origin: { ot: 'user', source: 'attachment', media: 'file-open', fileName: sentinel },
    metadata: { width: 1, height: 1, description: sentinel },
    createdAt: new Date('2026-08-19T00:00:00.000Z'),
    updatedAt: new Date('2026-08-19T00:00:00.000Z'),
    cache: {},
  };

  await dbModule.putDBAsset(asset);

  assert.deepEqual(await dbModule.getDBAsset(asset.id), asset);
  const raw = new Dexie('Big-AGI');
  raw.version(1).stores({ largeAssets: 'id' });
  assert.equal(JSON.stringify(await raw.table('largeAssets').toArray()).includes(sentinel), false);
  raw.close();
});

test('clears volatile and legacy plaintext DBlobs during private Pro setup or logout', async () => {
  const asset: DBlobDBAsset = {
    id: 'asset-clear-private-pro', contextId: 'global', scopeId: 'app-chat', assetType: DBlobAssetType.IMAGE,
    label: 'sentinel-clear', data: { mimeType: DBlobMimeType.IMG_PNG, base64: 'c2VudGluZWw=' },
    origin: { ot: 'user', source: 'attachment', media: 'file-open' }, metadata: { width: 1, height: 1 },
    createdAt: new Date('2026-08-19T00:00:00.000Z'), updatedAt: new Date('2026-08-19T00:00:00.000Z'), cache: {},
  };
  await dbModule.putDBAsset(asset);
  const raw = new Dexie('Big-AGI');
  raw.version(1).stores({ largeAssets: 'id' });
  await raw.table('largeAssets').put({ ...asset, id: 'legacy-plaintext-asset' });

  await dbModule.clearPrivateProPlaintextDBlobPersistence();

  assert.equal(await dbModule.getDBAsset(asset.id), undefined);
  assert.equal(await raw.table('largeAssets').count(), 0);
  raw.close();
});
