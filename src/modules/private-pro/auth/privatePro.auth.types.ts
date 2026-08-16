export interface PrivateProIdentity {
  uid: string;
  email: string;
  emailVerified: boolean;
  privatePro: boolean;
  privateProEpoch: number | null;
  issuedAt: number;
  expiresAt: number;
}


export function privateProIdentityCanAccessDeployment(
  enabled: boolean,
  identity: PrivateProIdentity | null,
  allowlist: ReadonlySet<string>,
): boolean {
  if (!enabled) return true;
  return !!identity?.emailVerified && allowlist.has(identity.email) && privateProIdentityHasPremiumAccess(identity);
}

export function privateProIdentityCanBootstrap(identity: PrivateProIdentity | null, allowlist: ReadonlySet<string>): identity is PrivateProIdentity {
  return !!identity?.emailVerified && allowlist.has(identity.email);
}

export function privateProIdentityHasPremiumAccess(identity: PrivateProIdentity | null): identity is PrivateProIdentity & {
  privatePro: true;
  privateProEpoch: number;
} {
  return !!identity?.privatePro && typeof identity.privateProEpoch === 'number' && identity.privateProEpoch > 0;
}
