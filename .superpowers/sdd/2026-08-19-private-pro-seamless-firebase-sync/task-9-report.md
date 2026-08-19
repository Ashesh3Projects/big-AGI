# Task 9 report

## Result

DONE

## Files

Created:

- `src/modules/private-pro/sync/ProviderPrivateProSync.tsx`
- `src/modules/private-pro/sync/ProviderPrivateProSync.test.tsx`
- `src/modules/private-pro/sync/privatePro.sync.runtime.ts`
- `src/modules/private-pro/ui/PrivateProSyncStatus.tsx`
- `src/common/providers/single-tab/ProviderSingleTab.test.tsx`

Modified:

- `pages/_app.tsx`
- `src/apps/chat/components/panes/store-panes-manager.ts`
- `src/common/livefile/store-live-file.ts`
- `src/common/logger/store-logger.ts`
- `src/common/logic/store-logic-sherpa.ts`
- `src/common/stores/metrics/store-metrics.ts`
- `src/common/stores/store-client.ts`
- `src/common/stores/workspace/store-client-workspace.ts`
- `src/common/providers/single-tab/ProviderSingleTab.tsx`
- `src/modules/private-pro/ui/PrivateProAccountControl.tsx`
- `src/modules/private-pro/persistence/privatePro.persistence.ts`
- `src/modules/private-pro/persistence/privatePro.persistence.test.ts`
- `src/modules/private-pro/auth/**`
- `src/modules/private-pro/config/privatePro.config.ts`
- `src/modules/private-pro/config/privatePro.config.server.ts`
- `src/server/env.server.ts`
- `src/server/trpc/trpc.server.ts`
- `src/modules/private-pro/vault/privatePro.vault.router.ts`
- `src/modules/private-pro/vault/privatePro.vault.router.test.ts`
- `src/modules/private-pro/vault/ProviderPrivateProVault.tsx`
- `tools/private-pro/manage-access.ts`
- `tools/private-pro/manage-access.test.ts`
- `src/modules/private-pro/assets/privatePro.assets.client.ts`
- `src/modules/private-pro/assets/privatePro.assets.client.test.ts`
- `src/modules/private-pro/assets/privatePro.assets.local.ts`
- `src/modules/dblobs/dblobs.db.ts`
- `src/modules/dblobs/dblobs.private-pro.test.ts`
- Sensitive runtime stores under chat panes, live files, logger, Sherpa, metrics, device, and workspace received narrow Private Pro reset adapters.
- `src/modules/private-pro/sync/privatePro.sync.coordinator.ts`
- `src/modules/private-pro/sync/privatePro.sync.coordinator.test.ts`
- `src/modules/private-pro/assets/privatePro.assets.router.ts`
- Retained pre-Task-11 vault router call sites and tests were adjusted only to compile without removed device headers and middleware.
- `tools/tsconfig.json` and `eslint.config.mjs` now cover `.test.tsx` with the tools test program.

## Provider and sign-out

- Private Pro sync mounts after authentication and renders children immediately.
- Startup awaits managed persistence and the DBlob asset activation barrier in the background before constructing and starting the engine.
- Every mounted account owns a fresh status store and writer ID.
- Asset construction always receives the durable sync DB lease port with the tested 15,000 ms lease, 5,000 ms renewal, and 250 ms retry timings, including when Web Locks exist.
- Account and lifecycle epochs prevent late old-account startup and stale cleanup from reactivating or clearing the current UID.
- Sign-out drains for 5,000 ms. Remaining work throws `PrivateProUnsyncedChangesError(count)` until explicit discard.
- Confirmed sign-out stops the engine, deactivates account-scoped persistence, resets managed runtime stores, clears the UID sync DB and assets, broadcasts signed-out, calls raw Firebase sign-out, then reloads.
- Ordinary unmount and account cleanup stop and clear local runtime state without Firebase sign-out or reload.

## Managed persistence and UI

