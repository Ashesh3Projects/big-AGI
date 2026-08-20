import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

import type { Bucket } from '@google-cloud/storage';


const FIRESTORE_TARGETS = [
  ['collection', 'vault'],
  ['collection', 'chats'],
  ['collection', 'personas'],
  ['collection', 'tombstones'],
  ['collection', 'assets'],
  ['collection', 'chatUploads'],
  ['collection', 'quotaReservations'],
  ['collection', 'uploadRateWindows'],
  ['collection', 'legacyCleanupLocators'],
  ['collection', 'legacyCleanupReceipts'],
  ['document', 'workspaces/v1'],
] as const;

const STORAGE_PREFIXES = ['vault/', 'assets/', 'chatUploads/', 'workspace-v1/'] as const;
const PAGE_SIZE = 500;
const DELETE_CONCURRENCY = 10;
export const PRIVATE_PRO_WORKSPACE_RESET_REVISION = 1;
const RESET_OPERATION_PATH = `privateProOperations/workspaceV1Reset-v${PRIVATE_PRO_WORKSPACE_RESET_REVISION}`;

export interface PrivateProResetAuthIdentity {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  claims: Readonly<Record<string, unknown>>;
}

export interface PrivateProResetAccountDocument {
  uid: string;
  exists: boolean;
  data: Readonly<Record<string, unknown>> | undefined;
}

export interface PrivateProResetPlanInput {
  projectId: string;
  execute: boolean;
  confirm?: string;
  authIdentities: readonly PrivateProResetAuthIdentity[];
  accountDocuments: readonly PrivateProResetAccountDocument[];
  allowedEmails: ReadonlySet<string>;
  nowMs: number;
  resetOperation?: PrivateProResetOperation;
  resetTargets?: readonly PrivateProResetJournalTarget[];
}

