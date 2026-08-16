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

let cachedConfig: PrivateProServerConfig | undefined;

export function getPrivateProServerConfig(): PrivateProServerConfig {
  if (cachedConfig) return cachedConfig;

  const enabled = env.NEXT_PUBLIC_PRIVATE_PRO_ENABLED === 'true';
  const allowedEmails = parsePrivateProAllowlist(env.PRIVATE_PRO_ALLOWED_EMAILS);
  if (enabled && allowedEmails.size === 0)
    throw new Error('PRIVATE_PRO_ALLOWED_EMAILS is required when private Pro is enabled.');

  cachedConfig = {
    enabled,
    allowedEmails,
    firebase: {
      projectId: env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? '',
      clientEmail: env.FIREBASE_CLIENT_EMAIL ?? '',
      privateKey: (env.FIREBASE_PRIVATE_KEY ?? '').replaceAll('\\n', '\n'),
      storageBucket: env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? '',
    },
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
    appCheckEnforced: enabled && !!env.NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY,
  };

  return cachedConfig;
}
