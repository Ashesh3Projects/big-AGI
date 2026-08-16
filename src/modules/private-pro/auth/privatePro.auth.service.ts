import { isPrivateProEmailAllowed } from '../config/privatePro.config.server';
import type { PrivateProIdentity } from './privatePro.auth.types';


export interface PrivateProAccountRecord {
  uid: string;
  email: string;
  active: boolean;
  accessEpoch: number;
  quotaBytes: number;
  usedBytes: number;
  reservedBytes: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PrivateProBootstrap {
  uid: string;
  email: string;
  accessEpoch: number;
  quotaBytes: number;
  usedBytes: number;
  reservedBytes: number;
}

export interface PrivateProAuthAdminPort {
  getAccount(uid: string): Promise<PrivateProAccountRecord | null>;
  saveAccount(record: PrivateProAccountRecord): Promise<void>;
  setClaims(uid: string, claims: { privatePro: true; privateProEpoch: number }): Promise<void>;
  revokeRefreshTokens(uid: string): Promise<void>;
}

export interface PrivateProBootstrapOptions {
  allowedEmails: ReadonlySet<string>;
  attachmentQuotaBytes: number;
  nowMs: number;
}


export async function bootstrapPrivateProAccount(
  identity: PrivateProIdentity,
  admin: PrivateProAuthAdminPort,
  options: PrivateProBootstrapOptions,
): Promise<PrivateProBootstrap> {
  if (!identity.emailVerified || !isPrivateProEmailAllowed(identity.email, options.allowedEmails))
    throw new Error('This Google account is not allowed to use private Pro.');

  const existing = await admin.getAccount(identity.uid);
  const accessEpoch = existing
    ? existing.active ? Math.max(1, existing.accessEpoch) : Math.max(1, existing.accessEpoch + 1)
    : 1;
  const account: PrivateProAccountRecord = {
    uid: identity.uid,
    email: identity.email,
    active: true,
    accessEpoch,
    quotaBytes: options.attachmentQuotaBytes,
    usedBytes: existing?.usedBytes ?? 0,
    reservedBytes: existing?.reservedBytes ?? 0,
    createdAtMs: existing?.createdAtMs ?? options.nowMs,
    updatedAtMs: options.nowMs,
  };

  await admin.saveAccount(account);
  await admin.setClaims(identity.uid, { privatePro: true, privateProEpoch: accessEpoch });

  return {
    uid: account.uid,
    email: account.email,
    accessEpoch: account.accessEpoch,
    quotaBytes: account.quotaBytes,
    usedBytes: account.usedBytes,
    reservedBytes: account.reservedBytes,
  };
}

export function privateProAccountIsCurrent(
  identity: PrivateProIdentity,
  account: PrivateProAccountRecord | null,
): account is PrivateProAccountRecord {
  return !!account &&
    account.active &&
    account.uid === identity.uid &&
    identity.privatePro &&
    identity.privateProEpoch === account.accessEpoch;
}
