import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  classifyAppCheck,
  classifyAuthorizedDomains,
  classifyBrowserApiKeys,
  classifyDependencyAudit,
  classifyDeployment,
  classifyFirebaseRuleProbes,
  classifyHeaders,
  classifyIamRoles,
  classifyServiceAccountKeys,
  auditCommand,
  buildAuditReport,
  inspectAppCheck,
  inspectAuthorizedDomains,
  inspectBrowserApiKeys,
  inspectDependencyAudit,
  inspectDeployment,
  inspectIamRoles,
  inspectServiceAccountKeys,
  inspectServiceAccountIamRoles,
  type AuditFinding,
} from './security-audit';


function severities(findings: AuditFinding[]) {
  return findings.map(finding => finding.severity);
}

describe('private Pro security audit classifiers', () => {
  test('uses Windows command executables for CLI collectors', () => {
    assert.deepEqual(auditCommand('gcloud', ['version'], 'win32', 'C:\\Windows\\System32\\cmd.exe'), {
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'gcloud.cmd', 'version'],
    });
    assert.deepEqual(auditCommand('gcloud', ['version'], 'linux'), { file: 'gcloud', args: ['version'] });
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
    const findings = classifyBrowserApiKeys({ total: 1, unrestricted: 1, missingReferrerRestrictions: 1, missingApiTargets: 1 });

    assert.deepEqual(severities(findings), ['pass', 'block', 'block', 'block']);
  });

  test('blocks disabled App Check enforcement', () => {
    const findings = classifyAppCheck({ total: 2, enforced: 0, unenforced: 2, unknown: 0 });

    assert.deepEqual(severities(findings), ['pass', 'block', 'pass']);
  });

  test('blocks broad Admin SDK roles and reports counts only', () => {
    const findings = classifyIamRoles({ bindings: 3, broadAdmin: 1, owner: 0, editor: 0, serviceAccountUser: 1 });

    assert.deepEqual(severities(findings), ['pass', 'block', 'pass', 'pass', 'warn']);
  });

  test('blocks stale service-account keys without key IDs', () => {
    const findings = classifyServiceAccountKeys({ total: 3, userManaged: 2, stale: 1, disabled: 0 });

    assert.deepEqual(severities(findings), ['pass', 'warn', 'block', 'pass']);
  });

  test('blocks critical or high production dependency advisories', () => {
    const findings = classifyDependencyAudit({ critical: 1, high: 2, moderate: 3, low: 4, total: 10 });

    assert.deepEqual(severities(findings), ['block', 'block', 'warn', 'warn', 'pass']);
  });

  test('blocks Firebase probes that permit anonymous reads or writes', () => {
    const findings = classifyFirebaseRuleProbes({
      firestoreReadDenied: true,
      firestoreWriteDenied: false,
      storageReadDenied: false,
      storageWriteDenied: true,
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
    assert.deepEqual(inspectBrowserApiKeys([{ restrictions: { browserKeyRestrictions: { allowedReferrers: ['https://example.com/*'] }, apiTargets: [{ service: 'identitytoolkit.googleapis.com' }] } }, {}]), {
      total: 2,
      unrestricted: 1,
      missingReferrerRestrictions: 1,
      missingApiTargets: 1,
    });
    assert.deepEqual(inspectAppCheck({ services: [{ enforcementMode: 'ENFORCED' }, { enforcementMode: 'UNENFORCED' }, {}] }), {
      total: 3,
      enforced: 1,
      unenforced: 1,
      unknown: 1,
    });
    assert.deepEqual(inspectIamRoles({ bindings: [{ role: 'roles/firebase.admin' }, { role: 'roles/viewer' }] }), {
      bindings: 2,
      broadAdmin: 1,
      owner: 0,
      editor: 0,
      serviceAccountUser: 0,
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
    });
    assert.deepEqual(inspectServiceAccountKeys([
      { name: 'secret-key-id', keyType: 'USER_MANAGED', validAfterTime: '2025-01-01T00:00:00Z' },
      { name: 'system-key-id', keyType: 'SYSTEM_MANAGED', disabled: true },
    ], Date.parse('2026-08-17T00:00:00Z')), { total: 2, userManaged: 1, stale: 1, disabled: 1 });
    assert.deepEqual(inspectDependencyAudit({ metadata: { vulnerabilities: { critical: 1, high: 2, moderate: 3, low: 4, total: 10 } } }), {
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

    const reportText = JSON.stringify(buildAuditReport(classifyServiceAccountKeys({ total: 2, userManaged: 1, stale: 1, disabled: 0 })));
    assert.doesNotMatch(reportText, /secret|key-id|example\.com|firebase\.admin/);
    const assertBooleanOrCountLeaves = (value: unknown): void => {
      if (typeof value === 'boolean' || typeof value === 'number') return;
      assert.equal(typeof value, 'object');
      assert.notEqual(value, null);
      for (const child of Object.values(value as Record<string, unknown>)) assertBooleanOrCountLeaves(child);
    };
    assertBooleanOrCountLeaves(buildAuditReport(classifyServiceAccountKeys({ total: 2, userManaged: 1, stale: 1, disabled: 0 })));
  });
});
