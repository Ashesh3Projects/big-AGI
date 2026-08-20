import { pathToFileURL } from 'node:url';

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
}

export interface PrivateProResetPlan {
  projectId: string;
  mode: 'dry-run' | 'execute';
  authIdentityUids: string[];
  authDeleteCount: 0;
  actions: PrivateProResetAction[];
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

function validNonnegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function validPositiveTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isCurrentPrivateProAccount(value: Readonly<Record<string, unknown>> | undefined, uid: string, email: string): boolean {
  if (!value || Object.keys(value).sort().join(',') !== 'accessEpoch,active,createdAtMs,email,uid,updatedAtMs') return false;
  return value.uid === uid
    && value.email === email
    && typeof value.active === 'boolean'
    && validNonnegativeInteger(value.accessEpoch) > 0
    && validPositiveTimestamp(value.createdAtMs, 0) > 0
    && validPositiveTimestamp(value.updatedAtMs, 0) > 0;
}

function resetTargetEpoch(input: {
  account: PrivateProResetAccountDocument | undefined;
  identity: PrivateProResetAuthIdentity;
  uid: string;
  email: string;
}): { maximumEpoch: number; targetEpoch: number } {
  const accountEpoch = validNonnegativeInteger(input.account?.data?.accessEpoch);
  const claimEpoch = validNonnegativeInteger(input.identity.claims.privateProEpoch);
  const maximumEpoch = Math.max(accountEpoch, claimEpoch, 0);
  if (maximumEpoch >= Number.MAX_SAFE_INTEGER) throw new Error('Private Pro reset cannot advance beyond the maximum safe epoch.');
  const accountIsResetState = isCurrentPrivateProAccount(input.account?.data, input.uid, input.email);
  const claimsAreResetState = input.identity.claims.privatePro === true && claimEpoch > 0;
  return {
    maximumEpoch,
    targetEpoch: accountIsResetState || (!input.account && claimsAreResetState) ? Math.max(maximumEpoch, 1) : maximumEpoch + 1,
  };
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

  const allowedEmails = new Set([...input.allowedEmails].map(normalizeEmail).filter(Boolean));
  if (input.execute && allowedEmails.size === 0) throw new Error('PRIVATE_PRO_ALLOWED_EMAILS allowlist is empty.');

  const authByUid = new Map(input.authIdentities.map(identity => [identity.uid, identity]));
  const accountByUid = new Map(input.accountDocuments.filter(account => account.exists).map(account => [account.uid, account]));
  const uids = [...new Set([...authByUid.keys(), ...accountByUid.keys()])].sort();
  const actions = uids.map(uid => {
    const identity = authByUid.get(uid);
    const account = accountByUid.get(uid);
    const normalizedEmail = identity?.email ? normalizeEmail(identity.email) : '';
    const approved = !!identity && identity.emailVerified && normalizedEmail !== '' && allowedEmails.has(normalizedEmail);
    const targets = cleanupTargets(uid);

    if (!approved) return {
      uid,
      approved: false,
      ...targets,
      account: { type: 'delete' } as const,
      ...(identity ? (() => {
        const { maximumEpoch, targetEpoch } = resetTargetEpoch({ account, identity, uid, email: normalizedEmail });
        const createdAtMs = validPositiveTimestamp(account?.data?.createdAtMs, input.nowMs);
        return {
          fenceAccount: { uid, email: normalizedEmail, active: false as const, accessEpoch: targetEpoch, createdAtMs, updatedAtMs: input.nowMs },
          epochTransition: { from: maximumEpoch, to: targetEpoch },
        };
      })() : {}),
      claims: identity
        ? { type: 'replace' as const, claims: clearedPrivateProClaims(identity.claims) }
        : { type: 'none' as const },
      revokeRefreshTokens: !!identity,
    };

    const { maximumEpoch, targetEpoch: accessEpoch } = resetTargetEpoch({ account, identity, uid, email: normalizedEmail });
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
    };
  });

  return {
    projectId: input.projectId,
    mode: input.execute ? 'execute' : 'dry-run',
    authIdentityUids: [...authByUid.keys()].sort(),
    authDeleteCount: 0,
    actions,
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
      stage = 'fence-account';
      await port.fenceAccount(action);
      stage = 'fence-claims';
      await port.fenceClaims(action);
      stage = 'fence-tokens';
      await port.revokeFenceTokens(action);
      stage = 'firestore-cleanup';
      await port.cleanupFirestore(action);
      stage = 'storage-cleanup';
      await port.cleanupStorage(action);
      stage = 'final-account';
      await port.applyFinalAccount(action);
      stage = 'final-claims';
      await port.applyFinalClaims(action);
      stage = 'final-tokens';
      await port.revokeFinalTokens(action);
      port.emit({ ...counts, stage: 'complete', success: true });
    } catch {
      port.emit({ ...counts, stage, success: false, errorCode: STAGE_ERRORS[stage] });
      throw new Error('Private Pro reset failed.');
    }
  }
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

async function collectInputs(admin: AdminModules, projectId: string, storageBucket: string) {
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

  return { auth, firestore, bucket, authIdentities, accountDocuments };
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
  const inputs = await collectInputs(admin, projectId, storageBucket);
  const plan = buildPrivateProResetPlan({
    projectId,
    ...args,
    authIdentities: inputs.authIdentities,
    accountDocuments: inputs.accountDocuments,
    allowedEmails,
    nowMs: Date.now(),
  });

  if (plan.mode === 'execute') {
    await executePrivateProResetActions(plan.actions, {
      inspect: action => inspectAction(action, inputs.firestore, inputs.bucket, admin.FieldPath.documentId()),
      fenceAccount: action => fenceAccountAction(action, inputs.firestore),
      fenceClaims: action => fenceClaimsAction(action, inputs.auth),
      revokeFenceTokens: action => revokeTokensAction(action, inputs.auth),
      cleanupFirestore: action => cleanupFirestoreAction(action, inputs.firestore),
      cleanupStorage: async action => { for (const prefix of action.storagePrefixes) await deleteStoragePrefix(inputs.bucket, prefix); },
      applyFinalAccount: action => applyAccountAction(action, inputs.firestore),
      applyFinalClaims: action => applyClaimsAction(action, inputs.auth),
      revokeFinalTokens: action => revokeTokensAction(action, inputs.auth),
      emit: result => console.log(JSON.stringify(result)),
    });
    return;
  }
  const accounts = [];
  for (const action of plan.actions) accounts.push(await inspectAction(action, inputs.firestore, inputs.bucket, admin.FieldPath.documentId()));
  console.log(JSON.stringify({ projectId: plan.projectId, mode: plan.mode, authIdentityCount: plan.authIdentityUids.length, authDeleteCount: plan.authDeleteCount, accountCount: plan.actions.length, accounts }, null, 2));
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) void main().catch(error => {
  void error;
  console.error(JSON.stringify({ success: false, errorCode: 'RESET_FAILED' }));
  process.exitCode = 1;
});
