import { execFile as execFileCallback } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';


const execFile = promisify(execFileCallback);
const DEFAULT_PROJECT_ID = 'big-agi-243b6';
const DEFAULT_DEPLOYMENT_ORIGIN = 'https://chatgpt.ashesh.dev';
const EXPECTED_BROWSER_REFERRERS = new Set(['https://chatgpt.ashesh.dev/*', 'https://big-agi-243b6.firebaseapp.com/*']);
const REQUIRED_BROWSER_API_SERVICES = new Set([
  'firebaseappcheck.googleapis.com',
  'firebaseinstallations.googleapis.com',
  'firebasestorage.googleapis.com',
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
]);
const REQUIRED_APP_CHECK_SERVICES = new Set(['firebaseauth.googleapis.com', 'firestore.googleapis.com', 'storage.googleapis.com']);
const ALLOWED_AUTH_DOMAINS = new Set(['chatgpt.ashesh.dev', 'big-agi-243b6.firebaseapp.com']);
const BROAD_ADMIN_ROLES = new Set([
  'roles/owner',
  'roles/editor',
  'roles/firebase.admin',
  'roles/firebase.sdkAdminServiceAgent',
  'roles/firebaseauth.admin',
  'roles/datastore.owner',
  'roles/storage.admin',
]);
const SERVICE_ACCOUNT_USER_ROLES = new Set([
  'roles/iam.serviceAccountAdmin',
  'roles/iam.serviceAccountUser',
]);
const RUNTIME_ROLE_ID = 'privateProRuntime';
const RUNTIME_ROLE_MANIFEST_PATH = 'infra/private-pro/gcp-runtime-role.yaml';
const PRIVATE_PRO_RUNTIME_ROLE_PERMISSIONS = new Set([
  'datastore.databases.get',
  'datastore.entities.create',
  'datastore.entities.delete',
  'datastore.entities.get',
  'datastore.entities.list',
  'datastore.entities.update',
  'firebaseauth.users.get',
  'firebaseauth.users.update',
  'storage.objects.create',
  'storage.objects.delete',
  'storage.objects.get',
]);
const FORBIDDEN_RUNTIME_PERMISSIONS = new Set([
  'apikeys.keys.create',
  'apikeys.keys.delete',
  'apikeys.keys.update',
  'firebase.projects.update',
  'firebaseauth.configs.update',
  'firebaserules.releases.create',
  'firebaserules.releases.delete',
  'firebaserules.rulesets.create',
  'firebaserules.rulesets.delete',
  'resourcemanager.projects.setIamPolicy',
  'storage.buckets.create',
  'storage.buckets.delete',
  'storage.buckets.setIamPolicy',
]);

export type AuditSeverity = 'pass' | 'warn' | 'block';

export interface AuditFinding {
  area: string;
  check: string;
  severity: AuditSeverity;
  passed: boolean;
  count: number;
}

export interface AuditReport {
  pass: boolean;
  summary: {
    pass: number;
    warn: number;
    block: number;
  };
  findings: Record<string, Record<string, {
    pass: boolean;
    warn: boolean;
    block: boolean;
    count: number;
  }>>;
}

interface HeaderFacts {
  contentSecurityPolicy: boolean;
  strictTransportSecurity: boolean;
  noSniff: boolean;
  referrerPolicy: boolean;
  permissionsPolicy: boolean;
  frameDenied: boolean;
  crossOriginOpenerPolicy: boolean;
  corsWildcard: boolean;
}

interface AuthorizedDomainFacts {
  exactMatches: number;
  stale: number;
  wildcard: number;
  missing: number;
}

interface DeploymentFacts {
  ready: boolean;
  production: boolean;
  exactAliases: number;
  staleAliases: number;
}

interface BrowserApiKeyFacts {
  total: number;
  unrestricted: number;
  missingExpectedReferrers: number;
  staleReferrers: number;
  broadReferrers: number;
  missingRequiredApiTargets: number;
  unrelatedApiTargets: number;
}

interface AppCheckFacts {
  required: number;
  enforced: number;
  missing: number;
  unenforced: number;
  unknown: number;
}

interface IamRoleFacts {
  bindings: number;
  broadAdmin: number;
  owner: number;
  editor: number;
  serviceAccountUser: number;
  runtimeRole: number;
  identityAttributed?: boolean;
  credentialSource?: RuntimeIdentityFacts['credentialSource'];
}

interface ServiceAccountKeyFacts {
  collectorReady: boolean;
  identityCount: number;
  total: number;
  userManaged: number;
  stale: number;
  disabled: number;
  credentialSource?: RuntimeIdentityFacts['credentialSource'];
  identityExplicit?: boolean;
}

export interface RuntimeIdentityFacts {
  credentialSource: 'application-default' | 'static-key-fallback' | 'invalid';
  identityCount: number;
  staticKeyFallback: boolean;
  partialStaticCredentials: boolean;
  identityExplicit: boolean;
}

interface RuntimeIdentitySelection extends RuntimeIdentityFacts {
  email?: string;
}

