export const PRIVATE_PRO_ATTACHMENT_QUOTA_BYTES = 1024 * 1024 * 1024;
export const PRIVATE_PRO_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const PRIVATE_PRO_CHAT_CHUNK_BYTES = 180 * 1024;
export const PRIVATE_PRO_UPLOAD_RATE_WINDOW_MS = 60 * 1000;
export const PRIVATE_PRO_UPLOAD_RATE_MAX_REQUESTS = 30;
export const PRIVATE_PRO_UPLOAD_RATE_MAX_BYTES = 256 * 1024 * 1024;


export const privateProClientConfig = {
  enabled: process.env.NEXT_PUBLIC_PRIVATE_PRO_ENABLED === 'true',
  firebase: {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? '',
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? '',
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? '',
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? '',
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? '',
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? '',
  },
  appCheckSiteKey: process.env.NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY ?? '',
} as const;


export function privateProClientConfigComplete(): boolean {
  const { firebase } = privateProClientConfig;
  return !privateProClientConfig.enabled || !!(
    firebase.apiKey &&
    firebase.authDomain &&
    firebase.projectId &&
    firebase.storageBucket &&
    firebase.messagingSenderId &&
    firebase.appId
  );
}
