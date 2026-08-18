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

The security audit uses the exact `gcloud firestore databases describe` command and requires the complete current resource shape: name, database type, edition, location, deletion protection, PITR enablement, earliest version time, and retention period. It accepts only the exact current combinations of disabled PITR with `3600s` or enabled PITR with `604800s`. Missing, malformed, unknown, or inconsistent fields block.

The audit also reads restore rehearsal evidence from `infra/private-pro/firestore-restore-evidence.json`, or from the path in `PRIVATE_PRO_FIRESTORE_RESTORE_EVIDENCE`. Missing evidence blocks. Valid evidence must be no older than 90 days. The canonical evidence file does not exist because no restore rehearsal has run.

## Options

### Firestore PITR

PITR extends the readable version-retention window from one hour to seven days. Reads, exports, and clones select a whole-minute timestamp not earlier than `earliestVersionTime`. The full seven-day window accumulates only after PITR has been enabled long enough. A PITR recovery clone creates a new database in the same location and does not overwrite the source database.

Firestore charges PITR storage separately from normal database storage. Public `us-central1` Standard edition list pricing is $0.15 per GiB-month of PITR data and $0.20 per GiB cloned. There is no free quota for PITR or clone operations. Billing-account currency, contracts, credits, and discounts can change the effective price.

Operational characteristics:

- RPO: one minute within the available window.
- Retention: up to seven days after the window has accumulated.
- Restore target: new database in the same project and location.
- Restore owner: Firestore operator with database clone permissions.
- Application owner: validates encrypted vault records, indexes, attachment metadata, entitlement records, and a clean-profile application bootstrap against the clone.
- Key ownership: unchanged. Firestore stores application ciphertext, but a cloned database does not make ciphertext decryptable without the user's vault key or recovery material.

### Native scheduled backups

Firestore native scheduled backups are consistent point-in-time copies. A backup contains all data and index configurations at the backup time. It does not contain database TTL policies. Backups remain in the source database location and restore to a new database.

Each database supports at most one daily schedule and one weekly schedule. The exact execution time cannot be selected. Weekly schedules allow a day of week. Retention is configurable up to 14 weeks.

Public `us-central1` Standard edition list pricing is $0.03 per GiB-month of retained backup data and $0.20 per GiB restored. The billable retained fraction depends on backup size and retention days. There is no free quota for backup data or restores. Billing-account terms can change effective cost.

Operational characteristics:

- RPO: backup cadence plus the provider-selected execution time and backup completion time.
- Retention: up to 14 weeks.
- Restore target: a new database in the backup's location.
- Restore owner: Firestore operator with backup schedule, backup, and restore permissions.
- Application owner: validates restored data, current security rules, TTL policies, other database configuration, and application reconstruction.
- Key ownership: unchanged. Native backups contain stored application ciphertext and do not escrow user vault keys.

### Scheduled Firestore exports of application ciphertext

The Task 12 archive format is client-side, password-encrypted, authenticated, and interactive. It requires a user password or recovery key to unwrap the vault key. It is not server-schedulable without a separately approved noninteractive key-management design. Do not put a user's password, recovery key, vault master key, or export-unwrapping secret into Cloud Scheduler, Cloud Run, Cloud Functions, Vercel, or Firebase configuration.

A server-triggered Firestore managed export is different. It copies Firestore documents to Cloud Storage. For Private Pro, encrypted vault records remain ciphertext because ciphertext is what Firestore stores. It is an infrastructure restore artifact, not the Task 12 user-facing archive, and it does not prove that a user can decrypt or import the data through the application.

A normal managed export is not an exact database snapshot at export start. It can include changes made while the operation runs. Only an export that explicitly uses a supported PITR `--snapshot-time` selects a whole-minute point in time. Exports do not contain index definitions. On import, Firestore uses the target database's current index definitions, overwrites documents with matching IDs, and leaves unrelated target documents intact. Therefore an import rehearsal must use a freshly created, empty, isolated non-default database or separate project. Deploy the exact current indexes, security rules, TTL policies, and other required database configuration separately before application validation.

Scheduled exports require an execution service, schedule, destination bucket, least-privilege IAM, retention lifecycle, monitoring, failure alerts, and periodic import rehearsals. The official solution uses Cloud Scheduler plus a function that calls Firestore Admin `exportDocuments`. Each exported document is billed as a document read. Other cost inputs include Cloud Storage class and retained bytes, storage operations, scheduler jobs, function or Cloud Run execution, logging, network transfer if locations differ, and import document writes during rehearsal.

Operational characteristics:

- RPO: selected schedule interval plus export duration, with the consistency caveat above unless a PITR snapshot time is used.
- Retention: bucket lifecycle policy selected by the operator.
- Restore target: a separate Firestore database, or a separate project when export/import IAM and bucket access are configured.
- Restore owner: infrastructure operator owns scheduler, export job, bucket, retention, import, alerts, and cleanup.
- Application owner: validates encrypted records and application behavior after import.
- Key ownership: exports preserve stored ciphertext. They do not replace Task 12 password-encrypted archives and do not escrow user vault keys.

### Decision table

| Decision input | Firestore PITR | Native scheduled backups | Scheduled Firestore export |
| --- | --- | --- | --- |
| Primary incident | Recent accidental write or deletion | Consistent retained restore points | Longer custom retention or cross-project artifact |
| RPO | One minute within accumulated window | Daily/weekly cadence plus provider-selected start/completion | Schedule interval plus export duration; cross-time unless PITR snapshot-time is used |
| Retention | Fixed seven-day window | Configurable up to 14 weeks | Operator-defined bucket retention |
| Restore path | Clone to new same-location database | Restore to new database in backup location | Import into fresh empty separate database or project |
| Index definitions | Clone includes indexes | Backup includes index configurations | Export omits index definitions; deploy current indexes separately |
| Target merge risk | New database | New database | Matching IDs overwrite and unrelated target docs remain, so target must start empty |
| Routine ownership | Firestore/database operator | Firestore backup operator | Scheduler, runtime, bucket, IAM, and monitoring owner |
| Public list-price dimensions | $0.15/GiB-month PITR; $0.20/GiB clone | $0.03/GiB-month backup; $0.20/GiB restore | $0.03/100k export reads; $0.09/100k import writes; $0.02/GiB-month regional Standard storage; scheduler/runtime/logging/transfer |
| User-friendly encrypted archive | No | No | No |
| Safe noninteractive user-key design required | No | No | Not for ciphertext export; yes if attempting to generate the Task 12 archive server-side |

## Exact estimate

Public list prices below are for Firestore Standard edition and regional Cloud Storage Standard in `us-central1`, accessed 2026-08-18. They are not a project estimate:

| Item | Public list price |
| --- | --- |
| Firestore document reads | $0.03 per 100,000 documents |
| Firestore document writes | $0.09 per 100,000 documents |
| Firestore PITR data | $0.15 per GiB-month |
| Firestore native backup data | $0.03 per GiB-month |
| Firestore restore operation | $0.20 per GiB |
| Firestore clone operation | $0.20 per GiB |
| Cloud Storage regional Standard in `us-central1` | $0.02 per GiB-month |
| Cloud Scheduler | 3 free jobs per billing account, then $0.10 per job per month |

Managed export bills one read per exported document. Import bills one write per imported document. Export objects also incur Cloud Storage charges. Cloud Scheduler charges by defined job, not executions. Runtime, logging, storage operations, network transfer, and account-specific billing still require the calculator or billing price table.

Do not approve a paid control from the list prices alone. The exact estimate needs:

1. Firestore location `us-central1` and Standard edition.
2. Average database stored GiB, including indexes and metadata.
3. For PITR: expected average database size and clone rehearsal frequency/size.
4. For native backups: schedule count, retained backup sizes, retention days, and restore rehearsal size/frequency.
5. For exports: document count per run, export frequency/duration, average export bytes, storage class, retention days, bucket location, scheduler job count, runtime duration/memory, log volume, import rehearsal frequency, and possible network transfer.
6. Billing-account-specific contract pricing, currency, credits, and discounts.

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

## Approval-required native scheduled backup

Not executed. Select exactly one daily and/or one weekly schedule plus retention no longer than 14 weeks. Example only after explicit cost and mutation approval:

```powershell
$ProjectId='big-agi-243b6'

npx firebase --project $ProjectId firestore:backups:schedules:create --database='(default)' --recurrence='DAILY' --retention='14w'
npx firebase --project $ProjectId firestore:backups:schedules:create --database='(default)' --recurrence='WEEKLY' --day-of-week='SUNDAY' --retention='14w'
```

Read-only verification:

```powershell
npx firebase --project $ProjectId firestore:backups:schedules:list --database='(default)'
npx firebase --project $ProjectId firestore:backups:list --location='us-central1'
```

Rollback deletes only the explicitly selected schedule resource and requires separate approval:

```powershell
npx firebase --project $ProjectId firestore:backups:schedules:delete 'BACKUP_SCHEDULE_RESOURCE_NAME'
```

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

### Native backup restore

Select one verified backup resource and restore it to a new non-default database. Never use `(default)` as the destination.

```powershell
$ProjectId='big-agi-243b6'
$SourceBackup='projects/PROJECT_ID/locations/us-central1/backups/BACKUP_ID'
$DestinationDatabase='private-pro-restore-YYYYMMDD'

gcloud firestore databases restore --source-backup=$SourceBackup --destination-database=$DestinationDatabase --project=$ProjectId
```

