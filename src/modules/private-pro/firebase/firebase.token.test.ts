import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';

import { extractFirebaseBearerToken, verifyFirebaseIdToken } from './firebase.token';


const PROJECT_ID = 'private-pro-test';
const UID = 'uid-123';

async function createToken(overrides: Record<string, unknown> = {}, audience: string = PROJECT_ID) {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    email: 'Friend@Example.com',
    email_verified: true,
    privatePro: true,
    privateProEpoch: 7,
    firebase: { sign_in_provider: 'google.com' },
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject(UID)
    .setIssuer(`https://securetoken.google.com/${PROJECT_ID}`)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  return {
    token,
    jwks: createLocalJWKSet({ keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] }),
  };
}


describe('Firebase ID token verification', () => {
  test('extracts only a non-empty bearer token', () => {
    assert.equal(extractFirebaseBearerToken('Bearer signed-token'), 'signed-token');
    assert.equal(extractFirebaseBearerToken('Basic abc'), null);
    assert.equal(extractFirebaseBearerToken('Bearer   '), null);
    assert.equal(extractFirebaseBearerToken(null), null);
  });

  test('accepts a valid verified Firebase identity', async () => {
    const { token, jwks } = await createToken();

    const identity = await verifyFirebaseIdToken(token, { projectId: PROJECT_ID, jwks });

    assert.equal(identity.uid, UID);
    assert.equal(identity.email, 'friend@example.com');
    assert.equal(identity.emailVerified, true);
    assert.equal(identity.privatePro, true);
    assert.equal(identity.privateProEpoch, 7);
    assert.equal(identity.expiresAt > identity.issuedAt, true);
  });

  test('rejects a token issued for another Firebase project', async () => {
    const { token, jwks } = await createToken({}, 'other-project');

    await assert.rejects(
      verifyFirebaseIdToken(token, { projectId: PROJECT_ID, jwks }),
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        assert.equal((error as { cause?: { claim?: string } }).cause?.claim, 'aud');
        return true;
      },
    );
  });

  test('rejects an unverified email address', async () => {
    const { token, jwks } = await createToken({ email_verified: false });

    await assert.rejects(
      verifyFirebaseIdToken(token, { projectId: PROJECT_ID, jwks }),
      /verified email/i,
    );
  });

  test('rejects a token without an email address', async () => {
    const { token, jwks } = await createToken({ email: undefined });

    await assert.rejects(
      verifyFirebaseIdToken(token, { projectId: PROJECT_ID, jwks }),
      /verified email/i,
    );
  });

  test('rejects a verified identity from a non-Google provider', async () => {
    const { token, jwks } = await createToken({ firebase: { sign_in_provider: 'password' } });

    await assert.rejects(
      verifyFirebaseIdToken(token, { projectId: PROJECT_ID, jwks }),
      /Google sign-in/i,
    );
  });
});
