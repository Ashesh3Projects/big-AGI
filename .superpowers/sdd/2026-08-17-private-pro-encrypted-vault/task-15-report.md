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