export interface RuntimeRoleManifestFacts {
  readable: boolean;
  missingRuntimePermissions: number;
  unexpectedRuntimePermissions: number;
  forbiddenRuntimePermissions: number;
  signBlobInRuntimeRole: number;
  signingBindingValid: boolean;
  projectSpecificPrincipals: number;
}

interface DependencyAuditFacts {
  readable: boolean;
  critical: number;
  high: number;
  moderate: number;
  low: number;
  total: number;
}

type ProbeState = 'denied' | 'allowed' | 'unknown';

interface FirebaseRuleProbeFacts {
  firestoreRead: ProbeState;
  firestoreWrite: ProbeState;
  storageRead: ProbeState;
  storageWrite: ProbeState;
}

interface JsonRecord {
  [key: string]: unknown;
}

function finding(area: string, check: string, severity: AuditSeverity, count: number): AuditFinding {
  return { area, check, severity, passed: severity === 'pass', count };
}

function booleanFinding(area: string, check: string, passed: boolean, failedSeverity: Exclude<AuditSeverity, 'pass'> = 'block'): AuditFinding {
  return finding(area, check, passed ? 'pass' : failedSeverity, passed ? 0 : 1);
}

export function classifyHeaders(facts: HeaderFacts): AuditFinding[] {
  return [
    booleanFinding('headers', 'contentSecurityPolicy', facts.contentSecurityPolicy),
    booleanFinding('headers', 'corsWildcardAbsent', !facts.corsWildcard),
    booleanFinding('headers', 'strictTransportSecurity', facts.strictTransportSecurity),
    booleanFinding('headers', 'noSniff', facts.noSniff),
    booleanFinding('headers', 'referrerPolicy', facts.referrerPolicy),
    booleanFinding('headers', 'permissionsPolicy', facts.permissionsPolicy),
    booleanFinding('headers', 'frameDenied', facts.frameDenied),
    booleanFinding('headers', 'crossOriginOpenerPolicy', facts.crossOriginOpenerPolicy),
  ];
}

export function classifyAuthorizedDomains(facts: AuthorizedDomainFacts): AuditFinding[] {
  return [
    finding('authorizedDomains', 'exact', facts.exactMatches > 0 ? 'pass' : 'block', facts.exactMatches),
    finding('authorizedDomains', 'missing', facts.missing === 0 ? 'pass' : 'block', facts.missing),
    finding('authorizedDomains', 'stale', facts.stale === 0 ? 'pass' : 'block', facts.stale),
    finding('authorizedDomains', 'wildcard', facts.wildcard === 0 ? 'pass' : 'block', facts.wildcard),
  ];
}

export function classifyDeployment(facts: DeploymentFacts): AuditFinding[] {
  return [
    booleanFinding('deployment', 'ready', facts.ready),
    booleanFinding('deployment', 'production', facts.production),
    finding('deployment', 'exactAliases', facts.exactAliases > 0 ? 'pass' : 'block', facts.exactAliases),
    finding('deployment', 'staleAliases', facts.staleAliases === 0 ? 'pass' : 'block', facts.staleAliases),
  ];
}

export function classifyBrowserApiKeys(facts: BrowserApiKeyFacts): AuditFinding[] {
  return [
    finding('browserApiKeys', 'present', facts.total > 0 ? 'pass' : 'block', facts.total),
    finding('browserApiKeys', 'restricted', facts.unrestricted === 0 ? 'pass' : 'block', facts.unrestricted),
    finding('browserApiKeys', 'missingExpectedReferrers', facts.missingExpectedReferrers === 0 ? 'pass' : 'block', facts.missingExpectedReferrers),
    finding('browserApiKeys', 'staleReferrers', facts.staleReferrers === 0 ? 'pass' : 'block', facts.staleReferrers),
    finding('browserApiKeys', 'broadReferrers', facts.broadReferrers === 0 ? 'pass' : 'block', facts.broadReferrers),
    finding('browserApiKeys', 'missingRequiredApiTargets', facts.missingRequiredApiTargets === 0 ? 'pass' : 'block', facts.missingRequiredApiTargets),
    finding('browserApiKeys', 'unrelatedApiTargets', facts.unrelatedApiTargets === 0 ? 'pass' : 'block', facts.unrelatedApiTargets),
  ];
}

export function classifyAppCheck(facts: AppCheckFacts): AuditFinding[] {
  return [
    finding('appCheck', 'required', facts.required > 0 ? 'pass' : 'block', facts.required),
    finding('appCheck', 'enforced', facts.enforced === facts.required ? 'pass' : 'block', facts.enforced),
    finding('appCheck', 'missing', facts.missing === 0 ? 'pass' : 'block', facts.missing),
    finding('appCheck', 'unenforced', facts.unenforced === 0 ? 'pass' : 'block', facts.unenforced),
    finding('appCheck', 'unknown', facts.unknown === 0 ? 'pass' : 'block', facts.unknown),
  ];
}

