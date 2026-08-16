import { isPrivateProEmailAllowed } from '../config/privatePro.config.server';
import type { PrivateProIdentity } from './privatePro.auth.types';


export class PrivateProAccessDeniedError extends Error {
  constructor() {
    super('This Google account is not allowed to use private Pro.');
    this.name = 'PrivateProAccessDeniedError';
  }
}

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
  activateAccount(input: {
    uid: string;
    email: string;
    quotaBytes: number;
    nowMs: number;
  }): Promise<PrivateProAccountRecord>;
  setClaims(uid: string, claims: { privatePro: true; privateProEpoch: number }): Promise<void>;
  revokeRefreshTokens(uid: string): Promise<void>;
}

export interface PrivateProBootstrapOptions {
  allowedEmails: ReadonlySet<string>;
  attachmentQuotaBytes: number;
  nowMs: number;
}

export function activatePrivateProAccountRecord(
  existing: PrivateProAccountRecord | null,
  input: { uid: string; email: string; quotaBytes: number; nowMs: number },
): PrivateProAccountRecord {
  const accessEpoch = existing
    ? existing.active ? Math.max(1, existing.accessEpoch) : Math.max(1, existing.accessEpoch + 1)
    : 1;
  return {
    uid: input.uid,
    email: input.email,
    active: true,
    accessEpoch,
    quotaBytes: input.quotaBytes,
    usedBytes: existing?.usedBytes ?? 0,
    reservedBytes: existing?.reservedBytes ?? 0,
    createdAtMs: existing?.createdAtMs ?? input.nowMs,
    updatedAtMs: input.nowMs,
  };
}


export async function bootstrapPrivateProAccount(
  identity: PrivateProIdentity,
  admin: PrivateProAuthAdminPort,
  options: PrivateProBootstrapOptions,
): Promise<PrivateProBootstrap> {
  if (!identity.emailVerified || !isPrivateProEmailAllowed(identity.email, options.allowedEmails))
    throw new PrivateProAccessDeniedError();

  const account = await admin.activateAccount({
    uid: identity.uid,
    email: identity.email,
    quotaBytes: options.attachmentQuotaBytes,
    nowMs: options.nowMs,
  });
  await admin.setClaims(identity.uid, { privatePro: true, privateProEpoch: account.accessEpoch });

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
