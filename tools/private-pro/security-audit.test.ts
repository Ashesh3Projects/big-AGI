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

  test('selects an explicit ADC runtime identity without requiring FIREBASE_CLIENT_EMAIL', () => {
    assert.deepEqual(selectRuntimeIdentity([], {
      runtimeServiceAccountEmail: 'private-pro-runtime@sample-project.iam.gserviceaccount.com',
    }), {
      credentialSource: 'application-default',
      identityCount: 1,
      email: 'private-pro-runtime@sample-project.iam.gserviceaccount.com',
      staticKeyFallback: false,
      partialStaticCredentials: false,
      identityExplicit: true,
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
    });
    assert.deepEqual(severities(classifyRuntimeIdentity(fallback)), ['pass', 'warn', 'pass']);
    assert.deepEqual(severities(classifyRuntimeIdentity(partial)), ['block', 'pass', 'block']);
    assert.doesNotMatch(JSON.stringify(buildAuditReport(classifyRuntimeIdentity(fallback))), /private-key-sentinel|sample-project|iam\.gserviceaccount/);
  });

  test('warns when ADC is selected but the runtime service account cannot be attributed', () => {
    const facts = inspectRuntimeIdentity([], {});

    assert.deepEqual(facts, {
      credentialSource: 'application-default',
      identityCount: 0,
      staticKeyFallback: false,
      partialStaticCredentials: false,
      identityExplicit: false,
    });
    assert.deepEqual(severities(classifyRuntimeIdentity(facts)), ['warn', 'pass', 'pass']);
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
      missingRuntimePermissions: 0,
      unexpectedRuntimePermissions: 0,
      forbiddenRuntimePermissions: 0,
      signBlobInRuntimeRole: 0,
      signingBindingValid: true,
      projectSpecificPrincipals: 0,
    });
    assert.equal(classifyRuntimeRoleManifest(facts).every(finding => finding.severity === 'pass'), true);
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