export interface PrivateProAccountRecord {
  uid: string;
  email: string;
  active: true;
  accessEpoch: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PrivateProAccountFenceRecord extends Omit<PrivateProAccountRecord, 'active'> {
  active: false;
}

export interface PrivateProResetTarget {
  kind: 'document' | 'collection';
  path: string;
}

export interface PrivateProResetAction {
  uid: string;
  approved: boolean;
  firestoreTargets: PrivateProResetTarget[];
  storagePrefixes: string[];
  account: { type: 'replace'; record: PrivateProAccountRecord } | { type: 'delete' };
  fenceAccount?: PrivateProAccountFenceRecord;
  claims: { type: 'replace'; claims: Record<string, unknown> } | { type: 'none' };
  revokeRefreshTokens: boolean;
  epochTransition?: { from: number; to: number };
  journalPhase: PrivateProResetTargetPhase;
}

export interface PrivateProResetPlan {
  projectId: string;
  mode: 'dry-run' | 'execute';
  authIdentityUids: string[];
  authDeleteCount: 0;
  actions: PrivateProResetAction[];
  alreadyComplete: boolean;
}

export type PrivateProResetTargetPhase = 'planned' | 'fenced' | 'cleaned' | 'complete';

export interface PrivateProResetOperation {
  operationId: 'workspace-v1';
  schemaVersion: 1;
  revision: 1;
  projectId: string;
  state: 'running' | 'complete';
  startedAtMs: number;
  executorId: string;
  leaseExpiresAtMs: number;
}

export interface PrivateProResetJournalTarget {
  uid: string;
  approved: boolean;
  targetEpoch: number;
  phase: PrivateProResetTargetPhase;
  updatedAtMs: number;
}

export interface PrivateProResetArguments {
  execute: boolean;
  confirm: string | undefined;
}

export type PrivateProResetExecutionStage = 'inspect' | 'fence-account' | 'fence-claims' | 'fence-tokens' | 'firestore-cleanup' | 'storage-cleanup' | 'final-account' | 'final-claims' | 'final-tokens' | 'complete';
export type PrivateProResetErrorCode = 'INSPECTION_FAILED' | 'FENCE_ACCOUNT_FAILED' | 'FENCE_CLAIMS_FAILED' | 'FENCE_TOKEN_REVOCATION_FAILED' | 'FIRESTORE_CLEANUP_FAILED' | 'STORAGE_CLEANUP_FAILED' | 'FINAL_ACCOUNT_FAILED' | 'FINAL_CLAIMS_FAILED' | 'FINAL_TOKEN_REVOCATION_FAILED';

export interface PrivateProResetActionResult {
  uid: string;
  documentCount: number;
  objectCount: number;
  epochTransition?: { from: number; to: number };
  stage: PrivateProResetExecutionStage;
  success: boolean;
  errorCode?: PrivateProResetErrorCode;
}

export interface PrivateProResetExecutionPort {
  inspect(action: PrivateProResetAction): Promise<Pick<PrivateProResetActionResult, 'uid' | 'documentCount' | 'objectCount' | 'epochTransition'>>;
  fenceAccount(action: PrivateProResetAction): Promise<void>;
  fenceClaims(action: PrivateProResetAction): Promise<void>;
  revokeFenceTokens(action: PrivateProResetAction): Promise<void>;
  cleanupFirestore(action: PrivateProResetAction): Promise<void>;
  cleanupStorage(action: PrivateProResetAction): Promise<void>;
  applyFinalAccount(action: PrivateProResetAction): Promise<void>;
  applyFinalClaims(action: PrivateProResetAction): Promise<void>;
  revokeFinalTokens(action: PrivateProResetAction): Promise<void>;
  persistPhase(action: PrivateProResetAction, phase: PrivateProResetTargetPhase): Promise<void>;
  emit(result: PrivateProResetActionResult): void;
}

export interface PrivateProResetBucketBinding {
  configuredBucket: string;
  actualBucketName: string;
  bucketProjectNumber: string;
  confirmedProjectNumber: string;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function strictEpoch(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number') return 0;
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(value)) throw new Error('Private Pro epoch is invalid.');
  return value;
}

function validPositiveTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function resetTargetEpoch(input: {
  account: PrivateProResetAccountDocument | undefined;
  identity: PrivateProResetAuthIdentity;
  uid: string;
  email: string;
}): { maximumEpoch: number; targetEpoch: number } {
  const accountEpoch = strictEpoch(input.account?.data?.accessEpoch);
  const claimEpoch = strictEpoch(input.identity.claims.privateProEpoch);
  const maximumEpoch = Math.max(accountEpoch, claimEpoch, 0);
  return { maximumEpoch, targetEpoch: maximumEpoch >= Number.MAX_SAFE_INTEGER ? maximumEpoch : maximumEpoch + 1 };
}

function clearedPrivateProClaims(claims: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const next = { ...claims };
  delete next.privatePro;
  delete next.privateProEpoch;
  return next;
}

function cleanupTargets(uid: string): Pick<PrivateProResetAction, 'firestoreTargets' | 'storagePrefixes'> {
  return {
    firestoreTargets: FIRESTORE_TARGETS.map(([kind, suffix]) => ({ kind, path: `users/${uid}/${suffix}` })),
    storagePrefixes: STORAGE_PREFIXES.map(suffix => `users/${uid}/${suffix}`),
  };
}

export function parsePrivateProResetArguments(args: readonly string[], projectId: string): PrivateProResetArguments {
  let execute = false;
  let confirm: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--execute') {
      execute = true;
      continue;
    }
    if (argument === '--confirm') {
      confirm = args[++index];
      if (!confirm) throw new Error('--confirm requires the exact Firebase project ID.');
      continue;
    }
    throw new Error('Invalid reset arguments.');
  }
  if (execute && confirm !== projectId)
    throw new Error('Execution requires --confirm with the exact project ID.');
  if (!execute && confirm !== undefined)
    throw new Error('--confirm is valid only with --execute.');
  return { execute, confirm };
}

