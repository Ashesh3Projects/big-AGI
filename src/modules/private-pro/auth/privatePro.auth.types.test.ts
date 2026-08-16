import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  privateProIdentityCanAccessDeployment,
  privateProIdentityHasPremiumAccess,
  type PrivateProIdentity,
} from './privatePro.auth.types';


const VERIFIED_IDENTITY: PrivateProIdentity = {
  uid: 'uid-123',
  email: 'friend@example.com',
  emailVerified: true,
  privatePro: false,
  privateProEpoch: null,
  issuedAt: 100,
  expiresAt: 200,
};


describe('private Pro access decisions', () => {
  test('keeps the deployment open when private Pro is disabled', () => {
    assert.equal(privateProIdentityCanAccessDeployment(false, null, new Set()), true);
  });

  test('requires an allowlisted verified identity when enabled', () => {
    const allowlist = new Set(['friend@example.com']);

    assert.equal(privateProIdentityCanAccessDeployment(true, VERIFIED_IDENTITY, allowlist), true);
    assert.equal(privateProIdentityCanAccessDeployment(true, null, allowlist), false);
    assert.equal(privateProIdentityCanAccessDeployment(true, { ...VERIFIED_IDENTITY, email: 'other@example.com' }, allowlist), false);
    assert.equal(privateProIdentityCanAccessDeployment(true, { ...VERIFIED_IDENTITY, emailVerified: false }, allowlist), false);
  });

  test('requires both the private Pro claim and a positive access epoch', () => {
    assert.equal(privateProIdentityHasPremiumAccess({ ...VERIFIED_IDENTITY, privatePro: true, privateProEpoch: 3 }), true);
    assert.equal(privateProIdentityHasPremiumAccess({ ...VERIFIED_IDENTITY, privatePro: false, privateProEpoch: 3 }), false);
    assert.equal(privateProIdentityHasPremiumAccess({ ...VERIFIED_IDENTITY, privatePro: true, privateProEpoch: null }), false);
    assert.equal(privateProIdentityHasPremiumAccess({ ...VERIFIED_IDENTITY, privatePro: true, privateProEpoch: 0 }), false);
  });
});
