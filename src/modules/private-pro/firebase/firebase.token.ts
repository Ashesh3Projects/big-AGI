import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

import { normalizePrivateProEmail } from '../config/privatePro.config.server';
import type { PrivateProIdentity } from '../auth/privatePro.auth.types';


const FIREBASE_JWKS_URL = new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');

let remoteJwks: JWTVerifyGetKey | undefined;

export interface VerifyFirebaseIdTokenOptions {
  projectId: string;
  jwks?: JWTVerifyGetKey;
}


export function extractFirebaseBearerToken(header: string | null): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token || null;
}

export async function verifyFirebaseIdToken(token: string, options: VerifyFirebaseIdTokenOptions): Promise<PrivateProIdentity> {
  if (!token) throw new Error('Firebase ID token is required.');
  if (!options.projectId) throw new Error('Firebase project ID is required.');

  const jwks = options.jwks ?? (remoteJwks ??= createRemoteJWKSet(FIREBASE_JWKS_URL));
  const { payload } = await jwtVerify(token, jwks, {
    algorithms: ['RS256'],
    audience: options.projectId,
    issuer: `https://securetoken.google.com/${options.projectId}`,
  });

  if (
    !payload.sub ||
    typeof payload.email !== 'string' ||
    payload.email_verified !== true ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number'
  )
    throw new Error('Firebase identity requires a verified email.');
  const firebaseClaim = payload.firebase;
  if (!firebaseClaim || typeof firebaseClaim !== 'object' || !('sign_in_provider' in firebaseClaim) || firebaseClaim.sign_in_provider !== 'google.com')
    throw new Error('Private Pro requires Google sign-in.');

  const privateProEpoch = payload.privateProEpoch;
  return {
    uid: payload.sub,
    email: normalizePrivateProEmail(payload.email),
    emailVerified: true,
    privatePro: payload.privatePro === true,
    privateProEpoch: typeof privateProEpoch === 'number' && Number.isInteger(privateProEpoch)
      ? privateProEpoch
      : null,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
}
