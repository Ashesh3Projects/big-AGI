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
