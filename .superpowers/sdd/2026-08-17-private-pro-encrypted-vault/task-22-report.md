# Task 22 report

## Status

Local and read-only preparation complete. No deletion-protection update, PITR update, backup schedule, export job, Cloud Storage bucket, lifecycle rule, scheduler, runtime, IAM binding, restore database, deployment, or cleanup ran.

Current blocker: Firestore deletion protection is disabled.

Pending decision: PITR is disabled. The user must select an RPO/RTO and accept the measured cost before PITR or scheduled exports are provisioned.

## Read-only state

The following command ran successfully and only described the database:

```text
gcloud firestore databases describe --database=(default) --project=big-agi-243b6 --format=json
```

Raw output was not saved. The reduced state is:

- database type: `FIRESTORE_NATIVE`;
- database edition: `STANDARD`;
- location: `us-central1`;
- deletion protection: `DELETE_PROTECTION_DISABLED`;
- PITR: `POINT_IN_TIME_RECOVERY_DISABLED`;
- earliest version time: `2026-08-18T11:30:50Z`, rounded to seconds;
- version retention period: `3600s`;
- cloud mutations: zero.

The safe snapshot is `task-22-before-redacted.json`. It has no project number, token, raw policy, database resource name, user identifier, key, raw record, or billing account identifier.

## Changes

- Added strict Firestore database recovery-state inspection to `tools/private-pro/security-audit.ts`.
- Added the exact read-only `gcloud firestore databases describe` collector.
- Added fail-closed classification for unreadable resources and unknown enum values.
- Added a deployment blocker when deletion protection is disabled or unspecified.
- Added a warning for explicitly disabled PITR because the paid-control decision remains pending.
- Added a strict redacted restore-rehearsal evidence validator.
- Added fixtures for deletion protection enabled, disabled, and unspecified; PITR enabled, disabled, and unknown; malformed database shapes; wrong database identity; command arguments; and restore evidence shape.
- Added `infra/private-pro/firestore-recovery-controls.md` with current state, read-only collection, exact approval-required enable/disable commands, option comparison, cost inputs, restore rehearsal, evidence schema, and RTO/RPO ownership.
- Updated `docs/deploy-private-pro-firebase.md` with the blocker, separate cost decision, restore-rehearsal gate, and Task 12 distinction.

## Option ruling

Firestore PITR provides one-minute recovery points in a seven-day window after the window accumulates. Recovery clones to a new database in the same location. PITR storage and clone operations are paid and not in the free quota.

The Task 12 encrypted backup is a user password or recovery-key archive. It is interactive and not safe to schedule server-side without a separate noninteractive key design.

A scheduled Firestore managed export is different. It exports the application ciphertext and Firestore metadata already stored in the database. It can support infrastructure recovery, including import to an isolated database or project, but it is not the Task 12 archive and does not make data decryptable without the user's vault key.

No recovery option was selected on the user's behalf.

## Cost ruling

No dollar estimate was invented. The official Firestore pricing page varies by location and edition, and account-specific prices may include currency and contract discounts.

The exact decision requires:

- `us-central1`, Standard edition;
- average database and index GiB;
- clone or restore frequency and size;
- for exports, document count, frequency, output GiB, storage class, retention, bucket location, runtime, scheduler, logging, import frequency, and possible network transfer;
- billing-account-specific SKU prices from the billing price table or Pricing API.

## Approval questions

1. Approve enabling deletion protection with:

   ```text
   gcloud firestore databases update --database='(default)' --project=big-agi-243b6 --delete-protection
   ```

2. What are the required RPO and RTO?
3. After reviewing the measured estimate, select PITR, scheduled Firestore ciphertext exports, both, or explicit acceptance of the remaining risk.
4. If exports are selected, approve a separate design for schedule, retention, bucket, runtime, IAM, monitoring, rehearsal target, and cost ceiling.
5. Approve a non-destructive restore rehearsal only after its isolated target and cleanup plan are reviewed.

## TDD

RED:

```text
39 tests: 35 passed, 4 failed
```

The four failures were the missing Firestore recovery inspector/classifier, missing read-only collector, and missing restore evidence validator.

GREEN:

```text
39 tests: 39 passed, 0 failed
```

## Verification

