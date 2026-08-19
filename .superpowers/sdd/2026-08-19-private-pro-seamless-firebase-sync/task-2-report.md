# Task 2 report

## Implementation

- Added the plaintext serializer interfaces, prepared-record shape, local mutation shape, projection shape, and `createPrivateProSyncSerializers(extraSerializers?)` registry.
- Moved the six non-chat portable serializer implementations into `sync/serializers` with their existing Zod allowlists and store APIs intact.
- Added narrow vault compatibility re-exports so the current encrypted vault continues compiling and its existing serializer regression continues to run.
- Added split chat metadata and message serializers with stable message logical IDs and a message-identity conflict policy.
- Added chat projection staging. Message-first delivery remains staged without a placeholder conversation. Metadata materializes the conversation. Same-timestamp messages sort by ID. Replacing a projection removes absent messages.
- Added chat store helpers for metadata/message application, message removal, deterministic materialization, and deterministic token-count summing.
- The asset serializer is intentionally absent. The registry accepts later `extraSerializers` from Task 8.

## RED evidence

Command:

```powershell
npx tsx --test src/modules/private-pro/sync/privatePro.sync.serializers.test.ts
```

Output excerpt:

```text
Error: Cannot find module './privatePro.sync.serializers'
pass 0
fail 1
```

The test failed because the requested plaintext serializer registry did not exist.

## GREEN evidence

Commands:

```powershell
npx tsx --test src/modules/private-pro/sync/privatePro.sync.protocol.test.ts src/modules/private-pro/sync/privatePro.sync.serializers.test.ts
npx tsx --test src/modules/private-pro/vault/privatePro.vault.serializers.test.ts
npx tsc --noEmit --pretty
npx eslint src/modules/private-pro/sync src/common/stores/chat/store-chats.ts
git diff --check
```

Results:

```text
sync protocol plus serializer tests: 16 passed, 0 failed
legacy vault serializer test: 1 passed, 0 failed
TypeScript: exit 0
ESLint: exit 0
git diff check: exit 0
```

## Files

- Created `src/modules/private-pro/sync/privatePro.sync.serializers.ts`
- Created `src/modules/private-pro/sync/privatePro.sync.serializers.test.ts`
- Created `src/modules/private-pro/sync/serializers/chat.ts`
- Moved portable non-chat serializers into `src/modules/private-pro/sync/serializers/`
- Added narrow compatibility re-exports under `src/modules/private-pro/vault/serializers/`
- Modified `src/common/stores/chat/store-chats.ts`

## Self-review

- Chat metadata and messages use one projection key per conversation.
- Metadata deletion removes the rendered conversation. Message deletion rematerializes the remaining messages.
- Materialization uses `_abortController: null`, sorts by `(created, id)`, and sums stored `tokenCount` values rather than recalculating them against a local model.
- Serializer change detection uses canonical JSON, not insertion-order-dependent JSON serialization.
- No Firebase, revision, mutation ID, device, or encryption dependency is present in serializer interfaces.
- No dev server was started or stopped. No branch was pushed or stashed.

## Concerns

- The vault compatibility files contain narrow type boundary casts until Task 11 removes the encrypted vault. The legacy serializer test and `tsc` cover this temporary bridge.
- Git emits the repository's existing Windows LF-to-CRLF notices when inspecting staged files. The diff check passed.
