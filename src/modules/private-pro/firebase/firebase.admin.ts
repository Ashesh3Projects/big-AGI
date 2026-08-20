import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
  type App,
  type Credential,
} from 'firebase-admin/app';
import { getAppCheck } from 'firebase-admin/app-check';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

import {
  classifyPrivateProFirebaseCredentialSource,
  getPrivateProServerConfig,
} from '../config/privatePro.config.server';
import type { PrivateProFirebaseCredentialSource } from '../config/privatePro.config.server';


let privateProAdminApp: App | undefined;

export interface PrivateProFirebaseCredentialConfig {
  projectId: string;
  clientEmail?: string;
  privateKey?: string;
}

export interface PrivateProFirebaseAdminConfig extends PrivateProFirebaseCredentialConfig {}

export interface PrivateProFirebaseCredentialFactories<TCredential> {
  applicationDefault(): TCredential;
  cert(input: { projectId: string; clientEmail: string; privateKey: string }): TCredential;
}

const privateProFirebaseCredentialFactories: PrivateProFirebaseCredentialFactories<Credential> = {
  applicationDefault,
  cert,
};

export function selectPrivateProFirebaseCredential<TCredential>(
  config: PrivateProFirebaseCredentialConfig,
  factories: PrivateProFirebaseCredentialFactories<TCredential>,
): { credentialSource: PrivateProFirebaseCredentialSource; credential: TCredential } {
  const credentialSource = classifyPrivateProFirebaseCredentialSource(config.clientEmail, config.privateKey);
  if (credentialSource === 'static-key-fallback' && config.clientEmail && config.privateKey) {
    let credential: TCredential;
    try {
      credential = factories.cert({
        projectId: config.projectId,
        clientEmail: config.clientEmail,
        privateKey: config.privateKey,
      });
    } catch {
      throw new Error('The static Firebase credential is invalid.');
    }
    return {
      credentialSource,
      credential,
    };
  }
  return {
    credentialSource: 'application-default',
    credential: factories.applicationDefault(),
  };
}

export function createPrivateProAdminAppOptions<TCredential>(
  config: PrivateProFirebaseAdminConfig,
  factories: PrivateProFirebaseCredentialFactories<TCredential>,
): {
  credentialSource: PrivateProFirebaseCredentialSource;
  options: { credential: TCredential; projectId: string };
} {
  const missing = [
    !config.projectId && 'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
  ].filter((value): value is string => !!value);
  if (missing.length)
    throw new Error(`Private Pro Firebase Admin is missing: ${missing.join(', ')}`);

  const selection = selectPrivateProFirebaseCredential(config, factories);
  return {
    credentialSource: selection.credentialSource,
    options: {
      credential: selection.credential,
      projectId: config.projectId,
    },
  };
}

function getPrivateProAdminApp(): App {
  if (privateProAdminApp) return privateProAdminApp;

  const config = getPrivateProServerConfig();
  const { options } = createPrivateProAdminAppOptions(config.firebase, privateProFirebaseCredentialFactories);
  privateProAdminApp = getApps().find(app => app.name === 'private-pro') ?? initializeApp(options, 'private-pro');
  return privateProAdminApp;
}

export function getPrivateProAdminAuth() {
  return getAuth(getPrivateProAdminApp());
}

export function getPrivateProAdminAppCheck() {
  return getAppCheck(getPrivateProAdminApp());
}

export function getPrivateProFirestore() {
  return getFirestore(getPrivateProAdminApp());
}
