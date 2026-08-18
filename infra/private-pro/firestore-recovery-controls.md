# Firestore recovery controls

Status: local and read-only preparation only. Accessed 2026-08-18. No command in an approval-required section has been run.

## Current state

The read-only database description succeeded for the default Firestore database.

| Field | Observed value | Ruling |
| --- | --- | --- |
| Database type | `FIRESTORE_NATIVE` | Expected |
| Database edition | `STANDARD` | Use Standard edition pricing |
| Location | `us-central1` | Use this location for pricing and restore planning |
| Deletion protection | `DELETE_PROTECTION_DISABLED` | Blocker |
| PITR | `POINT_IN_TIME_RECOVERY_DISABLED` | Explicit cost decision pending |
| Earliest version time | `2026-08-18T11:30:50Z` | Rounded to seconds |
| Version retention period | `3600s` | One-hour history while PITR is disabled |

The redacted snapshot is `.superpowers/sdd/2026-08-17-private-pro-encrypted-vault/task-22-before-redacted.json`. It contains no project number, access token, raw database resource, IAM policy, key, user data, or ciphertext.

Deletion protection must be enabled before production approval. This task did not enable it. PITR remains a separate paid-control decision.

## Read-only collection

These commands do not mutate cloud state. Do not save raw output. Reduce it immediately to booleans, enums, counts, and rounded timestamps.

```powershell
$ProjectId='big-agi-243b6'

gcloud firestore databases describe --database='(default)' --project=$ProjectId --format=json
npm run private-pro:security-audit -- --report-only
```

The security audit uses the exact `gcloud firestore databases describe` command, validates the current API enum values, and fails closed when the command or resource shape is unreadable. It blocks when deletion protection is disabled or unspecified. It warns when PITR is explicitly disabled because the paid-control decision is pending, and blocks an unknown PITR value.

## Options

### Firestore PITR

PITR extends the readable version-retention window from one hour to seven days. Reads, exports, and clones select a whole-minute timestamp not earlier than `earliestVersionTime`. The full seven-day window accumulates only after PITR has been enabled long enough. A PITR recovery clone creates a new database in the same location and does not overwrite the source database.

Firestore charges PITR storage separately from normal database storage. The official pricing model measures database size daily, averages it over the month, and applies the location-specific PITR GiB-month SKU. Google states that many customers will find PITR storage cost similar to database storage cost, but that is not a project estimate. Clone operations are also billable and have no free usage.

Operational characteristics:

- RPO: one minute within the available window.
- Retention: up to seven days after the window has accumulated.
- Restore target: new database in the same project and location.
- Restore owner: Firestore operator with database clone permissions.
- Application owner: validates encrypted vault records, indexes, attachment metadata, entitlement records, and a clean-profile application bootstrap against the clone.
- Key ownership: unchanged. Firestore stores application ciphertext, but a cloned database does not make ciphertext decryptable without the user's vault key or recovery material.

### Scheduled Firestore exports of application ciphertext

The Task 12 archive format is client-side, password-encrypted, authenticated, and interactive. It requires a user password or recovery key to unwrap the vault key. It is not server-schedulable without a separately approved noninteractive key-management design. Do not put a user's password, recovery key, vault master key, or export-unwrapping secret into Cloud Scheduler, Cloud Run, Cloud Functions, Vercel, or Firebase configuration.

A server-triggered Firestore managed export is different. It copies Firestore documents to Cloud Storage. For Private Pro, encrypted vault records remain ciphertext because ciphertext is what Firestore stores. The export also preserves Firestore document structure and operational metadata. It is an infrastructure restore artifact, not the Task 12 user-facing archive, and it does not prove that a user can decrypt or import the data through the application.

Scheduled exports require an execution service, schedule, destination bucket, least-privilege IAM, retention lifecycle, monitoring, failure alerts, and periodic import rehearsals. The official solution uses Cloud Scheduler plus a function that calls Firestore Admin `exportDocuments`. Each exported document is billed as a document read. Other cost inputs include Cloud Storage class and retained bytes, storage operations, scheduler jobs, function or Cloud Run execution, logging, network transfer if locations differ, and import document writes during rehearsal.

Operational characteristics:

- RPO: selected schedule interval plus export completion time.
- Retention: bucket lifecycle policy selected by the operator.
- Restore target: a separate Firestore database, or a separate project when export/import IAM and bucket access are configured.
- Restore owner: infrastructure operator owns scheduler, export job, bucket, retention, import, alerts, and cleanup.
- Application owner: validates encrypted records and application behavior after import.
- Key ownership: exports preserve stored ciphertext. They do not replace Task 12 password-encrypted archives and do not escrow user vault keys.

### Decision table

