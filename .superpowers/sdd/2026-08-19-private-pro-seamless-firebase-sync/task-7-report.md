# Task 7 report

## Result

DONE

Implemented cache and remote reconciliation, a non-blocking sync engine, compact status state, and the narrow Task 2-6 interface extensions required by the reviewed design.

## Files

Created:

- `src/modules/private-pro/sync/privatePro.sync.reconcile.ts`
- `src/modules/private-pro/sync/privatePro.sync.reconcile.test.ts`
- `src/modules/private-pro/sync/privatePro.sync.engine.ts`
- `src/modules/private-pro/sync/privatePro.sync.engine.test.ts`
- `src/modules/private-pro/sync/store-private-pro-sync.ts`

Modified:

- `src/modules/private-pro/sync/privatePro.sync.db.ts`
- `src/modules/private-pro/sync/privatePro.sync.db.test.ts`
- `src/modules/private-pro/sync/privatePro.sync.transport.ts`
- `src/modules/private-pro/sync/privatePro.sync.firebase.ts`
- `src/modules/private-pro/sync/privatePro.sync.firebase.test.ts`
- `src/modules/private-pro/sync/privatePro.sync.serializers.ts`
- `src/modules/private-pro/sync/privatePro.sync.serializers.test.ts`
- `src/modules/private-pro/sync/privatePro.sync.outbound.test.ts`

## Interfaces

- Added `PrivateProSyncSerializer.project(logicalId, value)` for trusted projection keys and referenced asset IDs after validation.
- Added `PrivateProSyncSerializer.projection` for projection materialization and removal.
- Added transport `current` events for `records`, `assets`, and `tombstones`, emitted once after the first committed snapshot for each collection.
- Added atomic DB methods to list live projection records, commit remote records and tombstones, advance effective remote bases, quarantine sanitized reasons, and count all pending work.
- Added `PrivateProSyncReconciler`, `PrivateProSyncEngine`, `createPrivateProSyncEngine`, `createPrivateProSyncStore`, and `privateProSyncStore`.

## TDD evidence

RED:

- Serializer, transport, and DB seam tests failed with missing `project`, missing `current` events, and missing DB methods.
- Reconciler test command failed because `privatePro.sync.reconcile.ts` did not exist.
- Engine test command failed because `privatePro.sync.engine.ts` did not exist.
- The delayed cache hydration regression failed with runtime value `cached-local` instead of `remote`, then passed after projection version fencing.

GREEN:

- Final focused suite: 100 tests, 6 suites, 100 passed, 0 failed, exit 0.
- TypeScript: `npx tsc --noEmit --pretty`, exit 0.
- Scoped ESLint across all modified sync source and tests, exit 0.
- `git diff --check`, exit 0. Git printed only existing LF-to-CRLF conversion notices.

## Behavior

- Cache hydration applies under caller-supplied suppression and cannot overwrite a synchronous local origin or a newer remote materialization.
- Remote payloads require serializer validation, canonical JSON equality, content hash equality, and deterministic serializer projection.
- Same-tab writer and mutation matches update the durable base and acknowledge without runtime apply.
- Sibling tabs apply the committed canonical payload even when shared Dexie contains another tab's pending row.
- Chat messages stage until metadata exists, sort by created time and ID, keep distinct IDs, and quarantine same-ID content collisions.
- Tombstones persist first, discard stale puts through `discardAcrossTombstone`, preserve post-tombstone generations, and rematerialize or remove under suppression.
- Engine startup uses outbound subscription and coordinator ownership first, starts cache hydration without awaiting it, attaches listeners, wakes durable work, and resolves without server catch-up.
- Status contains only phase, pending, sanitized category, retry callback, and last successful sync time. `synced` requires all three collections current and pending zero.
- Stop closes transport, outbound subscriptions and coordinator, window listeners, and blocks pending projection application.

## Self-review

- Verified no payload or credentials enter quarantine or status.
- Verified no global async suppression flag is introduced.
- Verified no coordinator double-start is possible in the engine.
- Verified stale lower revisions do not rematerialize.
- Verified committed listener events are serialized before their corresponding `current` event changes status.
- Verified the status store exposes no additional fields.

## Concerns

None.

## Fix round 1

### Findings addressed

- Engine-owned synchronous and asynchronous suppression depth now gates outbound capture in both the default and injected outbound paths.
- Per-projection edit versions fence cache, record, and tombstone work before every projection callback and across DB/list awaits.
- Capture completion uses unique `captureId` correlation. Failed latest captures remain local-dirty without binding the next successful completion.
- Synthetic transaction acknowledgements emit exact record key, generation, mutation ID, revision, and deletion identity. Bounded committed markers suppress only the exact listener echo and are pruned by higher revisions or newer local captures.
- Listener errors include collection identity, invalidate current state, close the listener set, and require a fresh listener epoch on retry or online recovery.
- Malformed committed documents emit sanitized `invalid-document` events with collection and record key only. Reconciliation quarantines the sanitized reason and continues queue order.
- Lifecycle epochs fence cache, event, status, and projection work. Stop closes listeners first, waits for running engine-owned projection scopes, and does not hang on arbitrary listener work.
- Each engine now owns an isolated status store by default. Added `syncing` for all-current state with durable pending work.
- Outbound `retryNow` only wakes and reschedules due work. Only `flushNow` expedites the 60-second write window.

