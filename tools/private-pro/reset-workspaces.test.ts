import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildPrivateProResetPlan,
  parsePrivateProResetArguments,
} from './reset-workspaces';


const PROJECT_ID = 'sample-project';
const NOW_MS = 1_800_000_000_000;

test('plans exact cleanup, approved account replacement, claim rotation, and Auth preservation', () => {
  const plan = buildPrivateProResetPlan({
    projectId: PROJECT_ID,
    execute: false,
    authIdentities: [
      {
        uid: 'approved',
        email: ' Approved@Example.com ',
        emailVerified: true,
        claims: { privatePro: true, privateProEpoch: 4, unrelated: 'keep' },
      },
      {
        uid: 'unverified',
        email: 'unverified@example.com',
        emailVerified: false,
        claims: { privatePro: true, privateProEpoch: 2, unrelated: 7 },
      },
      {
        uid: 'auth-only',
        email: 'auth-only@example.com',
        emailVerified: true,
        claims: { unrelated: true },
      },
    ],
    accountDocuments: [
      {
        uid: 'approved',
        exists: true,
        data: { uid: 'wrong', email: 'old@example.com', active: true, accessEpoch: 6, createdAtMs: 123, quotaBytes: 1, usedBytes: 2, reservedBytes: 3 },
      },
      { uid: 'unverified', exists: true, data: { active: true, accessEpoch: 2 } },
      { uid: 'orphan', exists: true, data: { active: true, accessEpoch: 9 } },
    ],
    allowedEmails: new Set(['approved@example.com', 'auth-only@example.com']),
    nowMs: NOW_MS,
  });

  assert.equal(plan.mode, 'dry-run');
  assert.equal(plan.projectId, PROJECT_ID);
  assert.deepEqual(plan.authIdentityUids, ['approved', 'auth-only', 'unverified']);
  assert.equal(plan.authDeleteCount, 0);

  const approved = plan.actions.find(action => action.uid === 'approved');
  assert.deepEqual(approved?.account, {
    type: 'replace',
    record: {
      uid: 'approved',
      email: 'approved@example.com',
      active: true,
      accessEpoch: 7,
      createdAtMs: 123,
      updatedAtMs: NOW_MS,
    },
  });
  assert.deepEqual(approved?.claims, { type: 'replace', claims: { unrelated: 'keep', privatePro: true, privateProEpoch: 7 } });
  assert.equal(approved?.revokeRefreshTokens, true);
  assert.deepEqual(approved?.epochTransition, { from: 6, to: 7 });

  const authOnly = plan.actions.find(action => action.uid === 'auth-only');
  assert.equal(authOnly?.account.type, 'replace');
  assert.equal(authOnly?.account.type === 'replace' ? authOnly.account.record.createdAtMs : 0, NOW_MS);
  assert.deepEqual(authOnly?.epochTransition, { from: 0, to: 1 });

  const unverified = plan.actions.find(action => action.uid === 'unverified');
  assert.deepEqual(unverified?.account, { type: 'delete' });
  assert.deepEqual(unverified?.claims, { type: 'replace', claims: { unrelated: 7 } });
  assert.equal(unverified?.revokeRefreshTokens, true);

  const orphan = plan.actions.find(action => action.uid === 'orphan');
  assert.deepEqual(orphan?.account, { type: 'delete' });
  assert.deepEqual(orphan?.claims, { type: 'none' });
  assert.equal(orphan?.revokeRefreshTokens, false);

  for (const action of plan.actions) {
    assert.deepEqual(action.firestoreTargets, [
      { kind: 'collection', path: `users/${action.uid}/vault` },
      { kind: 'collection', path: `users/${action.uid}/chats` },
      { kind: 'collection', path: `users/${action.uid}/personas` },
      { kind: 'collection', path: `users/${action.uid}/tombstones` },
      { kind: 'collection', path: `users/${action.uid}/assets` },
      { kind: 'collection', path: `users/${action.uid}/chatUploads` },
      { kind: 'collection', path: `users/${action.uid}/quotaReservations` },
      { kind: 'collection', path: `users/${action.uid}/uploadRateWindows` },
      { kind: 'collection', path: `users/${action.uid}/legacyCleanupLocators` },
      { kind: 'collection', path: `users/${action.uid}/legacyCleanupReceipts` },
      { kind: 'document', path: `users/${action.uid}/workspaces/v1` },
    ]);
    assert.deepEqual(action.storagePrefixes, [
      `users/${action.uid}/vault/`,
      `users/${action.uid}/assets/`,
      `users/${action.uid}/chatUploads/`,
      `users/${action.uid}/workspace-v1/`,
    ]);
  }
});

test('normalizes allowlist matching and uses only valid epochs and creation times', () => {
  const plan = buildPrivateProResetPlan({
    projectId: PROJECT_ID,
    execute: false,
    authIdentities: [{
      uid: 'uid-a',
      email: 'USER@EXAMPLE.COM',
      emailVerified: true,
      claims: { privateProEpoch: 8.5 },
    }],
    accountDocuments: [{
      uid: 'uid-a',
      exists: true,
      data: { accessEpoch: -1, createdAtMs: Number.NaN },
    }],
    allowedEmails: new Set([' user@example.com ']),
    nowMs: NOW_MS,
  });

  const action = plan.actions[0];
  assert.equal(action.account.type, 'replace');
  if (action.account.type !== 'replace') assert.fail('Expected account replacement.');
  assert.equal(action.account.record.accessEpoch, 1);
  assert.equal(action.account.record.createdAtMs, NOW_MS);
});

test('defaults to dry run and enforces the exact destructive execution gate', () => {
  assert.deepEqual(parsePrivateProResetArguments([], PROJECT_ID), { execute: false, confirm: undefined });
  assert.deepEqual(parsePrivateProResetArguments(['--execute', '--confirm', PROJECT_ID], PROJECT_ID), { execute: true, confirm: PROJECT_ID });
  assert.throws(() => parsePrivateProResetArguments(['--execute'], PROJECT_ID), /--confirm/);
  assert.throws(() => parsePrivateProResetArguments(['--confirm', PROJECT_ID], PROJECT_ID), /--execute/);
  assert.throws(() => parsePrivateProResetArguments(['--execute', '--confirm', 'other-project'], PROJECT_ID), /exact project ID/);
  assert.throws(() => parsePrivateProResetArguments(['--execute', '--confirm', PROJECT_ID, '--unknown'], PROJECT_ID), /Unknown argument/);

  const base = {
    projectId: PROJECT_ID,
    authIdentities: [],
    accountDocuments: [],
    nowMs: NOW_MS,
  };
  assert.throws(() => buildPrivateProResetPlan({
    ...base,
    execute: true,
    confirm: PROJECT_ID,
    allowedEmails: new Set<string>(),
  }), /allowlist is empty/);
  assert.doesNotThrow(() => buildPrivateProResetPlan({
    ...base,
    execute: false,
    allowedEmails: new Set<string>(),
  }));
});