export function classifyIamRoles(facts: IamRoleFacts): AuditFinding[] {
  const adcUnattributed = facts.credentialSource === 'application-default' && facts.identityAttributed === false;
  return [
    finding('iam', 'identityAttributed', facts.identityAttributed === false ? (adcUnattributed ? 'warn' : 'block') : 'pass', facts.identityAttributed === false ? 1 : 0),
    finding('iam', 'bindings', facts.bindings > 0 ? 'pass' : 'warn', facts.bindings),
    finding('iam', 'runtimeRole', facts.runtimeRole === 1 ? 'pass' : adcUnattributed ? 'warn' : 'block', facts.runtimeRole),
    finding('iam', 'broadAdmin', facts.broadAdmin === 0 ? 'pass' : 'block', facts.broadAdmin),
    finding('iam', 'owner', facts.owner === 0 ? 'pass' : 'block', facts.owner),
    finding('iam', 'editor', facts.editor === 0 ? 'pass' : 'block', facts.editor),
    finding('iam', 'serviceAccountUser', facts.serviceAccountUser === 0 ? 'pass' : 'block', facts.serviceAccountUser),
  ];
}

export function classifyRuntimeIdentity(facts: RuntimeIdentityFacts): AuditFinding[] {
  const identitySeverity: AuditSeverity = facts.identityExplicit && facts.identityCount === 1
    ? 'pass'
    : facts.credentialSource === 'application-default' && !facts.partialStaticCredentials ? 'warn' : 'block';
  return [
    finding('runtimeIdentity', 'selected', identitySeverity, facts.identityCount),
    finding('runtimeIdentity', 'staticKeyFallback', facts.staticKeyFallback ? 'warn' : 'pass', facts.staticKeyFallback ? 1 : 0),
    finding('runtimeIdentity', 'partialStaticCredentials', facts.partialStaticCredentials ? 'block' : 'pass', facts.partialStaticCredentials ? 1 : 0),
  ];
}

export function classifyRuntimeRoleManifest(facts: RuntimeRoleManifestFacts): AuditFinding[] {
  return [
    booleanFinding('runtimeRoleManifest', 'readable', facts.readable),
    finding('runtimeRoleManifest', 'missingRuntimePermissions', facts.missingRuntimePermissions === 0 ? 'pass' : 'block', facts.missingRuntimePermissions),
    finding('runtimeRoleManifest', 'unexpectedRuntimePermissions', facts.unexpectedRuntimePermissions === 0 ? 'pass' : 'block', facts.unexpectedRuntimePermissions),
    finding('runtimeRoleManifest', 'forbiddenRuntimePermissions', facts.forbiddenRuntimePermissions === 0 ? 'pass' : 'block', facts.forbiddenRuntimePermissions),
    finding('runtimeRoleManifest', 'signBlobSeparated', facts.signBlobInRuntimeRole === 0 ? 'pass' : 'block', facts.signBlobInRuntimeRole),
    booleanFinding('runtimeRoleManifest', 'signingBindingValid', facts.signingBindingValid),
    finding('runtimeRoleManifest', 'projectSpecificPrincipals', facts.projectSpecificPrincipals === 0 ? 'pass' : 'block', facts.projectSpecificPrincipals),
  ];
}

export function classifyServiceAccountKeys(facts: ServiceAccountKeyFacts): AuditFinding[] {
  const adcUnattributed = facts.credentialSource === 'application-default' && facts.identityExplicit === false;
  return [
    finding('serviceAccountKeys', 'collectorReady', facts.collectorReady ? 'pass' : adcUnattributed ? 'warn' : 'block', facts.collectorReady ? 0 : 1),
    finding('serviceAccountKeys', 'identity', facts.identityCount === 1 ? 'pass' : adcUnattributed ? 'warn' : 'block', facts.identityCount),
    finding('serviceAccountKeys', 'total', facts.collectorReady && facts.identityCount === 1 ? 'pass' : adcUnattributed ? 'warn' : 'block', facts.total),
    finding('serviceAccountKeys', 'userManaged', facts.userManaged === 0 ? 'pass' : 'warn', facts.userManaged),
    finding('serviceAccountKeys', 'stale', facts.stale === 0 ? 'pass' : 'block', facts.stale),
    finding('serviceAccountKeys', 'disabled', facts.disabled === 0 ? 'pass' : 'warn', facts.disabled),
  ];
}

export function classifyDependencyAudit(facts: DependencyAuditFacts): AuditFinding[] {
  return [
    booleanFinding('dependencies', 'collectorReadable', facts.readable),
    finding('dependencies', 'critical', facts.critical === 0 ? 'pass' : 'block', facts.critical),
    finding('dependencies', 'high', facts.high === 0 ? 'pass' : 'block', facts.high),
    finding('dependencies', 'moderate', facts.moderate === 0 ? 'pass' : 'warn', facts.moderate),
    finding('dependencies', 'low', facts.low === 0 ? 'pass' : 'warn', facts.low),
    finding('dependencies', 'total', 'pass', facts.total),
  ];
}

