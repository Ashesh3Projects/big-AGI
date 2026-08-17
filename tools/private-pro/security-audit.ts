import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';


const execFile = promisify(execFileCallback);
const DEFAULT_PROJECT_ID = 'big-agi-243b6';
const DEFAULT_DEPLOYMENT_ORIGIN = 'https://chatgpt.ashesh.dev';
const ALLOWED_AUTH_DOMAINS = new Set(['chatgpt.ashesh.dev', 'big-agi-243b6.firebaseapp.com']);
const BROAD_ADMIN_ROLES = new Set([
  'roles/owner',
  'roles/editor',
  'roles/firebase.admin',
  'roles/firebaseauth.admin',
  'roles/datastore.owner',
  'roles/storage.admin',
]);
const SERVICE_ACCOUNT_USER_ROLES = new Set([
  'roles/iam.serviceAccountAdmin',
  'roles/iam.serviceAccountTokenCreator',
  'roles/iam.serviceAccountUser',
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
  missingReferrerRestrictions: number;
  missingApiTargets: number;
}

interface AppCheckFacts {
  total: number;
  enforced: number;
  unenforced: number;
  unknown: number;
}

interface IamRoleFacts {
  bindings: number;
  broadAdmin: number;
  owner: number;
  editor: number;
  serviceAccountUser: number;
}

interface ServiceAccountKeyFacts {
  total: number;
  userManaged: number;
  stale: number;
  disabled: number;
}

interface DependencyAuditFacts {
  critical: number;
  high: number;
  moderate: number;
  low: number;
  total: number;
}

interface FirebaseRuleProbeFacts {
  firestoreReadDenied: boolean;
  firestoreWriteDenied: boolean;
  storageReadDenied: boolean;
  storageWriteDenied: boolean;
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
    finding('browserApiKeys', 'referrerRestrictions', facts.missingReferrerRestrictions === 0 ? 'pass' : 'block', facts.missingReferrerRestrictions),
    finding('browserApiKeys', 'apiTargets', facts.missingApiTargets === 0 ? 'pass' : 'block', facts.missingApiTargets),
  ];
}

export function classifyAppCheck(facts: AppCheckFacts): AuditFinding[] {
  return [
    finding('appCheck', 'services', facts.total > 0 ? 'pass' : 'block', facts.total),
    finding('appCheck', 'enforcement', facts.total > 0 && facts.unenforced === 0 ? 'pass' : 'block', facts.unenforced),
    finding('appCheck', 'unknown', facts.unknown === 0 ? 'pass' : 'warn', facts.unknown),
  ];
}

export function classifyIamRoles(facts: IamRoleFacts): AuditFinding[] {
  return [
    finding('iam', 'bindings', facts.bindings > 0 ? 'pass' : 'warn', facts.bindings),
    finding('iam', 'broadAdmin', facts.broadAdmin === 0 ? 'pass' : 'block', facts.broadAdmin),
    finding('iam', 'owner', facts.owner === 0 ? 'pass' : 'block', facts.owner),
    finding('iam', 'editor', facts.editor === 0 ? 'pass' : 'block', facts.editor),
    finding('iam', 'serviceAccountUser', facts.serviceAccountUser === 0 ? 'pass' : 'warn', facts.serviceAccountUser),
  ];
}

export function classifyServiceAccountKeys(facts: ServiceAccountKeyFacts): AuditFinding[] {
  return [
    finding('serviceAccountKeys', 'total', facts.total >= 0 ? 'pass' : 'block', facts.total),
    finding('serviceAccountKeys', 'userManaged', facts.userManaged === 0 ? 'pass' : 'warn', facts.userManaged),
    finding('serviceAccountKeys', 'stale', facts.stale === 0 ? 'pass' : 'block', facts.stale),
    finding('serviceAccountKeys', 'disabled', facts.disabled === 0 ? 'pass' : 'warn', facts.disabled),
  ];
}

