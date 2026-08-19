# Task 8 report

## Result

DONE

## Files

Created:

- `src/modules/private-pro/assets/privatePro.assets.schemas.ts`
- `src/modules/private-pro/assets/privatePro.assets.local.ts`
- `src/modules/private-pro/assets/privatePro.assets.client.ts`
- `src/modules/private-pro/assets/privatePro.assets.client.test.ts`
- `src/modules/private-pro/sync/serializers/asset.ts`

Modified:

- `src/modules/dblobs/dblobs.db.ts`
- `src/modules/dblobs/dblobs.private-pro.test.ts`
- `src/modules/private-pro/sync/privatePro.sync.db.ts`
- `src/modules/private-pro/sync/privatePro.sync.db.test.ts`
- `src/modules/private-pro/sync/privatePro.sync.outbound.ts`
- `src/modules/private-pro/sync/privatePro.sync.outbound.test.ts`
- `src/modules/private-pro/sync/privatePro.sync.serializers.ts`
- `src/modules/private-pro/sync/privatePro.sync.serializers.test.ts`
- `src/modules/private-pro/sync/privatePro.sync.reconcile.ts`
- `src/modules/private-pro/sync/privatePro.sync.engine.ts`
- `src/modules/private-pro/sync/privatePro.sync.engine.test.ts`

## Manifest contract

- Strict Zod discriminated union for image and audio DBlobs.
- Stores UID, asset ID, type, context, scope, label, explicit ISO dates, allowlisted origin, allowlisted metadata, and original/optional thumbnail descriptors.
- Each object descriptor contains only fixed object ID/kind, MIME, byte size, and SHA-256.
- Fixed Storage paths are constructed internally as `users/{uid}/workspace-v1/assets/{assetId}/original` and `users/{uid}/workspace-v1/assets/{assetId}/thumb256`.
- No caller-supplied bucket or path is accepted.
- Hydration validates manifest UID/asset ID, Storage custom metadata, MIME, byte size, and SHA-256 before writing the DBlob.

## DB and schema changes

- Extended the existing UID/asset ID sync DB row with exact structured-cloneable DBlob state, validated manifest, upload state, hydration state, and update time.
- Added a UID-scoped local port for DBlob and manifest CRUD.
- DBlob CRUD delegates only while the new asset-specific Private Pro persistence port is active. Open builds retain the existing `Big-AGI` Dexie table.
- Account switching changes the activation generation and cannot expose another UID namespace.

## Ordering and readiness

- Due asset manifest rows sort before all other due record types.
- Outbound uploads referenced bytes first.
- Non-asset rows with references defer until every asset manifest record has a live acknowledged remote revision.
- Deferred rows release their fenced lease and move to a one-second readiness recheck, preventing a tight drain loop while preserving the original 60-second capture window.
- Remote projection commits trigger abortable background hydration. Hydration failures report only a sanitized retryable category and do not block projection or unrelated records.

## TDD evidence

RED:

- Initial DBlob and direct asset command: 2 test files failed, 0 passed, exit 1, because the local port and direct client modules did not exist.
- DB/outbound/serializer command: 3 failures, 54 passed, exit 1, for the missing asset serializer, missing readiness DB seam, and a referencing row writing before acknowledgement.
- TypeScript first run: 2 errors, exit 1, for the Firebase metadata type and Web Crypto BufferSource input.

GREEN:

- Final DBlob, asset, DB, outbound, serializer, and engine suites: 91 tests, 5 suites, 91 passed, 0 failed, exit 0.
- TypeScript: `npx tsc --noEmit --pretty`, exit 0.
- Scoped ESLint for modified asset, sync, and DBlob source: exit 0.
- `git diff --check`: exit 0 with only repository line-ending conversion warnings.

## Self-review

- Storage bytes, base64, origins, and metadata are never logged.
- Uploads use browser `atob`/`btoa` conversion and no production `Buffer` dependency.
- Manifest visibility follows successful completion of every required object upload.
- Object deletion attempts both fixed paths and treats Firebase object-not-found as idempotent success.
- Hydration preserves Dates, nested origin parameters, metadata, scope, context, original MIME/base64, and optional thumbnail.
- Local user edits clear the prior manifest so changed bytes cannot reuse stale acknowledged metadata.
- The old encrypted-persistence switch is no longer consulted by DBlob CRUD.
- Engine stop aborts background hydration and does not wait indefinitely for Storage.

## Concerns

None.

## Fix round 1

### Findings addressed

- All active DBlob reads, writes, updates, deletes, clear, queries, and GC now route through one activation lease. Account switches abort the lease, and local-port Dexie transactions recheck it before committing so stale UID operations reject with `AbortError` without mutating the old namespace.
- Asset rows now carry monotonic `contentGeneration`, `publishedContentGeneration`, and `publishedManifestHash`. User writes increment generation and clear publication identity. Hydration preserves the remote generation without emitting a user mutation.
- Upload snapshots exact asset content and generation, validates and bounds the manifest before Storage, uploads deterministic objects, then atomically publishes only if the generation is still current. Late uploads cannot overwrite newer content or manifests.
- Asset readiness now requires a current published manifest/hash, no asset outbox row, a matching live local sync content hash, and the matching acknowledged remote revision. Synthetic acknowledgement updates the same durable state used by readiness.
- Active persistence registration accepts the canonical asset delete callback. DBlob delete and GC remove the manifest first, enqueue the serializer tombstone, remove local bytes, then attempt both fixed Storage objects without recursion.
- Firebase Storage errors are converted at the client boundary to fixed sync categories. Permission and quota failures block outbound rows, while aborts and schema errors preserve their original types.
- Manifest strings, parameter depth/count/key/value sizes, tag count, and overall canonical sync payload are bounded before any Storage operation.

### RED evidence

- DBlob/asset/DB RED suite: 11 failures, 40 passed, exit 1. Failures covered delayed UID read/write/update/delete/GC races, edit-during-upload publication, oversized pre-upload validation, Storage category mapping, and current-manifest readiness.
- Additional canonical delete and GC tests initially exposed shared test data in the UID namespace, then passed after isolating the target asset.

### GREEN evidence

- Final DBlob, asset, DB, outbound, serializer, and engine suites: 106 tests, 5 suites, 106 passed, 0 failed, exit 0.
- TypeScript: `npx tsc --noEmit --pretty`, exit 0.
- Scoped ESLint for modified asset, sync, and DBlob source: exit 0.
- `git diff --check`: exit 0 with only repository line-ending conversion warnings.

### Self-review

- Open-build Dexie branches remain unchanged when no Private Pro asset activation exists.
- Local content changes cannot reuse an old remote revision or manifest hash.
- Blocked, pending, or delete asset outbox rows all keep references unready.
- Storage cleanup errors expose only sanitized client errors and never object paths or content.
- Background hydration and exact deterministic Storage paths remain intact.
- The 60-second normal outbox window and fenced leases remain unchanged.

### Concerns

None.