### RED evidence

- Outbound/Firebase suite: 8 failures for missing capture IDs, failed-capture correlation, synthetic commit notice, `retryNow`, collection-scoped errors, and invalid-document events.
- Engine suite: 5 failures for missing suppression hooks, shared default store, missing listener reattachment, stale lifecycle callbacks, and missing failed-capture correlation.
- Reconciler race: local edit during remote DB commit applied stale runtime data, `1 !== 0`.
- Lifecycle regression: stop hung on an arbitrary remote handler until event and projection task classes were separated.

### GREEN evidence

- Modified DB, serializer, Firebase, outbound, reconciler, and engine suites: 117 tests, 6 suites, 117 passed, 0 failed, exit 0.
- TypeScript: `npx tsc --noEmit --pretty`, exit 0.
- Scoped ESLint for all modified sync source and tests, exit 0 with no warnings.
- `git diff --check`, exit 0. Git printed only LF-to-CRLF conversion notices.

### Self-review

- Projection callbacks cannot re-enter capture while any nested async suppression scope is active.
- Local edits during initial cache listing, DB commit, projection listing, and tombstone persistence win without stale runtime apply/remove.
- Old synthetic commits cannot recreate a marker after a newer local capture.
- Old listener epochs cannot mutate current state or status after retry or restart.
- Stop invalidates lifecycle state before closing transport and outbound, then waits only for engine-owned projection scopes.
- Status ownership and retry callback cleanup are per engine.

### Concerns

None.

## Fix round 3

### Finding addressed

- Added `observeRemoteBase` to persist a monotonic remote base without rebasing local or outbox rows. Deleted canonical observation now uses this observe-only path, preserving the pre-deletion base used by tombstone discard.

### RED evidence

- DB tests failed because `observeRemoteBase` did not exist.
- Reconciler sequence failed with a retained local row whose `baseRevision` had been incorrectly advanced to deletion revision 2.

### GREEN evidence

- DB/reconciler/outbound targeted suites passed, including deleted-response handling after prior deletion observation.
- Full modified DB, serializer, Firebase, outbound, reconciler, and engine suites: 125 tests, 6 suites, 125 passed, 0 failed, exit 0.
- TypeScript: `npx tsc --noEmit --pretty`, exit 0.
- Scoped ESLint for all modified sync source and tests, exit 0 with no warnings.
- `git diff --check`, exit 0. Git printed only LF-to-CRLF conversion notices.

### Self-review

- Deleted canonical revision 2 is recorded monotonically while a pending put based on revision 1 remains revision 1 until its tombstone discards it.
- A genuine pending operation explicitly based at revision 2 survives the same tombstone.
- A later outbound deleted response cannot retain or retry the stale pre-deletion put.
- A stale live revision 1 remains ignored after deletion revision 2 was observed.

### Concerns

None.

## Fix round 2

### Findings addressed

- Replaced the global suppression counter with nested, concurrent projection-key counters. Outbound capture derives the mutation projection key and suppresses only matching projection work.
- Deleted canonical records now advance the deletion base without parsing or projecting the empty payload. Tombstones remain the only runtime deletion trigger.
- Tombstones now apply the same exact committed-marker match as records, including writer, mutation, revision, and deletion identity. Exact echoes are suppressed; higher revisions prune the marker and proceed.
- Each lifecycle start receives a fresh event queue root. New listener work no longer chains behind unresolved work from an old lifecycle.

### RED evidence

- Projection-scoped suppression test failed because an unrelated persona mutation was suppressed by the global counter.
- Restart queue test failed with only one handled event because the new listener chained behind an unresolved old handler.
- Deleted canonical ordering test produced two quarantine rows from attempts to parse the empty deleted payload.
- Exact synthetic delete marker test removed the projection instead of suppressing the tombstone echo.

### GREEN evidence

- Modified DB, serializer, Firebase, outbound, reconciler, and engine suites: 121 tests, 6 suites, 121 passed, 0 failed, exit 0.
- TypeScript: `npx tsc --noEmit --pretty`, exit 0.
- Scoped ESLint for all modified sync source and tests, exit 0 with no warnings.
- `git diff --check`, exit 0. Git printed only LF-to-CRLF conversion notices.

### Self-review

- Holding settings projection A suppresses settings A only; unrelated persona B remains capturable.
- Deleted record before tombstone and tombstone before deleted record are idempotent without schema status or quarantine.
- Exact synthetic delete tombstone echoes do not apply or remove runtime state; higher tombstone revisions proceed.
- Old unresolved lifecycle handlers remain detached while restarted listener events and current state progress normally.

### Concerns

None.
