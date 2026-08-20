import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertPrivateProResetBucketBinding,
  buildPrivateProResetPlan,
  createPrivateProResetLeaseController,
  executePrivateProResetActions,
  parsePrivateProResetArguments,
  parsePrivateProResetOperation,
  parsePrivateProResetTarget,
  runPrivateProResetConvergence,
  assertPrivateProResetExecutorLease,
  verifyPrivateProResetBucketBeforeInspection,
  type PrivateProResetOperation,
} from './reset-workspaces';


const PROJECT_ID = 'sample-project';
const NOW_MS = 1_800_000_000_000;

class FakeLeaseClock {
  nowMs: number;
  private nextTimerId = 1;
  private readonly timers = new Map<number, { atMs: number; callback: () => Promise<void> }>();

  constructor(nowMs: number) {
    this.nowMs = nowMs;
  }

  readonly schedule = (callback: () => Promise<void>, delayMs: number): number => {
    const id = this.nextTimerId++;
    this.timers.set(id, { atMs: this.nowMs + delayMs, callback });
    return id;
  };

  readonly cancel = (timer: unknown): void => {
    if (typeof timer === 'number') this.timers.delete(timer);
  };

  async advance(milliseconds: number): Promise<void> {
    const targetMs = this.nowMs + milliseconds;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.atMs <= targetMs)
        .sort((left, right) => left[1].atMs - right[1].atMs)[0];
      if (!due) break;
      const [id, timer] = due;
      this.timers.delete(id);
      this.nowMs = timer.atMs;
      await timer.callback();
    }
    this.nowMs = targetMs;
  }

  jump(milliseconds: number): void {
    this.nowMs += milliseconds;
  }

  startNextTimer(): void {
    const next = [...this.timers.entries()].sort((left, right) => left[1].atMs - right[1].atMs)[0];
    if (!next) throw new Error('Expected a pending fake timer.');
    const [id, timer] = next;
    this.timers.delete(id);
    this.nowMs = timer.atMs;
    void timer.callback();
  }

  get pendingTimers(): number {
    return this.timers.size;
  }
}

function resetOperation(executorId: string, leaseExpiresAtMs: number): PrivateProResetOperation {
  return {
    operationId: 'workspace-v1',
    schemaVersion: 1,
    revision: 1,
    projectId: PROJECT_ID,
    state: 'running',
    startedAtMs: 1,
    executorId,
    leaseExpiresAtMs,
  };
}

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

test('normalizes allowlist matching and rejects invalid epochs', () => {
  assert.throws(() => buildPrivateProResetPlan({
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
  }), /epoch/i);
});

test('uses journal targets as the only authority for resumable epochs and phases', () => {
  const currentAccount = (accessEpoch: number) => ({
    uid: 'uid-a',
    email: 'user@example.com',
    active: true,
    accessEpoch,
    createdAtMs: 123,
    updatedAtMs: 456,
  });
  const planFor = (accountEpoch: number, claims: Record<string, unknown>, phase?: 'planned' | 'fenced' | 'cleaned' | 'complete') => buildPrivateProResetPlan({
    projectId: PROJECT_ID,
    execute: false,
    authIdentities: [{ uid: 'uid-a', email: 'user@example.com', emailVerified: true, claims }],
    accountDocuments: [{ uid: 'uid-a', exists: true, data: currentAccount(accountEpoch) }],
    allowedEmails: new Set(['user@example.com']),
    nowMs: NOW_MS,
    resetOperation: { operationId: 'workspace-v1', schemaVersion: 1, revision: 1, projectId: PROJECT_ID, state: 'running', startedAtMs: 100, executorId: 'executor-a', leaseExpiresAtMs: 200 },
    resetTargets: phase ? [{ uid: 'uid-a', approved: true, targetEpoch: 7, phase, updatedAtMs: 200 }] : [],
  }).actions[0];

  assert.deepEqual(planFor(6, { privatePro: true, privateProEpoch: 6 }, 'fenced').epochTransition, { from: 6, to: 7 });
  assert.equal(planFor(6, {}, 'fenced').journalPhase, 'fenced');
  assert.equal(planFor(6, {}, 'cleaned').journalPhase, 'cleaned');
  assert.equal(planFor(6, {}, 'complete').journalPhase, 'complete');
  assert.deepEqual(planFor(7, { privatePro: true, privateProEpoch: 7 }).epochTransition, { from: 7, to: 8 });
});

