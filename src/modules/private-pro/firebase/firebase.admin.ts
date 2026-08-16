import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAppCheck } from 'firebase-admin/app-check';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

import { getPrivateProServerConfig } from '../config/privatePro.config.server';


let privateProAdminApp: App | undefined;

function getPrivateProAdminApp(): App {
  if (privateProAdminApp) return privateProAdminApp;

  const config = getPrivateProServerConfig();
  const missing = [
    !config.firebase.projectId && 'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
    !config.firebase.clientEmail && 'FIREBASE_CLIENT_EMAIL',
    !config.firebase.privateKey && 'FIREBASE_PRIVATE_KEY',
    !config.firebase.storageBucket && 'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
  ].filter(Boolean);
  if (missing.length)
    throw new Error(`Private Pro Firebase Admin is missing: ${missing.join(', ')}`);

  privateProAdminApp = getApps().find(app => app.name === 'private-pro') ?? initializeApp({
    credential: cert({
      projectId: config.firebase.projectId,
      clientEmail: config.firebase.clientEmail,
      privateKey: config.firebase.privateKey,
    }),
    storageBucket: config.firebase.storageBucket,
  }, 'private-pro');
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

export function getPrivateProStorageBucket() {
  return getStorage(getPrivateProAdminApp()).bucket();
}