export function classifyFirebaseRuleProbes(facts: FirebaseRuleProbeFacts): AuditFinding[] {
  const probeFinding = (resource: string, state: ProbeState) => finding(
    'firebaseRules',
    `${resource}${state === 'denied' ? 'Denied' : state === 'allowed' ? 'Allowed' : 'Unknown'}`,
    state === 'denied' ? 'pass' : 'block',
    state === 'denied' ? 0 : 1,
  );
  return [
    probeFinding('firestoreRead', facts.firestoreRead),
    probeFinding('firestoreWrite', facts.firestoreWrite),
    probeFinding('storageRead', facts.storageRead),
    probeFinding('storageWrite', facts.storageWrite),
  ];
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null ? value as JsonRecord : {};
}

function asRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveExecutable(command: string): Promise<{ file: string; prefixArgs: string[] }> {
  if (/^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)/.test(command)) return { file: command, prefixArgs: [] };
  if (process.platform !== 'win32') return { file: command, prefixArgs: [] };
  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const executable = join(entry, `${command}.exe`);
    if (await exists(executable)) return { file: executable, prefixArgs: [] };
    const commandShim = join(entry, `${command}.cmd`);
    if (!await exists(commandShim)) continue;
    if (command === 'npm') {
      const nodeExecutable = join(dirname(commandShim), 'node.exe');
      const npmCli = join(dirname(commandShim), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (await exists(nodeExecutable) && await exists(npmCli)) return { file: nodeExecutable, prefixArgs: [npmCli] };
    }
    if (command === 'gcloud') {
      const cloudRoot = join(dirname(commandShim), '..');
      const python = process.env.CLOUDSDK_PYTHON || join(cloudRoot, 'platform', 'bundledpython', 'python.exe');
      const gcloudPy = join(cloudRoot, 'lib', 'gcloud.py');
      if (await exists(python) && await exists(gcloudPy)) return { file: python, prefixArgs: [gcloudPy] };
    }
  }
  throw new Error('Required command is unavailable.');
}

export async function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const executable = await resolveExecutable(command);
  return execFile(executable.file, [...executable.prefixArgs, ...args], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
    shell: false,
  });
}

export function inspectAuthorizedDomains(value: unknown, allowedDomains = ALLOWED_AUTH_DOMAINS): AuthorizedDomainFacts {
  const domains = asStrings(asRecord(value).authorizedDomains).map(domain => domain.trim().toLowerCase()).filter(Boolean);
  const exactMatches = domains.filter(domain => allowedDomains.has(domain)).length;
  return {
    exactMatches,
    stale: domains.filter(domain => !allowedDomains.has(domain) && !domain.includes('*')).length,
    wildcard: domains.filter(domain => domain.includes('*')).length,
    missing: [...allowedDomains].filter(domain => !domains.includes(domain)).length,
  };
}

export function inspectDeployment(value: unknown): DeploymentFacts {
  const deployment = asRecord(value);
  const aliases = asStrings(deployment.aliases).map(alias => alias.trim().toLowerCase()).filter(Boolean);
  return {
    ready: deployment.readyState === 'READY',
    production: deployment.target === 'production',
    exactAliases: aliases.filter(alias => alias === 'chatgpt.ashesh.dev').length,
    staleAliases: aliases.filter(alias => alias !== 'chatgpt.ashesh.dev').length,
  };
}

function isBroadReferrer(referrer: string): boolean {
  return referrer === '*' || /^\*:\/\//.test(referrer) || /^https?:\/\/\*\./.test(referrer) || /^https?:\/\/\*\//.test(referrer);
}

export function inspectBrowserApiKeys(
  value: unknown,
  expectedReferrers = EXPECTED_BROWSER_REFERRERS,
  requiredApiServices = REQUIRED_BROWSER_API_SERVICES,
): BrowserApiKeyFacts {
  const keys = asRecords(value);
  let unrestricted = 0;
  let missingExpectedReferrers = 0;
  let staleReferrers = 0;
  let broadReferrers = 0;
  let missingRequiredApiTargets = 0;
  let unrelatedApiTargets = 0;
  for (const key of keys) {
    const restrictions = asRecord(key.restrictions);
    const browser = asRecord(restrictions.browserKeyRestrictions);
    const referrers = asStrings(browser.allowedReferrers);
    const targetServices = asRecords(restrictions.apiTargets).map(target => typeof target.service === 'string' ? target.service : '').filter(Boolean);
    if (Object.keys(restrictions).length === 0) unrestricted += 1;
    missingExpectedReferrers += [...expectedReferrers].filter(referrer => !referrers.includes(referrer)).length;
    staleReferrers += referrers.filter(referrer => !expectedReferrers.has(referrer)).length;
    broadReferrers += referrers.filter(isBroadReferrer).length;
    missingRequiredApiTargets += [...requiredApiServices].filter(service => !targetServices.includes(service)).length;
    unrelatedApiTargets += targetServices.filter(service => !requiredApiServices.has(service)).length;
  }
  return { total: keys.length, unrestricted, missingExpectedReferrers, staleReferrers, broadReferrers, missingRequiredApiTargets, unrelatedApiTargets };
}

