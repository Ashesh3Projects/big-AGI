# Task 15 report

## Status

Complete.

## Changes

- Added a blocking encrypted vault engine with `hydrateBeforeOpen`, `start`, `stop`, `whenCurrent`, and `logoutAndClear`.
- Added a paged tRPC transport for the Task 14 index, record reads, and compare-and-swap writes.
- Added a secret-free vanilla Zustand status store for locked, hydrating, ready, reconnecting, conflict, rollback-blocked, chunk-required, and error states.
- Extended serializers with side-effect-free validation, explicit conflict policy, and a chat conflict-copy adapter.
- Added an encrypted outbox local sequence so device clock movement cannot reorder offline mutations.

## Synchronization

- Startup fetches the complete remote index, detects revision regression, downloads changed ciphertext, decrypts and validates the complete stage, then applies records in serializer registry order.
- Runtime apply uses event suppression. Apply failures restore the previous runtime snapshot in reverse dependency order without emitting uploads.
- Local portable mutations are encrypted before entering the outbox. Reconnect refetches remote state before draining.
- Ambiguous network failures replay the identical operation ID and encrypted envelope.
- Same-record replace policies refetch canonical ciphertext and replay the exact decrypted local mutation against the new base revision.
- Chats keep the canonical remote record and upload a separate conflict copy.
- Other same-record conflicts fail closed with record type and opaque ID only.

## Acceptance coverage

- PC A credential write, PC B blocking hydration, then independent PC B theme write.
- Offline startup blocking.
- Server revisions instead of device timestamps.
- Stale-base refetch and exact mutation replay.
- Exact encrypted operation replay after an ambiguous network failure.
- Remote index rollback blocking.
- Full-stage validation before apply and runtime rollback on apply failure.
- Disconnect-race encrypted outbox persistence and reconnect refetch.
- Backward device clock with ordered offline mutations.
- Chat conflict copy.
- 700 KiB server limit surfaces `chunk-required`; the encrypted outbox is preserved and never truncated.

## TDD

Initial RED:

```text
Cannot find module './privatePro.vault.engine'
```

Self-review RED:

```text
disconnect-race outbox count: expected 1, actual 0
backward-clock final value: expected light, actual dark
```

GREEN:

```text
11 passed, 0 failed
```

## Verification

- `npx cross-env NODE_ENV=development tsx --test src/modules/private-pro/vault/privatePro.vault.engine.test.ts` - 11 passed.
- Focused related DB, serializer, and engine suites - 21 passed.
- Required focused ESLint - passed.
- Extended affected-file ESLint - passed.
- `npm run tscheck` - passed.
- `git diff --check` - passed with only Git line-ending notices.

## Self-review

- Status and conflict state never contain decrypted values.
- Network errors use fixed local messages instead of upstream text.
- The outbox stores validated encrypted operations only.
- Server timestamps are not used for conflict ordering.
- Oversized records remain encrypted and pending until chunk transport exists.

## Concerns

- Task 17 must add record chunk transport before records above the current 700 KiB Firestore-safe limit can sync.
- Task 16 must integrate the store gate so application controls remain inaccessible whenever `ready` is false.

## Fix round 1

Addressed all three concurrency and persistence review findings.

- Added a monotonic run epoch to every queued engine run. `stop()` invalidates the epoch and unsubscribes synchronously. Every awaited transport, crypto, serializer, database, and status boundary checks the epoch before the next side effect.
- `logoutAndClear()` now invalidates the run, waits for the serialized work tail to settle, clears the in-memory session, then clears all UID-scoped durable and runtime state. A late deferred fetch cannot repopulate the vault.
- Hydration now snapshots both runtime state and encrypted records/revisions. A runtime apply failure, durable commit failure, post-commit injected failure, or cancellation restores the prior runtime in reverse serializer order and restores the prior encrypted cache/revisions.
- Added a transactional database backfill for missing or zero outbox `localSequence` values. Legacy rows are assigned after the current maximum in deterministic `[uid+operationId]` primary-key order.
- Outbox draining now sorts only by `localSequence`, with operation ID as a deterministic tie-breaker. Device `createdAtMs` and tombstone `deletedAtMs` remain metadata only.

Fix TDD RED:

```text
db.backfillOutboxLocalSequences is not a function
persist failure left runtime dark instead of restoring light
stop removed the deferred operation from outbox
logout did not clear the session hook
legacy-b drained before the sequenced and primary-key ordered rows
```

Fix verification:

- Engine, database, and serializer suites - 26 passed, 0 failed.
- Focused affected-file ESLint - passed.
- `npm run tscheck` - passed.
- `git diff --check` - passed with Git line-ending notices only.

## Fix round 3

Restored the agreed synchronous stop interface while preserving the commit barrier.

- `stop()` again returns `void`. It synchronously invalidates the run and unsubscribes, starts the shared stopping barrier, and consumes any rejection so fire-and-forget callers cannot create an unhandled rejection.
- Added `stopAndWait(): Promise<void>` for callers that must await the full serialized tail, including a started acknowledgement transaction.
- Repeated `stop()` and `stopAndWait()` calls share the same barrier and do not invalidate twice.
- `logoutAndClear()` awaits `stopAndWait()`.
- `hydrateBeforeOpen()` and `start()` continue to await the existing stopping barrier before opening a new run.

Fix TDD RED:

```text
stop returned a pending Promise instead of undefined
```

Fix verification:

- Engine, database, and serializer suites - 27 passed, 0 failed.
- Focused affected-file ESLint - passed.
- `npm run tscheck` - passed.
- `git diff --check` - passed with Git line-ending notices only.

## Fix round 2

Closed the remaining acknowledgement commit race.

- Changed `PrivateProVaultEngine.stop()` to return `Promise<void>`.
- `stop()` invalidates the epoch and unsubscribes synchronously, then waits for the current serialized tail, including any IndexedDB acknowledgement transaction that already started.
- A remote write stopped before acknowledgement leaves the encrypted outbox operation intact.
- A stop during an acknowledgement transaction stays pending until the transaction commits, then exposes a consistent committed record/revision with the outbox entry removed.
- `hydrateBeforeOpen()` and `start()` await the stable stopping barrier, so no new run starts while the previous transaction tail is settling.
- `logoutAndClear()` awaits `stop()` before session, durable, and runtime clearing.

Fix TDD RED:

```text
stop returned void instead of a barrier promise
acknowledgement defer hook was never reached
```

Fix verification:

- Engine, database, and serializer suites - 27 passed, 0 failed.
- Focused affected-file ESLint - passed.
- `npm run tscheck` - passed.
- `git diff --check` - passed with Git line-ending notices only.
