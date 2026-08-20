import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import { parsePrivateProServerConfig } from '../config/privatePro.config.server';
import {
  createPrivateProAdminAppOptions,
  selectPrivateProFirebaseCredential,
} from './firebase.admin';


interface TestCredential {
  kind: 'adc' | 'static';
}

const baseConfigInput = {
  enabled: true,
  nodeEnv: 'production',
  allowedEmails: 'friend@example.com',
  firebaseProjectId: 'sample-project',
  firebaseClientEmail: undefined,
  firebasePrivateKey: undefined,
  appCheckSiteKey: 'site-key',
} as const;


describe('Private Pro Firebase Admin credentials', () => {
  test('selects Application Default Credentials when static credentials are absent', () => {
    const adc: TestCredential = { kind: 'adc' };
    const config = parsePrivateProServerConfig(baseConfigInput);
    const selection = selectPrivateProFirebaseCredential(config.firebase, {
      applicationDefault: () => adc,
      cert: () => assert.fail('static certificate factory must not run in ADC mode'),
    });

    assert.equal(config.firebase.credentialSource, 'application-default');
    assert.equal(config.firebase.clientEmail, undefined);
    assert.equal(config.firebase.privateKey, undefined);
    assert.deepEqual(selection, { credentialSource: 'application-default', credential: adc });
  });

  test('classifies and constructs the complete static credential pair as a fallback', () => {
    const staticCredential: TestCredential = { kind: 'static' };
    const config = parsePrivateProServerConfig({
      ...baseConfigInput,
      firebaseClientEmail: 'runtime@sample-project.iam.gserviceaccount.com',
      firebasePrivateKey: 'line-1\\nline-2',
    });
    let certificateInput: unknown;
    const selection = selectPrivateProFirebaseCredential(config.firebase, {
      applicationDefault: () => assert.fail('ADC factory must not run for a complete static pair'),
      cert: input => {
        certificateInput = input;
        return staticCredential;
      },
    });

    assert.equal(config.firebase.credentialSource, 'static-key-fallback');
    assert.deepEqual(selection, { credentialSource: 'static-key-fallback', credential: staticCredential });
    assert.deepEqual(certificateInput, {
      projectId: 'sample-project',
      clientEmail: 'runtime@sample-project.iam.gserviceaccount.com',
      privateKey: 'line-1\nline-2',
    });
  });

  test('rejects either partial static credential without exposing the key', () => {
    const privateKey = 'private-key-sentinel';
    for (const input of [
      { ...baseConfigInput, firebaseClientEmail: 'runtime@sample-project.iam.gserviceaccount.com' },
      { ...baseConfigInput, firebasePrivateKey: privateKey },
    ]) {
      assert.throws(
        () => parsePrivateProServerConfig(input),
        error => error instanceof Error && /must be provided together/i.test(error.message) && !error.message.includes(privateKey),
      );
    }
  });

  test('redacts a static certificate construction failure', () => {
    const privateKey = 'private-key-sentinel';

    assert.throws(
      () => selectPrivateProFirebaseCredential({
        projectId: 'sample-project',
        clientEmail: 'runtime@sample-project.iam.gserviceaccount.com',
        privateKey,
      }, {
        applicationDefault: () => assert.fail('ADC factory must not run for a complete static pair'),
        cert: () => { throw new Error(`invalid ${privateKey}`); },
      }),
      error => error instanceof Error && /static Firebase credential is invalid/i.test(error.message) && !error.message.includes(privateKey),
    );
  });

  test('builds deterministic Admin initialization options without initializing a global app', () => {
    const adc: TestCredential = { kind: 'adc' };
    const result = createPrivateProAdminAppOptions({
      projectId: 'sample-project',
    }, {
      applicationDefault: () => adc,
      cert: () => assert.fail('static certificate factory must not run in ADC mode'),
    });

    assert.deepEqual(result, {
      credentialSource: 'application-default',
      options: {
        credential: adc,
        projectId: 'sample-project',
      },
    });
  });

  test('keeps deployment examples consistent with ADC and paired static fallback configuration', async () => {
    const deployment = await readFile('docs/deploy-private-pro-firebase.md', 'utf8');
    const dotenvBlocks = [...deployment.matchAll(/```dotenv\r?\n([\s\S]*?)```/g)].map(match => match[1]);
    const primary = dotenvBlocks.find(block => block.includes('NEXT_PUBLIC_PRIVATE_PRO_ENABLED=true')) ?? '';
    const fallback = dotenvBlocks.find(block => block.includes('BEGIN PRIVATE KEY')) ?? '';

    assert.doesNotMatch(primary, /FIREBASE_(?:CLIENT_EMAIL|PRIVATE_KEY)=/);
    assert.match(fallback, /FIREBASE_CLIENT_EMAIL=/);
    assert.match(fallback, /FIREBASE_PRIVATE_KEY=/);
  });

});