test('completed operation makes execute and dry-run plans no-op', () => {
  const plan = buildPrivateProResetPlan({
    projectId: PROJECT_ID,
    execute: true,
    confirm: PROJECT_ID,
    authIdentities: [{ uid: 'uid-a', email: 'user@example.com', emailVerified: true, claims: {} }],
    accountDocuments: [],
    allowedEmails: new Set(['user@example.com']),
    nowMs: NOW_MS,
    resetOperation: { operationId: 'workspace-v1', schemaVersion: 1, revision: 1, projectId: PROJECT_ID, state: 'complete', startedAtMs: 100, executorId: 'executor-a', leaseExpiresAtMs: 200 },
    resetTargets: [],
  });
  assert.equal(plan.alreadyComplete, true);
  assert.deepEqual(plan.actions, []);
});

test('excludes Auth-only identities that have no entitlement claims and are not approved', () => {
  const plan = buildPrivateProResetPlan({
    projectId: PROJECT_ID,
    execute: false,
    authIdentities: [
      { uid: 'irrelevant', email: 'other@example.com', emailVerified: true, claims: {} },
      { uid: 'claimed', email: 'old@example.com', emailVerified: false, claims: { privateProEpoch: 2 } },
      { uid: 'allowed', email: 'allowed@example.com', emailVerified: true, claims: {} },
    ],
    accountDocuments: [],
    allowedEmails: new Set(['allowed@example.com']),
    nowMs: NOW_MS,
  });
  assert.deepEqual(plan.actions.map(action => action.uid), ['allowed', 'claimed']);
  assert.deepEqual(plan.authIdentityUids, ['allowed', 'claimed', 'irrelevant']);
});

test('rejects malformed reset operation and target journal schemas', () => {
  assert.deepEqual(parsePrivateProResetOperation({ operationId: 'workspace-v1', schemaVersion: 1, revision: 1, projectId: PROJECT_ID, state: 'running', startedAtMs: 100, executorId: 'executor-a', leaseExpiresAtMs: 200 }), { operationId: 'workspace-v1', schemaVersion: 1, revision: 1, projectId: PROJECT_ID, state: 'running', startedAtMs: 100, executorId: 'executor-a', leaseExpiresAtMs: 200 });
  assert.deepEqual(parsePrivateProResetTarget({ uid: 'uid-a', approved: true, targetEpoch: 2, phase: 'planned', updatedAtMs: 100 }), { uid: 'uid-a', approved: true, targetEpoch: 2, phase: 'planned', updatedAtMs: 100 });
  assert.throws(() => parsePrivateProResetOperation({ operationId: 'workspace-v1', schemaVersion: 1, revision: 1, projectId: PROJECT_ID, state: 'running', startedAtMs: 100, executorId: 'executor-a', leaseExpiresAtMs: 200, extra: 'secret' }), /journal/i);
  assert.throws(() => parsePrivateProResetTarget({ uid: 'uid-a', approved: true, targetEpoch: 1.5, phase: 'planned', updatedAtMs: 100 }), /journal/i);
});

