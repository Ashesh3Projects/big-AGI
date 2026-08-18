# Task 19 report

## Status

Complete.

## Browser access ruling

Allowed browser Firestore reads: none.

Allowed browser Firestore writes: none.

Allowed browser Storage reads, writes, deletes, and lists: none.

The production provider tree uses `ProviderPrivatePro` and `ProviderPrivateProVault`. Account bootstrap calls the authenticated `privateProAuth.bootstrap` procedure. Encrypted vault records, keysets, devices, operations, indexes, asset metadata, reservations, rate windows, and object signed URLs use authenticated server procedures backed by Firebase Admin SDK. `getPrivateProClientFirestore()` remains referenced only by the former plaintext `privatePro.sync.transport.ts`, and `ProviderPrivateProSync` is not mounted in the application provider tree. No direct client Firestore bootstrap read remains.

Firestore and Storage therefore use one catch-all browser denial. Firebase Admin SDK access and signed Storage URLs are unaffected because Admin SDK bypasses Firebase Security Rules and signed URLs authorize the individual object request outside browser SDK rules.

## Changes

- Replaced the former entitlement-based Firestore reads with one catch-all read/write denial.
- Replaced the former legacy asset Storage read with one catch-all read/write denial.
- Added emulator coverage for account metadata, every encrypted vault family, former migration and plaintext sync paths, unknown nested paths, collection and collection-group queries, the current encrypted chunk object path, old Storage paths, and Storage list operations.
- Seeded all emulator fixtures through a rules-disabled context and verified both Firestore and Storage seeds.
- Retained the two Task 17 `assetReservations` composite indexes:
  - UID-local `opaqueAssetId ==` plus `status ==` reservation lookup.
  - Collection-group `status ==` plus `expiresAtMs <=` expiration sweep.
- Task 13 record/tombstone index paging orders by document ID and requires no composite index.

## TDD

Initial RED with the expanded emulator tests:

```text
35 tests: 26 passed, 9 failed
```

The failures proved the current browser exceptions for the top-level account document, five former plaintext Firestore families, same-account legacy list access, legacy Storage object reads, and Storage list access.

After the catch-all denials and index cleanup:

```text
35 tests: 35 passed, 0 failed
```

Mutation check:

- Deliberately allowed same-account `get` on `users/{uid}/vault/data/records/{recordId}`.
- The record-family denial test failed because the read succeeded.
- Mutation result: 34 passed, 1 failed.
- Restored the catch-all denial and reran the full emulator suite: 35 passed, 0 failed.

## Verification

- `$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-21.0.4.7-hotspot'; $env:PATH="$env:JAVA_HOME\bin;$env:PATH"; npm run test:firebase:exec` - 35 passed, 0 failed.
- `npx eslint test/firebase` - passed with zero warnings.
- `npx cross-env NODE_ENV=development tsx --test src/modules/private-pro/vault/privatePro.vault.greenfield.test.ts` - 1 passed, 0 failed.
- `npx cross-env NODE_ENV=development tsx --test "tools/private-pro/**/*.test.ts" "src/modules/private-pro/**/*.test.ts" "src/modules/trade/privateProEncryptedBackup.test.ts"` - 295 passed, 0 failed.
- `npm run tscheck` - passed application and tools TypeScript projects.
- `npm test` - Private Pro tools passed 20/20 and the source run reported 291 passed, 18 skipped, and 1 unrelated failure. The failure is the existing live Groq model-list drift for `minimaxai/minimax-m2.7`, `llama-3.3-70b-versatile`, and `llama-3.1-8b-instant`. No Private Pro or Firebase rule test failed.
- `git diff --check` - passed.

## Fix round 2

Status: complete.

### Finding

The fix-round-1 deployment contract inferred cron behavior from an exact source substring. A harmless refactor or formatting change could skip the `quotaReservations` index assertion while the scheduled plaintext sweep remained live.

### Changes

