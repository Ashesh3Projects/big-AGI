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

## Fix round 5

### Finding addressed

Failed startup mutation recovery was owned only by one engine instance. Ordinary same-UID stop cleared the failed entry and its dirty local origin, so a replacement engine could hydrate cached state over the unpersisted local edit before Retry.

### Design

- The UID-scoped startup buffer now owns bounded failed entries by canonical record key alongside active and frozen startup state.
- Ordinary engine stop retains failed entries in that buffer. A replacement engine imports them before cache hydration and reconstructs a dirty origin with no durable generation or mutation identity.
- A newer live mutation removes the retained failure for its key. Successful or superseded conditional retry resolves the retained entry and prunes its version when no active, frozen, or failed state remains.
- Confirmed sign-out and cross-UID destructive cleanup clear the old UID recovery owner. Ordinary same-UID release preserves it for remount.

### RED evidence

- The startup buffer had no failed-entry persistence API, so ordinary stop could not retain recovery state for another engine.
- A real reconciler and IndexedDB remount regression showed the second engine started with an empty fresh startup batch and no retained dirty protection.

### GREEN evidence

- The same-UID remount regression proves cached state is not applied, the retained failure is rehydrated, and conditional Retry resolves it.
- The destructive-clear regression proves ordinary stop preserves the failure while explicit clear removes failed and version state.
- Final provider, engine, outbound, DB, reconciler, persistence, and cutover suite: 221 passed, 0 failed.
- `npm run tscheck`, `npm run lint`, and `git diff --check`: exit 0.

### Concerns

None.

## Fix round 4

Round 4 supersedes the round-3 recovery mechanism described below.

### Findings addressed

- A rejected frozen startup capture still rejected engine startup. Lifecycle cleanup then stopped outbound and could abort unrelated post-close edits that were already queued.
- Failed startup recovery used separate generation reads followed by a later ordinary capture. A sibling or same-UID writer could advance the durable generation between those operations and then be overwritten by the stale retry.
- Baseline generation promises had no rejection handler in their observation turn. Version entries also accumulated for ordinary post-startup mutations.
- Round-3 recovery status could be overwritten by the lifecycle wrapper after engine start resolved.

### Design

- The engine invokes every frozen capture synchronously, awaits the complete `Promise.allSettled` barrier, records each unchanged failure in a bounded map keyed by canonical record key, and continues to cache hydration and listeners. Failed origins remain dirty and protected. Startup no longer rejects because one frozen capture failed.
- Retry processes only failed entries whose settled baseline is known. It uses outbound validation, canonical serialization, hashing, and local-origin hooks, then calls a DB-atomic conditional put or delete.
- The conditional DB transaction reads the retained generation counter, local row, outbox row, and remote base in the same transaction. It allocates and writes only when the effective current generation exactly equals the startup baseline. Otherwise it returns `superseded` without mutation.
- A superseded conditional attempt removes only its own temporary local origin. A newer live origin remains authoritative.
- Startup baseline reads attach fulfillment and rejection handlers immediately and store `{ ok: true, value }` or `{ ok: false }`. Unknown baselines remain retained but are not retried automatically.
- The startup buffer allocates versions only while observing active startup mutations. Successful entries, conditional completions, live supersession, and stop prune version and failed state. Ordinary post-startup mutations do not allocate version entries.
- The lifecycle clears stale status before engine start and preserves any fresh sanitized error or offline status reported during startup.

### RED evidence

- Startup-buffer regressions failed because settled baseline results and bounded state probes did not exist; the rejected baseline also emitted an `unhandledRejection` after the test ended.
- DB regressions failed because conditional put/delete and retained-generation baseline APIs did not exist.
- Outbound regressions failed because `captureIfGeneration` did not exist.
- The lifecycle regression showed a fresh engine-reported `error` was overwritten with `local`.
- The sibling-write regression showed conditional retry needed to reject OLD after NEW committed following validation.
- The live-during-baseline regression showed the retry still enqueued a stale same-key conditional capture after the live edit had superseded it.

### GREEN evidence

- Final provider, engine, outbound, DB, reconciler, persistence, and cutover suite: 219 passed, 0 failed.
- `npm run tscheck`: exit 0 for root and tools TypeScript programs.
- `npm run lint`: exit 0 with no warnings.
- `git diff --check`: exit 0 with only repository line-ending notices.

### Self-review