test('increments legacy state once and rejects unsafe epoch overflow', () => {
  const base = {
    projectId: PROJECT_ID,
    execute: false,
    authIdentities: [{ uid: 'uid-a', email: 'user@example.com', emailVerified: true, claims: { privatePro: true, privateProEpoch: 8 } }],
    allowedEmails: new Set(['user@example.com']),
    nowMs: NOW_MS,
  };
  const legacy = buildPrivateProResetPlan({
    ...base,
    accountDocuments: [{ uid: 'uid-a', exists: true, data: { active: true, accessEpoch: 9, createdAtMs: 123 } }],
  }).actions[0];
  assert.deepEqual(legacy.epochTransition, { from: 9, to: 10 });

  assert.throws(() => buildPrivateProResetPlan({
    ...base,
    authIdentities: [{ uid: 'uid-a', email: 'user@example.com', emailVerified: true, claims: { privateProEpoch: Number.MAX_SAFE_INTEGER } }],
    accountDocuments: [],
  }), /safe epoch/i);
  assert.throws(() => buildPrivateProResetPlan({
    ...base,
    authIdentities: [{ uid: 'uid-a', email: 'user@example.com', emailVerified: true, claims: { privateProEpoch: 1.5 } }],
    accountDocuments: [],
  }), /epoch/i);
  const resumedMaximum = buildPrivateProResetPlan({
    ...base,
    authIdentities: [{ uid: 'uid-a', email: 'user@example.com', emailVerified: true, claims: { privateProEpoch: Number.MAX_SAFE_INTEGER } }],
    accountDocuments: [],
    resetTargets: [{ uid: 'uid-a', approved: true, targetEpoch: Number.MAX_SAFE_INTEGER, phase: 'fenced', updatedAtMs: 100 }],
  }).actions[0];
  assert.equal(resumedMaximum.epochTransition?.to, Number.MAX_SAFE_INTEGER);
});

test('fences orphan accounts with a journaled target epoch', () => {
  const action = buildPrivateProResetPlan({
    projectId: PROJECT_ID,
    execute: true,
    confirm: PROJECT_ID,
    authIdentities: [],
    accountDocuments: [{ uid: 'orphan', exists: true, data: { email: 'old@example.com', accessEpoch: 4, createdAtMs: 123 } }],
    allowedEmails: new Set(['allowed@example.com']),
    nowMs: NOW_MS,
    resetTargets: [{ uid: 'orphan', approved: false, targetEpoch: 5, phase: 'planned', updatedAtMs: 100 }],
  }).actions[0];
  assert.deepEqual(action.fenceAccount, { uid: 'orphan', email: 'old@example.com', active: false, accessEpoch: 5, createdAtMs: 123, updatedAtMs: NOW_MS });
  assert.deepEqual(action.claims, { type: 'none' });
});

test('keeps a cleaned orphan journal target in the resume plan after its account is gone', () => {
  const plan = buildPrivateProResetPlan({
    projectId: PROJECT_ID,
    execute: true,
    confirm: PROJECT_ID,
    authIdentities: [],
    accountDocuments: [],
    allowedEmails: new Set(['allowed@example.com']),
    nowMs: NOW_MS,
    resetOperation: { operationId: 'workspace-v1', schemaVersion: 1, revision: 1, projectId: PROJECT_ID, state: 'running', startedAtMs: 100, executorId: 'executor-a', leaseExpiresAtMs: 200 },
    resetTargets: [{ uid: 'orphan', approved: false, targetEpoch: 5, phase: 'cleaned', updatedAtMs: 100 }],
  });
  assert.equal(plan.actions[0].uid, 'orphan');
  assert.equal(plan.actions[0].journalPhase, 'cleaned');
  assert.deepEqual(plan.actions[0].account, { type: 'delete' });
});