| Decision input | Firestore PITR | Scheduled Firestore export |
| --- | --- | --- |
| Primary incident | Recent accidental write or deletion | Longer retention, project isolation, or durable snapshots |
| RPO | One minute | Schedule interval plus completion time |
| Retention | Fixed seven-day window | Operator-defined bucket retention |
| Restore path | Clone to a new same-location database | Import to a separate database or project |
| Direct production overwrite | No | Import must target the explicitly selected database |
| Routine ownership | Firestore/database operator | Scheduler, runtime, bucket, IAM, and monitoring owner |
| Cost dimensions | PITR GiB-month and clone size | Export reads, object storage, scheduler/runtime/logging, import writes, possible transfer |
| User-friendly encrypted archive | No | No |
| Safe noninteractive user-key design required | No | Not for ciphertext export; yes if attempting to generate the Task 12 archive server-side |

## Exact estimate

Do not approve a paid control from a generic dollar figure. The exact estimate needs:

1. Firestore location `us-central1` and Standard edition.
2. Average database stored GiB, including indexes and metadata.
3. For PITR: expected average database size and clone rehearsal frequency/size.
4. For exports: document count per run, export frequency, average export bytes, storage class, retention days, bucket location, scheduler job count, runtime duration/memory, log volume, import rehearsal frequency, and possible network transfer.
5. Billing-account-specific contract pricing, currency, and discounts.

The operator should use the Firestore, Cloud Storage, Cloud Scheduler, and chosen runtime pricing pages with the actual measurements. For account-specific prices, use the Google Cloud Console billing pricing table or the Cloud Billing Pricing API with a principal allowed to view the billing account. Save the estimate and selected RPO/RTO with the approval record. Do not commit billing account IDs or contract price exports.

## Approval-required deletion protection

Not executed. Obtain explicit approval for this exact mutation:

```powershell
$ProjectId='big-agi-243b6'

gcloud firestore databases update --database='(default)' --project=$ProjectId --delete-protection
```

Read-only verification after approval:

```powershell
gcloud firestore databases describe --database='(default)' --project=$ProjectId --format=json
npm run private-pro:security-audit -- --report-only
```

Expected enum: `DELETE_PROTECTION_ENABLED`.

Rollback disables a safety control and needs its own explicit approval. Not executed:

```powershell
gcloud firestore databases update --database='(default)' --project=$ProjectId --no-delete-protection
```

## Approval-required PITR

Not executed. Run only after the user accepts the measured cost and selects PITR:

```powershell
$ProjectId='big-agi-243b6'

gcloud firestore databases update --database='(default)' --project=$ProjectId --enable-pitr
```

Read-only verification after approval:

```powershell
gcloud firestore databases describe --database='(default)' --project=$ProjectId --format=json
```

Expected enums and fields after propagation:

- `POINT_IN_TIME_RECOVERY_ENABLED`
- `versionRetentionPeriod: 604800s`
- a readable `earliestVersionTime`

Rollback removes future seven-day protection and retained history expires under Firestore policy. It needs separate explicit approval. Not executed:

```powershell
gcloud firestore databases update --database='(default)' --project=$ProjectId --no-enable-pitr
```

## Approval-required scheduled export

No export bucket, scheduler, runtime, service account, IAM binding, lifecycle policy, or export job is defined or approved by this task. The implementation must be a separate reviewed change after the operator selects:

- schedule and RPO;
- retention and storage class;
- same-region bucket;
- isolated service identity and exact permissions;
- alert owner and escalation path;
- import rehearsal cadence;
- cost ceiling and billing alerts;
- whether a same-project separate database or separate project is the rehearsal target.

Do not add an endpoint, cron job, or stored secret that attempts to generate the Task 12 password-encrypted archive noninteractively.

## Restore rehearsal

Every command below is a cloud mutation and was not executed.

### PITR clone

Use a new database ID in the same project. Select a whole-minute timestamp within the available window. Never use `(default)` as the destination.

```powershell
$ProjectId='big-agi-243b6'
$SnapshotTime='YYYY-MM-DDTHH:MM:00Z'
$DestinationDatabase='private-pro-restore-YYYYMMDD'

gcloud firestore databases clone --source-database="projects/$ProjectId/databases/(default)" --snapshot-time=$SnapshotTime --destination-database=$DestinationDatabase --project=$ProjectId
```

### Firestore export import

For a managed Firestore export, import into an explicitly created and isolated target database. A separate project is preferred when the tested IAM and bucket path support it.

```powershell
$DestinationProjectId='APPROVED_REHEARSAL_PROJECT_ID'
$DestinationDatabase='private-pro-restore-YYYYMMDD'
$ExportUri='gs://APPROVED_BUCKET/APPROVED_EXPORT_PREFIX'

gcloud firestore import $ExportUri --database=$DestinationDatabase --project=$DestinationProjectId
```

