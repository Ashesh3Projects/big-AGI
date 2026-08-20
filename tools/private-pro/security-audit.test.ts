import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, test } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyAppCheck,
  classifyAuthorizedDomains,
  classifyBrowserApiKeys,
  classifyBucketCors,
  classifyDependencyAudit,
  classifyDeployment,
  classifyFirebaseRuleProbes,
  classifyHeaders,
  classifyIamRoles,
  classifyRuntimeIdentity,
  classifyRuntimeRoleManifest,
  classifyServiceAccountKeys,
  collectProjectNumber,
  collectFirebaseEndpointProbes,
  assertPrivateProSecurityAuditIdentity,
  runCommand,
  selectRuntimeIdentity,
  buildAuditReport,
  inspectAppCheck,
  inspectAuthorizedDomains,
  inspectBrowserApiKeys,
  inspectBucketCors,
  inspectDependencyAudit,
  inspectDeployment,
  inspectIamRoles,
  inspectApiKeyLookup,
  isAllowedReferrerPolicy,
  inspectProjectNumber,
  inspectRuntimeIdentity,
  inspectRuntimeRoleManifest,
  inspectServiceAccountKeys,
  inspectServiceAccountIamRoles,
  EXPECTED_PRIVATE_PRO_BUCKET_CORS,
  type AuditFinding,
} from './security-audit';

import * as securityAuditModule from './security-audit';


function severities(findings: AuditFinding[]) {
  return findings.map(finding => finding.severity);
}

const RESTORE_EVIDENCE_FAMILIES = [
  'accounts',
  'vaultAssetRateWindows',
  'vaultAssetReservations',
  'vaultAssets',
  'vaultDevices',
  'vaultKeysets',
  'vaultOperations',
  'vaultRecords',
  'vaultRegistrationChallenges',
  'vaultTombstones',
] as const;
const TEST_RELEASE_COMMIT = 'a'.repeat(40);
const TEST_ATTESTOR = generateKeyPairSync('ed25519');
const TEST_PUBLIC_JWK = TEST_ATTESTOR.publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string };
const TEST_TRUST = {
  schemaVersion: 1,
  status: 'active',
  algorithm: 'Ed25519',
  keyId: 'private-pro-restore-attestor-2026-01',
  publicKeyJwk: TEST_PUBLIC_JWK,
  issuer: 'github-actions',
  allowedClaims: {
    repository: 'big-agi/big-agi-private',
    workflowPath: '.github/workflows/private-pro-restore-attest.yml',
    workflowRef: 'refs/heads/dev',
    environment: 'production-recovery',
  },
  activatedAt: '2026-01-01T00:00:00Z',
  expiresAt: '2027-01-01T00:00:00Z',
  revokedAt: null,
};

function canonicalJsonForTest(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonForTest).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJsonForTest(record[key])}`).join(',')}}`;
}

function unsignedRestoreEvidence() {
  const collectionFamilies = Object.fromEntries(RESTORE_EVIDENCE_FAMILIES.map((family, index) => [family, {
    expectedCount: index,
    actualCount: index,
    expectedCiphertextHmacSha256: (index + 1).toString(16).padStart(64, '0'),
    actualCiphertextHmacSha256: (index + 1).toString(16).padStart(64, '0'),
  }]));
  return {
    schemaVersion: 1,
    evidenceVersion: 1,
    runId: '123e4567-e89b-42d3-a456-426614174000',
    recoveryMethod: 'firestore-export-import',
    startedAt: '2026-08-18T00:00:00Z',
    completedAt: '2026-08-18T00:30:00Z',
    sourceDatabaseIdentitySha256: '1'.repeat(64),
    sourcePreFingerprintSha256: '2'.repeat(64),
    sourcePostFingerprintSha256: '2'.repeat(64),
    destinationDatabaseId: 'private-pro-restore-20260818',
    destinationInitialDocumentCount: 0,
    destinationInitiallyEmptyProofSha256: '3'.repeat(64),
    recoveryArtifactIdentifierSha256: '4'.repeat(64),
    recoveryArtifactTimestamp: '2026-08-17T23:55:00Z',
    commandTranscriptSha256: '5'.repeat(64),
    tool: {
      name: 'private-pro-firestore-rehearsal',
      version: '1.0.0',
    },
    testSuiteCommitSha: TEST_RELEASE_COMMIT,
    manifests: {
      configSha256: '6'.repeat(64),
      indexesSha256: '7'.repeat(64),
      rulesSha256: '8'.repeat(64),
    },
    collectionFamilies,
    applicationAcceptance: {
      status: 'passed',
      resultSha256: '9'.repeat(64),
    },
    cleanup: {
      status: 'completed',
      evidenceSha256: 'a'.repeat(64),
    },
    approverAttestation: {
      identity: 'operator:release-owner',
      role: 'recovery-approver',
      attestedAt: '2026-08-18T00:35:00Z',
      statementSha256: 'b'.repeat(64),
    },
    ciProvenance: {
      repository: TEST_TRUST.allowedClaims.repository,
      workflowPath: TEST_TRUST.allowedClaims.workflowPath,
      workflowRef: TEST_TRUST.allowedClaims.workflowRef,
      workflowRunId: '1234567890',
      workflowRunAttempt: 1,
      environment: TEST_TRUST.allowedClaims.environment,
    },
    attestorKeyId: TEST_TRUST.keyId,
    attestorIssuer: TEST_TRUST.issuer,
  };
}

function signedRestoreEvidence(value = unsignedRestoreEvidence(), privateKey = TEST_ATTESTOR.privateKey) {
  return {
    ...value,
    signatureBase64: sign(null, Buffer.from(canonicalJsonForTest(value)), privateKey).toString('base64'),
  };
}

function restoreEvidenceBase64(value = signedRestoreEvidence()) {
  return Buffer.from(canonicalJsonForTest(value), 'utf8').toString('base64');
}

