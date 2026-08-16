import { FirebaseError } from 'firebase/app';
import { getToken as getAppCheckToken } from 'firebase/app-check';
import {
  browserLocalPersistence,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from 'firebase/auth';

import { privateProClientConfig } from '../config/privatePro.config';
import { getPrivateProClientAppCheck, getPrivateProFirebaseAuth } from '../firebase/firebase.client';


export function privateProOnAuthStateChanged(callback: (user: User | null) => void): () => void {
  if (!privateProClientConfig.enabled) {
    callback(null);
    return () => undefined;
  }
  return onAuthStateChanged(getPrivateProFirebaseAuth(), callback);
}

export async function privateProSignInWithGoogle(): Promise<void> {
  const auth = getPrivateProFirebaseAuth();
  await setPersistence(auth, browserLocalPersistence);
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await signInWithPopup(auth, provider);
  } catch (error) {
    if (error instanceof FirebaseError && ['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(error.code)) {
      await signInWithRedirect(auth, provider);
      return;
    }
    throw error;
  }
}

export async function privateProSignOut(): Promise<void> {
  await signOut(getPrivateProFirebaseAuth());
}

export async function privateProRefreshIdToken(): Promise<string> {
  const user = getPrivateProFirebaseAuth().currentUser;
  if (!user) throw new Error('No signed-in Firebase user.');
  return user.getIdToken(true);
}

export async function privateProGetRequestHeaders(): Promise<Record<string, string>> {
  if (!privateProClientConfig.enabled) return {};
  const user = getPrivateProFirebaseAuth().currentUser;
  if (!user) return {};

  const appCheck = getPrivateProClientAppCheck();
  const appCheckToken = appCheck ? (await getAppCheckToken(appCheck, false)).token : '';
  return {
    authorization: `Bearer ${await user.getIdToken()}`,
    ...(appCheckToken && { 'x-firebase-appcheck': appCheckToken }),
  };
}