Rehearsal checks:

1. Confirm the source default database remains unchanged.
2. Confirm the target is isolated from production traffic, rules deployment, scheduled sweep, and production credentials.
3. Compare redacted document and collection-group counts. Do not save document IDs or raw records.
4. Verify required indexes and operational metadata separately. Export/import and backup products differ in which database-level configuration they preserve.
5. Point a non-production application deployment at the target.
6. Use a clean browser profile and approved test user. Unlock with test recovery material, hydrate encrypted vault records, and verify a sentinel chat, setting, credential, and attachment metadata.
7. Verify ciphertext remains unreadable without the correct vault key.
8. Record the elapsed recovery time, achieved RPO, validation result, and owner sign-off.
9. Delete the rehearsal database, bucket objects, or project only under separate explicit cleanup approval.

## Restore evidence

Commit only the redacted structure below. The audit exposes a strict validator for this schema and rejects extra fields.

```json
{
  "schemaVersion": 1,
  "evidenceType": "firestore-restore-rehearsal",
  "collectedAt": "2026-08-18T00:00:00Z",
  "sourceDatabase": "(default)",
  "restoreMethod": "pitr-clone",
  "targetIsolation": "separate-database",
  "status": "passed",
  "sourceUnchanged": true,
  "dataVerificationPassed": true,
  "applicationVerificationPassed": true
}
```

Allowed `restoreMethod` values are `pitr-clone` and `firestore-export-import`. Allowed `targetIsolation` values are `separate-database` and `separate-project`. Never include project numbers, billing account IDs, backup IDs, export URIs, database resource names, document IDs, user IDs, tokens, keys, raw records, IAM policies, or raw command output.

## RTO and RPO approval

| Input | Required decision | Owner |
| --- | --- | --- |
| Maximum acceptable recent data loss | One minute, one hour, one day, or another explicit value | Product owner |
| Maximum acceptable recovery duration | Exact RTO in minutes or hours | Product owner and incident commander |
| Recovery control | PITR, scheduled export, both, or documented acceptance of the remaining risk | Product owner and cost approver |
| Restore execution | Named database operator | Operations owner |
| Application validation | Named Private Pro application owner | Engineering owner |
| Billing and alerts | Named billing owner and monthly ceiling | Cost approver |
| Rehearsal cadence | Monthly, quarterly, or another explicit interval | Operations owner |

## Approval questions

1. Approve enabling Firestore deletion protection on `(default)` now using the exact command above? This is required to clear the current blocker.
2. What RPO and RTO must Private Pro meet?
3. Accept Firestore PITR cost after reviewing the `us-central1` Standard edition estimate, or select scheduled Firestore ciphertext exports for a separate design?
4. If exports are selected, approve the schedule, retention, bucket location/class, runtime, IAM, monitoring owner, rehearsal target, and measured cost ceiling?
5. Approve a non-destructive restore rehearsal only after the target database or project and cleanup plan are reviewed?

## Sources

Official sources accessed 2026-08-18:

- Firestore database resource fields and enum shapes: <https://cloud.google.com/firestore/docs/reference/rest/v1/projects.databases>
- Firestore database management and deletion protection: <https://cloud.google.com/firestore/docs/manage-databases>
- `gcloud firestore databases describe`: <https://cloud.google.com/sdk/gcloud/reference/firestore/databases/describe>
- `gcloud firestore databases update`: <https://cloud.google.com/sdk/gcloud/reference/firestore/databases/update>
- Firestore PITR behavior and clone workflow: <https://firebase.google.com/docs/firestore/use-pitr>
- `gcloud firestore databases clone`: <https://cloud.google.com/sdk/gcloud/reference/firestore/databases/clone>
- Firestore export/import: <https://firebase.google.com/docs/firestore/manage-data/export-import>
- Scheduled Firestore export solution: <https://firebase.google.com/docs/firestore/solutions/schedule-export>
- Firestore Standard edition pricing: <https://cloud.google.com/firestore/pricing>
- Firestore Enterprise edition pricing: <https://firebase.google.com/docs/firestore/enterprise/pricing>
- Cloud Storage pricing: <https://cloud.google.com/storage/pricing>
- Cloud Scheduler pricing: <https://cloud.google.com/scheduler/pricing>
- Cloud Run pricing: <https://cloud.google.com/run/pricing>
- Google Cloud Pricing Calculator: <https://cloud.google.com/products/calculator>
- Billing-account price table: <https://cloud.google.com/billing/docs/how-to/pricing-table>
- Cloud Billing Pricing API: <https://cloud.google.com/billing/docs/how-to/get-pricing-information-api>
