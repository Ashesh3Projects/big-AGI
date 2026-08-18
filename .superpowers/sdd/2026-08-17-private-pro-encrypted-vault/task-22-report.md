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