- Focused security-audit tests: 39 passed, 0 failed.
- Focused Task 22 TypeScript project for `security-audit.ts` and its tests: passed. The temporary project file was deleted and is not committed.
- `npm run private-pro:security-audit -- --report-only`: exited 0. The redacted report contained 42 pass, 8 warn, and 25 block findings across the existing audit. The new `firestoreRecovery` area was readable, matched `(default)`, blocked disabled deletion protection, passed the one-hour retention consistency check, reported one timestamp-present count, and warned that the PITR decision is pending.
- No raw Firestore database resource, database resource name, project number, access token, IAM policy, user data, or ciphertext appeared in the audit report.
- All Private Pro tool tests: 44 passed, 0 failed.
- `npm run tscheck`: blocked by the existing duplicate-React type collision with 337 root-project errors in 152 files. The tools-only leg reported only the known 5 JSX/ReactNode errors in 4 unrelated application files and no Task 22 error.
- Focused ESLint was blocked before file analysis by the existing `@rushstack/eslint-patch` caller-recognition error.
- Redacted snapshot JSON and report-only audit JSON: parsed successfully. The parsed audit asserted the deletion-protection blocker and PITR decision warning; the snapshot asserted zero cloud mutations.
- Task 22 artifact secret scan: passed.
- `git diff --check`: passed.

Final verification reran the focused TypeScript project, all 44 Private Pro tool tests, the report-only audit JSON assertions, the zero-mutation snapshot assertion, and `git diff --check` against the final implementation. All passed.

## Sources

Official sources accessed 2026-08-18:

- <https://cloud.google.com/firestore/docs/reference/rest/v1/projects.databases>
- <https://cloud.google.com/firestore/docs/manage-databases>
- <https://cloud.google.com/sdk/gcloud/reference/firestore/databases/describe>
- <https://cloud.google.com/sdk/gcloud/reference/firestore/databases/update>
- <https://firebase.google.com/docs/firestore/use-pitr>
- <https://cloud.google.com/sdk/gcloud/reference/firestore/databases/clone>
- <https://firebase.google.com/docs/firestore/manage-data/export-import>
- <https://firebase.google.com/docs/firestore/solutions/schedule-export>
- <https://cloud.google.com/firestore/pricing>
- <https://firebase.google.com/docs/firestore/enterprise/pricing>
- <https://cloud.google.com/storage/pricing>
- <https://cloud.google.com/scheduler/pricing>
- <https://cloud.google.com/run/pricing>
- <https://cloud.google.com/products/calculator>
- <https://cloud.google.com/billing/docs/how-to/pricing-table>
- <https://cloud.google.com/billing/docs/how-to/get-pricing-information-api>

## Cloud boundary

All approval-required commands in the runbook are documentation only. No mutation occurred.

## Fix round 1

Status: complete. No cloud mutation occurred.

### Review findings

The first implementation overstated normal managed export consistency, allowed partial Firestore database resources to pass, did not make restore evidence part of the security audit, omitted native scheduled backups, and did not list the current official `us-central1` public rates.

### Changes

- Corrected managed export/import semantics:
  - A normal export is not an exact snapshot at export start and can include changes made while it runs.
  - A whole-minute PITR `--snapshot-time` is the explicit point-in-time export path where supported.
  - Exports omit index definitions.
  - Imports use current target index definitions, overwrite matching IDs, and retain unrelated target documents.
  - Export/import rehearsals now require a freshly created empty isolated non-default target, separate index/rule/TTL/config deployment, redacted document counts, keyed ciphertext hashes, and application reconstruction.