### Firestore export import

For a managed Firestore export, import into a freshly created empty isolated non-default target database. A separate project is preferred when the tested IAM and bucket path support it. Never import a rehearsal into a target containing documents: matching IDs are overwritten and unrelated documents survive.

```powershell
$DestinationProjectId='APPROVED_REHEARSAL_PROJECT_ID'
$DestinationDatabase='private-pro-restore-YYYYMMDD'
$ExportUri='gs://APPROVED_BUCKET/APPROVED_EXPORT_PREFIX'

gcloud firestore import $ExportUri --database=$DestinationDatabase --project=$DestinationProjectId
```

Rehearsal checks:

1. Confirm the source default database remains unchanged.
2. Confirm the target is isolated from production traffic, rules deployment, scheduled sweep, and production credentials.
3. Before import, prove the isolated target has zero documents. Record a boolean only.
4. Deploy and verify the exact current indexes, security rules, TTL policies, and required database configuration separately. Managed exports do not contain index definitions. Native backups include index configurations but not TTL policies.
5. Compare redacted document and collection-group counts and keyed ciphertext hashes. Do not save document IDs, raw records, or hash keys.
6. Point a non-production application deployment at the target.
7. Use a clean browser profile and approved test user. Unlock with test recovery material, hydrate encrypted vault records, and verify a sentinel chat, setting, credential, and attachment metadata.
8. Verify ciphertext remains unreadable without the correct vault key.
9. Record the elapsed recovery time, achieved RPO, consistency mode, validation result, and owner sign-off.
10. Delete the rehearsal database, bucket objects, or project only under separate explicit cleanup approval.

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
  "targetDatabaseDefault": false,
  "status": "passed",
  "sourceUnchanged": true,
  "targetInitiallyEmpty": true,
  "indexesVerified": true,
  "rulesVerified": true,
  "configVerified": true,
  "documentCountsVerified": true,
  "documentHashesVerified": true,
  "dataVerificationPassed": true,
  "applicationVerificationPassed": true
}
```

Allowed `restoreMethod` values are `pitr-clone`, `native-backup-restore`, and `firestore-export-import`. Allowed `targetIsolation` values are `separate-database` and `separate-project`. Never include project numbers, billing account IDs, backup IDs, export URIs, database resource names, document IDs, user IDs, tokens, keys, raw records, IAM policies, or raw command output.

## RTO and RPO approval

| Input | Required decision | Owner |
| --- | --- | --- |
| Maximum acceptable recent data loss | One minute, one hour, one day, or another explicit value | Product owner |
| Maximum acceptable recovery duration | Exact RTO in minutes or hours | Product owner and incident commander |
| Recovery control | PITR, native scheduled backups, scheduled export, a combination, or documented acceptance of remaining risk | Product owner and cost approver |
| Restore execution | Named database operator | Operations owner |
| Application validation | Named Private Pro application owner | Engineering owner |
| Billing and alerts | Named billing owner and monthly ceiling | Cost approver |
| Rehearsal cadence | Monthly, quarterly, or another explicit interval | Operations owner |

## Approval questions

1. Approve enabling Firestore deletion protection on `(default)` now using the exact command above? This is required to clear the current blocker.
2. What RPO and RTO must Private Pro meet?
3. After reviewing measured costs, select PITR, native scheduled backups, scheduled Firestore ciphertext exports, a combination, or explicit risk acceptance?
4. If native backups are selected, approve daily and/or weekly recurrence, retention, restore owner, rehearsal cadence, and cost ceiling?
5. If exports are selected, approve the schedule, consistency mode, retention, bucket location/class, runtime, IAM, monitoring owner, fresh empty rehearsal target, and measured cost ceiling?
6. Approve a non-destructive restore rehearsal only after the fresh empty target database or project and cleanup plan are reviewed?

## Sources

Official sources accessed 2026-08-18:

- Firestore database resource fields and enum shapes: <https://cloud.google.com/firestore/docs/reference/rest/v1/projects.databases>
- Firestore database management and deletion protection: <https://cloud.google.com/firestore/docs/manage-databases>
- `gcloud firestore databases describe`: <https://cloud.google.com/sdk/gcloud/reference/firestore/databases/describe>
- `gcloud firestore databases update`: <https://cloud.google.com/sdk/gcloud/reference/firestore/databases/update>
- Firestore PITR behavior and clone workflow: <https://firebase.google.com/docs/firestore/use-pitr>
- `gcloud firestore databases clone`: <https://cloud.google.com/sdk/gcloud/reference/firestore/databases/clone>
- Native scheduled backups: <https://firebase.google.com/docs/firestore/backups>
- `gcloud firestore databases restore`: <https://cloud.google.com/sdk/gcloud/reference/firestore/databases/restore>
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
