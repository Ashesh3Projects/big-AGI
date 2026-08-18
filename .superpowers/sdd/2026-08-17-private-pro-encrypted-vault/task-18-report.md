# Task 18 report

## Design

- Added a resumable migration runner with the exact phases `inventory`, `encrypt-local`, `upload`, `verify-cloud`, `commit`, `cleanup-local`, `cleanup-cloud`, and `complete`.
- The local journal exposes only UID scope, migration ID, phase, revision, counts, opaque operation IDs, timestamps, and encrypted envelopes. Frozen source identities, versions, values, asset IDs, cleanup cursors, and error context remain inside the encrypted journal envelope.
- Reused Task 11 serializers, Task 15 record encryption/transport contracts, Task 17 encrypted asset upload/download/decryption, and the existing server migration CAS.
- Provider activation runs migration before starting the normal vault engine. Migration progress, retry, and encrypted-export actions remain behind the blocking vault gate.
- Legacy cloud inventory reads the authorized chat/persona paths. Cleanup uses an authenticated server mutation that compare-deletes only the exact UID, entity ID, revision, and content hash frozen during inventory.

## Rulings

- The server journal records only destructive milestones `commit` and `complete`; the encrypted local journal owns all eight detailed phases. Cost if wrong: server observability is coarser, but plaintext cleanup cannot begin without an authoritative committed marker and intermediate plaintext details never leave the browser.
- Local source versions are SHA-256 over canonical portable serializer output. Cloud source versions are server revision plus the legacy content hash. Cost if wrong: any semantically irrelevant serializer ordering change blocks cleanup and requires reinventory, which is safer than deleting a late edit.
- Local cleanup is item-scoped through serializer removal and deletes only DBlobs referenced by the frozen migrated record. Task 17 hydrated-asset tracking remains separate, so unrelated or preexisting local assets are not claimed by migration hydration cleanup.
- Explicit encrypted-export confirmation is stored inside the encrypted journal only after the export stream has been fully materialized for download. A failed download construction does not open cleanup gates.
- Legacy cloud cleanup removes the canonical chat/persona document only after exact revision/hash comparison. For chats it then removes the exact frozen revision document and its chunks. A changed or newly created version returns conflict and remains intact.
- A local/cloud record collision with different canonical portable values blocks inventory instead of choosing a silent winner.

## Files

- Created `src/modules/private-pro/vault/privatePro.vault.migration.ts`.
- Created `src/modules/private-pro/vault/privatePro.vault.migration.test.ts`.
- Modified provider, vault DB/service/store, encrypted asset client, blocking status UI, and legacy sync transport/repository/service/router tests and contracts.

## Test evidence

- RED: focused migration test initially failed with `Cannot find module './privatePro.vault.migration'`.
- Focused migration and asset verification: `41` passed, `0` failed.
- Broad relevant migration/provider/sync/vault/asset/backup regression: `155` passed, `0` failed.
- Additional router/provider/migration/sync service regression: `66` passed, `0` failed.
- Touched ESLint: passed with `0` errors and `0` warnings.
- `npm run tscheck`: passed.
- `npm run build`: passed. Next.js emitted only the existing worktree multi-lockfile and edge-runtime static-generation warnings.
- `git diff --check`: passed.
- Full `npm test`: tools `20/20` passed; source tests `312` passed, `18` skipped, `1` failed. The only failure is the known live Groq catalog drift baseline: stale definitions `minimaxai/minimax-m2.7`, `llama-3.3-70b-versatile`, and `llama-3.1-8b-instant`.

## Limitations

- No live cloud mutation, deployment, push, emulator cleanup rehearsal, or server start was performed. Repository ports and fakes cover migration behavior; the production client/server integration compiles and builds.
- Post-migration disabling of every legacy read rule is owned by the later Firebase enforcement task.

## Commit

- `Cloud: migrate private data into encrypted vaults`

## Fix round 1

### Review findings resolved

- Added write-ahead encrypted-journal checkpoints for every upload, server commit, local cleanup, cloud cleanup, and completion effect. Retries reuse stable operation IDs and item cursors, including crashes immediately after an effect but before its completion checkpoint.
- Froze the exact local and cloud source sets plus asset byte length, content SHA-256, encrypted-manifest SHA-256, and source references. Commit and cleanup relist both source sets and re-describe assets, blocking late additions, edits, newly referenced assets, and shared-asset deletion.
- Added an activation-owned provider epoch and one idempotent stop barrier. Logout, full wipe, UID/provider teardown, and failed activation invalidate and unsubscribe before joining the same migration stop, suppressing stale progress and preventing engine startup after cancellation.
- Added a Firestore cleanup receipt keyed by the stable migration cleanup operation. Canonical deletion and receipt creation are atomic; exact frozen chunks advance a persisted cursor transactionally; revision deletion and completion are resumable.
- Split encrypted export creation from explicit user acknowledgement. The confirmation is bound to migration ID, frozen inventory digest, and the materialized export SHA-256, and a separate acknowledgement action opens the destructive gate.

### Fix verification

- Focused migration/provider/assets/cleanup/service regression: `97` passed, `0` failed.
- All Private Pro source tests: `300` passed, `0` failed.
- Touched ESLint: passed with `0` errors and `0` warnings.
- `npm run tscheck`: passed.
- `npm run build`: passed. Next.js emitted only the existing multi-lockfile and edge-runtime static-generation warnings.
- `git diff --check`: passed.
- Full `npm test`: tools `20/20` passed; source tests `333` passed, `18` skipped, `1` failed. The only failure remains the known live Groq catalog drift baseline: stale definitions `minimaxai/minimax-m2.7`, `llama-3.3-70b-versatile`, and `llama-3.1-8b-instant`.

### Remaining limitation

- Live Firebase/Storage mutation and a real browser download acknowledgement were not exercised. Repository ports, crash-injection tests, typecheck, and the production build cover the implementation paths without deployment or server startup.