test('binds the configured bucket to the confirmed numeric project before inspection', async () => {
  assert.doesNotThrow(() => assertPrivateProResetBucketBinding({
    configuredBucket: 'sample-project.firebasestorage.app',
    actualBucketName: 'sample-project.firebasestorage.app',
    bucketProjectNumber: '123456789012',
    confirmedProjectNumber: '123456789012',
  }));
  assert.throws(() => assertPrivateProResetBucketBinding({
    configuredBucket: 'sample-project.firebasestorage.app',
    actualBucketName: 'other-project.firebasestorage.app',
    bucketProjectNumber: '123456789012',
    confirmedProjectNumber: '123456789012',
  }), /bucket name/i);
  assert.throws(() => assertPrivateProResetBucketBinding({
    configuredBucket: 'sample-project.firebasestorage.app',
    actualBucketName: 'sample-project.firebasestorage.app',
    bucketProjectNumber: '999999999999',
    confirmedProjectNumber: '123456789012',
  }), /project number/i);

  const calls: string[] = [];
  await verifyPrivateProResetBucketBeforeInspection({
    projectId: PROJECT_ID,
    configuredBucket: 'sample-project.firebasestorage.app',
    readConfirmedProjectNumber: async () => { calls.push('project'); return '123456789012'; },
    readBucketMetadata: async () => { calls.push('bucket'); return { name: 'sample-project.firebasestorage.app', projectNumber: '123456789012' }; },
    inspect: async () => { calls.push('inspect'); },
  });
  assert.deepEqual(calls, ['project', 'bucket', 'inspect']);
});

test('stops execution after one sanitized per-UID failure result', async () => {
  const plan = buildPrivateProResetPlan({
    projectId: PROJECT_ID,
    execute: true,
    confirm: PROJECT_ID,
    authIdentities: [
      { uid: 'uid-a', email: 'a@example.com', emailVerified: true, claims: {} },
      { uid: 'uid-b', email: 'b@example.com', emailVerified: true, claims: {} },
    ],
    accountDocuments: [],
    allowedEmails: new Set(['a@example.com', 'b@example.com']),
    nowMs: NOW_MS,
  });
  const calls: string[] = [];
  const results: unknown[] = [];
  await assert.rejects(() => executePrivateProResetActions(plan.actions, {
    assertLease: async () => undefined,
    inspect: async action => ({ uid: action.uid, documentCount: 3, objectCount: 4, epochTransition: action.epochTransition }),
    fenceAccount: async () => undefined,
    fenceClaims: async () => undefined,
    revokeFenceTokens: async () => undefined,
    cleanupFirestore: async action => { calls.push(action.uid); throw new Error('secret payload'); },
    cleanupStorage: async () => assert.fail('Storage must not run after Firestore failure.'),
    applyFinalAccount: async () => assert.fail('Account must not run after cleanup failure.'),
    applyFinalClaims: async () => assert.fail('Claims must not run after cleanup failure.'),
    revokeFinalTokens: async () => assert.fail('Revoke must not run after cleanup failure.'),
    persistPhase: async () => undefined,
    emit: result => { results.push(result); },
  }), /reset failed/i);
  assert.deepEqual(calls, ['uid-a']);
  assert.deepEqual(results, [{
    uid: 'uid-a',
    documentCount: 3,
    objectCount: 4,
    epochTransition: { from: 0, to: 1 },
    stage: 'firestore-cleanup',
    success: false,
    errorCode: 'FIRESTORE_CLEANUP_FAILED',
  }]);
  assert.doesNotMatch(JSON.stringify(results), /secret payload/);
});

test('fences access before cleanup and restores the same fixed epoch', async () => {
  const action = buildPrivateProResetPlan({
    projectId: PROJECT_ID,
    execute: true,
    confirm: PROJECT_ID,
    authIdentities: [{ uid: 'uid-a', email: 'a@example.com', emailVerified: true, claims: { privatePro: true, privateProEpoch: 4 } }],
    accountDocuments: [{ uid: 'uid-a', exists: true, data: { active: true, accessEpoch: 4, createdAtMs: 123 } }],
    allowedEmails: new Set(['a@example.com']),
    nowMs: NOW_MS,
  }).actions[0];
  const order: string[] = [];
  await executePrivateProResetActions([action], {
    assertLease: async () => undefined,
    inspect: async input => ({ uid: input.uid, documentCount: 0, objectCount: 0, epochTransition: input.epochTransition }),
    fenceAccount: async input => { order.push(`fence-account:${input.epochTransition?.to}`); },
    fenceClaims: async () => { order.push('fence-claims'); },
    revokeFenceTokens: async () => { order.push('fence-tokens'); },
    cleanupFirestore: async () => { order.push('firestore'); assert.deepEqual(order.slice(0, 3), [`fence-account:${action.epochTransition?.to}`, 'fence-claims', 'fence-tokens']); },
    cleanupStorage: async () => { order.push('storage'); },
    applyFinalAccount: async input => { order.push(`final-account:${input.epochTransition?.to}`); },
    applyFinalClaims: async input => { order.push(`final-claims:${input.epochTransition?.to}`); },
    revokeFinalTokens: async () => { order.push('final-tokens'); },
    persistPhase: async (_input, phase) => { order.push(`phase:${phase}`); },
    emit: () => undefined,
  });
  assert.deepEqual(order, [`fence-account:${action.epochTransition?.to}`, 'fence-claims', 'fence-tokens', 'phase:fenced', 'firestore', 'storage', 'phase:cleaned', `final-account:${action.epochTransition?.to}`, `final-claims:${action.epochTransition?.to}`, 'final-tokens', 'phase:complete']);
});

