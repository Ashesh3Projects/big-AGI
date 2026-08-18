import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { NextRequest } from 'next/server';

import { getFirebasePrivateProVaultAssetsService } from '../vault/privatePro.vault.assets.firebase';


interface FirestoreIndex {
  collectionGroup: string;
  queryScope: 'COLLECTION' | 'COLLECTION_GROUP';
  fields: Array<{ fieldPath: string; order: 'ASCENDING' | 'DESCENDING' }>;
}

function hasIndex(indexes: readonly FirestoreIndex[], expected: FirestoreIndex): boolean {
  return indexes.some(index =>
    index.collectionGroup === expected.collectionGroup
    && index.queryScope === expected.queryScope
    && JSON.stringify(index.fields) === JSON.stringify(expected.fields),
  );
}

test('mounts encrypted asset procedures without plaintext compatibility procedures', async () => {
  const { appRouterCloud } = await import('~/server/trpc/trpc.router-cloud');
  const procedureNames = Object.keys(appRouterCloud._def.procedures);

  assert.equal(procedureNames.some(name => name.startsWith('privateProAssets.')), false);
  assert.deepEqual(procedureNames.filter(name => name.startsWith('privateProVaultAssets.')).sort(), [
    'privateProVaultAssets.finalizeEncryptedUpload',
    'privateProVaultAssets.getEncryptedDownload',
    'privateProVaultAssets.releaseEncryptedReservation',
    'privateProVaultAssets.reserveEncryptedUpload',
  ]);
  assert.equal(procedureNames.some(name => name.startsWith('privateProSync.')), false);
});

test('production sweep route invokes only encrypted reservation cleanup', async () => {
  const [route, sweep] = await Promise.all([
    import('../../../../app/api/private-pro/sweep-expired/route'),
    import('../../../../app/api/private-pro/sweep-expired/privatePro.sweep-expired'),
  ]);
  let encryptedCalls = 0;
  assert.equal(sweep.privateProReservationSweepProductionFactories.encrypted, getFirebasePrivateProVaultAssetsService);

  const production = sweep.privateProSweepExpiredProductionDependencies;
  const previous = { ...production };
  try {
    production.enabled = true;
    production.cronSecret = 'cron-secret';
    production.factories = {
      encrypted() {
        return {
          async sweepExpiredReservations() {
            encryptedCalls++;
            return { released: 3 };
          },
        };
      },
    };
    const response = await route.GET(new NextRequest('https://example.test/api/private-pro/sweep-expired', {
      headers: { authorization: 'Bearer cron-secret' },
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { released: 3 });
    assert.equal(encryptedCalls, 1);
  } finally {
    Object.assign(production, previous);
  }
});

test('deploys only encrypted reservation indexes', async () => {
  const indexes = (JSON.parse(await readFile('firestore.indexes.json', 'utf8')) as { indexes: FirestoreIndex[] }).indexes;

  assert.equal(indexes.some(index => index.collectionGroup === 'assets' || index.collectionGroup === 'quotaReservations'), false);
  assert.equal(hasIndex(indexes, {
    collectionGroup: 'assetReservations',
    queryScope: 'COLLECTION_GROUP',
    fields: [
      { fieldPath: 'status', order: 'ASCENDING' },
      { fieldPath: 'expiresAtMs', order: 'ASCENDING' },
    ],
  }), true);
});
