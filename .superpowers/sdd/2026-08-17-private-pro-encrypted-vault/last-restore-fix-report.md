# Last restore fix report

Status: LOCAL RESTORE FIXES COMPLETE. NOT READY FOR PRODUCTION DEPLOYMENT.

Code commit: `e0a402399`

## Protocol

- Split restore completion into idempotent seal and verified confirmation operations.
- Seal retains the active marker and exposes `awaiting-verification`; normal vault reads and mutations remain blocked.
- The client fetches the session-authorized exact index and records, verifies canonical values, hydrates runtime assets/state and durable ciphertext, then confirms with the sealed session fingerprint.
- Verification or hydration failure leaves the sealed marker so restart repeats authorized verification and confirmation.
- Confirmation creates the completion receipt and deletes the marker in one transaction.

## Manifest

- Begin binds authenticated backup record and byte totals plus a bounded restore manifest: at most 100,000 records, 500 chunks, 200 records per non-empty chunk, 128 MiB backup bytes, ordered chunk counts, canonical per-chunk SHA-256 fingerprints, restore ciphertext total, and overall backup fingerprint.
- Merge validates the declared count and fingerprint against the exact ordered envelope identity, base revision, ciphertext metadata, and ciphertext content. It rejects membership changes, reordering, mutation, byte overcommit, record overcommit, and operation-ID reuse with different content.
- The Firestore active receipt stores only bounded counts and opaque fingerprints. A zero-record backup uses zero chunks and seals directly.

## Transport

- The ambiguity classifier now covers installed `@trpc/client` `httpLink` failures for empty 200 responses, truncated JSON, and HTML/non-JSON responses, plus network `TypeError` and non-abort `DOMException` failures.
- Structured tRPC errors with server data/code and abort failures remain non-ambiguous.

## Tests

- Added service coverage for manifest count/sum/size bounds, overcommit, ordered fingerprint/content mismatch, zero records, sealed blocking, exact seal/confirm idempotency, and duplicate chunk replay after sealing.
- Added client coverage for 1,001 records, authorized resume, failed sealed verification/hydration retaining the marker, and successful restart confirmation.
- Added real `httpLink` mocked-fetch coverage for empty, truncated, HTML, structured error, and abort responses.
- Added restore-specific engine hydration and explicit restore nonce regression coverage.

## Verification

- Focused restore, service, router, transport, engine, crypto, lifecycle, and encrypted-backup tests passed.
- Private Pro source, DBlob, and encrypted-backup suite: 290 passed, 0 failed.
- Private Pro tools: 63 passed, 0 failed.
- Firebase emulator: 38 passed, 0 failed.
- `npm run tscheck`: passed.
- `npm run lint`: passed.
- Key-free `npm test`: tools 63 passed; source 312 passed, 19 skipped, 0 failed. A first run with an ambient `GROQ_API_KEY` reached one unrelated live-model catalog drift failure; removing that credential produced the required key-free pass.
- Private Pro production build: compiled, linted, type-checked, generated 17 static pages, and completed trace collection. Dummy Firebase, App Check, GA, and PostHog values were used; the Private Pro build path excluded the PostHog upload wrapper.
- `npm audit --omit=dev --audit-level=high --json`: 0 critical, 0 high, 8 reviewed moderate findings.
- Security audit report-only on the clean worktree: 47 pass, 8 warn, 43 block.
- Security audit blocking mode: expected exit 1 with the same approval-gated live-state blockers.
- `git diff --check`: passed.

Production remains blocked by the existing live deployment, Firebase, IAM, App Check, recovery, and independently attested restore-rehearsal controls. No cloud mutation, deployment, push, server start, real-account action, or automatic device revocation was performed.