test('persists journal phases and resumes without repeating completed phases', async () => {
  const action = buildPrivateProResetPlan({
    projectId: PROJECT_ID,
    execute: true,
    confirm: PROJECT_ID,
    authIdentities: [{ uid: 'uid-a', email: 'a@example.com', emailVerified: true, claims: {} }],
    accountDocuments: [],
    allowedEmails: new Set(['a@example.com']),
    nowMs: NOW_MS,
    resetTargets: [{ uid: 'uid-a', approved: true, targetEpoch: 7, phase: 'cleaned', updatedAtMs: 100 }],
  }).actions[0];
  const calls: string[] = [];
  await executePrivateProResetActions([action], {
    assertLease: async () => undefined,
    inspect: async input => ({ uid: input.uid, documentCount: 0, objectCount: 0, epochTransition: input.epochTransition }),
    fenceAccount: async () => { calls.push('fence'); },
    fenceClaims: async () => { calls.push('fence-claims'); },
    revokeFenceTokens: async () => { calls.push('fence-tokens'); },
    cleanupFirestore: async () => { calls.push('firestore'); },
    cleanupStorage: async () => { calls.push('storage'); },
    applyFinalAccount: async () => { calls.push('final-account'); },
    applyFinalClaims: async () => { calls.push('final-claims'); },
    revokeFinalTokens: async () => { calls.push('final-tokens'); },
    persistPhase: async (_input, phase) => { calls.push(`phase:${phase}`); },
    emit: () => undefined,
  });
  assert.deepEqual(calls, ['final-account', 'final-claims', 'final-tokens', 'phase:complete']);
});

