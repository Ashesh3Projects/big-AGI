import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';


describe('private Pro greenfield vault contract', () => {
  test('does not grant or implement a Firestore migration collection', () => {
    const rules = readFileSync('firestore.rules', 'utf8');
    const repository = readFileSync('src/modules/private-pro/vault/privatePro.vault.repository.firebase.ts', 'utf8');

    assert.doesNotMatch(rules, /match \/migrations\//);
    assert.doesNotMatch(repository, /\/migrations\//);
  });

  test('does not mount or schedule legacy plaintext private Pro mutation paths', () => {
    const cloudRouter = readFileSync('src/server/trpc/trpc.router-cloud.ts', 'utf8');
    const assetRouter = readFileSync('src/modules/private-pro/assets/privatePro.assets.router.ts', 'utf8');
    const sweep = readFileSync('app/api/private-pro/sweep-expired/privatePro.sweep-expired.ts', 'utf8');
    const indexes = readFileSync('firestore.indexes.json', 'utf8');

    assert.doesNotMatch(cloudRouter, /privateProSync/);
    assert.doesNotMatch(cloudRouter, /privateProAssets/);
    assert.doesNotMatch(assetRouter, /getFirebasePrivateProAssetsService|reserveUpload:\s*privateProNodePremiumProcedure|finalizeUpload:\s*privateProNodePremiumProcedure|getDownload:\s*privateProNodePremiumProcedure/);
    assert.doesNotMatch(sweep, /legacy|getFirebasePrivateProAssetsService/);
    assert.doesNotMatch(indexes, /quotaReservations|"collectionGroup": "assets"/);
  });
});