- Tightened Firestore database collection to require exact name, `FIRESTORE_NATIVE`, `STANDARD`, nonempty location, deletion protection, PITR enablement, earliest version time, and retention period. Only disabled PITR plus `3600s` or enabled PITR plus `604800s` is readable. Missing, malformed, unknown, or inconsistent fields block.
- Changed `earliestVersionTimePresent` from a constant pass to a real blocker when absent.
- Added a restore evidence release gate. Its initial transport was superseded in fix round 4.
- Missing, malformed, failed, older-than-90-day, changed-source, non-isolated, default-target, non-empty-target, index/rule/config, count/hash, data, or application evidence now blocks the audit.
- Added `native-backup-restore` evidence support.
- Added native scheduled backups as a third option: consistent point-in-time data plus index configurations, one daily and one weekly schedule per database, provider-selected execution time, up to 14 weeks retention, same-location restore to a new database, and TTL policy exclusion.
- Added current public `us-central1` Standard list rates from official pages:
  - Firestore reads: $0.03 per 100,000 documents.
  - Firestore writes: $0.09 per 100,000 documents.
  - PITR data: $0.15 per GiB-month.
  - Native backup data: $0.03 per GiB-month.
  - Restore and clone: $0.20 per GiB.
  - Regional Cloud Storage Standard: $0.02 per GiB-month.
  - Cloud Scheduler: 3 free jobs per billing account, then $0.10 per job per month.
- Kept calculator/billing-table requirements for runtime, logging, operations, network transfer, currency, credits, contracts, and discounts.

### TDD

RED:

```text
41 tests: 36 passed, 5 failed
```

The failures covered missing complete database facts, permissive partial resources, the expanded restore evidence schema, the absent restore evidence classifier, and the absent local evidence collector.

GREEN:

```text
41 focused audit tests: 41 passed, 0 failed
46 Private Pro tool tests: 46 passed, 0 failed
```

Focused Task 22 TypeScript passed. The temporary project file was deleted and is not committed.

All Private Pro tool tests passed. The tools-wide TypeScript project remained blocked only by the known 5 duplicate-React JSX/ReactNode errors in 4 unrelated application files. Focused ESLint remained blocked before file analysis by the existing `@rushstack/eslint-patch` caller-recognition error.

### Report-only state

`npm run private-pro:security-audit -- --report-only` exited 0. The report had 45 pass, 8 warn, and 40 block findings across the existing audit.

The `firestoreRecovery` resource was complete and readable. Deletion protection remained a blocker, retention was the exact disabled-PITR `3600s` state, and the PITR decision remained a warning.

The new `firestoreRestoreEvidence` area blocked because restore evidence is absent. This is expected: no restore rehearsal has been approved or run, and no evidence was fabricated.

The report-only JSON parsed successfully and asserted the deletion-protection blocker, restore-evidence blocker, empty-target evidence blocker, and PITR decision warning. The docs/source contract assertions passed.

Final verification reran focused TypeScript, all 46 Private Pro tool tests, report-only JSON assertions, the zero-mutation snapshot assertion, docs/source contracts, Task 22 artifact secret scan, and `git diff --check` against the final fix. All passed.

### Sources

All pricing and product semantics in this fix round use the official sources already listed above, accessed 2026-08-18. Account-specific effective prices still require the billing price table or Pricing API.

## Fix round 2

Status: complete. No cloud mutation occurred. No restore evidence or HMAC key was generated.

### Review finding

The previous restore evidence schema consisted of self-asserted booleans. A handwritten all-true file could satisfy the release gate without proving that a rehearsal ran or that the evidence belonged to the audited release.

### Changes

- Replaced boolean evidence with a strict provenance-bound schema containing:
  - schema/evidence versions and UUIDv4 run ID;
  - recovery method and ordered start/completion/artifact/attestation timestamps;
  - hashed source database identity;
  - immutable pre/post source fingerprints that must match;
  - explicit non-default destination ID and zero-document initial-state proof;
  - hashed recovery artifact identifier and timestamp;
  - command transcript digest;
  - bounded tool name/version;
  - exact audited release commit SHA;
  - index, rules, and config manifest digests;
  - exact expected/actual counts and keyed ciphertext HMAC digests for ten approved Private Pro Firestore families;
  - passed application acceptance artifact digest;
  - completed cleanup artifact digest;
  - bounded approver identity/role plus attestation timestamp and statement digest.
- Added HMAC-SHA256 authentication over recursively key-sorted canonical JSON excluding only `macBase64`.
- The audit reads `PRIVATE_PRO_RESTORE_EVIDENCE_HMAC_KEY` only at audit time. The key must be canonical base64 decoding to 32-64 bytes and is never stored in evidence, docs, reports, or normal application config.
- The audit binds evidence to `PRIVATE_PRO_RESTORE_EVIDENCE_EXPECTED_COMMIT_SHA`. A wrong or missing release SHA blocks.
- The initial filesystem transport was superseded and removed in fix round 4.
- Added a 1 MiB evidence cap and duplicate JSON object-key rejection before `JSON.parse`.
- Kept the report redacted: the audit emits only booleans/counts, including `macVerified` and `releaseCommitMatches`.

