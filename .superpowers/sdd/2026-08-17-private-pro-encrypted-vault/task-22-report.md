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
- Added a canonical restore evidence gate at `infra/private-pro/firestore-restore-evidence.json`, with `PRIVATE_PRO_FIRESTORE_RESTORE_EVIDENCE` as an explicit path override.
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

The new `firestoreRestoreEvidence` area blocked because the canonical evidence file is absent. This is expected: no restore rehearsal has been approved or run, and no evidence was fabricated.

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
- The canonical repository evidence path is absolute. Overrides require an absolute evidence path and absolute `PRIVATE_PRO_RESTORE_EVIDENCE_ROOT`; both are resolved through real paths, and the evidence must remain below the approved root. Relative paths, traversal, and symlink escapes block.
- Added a 1 MiB evidence cap and duplicate JSON object-key rejection before `JSON.parse`.
- Kept the report redacted: the audit emits only booleans/counts, including `macVerified` and `releaseCommitMatches`.

### TDD

RED:

```text
42 audit tests: 38 passed, 4 failed
```

The four failures covered valid authenticated evidence, unsigned/wrong-MAC/tampered/wrong-release/changed-source evidence, stale/reversed/invalid-family provenance, and path/duplicate-key/oversized JSON collection.

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
- relative path and traversal;
- realpath/symlink escape;
- oversized file;
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
- Replaced default `readFile` use with a bounded regular-file reader:
  - reject symlinks through `lstat`;
  - reject non-files and files over 1 MiB before open;
  - open by handle, compare size/device/inode, read at most cap plus one byte, and re-check file identity/size after read;
  - retain realpath root-containment checks.
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

Coverage includes ephemeral test-only Ed25519 keys, unconfigured production trust, valid signature, unsigned evidence, wrong signer/key ID/issuer, tamper, wrong actual HEAD/additional commit, dirty checkout, wrong repository/workflow/ref/environment/run, stale completion, excessive delay, future time, invalid family/count/digest/application, actual oversized file, actual symlink, duplicate JSON keys, traversal, and simulated realpath escape.

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
