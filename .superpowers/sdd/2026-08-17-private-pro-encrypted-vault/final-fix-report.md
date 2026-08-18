# Residual fix report

Status: LOCAL RESIDUAL FIXES COMPLETE. READY FOR PRO BRANCH INTEGRATION. NOT READY FOR PRODUCTION DEPLOYMENT.

Code HEAD before this report commit: `af4211c3f`

## Fixes

1. Portable persistence completeness
   - Added a machine-checked inventory for every Zustand `persist()` store and every direct localStorage or IndexedDB owner under `src`.
   - Portable records now include call, chat preferences, purpose visibility, AI preferences, UI preferences, UX labs, Beam, browsing, image generation, theme, Google, speech, sharing secrets, models, personas, folders, chats, and Scratch Clip.
   - Excluded pane/runtime Beam-open state, UI inspector and panel-collapse state, logs, metrics, device IDs, file handles, workspace-to-handle references, V1 markers, analytics opt-out, and manual-export infrastructure.
   - Every included persisted key routes through the Private Pro volatile adapter and is in the explicit allowlist. The source contract fails when a durable store is added or an included store loses the adapter.
   - Settings records use strict versioned Zod schemas and explicit projection, snapshot, apply, reset, and subscription paths. The PC A-to-PC B test removes every record and reconstructs every included sentinel.
   - Plaintext cleanup captures the original native `Storage.prototype.removeItem` before patching. A Node 24 real Web Storage prototype regression proves cleanup physically deletes allowlisted keys while Private Pro is active and preserves unrelated keys.
   - Setup and logout remove all allowlisted localStorage keys, both chat IndexedDB cells, the volatile DBlob map, and only the legacy `Big-AGI/largeAssets` table.

2. Atomic backup cloud merge
   - Added one `mergeBackup` server procedure, service method, transport call, Firestore transaction, and operation receipt.
   - The server accepts at most 200 encrypted records and 4 MiB total ciphertext. It validates every strict envelope, duplicate, base revision, revision transition, per-record limit, and total limit before transaction writes.
   - All current record and tombstone revisions are read before any mutation. Any conflict returns the complete conflict list with no record write and no replay receipt.
   - A committed operation receipt makes an identical replay return `unchanged`; reuse with different content fails.
   - The client materializes and finalizes backup assets first, re-encrypts all staged records under the active key/version, and sends one batch. Existing cloud-only records remain and no delete is possible.
   - Post-commit verification compares record type, opaque ID, schema version, key version, revision, receipt, index, fetched envelope, and canonical decrypted value equality.
   - Restore stops the engine, then hydrates, starts, and waits until current. A pre-commit failure restarts normal reconciliation. A committed cloud write followed by verification or hydration failure leaves the application blocked with an explicit restart-to-reconcile error.
   - Firebase emulator coverage denies browser access to the new `backupMerges` receipt family.

3. Build analytics
   - `next.config.ts` exits before importing `@posthog/nextjs-config` whenever `NEXT_PUBLIC_PRIVATE_PRO_ENABLED=true`.
   - Executable production-phase tests with dummy PostHog credentials prove Private Pro neither imports the wrapper nor applies hidden source maps. Open production builds retain the existing PostHog wrapper behavior.

4. Recovery prompt
   - Successful recovery sets the revoke recommendation.
   - Ready-state provider UI renders a visible warning and `Revoke other devices now` action without requiring the account modal.
   - Revocation remains confirmation-driven and is never automatic.

5. Final residual persistence and restore corrections
   - Added an enforced `sensitive-device` persistence class. App state, pane history, logs, metrics, live-file metadata, workspace identifiers, and the browser device identifier are volatile and physically cleared in Private Pro without being synchronized.
   - Kept composer startup text transient and discarded. Added `enableFolders` as its own encrypted settings record so a clean PC reconstructs both true and false independently of folder records.
   - Added a tRPC-aware ambiguous transport classifier. Only wrapped fetch/network failures replay the exact same operation; server validation and conflict responses do not retry.
   - Replaced the single 200-record backup merge with resumable restore sessions. Each chunk remains atomic at 200 records and 4 MiB, while the authenticated backup format remains bounded at 100,000 records and 128 MiB.
   - The active restore marker blocks normal vault reads and mutations. Session-authorized progress, index, record, chunk, and finalization procedures support exact resume and verification. A middle conflict leaves the marker and prior chunks intact, and finalization clears the marker only after all declared chunks and records commit.
   - Added 1,001-record client and service tests, active-session restart coverage, realistic `TRPCClientError` tests, and Firebase denial coverage for restore session/completion receipts.

## Commits

- `5c504abaa` Cloud: complete portable vault persistence
- `6204fbb2f` Cloud: merge encrypted backups atomically
- `f7d22a589` Build: disable PostHog uploads in private Pro
- `84a368362` Cloud: surface recovery device prompt
- `e139075e8` Test: inventory durable browser storage
- `e8bcc2195` Security: deny backup merge receipts
- `f47f82f3b` Cloud: reconcile ambiguous backup commits
- `a95511a12` Cloud: protect sensitive local persistence
- `af4211c3f` Cloud: resume large encrypted restores

## Verification

- Private Pro source, DBlob, and encrypted-backup tests: 276 passed, 0 failed.
- Private Pro tools: 63 passed, 0 failed.
- Firebase emulator with Microsoft OpenJDK 21.0.4: 38 passed, 0 failed.
- `npm run tscheck`: passed.
- `npm run lint`: passed.
- Key-free `npm test`: tools 63 passed; source 297 passed, 19 skipped, 0 failed.
- Private Pro production build with dummy PostHog and GA values: compiled, linted, type-checked, generated 17 static pages, and completed trace collection without loading the PostHog source-map wrapper.
- `npm audit --omit=dev --audit-level=high --json`: 0 critical, 0 high, 8 reviewed moderate findings.
- Security audit report-only: 47 pass, 8 warn, 43 block.
- Security audit blocking mode: expected exit 1 with the same approval-gated live blockers.
- `git diff --check`: passed before report generation.

## Remaining blockers

Production deployment remains blocked by live state and approval-gated operations: deployed headers and aliases, Firebase authorized domains and browser-key restrictions, bucket CORS, App Check enforcement evidence, deletion protection and PITR decision, independently attested restore rehearsal, runtime identity and IAM verification, and clean-profile/two-device acceptance.

No cloud mutation, deployment, push, server start, real-account action, or automatic device revocation was performed.
