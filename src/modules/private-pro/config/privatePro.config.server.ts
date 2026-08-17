import { env } from '~/server/env.server';

import {
  PRIVATE_PRO_ATTACHMENT_QUOTA_BYTES,
  PRIVATE_PRO_MAX_FILE_BYTES,
  PRIVATE_PRO_UPLOAD_RATE_MAX_BYTES,
  PRIVATE_PRO_UPLOAD_RATE_MAX_REQUESTS,
  PRIVATE_PRO_UPLOAD_RATE_WINDOW_MS,
} from './privatePro.config';


export function normalizePrivateProEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function parsePrivateProAllowlist(raw: string | undefined): ReadonlySet<string> {
  const emails = (raw ?? '')
    .split(',')
    .map(normalizePrivateProEmail)
    .filter(Boolean);
  return new Set(emails);
}

export function isPrivateProEmailAllowed(email: string, allowlist: ReadonlySet<string>): boolean {
  return allowlist.has(normalizePrivateProEmail(email));
}

export function parsePrivateProPositiveInteger(raw: string | undefined, fallback: number, label: string): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

export interface PrivateProServerConfig {
  enabled: boolean;
  allowedEmails: ReadonlySet<string>;
  firebase: {
    projectId: string;
    clientEmail: string;
    privateKey: string;
    storageBucket: string;
  };
  attachmentQuotaBytes: number;
  maxFileBytes: number;
  uploadRateLimit: {
    windowMs: number;
    maxRequests: number;
    maxBytes: number;
  };
  appCheckEnforced: boolean;
}

export interface PrivateProServerConfigInput {
  enabled: boolean;
  nodeEnv: string | undefined;
  allowedEmails: string | undefined;
  firebaseProjectId: string | undefined;
  firebaseClientEmail: string | undefined;
  firebasePrivateKey: string | undefined;
  firebaseStorageBucket: string | undefined;
  appCheckSiteKey: string | undefined;
}

export function parsePrivateProServerConfig(input: PrivateProServerConfigInput): PrivateProServerConfig {
  const allowedEmails = parsePrivateProAllowlist(input.allowedEmails);
  if (input.enabled && allowedEmails.size === 0)
    throw new Error('PRIVATE_PRO_ALLOWED_EMAILS is required when private Pro is enabled.');

  const appCheckSiteKey = input.appCheckSiteKey?.trim() ?? '';
  if (input.enabled && input.nodeEnv === 'production' && !appCheckSiteKey)
    throw new Error('Firebase App Check is required when private Pro is enabled in production.');

  return {
    enabled: input.enabled,
    allowedEmails,
    firebase: {
      projectId: input.firebaseProjectId ?? '',
      clientEmail: input.firebaseClientEmail ?? '',
      privateKey: (input.firebasePrivateKey ?? '').replaceAll('\\n', '\n'),
      storageBucket: input.firebaseStorageBucket ?? '',
    },
    attachmentQuotaBytes: PRIVATE_PRO_ATTACHMENT_QUOTA_BYTES,
    maxFileBytes: PRIVATE_PRO_MAX_FILE_BYTES,
    uploadRateLimit: {
      windowMs: PRIVATE_PRO_UPLOAD_RATE_WINDOW_MS,
      maxRequests: PRIVATE_PRO_UPLOAD_RATE_MAX_REQUESTS,
      maxBytes: PRIVATE_PRO_UPLOAD_RATE_MAX_BYTES,
    },
    appCheckEnforced: input.enabled && !!appCheckSiteKey,
  };
}

let cachedConfig: PrivateProServerConfig | undefined;

export function getPrivateProServerConfig(): PrivateProServerConfig {
  if (cachedConfig) return cachedConfig;

  const parsedConfig = parsePrivateProServerConfig({
    enabled: env.NEXT_PUBLIC_PRIVATE_PRO_ENABLED === 'true',
    nodeEnv: process.env.NODE_ENV,
    allowedEmails: env.PRIVATE_PRO_ALLOWED_EMAILS,
    firebaseProjectId: env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    firebaseClientEmail: env.FIREBASE_CLIENT_EMAIL,
    firebasePrivateKey: env.FIREBASE_PRIVATE_KEY,
    firebaseStorageBucket: env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    appCheckSiteKey: env.NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY,
  });

  cachedConfig = {
    ...parsedConfig,
    attachmentQuotaBytes: parsePrivateProPositiveInteger(
      env.PRIVATE_PRO_ATTACHMENT_QUOTA_BYTES,
      PRIVATE_PRO_ATTACHMENT_QUOTA_BYTES,
      'PRIVATE_PRO_ATTACHMENT_QUOTA_BYTES',
    ),
    maxFileBytes: parsePrivateProPositiveInteger(
      env.PRIVATE_PRO_MAX_FILE_BYTES,
      PRIVATE_PRO_MAX_FILE_BYTES,
      'PRIVATE_PRO_MAX_FILE_BYTES',
    ),
    uploadRateLimit: {
      windowMs: parsePrivateProPositiveInteger(env.PRIVATE_PRO_UPLOAD_RATE_WINDOW_MS, PRIVATE_PRO_UPLOAD_RATE_WINDOW_MS, 'PRIVATE_PRO_UPLOAD_RATE_WINDOW_MS'),
      maxRequests: parsePrivateProPositiveInteger(env.PRIVATE_PRO_UPLOAD_RATE_MAX_REQUESTS, PRIVATE_PRO_UPLOAD_RATE_MAX_REQUESTS, 'PRIVATE_PRO_UPLOAD_RATE_MAX_REQUESTS'),
      maxBytes: parsePrivateProPositiveInteger(env.PRIVATE_PRO_UPLOAD_RATE_MAX_BYTES, PRIVATE_PRO_UPLOAD_RATE_MAX_BYTES, 'PRIVATE_PRO_UPLOAD_RATE_MAX_BYTES'),
    },
  };

  return cachedConfig;
}