### TDD

RED:

```text
42 audit tests: 38 passed, 4 failed
```

The four failures covered valid authenticated evidence, unsigned/wrong-MAC/tampered/wrong-release/changed-source evidence, stale/reversed/invalid-family provenance, and transport/duplicate-key/oversized JSON validation.

GREEN:

```text
42 focused audit tests: 42 passed, 0 failed
47 Private Pro tool tests: 47 passed, 0 failed
```

Focused Task 22 TypeScript passed. The temporary project file was deleted and is not committed.

### Report-only state

`npm run private-pro:security-audit -- --report-only` exited 0 with 45 pass, 8 warn, and 42 block findings across the existing audit.

The restore evidence gate remains blocked because no approved rehearsal evidence, audit-time HMAC key, or expected release commit is present. `macVerified` and `releaseCommitMatches` are explicit blockers. This is the expected current state.

### Adversarial coverage

- all-true unsigned evidence;
- absent HMAC key;
- wrong HMAC key;
- post-MAC field mutation;
- wrong expected release commit;
- changed source fingerprint;
- stale evidence;
- reversed timestamps;
- malformed UUID/provenance;
- unapproved collection family;
- count or keyed digest mismatch;
- failed application acceptance;
- oversized evidence;
- duplicate JSON keys.

### Cloud boundary

No restore, backup, export, import, database, schedule, IAM, storage, deployment, cleanup, key, or evidence mutation ran.

## Fix round 3

Status: complete. No cloud mutation occurred. No real trust key, private key, or restore evidence was created.

### Review finding

Fix round 2 authenticated evidence with a shared HMAC. Anyone holding the shared key could author and attest a fabricated record. That trust model did not establish independent attestation.

### Changes

- Superseded the shared-HMAC attestation model with independent Ed25519 signatures.
- Added strict `infra/private-pro/firestore-restore-attestor-trust.json` parsing for:
  - schema/status/algorithm;
  - key ID and Ed25519 public JWK;
  - issuer;
  - exact repository, workflow path, workflow ref, and protected environment claims;
  - activation, expiry, and revocation state.
- Checked in only an explicit `unconfigured` descriptor with no public or private production key. It blocks by design.
- Evidence now includes exact CI repository/workflow/ref/run ID/run attempt/environment, attestor key ID, attestor issuer, and `signatureBase64`.
- Signature verification uses Node Ed25519 over recursively key-sorted canonical JSON excluding only `signatureBase64`.
- The rehearsal author/operator cannot satisfy the gate without the independent private key.
- The audit collects actual release state through:

  ```text
  git rev-parse HEAD
  git status --porcelain --untracked-files=normal
  ```

  Evidence must match actual HEAD and the checkout must be clean. An optional environment commit can only add another equality constraint.
- Tightened timing:
  - recovery artifact time is within five minutes before run start or later;
  - artifact <= start <= completion <= attestation;
  - completion-to-attestation is at most 24 hours;
  - completion and attestation cannot be more than five minutes in the future;
  - completion and artifact must be within 90 days;
  - attestation must fall within the trust key activation window.
- Added transport hardening that was later superseded and removed in fix round 4.
- Kept keyed per-family ciphertext HMAC comparisons only as data equality measurements. They are not the evidence attestation mechanism.

### TDD

RED:

```text
42 audit tests: 38 passed, 4 failed
```

The failures covered valid Ed25519 trust/signature, wrong signer/key/provenance/release, timing/provenance, and bounded-file collection.

GREEN:

```text
44 focused audit tests: 44 passed, 0 failed
49 Private Pro tool tests: 49 passed, 0 failed
```

Coverage includes ephemeral test-only Ed25519 keys, unconfigured production trust, valid signature, unsigned evidence, wrong signer/key ID/issuer, tamper, wrong actual HEAD/additional commit, dirty checkout, wrong repository/workflow/ref/environment/run, stale completion, excessive delay, future time, invalid family/count/digest/application, oversized evidence, and duplicate JSON keys.

