import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { getToken, initializeAppCheck, ReCaptchaEnterpriseProvider, type AppCheck } from 'firebase/app-check';
import { getAuth, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';

import { privateProClientConfig, privateProClientConfigComplete } from '../config/privatePro.config';


let privateProFirebaseApp: FirebaseApp | undefined;
let privateProAppCheck: AppCheck | null | undefined;

interface PrivateProAppCheckDebugGlobal {
  FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string;
}

export function getPrivateProFirebaseApp(): FirebaseApp {
  if (!privateProClientConfigComplete())
    throw new Error('Private Pro Firebase browser configuration is incomplete.');
  if (privateProFirebaseApp) return privateProFirebaseApp;

  privateProFirebaseApp = getApps().some(app => app.name === 'private-pro')
    ? getApp('private-pro')
    : initializeApp(privateProClientConfig.firebase, 'private-pro');
  return privateProFirebaseApp;
}

export function getPrivateProFirebaseAuth(): Auth {
  return getAuth(getPrivateProFirebaseApp());
}

export function getPrivateProClientFirestore(): Firestore {
  return getFirestore(getPrivateProFirebaseApp());
}

export function getPrivateProClientAppCheck(): AppCheck | null {
  if (privateProAppCheck !== undefined) return privateProAppCheck;
  if (!privateProClientConfig.appCheckSiteKey) return privateProAppCheck = null;

  const debugGlobal = globalThis as typeof globalThis & PrivateProAppCheckDebugGlobal;
  if (process.env.NODE_ENV !== 'production' && debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN === undefined)
    debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN = true;

  privateProAppCheck = initializeAppCheck(getPrivateProFirebaseApp(), {
    provider: new ReCaptchaEnterpriseProvider(privateProClientConfig.appCheckSiteKey),
    isTokenAutoRefreshEnabled: true,
  });
  return privateProAppCheck;
}

export function requirePrivateProAppCheckToken(token: string, required: boolean): string {
  if (required && !token)
    throw new Error('Firebase App Check token is required for private Pro in production.');
  return token;
}

export async function privateProGetAppCheckToken(): Promise<string> {
  const appCheck = getPrivateProClientAppCheck();
  const token = appCheck ? (await getToken(appCheck, false)).token : '';
  return requirePrivateProAppCheckToken(token, privateProClientConfig.appCheckRequired);
}
