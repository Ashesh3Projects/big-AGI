import { env } from '~/server/env.server';


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

export interface PrivateProServerConfig {
  enabled: boolean;
  allowedEmails: ReadonlySet<string>;
  firebase: {
    projectId: string;
    clientEmail?: string;
    privateKey?: string;
    credentialSource: PrivateProFirebaseCredentialSource;
  };
  appCheckEnforced: boolean;
}

export type PrivateProFirebaseCredentialSource = 'application-default' | 'static-key-fallback';

export interface PrivateProServerConfigInput {
  enabled: boolean;
  nodeEnv: string | undefined;
  allowedEmails: string | undefined;
  firebaseProjectId: string | undefined;
  firebaseClientEmail: string | undefined;
  firebasePrivateKey: string | undefined;
  appCheckSiteKey: string | undefined;
}

export function classifyPrivateProFirebaseCredentialSource(
  clientEmail: string | undefined,
  privateKey: string | undefined,
): PrivateProFirebaseCredentialSource {
  const hasClientEmail = !!clientEmail;
  const hasPrivateKey = !!privateKey;
  if (hasClientEmail !== hasPrivateKey)
    throw new Error('FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY must be provided together.');
  return hasClientEmail ? 'static-key-fallback' : 'application-default';
}

export function parsePrivateProServerConfig(input: PrivateProServerConfigInput): PrivateProServerConfig {
  const allowedEmails = parsePrivateProAllowlist(input.allowedEmails);
  if (input.enabled && allowedEmails.size === 0)
    throw new Error('PRIVATE_PRO_ALLOWED_EMAILS is required when private Pro is enabled.');

  const appCheckSiteKey = input.appCheckSiteKey?.trim() ?? '';
  if (input.enabled && input.nodeEnv === 'production' && !appCheckSiteKey)
    throw new Error('Firebase App Check is required when private Pro is enabled in production.');

  const clientEmail = input.firebaseClientEmail?.trim() || undefined;
  const expandedPrivateKey = (input.firebasePrivateKey ?? '').replaceAll('\\n', '\n');
  const privateKey = expandedPrivateKey.trim() ? expandedPrivateKey : undefined;
  const credentialSource = classifyPrivateProFirebaseCredentialSource(clientEmail, privateKey);

  return {
    enabled: input.enabled,
    allowedEmails,
    firebase: {
      projectId: input.firebaseProjectId ?? '',
      clientEmail,
      privateKey,
      credentialSource,
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
    appCheckSiteKey: env.NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY,
  });

  cachedConfig = parsedConfig;

  return cachedConfig;
}