export function buildPrivateProResetPlan(input: PrivateProResetPlanInput): PrivateProResetPlan {
  if (!input.projectId.trim()) throw new Error('projectId is required.');
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs <= 0) throw new Error('nowMs must be a positive integer.');
  if (input.execute && input.confirm !== input.projectId)
    throw new Error('Execution requires confirmation with the exact project ID.');
  if (input.resetOperation?.projectId !== undefined && input.resetOperation.projectId !== input.projectId)
    throw new Error('Reset operation project mismatch.');
  if (input.resetOperation?.state === 'complete') return {
    projectId: input.projectId,
    mode: input.execute ? 'execute' : 'dry-run',
    authIdentityUids: input.authIdentities.map(identity => identity.uid).sort(),
    authDeleteCount: 0,
    actions: [],
    alreadyComplete: true,
  };

  const allowedEmails = new Set([...input.allowedEmails].map(normalizeEmail).filter(Boolean));
  if (input.execute && allowedEmails.size === 0) throw new Error('PRIVATE_PRO_ALLOWED_EMAILS allowlist is empty.');

  const authByUid = new Map(input.authIdentities.map(identity => [identity.uid, identity]));
  const accountByUid = new Map(input.accountDocuments.filter(account => account.exists).map(account => [account.uid, account]));
  const resetTargetByUid = new Map((input.resetTargets ?? []).map(target => [target.uid, target]));
  const relevantAuthUids = [...authByUid.values()].filter(identity => {
    const email = identity.email ? normalizeEmail(identity.email) : '';
    return identity.claims.privatePro === true
      || identity.claims.privateProEpoch !== undefined
      || (identity.emailVerified && email !== '' && allowedEmails.has(email));
  }).map(identity => identity.uid);
  const uids = [...new Set([...relevantAuthUids, ...accountByUid.keys(), ...resetTargetByUid.keys()])].sort();
  const actions = uids.map(uid => {
    const identity = authByUid.get(uid);
    const account = accountByUid.get(uid);
    const normalizedEmail = identity?.email ? normalizeEmail(identity.email) : '';
    const approved = !!identity && identity.emailVerified && normalizedEmail !== '' && allowedEmails.has(normalizedEmail);
    const journalTarget = resetTargetByUid.get(uid);
    if (journalTarget && journalTarget.approved !== approved) throw new Error('Reset target approval mismatch.');
    const targets = cleanupTargets(uid);

    if (!approved) return {
      uid,
      approved: false,
      ...targets,
      account: { type: 'delete' } as const,
      ...(() => {
        const maximumEpoch = Math.max(strictEpoch(account?.data?.accessEpoch), identity ? strictEpoch(identity.claims.privateProEpoch) : 0);
        const targetEpoch = journalTarget?.targetEpoch ?? (() => {
          if (maximumEpoch >= Number.MAX_SAFE_INTEGER) throw new Error('Private Pro reset cannot advance beyond the maximum safe epoch.');
          return maximumEpoch + 1;
        })();
        if (!Number.isSafeInteger(targetEpoch) || targetEpoch <= 0) throw new Error('Private Pro reset target epoch is invalid.');
        const createdAtMs = validPositiveTimestamp(account?.data?.createdAtMs, input.nowMs);
        const accountEmail = normalizedEmail || (typeof account?.data?.email === 'string' ? normalizeEmail(account.data.email) : '');
        return {
          fenceAccount: { uid, email: accountEmail, active: false as const, accessEpoch: targetEpoch, createdAtMs, updatedAtMs: input.nowMs },
          epochTransition: { from: maximumEpoch, to: targetEpoch },
          journalPhase: journalTarget?.phase ?? 'planned' as const,
        };
      })(),
      claims: identity
        ? { type: 'replace' as const, claims: clearedPrivateProClaims(identity.claims) }
        : { type: 'none' as const },
      revokeRefreshTokens: !!identity,
    };

    const computedEpoch = resetTargetEpoch({ account, identity, uid, email: normalizedEmail });
    const maximumEpoch = computedEpoch.maximumEpoch;
    if (!journalTarget && maximumEpoch >= Number.MAX_SAFE_INTEGER) throw new Error('Private Pro reset cannot advance beyond the maximum safe epoch.');
    const accessEpoch = journalTarget?.targetEpoch ?? computedEpoch.targetEpoch;
    if (!Number.isSafeInteger(accessEpoch) || accessEpoch <= 0) throw new Error('Private Pro reset target epoch is invalid.');
    return {
      uid,
      approved: true,
      ...targets,
      account: {
        type: 'replace' as const,
        record: {
          uid,
          email: normalizedEmail,
          active: true as const,
          accessEpoch,
          createdAtMs: validPositiveTimestamp(account?.data?.createdAtMs, input.nowMs),
          updatedAtMs: input.nowMs,
        },
      },
      fenceAccount: { uid, email: normalizedEmail, active: false as const, accessEpoch, createdAtMs: validPositiveTimestamp(account?.data?.createdAtMs, input.nowMs), updatedAtMs: input.nowMs },
      claims: {
        type: 'replace' as const,
        claims: { ...identity.claims, privatePro: true, privateProEpoch: accessEpoch },
      },
      revokeRefreshTokens: true,
      epochTransition: { from: maximumEpoch, to: accessEpoch },
      journalPhase: journalTarget?.phase ?? 'planned',
    };
  });

  return {
    projectId: input.projectId,
    mode: input.execute ? 'execute' : 'dry-run',
    authIdentityUids: [...authByUid.keys()].sort(),
    authDeleteCount: 0,
    actions,
    alreadyComplete: false,
  };
}

export function assertPrivateProResetBucketBinding(input: PrivateProResetBucketBinding): void {
  if (input.actualBucketName !== input.configuredBucket) throw new Error('Configured bucket name does not match bucket metadata.');
  if (!/^\d{6,20}$/.test(input.confirmedProjectNumber) || input.bucketProjectNumber !== input.confirmedProjectNumber)
    throw new Error('Configured bucket project number does not match the confirmed project.');
}

