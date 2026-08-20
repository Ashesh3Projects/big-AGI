# Task 12 report

## Scope

- Added a dry-run-first workspace reset planner and operator CLI.
- Updated browser API-key, bucket CORS, anonymous rule probe, runtime IAM, deployment, and environment release gates.
- Did not run the reset, mutate cloud state, start a server, push, or alter Tasks 1-11.

## Reset behavior

- Preserves every Firebase Auth identity.
- Approves only verified Auth identities whose normalized email is in `PRIVATE_PRO_ALLOWED_EMAILS`.
- Replaces approved `users/{uid}` records with the current six-field shape and increments from the maximum valid account or claim epoch.
- Preserves unrelated claims, rotates approved Private Pro claims, clears Private Pro claims for non-approved identities, and revokes affected refresh tokens.
- Deletes non-approved and orphan account documents after exact per-UID Firestore and Storage cleanup.
- Cleans exact legacy roots plus pre-release `workspaces/v1`; it does not broadly delete `users/{uid}` Storage prefixes.
- Defaults to count-only reads. Execution requires `--execute`, an exact project confirmation, and a nonempty allowlist.

## CORS and IAM

- The exact browser API services are App Check, Identity Toolkit, Secure Token, Firestore, and Firebase Storage.
- The exported CORS fixture matches installed `@firebase/storage` 0.14.4 request and resumable response headers for the mounted asset operations.
- Anonymous Firestore and Storage findings are named explicitly.
- Runtime IAM retains Auth get/update and Firestore database/account get/create/update only.
- The runtime signing binding and all runtime Storage, Firestore list, and Firestore delete permissions were removed.

## Documentation

- Current deployment docs describe direct authenticated plaintext Firestore and Storage sync.
- Current docs remove vault, recovery, encrypted backup, signed URL, quota, upload reservation, and cron guidance.
- The production cutover order is the exact eight-step Task 12 sequence.
- No production change is claimed as executed.

## Verification

- `npx tsx --test tools/private-pro/reset-workspaces.test.ts tools/private-pro/security-audit.test.ts`
- `npm run tscheck`
- `npx eslint tools/private-pro`
- Documentation placeholder and em dash validation
- `git diff --check`

## Concerns

- Reset execution is intentionally destructive and remains approval-gated.
- The runtime IAM manifest is locally validated but still requires separately approved cloud provisioning and live validation.
- CORS is derived from the installed SDK source and mounted calls. A production browser trace should remain part of the approval evidence before mutation.

## Fix round 1

- Bound the configured Storage bucket to its metadata name and the confirmed numeric Firebase project before any object count or deletion.
- Made reset epochs resumable and idempotent across account-only, claims-only, fenced, and completed partial states. Unsafe epoch overflow now fails closed.
- Added the execution fence: inactive target-epoch account, cleared claims, and token revocation before cleanup, followed by final convergence at the same epoch and a second revocation.
- Execution now stops on the first UID failure and emits only sanitized UIDs, counts, fixed stages, and fixed error codes. Top-level failures and invalid arguments do not echo upstream content.
- Added unauthenticated valid-shaped v1 Firestore and Storage read/write endpoint probes with best-effort cleanup after unexpected allowed writes.
- Added the redacted installed-SDK CORS trace fixture, removed unused PUT, and audited exact methods, headers, rule count, and max age.
- Removed `PRIVATE_PRO_MAX_FILE_BYTES` from current environment docs. The v1 attachment limit is documented as a fixed 64 MiB rule constant.
- Replaced the stale recovery runbook link with concise current plaintext v1 recovery requirements.

## Fix round 2

- Added a strict global reset operation journal and per-UID target journal. The journal freezes target epochs and phases across retries and is the only completion authority.
- A complete operation makes reset reruns no-op. A failed operation stays running until resumed, and the operation is marked complete only after every target reaches complete.
- Bootstrap now reads the server-only operation marker before account activation and returns temporary unavailability while reset is running.
- Every account UID, including orphans, receives an inactive target-epoch fence before cleanup. Auth identities also have claims cleared and tokens revoked before cleanup.
- Tightened epoch parsing so unsafe, fractional, negative, and non-finite numeric epochs fail closed.
- Security audit probes now require `PRIVATE_PRO_SECURITY_AUDIT_UID`, target actual v1 paths, use a codec-derived record key and valid Storage metadata, and require operator cleanup for any unexpectedly allowed write.
- Documented that `--report-only` still performs bounded active anonymous endpoint probes.

## Fix round 3

- Revisioned the reset as `workspaceV1Reset-v1` with revision constant 1 and an executor lease.
- Firestore and Storage rules now deny all v1 browser access while reset revision 1 is running. Emulator tests cover running, complete, and absent marker states.
- Bootstrap checks the revisioned marker before account activation and again before claims, while the rules lock closes the remaining timing window.
- Resume inventory includes journal-only targets whose account document was already deleted.
- Execute uses a bounded fresh-inventory convergence loop, requires two stable complete passes, refreshes the single-executor lease, and refuses completion while targets are incomplete or inventory is unstable.
- Security audit separates the approved audit UID from UUID mutation IDs and keeps codec-derived Firestore shapes plus operator cleanup.

## Fix round 4

- Replaced pass-level lease refresh with a renewable lease controller that owns the executor ID and expiry for the full convergence run. It renews every 20 seconds against the 60-second lease and aborts on renewal failure, expiry, or takeover.
- Added transactional ownership assertions before target claims, account and claim fences, token revocations, every recursive Firestore target deletion, every Storage prefix/list/object deletion, final account and claim mutations, every journal phase, and operation completion. The renewal timer is always cleaned up.
- Made convergence state explicit with `lastCompleteSignature` and `consecutiveCompletePasses`. Completion now requires two consecutive complete passes with the same relevant and target UID signature. Incomplete coverage or a changed UID set resets the count.
- Changed the Storage read probe from an absent-object read to the denied v1 asset list endpoint. All rule probes now include the approved Origin, Referer, and a transient valid App Check token while omitting Firebase Auth, which isolates Rules from API-key and App Check rejection.
- Added `PRIVATE_PRO_SECURITY_AUDIT_APP_CHECK_TOKEN` as one-run operator input. The audit consumes and removes it from the process environment, scrubs it from child processes, never logs it, and returns unknown blocking probe results without fetching when it is absent.
- Matched the installed Firebase Storage SDK multipart request: POST bucket object endpoint, operation-derived asset ID/path, numeric one-byte `size`, exact custom metadata, `X-Goog-Upload-Protocol: multipart`, and SDK CRLF/closing boundary shape. Unexpected allowed writes still require operator Admin cleanup.

## Fix round 4 verification

- `npx tsx --test tools/private-pro/reset-workspaces.test.ts tools/private-pro/security-audit.test.ts`
- `npx tsx --test src/modules/private-pro/auth/privatePro.auth.service.test.ts`
- `npm run test:firebase:exec` with the documented JDK 21 environment
- `npm run tscheck`
- `npx eslint tools/private-pro`
- Documentation placeholder and em dash validation
- `git diff --check`