export function inspectAppCheck(value: unknown, requiredServices = REQUIRED_APP_CHECK_SERVICES): AppCheckFacts {
  const services = asRecords(asRecord(value).services);
  const byService = new Map(services.map(service => [String(service.name).split('/').at(-1) ?? '', service.enforcementMode]));
  const modes = [...requiredServices].map(service => byService.get(service));
  const enforced = modes.filter(mode => mode === 'ENFORCED').length;
  const missing = modes.filter(mode => mode === undefined).length;
  const unenforced = modes.filter(mode => ['UNENFORCED', 'OFF'].includes(String(mode))).length;
  return { required: requiredServices.size, enforced, missing, unenforced, unknown: requiredServices.size - enforced - missing - unenforced };
}

export function inspectIamRoles(value: unknown): IamRoleFacts {
  const bindings = asRecords(asRecord(value).bindings);
  const roles = bindings.map(binding => typeof binding.role === 'string' ? binding.role : '');
  return {
    bindings: roles.length,
    broadAdmin: roles.filter(role => BROAD_ADMIN_ROLES.has(role)).length,
    owner: roles.filter(role => role === 'roles/owner').length,
    editor: roles.filter(role => role === 'roles/editor').length,
    serviceAccountUser: roles.filter(role => SERVICE_ACCOUNT_USER_ROLES.has(role)).length,
    runtimeRole: roles.filter(role => role.endsWith(`/roles/${RUNTIME_ROLE_ID}`)).length,
  };
}

function isServiceAccountEmail(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{2,62}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/.test(value);
}

function selectRuntimeIdentityForInput(accountsValue: unknown, input: {
  runtimeServiceAccountEmail?: string;
  staticClientEmail?: string;
  staticPrivateKey?: string;
}): RuntimeIdentitySelection {
  const runtimeServiceAccountEmail = input.runtimeServiceAccountEmail?.trim() ?? '';
  const staticClientEmail = input.staticClientEmail?.trim() ?? '';
  const staticPrivateKey = input.staticPrivateKey ?? '';
  const hasStaticClientEmail = !!staticClientEmail;
  const hasStaticPrivateKey = !!staticPrivateKey.trim();
  if (hasStaticClientEmail !== hasStaticPrivateKey) {
    return {
      credentialSource: 'invalid',
      identityCount: 0,
      staticKeyFallback: false,
      partialStaticCredentials: true,
      identityExplicit: false,
    };
  }
  if (hasStaticClientEmail) {
    return isServiceAccountEmail(staticClientEmail) ? {
      credentialSource: 'static-key-fallback',
      identityCount: 1,
      email: staticClientEmail,
      staticKeyFallback: true,
      partialStaticCredentials: false,
      identityExplicit: true,
    } : {
      credentialSource: 'invalid',
      identityCount: 0,
      staticKeyFallback: true,
      partialStaticCredentials: false,
      identityExplicit: true,
    };
  }
  if (runtimeServiceAccountEmail) {
    return isServiceAccountEmail(runtimeServiceAccountEmail) ? {
      credentialSource: 'application-default',
      identityCount: 1,
      email: runtimeServiceAccountEmail,
      staticKeyFallback: false,
      partialStaticCredentials: false,
      identityExplicit: true,
    } : {
      credentialSource: 'invalid',
      identityCount: 0,
      staticKeyFallback: false,
      partialStaticCredentials: false,
      identityExplicit: true,
    };
  }
  const plausible = asRecords(accountsValue)
    .map(account => typeof account.email === 'string' ? account.email : '')
    .filter(email => email.startsWith('private-pro-runtime@') && isServiceAccountEmail(email));
  return plausible.length === 1 ? {
    credentialSource: 'application-default',
    identityCount: 1,
    email: plausible[0],
    staticKeyFallback: false,
    partialStaticCredentials: false,
    identityExplicit: false,
  } : {
    credentialSource: 'application-default',
    identityCount: plausible.length,
    staticKeyFallback: false,
    partialStaticCredentials: false,
    identityExplicit: false,
  };
}

export function inspectRuntimeIdentity(accountsValue: unknown, input: {
  runtimeServiceAccountEmail?: string;
  staticClientEmail?: string;
  staticPrivateKey?: string;
}): RuntimeIdentityFacts {
  const { email: _email, ...facts } = selectRuntimeIdentityForInput(accountsValue, input);
  return facts;
}

export function inspectServiceAccountIamRoles(value: unknown, serviceAccountEmail: string): IamRoleFacts {
  const bindings = asRecords(asRecord(value).bindings).filter(binding => asStrings(binding.members).includes(`serviceAccount:${serviceAccountEmail}`));
  return inspectIamRoles({ bindings });
}

