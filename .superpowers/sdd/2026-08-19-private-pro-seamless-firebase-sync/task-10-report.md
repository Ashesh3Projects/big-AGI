# Task 10 report

## Status

Complete on `codex/private-pro-seamless-sync`.

## Carried Task 9 fixes

### Coordinator renewal liveness

- Fallback coordinator stop no longer awaits an arbitrary renewal promise.
- Stop clears polling and renewal timers, aborts the leader and Web Lock request, rotates in-memory lease identity, and initiates the exact fenced release immediately.
- Detached renewal and release work receive same-turn rejection handlers.
- Finite leadership, Web Lock, channel, and coordinator state cleanup always runs, including when the fenced release rejects.
- Late renewal results cannot restore ownership because stopped checks and the cleared fence/owner identity reject them.
- Regressions cover direct coordinator stop, engine stop, ordinary remount, confirmed sign-out, successor acquisition, late renewal, failed release cleanup, and preserved successful renewal behavior.

### Hydration CAS abort

- The engine lifecycle `AbortSignal` now reaches `assets.hydrate` and `putHydratedAssetIfCurrent`.
- The hydration CAS runs in an abort-aware Dexie transaction through settlement with guard and signal checks before the final `assets.put`.
- Abort during the final update hook rolls back the transaction and normalizes the result to `AbortError`.
- Regressions cover a direct final-CAS abort and the production-shaped sequence: hydration reaches the final put hook, `engine.stop()` aborts it, UID state clears, the old hook releases, and no asset row reappears.
- Existing hydration success and concurrent local-edit CAS fencing remain green.

## Firestore rules

- Browser account document reads and writes remain denied.
- V1 reads and lists require the same authenticated UID, `privatePro == true`, an integer matching epoch, and an active current account document. Legacy quota fields on the account document are tolerated.
- Only exact v1 `records`, `assets`, `mutationReceipts`, and `tombstones` document paths are authorized. Broad user and collection-group queries remain denied.
- Canonical documents require exact keys, valid type and identity bounds, integer positive schema/revision, URL-safe record IDs, UUID mutation/writer IDs, lowercase SHA-256, ASCII payload up to 786432 characters, and `updatedAt == request.time`.
- Record and asset collections enforce their distinct record type domains.
- Create is revision 1 from absence, live only, with a same-atomic-write exact receipt and no tombstone.
- Update is exactly old revision plus 1 with stable record type, logical ID, and schema version. Deleted canonical records cannot update or recreate.
- Put cannot coexist with a tombstone. Delete requires the empty payload hash, exact delete receipt, and exact tombstone in the same atomic write.
- Receipt and tombstone IDs match embedded mutation/record identities. Both are immutable after create.
- Canonical physical delete is forbidden.
- Legacy encrypted and former plaintext paths remain denied.

## Storage rules

- Only `users/{uid}/workspace-v1/assets/{assetId}/{original|thumb256}` is authorized.
- Current-account checks use the Firestore account document and matching claim epoch. App Check is not required in emulator rules.
- Object listing and arbitrary nested names remain denied.
- Create/update requires exact custom metadata keys `uid`, `assetId`, `kind`, and `sha256`, exact path identity, lowercase SHA-256, and manifest-enum MIME types.
- Original objects are bounded to 64 MiB. Thumbnails are bounded to 2 MiB and only JPEG/WebP.
- Current-account get and delete are allowed only at the two fixed object names.

## Transport integration

- Added `createPrivateProFirebaseSyncTransportWithFirestore` as a narrow modular Firestore builder for emulator contexts without App Check or the production singleton.
- The real emulator transport test uses two authenticated contexts for one UID with distinct writers and tears down both listeners and the rules environment.
- It verifies two chat-message records remain queryable, settings conflict resolution advances to revision 2, a tombstone blocks a stale put, and duplicate mutation returns the existing receipt without a new revision.

## TDD evidence

### RED

- Carried lifecycle run: 2 failures, exactly the never-settling coordinator stop and final hydration CAS abort regressions.
- Initial deny-all emulator run: 18 tests total, 9 passed and 8 failed before authorization. The failures were all valid current-UID Firestore/Storage operations and the real transport listener/write path. One test was not reached after its required valid setup was denied.
- Self-review added a failed-release cleanup regression. It failed because stop returned before channel and started-state cleanup. The fix now preserves cleanup and restart while returning the release failure.

