# Task 11 report

## Result

DONE

## Deletion inventory

Deleted 63 tracked files:

- 51 files under `src/modules/private-pro/vault/**`.
- 4 vault UI files.
- 2 encrypted asset server files: the cloud router and deployment regression.
- 2 encrypted backup files.
- 2 sweep-expired cron route files.
- 1 vault password test helper.
- `vercel.json`, because the removed cron was its only behavior.

The final staged tree changes 91 files: 3 added, 25 modified, and 63 deleted, with 655 insertions and 15,927 deletions. The added files are the cutover implementation, its tests, and this report.

## Local cutover contract

Created `runPrivateProWorkspaceV1LocalCutover(port)` with the global marker:

```text
private-pro-cutover:workspace-v1
```

The cleanup:

- Deletes only the proven legacy databases `private-pro-vault-v1` and `private-pro-sync-v1`.
- Never deletes the current `private-pro-workspace-v1` database.
- Removes the explicit portable and sensitive localStorage allowlists.
- Removes only the exact `private-pro-vault-device:` prefix.
- Removes the explicit portable idb-keyval cells `app-chats` and `app-chats-v3`.
- Clears the legacy `Big-AGI.largeAssets` table through its narrow helper.
- Preserves Firebase Auth, heartbeat, installations, App Check, and unrelated browser keys because no broad storage or database clear is used.
- Waits for IndexedDB success and rejects with sanitized errors on error or blocked deletion.
- Writes the marker only after every cleanup step succeeds.
- Repeats safely after partial failure and becomes a no-op after the marker exists.

The provider runs cutover inside production prepare before managed persistence or asset activation. Children remain non-blocking. Startup failure enters the existing sanitized error state, and retry reruns the full cleanup. Same-UID remount after the marker does no destructive work and preserves current v1 and volatile state.

## Source and dependency cutover

Removed cloud router registrations, cron routing, encrypted backup, encrypted asset server routes, device, recovery, password, crypto, repository, quota, and compatibility serializer surfaces.

Removed transition-only persistence APIs:

- `setPrivateProEncryptedPersistenceActive`
- `markPrivateProPortableAssetEncrypted`
- `privateProPortableAssetBeforeUnload`
- `clearPrivateProPlaintextPortablePersistence`

Renamed active store adapter APIs and comments from vault terminology to sync terminology. Removed one now-unused combined model adapter. Historical specs and deployment documentation remain for Task 12.

Ran `npm uninstall hash-wasm`. Both `package.json` and `package-lock.json` no longer contain the package.

## TDD evidence

RED:

- `npx tsx --test src/modules/private-pro/sync/privatePro.sync.cutover.test.ts` failed because `privatePro.sync.cutover` did not exist.
- Expanded cutover/provider tests then failed for missing portable IDB cleanup, browser deletion completion handling, and provider ordering.
- Deletion-boundary tests failed while the vault tree, routes, backup files, cloud registrations, and dependency still existed.

GREEN:

- Final focused cutover, provider, persistence, serializer, direct asset, dependency, and import-boundary suite: 119 passed, 0 failed.
- `npm run tscheck`: exit 0 for root and tools TypeScript programs.
- `npm run lint`: exit 0 with no warnings.
- `git diff --check`: exit 0; only the repository's Windows line-ending notices were printed.

A stale generated `.next/types` cron route file initially made root TypeScript reference the deleted route. `next typegen` refreshed the manifest but retained that orphan file, so the ignored generated file was removed. No generated `.next` assertions were added. The tools TypeScript program also exposed an existing missing type-only import in the coordinator test; the import was added without behavior changes.

## Forbidden searches

Exact required search:

```powershell
rg -n "privateProVault|PrivateProVault|privateProEncryptedBackup|hash-wasm" src app pages tools package.json
```

Result: no output, ripgrep status 1, classified as zero matches.

Extended current-code search:

```powershell
rg -n -i "hash-wasm|argon2|encrypted backup|vault password|recovery key" src app pages tools package.json
```

Result: no output, ripgrep status 1, classified as zero matches.

The remaining generic `vault` matches are intentional:

- Exact legacy database/device identifiers in the cutover and its tests.
- Task 9 UI negative assertions.
- Security-audit legacy cloud collection names retained for Task 12 reset/audit work.
- An unrelated Obsidian URI parameter.

## Boundary assertions

Dependency and import tests now prove:

- The removed application crypto dependency is absent from manifest and lockfile.
- The vault tree, UI, encrypted asset router/test, encrypted backup, cron route, and password helper stay absent.
- The cloud router retains Private Pro auth without removed vault registrations.
- Direct Firestore sync and Storage asset browser modules stay present.
- Direct browser modules do not import Firebase Admin or the deleted vault path.

## Self-review

- The cutover is global per build marker, not per UID.
- The current v1 database is not deleted.
- Marker creation is the final operation.
- No `localStorage.clear()` or broad IndexedDB enumeration/deletion exists.
- The durable localStorage removal path bypasses the managed volatile Storage prototype gate.
- Firebase and unrelated keys are preserved by positive allowlists only.
- Cutover errors and IndexedDB errors are sanitized.
- Open builds remain unchanged because the production cutover is reachable only inside the enabled Private Pro provider lifecycle.
- Task 10 Firestore and Storage security behavior was not changed.
- No payload, credential, token, or asset content is logged.

## Concerns

None.
