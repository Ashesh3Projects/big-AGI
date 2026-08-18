import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { NextRequest } from 'next/server';

import { getFirebasePrivateProAssetsService } from './privatePro.assets.firebase';
import { getFirebasePrivateProVaultAssetsService } from '../vault/privatePro.vault.assets.firebase';


interface FirestoreIndex {
  collectionGroup: string;
  queryScope: 'COLLECTION' | 'COLLECTION_GROUP';
  fields: Array<{ fieldPath: string; order: 'ASCENDING' | 'DESCENDING' }>;
}

const LEGACY_ASSET_PROCEDURES = [
  'privateProAssets.reserveUpload',
  'privateProAssets.finalizeUpload',
  'privateProAssets.getDownload',
  'privateProAssets.releaseExpired',
  'privateProAssets.releaseReservation',
] as const;

function hasIndex(indexes: readonly FirestoreIndex[], expected: FirestoreIndex): boolean {
  return indexes.some(index =>
    index.collectionGroup === expected.collectionGroup
    && index.queryScope === expected.queryScope
    && JSON.stringify(index.fields) === JSON.stringify(expected.fields),
  );
}

test('deploys the composite indexes required by mounted plaintext asset paths', async () => {
  const [{ appRouterCloud }, rawIndexes] = await Promise.all([
    import('~/server/trpc/trpc.router-cloud'),
    readFile('firestore.indexes.json', 'utf8'),
  ]);
  const procedureNames = Object.keys(appRouterCloud._def.procedures);
  const plaintextAssetsMounted = LEGACY_ASSET_PROCEDURES.some(name => procedureNames.includes(name));
  const indexes = (JSON.parse(rawIndexes) as { indexes: FirestoreIndex[] }).indexes;
  if (plaintextAssetsMounted) {
    assert.equal(hasIndex(indexes, {
      collectionGroup: 'assets',
      queryScope: 'COLLECTION',
      fields: [
        { fieldPath: 'contentHash', order: 'ASCENDING' },
        { fieldPath: 'status', order: 'ASCENDING' },
      ],
    }), true, 'reserveUpload requires the assets contentHash/status index');
  }

});

test('production sweep route invokes legacy and encrypted reservation services', async () => {
  const [route, sweep] = await Promise.all([
    import('../../../../app/api/private-pro/sweep-expired/route'),
    import('../../../../app/api/private-pro/sweep-expired/privatePro.sweep-expired'),
  ]);
  const calls = { legacy: 0, encrypted: 0 };
  assert.equal(sweep.privateProReservationSweepProductionFactories.legacy, getFirebasePrivateProAssetsService);
  assert.equal(sweep.privateProReservationSweepProductionFactories.encrypted, getFirebasePrivateProVaultAssetsService);

  const testFactories = {
    legacy() {
      return {
        async sweepExpiredReservations() {
          calls.legacy++;
          return { released: 2 };
        },
      };
    },
    encrypted() {
      return {
        async sweepExpiredReservations() {
          calls.encrypted++;
          return { released: 3 };
        },
      };
    },
  };
  const production = sweep.privateProSweepExpiredProductionDependencies;
  const previous = { ...production };
  try {
    production.enabled = true;
    production.cronSecret = 'cron-secret';
    production.factories = testFactories;
    const response = await route.GET(new NextRequest('https://example.test/api/private-pro/sweep-expired', {
      headers: { authorization: 'Bearer cron-secret' },
    }));

    assert.equal(route.GET, sweep.privateProSweepExpiredGET);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { released: 5 });
    assert.deepEqual(calls, { legacy: 1, encrypted: 1 });
  } finally {
    Object.assign(production, previous);
  }
});

test('schedules the reservation sweep route with its legacy cleanup index', async () => {
  const [rawVercelConfig, rawIndexes] = await Promise.all([
    readFile('vercel.json', 'utf8'),
    readFile('firestore.indexes.json', 'utf8'),
  ]);
  const vercelConfig = JSON.parse(rawVercelConfig) as { crons?: Array<{ path: string; schedule: string }> };
  const indexes = (JSON.parse(rawIndexes) as { indexes: FirestoreIndex[] }).indexes;

  assert.deepEqual(vercelConfig.crons, [{ path: '/api/private-pro/sweep-expired', schedule: '0 3 * * *' }]);
  assert.equal(hasIndex(indexes, {
    collectionGroup: 'quotaReservations',
    queryScope: 'COLLECTION_GROUP',
    fields: [
      { fieldPath: 'status', order: 'ASCENDING' },
      { fieldPath: 'expiresAtMs', order: 'ASCENDING' },
    ],
  }), true, 'the scheduled plaintext reservation sweep requires the quotaReservations status/expiresAtMs index');
});
