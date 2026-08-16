import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { pathToFileURL } from 'node:url';


const DEFAULT_QUOTA_BYTES = 1024 * 1024 * 1024;

export interface PrivateProAccessUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  privatePro: boolean;
  claimEpoch: number | null;
  accountActive: boolean;
  accountEpoch: number | null;
}

export interface PrivateProAccessDiff {
  grant: string[];
  refresh: string[];
  revoke: string[];
  unchanged: string[];
  ignored: string[];
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function diffPrivateProAccess(users: PrivateProAccessUser[], allowedEmails: ReadonlySet<string>): PrivateProAccessDiff {
  const result: PrivateProAccessDiff = { grant: [], refresh: [], revoke: [], unchanged: [], ignored: [] };
  for (const user of users) {
    const allowed = !!user.email && user.emailVerified && allowedEmails.has(normalizeEmail(user.email));
    if (allowed) {
      if (!user.privatePro || !user.accountActive || user.accountEpoch === null)
        result.grant.push(user.uid);
      else if (user.claimEpoch !== user.accountEpoch)
        result.refresh.push(user.uid);
      else
        result.unchanged.push(user.uid);
    } else if (user.privatePro || user.accountActive) {
      result.revoke.push(user.uid);
    } else {
      result.ignored.push(user.uid);
    }
  }
  Object.values(result).forEach(group => group.sort());
  return result;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function firebaseAdminApp() {
  return getApps().find(app => app.name === 'private-pro-admin') ?? initializeApp({
    credential: cert({
      projectId: requiredEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID'),
      clientEmail: requiredEnv('FIREBASE_CLIENT_EMAIL'),
      privateKey: requiredEnv('FIREBASE_PRIVATE_KEY').replaceAll('\\n', '\n'),
    }),
  }, 'private-pro-admin');
}

async function listPrivateProUsers(): Promise<PrivateProAccessUser[]> {
  const app = firebaseAdminApp();
  const auth = getAuth(app);
  const firestore = getFirestore(app);
  const users: PrivateProAccessUser[] = [];
  let pageToken: string | undefined;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const user of page.users) {
      const account = await firestore.doc(`users/${user.uid}`).get();
      const accountData = account.data();
      users.push({
        uid: user.uid,
        email: user.email ? normalizeEmail(user.email) : null,
        emailVerified: user.emailVerified,
        privatePro: user.customClaims?.privatePro === true,
        claimEpoch: typeof user.customClaims?.privateProEpoch === 'number' ? user.customClaims.privateProEpoch : null,
        accountActive: accountData?.active === true,
        accountEpoch: typeof accountData?.accessEpoch === 'number' ? accountData.accessEpoch : null,
      });
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return users;
}

async function grant(uid: string, nowMs: number) {
  const app = firebaseAdminApp();
  const auth = getAuth(app);
  const firestore = getFirestore(app);
  const user = await auth.getUser(uid);
  if (!user.email || !user.emailVerified) throw new Error(`Cannot grant unverified user ${uid}.`);
  const reference = firestore.doc(`users/${uid}`);
  const snapshot = await reference.get();
  const current = snapshot.data();
  const accessEpoch = current?.active === true
    ? Math.max(1, Number(current.accessEpoch) || 1)
    : Math.max(1, (Number(current?.accessEpoch) || 0) + 1);
  await reference.set({
    uid,
    email: normalizeEmail(user.email),
    active: true,
    accessEpoch,
    quotaBytes: Number(process.env.PRIVATE_PRO_ATTACHMENT_QUOTA_BYTES) || Number(current?.quotaBytes) || DEFAULT_QUOTA_BYTES,
    usedBytes: Number(current?.usedBytes) || 0,
    reservedBytes: Number(current?.reservedBytes) || 0,
    createdAtMs: Number(current?.createdAtMs) || nowMs,
    updatedAtMs: nowMs,
  });
  await auth.setCustomUserClaims(uid, { ...user.customClaims, privatePro: true, privateProEpoch: accessEpoch });
}

async function revoke(uid: string, nowMs: number) {
  const app = firebaseAdminApp();
  const auth = getAuth(app);
  const firestore = getFirestore(app);
  const user = await auth.getUser(uid);
  const reference = firestore.doc(`users/${uid}`);
  const snapshot = await reference.get();
  const current = snapshot.data();
  const accessEpoch = Math.max(1, (Number(current?.accessEpoch) || 0) + 1);
  await reference.set({ active: false, accessEpoch, updatedAtMs: nowMs }, { merge: true });
  const claims = { ...user.customClaims };
  delete claims.privatePro;
  delete claims.privateProEpoch;
  await auth.setCustomUserClaims(uid, claims);
  await auth.revokeRefreshTokens(uid);
}

async function main() {
  const [command, value] = process.argv.slice(2);
  const allowlist = new Set((process.env.PRIVATE_PRO_ALLOWED_EMAILS ?? '').split(',').map(normalizeEmail).filter(Boolean));
  if (command === 'revoke') {
    if (!value) throw new Error('Usage: npm run private-pro:revoke -- user@example.com');
    const target = (await listPrivateProUsers()).find(user => user.email === normalizeEmail(value));
    if (!target) throw new Error(`Firebase user not found for ${value}.`);
    await revoke(target.uid, Date.now());
    console.log(`Revoked private Pro access for ${target.email}.`);
    return;
  }
  if (command && command !== 'sync') throw new Error('Usage: manage-access.ts [sync | revoke user@example.com]');
  if (!allowlist.size) throw new Error('PRIVATE_PRO_ALLOWED_EMAILS is empty.');

  const users = await listPrivateProUsers();
  const diff = diffPrivateProAccess(users, allowlist);
  const nowMs = Date.now();
  for (const uid of [...diff.grant, ...diff.refresh]) await grant(uid, nowMs);
  for (const uid of diff.revoke) await revoke(uid, nowMs);
  console.log(JSON.stringify({
    granted: diff.grant.length,
    refreshed: diff.refresh.length,
    revoked: diff.revoke.length,
    unchanged: diff.unchanged.length,
    ignored: diff.ignored.length,
  }, null, 2));
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint)
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
