import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyAppCheck,
  classifyAuthorizedDomains,
  classifyBrowserApiKeys,
  classifyDependencyAudit,
  classifyDeployment,
  classifyFirebaseRuleProbes,
  classifyHeaders,
  classifyIamRoles,
  classifyRuntimeIdentity,
  classifyRuntimeRoleManifest,
  classifyServiceAccountKeys,
  runCommand,
  selectRuntimeIdentity,
  buildAuditReport,
  inspectAppCheck,
  inspectAuthorizedDomains,
  inspectBrowserApiKeys,
  inspectDependencyAudit,
  inspectDeployment,
  inspectIamRoles,
  inspectRuntimeIdentity,
  inspectRuntimeRoleManifest,
  inspectServiceAccountKeys,
  inspectServiceAccountIamRoles,
  type AuditFinding,
} from './security-audit';

import * as securityAuditModule from './security-audit';


function severities(findings: AuditFinding[]) {
  return findings.map(finding => finding.severity);
}

describe('private Pro security audit classifiers', () => {
  test('passes shell metacharacters as one argument without executing them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'private-pro-audit-'));
    const script = join(directory, 'echo-args.ps1');
    const sideEffect = join(directory, 'injected.txt');
    await writeFile(script, '$args | ConvertTo-Json -Compress\n', 'utf8');

    const argument = `safe&Set-Content -LiteralPath '${sideEffect}' injected`;
    const result = await runCommand(process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, argument]);

    assert.equal(JSON.parse(result.stdout), argument);
    await assert.rejects(readFile(sideEffect, 'utf8'));
  });

  test('blocks wildcard CORS and missing CSP headers', () => {
    const findings = classifyHeaders({
      contentSecurityPolicy: false,
      strictTransportSecurity: true,
      noSniff: true,
      referrerPolicy: true,
      permissionsPolicy: true,
      frameDenied: true,
      crossOriginOpenerPolicy: true,
      corsWildcard: true,
    });

    assert.deepEqual(severities(findings), ['block', 'block', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
  });

  test('blocks stale or wildcard authorized domains without exposing domain values', () => {
    const findings = classifyAuthorizedDomains({ exactMatches: 2, stale: 1, wildcard: 1, missing: 0 });

    assert.deepEqual(findings, [
      { area: 'authorizedDomains', check: 'exact', severity: 'pass', passed: true, count: 2 },
      { area: 'authorizedDomains', check: 'missing', severity: 'pass', passed: true, count: 0 },
      { area: 'authorizedDomains', check: 'stale', severity: 'block', passed: false, count: 1 },
      { area: 'authorizedDomains', check: 'wildcard', severity: 'block', passed: false, count: 1 },
    ]);
  });

  test('blocks a non-ready deployment and stale production aliases', () => {
    const findings = classifyDeployment({ ready: false, production: true, exactAliases: 1, staleAliases: 2 });

    assert.deepEqual(severities(findings), ['block', 'pass', 'pass', 'block']);
  });

  test('blocks an unrestricted browser API key', () => {
    const findings = classifyBrowserApiKeys({ total: 1, unrestricted: 1, missingExpectedReferrers: 2, staleReferrers: 0, broadReferrers: 1, missingRequiredApiTargets: 2, unrelatedApiTargets: 0 });

    assert.deepEqual(severities(findings), ['pass', 'block', 'block', 'pass', 'block', 'block', 'pass']);
  });

  test('requires exact browser referrers and only explicit API services', () => {
    assert.deepEqual(inspectBrowserApiKeys([{ restrictions: {
      browserKeyRestrictions: { allowedReferrers: ['https://chatgpt.ashesh.dev/*', 'https://*.ashesh.dev/*', 'https://old.example.com/*'] },
      apiTargets: [{ service: 'identitytoolkit.googleapis.com' }, { service: 'maps.googleapis.com' }],
    } }], new Set(['https://chatgpt.ashesh.dev/*', 'https://big-agi-243b6.firebaseapp.com/*']), new Set(['identitytoolkit.googleapis.com', 'securetoken.googleapis.com'])), {
      total: 1,
      unrestricted: 0,
      missingExpectedReferrers: 1,
      staleReferrers: 2,
      broadReferrers: 1,
      missingRequiredApiTargets: 1,
      unrelatedApiTargets: 1,
    });
  });

  test('blocks disabled App Check enforcement', () => {
    const findings = classifyAppCheck({ required: 3, enforced: 0, missing: 1, unenforced: 1, unknown: 1 });

    assert.deepEqual(severities(findings), ['pass', 'block', 'block', 'block', 'block']);
  });

  test('passes App Check only when every required service is explicitly enforced', () => {
    const required = new Set(['identitytoolkit.googleapis.com', 'firestore.googleapis.com']);
    assert.deepEqual(inspectAppCheck({ services: [
      { name: 'projects/1/services/identitytoolkit.googleapis.com', enforcementMode: 'ENFORCED' },
      { name: 'projects/1/services/firestore.googleapis.com', enforcementMode: 'ENFORCED' },
    ] }, required), { required: 2, enforced: 2, missing: 0, unenforced: 0, unknown: 0 });
    assert.equal(classifyAppCheck({ required: 2, enforced: 2, missing: 0, unenforced: 0, unknown: 0 }).every(item => item.severity === 'pass'), true);
  });

  test('blocks broad Admin SDK roles and reports counts only', () => {
    const findings = classifyIamRoles({ bindings: 3, broadAdmin: 1, owner: 0, editor: 0, serviceAccountUser: 1, runtimeRole: 1, identityAttributed: true });

    assert.deepEqual(severities(findings), ['pass', 'pass', 'pass', 'block', 'pass', 'pass', 'block']);
    assert.equal(inspectIamRoles({ bindings: [{ role: 'roles/firebase.sdkAdminServiceAgent' }] }).broadAdmin, 1);
    assert.equal(inspectIamRoles({ bindings: [{ role: 'projects/sample-project/roles/privateProRuntime' }] }).broadAdmin, 0);
  });

  test('blocks stale service-account keys without key IDs', () => {
    const findings = classifyServiceAccountKeys({ collectorReady: true, identityCount: 1, total: 3, userManaged: 2, stale: 1, disabled: 0 });

    assert.deepEqual(severities(findings), ['pass', 'pass', 'pass', 'warn', 'block', 'pass']);
  });

  test('blocks missing or ambiguous runtime identity and unreadable key data', () => {
    assert.deepEqual(selectRuntimeIdentity([], undefined), { identityCount: 0 });
    assert.deepEqual(selectRuntimeIdentity([{ email: 'firebase-adminsdk-a@example.iam.gserviceaccount.com' }, { email: 'firebase-adminsdk-b@example.iam.gserviceaccount.com' }], undefined), { identityCount: 2 });
    assert.deepEqual(selectRuntimeIdentity([], 'runtime@sample-project.iam.gserviceaccount.com'), { identityCount: 1, email: 'runtime@sample-project.iam.gserviceaccount.com' });
    assert.deepEqual(selectRuntimeIdentity([], 'runtime@sample-project.iam.gserviceaccount.com&whoami'), { identityCount: 0 });
    assert.equal(classifyServiceAccountKeys({ collectorReady: false, identityCount: 1, total: 0, userManaged: 0, stale: 0, disabled: 0 })[0].severity, 'block');
  });

  test('treats the configured ADC service account as expected, not active identity proof', () => {
    assert.deepEqual(selectRuntimeIdentity([], {
      runtimeServiceAccountEmail: 'private-pro-runtime@sample-project.iam.gserviceaccount.com',
    }), {
      credentialSource: 'application-default',
      identityCount: 0,
      email: undefined,
      expectedEmail: 'private-pro-runtime@sample-project.iam.gserviceaccount.com',
      activeEmail: undefined,
      staticKeyFallback: false,
      partialStaticCredentials: false,
      identityExplicit: true,
      expectedIdentityConfigured: true,
      activeIdentityVerified: false,
      activeIdentityMatchesExpected: false,
    });
  });

  test('warns for a complete static key fallback and blocks a partial pair', () => {
    const fallback = inspectRuntimeIdentity([], {
      staticClientEmail: 'private-pro-runtime@sample-project.iam.gserviceaccount.com',
      staticPrivateKey: 'private-key-sentinel',
    });
    const partial = inspectRuntimeIdentity([], {
      staticPrivateKey: 'private-key-sentinel',
    });

    assert.deepEqual(fallback, {
      credentialSource: 'static-key-fallback',
      identityCount: 1,
      staticKeyFallback: true,
      partialStaticCredentials: false,
      identityExplicit: true,
      expectedIdentityConfigured: true,
      activeIdentityVerified: true,
      activeIdentityMatchesExpected: true,
      expectedEmail: 'private-pro-runtime@sample-project.iam.gserviceaccount.com',
      activeEmail: 'private-pro-runtime@sample-project.iam.gserviceaccount.com',
    });
    assert.deepEqual(severities(classifyRuntimeIdentity(fallback)), ['pass', 'pass', 'pass', 'pass', 'warn', 'pass']);
    assert.deepEqual(severities(classifyRuntimeIdentity(partial)), ['block', 'block', 'block', 'block', 'pass', 'block']);
    assert.doesNotMatch(JSON.stringify(buildAuditReport(classifyRuntimeIdentity(fallback))), /private-key-sentinel|sample-project|iam\.gserviceaccount/);
  });

  test('blocks ADC when the expected or active runtime service account cannot be verified', () => {
    const facts = inspectRuntimeIdentity([], {});

    assert.deepEqual(facts, {
      credentialSource: 'application-default',
      identityCount: 0,
      staticKeyFallback: false,
      partialStaticCredentials: false,
      identityExplicit: false,
      expectedIdentityConfigured: false,
      activeIdentityVerified: false,
      activeIdentityMatchesExpected: false,
    });
    assert.deepEqual(severities(classifyRuntimeIdentity(facts)), ['block', 'block', 'block', 'block', 'pass', 'pass']);
    assert.deepEqual(severities(classifyIamRoles({
      bindings: 0,
      broadAdmin: 0,
      owner: 0,
      editor: 0,
      serviceAccountUser: 0,
      runtimeRole: 0,
      identityAttributed: false,
      credentialSource: 'application-default',
    })), ['warn', 'warn', 'warn', 'pass', 'pass', 'pass', 'pass']);
    assert.deepEqual(severities(classifyServiceAccountKeys({
      collectorReady: false,
      identityCount: 0,
      total: 0,
      userManaged: 0,
      stale: 0,
      disabled: 0,
      credentialSource: 'application-default',
      identityExplicit: false,
    })), ['warn', 'warn', 'warn', 'pass', 'pass', 'pass']);
  });

  test('validates the exact runtime permission allowlist and separate signBlob binding', async () => {
    const manifest = JSON.parse(await readFile('infra/private-pro/gcp-runtime-role.yaml', 'utf8')) as unknown;
    const facts = inspectRuntimeRoleManifest(manifest);

    assert.deepEqual(facts, {
      readable: true,
      schemaErrors: 0,
      missingRuntimePermissions: 0,
      unexpectedRuntimePermissions: 0,
      forbiddenRuntimePermissions: 0,
      signBlobInRuntimeRole: 0,
      signingBindingValid: true,
      projectSpecificPrincipals: 0,
    });
    assert.equal(classifyRuntimeRoleManifest(facts).every(finding => finding.severity === 'pass'), true);
  });

  test('rejects malformed runtime manifests instead of coercing their shape', async () => {
    const valid = JSON.parse(await readFile('infra/private-pro/gcp-runtime-role.yaml', 'utf8')) as Record<string, unknown>;
    const audit = securityAuditModule as unknown as {
      inspectRuntimeRoleManifest(value: unknown): RuntimeRoleManifestResult;
    };
    type RuntimeRoleManifestResult = ReturnType<typeof inspectRuntimeRoleManifest> & { schemaErrors: number };
    const mutations: Array<(manifest: Record<string, unknown>) => void> = [
      manifest => { manifest.extra = true; },
      manifest => { manifest.schemaVersion = 2; },
      manifest => { (manifest.runtimeRole as Record<string, unknown>).extra = true; },
      manifest => { (manifest.runtimeRole as Record<string, unknown>).roleId = 'otherRuntime'; },
      manifest => { (manifest.runtimeRole as Record<string, unknown>).stage = 'BETA'; },
      manifest => { ((manifest.runtimeRole as Record<string, unknown>).includedPermissions as unknown[]).push('datastore.entities.get'); },
      manifest => { ((manifest.runtimeRole as Record<string, unknown>).includedPermissions as unknown[])[0] = { permission: 'datastore.databases.get' }; },
      manifest => { ((manifest.runtimeRole as Record<string, unknown>).includedPermissions as unknown[]).reverse(); },
      manifest => { ((manifest.localVerification as Array<Record<string, unknown>>)[0]).extra = true; },
      manifest => { (manifest.workloadIdentityBinding as Record<string, unknown>).extra = true; },
      manifest => { (manifest.workloadIdentityBinding as Record<string, unknown>).serviceAccount = 'runtime@example.iam.gserviceaccount.com'; },
      manifest => { (manifest.workloadIdentityBinding as Record<string, unknown>).members = ['principalSet://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/*']; },
      manifest => { (manifest.signingBinding as Record<string, unknown>).extra = true; },
      manifest => { (manifest.signingBinding as Record<string, unknown>).member = '${WIF_RUNTIME_PRINCIPAL}'; },
      manifest => { (manifest.signingBinding as Record<string, unknown>).serviceAccount = '${OTHER_SERVICE_ACCOUNT_EMAIL}'; },
      manifest => { (manifest.signingBinding as Record<string, unknown>).scope = 'project'; },
      manifest => { delete (manifest.validation as Record<string, unknown>).liveValidationTask; },
      manifest => { (manifest.validation as Record<string, unknown>).extra = true; },
    ];

    for (const mutate of mutations) {
      const manifest = structuredClone(valid);
      mutate(manifest);
      const facts = audit.inspectRuntimeRoleManifest(manifest);
      assert.equal(facts.readable, false);
      assert.ok(facts.schemaErrors > 0);
    }
    for (const value of [null, [], 'manifest']) {
      const facts = audit.inspectRuntimeRoleManifest(value);
      assert.equal(facts.readable, false);
      assert.ok(facts.schemaErrors > 0);
    }

    const signBlob = structuredClone(valid);
    const permissions = (signBlob.runtimeRole as Record<string, unknown>).includedPermissions as string[];
    permissions.splice(8, 0, 'iam.serviceAccounts.signBlob');
    const signBlobFacts = audit.inspectRuntimeRoleManifest(signBlob);
    assert.equal(signBlobFacts.signBlobInRuntimeRole, 1);
    assert.equal(classifyRuntimeRoleManifest(signBlobFacts).some(finding => finding.severity === 'block'), true);
  });

  test('compares the deployed custom role with the exact manifest role', async () => {
    const audit = securityAuditModule as unknown as {
      inspectDeployedRuntimeRole(value: unknown, projectId: string, manifest: unknown): {
        readable: boolean;
        nameMatches: boolean;
        stageMatches: boolean;
        active: boolean;
        missingPermissions: number;
        unexpectedPermissions: number;
      };
      classifyDeployedRuntimeRole(facts: ReturnType<typeof audit.inspectDeployedRuntimeRole>): AuditFinding[];
    };
    const manifest = JSON.parse(await readFile('infra/private-pro/gcp-runtime-role.yaml', 'utf8')) as unknown;
    const deployed = {
      name: 'projects/sample-project/roles/privateProRuntime',
      stage: 'GA',
      deleted: false,
      includedPermissions: [
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
      ],
    };

    const exact = audit.inspectDeployedRuntimeRole(deployed, 'sample-project', manifest);
    assert.equal(audit.classifyDeployedRuntimeRole(exact).every(finding => finding.severity === 'pass'), true);
    assert.equal(audit.classifyDeployedRuntimeRole(audit.inspectDeployedRuntimeRole({}, 'sample-project', manifest)).every(finding => finding.severity === 'pass'), false);
    const drifted = audit.inspectDeployedRuntimeRole({
      ...deployed,
      stage: 'BETA',
      deleted: true,
      includedPermissions: [...deployed.includedPermissions.slice(1), 'storage.objects.list'],
    }, 'sample-project', manifest);
    assert.deepEqual(severities(audit.classifyDeployedRuntimeRole(drifted)), ['pass', 'pass', 'block', 'block', 'block', 'block']);
  });

  test('allows only the runtime custom role on the runtime service account at project scope', () => {
    const audit = securityAuditModule as unknown as {
      inspectProjectRuntimePolicy(value: unknown, projectId: string, runtimeEmail: string): {
        readable: boolean;
        runtimeRoleBindings: number;
        unexpectedRoles: number;
        projectTokenCreator: number;
      };
      classifyProjectRuntimePolicy(facts: ReturnType<typeof audit.inspectProjectRuntimePolicy>): AuditFinding[];
    };
    const member = 'serviceAccount:private-pro-runtime@sample-project.iam.gserviceaccount.com';
    const expected = audit.inspectProjectRuntimePolicy({ bindings: [{
      role: 'projects/sample-project/roles/privateProRuntime',
      members: [member],
    }] }, 'sample-project', member.slice('serviceAccount:'.length));
    const extra = audit.inspectProjectRuntimePolicy({ bindings: [
      { role: 'projects/sample-project/roles/privateProRuntime', members: [member] },
      { role: 'roles/storage.objectAdmin', members: [member] },
      { role: 'projects/sample-project/roles/otherCustom', members: [member] },
      { role: 'roles/iam.serviceAccountTokenCreator', members: ['principalSet://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/vercel/*'] },
    ] }, 'sample-project', member.slice('serviceAccount:'.length));

    assert.equal(audit.classifyProjectRuntimePolicy(expected).every(finding => finding.severity === 'pass'), true);
    assert.equal(extra.unexpectedRoles, 2);
    assert.equal(extra.projectTokenCreator, 1);
    assert.deepEqual(severities(audit.classifyProjectRuntimePolicy(extra)), ['pass', 'pass', 'block', 'block']);
  });

  test('enforces the exact service-account WIF and self-signing policy matrix', () => {
    const audit = securityAuditModule as unknown as {
      inspectRuntimeServiceAccountPolicy(value: unknown, runtimeEmail: string, wifPrincipals: ReadonlySet<string>): {
        readable: boolean;
        missingWifPrincipals: number;
        unexpectedWifPrincipals: number;
        selfTokenCreatorBindings: number;
        externalTokenCreators: number;
        unexpectedBindings: number;
      };
      classifyRuntimeServiceAccountPolicy(facts: ReturnType<typeof audit.inspectRuntimeServiceAccountPolicy>): AuditFinding[];
    };
    const runtimeEmail = 'private-pro-runtime@sample-project.iam.gserviceaccount.com';
    const runtimeMember = `serviceAccount:${runtimeEmail}`;
    const wif = 'principalSet://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/vercel/attribute.repository/org/repo';
    const expected = audit.inspectRuntimeServiceAccountPolicy({ bindings: [
      { role: 'roles/iam.workloadIdentityUser', members: [wif] },
      { role: 'roles/iam.serviceAccountTokenCreator', members: [runtimeMember] },
    ] }, runtimeEmail, new Set([wif]));
    const extra = audit.inspectRuntimeServiceAccountPolicy({ bindings: [
      { role: 'roles/iam.workloadIdentityUser', members: [wif, 'principal://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/vercel/subject/other'] },
      { role: 'roles/iam.serviceAccountTokenCreator', members: [runtimeMember, wif] },
      { role: 'roles/iam.serviceAccountUser', members: [wif] },
    ] }, runtimeEmail, new Set([wif]));

    assert.equal(audit.classifyRuntimeServiceAccountPolicy(expected).every(finding => finding.severity === 'pass'), true);
    assert.deepEqual(severities(audit.classifyRuntimeServiceAccountPolicy(extra)), ['pass', 'pass', 'block', 'block', 'block', 'block']);
  });

  test('distinguishes the expected ADC identity from an independently verified active principal', async () => {
    const audit = securityAuditModule as unknown as {
      inspectRuntimeIdentity(accounts: unknown, input: {
        runtimeServiceAccountEmail?: string;
        staticClientEmail?: string;
        staticPrivateKey?: string;
        activeAdcServiceAccountEmail?: string;
      }): ReturnType<typeof inspectRuntimeIdentity> & {
        expectedIdentityConfigured: boolean;
        activeIdentityVerified: boolean;
        activeIdentityMatchesExpected: boolean;
      };
      collectActiveAdcServiceAccountEmail(factory: () => Promise<{
        getAccessToken(): Promise<string | null | undefined>;
        getCredentials(): Promise<{ client_email?: string }>;
      }>): Promise<string | undefined>;
    };
    const expectedOnly = audit.inspectRuntimeIdentity([], {
      runtimeServiceAccountEmail: 'private-pro-runtime@sample-project.iam.gserviceaccount.com',
    });
    const verified = audit.inspectRuntimeIdentity([], {
      runtimeServiceAccountEmail: 'private-pro-runtime@sample-project.iam.gserviceaccount.com',
      activeAdcServiceAccountEmail: 'private-pro-runtime@sample-project.iam.gserviceaccount.com',
    });
    const mismatched = audit.inspectRuntimeIdentity([], {
      runtimeServiceAccountEmail: 'private-pro-runtime@sample-project.iam.gserviceaccount.com',
      activeAdcServiceAccountEmail: 'other-runtime@sample-project.iam.gserviceaccount.com',
    });

    assert.equal(expectedOnly.activeIdentityVerified, false);
    assert.equal(verified.activeIdentityMatchesExpected, true);
    assert.equal(mismatched.activeIdentityMatchesExpected, false);
    assert.equal(classifyRuntimeIdentity(expectedOnly).some(finding => finding.severity === 'block'), true);
    assert.equal(classifyRuntimeIdentity(verified).every(finding => finding.severity !== 'block'), true);
    assert.equal(classifyRuntimeIdentity(mismatched).some(finding => finding.severity === 'block'), true);
    assert.equal(await audit.collectActiveAdcServiceAccountEmail(async () => ({
      async getAccessToken() { return 'access-token'; },
      async getCredentials() { return { client_email: 'private-pro-runtime@sample-project.iam.gserviceaccount.com' }; },
    })), 'private-pro-runtime@sample-project.iam.gserviceaccount.com');
  });

  test('blocks critical or high production dependency advisories', () => {
    const findings = classifyDependencyAudit({ readable: true, critical: 1, high: 2, moderate: 3, low: 4, total: 10 });

    assert.deepEqual(severities(findings), ['pass', 'block', 'block', 'warn', 'warn', 'pass']);
  });

  test('blocks malformed and npm audit error payloads', () => {
    assert.equal(inspectDependencyAudit({ error: { code: 'EAUDITNOLOCK' } }).readable, false);
    assert.equal(inspectDependencyAudit({ metadata: {} }).readable, false);
    assert.equal(inspectDependencyAudit('not-json').readable, false);
    assert.equal(classifyDependencyAudit({ readable: false, critical: 0, high: 0, moderate: 0, low: 0, total: 0 })[0].severity, 'block');
  });

  test('blocks Firebase probes that permit anonymous reads or writes', () => {
    const findings = classifyFirebaseRuleProbes({
      firestoreRead: 'denied',
      firestoreWrite: 'allowed',
      storageRead: 'unknown',
      storageWrite: 'denied',
    });

    assert.deepEqual(severities(findings), ['pass', 'block', 'block', 'pass']);
  });

  test('reduces live collector payloads to booleans and counts', () => {
    assert.deepEqual(inspectAuthorizedDomains({ authorizedDomains: ['chatgpt.ashesh.dev', 'old.example.com', '*.example.com'] }), {
      exactMatches: 1,
      stale: 1,
      wildcard: 1,
      missing: 1,
    });
    assert.deepEqual(inspectBrowserApiKeys([{ restrictions: { browserKeyRestrictions: { allowedReferrers: ['https://example.com/*'] }, apiTargets: [{ service: 'identitytoolkit.googleapis.com' }] } }, {}], new Set(['https://example.com/*']), new Set(['identitytoolkit.googleapis.com'])), {
      total: 2,
      unrestricted: 1,
      missingExpectedReferrers: 1,
      staleReferrers: 0,
      broadReferrers: 0,
      missingRequiredApiTargets: 1,
      unrelatedApiTargets: 0,
    });
    assert.deepEqual(inspectAppCheck({ services: [{ name: 'projects/1/services/a', enforcementMode: 'ENFORCED' }, { name: 'projects/1/services/b', enforcementMode: 'UNENFORCED' }, { name: 'projects/1/services/c' }] }, new Set(['a', 'b', 'c', 'd'])), {
      required: 4,
      enforced: 1,
      missing: 2,
      unenforced: 1,
      unknown: 0,
    });
    assert.deepEqual(inspectIamRoles({ bindings: [{ role: 'roles/firebase.admin' }, { role: 'roles/viewer' }] }), {
      bindings: 2,
      broadAdmin: 1,
      owner: 0,
      editor: 0,
      serviceAccountUser: 0,
      runtimeRole: 0,
    });
    assert.deepEqual(inspectServiceAccountIamRoles({ bindings: [
      { role: 'roles/firebase.admin', members: ['serviceAccount:runtime@example.iam.gserviceaccount.com'] },
      { role: 'roles/editor', members: ['user:owner@example.com'] },
    ] }, 'runtime@example.iam.gserviceaccount.com'), {
      bindings: 1,
      broadAdmin: 1,
      owner: 0,
      editor: 0,
      serviceAccountUser: 0,
      runtimeRole: 0,
    });
    assert.deepEqual(inspectServiceAccountKeys([
      { name: 'secret-key-id', keyType: 'USER_MANAGED', validAfterTime: '2025-01-01T00:00:00Z' },
      { name: 'system-key-id', keyType: 'SYSTEM_MANAGED', disabled: true },
    ], Date.parse('2026-08-17T00:00:00Z'), true, 1), { collectorReady: true, identityCount: 1, total: 2, userManaged: 1, stale: 1, disabled: 1 });
    assert.deepEqual(inspectDependencyAudit({ metadata: { vulnerabilities: { critical: 1, high: 2, moderate: 3, low: 4, total: 10 } } }), {
      readable: true,
      critical: 1,
      high: 2,
      moderate: 3,
      low: 4,
      total: 10,
    });
    assert.deepEqual(inspectDeployment({ readyState: 'READY', target: 'production', aliases: ['chatgpt.ashesh.dev', 'old.vercel.app'] }), {
      ready: true,
      production: true,
      exactAliases: 1,
      staleAliases: 1,
    });

    const reportText = JSON.stringify(buildAuditReport(classifyServiceAccountKeys({ collectorReady: true, identityCount: 1, total: 2, userManaged: 1, stale: 1, disabled: 0 })));
    assert.doesNotMatch(reportText, /secret|key-id|example\.com|firebase\.admin/);
    const assertBooleanOrCountLeaves = (value: unknown): void => {
      if (typeof value === 'boolean' || typeof value === 'number') return;
      assert.equal(typeof value, 'object');
      assert.notEqual(value, null);
      for (const child of Object.values(value as Record<string, unknown>)) assertBooleanOrCountLeaves(child);
    };
    assertBooleanOrCountLeaves(buildAuditReport(classifyServiceAccountKeys({ collectorReady: true, identityCount: 1, total: 2, userManaged: 1, stale: 1, disabled: 0 })));
  });
});