- Encrypted persistence naming was replaced by managed Private Pro activation, deactivation, and UID clear APIs.
- Explicit portable and sensitive allowlists remain.
- Volatile Zustand values, legacy plaintext DBlobs, active local assets, and UID sync tables are cleared through one account-scoped flow.
- The account control now shows only email, compact sync status, retry, sign-out, and a minimal pending-discard confirmation.
- Private Pro bypasses the global single-tab gate. Open builds retain the existing leader/follower screen.
- Auth bootstrap copy is workspace-neutral.

## Auth and server shape

- Auth context exposes enabled state, user, bootstrap, and raw Firebase sign-out.
- Request headers contain only Firebase authorization and optional App Check.
- The tRPC context no longer parses a vault device header.
- Vault device procedure factories were removed. Retained pre-Task-11 vault routes use premium account authorization until Task 11 deletes them.
- Current account and bootstrap records contain only UID, email, active state, access epoch, and timestamps as applicable.
- Attachment quota runtime fields and environment configuration were removed from current auth and access management code.

## Carried Task 8 breaker fix

- A renewal promise that never settles no longer pins asset upload cleanup or a Web Lock callback.
- Expiry or abort cancels Storage through the lease-owned signal, clears timers, initiates the exact fenced release without awaiting the renewal, attaches same-turn rejection handling to detached release work, and returns promptly.
- Fence and owner-token rotation continue to reject late renewal attempts.
- The regression proves Storage abort, prompt `ensureUploaded` settlement, Web Lock exit, successor acquisition, and preserved timely renewal behavior.

## TDD evidence

RED:

- Lease liveness: 1 failing regression because the Web Lock callback remained active after the never-settling renewal reached expiry.
- Single-tab bypass: test initially failed before the `enabled` split component existed.
- Managed persistence: 9 failures before managed APIs and atomic UID clear existed.
- Auth account shape: 2 failures because quota fields remained in bootstrap output.
- Access management: 1 failure before current-shape account construction existed.
- Provider and account UI: missing module and missing content component failures before implementation.

GREEN:

- Final focused provider, persistence, auth, access, asset, DBlob, coordinator, engine, config, and retained vault-router compatibility suites: 117 tests passed, 0 failed.
- Root TypeScript: `npx tsc --noEmit --pretty`, exit 0.
- Tools and test TypeScript: `npx tsc --noEmit --pretty -p tools/tsconfig.json`, exit 0.
- Scoped ESLint for all modified source and tests: exit 0.
- `git diff --check`: exit 0 with only repository line-ending conversion warnings.

## Self-review

- No payload, credential, token, asset content, or raw error detail is logged.
- Disabled Private Pro constructs no Firebase sync or asset runtime and leaves children unchanged.
- Open storage and single-tab behavior remain unchanged.
- Runtime status is per mounted UID and cannot leak the previous account phase, pending count, or retry callback.
- Projection suppression remains engine-owned and the provider supplies only the minimal callback.
- Cloud workspace data is never cleared during client sign-out.
- Task 11 vault database deletion and first-launch cutover remain out of scope.

## Concerns

- The legacy encrypted vault router remains mounted until Task 11 and is now protected by current premium account and App Check authorization without the removed device header middleware. Task 11 deletes this surface completely.

## Fix round 1

### Findings addressed

- Every retained vault and encrypted-asset procedure remains mounted for type compatibility but now throws a sanitized `NOT_FOUND` before any legacy handler or quota service runs.
- Private Pro deactivation now returns to a pending-auth volatile sentinel. Portable localStorage and IndexedDB adapters cannot fall through to Open durable storage while the Private Pro page remains alive. Open builds retain null and durable behavior.
- Lifecycle startup now rolls back prepare and engine-start failures, attempts engine stop and deactivation, clears partial state, reports a sanitized error, and lets retry rerun full construction.
- Stop cleanup attempts deactivation even when engine stop rejects, and React unmount consumes the sanitized cleanup rejection.
- Sign-out is single-flight. Pending confirmation releases the flight for a later confirmed call. Confirmed sign-out broadcasts first, then attempts stop, deactivation, UID clear, Firebase sign-out, and reload in order even when earlier steps fail. Only a generic failure reaches the UI after the reload attempt.
- The account control renders compact generic action failure copy and never exposes raw error details.
- Auth bootstrap now uses an epoch and exact UID guard across auth callbacks, effect disposal, bootstrap resolution, token refresh, denial, and Firebase sign-out. Stale A results cannot mutate B or signed-out state.
- Current account and access management remain quota-free. Legacy asset quota code is unreachable through the fail-closed router.