describe('private Pro security audit classifiers', () => {
  test('classifies exact Firestore deletion protection and PITR states without retaining database identity', () => {
    const audit = securityAuditModule as unknown as {
      inspectFirestoreRecoveryState(value: unknown, projectId: string): {
        readable: boolean;
        databaseNameMatches: boolean;
        nativeMode: boolean;
        standardEdition: boolean;
        locationPresent: boolean;
        deletionProtection: 'enabled' | 'disabled' | 'unspecified' | 'unknown';
        pitr: 'enabled' | 'disabled' | 'unknown';
        earliestVersionTimePresent: boolean;
        versionRetentionPeriod: 'seven-days' | 'one-hour' | 'other' | 'missing';
      };
      classifyFirestoreRecoveryState(facts: ReturnType<typeof audit.inspectFirestoreRecoveryState>): AuditFinding[];
    };
    const enabled = audit.inspectFirestoreRecoveryState({
      name: 'projects/sample-project/databases/(default)',
      type: 'FIRESTORE_NATIVE',
      databaseEdition: 'STANDARD',
      locationId: 'us-central1',
      deleteProtectionState: 'DELETE_PROTECTION_ENABLED',
      pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_ENABLED',
      earliestVersionTime: '2026-08-18T00:00:00.123456Z',
      versionRetentionPeriod: '604800s',
    }, 'sample-project');
    const disabled = audit.inspectFirestoreRecoveryState({
      name: 'projects/sample-project/databases/(default)',
      type: 'FIRESTORE_NATIVE',
      databaseEdition: 'STANDARD',
      locationId: 'us-central1',
      deleteProtectionState: 'DELETE_PROTECTION_DISABLED',
      pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_DISABLED',
      earliestVersionTime: '2026-08-18T00:00:00Z',
      versionRetentionPeriod: '3600s',
    }, 'sample-project');
    const unspecified = audit.inspectFirestoreRecoveryState({
      name: 'projects/sample-project/databases/(default)',
      type: 'FIRESTORE_NATIVE',
      databaseEdition: 'STANDARD',
      locationId: 'us-central1',
      deleteProtectionState: 'DELETE_PROTECTION_STATE_UNSPECIFIED',
      pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_ENABLEMENT_UNSPECIFIED',
      earliestVersionTime: '2026-08-18T00:00:00Z',
      versionRetentionPeriod: '3600s',
    }, 'sample-project');

    assert.deepEqual(enabled, {
      readable: true,
      databaseNameMatches: true,
      nativeMode: true,
      standardEdition: true,
      locationPresent: true,
      deletionProtection: 'enabled',
      pitr: 'enabled',
      earliestVersionTimePresent: true,
      versionRetentionPeriod: 'seven-days',
    });
    assert.deepEqual(disabled, {
      readable: true,
      databaseNameMatches: true,
      nativeMode: true,
      standardEdition: true,
      locationPresent: true,
      deletionProtection: 'disabled',
      pitr: 'disabled',
      earliestVersionTimePresent: true,
      versionRetentionPeriod: 'one-hour',
    });
    assert.deepEqual(unspecified, {
      readable: true,
      databaseNameMatches: true,
      nativeMode: true,
      standardEdition: true,
      locationPresent: true,
      deletionProtection: 'unspecified',
      pitr: 'unknown',
      earliestVersionTimePresent: true,
      versionRetentionPeriod: 'one-hour',
    });
    assert.deepEqual(severities(audit.classifyFirestoreRecoveryState(enabled)), ['pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
    assert.deepEqual(severities(audit.classifyFirestoreRecoveryState(disabled)), ['pass', 'pass', 'pass', 'pass', 'pass', 'block', 'pass', 'pass', 'warn']);
    assert.deepEqual(severities(audit.classifyFirestoreRecoveryState(unspecified)), ['pass', 'pass', 'pass', 'pass', 'pass', 'block', 'block', 'pass', 'block']);
    assert.doesNotMatch(JSON.stringify(buildAuditReport(audit.classifyFirestoreRecoveryState(enabled))), /sample-project|projects\//);
  });

  test('fails closed on malformed or unrecognized Firestore recovery database shapes', () => {
    const audit = securityAuditModule as unknown as {
      inspectFirestoreRecoveryState(value: unknown, projectId: string): {
        readable: boolean;
        databaseNameMatches: boolean;
        nativeMode: boolean;
        standardEdition: boolean;
        locationPresent: boolean;
        deletionProtection: 'enabled' | 'disabled' | 'unspecified' | 'unknown';
        pitr: 'enabled' | 'disabled' | 'unknown';
        earliestVersionTimePresent: boolean;
        versionRetentionPeriod: 'seven-days' | 'one-hour' | 'other' | 'missing';
      };
      classifyFirestoreRecoveryState(facts: ReturnType<typeof audit.inspectFirestoreRecoveryState>): AuditFinding[];
    };
    const complete = {
      name: 'projects/sample-project/databases/(default)',
      type: 'FIRESTORE_NATIVE',
      databaseEdition: 'STANDARD',
      locationId: 'us-central1',
      deleteProtectionState: 'DELETE_PROTECTION_ENABLED',
      pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_ENABLED',
      earliestVersionTime: '2026-08-18T00:00:00Z',
      versionRetentionPeriod: '604800s',
    };
    const partialValues = Object.keys(complete).map(key => {
      const value = structuredClone(complete) as Record<string, unknown>;
      delete value[key];
      return value;
    });
    const invalidValues = [
      null,
      [],
      'database',
      {},
      {
        ...complete,
        deleteProtectionState: 'DELETE_PROTECTION_MAGIC',
      },
      {
        ...complete,
        pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_MAGIC',
      },
      {
        ...complete,
        earliestVersionTime: 'not-a-timestamp',
      },
      {
        ...complete,
        earliestVersionTime: '2026-02-30T00:00:00Z',
      },
      {
        ...complete,
        versionRetentionPeriod: 604800,
      },
      { ...complete, type: 'DATASTORE_MODE' },
      { ...complete, databaseEdition: 'DATABASE_EDITION_UNSPECIFIED' },
      { ...complete, locationId: '' },
      { ...complete, pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_DISABLED' },
      { ...complete, versionRetentionPeriod: '3600s' },
      ...partialValues,
    ];

    for (const value of invalidValues) {
      const facts = audit.inspectFirestoreRecoveryState(value, 'sample-project');
      assert.equal(facts.readable, false);
      assert.equal(audit.classifyFirestoreRecoveryState(facts).some(finding => finding.severity === 'block'), true);
    }

    const missingEarliest = structuredClone(complete) as Record<string, unknown>;
    delete missingEarliest.earliestVersionTime;
    const missingEarliestFindings = audit.classifyFirestoreRecoveryState(audit.inspectFirestoreRecoveryState(missingEarliest, 'sample-project'));
    assert.equal(missingEarliestFindings.find(finding => finding.check === 'earliestVersionTimePresent')?.severity, 'block');

    const wrongDatabase = audit.inspectFirestoreRecoveryState({
      ...complete,
      name: 'projects/other-project/databases/(default)',
    }, 'sample-project');
    assert.equal(wrongDatabase.readable, true);
    assert.equal(wrongDatabase.databaseNameMatches, false);
    assert.equal(audit.classifyFirestoreRecoveryState(wrongDatabase)[1].severity, 'block');
  });

  test('uses only the read-only Firestore database describe command for recovery collection', async () => {
    const audit = securityAuditModule as unknown as {
      collectFirestoreRecoveryStateWithExecutor(
        projectId: string,
        execute: (command: string, args: string[]) => Promise<unknown>,
      ): Promise<{ readable: boolean }>;
    };
    const calls: Array<{ command: string; args: string[] }> = [];

    const facts = await audit.collectFirestoreRecoveryStateWithExecutor('sample-project', async (command, args) => {
      calls.push({ command, args });
      return {
        name: 'projects/sample-project/databases/(default)',
        type: 'FIRESTORE_NATIVE',
        databaseEdition: 'STANDARD',
        locationId: 'us-central1',
        deleteProtectionState: 'DELETE_PROTECTION_ENABLED',
        pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_DISABLED',
        earliestVersionTime: '2026-08-18T00:00:00Z',
        versionRetentionPeriod: '3600s',
      };
    });

    assert.deepEqual(calls, [{
      command: 'gcloud',
      args: ['firestore', 'databases', 'describe', '--database=(default)', '--project=sample-project', '--format=json'],
    }]);
    assert.equal(facts.readable, true);
  });

  test('accepts only independently attested Ed25519 restore evidence', () => {
    const audit = securityAuditModule as unknown as {
      inspectFirestoreRestoreEvidence(value: unknown, input: {
        nowMs: number;
        actualHeadSha: string;
        worktreeClean?: boolean;
        additionalExpectedCommitSha?: string;
        trustDescriptor: unknown;
      }): {
        readable: boolean;
        schemaErrors: number;
        completed: boolean;
        stale: boolean;
        sourceUnchanged: boolean;
        isolatedTarget: boolean;
        targetNotDefault: boolean;
        targetInitiallyEmpty: boolean;
        indexesVerified: boolean;
        rulesVerified: boolean;
        configVerified: boolean;
        documentCountsVerified: boolean;
        documentHashesVerified: boolean;
        dataVerified: boolean;
        applicationVerified: boolean;
        signatureVerified: boolean;
        releaseCommitMatches: boolean;
        trustConfigured: boolean;
        provenanceMatches: boolean;
        worktreeClean: boolean;
      };
    };
    const input = {
      nowMs: Date.parse('2026-08-18T12:00:00Z'),
      actualHeadSha: TEST_RELEASE_COMMIT,
      trustDescriptor: TEST_TRUST,
    };

    assert.deepEqual(audit.inspectFirestoreRestoreEvidence(signedRestoreEvidence(), input), {
      readable: true,
      schemaErrors: 0,
      completed: true,
      stale: false,
      sourceUnchanged: true,
      isolatedTarget: true,
      targetNotDefault: true,
      targetInitiallyEmpty: true,
      indexesVerified: true,
      rulesVerified: true,
      configVerified: true,
      documentCountsVerified: true,
      documentHashesVerified: true,
      dataVerified: true,
      applicationVerified: true,
      signatureVerified: true,
      releaseCommitMatches: true,
      trustConfigured: true,
      provenanceMatches: true,
      worktreeClean: true,
    });
  });

  test('rejects unsigned, wrong signer, wrong key ID, tampered, and wrong release evidence', () => {
    const audit = securityAuditModule as unknown as {
      inspectFirestoreRestoreEvidence(value: unknown, input: {
        nowMs: number;
        actualHeadSha: string;
        worktreeClean?: boolean;
        additionalExpectedCommitSha?: string;
        trustDescriptor: unknown;
      }): {
        readable: boolean;
        sourceUnchanged: boolean;
        signatureVerified: boolean;
        releaseCommitMatches: boolean;
        trustConfigured: boolean;
      };
    };
    const input = {
      nowMs: Date.parse('2026-08-18T12:00:00Z'),
      actualHeadSha: TEST_RELEASE_COMMIT,
      trustDescriptor: TEST_TRUST,
    };
    const unsigned = audit.inspectFirestoreRestoreEvidence(unsignedRestoreEvidence(), input);
    assert.equal(unsigned.readable, false);
    assert.equal(unsigned.signatureVerified, false);

    const unconfigured = audit.inspectFirestoreRestoreEvidence(signedRestoreEvidence(), {
      ...input,
      trustDescriptor: { ...TEST_TRUST, status: 'unconfigured', publicKeyJwk: null },
    });
    assert.equal(unconfigured.readable, false);
    assert.equal(unconfigured.trustConfigured, false);

    const other = generateKeyPairSync('ed25519');
    const wrongSigner = audit.inspectFirestoreRestoreEvidence(signedRestoreEvidence(unsignedRestoreEvidence(), other.privateKey), input);
    assert.equal(wrongSigner.readable, false);
    assert.equal(wrongSigner.signatureVerified, false);

    const wrongKeyIdValue = unsignedRestoreEvidence();
    wrongKeyIdValue.attestorKeyId = 'other-key';
    assert.equal(audit.inspectFirestoreRestoreEvidence(signedRestoreEvidence(wrongKeyIdValue), input).readable, false);

    const wrongIssuerValue = unsignedRestoreEvidence();
    wrongIssuerValue.attestorIssuer = 'other-issuer';
    assert.equal(audit.inspectFirestoreRestoreEvidence(signedRestoreEvidence(wrongIssuerValue), input).readable, false);

    const tampered = signedRestoreEvidence();
    tampered.destinationDatabaseId = 'private-pro-restore-tampered';
    assert.equal(audit.inspectFirestoreRestoreEvidence(tampered, input).signatureVerified, false);

    const wrongCommit = audit.inspectFirestoreRestoreEvidence(signedRestoreEvidence(), { ...input, actualHeadSha: 'c'.repeat(40) });
    assert.equal(wrongCommit.releaseCommitMatches, false);
    assert.equal(wrongCommit.readable, false);

    const additionalMismatch = audit.inspectFirestoreRestoreEvidence(signedRestoreEvidence(), {
      ...input,
      additionalExpectedCommitSha: 'c'.repeat(40),
    });
    assert.equal(additionalMismatch.readable, false);

    const dirty = audit.inspectFirestoreRestoreEvidence(signedRestoreEvidence(), { ...input, worktreeClean: false });
    assert.equal(dirty.releaseCommitMatches, false);
    assert.equal(dirty.readable, false);

    const changedSourceValue = unsignedRestoreEvidence();
    changedSourceValue.sourcePostFingerprintSha256 = 'c'.repeat(64);
    const changedSource = audit.inspectFirestoreRestoreEvidence(signedRestoreEvidence(changedSourceValue), input);
    assert.equal(changedSource.sourceUnchanged, false);
    assert.equal(changedSource.readable, false);
  });

  test('rejects wrong CI provenance, stale completion, excessive attestation delay, future times, and malformed evidence', () => {
    const audit = securityAuditModule as unknown as {
      inspectFirestoreRestoreEvidence(value: unknown, input: {
        nowMs: number;
        actualHeadSha: string;
        trustDescriptor: unknown;
      }): { readable: boolean; stale: boolean; schemaErrors: number };
    };
    const input = {
      nowMs: Date.parse('2026-08-18T12:00:00Z'),
      actualHeadSha: TEST_RELEASE_COMMIT,
      trustDescriptor: TEST_TRUST,
    };
    const staleValue = unsignedRestoreEvidence();
    staleValue.startedAt = '2026-04-01T00:00:00Z';
    staleValue.completedAt = '2026-04-01T00:30:00Z';
    staleValue.recoveryArtifactTimestamp = '2026-03-31T23:55:00Z';
    staleValue.approverAttestation.attestedAt = '2026-04-01T00:35:00Z';
    const stale = audit.inspectFirestoreRestoreEvidence(signedRestoreEvidence(staleValue), input);
    assert.equal(stale.readable, true);
    assert.equal(stale.stale, true);

    for (const [field, value] of [
      ['repository', 'other/repo'],
      ['workflowPath', '.github/workflows/other.yml'],
      ['workflowRef', 'refs/heads/main'],
      ['environment', 'unprotected'],
    ] as const) {
      const wrongClaim = unsignedRestoreEvidence();
      wrongClaim.ciProvenance[field] = value;
      assert.equal(audit.inspectFirestoreRestoreEvidence(signedRestoreEvidence(wrongClaim), input).readable, false);
    }

    const badRun = unsignedRestoreEvidence();
    badRun.ciProvenance.workflowRunId = '0';
    assert.equal(audit.inspectFirestoreRestoreEvidence(signedRestoreEvidence(badRun), input).readable, false);

    const reversed = unsignedRestoreEvidence();
    reversed.completedAt = '2026-08-17T23:00:00Z';
    assert.equal(audit.inspectFirestoreRestoreEvidence(signedRestoreEvidence(reversed), input).readable, false);

    const delayed = unsignedRestoreEvidence();
    delayed.approverAttestation.attestedAt = '2026-08-20T00:31:00Z';
    assert.equal(audit.inspectFirestoreRestoreEvidence(signedRestoreEvidence(delayed), input).readable, false);

    const future = unsignedRestoreEvidence();
    future.completedAt = '2026-08-18T12:06:00Z';
    future.approverAttestation.attestedAt = '2026-08-18T12:07:00Z';
    assert.equal(audit.inspectFirestoreRestoreEvidence(signedRestoreEvidence(future), input).readable, false);

    const extraFamily = unsignedRestoreEvidence() as ReturnType<typeof unsignedRestoreEvidence> & { collectionFamilies: Record<string, unknown> };
    extraFamily.collectionFamilies.unapprovedFamily = {
      expectedCount: 1,
      actualCount: 1,
      expectedCiphertextHmacSha256: 'd'.repeat(64),
      actualCiphertextHmacSha256: 'd'.repeat(64),
    };
    assert.equal(audit.inspectFirestoreRestoreEvidence(signedRestoreEvidence(extraFamily), input).readable, false);

    const familyMismatch = unsignedRestoreEvidence();
    familyMismatch.collectionFamilies.vaultRecords.actualCiphertextHmacSha256 = 'e'.repeat(64);
    assert.equal(audit.inspectFirestoreRestoreEvidence(signedRestoreEvidence(familyMismatch), input).readable, false);

    const applicationFailed = unsignedRestoreEvidence();
    applicationFailed.applicationAcceptance.status = 'failed';
    assert.equal(audit.inspectFirestoreRestoreEvidence(signedRestoreEvidence(applicationFailed), input).readable, false);

    const malformed = unsignedRestoreEvidence();
    malformed.runId = 'not-a-uuid';
    assert.ok(audit.inspectFirestoreRestoreEvidence(signedRestoreEvidence(malformed), input).schemaErrors > 0);
  });

  test('collects signed evidence only from strict bounded canonical base64 environment input', () => {
    const audit = securityAuditModule as unknown as {
      collectFirestoreRestoreEvidenceFromBase64(
        value: string | undefined,
        input: {
          nowMs: number;
          actualHeadSha: string;
          trustDescriptor: unknown;
        },
      ): { readable: boolean; completed: boolean; signatureVerified: boolean };
    };
    const input = {
      nowMs: Date.parse('2026-08-18T12:00:00Z'),
      actualHeadSha: TEST_RELEASE_COMMIT,
      trustDescriptor: TEST_TRUST,
    };
    const encoded = restoreEvidenceBase64();
    const accepted = audit.collectFirestoreRestoreEvidenceFromBase64(encoded, input);
    assert.equal(accepted.readable, true);
    assert.equal(accepted.completed, true);
    assert.equal(accepted.signatureVerified, true);

    const withoutPadding = encoded.endsWith('==') ? encoded.slice(0, -2) : encoded.endsWith('=') ? encoded.slice(0, -1) : `${encoded}=`;
    const aliasBytes = Buffer.from([0xff]);
    const canonicalAlias = aliasBytes.toString('base64');
    const trailingBitAlias = `${canonicalAlias.slice(0, 1)}${canonicalAlias[1] === 'w' ? 'x' : 'w'}==`;
    const duplicateKey = Buffer.from('{"schemaVersion":1,"schemaVersion":1}', 'utf8').toString('base64');
    const invalidUtf8 = Buffer.from([0xc3, 0x28]).toString('base64');
    const bomPrefixed = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(canonicalJsonForTest(signedRestoreEvidence()), 'utf8'),
    ]).toString('base64');
    const noncanonicalJson = Buffer.from(JSON.stringify(signedRestoreEvidence()), 'utf8').toString('base64');
    const oversized = Buffer.alloc(16 * 1024 + 1, 0x20).toString('base64');
    for (const value of [
      undefined,
      '',
      'not-base64',
      `${encoded}\n`,
      withoutPadding,
      trailingBitAlias,
      noncanonicalJson,
      duplicateKey,
      invalidUtf8,
      bomPrefixed,
      oversized,
    ]) assert.equal(audit.collectFirestoreRestoreEvidenceFromBase64(value, input).readable, false);
  });

  test('has no restore evidence filesystem transport left', async () => {
    const source = await readFile('tools/private-pro/security-audit.ts', 'utf8');
    const docs = `${await readFile('infra/private-pro/firestore-recovery-controls.md', 'utf8')}\n${await readFile('docs/deploy-private-pro-firebase.md', 'utf8')}`;
    const evidenceSource = source.slice(source.indexOf('function decodeCanonicalRestoreEvidenceBase64'), source.indexOf('function runtimeIdentityInput'));

    assert.match(source, /PRIVATE_PRO_FIRESTORE_RESTORE_EVIDENCE_BASE64/);
    assert.doesNotMatch(evidenceSource, /(?:lstat|realpath|readText|canonicalizePath|repoRoot|configuredPath|approvedOperatorRoot)/);
    assert.doesNotMatch(evidenceSource, /PRIVATE_PRO_FIRESTORE_RESTORE_EVIDENCE\?\.trim|PRIVATE_PRO_RESTORE_EVIDENCE_ROOT/);
    assert.doesNotMatch(docs, /PRIVATE_PRO_RESTORE_EVIDENCE_ROOT|firestore-restore-evidence\.json/);
  });

  test('loads restore evidence from only the audit base64 environment variable', async () => {
    const source = await readFile('tools/private-pro/security-audit.ts', 'utf8');
    const evidenceEnvironmentReads = source.match(/process\.env\.PRIVATE_PRO_(?:FIRESTORE_)?RESTORE_EVIDENCE[A-Z0-9_]*/g) ?? [];

    assert.deepEqual([...new Set(evidenceEnvironmentReads)].sort(), [
      'process.env.PRIVATE_PRO_FIRESTORE_RESTORE_EVIDENCE_BASE64',
      'process.env.PRIVATE_PRO_RESTORE_EVIDENCE_EXPECTED_COMMIT_SHA',
    ]);
  });

  test('collects the audited release commit from actual git HEAD', async () => {
    const audit = securityAuditModule as unknown as {
      collectGitReleaseStateWithExecutor(execute: (command: string, args: string[]) => Promise<{ stdout: string }>): Promise<{
        headSha: string;
        clean: boolean;
      }>;
    };
    const calls: Array<{ command: string; args: string[] }> = [];
    const release = await audit.collectGitReleaseStateWithExecutor(async (command, args) => {
      calls.push({ command, args });
      return { stdout: args[0] === 'rev-parse' ? `${TEST_RELEASE_COMMIT}\n` : '' };
    });

    assert.deepEqual(release, { headSha: TEST_RELEASE_COMMIT, clean: true });
    assert.deepEqual(calls, [
      { command: 'git', args: ['rev-parse', 'HEAD'] },
      { command: 'git', args: ['status', '--porcelain', '--untracked-files=normal'] },
    ]);
    const dirty = await audit.collectGitReleaseStateWithExecutor(async (_command, args) => ({
      stdout: args[0] === 'rev-parse' ? `${TEST_RELEASE_COMMIT}\n` : ' M tracked.ts\n',
    }));
    assert.deepEqual(dirty, { headSha: TEST_RELEASE_COMMIT, clean: false });
    await assert.rejects(() => audit.collectGitReleaseStateWithExecutor(async () => ({ stdout: 'not-a-commit\n' })));
  });

  test('loads the restore trust descriptor from the audited HEAD blob', async () => {
    const audit = securityAuditModule as unknown as {
      collectFirestoreRestoreTrustAtHeadWithExecutor(
        headSha: string,
        execute?: (command: string, args: string[], maxBuffer: number) => Promise<{ stdout: Buffer; stderr: Buffer }>,
      ): Promise<unknown>;
    };
    const committedTrust = {
      schemaVersion: 1,
      status: 'unconfigured',
      algorithm: 'Ed25519',
      keyId: 'unconfigured',
      publicKeyJwk: null,
      issuer: 'unconfigured',
      allowedClaims: TEST_TRUST.allowedClaims,
      activatedAt: null,
      expiresAt: null,
      revokedAt: null,
    };
    const calls: Array<{ command: string; args: string[]; maxBuffer: number }> = [];
    const collected = await audit.collectFirestoreRestoreTrustAtHeadWithExecutor(TEST_RELEASE_COMMIT, async (command, args, maxBuffer) => {
      calls.push({ command, args, maxBuffer });
      return { stdout: Buffer.from(JSON.stringify(committedTrust)), stderr: Buffer.alloc(0) };
    });
    assert.deepEqual(collected, committedTrust);
    assert.deepEqual(calls, [{
      command: 'git',
      args: ['show', `${TEST_RELEASE_COMMIT}:infra/private-pro/firestore-restore-attestor-trust.json`],
      maxBuffer: 16 * 1024,
    }]);
    await assert.rejects(() => audit.collectFirestoreRestoreTrustAtHeadWithExecutor(TEST_RELEASE_COMMIT, async () => {
      throw new Error('missing blob');
    }));
    await assert.rejects(() => audit.collectFirestoreRestoreTrustAtHeadWithExecutor('not-a-head', async () => ({
      stdout: Buffer.from('{}'),
      stderr: Buffer.alloc(0),
    })));

    const directory = await mkdtemp(join(tmpdir(), 'restore-trust-head-'));
    const trustDirectory = join(directory, 'infra', 'private-pro');
    const trustPath = join(trustDirectory, 'firestore-restore-attestor-trust.json');
    await mkdir(trustDirectory, { recursive: true });
    const previousCwd = process.cwd();
    try {
      process.chdir(directory);
      await runCommand('git', ['init', '--quiet']);
      await runCommand('git', ['config', 'user.name', 'Private Pro Test']);
      await runCommand('git', ['config', 'user.email', 'private-pro@example.invalid']);
      await writeFile(trustPath, JSON.stringify(committedTrust), 'utf8');
      await runCommand('git', ['add', 'infra/private-pro/firestore-restore-attestor-trust.json']);
      await runCommand('git', ['commit', '--quiet', '-m', 'trust']);
      const head = (await runCommand('git', ['rev-parse', 'HEAD'])).stdout.trim();
      await writeFile(trustPath, JSON.stringify(TEST_TRUST), 'utf8');

      assert.deepEqual(await audit.collectFirestoreRestoreTrustAtHeadWithExecutor(head), committedTrust);
    } finally {
      process.chdir(previousCwd);
    }
  });

  test('ships an explicitly unconfigured restore attestor trust descriptor', async () => {
    const trust = JSON.parse(await readFile('infra/private-pro/firestore-restore-attestor-trust.json', 'utf8')) as Record<string, unknown>;
    assert.deepEqual(trust, {
      schemaVersion: 1,
      status: 'unconfigured',
      algorithm: 'Ed25519',
      keyId: 'unconfigured',
      publicKeyJwk: null,
      issuer: 'unconfigured',
      allowedClaims: {
        repository: 'big-agi/big-agi-private',
        workflowPath: '.github/workflows/private-pro-restore-attest.yml',
        workflowRef: 'refs/heads/dev',
        environment: 'production-recovery',
      },
      activatedAt: null,
      expiresAt: null,
      revokedAt: null,
    });
  });

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

  test('consumes restore evidence once before GoogleAuth and verifies explicitly reinjected input deterministically', async () => {
    const audit = securityAuditModule as unknown as {
      runSecurityAuditWithCollector<T>(collector: (input: {
        readonly evidenceBase64?: string;
        readonly additionalExpectedCommitSha?: string;
      }) => Promise<T>): Promise<T>;
      collectFirestoreRestoreEvidence(
        input: {
          readonly evidenceBase64?: string;
          readonly additionalExpectedCommitSha?: string;
        },
        collectReleaseState: () => Promise<{ headSha: string; clean: boolean }>,
        collectTrustDescriptor: (headSha: string) => Promise<unknown>,
      ): Promise<{ readable: boolean; signatureVerified: boolean; releaseCommitMatches: boolean }>;
      collectActiveAdcServiceAccountEmail(factory: () => Promise<{
        getAccessToken(): Promise<string | null | undefined>;
        getCredentials(): Promise<{ client_email?: string }>;
      }>): Promise<string | undefined>;
    };
    const auditEnvironment = {
      PRIVATE_PRO_FIRESTORE_RESTORE_EVIDENCE_BASE64: restoreEvidenceBase64(),
      PRIVATE_PRO_RESTORE_EVIDENCE_EXPECTED_COMMIT_SHA: TEST_RELEASE_COMMIT,
      PRIVATE_PRO_RESTORE_EVIDENCE_HMAC_KEY: 'obsolete-hmac',
      PRIVATE_PRO_FIRESTORE_RESTORE_EVIDENCE: 'obsolete-path',
      PRIVATE_PRO_RESTORE_EVIDENCE_ROOT: 'obsolete-root',
      GOOGLE_APPLICATION_CREDENTIALS: 'retained-google-credentials.json',
      GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES: '1',
      PRIVATE_PRO_WIF_RUNTIME_PRINCIPALS: 'principal://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/vercel-prod/subject/deploy',
    } as const;
    const evidenceEnvironmentNames = Object.keys(auditEnvironment).filter(name => name.includes('RESTORE_EVIDENCE'));
    const previous = Object.fromEntries(Object.keys(auditEnvironment).map(name => [name, process.env[name]]));
    const runOnce = async () => audit.runSecurityAuditWithCollector(async input => {
      assert.equal(Object.isFrozen(input), true);
      assert.equal(input.evidenceBase64, auditEnvironment.PRIVATE_PRO_FIRESTORE_RESTORE_EVIDENCE_BASE64);
      assert.equal(input.additionalExpectedCommitSha, TEST_RELEASE_COMMIT);
      for (const name of evidenceEnvironmentNames) assert.equal(process.env[name], undefined, name);
      assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, auditEnvironment.GOOGLE_APPLICATION_CREDENTIALS);
      assert.equal(process.env.GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES, '1');
      assert.equal(process.env.PRIVATE_PRO_WIF_RUNTIME_PRINCIPALS, auditEnvironment.PRIVATE_PRO_WIF_RUNTIME_PRINCIPALS);

      const activeEmail = await audit.collectActiveAdcServiceAccountEmail(async () => {
        const credentialExecutable = JSON.parse(execFileSync(process.execPath, ['-e', `
          process.stdout.write(JSON.stringify({
            evidence: !!process.env.PRIVATE_PRO_FIRESTORE_RESTORE_EVIDENCE_BASE64,
            expectedCommit: !!process.env.PRIVATE_PRO_RESTORE_EVIDENCE_EXPECTED_COMMIT_SHA,
            legacyHmac: !!process.env.PRIVATE_PRO_RESTORE_EVIDENCE_HMAC_KEY,
            legacyPath: !!process.env.PRIVATE_PRO_FIRESTORE_RESTORE_EVIDENCE,
            legacyRoot: !!process.env.PRIVATE_PRO_RESTORE_EVIDENCE_ROOT,
            googleCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS,
          }));
        `], { encoding: 'utf8' })) as Record<string, unknown>;
        assert.deepEqual(credentialExecutable, {
          evidence: false,
          expectedCommit: false,
          legacyHmac: false,
          legacyPath: false,
          legacyRoot: false,
          googleCredentials: auditEnvironment.GOOGLE_APPLICATION_CREDENTIALS,
        });
        return {
          async getAccessToken() { return 'test-access-token'; },
          async getCredentials() { return { client_email: 'private-pro-runtime@sample-project.iam.gserviceaccount.com' }; },
        };
      });
      const genericChild = JSON.parse((await runCommand(process.execPath, ['-e', `
        process.stdout.write(JSON.stringify({
          evidence: !!process.env.PRIVATE_PRO_FIRESTORE_RESTORE_EVIDENCE_BASE64,
          expectedCommit: !!process.env.PRIVATE_PRO_RESTORE_EVIDENCE_EXPECTED_COMMIT_SHA,
          legacyHmac: !!process.env.PRIVATE_PRO_RESTORE_EVIDENCE_HMAC_KEY,
          googleCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS,
        }));
      `])).stdout) as Record<string, unknown>;
      const evidence = await audit.collectFirestoreRestoreEvidence(
        input,
        async () => ({ headSha: TEST_RELEASE_COMMIT, clean: true }),
        async headSha => {
          assert.equal(headSha, TEST_RELEASE_COMMIT);
          return TEST_TRUST;
        },
      );
      return {
        activeEmail,
        genericChild,
        evidence: {
          readable: evidence.readable,
          signatureVerified: evidence.signatureVerified,
          releaseCommitMatches: evidence.releaseCommitMatches,
        },
      };
    });

    try {
      Object.assign(process.env, auditEnvironment);
      const first = await runOnce();
      for (const name of evidenceEnvironmentNames) assert.equal(process.env[name], undefined, name);

      const consumed = await audit.runSecurityAuditWithCollector(async input => input);
      assert.equal(Object.isFrozen(consumed), true);
      assert.deepEqual(consumed, {});

      Object.assign(process.env, auditEnvironment);
      const second = await runOnce();
      assert.deepEqual(second, first);
      assert.deepEqual(first, {
        activeEmail: 'private-pro-runtime@sample-project.iam.gserviceaccount.com',
        genericChild: {
          evidence: false,
          expectedCommit: false,
          legacyHmac: false,
          googleCredentials: auditEnvironment.GOOGLE_APPLICATION_CREDENTIALS,
        },
        evidence: {
          readable: true,
          signatureVerified: true,
          releaseCommitMatches: true,
        },
      });
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('scrubs audit evidence and attestation secrets from child processes', async () => {
    const evidence = restoreEvidenceBase64();
    const names = {
      PRIVATE_PRO_FIRESTORE_RESTORE_EVIDENCE_BASE64: evidence,
      PRIVATE_PRO_RESTORE_EVIDENCE_HMAC_KEY: 'legacy-hmac',
      PRIVATE_PRO_FIRESTORE_RESTORE_ATTESTOR_PRIVATE_KEY: 'attestor-private-key',
      PRIVATE_PRO_FIRESTORE_RESTORE_ATTESTATION_SECRET: 'attestation-secret',
      PRIVATE_PRO_FIRESTORE_RESTORE_PRIVATE_KEY: 'future-private-key',
      PRIVATE_PRO_FUTURE_ATTEST_PRIVATE_KEY: 'future-attest-key',
      PRIVATE_PRO_RESTORE_SIGNING_KEY: 'future-signing-key',
      PRIVATE_PRO_FIRESTORE_RESTORE_ACCESS_TOKEN: 'future-access-token',
      PRIVATE_PRO_CHILD_ENV_SENTINEL: 'ordinary-value',
    } as const;
    const previous = Object.fromEntries(Object.keys(names).map(name => [name, process.env[name]]));
    try {
      Object.assign(process.env, names);
      const result = await runCommand(process.execPath, ['-e', `
        process.stdout.write(JSON.stringify({
          evidence: !!process.env.PRIVATE_PRO_FIRESTORE_RESTORE_EVIDENCE_BASE64,
          legacyHmac: !!process.env.PRIVATE_PRO_RESTORE_EVIDENCE_HMAC_KEY,
          attestorKey: !!process.env.PRIVATE_PRO_FIRESTORE_RESTORE_ATTESTOR_PRIVATE_KEY,
          attestationSecret: !!process.env.PRIVATE_PRO_FIRESTORE_RESTORE_ATTESTATION_SECRET,
          futurePrivateKey: !!process.env.PRIVATE_PRO_FIRESTORE_RESTORE_PRIVATE_KEY,
          futureAttestKey: !!process.env.PRIVATE_PRO_FUTURE_ATTEST_PRIVATE_KEY,
          futureSigningKey: !!process.env.PRIVATE_PRO_RESTORE_SIGNING_KEY,
          futureAccessToken: !!process.env.PRIVATE_PRO_FIRESTORE_RESTORE_ACCESS_TOKEN,
          ordinary: process.env.PRIVATE_PRO_CHILD_ENV_SENTINEL,
        }));
      `]);

      assert.deepEqual(JSON.parse(result.stdout), {
        evidence: false,
        legacyHmac: false,
        attestorKey: false,
        attestationSecret: false,
        futurePrivateKey: false,
        futureAttestKey: false,
        futureSigningKey: false,
        futureAccessToken: false,
        ordinary: 'ordinary-value',
      });
      assert.equal(process.env.PRIVATE_PRO_FIRESTORE_RESTORE_EVIDENCE_BASE64, evidence);
      assert.equal((securityAuditModule as unknown as {
        collectFirestoreRestoreEvidenceFromBase64(value: string | undefined, input: {
          nowMs: number;
          actualHeadSha: string;
          trustDescriptor: unknown;
        }): { readable: boolean };
      }).collectFirestoreRestoreEvidenceFromBase64(process.env.PRIVATE_PRO_FIRESTORE_RESTORE_EVIDENCE_BASE64, {
        nowMs: Date.parse('2026-08-18T12:00:00Z'),
        actualHeadSha: TEST_RELEASE_COMMIT,
        trustDescriptor: TEST_TRUST,
      }).readable, true);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
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

  test('accepts only the origin-preserving production referrer policy', () => {
    assert.equal(isAllowedReferrerPolicy('strict-origin-when-cross-origin'), true);
    assert.equal(isAllowedReferrerPolicy(' STRICT-ORIGIN-WHEN-CROSS-ORIGIN '), true);
    assert.equal(isAllowedReferrerPolicy('no-referrer'), false);
    assert.equal(isAllowedReferrerPolicy('origin'), false);
    assert.equal(isAllowedReferrerPolicy(''), false);
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

  test('passes only the exact two production Firebase Auth domains', () => {
    const exact = inspectAuthorizedDomains({ authorizedDomains: ['chatgpt.ashesh.dev', 'big-agi-243b6.firebaseapp.com'] });
    const localAndStale = inspectAuthorizedDomains({ authorizedDomains: ['chatgpt.ashesh.dev', 'localhost', 'old.vercel.app'] });
    const empty = inspectAuthorizedDomains({ authorizedDomains: [] });

    assert.equal(classifyAuthorizedDomains(exact).every(finding => finding.severity === 'pass'), true);
    assert.equal(classifyAuthorizedDomains(localAndStale).some(finding => finding.severity === 'block'), true);
    assert.equal(classifyAuthorizedDomains(empty).some(finding => finding.severity === 'block'), true);
    assert.equal(classifyAuthorizedDomains(inspectAuthorizedDomains({
      authorizedDomains: ['chatgpt.ashesh.dev', 'big-agi-243b6.firebaseapp.com', 'chatgpt.ashesh.dev'],
    })).some(finding => finding.severity === 'block'), true);
  });

  test('blocks a non-ready deployment and stale production aliases', () => {
    const findings = classifyDeployment({ ready: false, production: true, exactAliases: 1, staleAliases: 2 });

    assert.deepEqual(severities(findings), ['block', 'pass', 'pass', 'block']);
  });

  test('passes only one exact production deployment alias', () => {
    assert.equal(classifyDeployment(inspectDeployment({
      readyState: 'READY',
      target: 'production',
      aliases: ['chatgpt.ashesh.dev'],
    })).every(finding => finding.severity === 'pass'), true);
    assert.equal(classifyDeployment(inspectDeployment({
      readyState: 'READY',
      target: 'production',
      aliases: ['chatgpt.ashesh.dev', 'private-pro.vercel.app'],
    })).some(finding => finding.severity === 'block'), true);
    assert.equal(classifyDeployment(inspectDeployment({
      readyState: 'READY',
      target: 'production',
      aliases: ['chatgpt.ashesh.dev', 'chatgpt.ashesh.dev'],
    })).some(finding => finding.severity === 'block'), true);
  });

  test('blocks an unrestricted browser API key', () => {
    const findings = classifyBrowserApiKeys({ total: 1, unrestricted: 1, missingExpectedReferrers: 2, staleReferrers: 0, broadReferrers: 1, missingRequiredApiTargets: 2, unrelatedApiTargets: 0, duplicateReferrers: 0, duplicateApiTargets: 0 });

    assert.deepEqual(severities(findings), ['pass', 'block', 'block', 'pass', 'block', 'block', 'pass', 'pass', 'pass']);
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
      duplicateReferrers: 0,
      duplicateApiTargets: 0,
    });
  });

  test('passes the exact mounted browser Firebase API restriction', () => {
    const facts = inspectBrowserApiKeys([{ restrictions: {
      browserKeyRestrictions: { allowedReferrers: ['https://chatgpt.ashesh.dev/*', 'https://big-agi-243b6.firebaseapp.com/*'] },
      apiTargets: [
        { service: 'firebaseappcheck.googleapis.com' },
        { service: 'identitytoolkit.googleapis.com' },
        { service: 'securetoken.googleapis.com' },
        { service: 'firestore.googleapis.com' },
        { service: 'firebasestorage.googleapis.com' },
      ],
    } }]);

    assert.equal(classifyBrowserApiKeys(facts).every(finding => finding.severity === 'pass'), true);
    assert.equal(classifyBrowserApiKeys(inspectBrowserApiKeys([
      { restrictions: { browserKeyRestrictions: { allowedReferrers: ['https://chatgpt.ashesh.dev/*', 'https://big-agi-243b6.firebaseapp.com/*'] }, apiTargets: [
        { service: 'firebaseappcheck.googleapis.com' },
        { service: 'identitytoolkit.googleapis.com' }, { service: 'securetoken.googleapis.com' },
        { service: 'firestore.googleapis.com' }, { service: 'firebasestorage.googleapis.com' },
      ] } },
      { restrictions: { browserKeyRestrictions: { allowedReferrers: ['https://chatgpt.ashesh.dev/*', 'https://big-agi-243b6.firebaseapp.com/*'] }, apiTargets: [
        { service: 'firebaseappcheck.googleapis.com' },
        { service: 'identitytoolkit.googleapis.com' }, { service: 'securetoken.googleapis.com' },
        { service: 'firestore.googleapis.com' }, { service: 'firebasestorage.googleapis.com' },
      ] } },
    ])).some(finding => finding.severity === 'block'), true);
    assert.equal(classifyBrowserApiKeys(inspectBrowserApiKeys([{ restrictions: {
      browserKeyRestrictions: { allowedReferrers: ['https://chatgpt.ashesh.dev/*', 'https://chatgpt.ashesh.dev/*', 'https://big-agi-243b6.firebaseapp.com/*'] },
      apiTargets: [
        { service: 'firebaseappcheck.googleapis.com' }, { service: 'firebaseappcheck.googleapis.com' },
        { service: 'identitytoolkit.googleapis.com' },
        { service: 'securetoken.googleapis.com' },
        { service: 'firestore.googleapis.com' },
        { service: 'firebasestorage.googleapis.com' },
      ],
    } }])).some(finding => finding.severity === 'block'), true);
  });

  test('accepts only a global API key resource from the expected project number', () => {
    assert.equal(inspectProjectNumber({ projectNumber: '123' }), '123');
    assert.throws(() => inspectProjectNumber({ projectNumber: 'project-id' }));
    assert.equal(inspectApiKeyLookup({ name: 'projects/123/locations/global/keys/browser-key-id' }, '123'), 'projects/123/locations/global/keys/browser-key-id');
    assert.throws(() => inspectApiKeyLookup({}, '123'));
    assert.throws(() => inspectApiKeyLookup({ name: 'not-a-key-resource' }, '123'));
    assert.throws(() => inspectApiKeyLookup({ name: 'projects/456/locations/global/keys/browser-key-id' }, '123'));
    assert.throws(() => inspectApiKeyLookup({ name: 'projects/123/locations/us-central1/keys/browser-key-id' }, '123'));
  });

  test('collects the numeric project number with a read-only project describe command', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const projectNumber = await collectProjectNumber('big-agi-243b6', async (command, args) => {
      calls.push({ command, args });
      return { projectNumber: '123456789012' };
    });

    assert.equal(projectNumber, '123456789012');
    assert.deepEqual(calls, [{
      command: 'gcloud',
      args: ['projects', 'describe', 'big-agi-243b6', '--format=json'],
    }]);
  });

  test('blocks empty, missing, stale, broad, and unrelated browser API key restrictions', () => {
    const empty = inspectBrowserApiKeys([{ restrictions: {} }]);
    const wrong = inspectBrowserApiKeys([{ restrictions: {
      browserKeyRestrictions: { allowedReferrers: ['https://chatgpt.ashesh.dev/*', 'https://*.ashesh.dev/*', 'http://localhost:3000/*'] },
      apiTargets: [
        { service: 'identitytoolkit.googleapis.com' },
        { service: 'firestore.googleapis.com' },
        { service: 'firebasestorage.googleapis.com' },
      ],
    } }]);

    assert.equal(classifyBrowserApiKeys(empty).some(finding => finding.severity === 'block'), true);
    assert.equal(classifyBrowserApiKeys(wrong).some(finding => finding.severity === 'block'), true);
    assert.equal(wrong.missingRequiredApiTargets, 2);
    assert.equal(wrong.unrelatedApiTargets, 0);
  });

  test('passes only the checked-in Firebase Web Storage trace CORS', async () => {
    const trace = JSON.parse(await readFile('infra/private-pro/firebase-storage-cors-trace.json', 'utf8')) as {
      expectedCors: unknown;
    };
    assert.deepEqual(trace.expectedCors, EXPECTED_PRIVATE_PRO_BUCKET_CORS);
    const exact = inspectBucketCors({ cors: EXPECTED_PRIVATE_PRO_BUCKET_CORS });

    assert.equal(classifyBucketCors(exact).every(finding => finding.severity === 'pass'), true);
    assert.equal(classifyBucketCors(inspectBucketCors({ cors_config: [{
      origin: ['https://chatgpt.ashesh.dev', 'https://big-agi-243b6.firebaseapp.com'],
      method: ['DELETE', 'GET', 'POST'],
      responseHeader: [...EXPECTED_PRIVATE_PRO_BUCKET_CORS[0].responseHeader],
      maxAgeSeconds: 3600,
    }] })).every(finding => finding.severity === 'pass'), true);
  });

  test('blocks empty, wildcard, broad, stale, and missing-header bucket CORS', () => {
    const unreadable = inspectBucketCors({});
    const empty = inspectBucketCors({ cors_config: [] });
    const broad = inspectBucketCors({ cors: [{
      origin: ['https://*.ashesh.dev', 'https://old.vercel.app'],
      method: ['GET', 'HEAD', 'PUT', 'POST'],
      responseHeader: ['x-goog-*', 'Content-Type'],
    }] });
    const missingUploadHeader = inspectBucketCors({ cors: [{
      origin: ['https://chatgpt.ashesh.dev', 'https://big-agi-243b6.firebaseapp.com'],
      method: ['DELETE', 'GET', 'POST'],
      responseHeader: EXPECTED_PRIVATE_PRO_BUCKET_CORS[0].responseHeader.filter(header => header !== 'X-Goog-Upload-URL'),
      maxAgeSeconds: 3600,
    }] });
    const duplicates = inspectBucketCors({ cors: [{
      origin: ['https://chatgpt.ashesh.dev', 'https://chatgpt.ashesh.dev', 'https://big-agi-243b6.firebaseapp.com'],
      method: ['DELETE', 'GET', 'GET', 'POST'],
      responseHeader: [...EXPECTED_PRIVATE_PRO_BUCKET_CORS[0].responseHeader, 'Content-Type'],
      maxAgeSeconds: 3600,
    }] });
    const wrongMaxAge = inspectBucketCors({ cors: [{
      ...EXPECTED_PRIVATE_PRO_BUCKET_CORS[0],
      maxAgeSeconds: 60,
    }] });

    assert.equal(classifyBucketCors(unreadable)[0].severity, 'block');
    assert.equal(empty.readable, true);
    assert.equal(classifyBucketCors(empty).some(finding => finding.severity === 'block'), true);
    assert.equal(classifyBucketCors(broad).some(finding => finding.severity === 'block'), true);
    assert.equal(broad.wildcardOrigins, 1);
    assert.equal(broad.wildcardHeaders, 1);
    assert.equal(classifyBucketCors(missingUploadHeader).some(finding => finding.severity === 'block'), true);
    assert.equal(classifyBucketCors(duplicates).some(finding => finding.severity === 'block'), true);
    assert.equal(classifyBucketCors(wrongMaxAge).some(finding => finding.severity === 'block'), true);
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

  test('validates the exact runtime permission allowlist without signing access', async () => {
    const manifest = JSON.parse(await readFile('infra/private-pro/gcp-runtime-role.yaml', 'utf8')) as unknown;
    const facts = inspectRuntimeRoleManifest(manifest);

    assert.deepEqual(facts, {
      readable: true,
      schemaErrors: 0,
      missingRuntimePermissions: 0,
      unexpectedRuntimePermissions: 0,
      forbiddenRuntimePermissions: 0,
      signBlobInRuntimeRole: 0,
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
    permissions.push('iam.serviceAccounts.signBlob');
    permissions.sort();
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
        'datastore.entities.get',
        'datastore.entities.update',
        'firebaseauth.users.get',
        'firebaseauth.users.update',
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

  test('uses the supported gcloud custom-role describe argument vector', async () => {
    const audit = securityAuditModule as unknown as {
      collectDeployedRuntimeRoleWithExecutor(
        projectId: string,
        manifest: unknown,
        execute: (command: string, args: string[]) => Promise<unknown>,
      ): Promise<{
        readable: boolean;
        nameMatches: boolean;
        stageMatches: boolean;
        active: boolean;
        missingPermissions: number;
        unexpectedPermissions: number;
      }>;
    };
    const manifest = JSON.parse(await readFile('infra/private-pro/gcp-runtime-role.yaml', 'utf8')) as {
      runtimeRole: { includedPermissions: string[] };
    };
    const calls: Array<{ command: string; args: string[] }> = [];

    const facts = await audit.collectDeployedRuntimeRoleWithExecutor('sample-project', manifest, async (command, args) => {
      calls.push({ command, args });
      return {
        name: 'projects/sample-project/roles/privateProRuntime',
        stage: 'GA',
        deleted: false,
        includedPermissions: manifest.runtimeRole.includedPermissions,
      };
    });

    assert.deepEqual(calls, [{
      command: 'gcloud',
      args: ['iam', 'roles', 'describe', 'privateProRuntime', '--project=sample-project', '--format=json'],
    }]);
    assert.deepEqual(facts, {
      readable: true,
      nameMatches: true,
      stageMatches: true,
      active: true,
      missingPermissions: 0,
      unexpectedPermissions: 0,
    });
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

  test('enforces the exact service-account WIF policy without signing bindings', () => {
    const audit = securityAuditModule as unknown as {
      inspectRuntimeServiceAccountPolicy(value: unknown, runtimeEmail: string, wifPrincipals: ReadonlySet<string>): {
        readable: boolean;
        missingWifPrincipals: number;
        unexpectedWifPrincipals: number;
        unexpectedBindings: number;
      };
      classifyRuntimeServiceAccountPolicy(facts: ReturnType<typeof audit.inspectRuntimeServiceAccountPolicy>): AuditFinding[];
    };
    const runtimeEmail = 'private-pro-runtime@sample-project.iam.gserviceaccount.com';
    const wif = 'principalSet://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/vercel/attribute.repository/org/repo';
    const expected = audit.inspectRuntimeServiceAccountPolicy({ bindings: [
      { role: 'roles/iam.workloadIdentityUser', members: [wif] },
    ] }, runtimeEmail, new Set([wif]));
    const extra = audit.inspectRuntimeServiceAccountPolicy({ bindings: [
      { role: 'roles/iam.workloadIdentityUser', members: [wif, 'principal://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/vercel/subject/other'] },
      { role: 'roles/iam.serviceAccountTokenCreator', members: [`serviceAccount:${runtimeEmail}`, wif] },
      { role: 'roles/iam.serviceAccountUser', members: [wif] },
    ] }, runtimeEmail, new Set([wif]));

    assert.equal(audit.classifyRuntimeServiceAccountPolicy(expected).every(finding => finding.severity === 'pass'), true);
    assert.deepEqual(severities(audit.classifyRuntimeServiceAccountPolicy(extra)), ['pass', 'pass', 'block', 'block']);
  });

  test('accepts only exact bounded WIF subject, attribute, and group members from one pool', () => {
    const audit = securityAuditModule as unknown as {
      parseConfiguredWifPrincipals(raw: string): ReadonlySet<string>;
    };
    const subject = 'principal://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/vercel-prod/subject/repo:example-org/example-repo:environment:production';
    const attribute = 'principalSet://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/vercel-prod/attribute.repository/example-org/example-repo';
    const group = 'principalSet://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/vercel-prod/group/deployers@example.com';

    assert.deepEqual([...audit.parseConfiguredWifPrincipals(`${subject}, ${attribute}, ${group}`)], [subject, attribute, group]);

    const invalid = [
      'user:owner@example.com',
      'serviceAccount:runtime@example.iam.gserviceaccount.com',
      'domain:example.com',
      'allUsers',
      'allAuthenticatedUsers',
      'principal://iam.googleapis.com/projects/project-id/locations/global/workloadIdentityPools/vercel-prod/subject/repo:org/repo',
      'principal://iam.googleapis.com/projects/123/locations/us-central1/workloadIdentityPools/vercel-prod/subject/repo:org/repo',
      'principal://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/x/subject/repo:org/repo',
      'principal://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/vercel-prod/subject/',
      'principalSet://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/vercel-prod/*',
      'principalSet://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/vercel-prod/attribute.repository/*',
      'principalSet://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/vercel-prod/attribute./org/repo',
      'principalSet://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/vercel-prod/group/',
      'principalSet://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/vercel-prod/subject/repo:org/repo',
      'principalSet://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/vercel-prod',
      'principalSet://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/vercel-prod/attribute.repository/org/repo?broad=true',
    ];
    for (const member of invalid)
      assert.throws(() => audit.parseConfiguredWifPrincipals(member), /WIF runtime principal/i, member);

    assert.throws(
      () => audit.parseConfiguredWifPrincipals(`${subject},principalSet://iam.googleapis.com/projects/999/locations/global/workloadIdentityPools/vercel-prod/group/deployers`),
      /same project number and pool/i,
    );
    assert.throws(
      () => audit.parseConfiguredWifPrincipals(`${subject},principalSet://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/other-pool/group/deployers`),
      /same project number and pool/i,
    );
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

  test('collects anonymous endpoint write denial, allowed cleanup, and unknown outcomes', async () => {
    const requests: Array<{ url: string; method: string; body?: BodyInit | null; headers?: HeadersInit }> = [];
    const denied = await collectFirebaseEndpointProbes({
      projectId: 'sample-project',
      storageBucket: 'sample-project.firebasestorage.app',
      apiKey: 'secret-api-key',
      auditUid: 'firebase-uid-a',
      operationId: '123e4567-e89b-42d3-a456-426614174000',
      cleanupFirestore: async () => true,
      cleanupStorage: async () => true,
      fetch: async (url, init) => {
        requests.push({ url: String(url).replace('secret-api-key', '<key>'), method: init?.method ?? 'GET', body: init?.body, headers: init?.headers });
        return new Response('', { status: 403 });
      },
    });
    assert.deepEqual(denied, { firestoreRead: 'denied', firestoreWrite: 'denied', storageRead: 'denied', storageWrite: 'denied' });

    requests.length = 0;
    const allowed = await collectFirebaseEndpointProbes({
      projectId: 'sample-project',
      storageBucket: 'sample-project.firebasestorage.app',
      apiKey: 'secret-api-key',
      auditUid: 'firebase-uid-a',
      operationId: '123e4567-e89b-42d3-a456-426614174000',
      cleanupFirestore: async paths => { requests.push({ url: paths.join(','), method: 'ADMIN_DELETE' }); return true; },
      cleanupStorage: async paths => { requests.push({ url: paths.join(','), method: 'ADMIN_DELETE' }); return true; },
      fetch: async (url, init) => {
        requests.push({ url: String(url).replace('secret-api-key', '<key>'), method: init?.method ?? 'GET', body: init?.body, headers: init?.headers });
        return new Response('', { status: 200 });
      },
    });
    assert.deepEqual(allowed, { firestoreRead: 'allowed', firestoreWrite: 'allowed', storageRead: 'allowed', storageWrite: 'allowed' });
    assert.equal(requests.filter(request => request.method === 'ADMIN_DELETE').length, 2);
    const commit = requests.find(request => request.url.includes('documents:commit'));
    assert.match(String(commit?.body), /security-audit/);
    assert.match(String(commit?.body), /updateTransforms/);
    const upload = requests.find(request => request.url.includes('uploadType=multipart'));
    assert.match((upload?.headers as Record<string, string>)['content-type'], /^multipart\/related; boundary=/);
    assert.match(String(upload?.body), /"contentType":"image\/png"/);
    assert.match(String(upload?.body), /"uid":"firebase-uid-a"/);
    assert.match(String(upload?.url), /workspace-v1%2Fassets%2Faudit%2Foriginal/);
    assert.doesNotMatch(JSON.stringify(requests), /secret-api-key/);

    const unknown = await collectFirebaseEndpointProbes({
      projectId: 'sample-project',
      storageBucket: 'sample-project.firebasestorage.app',
      apiKey: 'secret-api-key',
      auditUid: 'firebase-uid-a',
      operationId: '123e4567-e89b-42d3-a456-426614174000',
      cleanupFirestore: async () => true,
      cleanupStorage: async () => true,
      fetch: async () => { throw new Error('network secret'); },
    });
    assert.deepEqual(unknown, { firestoreRead: 'unknown', firestoreWrite: 'unknown', storageRead: 'unknown', storageWrite: 'unknown' });
  });

  test('validates the audit UID account, Auth identity, allowlist, and matching epoch', () => {
    assert.doesNotThrow(() => assertPrivateProSecurityAuditIdentity({
      auditUid: 'uid-a',
      account: { uid: 'uid-a', active: true, accessEpoch: 7 },
      auth: { uid: 'uid-a', email: 'User@Example.com', emailVerified: true, claims: { privatePro: true, privateProEpoch: 7 } },
      allowedEmails: new Set(['user@example.com']),
    }));
    for (const mutate of [
      (input: any) => { input.account.uid = 'other'; },
      (input: any) => { input.account.active = false; },
      (input: any) => { input.account.accessEpoch = 1.5; },
      (input: any) => { input.auth.emailVerified = false; },
      (input: any) => { input.auth.claims.privatePro = false; },
      (input: any) => { input.auth.claims.privateProEpoch = 6; },
      (input: any) => { input.allowedEmails = new Set(['other@example.com']); },
    ]) {
      const input = {
        auditUid: 'uid-a', account: { uid: 'uid-a', active: true, accessEpoch: 7 },
        auth: { uid: 'uid-a', email: 'user@example.com', emailVerified: true, claims: { privatePro: true, privateProEpoch: 7 } },
        allowedEmails: new Set(['user@example.com']),
      };
      mutate(input);
      assert.throws(() => assertPrivateProSecurityAuditIdentity(input), /audit identity/i);
    }
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
      duplicateReferrers: 0,
      duplicateApiTargets: 0,
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