- Moved the cron handler implementation into `privatePro.sweep-expired.ts`; the App Router entry exports only the supported `runtime` and exact `GET` handler binding.
- Added a production dependency factory for the legacy and encrypted Firebase sweep services.
- Added an injectable HTTP handler factory. The production handler keeps the same enablement, cron-secret authorization, parallel sweep, summed `released` response, and Node.js runtime behavior.
- Replaced route source inspection with executable assertions that:
  - `route.GET` is the production composed handler.
  - An authorized injected HTTP request invokes both legacy and encrypted sweeps exactly once and returns their summed count.
  - `vercel.json` schedules exactly `/api/private-pro/sweep-expired` at `0 3 * * *`.
  - The scheduled legacy sweep has the required `quotaReservations(status, expiresAtMs)` index.

### TDD

Initial behavior RED:

```text
3 tests: 2 passed, 1 failed
createPrivateProReservationSweepDependencies is not a function
```

Strengthened HTTP-handler RED:

```text
3 tests: 2 passed, 1 failed
createPrivateProSweepExpiredGET is not a function
```

Final focused GREEN:

```text
3 tests: 3 passed, 0 failed
```

### Verification

- Focused route/deployment contract - 3 passed, 0 failed.
- Firebase Emulator Suite with Microsoft JDK 21 - 35 passed, 0 failed.
- All Private Pro source/tool/encrypted-backup tests - 298 passed, 0 failed.
- Focused ESLint - passed with zero warnings.
- `npm run tscheck` - passed application and tools TypeScript projects.
- `git diff --check` - passed.
- One intermediate Private Pro run hit the existing one-tick timing assertion in `privatePro.vault.engine.test.ts`. Repeated focused runs on the untouched parent commit alternated between the same pass and failure, proving baseline timing variance. The final full candidate run passed 298/298; no unrelated engine code was changed.
- A later ESLint rerun after an indentation-only cleanup was blocked before file analysis by the local `@rushstack/eslint-patch` caller-recognition error. The focused ESLint run on the same implementation had already passed, and no lint configuration or semantic code changed afterward.
- Main checkout `F:\Projects\big-agi` remained clean on branch `pro`.

## Cloud boundary

No Firebase rules, indexes, Storage configuration, or application build was deployed. No cloud resource was mutated.

## Fix round 1

Status: complete.

### Finding

The first report incorrectly classified the plaintext `assets` and `quotaReservations` indexes as obsolete based only on browser provider call sites. The plaintext asset client is not mounted by the production provider tree, but the authenticated cloud router still exposes `reserveUpload`, `finalizeUpload`, `getDownload`, `releaseExpired`, and `releaseReservation`. Those procedures call `getFirebasePrivateProAssetsService()` directly.

The production cron route also still calls `getFirebasePrivateProAssetsService().sweepExpiredReservations()`. Removing only that call would leave reservations created through the still-mounted plaintext server procedures without scheduled cleanup. Removing the plaintext procedures and modules is outside Task 19 scope.

### Changes

- Restored the `assets(contentHash, status)` collection index required by the mounted plaintext `reserveUpload` procedure.
- Restored the `quotaReservations(status, expiresAtMs)` collection-group index required by the live scheduled plaintext reservation sweep.
- Added a deployment contract against the real cloud router, cron route, and `firestore.indexes.json`. Each legacy index is required only while its production consumer remains mounted, so a later cleanup can remove the procedures, cron call, and indexes together.
- Left the cron route and legacy modules unchanged.
- Browser Firestore and Storage access remains fully denied.

### TDD

RED:

```text
1 test: 0 passed, 1 failed
reserveUpload requires the assets contentHash/status index
```

GREEN after restoring both reachable server-path indexes:

```text
1 test: 1 passed, 0 failed
```

Mutation check:

- Removed only the restored `quotaReservations` index.
- The deployment contract failed with `the scheduled plaintext reservation sweep requires the quotaReservations status/expiresAtMs index`.
- Restored the index and the focused contract passed again.

### Verification

- `npx eslint src/modules/private-pro/assets/privatePro.assets.deployment.test.ts app/api/private-pro/sweep-expired/route.ts test/firebase` - passed with zero warnings.
- `npx cross-env NODE_ENV=development tsx --test src/modules/private-pro/assets/privatePro.assets.deployment.test.ts` - 1 passed, 0 failed.
- Firebase Emulator Suite with Microsoft JDK 21 - 35 passed, 0 failed.
- All Private Pro source/tool/encrypted-backup tests, including the deployment contract - 296 passed, 0 failed.
- `npm run tscheck` - passed application and tools TypeScript projects.
- `git diff --check` - passed.