export async function verifyPrivateProResetBucketBeforeInspection(input: {
  projectId: string;
  configuredBucket: string;
  readConfirmedProjectNumber(): Promise<string>;
  readBucketMetadata(): Promise<{ name: string; projectNumber: string }>;
  inspect(): Promise<void>;
}): Promise<void> {
  const confirmedProjectNumber = await input.readConfirmedProjectNumber();
  const metadata = await input.readBucketMetadata();
  assertPrivateProResetBucketBinding({
    configuredBucket: input.configuredBucket,
    actualBucketName: metadata.name,
    bucketProjectNumber: metadata.projectNumber,
    confirmedProjectNumber,
  });
  await input.inspect();
}

const STAGE_ERRORS: Record<Exclude<PrivateProResetExecutionStage, 'complete'>, PrivateProResetErrorCode> = {
  inspect: 'INSPECTION_FAILED',
  'fence-account': 'FENCE_ACCOUNT_FAILED',
  'fence-claims': 'FENCE_CLAIMS_FAILED',
  'fence-tokens': 'FENCE_TOKEN_REVOCATION_FAILED',
  'firestore-cleanup': 'FIRESTORE_CLEANUP_FAILED',
  'storage-cleanup': 'STORAGE_CLEANUP_FAILED',
  'final-account': 'FINAL_ACCOUNT_FAILED',
  'final-claims': 'FINAL_CLAIMS_FAILED',
  'final-tokens': 'FINAL_TOKEN_REVOCATION_FAILED',
};

export async function executePrivateProResetActions(actions: readonly PrivateProResetAction[], port: PrivateProResetExecutionPort): Promise<void> {
  const phaseRank: Record<PrivateProResetTargetPhase, number> = { planned: 0, fenced: 1, cleaned: 2, complete: 3 };
  for (const action of actions) {
    let stage: Exclude<PrivateProResetExecutionStage, 'complete'> = 'inspect';
    let counts: Pick<PrivateProResetActionResult, 'uid' | 'documentCount' | 'objectCount' | 'epochTransition'> = {
      uid: action.uid,
      documentCount: 0,
      objectCount: 0,
      epochTransition: action.epochTransition,
    };
    try {
      counts = await port.inspect(action);
      if (phaseRank[action.journalPhase] < phaseRank.fenced) {
        stage = 'fence-account';
        await port.fenceAccount(action);
        stage = 'fence-claims';
        await port.fenceClaims(action);
        stage = 'fence-tokens';
        await port.revokeFenceTokens(action);
        await port.persistPhase(action, 'fenced');
      }
      if (phaseRank[action.journalPhase] < phaseRank.cleaned) {
        stage = 'firestore-cleanup';
        await port.cleanupFirestore(action);
        stage = 'storage-cleanup';
        await port.cleanupStorage(action);
        await port.persistPhase(action, 'cleaned');
      }
      if (phaseRank[action.journalPhase] < phaseRank.complete) {
        stage = 'final-account';
        await port.applyFinalAccount(action);
        stage = 'final-claims';
        await port.applyFinalClaims(action);
        stage = 'final-tokens';
        await port.revokeFinalTokens(action);
        await port.persistPhase(action, 'complete');
      }
      port.emit({ ...counts, stage: 'complete', success: true });
    } catch {
      port.emit({ ...counts, stage, success: false, errorCode: STAGE_ERRORS[stage] });
      throw new Error('Private Pro reset failed.');
    }
  }
}

export async function runPrivateProResetConvergence(port: {
  runPass(): Promise<{ relevantUids: readonly string[]; targetUids: readonly string[]; incompleteTargets: number }>;
  refreshLease(): Promise<void>;
  markComplete(): Promise<void>;
}, maxPasses = 8): Promise<void> {
  let previousSignature = '';
  for (let pass = 0; pass < maxPasses; pass++) {
    await port.refreshLease();
    const state = await port.runPass();
    const relevant = [...state.relevantUids].sort();
    const targets = [...state.targetUids].sort();
    const signature = JSON.stringify({ relevant, targets });
    const completeCoverage = state.incompleteTargets === 0
      && relevant.length === targets.length
      && relevant.every((uid, index) => uid === targets[index]);
    if (completeCoverage && signature === previousSignature) {
      await port.markComplete();
      return;
    }
    previousSignature = signature;
  }
  throw new Error('Private Pro reset did not converge.');
}

export function assertPrivateProResetExecutorLease(operation: PrivateProResetOperation, executorId: string, nowMs: number): void {
  if (operation.state === 'running' && operation.executorId !== executorId && operation.leaseExpiresAtMs > nowMs)
    throw new Error('Reset operation is already running.');
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function mapWithConcurrency<T>(values: readonly T[], concurrency: number, operation: (value: T) => Promise<void>): Promise<void> {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (index < values.length) {
      const value = values[index++];
      await operation(value);
    }
  }));
}

