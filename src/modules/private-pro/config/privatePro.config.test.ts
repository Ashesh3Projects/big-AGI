import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  isPrivateProEmailAllowed,
  normalizePrivateProEmail,
  parsePrivateProServerConfig,
  parsePrivateProAllowlist,
} from './privatePro.config.server';


describe('private Pro allowlist', () => {
  test('normalizes case and surrounding whitespace', () => {
    assert.equal(normalizePrivateProEmail('  Friend@Example.COM '), 'friend@example.com');
  });

  test('drops empty and duplicate entries', () => {
    assert.deepEqual(
      [...parsePrivateProAllowlist('a@example.com, A@example.com, ,b@example.com')],
      ['a@example.com', 'b@example.com'],
    );
  });

  test('requires an exact email match', () => {
    const allowlist = parsePrivateProAllowlist('friend@example.com');

    assert.equal(isPrivateProEmailAllowed('friend@example.com', allowlist), true);
    assert.equal(isPrivateProEmailAllowed('other@example.com', allowlist), false);
  });

});

describe('private Pro App Check configuration', () => {
  const productionInput = {
    enabled: true,
    nodeEnv: 'production',
    allowedEmails: 'friend@example.com',
    firebaseProjectId: 'project',
    firebaseClientEmail: 'service@example.iam.gserviceaccount.com',
    firebasePrivateKey: 'key',
    appCheckSiteKey: 'site-key',
  } as const;

  test('produces only authentication, Firestore, and App Check server configuration', () => {
    const config = parsePrivateProServerConfig(productionInput);

    assert.deepEqual(Object.keys(config).sort(), ['allowedEmails', 'appCheckEnforced', 'enabled', 'firebase']);
    assert.deepEqual(Object.keys(config.firebase).sort(), ['clientEmail', 'credentialSource', 'privateKey', 'projectId']);
  });

  test('rejects production private Pro without an App Check site key', () => {
    assert.throws(
      () => parsePrivateProServerConfig({ ...productionInput, appCheckSiteKey: '' }),
      /App Check/i,
    );
  });

  test('enforces App Check for production private Pro', () => {
    assert.equal(parsePrivateProServerConfig(productionInput).appCheckEnforced, true);
  });

  test('permits the development and emulator debug path without a site key', () => {
    const config = parsePrivateProServerConfig({
      ...productionInput,
      nodeEnv: 'development',
      appCheckSiteKey: '',
    });

    assert.equal(config.appCheckEnforced, false);
  });
});