### GREEN

- Firebase emulator suite: 18 passed, 0 failed, exit 0.
- Final focused lifecycle, provider, asset, engine, and transport matrix: 122 passed, 0 failed, exit 0.
- Root TypeScript: `npx tsc --noEmit --pretty`, exit 0.
- Scoped ESLint for `test/firebase` and all modified lifecycle/transport files: exit 0.
- `git diff --check`: exit 0 with only repository line-ending conversion warnings.

## Indexes

- Removed both legacy encrypted asset reservation indexes.
- V1 listeners are unfiltered collection listeners and require no composite indexes.

## Self-review

- Account rule validation reads required fields only and tolerates pre-reset quota extras.
- Rules authorize no account, legacy vault, former plaintext, broad prefix, nested object, or collection-group surface.
- Atomic links are bidirectional: canonical writes validate post-write receipt/tombstone state, and receipt/tombstone creates validate the resulting canonical.
- Successful concurrent transport transactions still work. Receipt immutability denies a second canonical attempting to reuse the first mutation ID.
- Coordinator cleanup is finite even when renewal never settles or fenced release rejects.
- Hydration cannot commit after lifecycle abort and UID clear.
- No payload, credential, token, attachment content, or raw service error is newly logged.
- Open/self-hosted behavior and existing Edge/provider routes are unchanged.

## Concerns

- Firestore Rules `string.size()` counts characters, not bytes. The rules require ASCII first, so character count equals byte count for accepted payloads, satisfying the 786432-byte bound.
- Expected negative Firestore emulator assertions emit verbose permission-denied and evaluation-error diagnostics when malformed documents omit fields. The assertions pass and no invalid operation is authorized.

## Fix round 1

### Findings addressed

- Coordinator lifecycle work is now fenced by a monotonically increasing generation captured by start, fallback acquire, renewal, leader execution, timers, and Web Lock callbacks.
- Stop increments the generation synchronously, marks the coordinator stopped, clears timers, channel, leader state, lease identity, and task references, aborts owned controllers, and detaches all remaining work with same-turn rejection handlers.
- Stop does not wait for leader callbacks, fenced release, fallback acquire, renewal, Web Lock requests, or leadership promises. Late acquire releases its stale lease best-effort and late callbacks cannot alter the restarted generation, owner, leader state, timers, or failure state.
- Receipt creation now proves a real canonical transition from pre-state to post-state: absent to revision 1 live put, or existing live canonical to exact next revision with stable identity. Resulting canonical identity, mutation, revision, writer, timestamp, and content link must match.
- Delete receipts additionally require the exact tombstone in the same atomic write. Tombstone creation requires an existing live canonical, an exact next deleted revision with stable identity and request timestamp, plus the exact receipt after the write.
- Receipt-only creation against an unchanged orphan canonical and tombstone-only recreation against an unchanged deleted canonical are denied.
- Receipt `schemaVersion` must be an integer exactly equal to 1.
- Record keys now require the exact codec family prefix and encoded length for all nine record types. This is structural validation only and is not represented as logical-ID digest verification.
- Firestore payloads allow only printable ASCII (`0x20` through `0x7e`). Canonical JSON backslash escapes remain printable while raw C0 controls, newlines, tabs, carriage returns, and NUL are denied.
- The deployment guide and rules comments state the actual trust boundary: Rules do not recompute SHA-256 or the record-key digest. The transport validates schemas/collection identity, and the reconciler recomputes the full key and content hash, enforces canonical JSON, and quarantines invalid remote records without payload retention.
- Storage tests explicitly preserve zero-byte originals and valid strict-shape metadata replacement on object update as protocol decisions.
- The real emulator transport settings-conflict case is deterministic: client A creates revision 1, client B observes a conflict and retries revision 2. This avoids offline transaction contention masking the rules result.

### TDD evidence

RED:

- Coordinator tests hung before the redesign because stop awaited never-settling leader, release, acquire, renewal, and Web Lock work.
- Emulator rules initially failed 3 cases: tombstone-only creation succeeded, a settings document with a persona-family record key succeeded, and raw-control payloads succeeded.
- The receipt-only test was corrected to use a rules-disabled orphan canonical, separating the companion-transition finding from existing receipt immutability.

GREEN:

- Coordinator focused suite: 20 passed, 0 failed.
- Firebase emulator suite: 23 passed, 0 failed.
- Focused coordinator, provider lifecycle, engine, reconciler, Firebase transport, and direct asset matrix: 155 passed, 0 failed.
- Root TypeScript: exit 0.
- Scoped ESLint for modified TypeScript and Firebase tests: exit 0.
- Diff check: exit 0 with only repository line-ending conversion warnings.

### Self-review

- Every asynchronous coordinator continuation checks its captured generation before changing shared state or reporting a failure.
- A delayed Web Lock callback from a stopped generation cannot lead after restart; the current generation callback still leads normally.
- Stop clears the current generation before initiating exact fenced release, and neither release failure nor non-settlement can block remount or sign-out.
- All nine valid record families pass the exact prefix/length matrix. Wrong family prefixes and wrong lengths fail.
- Companion documents can no longer be manufactured beside unchanged canonical state.
- Wrong-hash and independently noncanonical remote payloads each quarantine as `invalid-payload`.

### Concerns

- Detached coordinator release/acquire/leader failures after stop are intentionally not returned to the stopped generation. Finite cleanup and stale-generation isolation take priority; same-turn rejection handlers prevent unhandled rejections.
- Firebase emulator negative assertions continue to print expected permission/evaluation diagnostics for malformed documents.

## Fix round 2

### Findings addressed

- Stop now marks the active generation as stopping before aborting controllers and clearing timers. The stopping generation cannot start or mutate leadership state, but its already-settled promise failures remain reportable.
- Stop yields exactly one microtask checkpoint, snapshots any failure recorded for that stopping generation, then increments the generation, clears state, detaches all unbounded collaborators and releases, closes the channel, and returns or throws the snapshot.
- Leader and acquire rejections settled immediately before stop are returned. Rejections after the checkpoint and generation invalidation are ignored and cannot affect restart.
- Never-settling leader, release, Web Lock, acquire, renewal, and leadership work remain bounded by the single microtask checkpoint only.
- Record-key structural validation now uses the exact fixed Base64URL boundary-bit classes and total lengths for every record family.
- Every partial boundary family rejects a mutated character outside its class. The model-service `...AQ` probe is denied. Settings and asset retain an unrestricted next digest character because their type-plus-NUL prefix ends on a complete Base64 group.

### TDD evidence

RED:

- The pre-stop leader rejection and acquire rejection tests both failed because stop invalidated the generation before their already-scheduled rejection handlers could record the error.
- Round 1 prefix-only regexes admitted boundary characters outside the fixed codec bit classes.

GREEN:

- Coordinator focused suite: 23 passed, 0 failed.
- Firebase emulator suite: 25 passed, 0 failed.
- Focused coordinator, provider lifecycle, engine, reconciler, Firebase transport, and direct asset matrix: 158 passed, 0 failed.
- Root TypeScript: exit 0.
- Scoped ESLint: exit 0.
- Diff check: exit 0 with only repository line-ending conversion warnings.

### Self-review

- The stopping generation is failure-reportable for one microtask only and is never leadership-active during that window.
- Snapshotting happens before generation invalidation; all later callbacks see a stale generation.
- Exact regexes match the provided verified codec boundaries without claiming logical-ID digest verification.

## Fix round 3

### Findings addressed

- Coordinator cancellation filtering now uses the shared `isAbortErrorLike` classifier from `errorUtils` instead of a local DOMException-only check.
- Expected stop-checkpoint cancellation includes DOMException AbortError, ordinary `Error` values named `AbortError`, and recursively nested `cause` or `error` abort values.
- Genuine non-abort leader and acquire rejections settled before stop remain reportable and are returned by stop.

### TDD evidence

RED:

- An `Error` named `AbortError` and an error containing a nested abort cause were both incorrectly returned by stop under the DOMException-only classifier.

GREEN:

- Coordinator focused suite: 25 passed, 0 failed.
- Focused coordinator, provider lifecycle, engine, reconciler, Firebase transport, and direct asset matrix: 160 passed, 0 failed.
- Root TypeScript: exit 0.
- Scoped ESLint: exit 0.
- Diff check: exit 0 with only repository line-ending conversion warnings.

### Self-review

- The shared classifier is already the application-wide cancellation definition and recursively handles `cause` and `error` wrappers.
- Existing immediate genuine failure tests prevent cancellation filtering from swallowing unrelated pre-stop failures.
