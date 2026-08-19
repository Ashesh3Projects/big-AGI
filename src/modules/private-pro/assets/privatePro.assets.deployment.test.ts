import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { NextRequest } from 'next/server';

import { getFirebasePrivateProVaultAssetsService } from '../vault/privatePro.vault.assets.firebase';
import type { PrivateProAccountRecord } from '../auth/privatePro.auth.service';
import type { PrivateProIdentity } from '../auth/privatePro.auth.types';

process.env.NEXT_PUBLIC_PRIVATE_PRO_ENABLED = 'true';
process.env.PRIVATE_PRO_ALLOWED_EMAILS = 'friend@example.com';


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

test('mounted encrypted asset procedures fail closed before the legacy quota service', async () => {
  const { createPrivateProVaultAssetsRouter } = await import('./privatePro.assets.router');
  const identity: PrivateProIdentity = {
    uid: 'uid-current', email: 'friend@example.com', emailVerified: true, privatePro: true, privateProEpoch: 3, issuedAt: 1, expiresAt: 2,
  };
  const account: PrivateProAccountRecord = {
    uid: identity.uid, email: identity.email, active: true, accessEpoch: 3, createdAtMs: 1, updatedAtMs: 1,
  };
  let serviceCalls = 0;
  const { privateProNodePremiumProcedure } = await import('../auth/privatePro.auth.procedures.server');
  const router = createPrivateProVaultAssetsRouter(privateProNodePremiumProcedure, () => ({
    async reserveUpload() { serviceCalls++; throw new Error('legacy quota reached'); },
    async finalizeUpload() { serviceCalls++; throw new Error('legacy quota reached'); },
    async getDownload() { serviceCalls++; throw new Error('legacy quota reached'); },
    async releaseReservation() { serviceCalls++; throw new Error('legacy quota reached'); },
  } as never));
  const caller = router.createCaller({
    hostName: 'localhost', reqSignal: new AbortController().signal, privateProIdentity: identity,
    privateProAuthError: null, privateProAppCheckToken: 'app-check',
  });
  const opaqueId = 'a'.repeat(43);
  const calls = [
    () => caller.reserveEncryptedUpload({ operationId: 'operation-1', opaqueAssetId: opaqueId, chunks: [{
      opaqueChunkId: opaqueId, chunkIndex: 0, ciphertextBytes: 1, objectBytes: 1, objectSha256: 'a'.repeat(64),
    }] }),
    () => caller.finalizeEncryptedUpload({ operationId: 'operation-1' }),
    () => caller.getEncryptedDownload({ opaqueAssetId: opaqueId }),
    () => caller.releaseEncryptedReservation({ operationId: 'operation-1' }),
  ];
  for (const call of calls) await assert.rejects(call(), error => ['NOT_FOUND', 'UNAUTHORIZED'].includes((error as { code?: string }).code ?? ''));
  assert.equal(serviceCalls, 0);
});

test('production sweep route fails closed without constructing legacy reservation services', async () => {
  const [route, sweep] = await Promise.all([
    import('../../../../app/api/private-pro/sweep-expired/route'),
    import('../../../../app/api/private-pro/sweep-expired/privatePro.sweep-expired'),
  ]);
  let factoryCalls = 0;
  assert.equal(sweep.privateProReservationSweepProductionFactories.encrypted, getFirebasePrivateProVaultAssetsService);

  const production = sweep.privateProSweepExpiredProductionDependencies;
  const previous = { ...production };
  try {
    production.enabled = true;
    production.cronSecret = 'cron-secret';
    production.factories = {
      encrypted() {
        factoryCalls++;
        return {
          async sweepExpiredReservations() {
            return { released: 3 };
          },
        };
      },
    };
    const response = await route.GET(new NextRequest('https://example.test/api/private-pro/sweep-expired', {
      headers: { authorization: 'Bearer cron-secret' },
    }));

    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), { error: 'Private Pro legacy endpoint is unavailable.' });
    assert.equal(factoryCalls, 0);
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