export function selectRuntimeIdentity(accountsValue: unknown, configuredEmail: string | undefined): { identityCount: number; email?: string };
export function selectRuntimeIdentity(accountsValue: unknown, input: {
  runtimeServiceAccountEmail?: string;
  staticClientEmail?: string;
  staticPrivateKey?: string;
}): RuntimeIdentitySelection;
export function selectRuntimeIdentity(accountsValue: unknown, input: string | undefined | {
  runtimeServiceAccountEmail?: string;
  staticClientEmail?: string;
  staticPrivateKey?: string;
}): { identityCount: number; email?: string } | RuntimeIdentitySelection {
  if (typeof input === 'object') return selectRuntimeIdentityForInput(accountsValue, input);
  const configuredEmail = input;
  if (configuredEmail) return isServiceAccountEmail(configuredEmail) ? { identityCount: 1, email: configuredEmail } : { identityCount: 0 };
  const plausible = asRecords(accountsValue)
    .map(account => typeof account.email === 'string' ? account.email : '')
    .filter(email => email.startsWith('firebase-adminsdk-'));
  return plausible.length === 1 ? { identityCount: 1, email: plausible[0] } : { identityCount: plausible.length };
}

function countProjectSpecificPrincipals(value: unknown): number {
  if (typeof value === 'string') {
    if (value.includes('${')) return 0;
    return /@[^\s]+\.iam\.gserviceaccount\.com$/.test(value) || /principal(?:Set)?:\/\/iam\.googleapis\.com\/projects\/\d+/.test(value) ? 1 : 0;
  }
  if (Array.isArray(value)) return value.reduce((count, item) => count + countProjectSpecificPrincipals(item), 0);
  if (typeof value === 'object' && value !== null)
    return Object.values(value).reduce((count, item) => count + countProjectSpecificPrincipals(item), 0);
  return 0;
}

export function inspectRuntimeRoleManifest(value: unknown): RuntimeRoleManifestFacts {
  const root = asRecord(value);
  const role = asRecord(root.runtimeRole);
  const signing = asRecord(root.signingBinding);
  const localVerification = asRecords(root.localVerification);
  const permissions = asStrings(role.includedPermissions);
  const permissionSet = new Set(permissions);
  const localVerificationValid = ['firebase-id-token', 'firebase-app-check-token'].every(operation => localVerification.some(item => (
    item.operation === operation && asStrings(item.requiredIamPermissions).length === 0
  )));
  const readable = root.schemaVersion === 1 && role.roleId === 'privateProRuntime' && permissions.length > 0 && localVerificationValid;
  return {
    readable,
    missingRuntimePermissions: [...PRIVATE_PRO_RUNTIME_ROLE_PERMISSIONS].filter(permission => !permissionSet.has(permission)).length,
    unexpectedRuntimePermissions: permissions.filter(permission => !PRIVATE_PRO_RUNTIME_ROLE_PERMISSIONS.has(permission)).length,
    forbiddenRuntimePermissions: permissions.filter(permission => FORBIDDEN_RUNTIME_PERMISSIONS.has(permission)).length,
    signBlobInRuntimeRole: permissions.filter(permission => permission === 'iam.serviceAccounts.signBlob').length,
    signingBindingValid: signing.permission === 'iam.serviceAccounts.signBlob'
      && signing.role === 'roles/iam.serviceAccountTokenCreator'
      && signing.serviceAccount === '${RUNTIME_SERVICE_ACCOUNT_EMAIL}'
      && signing.member === 'serviceAccount:${RUNTIME_SERVICE_ACCOUNT_EMAIL}',
    projectSpecificPrincipals: countProjectSpecificPrincipals(value),
  };
}

export function inspectServiceAccountKeys(
  value: unknown,
  nowMs: number,
  collectorReady = true,
  identityCount = 1,
  staleAfterDays = 90,
  identity?: Pick<RuntimeIdentityFacts, 'credentialSource' | 'identityExplicit'>,
): ServiceAccountKeyFacts {
  const keys = asRecords(value);
  const userManaged = keys.filter(key => key.keyType === 'USER_MANAGED');
  const cutoff = nowMs - staleAfterDays * 24 * 60 * 60 * 1000;
  const stale = userManaged.filter(key => {
    const validAfterTime = typeof key.validAfterTime === 'string' ? Date.parse(key.validAfterTime) : Number.NaN;
    return Number.isFinite(validAfterTime) && validAfterTime < cutoff;
  }).length;
  return {
    collectorReady,
    identityCount,
    total: keys.length,
    userManaged: userManaged.length,
    stale,
    disabled: keys.filter(key => key.disabled === true).length,
    ...(identity ? {
      credentialSource: identity.credentialSource,
      identityExplicit: identity.identityExplicit,
    } : {}),
  };
}

export function inspectDependencyAudit(value: unknown): DependencyAuditFacts {
  const root = asRecord(value);
  const error = asRecord(root.error);
  const vulnerabilities = asRecord(asRecord(value).metadata).vulnerabilities;
  const counts = asRecord(vulnerabilities);
  const required = ['critical', 'high', 'moderate', 'low', 'total'];
  const readable = Object.keys(error).length === 0 && required.every(name => typeof counts[name] === 'number' && Number.isInteger(counts[name]) && (counts[name] as number) >= 0);
  const number = (name: string) => readable ? counts[name] as number : 0;
  return {
    readable,
    critical: number('critical'),
    high: number('high'),
    moderate: number('moderate'),
    low: number('low'),
    total: number('total'),
  };
}