### RED evidence

- Legacy route RED: 6 failures proved current premium callers could still enter vault handlers and the encrypted-asset router lacked an injectable fail-closed factory.
- Managed persistence RED: deactivation made `isPrivateProManagedPersistenceActive()` false and allowed Open fallback.
- Lifecycle RED: 6 failures covered duplicate concurrent sign-out cleanup, skipped cleanup after rejection, raw failure leakage, prepare failure propagation, retained failed engine state, and stop skipping deactivation.
- Auth RED: 3 failures because the epoch controller did not exist.

### GREEN evidence

- Focused Task 9, auth race, persistence, retained route, DBlob, asset, coordinator, engine, config, and access suites: 130 tests passed, 0 failed.
- Root TypeScript and tools/test TypeScript: exit 0.
- Scoped ESLint for the round-1 source and tests: exit 0.

### Self-review

- Fail-closed middleware runs after current premium/App Check authorization but before each handler.
- No legacy quota, device, vault payload, or service error is observable to a caller.
- Pending-auth remains volatile after startup failure, cleanup, sign-out failure, and mocked reload return.
- Retry does not silently no-op after a failed startup.
- All sign-out cleanup steps are attempted once per flight.
- The carried never-settling lease regression and timely-renewal regression remain in the final verification set.

### Concerns

None.

## Fix round 2

### Findings addressed

- Lifecycle start, retry, stop, and confirmed sign-out now serialize through one operation tail. A replacement start cannot enter prepare while stop is blocked.
- Stop invalidates the active start epoch and waits its serialized operation. Stale start cleanup stops only its local engine and does not globally deactivate after a newer start owns the UID.
- Sign-out pending detection uses flush first, then durable count. Dual failure blocks unconfirmed sign-out with a generic error, while confirmed discard proceeds with unknown pending.
- Confirmed sign-out guards broadcast, stop, deactivation, clear, Firebase sign-out, and reload individually. A throwing broadcast cannot skip later cleanup. Single-flight remains intact.
- The retained cron route authenticates as before, then returns sanitized 410 without constructing the legacy reservation service or calling quota code.
- Unauthorized bootstrap wraps Firebase sign-out rejection. A current rejection becomes a generic auth error; a stale rejection after account change is ignored without an unhandled rejection.

### RED evidence

- Lifecycle RED: 5 failures proved replacement start overlapped blocked stop, stale start ordering was unsafe, dual pending failure leaked raw errors or blocked confirmed discard, and broadcast throw skipped cleanup.
- Auth RED: 2 failures because current and stale unauthorized sign-out rejections escaped.
- Cron RED: authenticated production route returned 200 and invoked legacy cleanup rather than failing closed.

### GREEN evidence

- Focused Task 9, auth, cron, fail-closed route, persistence, DBlob, asset, coordinator, engine, config, and access suites: 137 tests passed, 0 failed.
- Root TypeScript and tools/test TypeScript: exit 0.
- Scoped ESLint and diff check: exit 0.

### Self-review

- A start does not overlap stop-held cleanup.
- Stale start cleanup never calls global deactivation after a newer epoch exists.
- Confirmed sign-out attempts every cleanup step exactly once per single flight.
- Cron factories stay lazy and untouched on the mounted production route.
- Firebase sign-out rejection cannot leak raw details or mutate a newer UID.
- The carried never-settling renewal and timely renewal regressions remain green.

### Concerns

None.
