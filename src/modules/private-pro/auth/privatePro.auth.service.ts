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
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PrivateProBootstrap {
  uid: string;
  email: string;
  accessEpoch: number;
}

export class PrivateProResetInProgressError extends Error {
  constructor() {
    super('Private Pro is temporarily unavailable.');
    this.name = 'PrivateProResetInProgressError';
  }
}

export interface PrivateProAuthAdminPort {
  getWorkspaceResetState(): Promise<'absent' | 'running' | 'complete'>;
  activateAccount(input: {
    uid: string;
    email: string;
    nowMs: number;
  }): Promise<PrivateProAccountRecord>;
  setClaims(uid: string, claims: { privatePro: true; privateProEpoch: number }): Promise<void>;
  revokeRefreshTokens(uid: string): Promise<void>;
}

export interface PrivateProBootstrapOptions {
  allowedEmails: ReadonlySet<string>;
  nowMs: number;
}

export function privateProBootstrapErrorCode(error: unknown): 'UNAUTHORIZED' | 'SERVICE_UNAVAILABLE' | null {
  if (error instanceof PrivateProAccessDeniedError) return 'UNAUTHORIZED';
  if (error instanceof PrivateProResetInProgressError) return 'SERVICE_UNAVAILABLE';
  return null;
}

export function activatePrivateProAccountRecord(
  existing: PrivateProAccountRecord | null,
  input: { uid: string; email: string; nowMs: number },
): PrivateProAccountRecord {
  const accessEpoch = existing
    ? existing.active ? Math.max(1, existing.accessEpoch) : Math.max(1, existing.accessEpoch + 1)
    : 1;
  return {
    uid: input.uid,
    email: input.email,
    active: true,
    accessEpoch,
    createdAtMs: existing?.createdAtMs ?? input.nowMs,
    updatedAtMs: input.nowMs,
  };
}


export async function bootstrapPrivateProAccount(
  identity: PrivateProIdentity,
  admin: PrivateProAuthAdminPort,
  options: PrivateProBootstrapOptions,
): Promise<PrivateProBootstrap> {
  if (await admin.getWorkspaceResetState() === 'running') throw new PrivateProResetInProgressError();
  if (!identity.emailVerified || !isPrivateProEmailAllowed(identity.email, options.allowedEmails))
    throw new PrivateProAccessDeniedError();

  const account = await admin.activateAccount({
    uid: identity.uid,
    email: identity.email,
    nowMs: options.nowMs,
  });
  await admin.setClaims(identity.uid, { privatePro: true, privateProEpoch: account.accessEpoch });

  return {
    uid: account.uid,
    email: account.email,
    accessEpoch: account.accessEpoch,
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