export function buildAuditReport(findings: AuditFinding[]): AuditReport {
  const summary = {
    pass: findings.filter(item => item.severity === 'pass').length,
    warn: findings.filter(item => item.severity === 'warn').length,
    block: findings.filter(item => item.severity === 'block').length,
  };
  const reportFindings: AuditReport['findings'] = {};
  for (const item of findings) {
    reportFindings[item.area] ??= {};
    reportFindings[item.area][item.check] = {
      pass: item.severity === 'pass',
      warn: item.severity === 'warn',
      block: item.severity === 'block',
      count: item.count,
    };
  }
  return { pass: summary.block === 0, summary, findings: reportFindings };
}

async function runJson(file: string, args: string[], allowFailure = false): Promise<unknown> {
  try {
    const { stdout } = await runCommand(file, args);
    return JSON.parse(stdout || '{}') as unknown;
  } catch (error) {
    if (allowFailure) {
      const stdout = asRecord(error).stdout;
      if (typeof stdout === 'string' && stdout.trim()) return JSON.parse(stdout) as unknown;
    }
    throw error;
  }
}

async function collectHeaders(origin: string): Promise<HeaderFacts> {
  const response = await fetch(origin, { redirect: 'follow' });
  const get = (name: string) => response.headers.get(name)?.trim() ?? '';
  const frameOptions = get('x-frame-options').toUpperCase();
  return {
    contentSecurityPolicy: get('content-security-policy').length > 0,
    strictTransportSecurity: get('strict-transport-security').length > 0,
    noSniff: get('x-content-type-options').toLowerCase() === 'nosniff',
    referrerPolicy: get('referrer-policy').length > 0,
    permissionsPolicy: get('permissions-policy').length > 0,
    frameDenied: frameOptions === 'DENY' || get('content-security-policy').includes("frame-ancestors 'none'"),
    crossOriginOpenerPolicy: get('cross-origin-opener-policy').length > 0,
    corsWildcard: get('access-control-allow-origin') === '*',
  };
}

async function accessToken(): Promise<string> {
  const { stdout } = await runCommand('gcloud', ['auth', 'print-access-token']);
  const token = stdout.trim();
  if (!token) throw new Error('gcloud did not return an access token.');
  return token;
}

async function collectGoogleJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${await accessToken()}` } });
  if (!response.ok) throw new Error(`Google read failed with HTTP ${response.status}.`);
  return response.json() as Promise<unknown>;
}

async function collectAuthorizedDomains(projectId: string): Promise<AuthorizedDomainFacts> {
  const value = await collectGoogleJson(`https://identitytoolkit.googleapis.com/v2/projects/${encodeURIComponent(projectId)}/config`);
  return inspectAuthorizedDomains(value);
}

async function collectDeployment(origin: string): Promise<DeploymentFacts> {
  return inspectDeployment(await runJson('vercel', ['inspect', new URL(origin).hostname, '--format=json', '--non-interactive']));
}

async function collectBrowserApiKeys(projectId: string): Promise<BrowserApiKeyFacts> {
  return inspectBrowserApiKeys(await runJson('gcloud', ['services', 'api-keys', 'list', `--project=${projectId}`, '--format=json']));
}

async function collectAppCheck(projectId: string): Promise<AppCheckFacts> {
  const value = await collectGoogleJson(`https://firebaseappcheck.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/services`);
  return inspectAppCheck(value);
}

async function collectIamRoles(projectId: string): Promise<IamRoleFacts> {
  const accounts = asRecords(await runJson('gcloud', ['iam', 'service-accounts', 'list', `--project=${projectId}`, '--format=json']));
  const identity = selectRuntimeIdentity(accounts, {
    runtimeServiceAccountEmail: process.env.PRIVATE_PRO_RUNTIME_SERVICE_ACCOUNT_EMAIL,
    staticClientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    staticPrivateKey: process.env.FIREBASE_PRIVATE_KEY,
  });
  if (identity.identityCount !== 1 || !identity.email) return {
    bindings: 0,
    broadAdmin: 0,
    owner: 0,
    editor: 0,
    serviceAccountUser: 0,
    runtimeRole: 0,
    identityAttributed: false,
    credentialSource: identity.credentialSource,
  };
  const policy = await runJson('gcloud', ['projects', 'get-iam-policy', projectId, '--format=json']);
  return {
    ...inspectServiceAccountIamRoles(policy, identity.email),
    identityAttributed: true,
    credentialSource: identity.credentialSource,
  };
}