test('asserts a live lease before every claimed executable mutation boundary', async () => {
  const actions = buildPrivateProResetPlan({
    projectId: PROJECT_ID,
    execute: true,
    confirm: PROJECT_ID,
    authIdentities: [
      { uid: 'uid-auth', email: 'auth@example.com', emailVerified: true, claims: { privatePro: true, privateProEpoch: 1 } },
    ],
    accountDocuments: [
      { uid: 'uid-auth', exists: true, data: { active: true, accessEpoch: 1 } },
      { uid: 'uid-orphan', exists: true, data: { active: true, accessEpoch: 1 } },
    ],
    allowedEmails: new Set(['auth@example.com']),
    nowMs: NOW_MS,
  }).actions;
  const leaseAssertions: string[] = [];
  const mutations: string[] = [];

  await executePrivateProResetActions(actions, {
    assertLease: async boundary => { leaseAssertions.push(boundary); },
    inspect: async action => ({ uid: action.uid, documentCount: 0, objectCount: 0, epochTransition: action.epochTransition }),
    fenceAccount: async action => { mutations.push(`fence-account:${action.uid}`); },
    fenceClaims: async action => { mutations.push(`fence-claims:${action.uid}`); },
    revokeFenceTokens: async action => { mutations.push(`fence-tokens:${action.uid}`); },
    cleanupFirestore: async (action, assertLease) => {
      await assertLease(`firestore-delete:${action.uid}`);
      mutations.push(`firestore:${action.uid}`);
    },
    cleanupStorage: async (action, assertLease) => {
      await assertLease(`storage-prefix:${action.uid}`);
      mutations.push(`storage:${action.uid}`);
    },
    applyFinalAccount: async action => { mutations.push(`final-account:${action.uid}`); },
    applyFinalClaims: async action => { mutations.push(`final-claims:${action.uid}`); },
    revokeFinalTokens: async action => { mutations.push(`final-tokens:${action.uid}`); },
    persistPhase: async (action, phase) => { mutations.push(`phase-${phase}:${action.uid}`); },
    emit: () => undefined,
  });

  assert.deepEqual(mutations, [
    'fence-account:uid-auth', 'fence-claims:uid-auth', 'fence-tokens:uid-auth', 'phase-fenced:uid-auth',
    'firestore:uid-auth', 'storage:uid-auth', 'phase-cleaned:uid-auth',
    'final-account:uid-auth', 'final-claims:uid-auth', 'final-tokens:uid-auth', 'phase-complete:uid-auth',
    'fence-account:uid-orphan', 'phase-fenced:uid-orphan',
    'firestore:uid-orphan', 'storage:uid-orphan', 'phase-cleaned:uid-orphan',
    'final-account:uid-orphan', 'phase-complete:uid-orphan',
  ]);
  assert.deepEqual(leaseAssertions, [
    'fence-account', 'fence-claims', 'fence-tokens', 'persist-phase:fenced',
    'firestore-cleanup', 'firestore-delete:uid-auth', 'storage-cleanup', 'storage-prefix:uid-auth', 'persist-phase:cleaned',
    'final-account', 'final-claims', 'final-tokens', 'persist-phase:complete',
    'fence-account', 'persist-phase:fenced',
    'firestore-cleanup', 'firestore-delete:uid-orphan', 'storage-cleanup', 'storage-prefix:uid-orphan', 'persist-phase:cleaned',
    'final-account', 'persist-phase:complete',
  ]);
});

test('lease renewal keeps a long reset alive and every destructive boundary asserts ownership', async () => {
  const clock = new FakeLeaseClock(1_000);
  let operation = resetOperation('executor-a', 61_000);
  let renewals = 0;
  const boundaries: string[] = [];
  const controller = createPrivateProResetLeaseController({
    projectId: PROJECT_ID,
    executorId: 'executor-a',
    leaseMs: 60_000,
    renewEveryMs: 20_000,
    now: () => clock.nowMs,
    schedule: clock.schedule,
    cancel: clock.cancel,
    renew: async input => {
      assert.equal(input.operation.state, 'running');
      renewals++;
      operation = resetOperation(input.executorId, input.nowMs + input.leaseMs);
      return operation;
    },
    assertOwned: async input => {
      assert.equal(input.operation, operation);
      assert.equal(input.nowMs, clock.nowMs);
      if (operation.executorId !== input.executorId || operation.leaseExpiresAtMs <= input.nowMs) throw new Error('lease lost');
      boundaries.push(input.boundary);
      return operation;
    },
  }, operation);
  const action = buildPrivateProResetPlan({
    projectId: PROJECT_ID,
    execute: true,
    confirm: PROJECT_ID,
    authIdentities: [{ uid: 'uid-a', email: 'a@example.com', emailVerified: true, claims: {} }],
    accountDocuments: [],
    allowedEmails: new Set(['a@example.com']),
    nowMs: NOW_MS,
  }).actions[0];
  const mutate = async () => { await clock.advance(12_000); };

  try {
    await executePrivateProResetActions([action], {
      assertLease: controller.assertLease,
      inspect: async input => ({ uid: input.uid, documentCount: 1, objectCount: 1, epochTransition: input.epochTransition }),
      fenceAccount: mutate,
      fenceClaims: mutate,
      revokeFenceTokens: mutate,
      cleanupFirestore: async (_input, assertLease) => {
        for (const target of action.firestoreTargets) {
          await assertLease(`firestore-delete:${target.path}`);
          await mutate();
        }
      },
      cleanupStorage: async (_input, assertLease) => {
        for (const prefix of action.storagePrefixes) {
          await assertLease(`storage-prefix:${prefix}`);
          await mutate();
        }
      },
      applyFinalAccount: mutate,
      applyFinalClaims: mutate,
      revokeFinalTokens: mutate,
      persistPhase: mutate,
      emit: () => undefined,
    });
    await controller.assertLease('mark-complete');
  } finally {
    controller.stop();
  }

  assert.ok(renewals >= 8, `expected renewals during the full run, received ${renewals}`);
  assert.equal(clock.pendingTimers, 0);
  assert.deepEqual(boundaries.slice(0, 4), ['fence-account', 'fence-claims', 'fence-tokens', 'persist-phase:fenced']);
  assert.ok(boundaries.includes(`firestore-delete:${action.firestoreTargets[0].path}`));
  assert.ok(boundaries.includes(`storage-prefix:${action.storagePrefixes[0]}`));
  assert.deepEqual(boundaries.slice(-4), ['final-claims', 'final-tokens', 'persist-phase:complete', 'mark-complete']);
});

