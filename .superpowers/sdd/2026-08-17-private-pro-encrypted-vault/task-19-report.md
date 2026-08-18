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
- Removed the obsolete legacy `assets` and `quotaReservations` indexes.
- Retained only the two Task 17 `assetReservations` composite indexes:
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
- Main checkout `F:\Projects\big-agi` remained clean on branch `pro`.

## Cloud boundary

No Firebase rules, indexes, Storage configuration, or application build was deployed. No cloud resource was mutated.