async function collectServiceAccountKeys(projectId: string): Promise<ServiceAccountKeyFacts> {
  const accounts = asRecords(await runJson('gcloud', ['iam', 'service-accounts', 'list', `--project=${projectId}`, '--format=json']));
  const identity = selectRuntimeIdentity(accounts, {
    runtimeServiceAccountEmail: process.env.PRIVATE_PRO_RUNTIME_SERVICE_ACCOUNT_EMAIL,
    staticClientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    staticPrivateKey: process.env.FIREBASE_PRIVATE_KEY,
  });
  if (identity.identityCount !== 1 || !identity.email)
    return inspectServiceAccountKeys([], Date.now(), false, identity.identityCount, 90, identity);
  const keys = await runJson('gcloud', ['iam', 'service-accounts', 'keys', 'list', `--iam-account=${identity.email}`, `--project=${projectId}`, '--format=json']);
  return inspectServiceAccountKeys(keys, Date.now(), true, 1, 90, identity);
}

async function collectRuntimeIdentity(projectId: string): Promise<RuntimeIdentityFacts> {
  const accounts = asRecords(await runJson('gcloud', ['iam', 'service-accounts', 'list', `--project=${projectId}`, '--format=json']));
  return inspectRuntimeIdentity(accounts, {
    runtimeServiceAccountEmail: process.env.PRIVATE_PRO_RUNTIME_SERVICE_ACCOUNT_EMAIL,
    staticClientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    staticPrivateKey: process.env.FIREBASE_PRIVATE_KEY,
  });
}

async function collectRuntimeRoleManifest(): Promise<RuntimeRoleManifestFacts> {
  return inspectRuntimeRoleManifest(JSON.parse(await readFile(RUNTIME_ROLE_MANIFEST_PATH, 'utf8')) as unknown);
}

async function collectDependencyAudit(): Promise<DependencyAuditFacts> {
  return inspectDependencyAudit(await runJson('npm', ['audit', '--omit=dev', '--json'], true));
}

async function probeRead(url: string): Promise<ProbeState> {
  const response = await fetch(url, {
    method: 'GET',
  });
  if (response.status === 401 || response.status === 403) return 'denied';
  if (response.ok) return 'allowed';
  return 'unknown';
}

async function collectFirebaseRuleProbes(projectId: string, storageBucket: string): Promise<FirebaseRuleProbeFacts> {
  const marker = 'security-audit-public-probe';
  const firestoreDocument = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${marker}/probe`;
  const storageObject = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(storageBucket)}/o/${encodeURIComponent(`${marker}/probe`)}`;
  return {
    firestoreRead: await probeRead(firestoreDocument),
    firestoreWrite: 'unknown',
    storageRead: await probeRead(storageObject),
    storageWrite: 'unknown',
  };
}

function validateProjectId(value: string): string {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value)) throw new Error('Invalid Firebase project ID.');
  return value;
}

function validateBucket(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(value)) throw new Error('Invalid Firebase storage bucket.');
  return value;
}

async function collectReport(): Promise<AuditReport> {
  const projectId = validateProjectId(process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim() || DEFAULT_PROJECT_ID);
  const deploymentOrigin = process.env.PRIVATE_PRO_AUDIT_ORIGIN?.trim() || DEFAULT_DEPLOYMENT_ORIGIN;
  const storageBucket = validateBucket(process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET?.trim() || `${projectId}.firebasestorage.app`);
  const tasks: Array<Promise<AuditFinding[]>> = [
    collectHeaders(deploymentOrigin).then(classifyHeaders),
    collectDeployment(deploymentOrigin).then(classifyDeployment),
    collectAuthorizedDomains(projectId).then(classifyAuthorizedDomains),
    collectBrowserApiKeys(projectId).then(classifyBrowserApiKeys),
    collectAppCheck(projectId).then(classifyAppCheck),
    collectIamRoles(projectId).then(classifyIamRoles),
    collectRuntimeIdentity(projectId).then(classifyRuntimeIdentity),
    collectRuntimeRoleManifest().then(classifyRuntimeRoleManifest),
    collectServiceAccountKeys(projectId).then(classifyServiceAccountKeys),
    collectDependencyAudit().then(classifyDependencyAudit),
    collectFirebaseRuleProbes(projectId, storageBucket).then(classifyFirebaseRuleProbes),
  ];
  const areas = ['headers', 'deployment', 'authorizedDomains', 'browserApiKeys', 'appCheck', 'iam', 'runtimeIdentity', 'runtimeRoleManifest', 'serviceAccountKeys', 'dependencies', 'firebaseRules'];
  const results = await Promise.allSettled(tasks);
  const findings = results.flatMap((result, index) => result.status === 'fulfilled'
    ? result.value
    : [finding(areas[index], 'collectorReadable', 'block', 1)]);
  return buildAuditReport(findings);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if ([...args].some(arg => arg !== '--report-only')) throw new Error('Usage: security-audit.ts [--report-only]');
  const report = await collectReport();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.pass && !args.has('--report-only')) process.exitCode = 1;
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint)
  void main().catch(() => {
    process.stdout.write(`${JSON.stringify(buildAuditReport([finding('audit', 'completed', 'block', 1)]), null, 2)}\n`);
    process.exitCode = 1;
  });