test('an expired stalled renewal aborts the lease and prevents later reset mutation', async () => {
  const clock = new FakeLeaseClock(1_000);
  const operation = resetOperation('executor-a', 61_000);
  const controller = createPrivateProResetLeaseController({
    projectId: PROJECT_ID,
    executorId: 'executor-a',
    leaseMs: 60_000,
    renewEveryMs: 20_000,
    now: () => clock.nowMs,
    schedule: clock.schedule,
    cancel: clock.cancel,
    renew: async () => new Promise<PrivateProResetOperation>(() => undefined),
    assertOwned: async input => {
      if (input.operation.leaseExpiresAtMs <= input.nowMs) throw new Error('lease expired');
      return input.operation;
    },
  }, operation);
  let laterMutations = 0;

  try {
    clock.startNextTimer();
    clock.jump(40_000);
    await assert.rejects(() => controller.assertLease('final-account'), /lease/i);
    if (!controller.aborted) laterMutations++;
  } finally {
    controller.stop();
  }

  assert.equal(controller.aborted, true);
  assert.equal(laterMutations, 0);
  assert.equal(clock.pendingTimers, 0);
});

test('a renewal rejection aborts before the next reset mutation', async () => {
  const clock = new FakeLeaseClock(1_000);
  const operation = resetOperation('executor-a', 61_000);
  const controller = createPrivateProResetLeaseController({
    projectId: PROJECT_ID,
    executorId: 'executor-a',
    leaseMs: 60_000,
    renewEveryMs: 20_000,
    now: () => clock.nowMs,
    schedule: clock.schedule,
    cancel: clock.cancel,
    renew: async () => { throw new Error('renewal failed'); },
    assertOwned: async input => input.operation,
  }, operation);
  let laterMutations = 0;

  try {
    await clock.advance(20_000);
    await assert.rejects(() => controller.assertLease('fence-claims'), /renewal failed/i);
    if (!controller.aborted) laterMutations++;
  } finally {
    controller.stop();
  }

  assert.equal(controller.aborted, true);
  assert.equal(laterMutations, 0);
  assert.equal(clock.pendingTimers, 0);
});

test('a second executor takeover prevents the original executor from continuing', async () => {
  const clock = new FakeLeaseClock(1_000);
  let operation = resetOperation('executor-a', 61_000);
  const controller = createPrivateProResetLeaseController({
    projectId: PROJECT_ID,
    executorId: 'executor-a',
    leaseMs: 60_000,
    renewEveryMs: 20_000,
    now: () => clock.nowMs,
    schedule: clock.schedule,
    cancel: clock.cancel,
    renew: async input => {
      if (operation.executorId !== input.executorId) throw new Error('lease taken over');
      operation = resetOperation(input.executorId, input.nowMs + input.leaseMs);
      return operation;
    },
    assertOwned: async input => {
      if (operation.executorId !== input.executorId) throw new Error('lease taken over');
      return operation;
    },
  }, operation);

  try {
    operation = resetOperation('executor-b', 90_000);
    await assert.rejects(() => controller.assertLease('fence-account'), /lease/i);
    await assert.rejects(() => controller.assertLease('fence-claims'), /lease/i);
  } finally {
    controller.stop();
  }

  assert.equal(controller.aborted, true);
});

