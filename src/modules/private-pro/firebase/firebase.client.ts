import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaV3Provider, type AppCheck } from 'firebase/app-check';
import { getAuth, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';

import { privateProClientConfig, privateProClientConfigComplete } from '../config/privatePro.config';


let privateProFirebaseApp: FirebaseApp | undefined;
let privateProAppCheck: AppCheck | null | undefined;

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

  privateProAppCheck = initializeAppCheck(getPrivateProFirebaseApp(), {
    provider: new ReCaptchaV3Provider(privateProClientConfig.appCheckSiteKey),
    isTokenAutoRefreshEnabled: true,
  });
  return privateProAppCheck;
}