### Approval boundary

Activating trust requires a separately reviewed and approved public trust descriptor. The independent CI/KMS attestor must fetch immutable artifacts and verify or re-run measurements before signing. Never commit the private key or give it to the rehearsal author/operator.

### Cloud boundary

No restore, backup, export, import, database, schedule, IAM, storage, deployment, cleanup, trust activation, key, or evidence mutation ran.

### Verification

- Focused Task 22 TypeScript: passed. The temporary project file was deleted and is not committed.
- Private Pro tools: 49 passed, 0 failed.
- Checked-in trust descriptor JSON parsed and remained `unconfigured` with no public key.
- Report-only JSON parsed and blocked `signatureVerified`, `trustConfigured`, `provenanceMatches`, `releaseCommitMatches`, and `worktreeClean` during the intentionally dirty pre-commit run.
- `git diff --check`: passed.

## Fix round 4

Status: complete. No cloud mutation occurred. No real trust key, private key, or restore evidence was created.

### Review findings

The filesystem evidence transport had two independent defects. On Windows, validating the final path could not prevent an ancestor directory junction or reparse-point swap between validation and read. The default checked-in evidence path also contradicted the release rule that the audited tree must be clean and evidence must bind the committed HEAD.

### Ruling

Restore evidence is no longer read from the filesystem. The audit accepts it only from `PRIVATE_PRO_FIRESTORE_RESTORE_EVIDENCE_BASE64`, while the independently pinned Ed25519 trust descriptor remains the sole fixed repository file. CI or the release attestor stores the immutable signed evidence artifact externally and injects its exact canonical base64 only into the audit process environment.

### Changes

- Removed the default evidence path, evidence path override, approved-root override, path containment, realpath, symlink, bounded-file reader, and evidence-file collector.
- Added strict in-memory transport validation:
  - canonical padded RFC 4648 base64 alphabet only;
  - no whitespace, missing padding, alternate trailing bits, or base64 aliases;
  - encoded-length rejection before allocation and a 16 KiB decoded ceiling;
  - fatal UTF-8 decoding;
  - duplicate JSON object-key rejection;
  - exact canonical JSON byte equality before schema or signature verification.
- Kept strict schema, independent Ed25519 verification, trust claims, timing, actual `git rev-parse HEAD`, and clean-tree checks unchanged.
- Anchored the fixed trust descriptor read to `import.meta.url`, capped it at 16 KiB, and decoded it as strict UTF-8.
- Kept `PRIVATE_PRO_RESTORE_EVIDENCE_EXPECTED_COMMIT_SHA` only as an optional additional equality constraint. It does not replace actual HEAD.
- Updated the runbook and deployment guide for external immutable artifact storage, audit-only environment injection, PowerShell in-memory base64 conversion, immediate environment cleanup, and the prohibition on saving or reporting the encoded value.

### TDD

RED:

```text
45 audit tests: 43 passed, 2 failed
```

The failures were the missing base64 collector and the residual filesystem transport contract.

GREEN:

```text
46 focused audit tests: 46 passed, 0 failed
```

Coverage includes valid canonical environment evidence with an ephemeral Ed25519 key; missing, empty, malformed, whitespace-bearing, unpadded, trailing-bit-alias, invalid-UTF-8, noncanonical-JSON, duplicate-key, and oversized input; unconfigured trust; signature tamper and wrong signer/claims/HEAD; dirty tree; and a source/docs assertion that no evidence filesystem transport remains.

### Approval and cloud boundary

The checked-in trust descriptor remains `unconfigured`. Activating a public trust key, creating or accessing production evidence, running a rehearsal, or mutating Firestore still requires separate explicit approval. No restore, backup, export, import, database, schedule, IAM, storage, deployment, cleanup, trust activation, key, or evidence mutation ran.

### Verification