test('convergence requires two consecutive identical complete passes and resets on incomplete or changed inventory', async () => {
  const passes = [
    { relevantUids: ['uid-a'], targetUids: ['uid-a'], incompleteTargets: 1 },
    { relevantUids: ['uid-a'], targetUids: ['uid-a'], incompleteTargets: 0 },
    { relevantUids: ['uid-a', 'uid-b'], targetUids: ['uid-a', 'uid-b'], incompleteTargets: 0 },
    { relevantUids: ['uid-a', 'uid-b'], targetUids: ['uid-a', 'uid-b'], incompleteTargets: 0 },
  ];
  let completed = 0;
  let passCount = 0;
  await runPrivateProResetConvergence({
    runPass: async () => { passCount++; return passes.shift()!; },
    assertLease: async () => undefined,
    markComplete: async () => { completed++; },
  });
  assert.equal(completed, 1);
  assert.equal(passCount, 4);

  const incompleteThenComplete = [
    { relevantUids: ['uid-a'], targetUids: ['uid-a'], incompleteTargets: 1 },
    { relevantUids: ['uid-a'], targetUids: ['uid-a'], incompleteTargets: 0 },
    { relevantUids: ['uid-a'], targetUids: ['uid-a'], incompleteTargets: 0 },
  ];
  passCount = 0;
  await runPrivateProResetConvergence({
    runPass: async () => { passCount++; return incompleteThenComplete.shift()!; },
    assertLease: async () => undefined,
    markComplete: async () => undefined,
  });
  assert.equal(passCount, 3);

  await assert.rejects(() => runPrivateProResetConvergence({
    runPass: async () => ({ relevantUids: ['uid-a'], targetUids: ['uid-a'], incompleteTargets: 1 }),
    assertLease: async () => undefined,
    markComplete: async () => assert.fail('Incomplete target must prevent completion.'),
  }, 2), /converge/i);
});

test('rejects a concurrent unexpired reset executor lease', () => {
  const operation = { operationId: 'workspace-v1', schemaVersion: 1, revision: 1, projectId: PROJECT_ID, state: 'running', startedAtMs: 100, executorId: 'executor-a', leaseExpiresAtMs: 1_000 } as const;
  assert.throws(() => assertPrivateProResetExecutorLease(operation, 'executor-b', 500), /already running/i);
  assert.doesNotThrow(() => assertPrivateProResetExecutorLease(operation, 'executor-a', 500));
  assert.doesNotThrow(() => assertPrivateProResetExecutorLease(operation, 'executor-b', 1_001));
});

test('defaults to dry run and enforces the exact destructive execution gate', () => {
  assert.deepEqual(parsePrivateProResetArguments([], PROJECT_ID), { execute: false, confirm: undefined });
  assert.deepEqual(parsePrivateProResetArguments(['--execute', '--confirm', PROJECT_ID], PROJECT_ID), { execute: true, confirm: PROJECT_ID });
  assert.throws(() => parsePrivateProResetArguments(['--execute'], PROJECT_ID), /--confirm/);
  assert.throws(() => parsePrivateProResetArguments(['--confirm', PROJECT_ID], PROJECT_ID), /--execute/);
  assert.throws(() => parsePrivateProResetArguments(['--execute', '--confirm', 'other-project'], PROJECT_ID), /exact project ID/);
  assert.throws(() => parsePrivateProResetArguments(['--execute', '--confirm', PROJECT_ID, '--secret-token'], PROJECT_ID), error => {
    assert.match(String(error), /invalid reset arguments/i);
    assert.doesNotMatch(String(error), /secret-token/);
    return true;
  });

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