export function classifyDependencyAudit(facts: DependencyAuditFacts): AuditFinding[] {
  return [
    finding('dependencies', 'critical', facts.critical === 0 ? 'pass' : 'block', facts.critical),
    finding('dependencies', 'high', facts.high === 0 ? 'pass' : 'block', facts.high),
    finding('dependencies', 'moderate', facts.moderate === 0 ? 'pass' : 'warn', facts.moderate),
    finding('dependencies', 'low', facts.low === 0 ? 'pass' : 'warn', facts.low),
    finding('dependencies', 'total', 'pass', facts.total),
  ];
}

export function classifyFirebaseRuleProbes(facts: FirebaseRuleProbeFacts): AuditFinding[] {
  return [
    booleanFinding('firebaseRules', 'firestoreReadDenied', facts.firestoreReadDenied),
    booleanFinding('firebaseRules', 'firestoreWriteDenied', facts.firestoreWriteDenied),
    booleanFinding('firebaseRules', 'storageReadDenied', facts.storageReadDenied),
    booleanFinding('firebaseRules', 'storageWriteDenied', facts.storageWriteDenied),
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

export function auditCommand(command: string, args: string[], platform = process.platform, commandShell = process.env.ComSpec): { file: string; args: string[] } {
  return platform === 'win32'
    ? { file: commandShell || 'cmd.exe', args: ['/d', '/s', '/c', `${command}.cmd`, ...args] }
    : { file: command, args };
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

export function inspectBrowserApiKeys(value: unknown): BrowserApiKeyFacts {
  const keys = asRecords(value);
  let unrestricted = 0;
  let missingReferrerRestrictions = 0;
  let missingApiTargets = 0;
  for (const key of keys) {
    const restrictions = asRecord(key.restrictions);
    const browser = asRecord(restrictions.browserKeyRestrictions);
    const referrers = asStrings(browser.allowedReferrers);
    const targets = asRecords(restrictions.apiTargets);
    if (Object.keys(restrictions).length === 0) unrestricted += 1;
    if (referrers.length === 0) missingReferrerRestrictions += 1;
    if (targets.length === 0) missingApiTargets += 1;
  }
  return { total: keys.length, unrestricted, missingReferrerRestrictions, missingApiTargets };
}

export function inspectAppCheck(value: unknown): AppCheckFacts {
  const services = asRecords(asRecord(value).services);
  const enforced = services.filter(service => service.enforcementMode === 'ENFORCED').length;
  const unenforced = services.filter(service => ['UNENFORCED', 'OFF'].includes(String(service.enforcementMode))).length;
  return { total: services.length, enforced, unenforced, unknown: services.length - enforced - unenforced };
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
  };
}

export function inspectServiceAccountIamRoles(value: unknown, serviceAccountEmail: string): IamRoleFacts {
  const bindings = asRecords(asRecord(value).bindings).filter(binding => asStrings(binding.members).includes(`serviceAccount:${serviceAccountEmail}`));
  return inspectIamRoles({ bindings });
}

export function inspectServiceAccountKeys(value: unknown, nowMs: number, staleAfterDays = 90): ServiceAccountKeyFacts {
  const keys = asRecords(value);
  const userManaged = keys.filter(key => key.keyType === 'USER_MANAGED');
  const cutoff = nowMs - staleAfterDays * 24 * 60 * 60 * 1000;
  const stale = userManaged.filter(key => {
    const validAfterTime = typeof key.validAfterTime === 'string' ? Date.parse(key.validAfterTime) : Number.NaN;
    return Number.isFinite(validAfterTime) && validAfterTime < cutoff;
  }).length;
  return {
    total: keys.length,
    userManaged: userManaged.length,
    stale,
    disabled: keys.filter(key => key.disabled === true).length,
  };
}

export function inspectDependencyAudit(value: unknown): DependencyAuditFacts {
  const vulnerabilities = asRecord(asRecord(value).metadata).vulnerabilities;
  const counts = asRecord(vulnerabilities);
  const number = (name: string) => typeof counts[name] === 'number' ? counts[name] as number : 0;
  return {
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
  const command = auditCommand(file, args);
  try {
    const { stdout } = await execFile(command.file, command.args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, windowsHide: true });
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
  const command = auditCommand('gcloud', ['auth', 'print-access-token']);
  const { stdout } = await execFile(command.file, command.args, { encoding: 'utf8', windowsHide: true });
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
  const serviceAccountEmail = accounts
    .map(account => typeof account.email === 'string' ? account.email : '')
    .find(email => email.startsWith('firebase-adminsdk-'));
  if (!serviceAccountEmail) return { bindings: 0, broadAdmin: 0, owner: 0, editor: 0, serviceAccountUser: 0 };
  const policy = await runJson('gcloud', ['projects', 'get-iam-policy', projectId, '--format=json']);
  return inspectServiceAccountIamRoles(policy, serviceAccountEmail);
}

async function collectServiceAccountKeys(projectId: string): Promise<ServiceAccountKeyFacts> {
  const accounts = asRecords(await runJson('gcloud', ['iam', 'service-accounts', 'list', `--project=${projectId}`, '--format=json']));
  const targetAccounts = accounts.filter(account => typeof account.email === 'string' && account.email.startsWith('firebase-adminsdk-'));
  const keys: JsonRecord[] = [];
  for (const account of targetAccounts) {
    const email = account.email as string;
    keys.push(...asRecords(await runJson('gcloud', ['iam', 'service-accounts', 'keys', 'list', `--iam-account=${email}`, `--project=${projectId}`, '--format=json'])));
  }
  return inspectServiceAccountKeys(keys, Date.now());
}

async function collectDependencyAudit(): Promise<DependencyAuditFacts> {
  return inspectDependencyAudit(await runJson('npm', ['audit', '--omit=dev', '--json'], true));
}

async function requestDenied(url: string): Promise<boolean> {
  const response = await fetch(url, {
    method: 'GET',
  });
  return response.status === 401 || response.status === 403;
}

async function collectFirebaseRuleProbes(projectId: string, storageBucket: string): Promise<FirebaseRuleProbeFacts> {
  const marker = 'security-audit-public-probe';
  const firestoreDocument = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${marker}/probe`;
  const storageObject = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(storageBucket)}/o/${encodeURIComponent(`${marker}/probe`)}`;
  return {
    firestoreReadDenied: await requestDenied(firestoreDocument),
    firestoreWriteDenied: false,
    storageReadDenied: await requestDenied(storageObject),
    storageWriteDenied: false,
  };
}

async function collectReport(): Promise<AuditReport> {
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim() || DEFAULT_PROJECT_ID;
  const deploymentOrigin = process.env.PRIVATE_PRO_AUDIT_ORIGIN?.trim() || DEFAULT_DEPLOYMENT_ORIGIN;
  const storageBucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET?.trim() || `${projectId}.firebasestorage.app`;
  const tasks: Array<Promise<AuditFinding[]>> = [
    collectHeaders(deploymentOrigin).then(classifyHeaders),
    collectDeployment(deploymentOrigin).then(classifyDeployment),
    collectAuthorizedDomains(projectId).then(classifyAuthorizedDomains),
    collectBrowserApiKeys(projectId).then(classifyBrowserApiKeys),
    collectAppCheck(projectId).then(classifyAppCheck),
    collectIamRoles(projectId).then(classifyIamRoles),
    collectServiceAccountKeys(projectId).then(classifyServiceAccountKeys),
    collectDependencyAudit().then(classifyDependencyAudit),
    collectFirebaseRuleProbes(projectId, storageBucket).then(classifyFirebaseRuleProbes),
  ];
  const areas = ['headers', 'deployment', 'authorizedDomains', 'browserApiKeys', 'appCheck', 'iam', 'serviceAccountKeys', 'dependencies', 'firebaseRules'];
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
