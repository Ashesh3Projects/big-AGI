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

## Fix round 2

### Design

The cross-UID case cannot safely distinguish an A cleanup emission from a B user edit while both accounts share the same runtime stores. The existing authentication provider already unmounts the application while a new account bootstraps. The bounded extension is:

- First UID and same-UID remount keep rendering children immediately and install their observer before the first asynchronous startup operation.
- A real A-to-B switch renders a sanitized workspace-transition screen instead of B application children.
- The transition waits for A's lifecycle owner, deactivates A assets, clears A managed runtime and UID data, then installs B's observer.
- Only after that sequence completes does the B application mount and start normal cutover, activation, and engine startup.
- Failure keeps the transition gate closed and exposes a retry action. No A reset can enter B's mutation buffer.

The startup handoff is a single atomic boundary:

- `closeAndTake()` synchronously marks the buffer inactive, unsubscribes its serializers, clones the coalesced mutations into a finite array, clears the map, and returns that array.
- Outbound serializers are already subscribed when closure occurs.
- The engine captures the finite frozen array before cache hydration.
- Any edit after closure is captured normally by outbound because startup suppression has ended.
- If a capture fails, only the uncaptured suffix is restored for retry. Already durable mutations remain in the DB.
- A stopped lifecycle never restores a late failed frozen batch.

### RED evidence

- The cross-UID transition helper did not exist.
- Existing startup began B observation before waiting for and clearing A.
- Engine startup expected the previous live `mutations()/acknowledge()` interface instead of atomic `closeAndTake()`.
- A continuous-edit stress case could keep the live drain conceptually unbounded.
- An edit after atomic closure initially remained in the old test expectation instead of normal outbound capture.
- A failed frozen capture initially had no suffix restoration.
- A late failed capture after stop initially restored the closed buffer.

### GREEN evidence

- Final provider, startup-buffer, engine, outbound, persistence, serializer, reconciler, cutover, and direct-asset suite: 189 passed, 0 failed.
- `npm run tscheck`: exit 0 for root and tools TypeScript programs.
- `npm run lint`: exit 0 with no warnings.
- `git diff --check`: exit 0 with only repository line-ending notices.

### Self-review

- Cross-UID children are gated only during the destructive prior-account cleanup that would otherwise erase or misclassify edits.
- The transition gate never exposes raw cleanup errors.
- B observation begins after A clear and before B children mount.
- First UID and same-UID paths preserve the existing immediate-child behavior.
- `closeAndTake()` is synchronous and called once.
- Frozen replay is finite and bounded by the coalesced record identities present at closure.
- Post-close edits flow through the normal outbound serializer subscriptions.
- Startup replay still creates local-origin protection before cache hydration.
- Failed replay restores only the uncaptured suffix and cannot re-arm after stop.
- No wholesale snapshot seeding or account-shared mutation map was introduced.

### Concerns

None.


## Fix round 1

### Findings addressed

- Removed the remaining server-only upload, quota, cron, signed-URL, and Admin Storage configuration after proving it had no runtime caller.
- Removed `CRON_SECRET`, `PRIVATE_PRO_MAX_FILE_BYTES`, and every `PRIVATE_PRO_UPLOAD_RATE_*` server environment entry.
- Removed obsolete upload constants, positive-integer limit parsing, server config fields, and server-side Firebase bucket input.
- Firebase Admin initialization now requires only project identity and credentials for Auth, Firestore, and App Check. The Admin Storage import, bucket option, bucket export, and signer-specific Admin test are gone.
- Browser `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` remains required for the direct Firebase Storage client.
- Pending-auth to first-UID activation now preserves volatile portable and sensitive values. Switching a real UID A to B still clears account A state.
- A UID-scoped startup mutation buffer subscribes to the non-asset serializers synchronously from the layout-effect lifecycle start before the first cutover await.
- The buffer records only mutations emitted after its baseline, coalesces by record identity, survives cutover or prepare failure, and is re-armed after a current engine-start failure.
- Engine startup establishes outbound subscriptions, suppresses their duplicate local capture while the startup buffer is active, durably drains and acknowledges the live buffer, stops the buffer, then starts cache hydration.
- The drain loops across edits emitted during outbound startup and while an earlier buffered capture is awaiting durability. A stopped or canceled lifecycle cannot re-arm the buffer.
- Startup capture creates normal local-origin protection before cache hydration, so cached or remote state cannot overwrite an edit made during cutover.
- No wholesale snapshot seed or default-value upload was added. Asset capture remains owned by the activated asset serializer after the local port exists.

### RED evidence

- Server config regression exposed `maxFileBytes` and `uploadRateLimit`.
- Admin initialization still rejected a missing Storage bucket.
- Source boundary regression found obsolete names in server config, shared config, Firebase Admin, and `env.server`.
- First UID activation cleared a value written while pending authentication.
- Engine startup reached cache before replaying a startup mutation.
- Duplicate buffered/live capture initially advanced the durable generation twice.
- Edits emitted during outbound startup or while capture awaited durability were initially absent from the startup handoff.
- A late canceled engine-start failure initially re-armed the stopped buffer.

### GREEN evidence

- Final config, Firebase Admin/App Check, persistence, provider, serializer, outbound, engine, reconciler, cutover, direct asset, dependency, and import-boundary suite: 217 passed, 0 failed.
- `npm run tscheck`: exit 0 for root and tools TypeScript programs.
- `npm run lint`: exit 0 with no warnings.
- `git diff --check`: exit 0 with only repository line-ending notices.

### Search classification

```powershell
rg -n "CRON_SECRET|PRIVATE_PRO_MAX_FILE_BYTES|PRIVATE_PRO_UPLOAD_RATE_WINDOW_MS|PRIVATE_PRO_UPLOAD_RATE_MAX_REQUESTS|PRIVATE_PRO_UPLOAD_RATE_MAX_BYTES|getPrivateProStorageBucket|firebase-admin/storage" src app pages tools package.json
```

Result: no output, ripgrep status 1.

The remaining `storage.objects`, `signBlob`, and signed-URL matches are confined to:

- `tools/private-pro/security-audit.ts` and its tests, scheduled for Task 12 IAM/CORS/audit rewriting.
- Direct asset test fakes whose `storage.objects` map represents browser Firebase Storage behavior, not IAM permissions or signed URLs.

Current deployment docs and IAM manifests also retain old claims for Task 12, outside this focused source-code fix.

### Self-review

- Children remain non-blocking.
- The startup observer is installed before passive effects and before the first async cutover operation.
- The buffer is UID-local and process-local, stores only emitted allowlisted serializer mutations, and never snapshots wholesale Zustand or localStorage state.
- Failed cutover and current engine-start failure retain capture coverage for retry.
- Stop, cancellation, account change, and sign-out stop the buffer.
- Startup mutations pass through the normal outbound validator, payload limit, content hash, local-origin, outbox, coalescing, and 60-second send path.
- Cache hydration begins only after all currently buffered mutations are durable.
- Open builds and direct Firebase browser Storage configuration remain unchanged.
- Task 12 security-audit and documentation behavior was not rewritten early.

### Concerns

None.
