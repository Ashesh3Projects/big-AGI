import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parsePrivateProServerConfig } from '../config/privatePro.config.server';
import { verifyPrivateProAppCheckTokenForConfig } from './firebase.appcheck.server';


describe('private Pro App Check verification', () => {
  test('rejects a missing token when production private Pro enforces App Check', async () => {
    const config = parsePrivateProServerConfig({
      enabled: true,
      nodeEnv: 'production',
      allowedEmails: 'friend@example.com',
      firebaseProjectId: 'project',
      firebaseClientEmail: 'service@example.iam.gserviceaccount.com',
      firebasePrivateKey: 'key',
      appCheckSiteKey: 'site-key',
    });

    await assert.rejects(
      verifyPrivateProAppCheckTokenForConfig(null, config.appCheckEnforced, async () => undefined),
      /App Check token required/i,
    );
  });

  test('rejects a token that Firebase App Check does not verify', async () => {
    await assert.rejects(
      verifyPrivateProAppCheckTokenForConfig('invalid', true, async () => {
        throw new Error('invalid token');
      }),
      /App Check verification failed/i,
    );
  });

  test('permits the development and emulator path when enforcement is disabled', async () => {
    await verifyPrivateProAppCheckTokenForConfig(null, false, async () => {
      throw new Error('verification should not run');
    });
  });
});