type AdminModules = Awaited<ReturnType<typeof loadAdminModules>>;

async function loadAdminModules() {
  const [{ cert, getApps, initializeApp }, { getAuth }, firestoreModule, { getStorage }] = await Promise.all([
    import('firebase-admin/app'),
    import('firebase-admin/auth'),
    import('firebase-admin/firestore'),
    import('firebase-admin/storage'),
  ]);
  return { cert, getApps, initializeApp, getAuth, getStorage, ...firestoreModule };
}

function initializeResetApp(admin: AdminModules, projectId: string, storageBucket: string) {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.trim();
  if (!!clientEmail !== !!privateKey) throw new Error('FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY must be set together.');
  return admin.getApps().find(app => app.name === 'private-pro-reset') ?? admin.initializeApp({
    ...(clientEmail && privateKey ? {
      credential: admin.cert({
        projectId,
        clientEmail,
        privateKey: privateKey.replaceAll('\\n', '\n'),
      }),
    } : {}),
    projectId,
    storageBucket,
  }, 'private-pro-reset');
}

async function collectInputs(admin: AdminModules, projectId: string, storageBucket: string, execute: boolean, nowMs: number, executorId: string) {
  const app = initializeResetApp(admin, projectId, storageBucket);
  const auth = admin.getAuth(app);
  const firestore = admin.getFirestore(app);
  const bucket = admin.getStorage(app).bucket(storageBucket);
  await verifyPrivateProResetBucketBeforeInspection({
    projectId,
    configuredBucket: storageBucket,
    readConfirmedProjectNumber: () => readConfirmedProjectNumber(projectId, app),
    readBucketMetadata: () => readBucketBindingMetadata(bucket),
    inspect: async () => undefined,
  });
  if (execute) await ensureResetOperation(firestore, projectId, nowMs, executorId);
  const operationSnapshot = await firestore.doc(RESET_OPERATION_PATH).get();
  const resetOperation = operationSnapshot.exists ? parsePrivateProResetOperation(operationSnapshot.data()) : undefined;
  const resetTargets = resetOperation
    ? (await firestore.collection(`${RESET_OPERATION_PATH}/targets`).get()).docs.map(document => parsePrivateProResetTarget(document.data()))
    : [];
  const authIdentities: PrivateProResetAuthIdentity[] = [];
  let authPageToken: string | undefined;
  do {
    const page = await auth.listUsers(1000, authPageToken);
    for (const user of page.users) authIdentities.push({
      uid: user.uid,
      email: user.email ?? null,
      emailVerified: user.emailVerified,
      claims: { ...user.customClaims },
    });
    authPageToken = page.pageToken;
  } while (authPageToken);

  const accountDocuments: PrivateProResetAccountDocument[] = [];
  let afterUid: string | undefined;
  do {
    let query = firestore.collection('users').orderBy(admin.FieldPath.documentId()).limit(PAGE_SIZE);
    if (afterUid) query = query.startAfter(afterUid);
    const page = await query.get();
    for (const document of page.docs) accountDocuments.push({ uid: document.id, exists: true, data: document.data() });
    afterUid = page.docs.at(-1)?.id;
    if (page.size < PAGE_SIZE) break;
  } while (afterUid);

  return { auth, firestore, bucket, authIdentities, accountDocuments, resetOperation, resetTargets };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function parsePrivateProResetOperation(value: unknown): PrivateProResetOperation {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  if (!exactKeys(record, ['operationId', 'schemaVersion', 'revision', 'projectId', 'state', 'startedAtMs', 'executorId', 'leaseExpiresAtMs'])
    || record.operationId !== 'workspace-v1'
    || record.schemaVersion !== 1
    || record.revision !== PRIVATE_PRO_WORKSPACE_RESET_REVISION
    || typeof record.projectId !== 'string'
    || !['running', 'complete'].includes(String(record.state))
    || typeof record.startedAtMs !== 'number'
    || !Number.isSafeInteger(record.startedAtMs)
    || record.startedAtMs <= 0
    || typeof record.executorId !== 'string'
    || record.executorId.length < 1
    || typeof record.leaseExpiresAtMs !== 'number'
    || !Number.isSafeInteger(record.leaseExpiresAtMs)) throw new Error('Reset operation journal is invalid.');
  return record as unknown as PrivateProResetOperation;
}

export function parsePrivateProResetTarget(value: unknown): PrivateProResetJournalTarget {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  if (!exactKeys(record, ['uid', 'approved', 'targetEpoch', 'phase', 'updatedAtMs'])
    || typeof record.uid !== 'string'
    || typeof record.approved !== 'boolean'
    || !Number.isSafeInteger(record.targetEpoch)
    || Number(record.targetEpoch) <= 0
    || !['planned', 'fenced', 'cleaned', 'complete'].includes(String(record.phase))
    || typeof record.updatedAtMs !== 'number'
    || !Number.isSafeInteger(record.updatedAtMs)
    || record.updatedAtMs <= 0) throw new Error('Reset target journal is invalid.');
  return record as unknown as PrivateProResetJournalTarget;
}

async function ensureResetOperation(firestore: FirebaseFirestore.Firestore, projectId: string, nowMs: number, executorId: string): Promise<PrivateProResetOperation> {
  const reference = firestore.doc(RESET_OPERATION_PATH);
  return firestore.runTransaction(async transaction => {
    const snapshot = await transaction.get(reference);
    if (snapshot.exists) {
      const operation = parsePrivateProResetOperation(snapshot.data());
      if (operation.projectId !== projectId) throw new Error('Reset operation project mismatch.');
      assertPrivateProResetExecutorLease(operation, executorId, nowMs);
      if (operation.state === 'running') {
        transaction.update(reference, { executorId, leaseExpiresAtMs: nowMs + 60_000 });
        return { ...operation, executorId, leaseExpiresAtMs: nowMs + 60_000 };
      }
      return operation;
    }
    const operation: PrivateProResetOperation = { operationId: 'workspace-v1', schemaVersion: 1, revision: PRIVATE_PRO_WORKSPACE_RESET_REVISION, projectId, state: 'running', startedAtMs: nowMs, executorId, leaseExpiresAtMs: nowMs + 60_000 };
    transaction.create(reference, operation);
    return operation;
  });
}

async function ensureResetTargets(firestore: FirebaseFirestore.Firestore, actions: readonly PrivateProResetAction[], nowMs: number): Promise<void> {
  for (const action of actions) {
    await firestore.runTransaction(async transaction => {
      const reference = firestore.doc(`${RESET_OPERATION_PATH}/targets/${action.uid}`);
      const snapshot = await transaction.get(reference);
      if (snapshot.exists) {
        parsePrivateProResetTarget(snapshot.data());
        return;
      }
      transaction.create(reference, {
        uid: action.uid,
        approved: action.approved,
        targetEpoch: action.epochTransition?.to ?? (() => { throw new Error('Reset target epoch is missing.'); })(),
        phase: 'planned',
        updatedAtMs: nowMs,
      } satisfies PrivateProResetJournalTarget);
    });
  }
}

async function persistResetPhase(firestore: FirebaseFirestore.Firestore, action: PrivateProResetAction, phase: PrivateProResetTargetPhase, nowMs: number): Promise<void> {
  const ranks: Record<PrivateProResetTargetPhase, number> = { planned: 0, fenced: 1, cleaned: 2, complete: 3 };
  await firestore.runTransaction(async transaction => {
    const reference = firestore.doc(`${RESET_OPERATION_PATH}/targets/${action.uid}`);
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) throw new Error('Reset target journal is missing.');
    const current = parsePrivateProResetTarget(snapshot.data());
    if (ranks[current.phase] > ranks[phase]) return;
    if (ranks[current.phase] + 1 !== ranks[phase]) throw new Error('Reset target journal phase mismatch.');
    transaction.update(reference, { phase, updatedAtMs: nowMs });
  });
}