- Frozen capture calls remain ordered and synchronous before the all-settled wait.
- One failed record cannot stop startup or abort unrelated queued live captures.
- A later live edit removes the failed entry before normal capture and owns the record origin.
- Conditional retry performs no generation allocation, local write, or outbox write after supersession.
- Same-tab edits queued after a conditional attempt still finish later and remain the final durable value.
- Sibling writes that commit after validation but before the conditional transaction win atomically.
- Baseline rejection has no process-level unhandled or rejection-handled event and never retries with an invented zero.
- Retained counters remain part of the baseline even when local and outbox rows are absent.
- Stop, sign-out, and UID cleanup still clear the bounded in-memory recovery state.
- Cross-UID transition, source deletion, cutover, Open-build behavior, and the 60-second outbound schedule remain unchanged.

### Concerns

None.

## Fix round 3

### Findings addressed

- Frozen startup mutations were awaited one at a time. A post-close live edit could therefore enter the normal outbound queue before a later frozen mutation, after which the later OLD capture could overwrite NEW.
- Failed startup replay restored a blind suffix. It did not prove that the buffered version or the durable local/outbox generation was still the one observed before replay.
- The cross-UID cleanup failure gate exposed only Retry, leaving no direct way to abandon the stuck account transition.

### Design

- `closeAndTake()` still closes and unsubscribes the startup buffer synchronously, but now returns entries carrying a record key, monotonically increasing per-key version, cloned mutation, and a durable-generation baseline started when that mutation was observed.
- After outbound starts, the engine invokes `outbound.capture()` for every frozen entry synchronously without an intervening await. The outbound capture queue therefore receives the complete frozen batch before any later serializer callback can append a post-close edit. The engine then awaits all capture promises together before cache hydration.
- Every normal post-close capture increments the same per-key version before entering outbound.
- A failed frozen entry is eligible for retry only when its version is unchanged, its baseline read succeeded, both current local and outbox generation reads succeeded, and neither durable generation advanced beyond the baseline. Version is checked again after the DB reads. Unknown state is never restored.
- Failed entries are considered independently. A newer live edit or durable generation for one key cannot be overwritten by an older failed frozen entry on the next retry.
- The cross-UID error screen now exposes Retry and Sign out. Sign out calls the raw Firebase sign-out dependency and attempts a full reload in `finally`; only generic transition/sign-out errors are rendered.

### RED evidence

- The ordering regression initially recorded only the first frozen capture before a post-close callback ran; the later frozen second record had not yet entered outbound.
- The versioned-buffer regression initially had no live-version API and accepted restoration of an old frozen value.
- A rejected durable-baseline read initially fell back to generation zero and restored without proof.
- A failed current-generation read initially replaced the original capture failure and could not make a conservative restore decision.
- A synchronous outbound capture throw initially stopped invocation before the later frozen entries reached the barrier.
- The cross-UID error screen initially rendered no Sign out action and had no raw Firebase sign-out/reload helper.

### GREEN evidence

- A real outbound plus IndexedDB regression delays validation of the first frozen record, emits NEW for the second record after buffer closure, and proves the second durable outbox row is NEW at generation 2.
- A forced frozen-capture failure regression proves the queued NEW edit becomes durable before startup rejects and a replacement-engine retry never replays OLD for the second record.
- Engine suite: 33 passed, 0 failed.
- Final persistence, provider, serializer, outbound, engine, DB, reconciler, cutover, and direct-asset suite: 244 passed, 0 failed.
- `npm run tscheck`: exit 0 for root and tools TypeScript programs.
- `npm run lint`: exit 0 with no warnings.
- `git diff --check`: exit 0 with only repository line-ending notices.

### Self-review

- All frozen capture calls are made in array order in one synchronous turn before `Promise.allSettled` yields; a synchronous throw is converted to a rejected promise so later entries are still invoked.
- The real outbound remains the single serialization point for validation, hashing, generation assignment, and DB writes.
- Cache hydration cannot begin until every frozen capture has fulfilled or rejected and conservative recovery has finished.
- A newer post-close edit invalidates the old entry by version; the later generation check independently protects against sibling-tab or already-durable advancement.
- Failed or unavailable baseline/current DB reads skip restoration and preserve the original capture failure.
- Stop/cancellation still prevents late restoration through the lifecycle epoch check.
- Transition error text contains no Firebase or cleanup exception detail.
- Reload is attempted even when raw Firebase sign-out rejects.

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
