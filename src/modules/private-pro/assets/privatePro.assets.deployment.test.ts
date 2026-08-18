import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';


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
  const [{ appRouterCloud }, rawIndexes, sweepRoute] = await Promise.all([
    import('~/server/trpc/trpc.router-cloud'),
    readFile('firestore.indexes.json', 'utf8'),
    readFile('app/api/private-pro/sweep-expired/route.ts', 'utf8'),
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

  if (sweepRoute.includes('getFirebasePrivateProAssetsService().sweepExpiredReservations()')) {
    assert.equal(hasIndex(indexes, {
      collectionGroup: 'quotaReservations',
      queryScope: 'COLLECTION_GROUP',
      fields: [
        { fieldPath: 'status', order: 'ASCENDING' },
        { fieldPath: 'expiresAtMs', order: 'ASCENDING' },
      ],
    }), true, 'the scheduled plaintext reservation sweep requires the quotaReservations status/expiresAtMs index');
  }
});
