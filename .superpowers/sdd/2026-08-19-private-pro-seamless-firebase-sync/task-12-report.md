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
