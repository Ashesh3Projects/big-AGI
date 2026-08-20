import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { getToken, initializeAppCheck, ReCaptchaEnterpriseProvider, type AppCheck } from 'firebase/app-check';
import { getAuth, type Auth } from 'firebase/auth';
import { getFirestore, initializeFirestore, memoryLocalCache, type Firestore } from 'firebase/firestore';
import { getStorage, type FirebaseStorage } from 'firebase/storage';

import { privateProClientConfig, privateProClientConfigComplete } from '../config/privatePro.config';


let privateProFirebaseApp: FirebaseApp | undefined;
let privateProAppCheck: AppCheck | null | undefined;
let privateProFirestore: Firestore | undefined;
let privateProStorage: FirebaseStorage | undefined;

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

export function privateProInitializeAppCheckBeforeAuth<TAppCheck, TAuth>(
  initializeAppCheck: () => TAppCheck,
  initializeAuth: () => TAuth,
): TAuth {
  initializeAppCheck();
  return initializeAuth();
}

export function getPrivateProFirebaseAuth(): Auth {
  return privateProInitializeAppCheckBeforeAuth(
    getPrivateProClientAppCheck,
    () => getAuth(getPrivateProFirebaseApp()),
  );
}

export function getPrivateProClientFirestore(): Firestore {
  if (privateProFirestore) return privateProFirestore;
  const app = getPrivateProFirebaseApp();
  getPrivateProClientAppCheck();
  try {
    return privateProFirestore = initializeFirestore(app, { localCache: memoryLocalCache() });
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'failed-precondition') throw error;
    return privateProFirestore = getFirestore(app);
  }
}

export function getPrivateProClientStorage(): FirebaseStorage {
  if (privateProStorage) return privateProStorage;
  const app = getPrivateProFirebaseApp();
  getPrivateProClientAppCheck();
  return privateProStorage = getStorage(app);
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