- Focused Task 22 TypeScript: passed. The temporary project file was deleted and is not committed.
- Focused security-audit tests: 46 passed, 0 failed.
- All Private Pro tool tests: 51 passed, 0 failed.
- Report-only audit: exited 0 with 45 pass, 8 warn, and 45 block findings across the existing audit. With no evidence environment value and the intentionally unconfigured trust descriptor, `readable`, `signatureVerified`, `trustConfigured`, `provenanceMatches`, `releaseCommitMatches`, and `worktreeClean` all blocked as expected.
- Post-commit report-only audit: exited 0 with 46 pass, 8 warn, and 44 block findings. The clean-tree check passed; absent evidence, unconfigured trust, signature, provenance, and release binding remained blocked as designed.
- Focused ESLint remained blocked before file analysis by the existing `@rushstack/eslint-patch` caller-recognition error.
- Residual transport scan: no evidence path/root environment variable, canonical evidence JSON path, path collector, path containment, realpath, symlink reader, or bounded evidence file reader remains in operational code or docs.
- Checked-in trust descriptor remains `unconfigured` with no production public or private key.
- `git diff --check`: passed.
- Added-diff credential-pattern scan: no credential-like values. The checked-in trust descriptor remained `unconfigured` with no public key.

## Fix round 5

Status: complete. No cloud mutation occurred. No real trust key, private key, or restore evidence was created.

### Review findings

The audit-only evidence value was inherited by every child process because `execFile` used the full process environment. The trust descriptor was read from the mutable working tree rather than the commit named by the evidence and actual HEAD. Node's UTF-8 decoder also accepted and stripped a byte-order mark before JSON validation.

### Changes

- Added one child-process environment scrubber used by both text and bounded-buffer command execution.
- Scrubbed restore evidence, legacy restore HMAC, attestation, attestor, signing, restore private-key/secret/token/credential, and Private Pro access-token environment variables from child processes while retaining ordinary environment variables required by git, gcloud, npm, and test executables.
- Kept evidence available in the audit process for in-memory verification.
- Collected and validated actual HEAD first, then loaded the fixed trust path with `git show <40_HEX_HEAD>:infra/private-pro/firestore-restore-attestor-trust.json`.
- Required strict 40-character lowercase hex HEAD before constructing the fixed git object expression.
- Capped trust output at 16 KiB, kept it as bytes until strict UTF-8 decoding, and failed closed on a missing blob, invalid UTF-8, duplicate keys, malformed schema, or oversized output.
- Removed the mutable working-tree trust read from the release gate. Clean-tree validation remains a separate required check.
- Rejected a UTF-8 BOM explicitly before evidence or trust JSON decoding.
- Updated recovery docs to describe child-process scrubbing and HEAD-bound trust verification.

### TDD

RED:

```text
48 audit tests: 45 passed, 3 failed
```

The failures proved that BOM evidence passed, the HEAD trust collector was missing, and evidence plus attestation secrets were inherited by a real child process.

GREEN:

```text
48 focused audit tests: 48 passed, 0 failed
```

Coverage includes a real executable child that receives an ordinary sentinel but not evidence, legacy HMAC, attestor/private-key, attestation-secret, future restore private-key, or access-token values. An actual temporary git repository proves that an attacker-key working-tree edit does not replace the descriptor in HEAD. Unit coverage asserts the exact `git show` vector, fixed path, 16 KiB cap, strict HEAD validation, missing-blob failure, and BOM rejection.

### Approval and cloud boundary

The committed trust descriptor remains `unconfigured`. No production evidence or key was accessed. No restore, backup, export, import, database, schedule, IAM, storage, deployment, cleanup, trust activation, key, or evidence mutation ran.

### Verification

- Focused Task 22 TypeScript: passed. The temporary project file was deleted and is not committed.
- Focused security-audit tests: 48 passed, 0 failed.
- All Private Pro tool tests: 53 passed, 0 failed.
- Report-only audit: exited 0 with 45 pass, 8 warn, and 45 block findings across the existing audit. With the dirty pre-commit tree, absent evidence, and unconfigured committed trust, the expected restore-evidence blockers remained set.
- Focused ESLint remained blocked before file analysis by the existing `@rushstack/eslint-patch` caller-recognition error.
- `git diff --check`: passed.
- Added-diff credential-pattern scan: no credential-like values.
- Post-commit report-only audit: exited 0 with 46 pass, 8 warn, and 44 block findings. The clean-tree check passed; absent evidence and the unconfigured trust blob from the audited HEAD remained blocked as designed.