async function markResetComplete(firestore: FirebaseFirestore.Firestore, projectId: string, executorId: string): Promise<void> {
  await firestore.runTransaction(async transaction => {
    const reference = firestore.doc(RESET_OPERATION_PATH);
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) throw new Error('Reset operation journal is missing.');
    const operation = parsePrivateProResetOperation(snapshot.data());
    if (operation.projectId !== projectId || operation.revision !== PRIVATE_PRO_WORKSPACE_RESET_REVISION || operation.state !== 'running' || operation.executorId !== executorId)
      throw new Error('Reset operation completion mismatch.');
    transaction.update(reference, { state: 'complete', leaseExpiresAtMs: 0 });
  });
}

function numericProjectNumber(value: unknown): string {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const projectNumber = record.projectNumber ?? record.project_number;
  if ((typeof projectNumber !== 'string' && typeof projectNumber !== 'number') || !/^\d{6,20}$/.test(String(projectNumber)))
    throw new Error('Project number verification failed.');
  return String(projectNumber);
}

async function readConfirmedProjectNumber(projectId: string, app: ReturnType<typeof initializeResetApp>): Promise<string> {
  const credential = app.options.credential;
  if (!credential) throw new Error('Project number verification failed.');
  const accessToken = await credential.getAccessToken();
  const response = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(projectId)}`, {
    headers: { Authorization: `Bearer ${accessToken.access_token}` },
  });
  if (!response.ok) throw new Error('Project number verification failed.');
  return numericProjectNumber(await response.json());
}

async function readBucketBindingMetadata(bucket: Bucket): Promise<{ name: string; projectNumber: string }> {
  const [metadata] = await bucket.getMetadata();
  return {
    name: typeof metadata.name === 'string' ? metadata.name : '',
    projectNumber: numericProjectNumber(metadata),
  };
}

async function countDocumentTree(reference: FirebaseFirestore.DocumentReference, documentId: FirebaseFirestore.FieldPath): Promise<number> {
  const [snapshot, collections] = await Promise.all([reference.get(), reference.listCollections()]);
  let count = snapshot.exists ? 1 : 0;
  for (const collection of collections) count += await countCollectionTree(collection, documentId);
  return count;
}

async function countCollectionTree(reference: FirebaseFirestore.CollectionReference, documentId: FirebaseFirestore.FieldPath): Promise<number> {
  let count = 0;
  let after: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  do {
    let query = reference.orderBy(documentId).limit(PAGE_SIZE);
    if (after) query = query.startAfter(after);
    const page = await query.get();
    for (const document of page.docs) count += await countDocumentTree(document.ref, documentId);
    after = page.docs.at(-1);
    if (page.size < PAGE_SIZE) break;
  } while (after);
  return count;
}

async function countStorageObjects(bucket: Bucket, prefix: string): Promise<number> {
  let count = 0;
  let pageToken: string | undefined;
  do {
    const [page, nextQuery] = await bucket.getFiles({ autoPaginate: false, maxResults: PAGE_SIZE, pageToken, prefix });
    count += page.length;
    pageToken = nextQuery?.pageToken;
  } while (pageToken);
  return count;
}

async function deleteStoragePrefix(bucket: Bucket, prefix: string): Promise<void> {
  while (true) {
    const [files] = await bucket.getFiles({ autoPaginate: false, maxResults: PAGE_SIZE, prefix });
    if (files.length === 0) return;
    await mapWithConcurrency(files, DELETE_CONCURRENCY, file => file.delete({ ignoreNotFound: true }).then(() => undefined));
  }
}

async function inspectAction(action: PrivateProResetAction, firestore: FirebaseFirestore.Firestore, bucket: Bucket, documentId: FirebaseFirestore.FieldPath) {
  let documentCount = 0;
  for (const target of action.firestoreTargets) {
    documentCount += target.kind === 'document'
      ? await countDocumentTree(firestore.doc(target.path), documentId)
      : await countCollectionTree(firestore.collection(target.path), documentId);
  }
  let objectCount = 0;
  for (const prefix of action.storagePrefixes) objectCount += await countStorageObjects(bucket, prefix);
  return { uid: action.uid, documentCount, objectCount, epochTransition: action.epochTransition };
}

async function cleanupFirestoreAction(action: PrivateProResetAction, firestore: FirebaseFirestore.Firestore) {
  for (const target of action.firestoreTargets) {
    const reference = target.kind === 'document' ? firestore.doc(target.path) : firestore.collection(target.path);
    await firestore.recursiveDelete(reference);
  }
}

async function applyAccountAction(action: PrivateProResetAction, firestore: FirebaseFirestore.Firestore) {
  const accountReference = firestore.doc(`users/${action.uid}`);
  if (action.account.type === 'replace') await accountReference.set(action.account.record);
  else await accountReference.delete();
}

async function fenceAccountAction(action: PrivateProResetAction, firestore: FirebaseFirestore.Firestore) {
  if (action.fenceAccount) await firestore.doc(`users/${action.uid}`).set(action.fenceAccount);
}

async function fenceClaimsAction(action: PrivateProResetAction, auth: ReturnType<AdminModules['getAuth']>) {
  if (action.claims.type === 'none') return;
  await auth.setCustomUserClaims(action.uid, clearedPrivateProClaims(action.claims.claims));
}

async function applyClaimsAction(action: PrivateProResetAction, auth: ReturnType<AdminModules['getAuth']>) {
  if (action.claims.type === 'replace') await auth.setCustomUserClaims(action.uid, action.claims.claims);
}

async function revokeTokensAction(action: PrivateProResetAction, auth: ReturnType<AdminModules['getAuth']>) {
  if (action.revokeRefreshTokens) await auth.revokeRefreshTokens(action.uid);
}

async function main() {
  const projectId = requiredEnvironment('NEXT_PUBLIC_FIREBASE_PROJECT_ID');
  const storageBucket = requiredEnvironment('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET');
  const args = parsePrivateProResetArguments(process.argv.slice(2), projectId);
  const allowedEmails = new Set((process.env.PRIVATE_PRO_ALLOWED_EMAILS ?? '').split(',').map(normalizeEmail).filter(Boolean));
  const admin = await loadAdminModules();
  const nowMs = Date.now();
  const executorId = randomUUID();
  const inputs = await collectInputs(admin, projectId, storageBucket, args.execute, nowMs, executorId);
  const plan = buildPrivateProResetPlan({
    projectId,
    ...args,
    authIdentities: inputs.authIdentities,
    accountDocuments: inputs.accountDocuments,
    allowedEmails,
    nowMs,
    resetOperation: inputs.resetOperation,
    resetTargets: inputs.resetTargets,
  });

  if (plan.mode === 'execute') {
    const operation = await ensureResetOperation(inputs.firestore, projectId, nowMs, executorId);
    if (operation.state === 'complete') {
      console.log(JSON.stringify({ projectId, mode: 'execute', alreadyComplete: true }));
      return;
    }
    await runPrivateProResetConvergence({
      refreshLease: async () => { await ensureResetOperation(inputs.firestore, projectId, Date.now(), executorId); },
      runPass: async () => {
        const fresh = await collectInputs(admin, projectId, storageBucket, false, Date.now(), executorId);
        const currentOperation = fresh.resetOperation ?? operation;
        const journalPlan = buildPrivateProResetPlan({ projectId, ...args, authIdentities: fresh.authIdentities, accountDocuments: fresh.accountDocuments, allowedEmails, nowMs: Date.now(), resetOperation: currentOperation, resetTargets: fresh.resetTargets });
        await ensureResetTargets(inputs.firestore, journalPlan.actions, Date.now());
        const refreshedTargets = (await inputs.firestore.collection(`${RESET_OPERATION_PATH}/targets`).get()).docs.map(document => parsePrivateProResetTarget(document.data()));
        const executablePlan = buildPrivateProResetPlan({ projectId, ...args, authIdentities: fresh.authIdentities, accountDocuments: fresh.accountDocuments, allowedEmails, nowMs: Date.now(), resetOperation: currentOperation, resetTargets: refreshedTargets });
        await executePrivateProResetActions(executablePlan.actions, {
          inspect: action => inspectAction(action, inputs.firestore, inputs.bucket, admin.FieldPath.documentId()),
          fenceAccount: action => fenceAccountAction(action, inputs.firestore),
          fenceClaims: action => fenceClaimsAction(action, inputs.auth),
          revokeFenceTokens: action => revokeTokensAction(action, inputs.auth),
          cleanupFirestore: action => cleanupFirestoreAction(action, inputs.firestore),
          cleanupStorage: async action => { for (const prefix of action.storagePrefixes) await deleteStoragePrefix(inputs.bucket, prefix); },
          applyFinalAccount: action => applyAccountAction(action, inputs.firestore),
          applyFinalClaims: action => applyClaimsAction(action, inputs.auth),
          revokeFinalTokens: action => revokeTokensAction(action, inputs.auth),
          persistPhase: (action, phase) => persistResetPhase(inputs.firestore, action, phase, Date.now()),
          emit: result => console.log(JSON.stringify(result)),
        });
        const finalTargets = (await inputs.firestore.collection(`${RESET_OPERATION_PATH}/targets`).get()).docs.map(document => parsePrivateProResetTarget(document.data()));
        return {
          relevantUids: executablePlan.actions.map(action => action.uid),
          targetUids: finalTargets.map(target => target.uid),
          incompleteTargets: finalTargets.filter(target => target.phase !== 'complete').length,
        };
      },
      markComplete: () => markResetComplete(inputs.firestore, projectId, executorId),
    });
    return;
  }
  const accounts = [];
  for (const action of plan.actions) accounts.push(await inspectAction(action, inputs.firestore, inputs.bucket, admin.FieldPath.documentId()));
  console.log(JSON.stringify({ projectId: plan.projectId, mode: plan.mode, alreadyComplete: plan.alreadyComplete, authIdentityCount: plan.authIdentityUids.length, authDeleteCount: plan.authDeleteCount, accountCount: plan.actions.length, accounts }, null, 2));
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) void main().catch(error => {
  void error;
  console.error(JSON.stringify({ success: false, errorCode: 'RESET_FAILED' }));
  process.exitCode = 1;
});
