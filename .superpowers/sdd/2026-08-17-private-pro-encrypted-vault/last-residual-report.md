# Last residual report

Status: LOCAL FINAL RESIDUAL FIXES COMPLETE. READY FOR PRO BRANCH INTEGRATION. NOT READY FOR PRODUCTION DEPLOYMENT.

Code HEAD before this report commit: `af4211c3f`

## Changes

- Classified every durable Zustand store as portable, sensitive-device, or safe-device. Portable and sensitive-device stores now fail the source inventory unless they use their assigned Private Pro volatile adapter.
- Made `app-state`, panes, logs, metrics, live-file metadata, workspace identifiers, and the browser device identifier volatile and part of physical plaintext cleanup. These excluded stores are never synchronized.
- Verified the client logger does not provide a general secret sanitizer: it accepts arbitrary message/details. It is therefore classified as sensitive-device, its durable sink is disabled and cleared in Private Pro, and all analytics reporting is disabled by the existing Private Pro build/runtime gates.
- Kept composer prefill transient. Added encrypted `settings/folders` persistence for `enableFolders`, including reset and PC A-to-PC B reconstruction.
- Added realistic tRPC fetch-failure classification and exact-operation retry. Validation and conflict errors do not retry.
- Added resumable encrypted restore sessions with deterministic 200-record/4 MiB atomic chunks, a blocking active marker, per-chunk receipts, completion receipts, session-authorized resume/verification, and exact canonical whole-restore verification.
- Tested 1,001-record restore, middle-chunk conflict with no writes for that chunk, exact idempotent retry, restart resume without normal `getIndex`, and direct-browser denial for the new Firestore receipt families.

## Commits

- `a95511a12` Cloud: protect sensitive local persistence
- `af4211c3f` Cloud: resume large encrypted restores

## Verification

- Private Pro source, DBlob, and encrypted-backup tests: 276 passed, 0 failed.
- Private Pro tools: 63 passed, 0 failed.
- Firebase emulator with Microsoft OpenJDK 21.0.4: 38 passed, 0 failed.
- `npm run tscheck`: passed.
- `npm run lint`: passed.
- Key-free `npm test`: tools 63 passed; source 297 passed, 19 skipped, 0 failed.
- Private Pro production build: compiled, linted, type-checked, generated 17 static pages, and completed trace collection.
- `npm audit --omit=dev --audit-level=high --json`: 0 critical, 0 high, 8 reviewed moderate findings.
- Security audit report-only: 47 pass, 8 warn, 43 block with a clean worktree.
- Security audit blocking mode: expected exit 1 with the same approval-gated live blockers.

## Restore semantics

- Starting a restore records an active marker only after the client has fetched the base index.
- Normal vault index reads and content mutations are blocked while the marker exists. The restoring client uses restore-authorized status, index, and record procedures.
- Each chunk is all-or-none. A chunk conflict writes nothing for that chunk, keeps prior chunks and the marker, and reports the same next chunk index.
- An ambiguous network response retries the exact same chunk operation once. If ambiguity remains, the application stays blocked and restart uses the authenticated backup fingerprint to query and resume the same restore.
- Sealing requires all manifest-bound chunks, record counts, and ciphertext bytes, but retains the active marker in `awaiting-verification`. The client verifies and hydrates through session-authorized reads. Only exact verified confirmation creates a completion receipt and deletes the marker in the same transaction.
- There is no destructive cancel. Once a chunk commits, cancellation cannot safely restore the prior cloud state. Resume or reconcile is required.

Production deployment remains blocked by the existing live-state and approval-gated controls. No cloud mutation, deployment, push, server start, real-account action, or automatic device revocation was performed.
