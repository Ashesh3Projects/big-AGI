# Private Pro Seamless Firebase Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the encrypted Private Pro vault with a destructive-greenfield, local-first, per-account Firebase workspace that synchronizes plaintext portable state and attachments without vault ceremony or routine conflict prompts.

**Architecture:** Google/Firebase authentication and the approved-email bootstrap remain the only opening gate. Portable Big-AGI stores stay in-memory UI authorities while a UID-scoped Dexie database persists local record projections and a 60-second coalescing outbox. One tab coordinates direct Firestore transactions and realtime listeners; Firebase Storage handles resumable attachment objects. Generation-aware acknowledgements never reapply sent snapshots, and chat metadata plus stable per-message records converge independently.

**Tech Stack:** Next.js 15, React 18, TypeScript 6, Zustand 5, Dexie 4, Firebase Web SDK 12.17.1, Firebase Admin SDK 13.10.0 for account administration only, Firebase App Check, Firebase Emulator Suite 15.27.0, Node test runner through `tsx`.

**Spec:** `docs/superpowers/specs/2026-08-19-private-pro-seamless-firebase-sync-design.md`

## Global Constraints

- Work only on branch `pro`.
- Never push any branch. The user manages remote Git writes.
- Never run `git stash`.
- Never start or stop a development server.
- Use normal hyphens, never em dashes, in prose, code comments, and UI copy.
- Preserve the Open/self-hosted build when `NEXT_PUBLIC_PRIVATE_PRO_ENABLED !== 'true'`.
- Keep existing Edge AI routes and provider behavior unchanged.
- Keep Firebase Admin imports out of browser and Edge bundles.
- Every approved Google account owns exactly one isolated workspace. There is no cross-account sharing.
- Treat every existing encrypted or plaintext Private Pro workspace, attachment, local vault cache, keyset, device record, and backup as disposable.
- Store synchronized workspace payloads and provider credentials as server-readable plaintext. Never log them to console, analytics, Sentry, audit output, or user-visible error details.
- Use direct authenticated Firestore and Storage browser access only below the versioned v1 UID paths.
- Use an application-owned durable outbox. Do not enable Firestore durable disk persistence or allow Firestore SDK latency compensation to become the product outbox.
- Open the app immediately after authentication bootstrap. Local cache hydration and remote catch-up must not replace the app with a blocking screen.
- Coalesce normal writes per record for 60,000 ms. A sign-out drain is the only permitted earlier flush.
- Never acknowledge a write by applying its sent snapshot to a runtime store.
- Never retry a stale put across a deletion tombstone.
- Do not upload incognito chats or incomplete messages.
- Use explicit Zod schemas and serializer allowlists. Never serialize Zustand state or `localStorage` wholesale.
- Run `tsc --noEmit --pretty`, `npm run lint`, focused tests, the full test suite, Firebase Emulator tests, and a production build before completion.

Official Firebase behavior relied on by this plan:

- Firestore transactions: `https://firebase.google.com/docs/firestore/manage-data/transactions`
- Firestore listener metadata and `hasPendingWrites`: `https://firebase.google.com/docs/firestore/query-data/listen#view_changes_between_snapshots`
- Resumable web uploads: `https://firebase.google.com/docs/storage/web/upload-files#upload_files_with_cloud_storage_on_web`
- App Check enforcement: `https://firebase.google.com/docs/app-check/enable-enforcement`

---

## File structure

### Sync protocol and serialization

- `src/modules/private-pro/sync/privatePro.sync.schemas.ts`: v1 record types, wire schemas, payload limits, mutation receipts, and tombstones.
- `src/modules/private-pro/sync/privatePro.sync.codec.ts`: deterministic record keys, ASCII canonical JSON, SHA-256 hashes, and payload byte checks.
- `src/modules/private-pro/sync/privatePro.sync.serialize.ts`: chat metadata/message parsing and existing conversation compatibility helpers.
- `src/modules/private-pro/sync/privatePro.sync.protocol.test.ts`: protocol, codec, record identity, size, and chat-split tests.
- `src/modules/private-pro/sync/privatePro.sync.serializers.ts`: serializer/projection interfaces and registry.
- `src/modules/private-pro/sync/serializers/chat.ts`: `chat-meta` and `chat-message` snapshots plus whole-conversation projection.
- `src/modules/private-pro/sync/serializers/models.ts`: credential-service and model-service records.
- `src/modules/private-pro/sync/serializers/settings.ts`: narrow settings records.
- `src/modules/private-pro/sync/serializers/persona.ts`: persona records.
- `src/modules/private-pro/sync/serializers/folder.ts`: folder records.
- `src/modules/private-pro/sync/serializers/scratch.ts`: Scratch records.
- `src/modules/private-pro/sync/serializers/asset.ts`: asset manifest records stored in the dedicated asset collection.
- `src/modules/private-pro/sync/privatePro.sync.serializers.test.ts`: serializer coverage, exclusions, projection ordering, and echo suppression.

### Durable local synchronization

- `src/modules/private-pro/sync/privatePro.sync.db.ts`: UID-scoped local records, remote bases, one-row-per-record outbox, quarantine, assets, and coordinator leases.
- `src/modules/private-pro/sync/privatePro.sync.db.test.ts`: fake IndexedDB tests for coalescing, generations, acknowledgement, clearing, and leases.
- `src/modules/private-pro/sync/privatePro.sync.coordinator.ts`: Web Lock leadership, `BroadcastChannel` wakeups, and fenced IndexedDB fallback.
- `src/modules/private-pro/sync/privatePro.sync.coordinator.test.ts`: leader election and failover tests.
- `src/modules/private-pro/sync/privatePro.sync.outbound.ts`: mutation capture, 60-second scheduling, retry, conflict rebase, and acknowledgement.
- `src/modules/private-pro/sync/privatePro.sync.outbound.test.ts`: fake-clock outbound state-machine tests.
- `src/modules/private-pro/sync/privatePro.sync.reconcile.ts`: remote validation, local cache hydration, projection materialization, deletion handling, and quarantine.
- `src/modules/private-pro/sync/privatePro.sync.reconcile.test.ts`: remote ordering, tombstone, invalid record, and chat merge tests.
- `src/modules/private-pro/sync/privatePro.sync.engine.ts`: lifecycle orchestration across serializers, DB, coordinator, transport, assets, and status.
- `src/modules/private-pro/sync/privatePro.sync.engine.test.ts`: offline/reconnect and two-client orchestration tests.

### Firebase browser transport

- `src/modules/private-pro/sync/privatePro.sync.transport.ts`: transport interface and Firestore result types.
- `src/modules/private-pro/sync/privatePro.sync.firebase.ts`: direct Firestore transactions, receipts, listeners, and record/tombstone parsing.
- `src/modules/private-pro/sync/privatePro.sync.firebase.test.ts`: injected Firestore-port transaction and listener tests.
- `src/modules/private-pro/firebase/firebase.client.ts`: initialize App Check before explicit memory-only Firestore and Storage clients.

### Attachments

- `src/modules/private-pro/assets/privatePro.assets.schemas.ts`: plaintext asset manifest and Storage object metadata schemas.
- `src/modules/private-pro/assets/privatePro.assets.local.ts`: UID-scoped local DBlob persistence backed by the sync DB.
- `src/modules/private-pro/assets/privatePro.assets.client.ts`: direct resumable upload, authenticated download, delete, hashing, and retry.
- `src/modules/private-pro/assets/privatePro.assets.client.test.ts`: fake Storage tests for upload, resume, hydration, and deletion.
- `src/modules/dblobs/dblobs.db.ts`: delegate Private Pro DBlob persistence to the active UID-scoped asset port.
- `src/modules/dblobs/dblobs.private-pro.test.ts`: account isolation and durable DBlob behavior.

### React integration and UI

- `src/modules/private-pro/sync/ProviderPrivateProSync.tsx`: non-blocking engine lifecycle and sign-out coordination.
- `src/modules/private-pro/sync/store-private-pro-sync.ts`: compact `local | syncing | synced | offline | error` state.
- `src/modules/private-pro/ui/PrivateProSyncStatus.tsx`: compact sanitized status copy.
- `src/modules/private-pro/ui/PrivateProAccountControl.tsx`: account, sync state, retry, and sign-out only.
- `src/modules/private-pro/persistence/privatePro.persistence.ts`: managed volatile runtime persistence, activation, clearing, and old-cache cleanup helpers.
- `src/modules/private-pro/persistence/privatePro.persistence.test.ts`: runtime persistence and destructive local cutover tests.
- `src/common/providers/single-tab/ProviderSingleTab.tsx`: disable the global single-tab gate only for Private Pro.
- `pages/_app.tsx`: mount `ProviderPrivateProSync` instead of `ProviderPrivateProVault`.
- `src/modules/private-pro/auth/privatePro.auth.client.ts`: remove vault device headers.
- `src/modules/private-pro/auth/privatePro.auth.procedures.server.ts`: retain bootstrap/current-account procedures and remove vault-device middleware.
- `src/modules/private-pro/auth/privatePro.auth.service.ts`: remove attachment quota counters from account/bootstrap types.
- `src/modules/private-pro/auth/privatePro.auth.service.test.ts`: retain allowlist/claim/epoch coverage without quota fixtures.
- `src/modules/private-pro/auth/privatePro.auth.router.ts`: bootstrap only UID, email, and access epoch.
- `src/modules/private-pro/config/privatePro.config.server.ts`: remove the attachment quota setting.
- `src/server/env.server.ts`: remove `PRIVATE_PRO_ATTACHMENT_QUOTA_BYTES` validation.
- `src/server/trpc/trpc.server.ts`: stop parsing `x-private-pro-device-id` into context.
- `tools/private-pro/manage-access.ts`: stop creating or refreshing quota counters.
- `tools/private-pro/manage-access.test.ts`: assert access management preserves only identity/epoch/account activity state.

### Firebase resources and rollout

- `firestore.rules`: current-account reads and transactional v1 record/receipt/tombstone writes.
- `storage.rules`: current-account direct object read/write/delete below `workspace-v1`.
- `firestore.indexes.json`: remove encrypted reservation indexes and add only queries used by v1.
- `test/firebase/private-pro.rules.test.ts`: emulator rule and cross-account coverage.
- `test/firebase/private-pro.sync.test.ts`: two authenticated emulator clients using the real browser transport.
- `tools/private-pro/reset-workspaces.ts`: dry-run-first destructive cloud reset preserving Auth identities and account documents.
- `tools/private-pro/reset-workspaces.test.ts`: pure reset-plan and confirmation tests.
- `tools/private-pro/security-audit.ts`: direct Firebase browser API targets and anonymous-denial audit language.
- `tools/private-pro/security-audit.test.ts`: revised browser-key, rules, and CORS expectations.
- `infra/private-pro/firebase-origin-restrictions.md`: exact direct-Firebase browser key and CORS policy.
- `infra/private-pro/gcp-runtime-role.yaml`: remove Storage and vault-only runtime permissions after server routes disappear.
- `docs/deploy-private-pro-firebase.md`: destructive cutover, rules, App Check, reset, and live verification.
- `docs/environment-variables.md`: remove vault/quota/cron settings that no longer exist.
- `tools/private-pro/dependency-security.test.ts`: remove crypto-only dependency expectations after uninstall.
- `tools/private-pro/src-import-boundaries.test.ts`: continue proving browser modules do not import Firebase Admin or deleted vault modules.

### Deletion targets after replacement coverage exists

- `src/modules/private-pro/vault/**`
- Vault-only components under `src/modules/private-pro/ui/`
- `src/modules/private-pro/assets/privatePro.assets.router.ts`
- `src/modules/private-pro/assets/privatePro.assets.service.ts`
- `src/modules/private-pro/assets/privatePro.assets.firebase.ts`
- Their encrypted tests and deployment assertions
- `src/modules/trade/privateProEncryptedBackup.ts`
- `src/modules/trade/privateProEncryptedBackup.test.ts`
- `app/api/private-pro/sweep-expired/**`
- Vault router registrations in `src/server/trpc/trpc.router-cloud.ts`
- The sole cron entry in `vercel.json`
- `hash-wasm` after a repository search proves no remaining caller

---

## Stage 1: Plaintext protocol and projections

### Task 1: Define the v1 record protocol and deterministic codec

**Files:**
- Modify: `src/modules/private-pro/config/privatePro.config.ts`
- Modify: `src/modules/private-pro/sync/privatePro.sync.schemas.ts`
- Create: `src/modules/private-pro/sync/privatePro.sync.codec.ts`
- Modify: `src/modules/private-pro/sync/privatePro.sync.serialize.ts`
- Test: `src/modules/private-pro/sync/privatePro.sync.protocol.test.ts`

**Interfaces:**
- Produces: `PrivateProSyncRecordType`
- Produces: `PrivateProSyncMutationKind`
- Produces: `PrivateProSyncRecordDocumentSchema`
- Produces: `PrivateProSyncTombstoneDocumentSchema`
- Produces: `PrivateProSyncMutationReceiptSchema`
- Produces: `privateProRecordKey(recordType: PrivateProSyncRecordType, logicalId: string): string`
- Produces: `privateProCanonicalJson(value: unknown): string`
- Produces: `privateProParseCanonicalJson<T>(payload: string, schema: z.ZodType<T>): T`
- Produces: `privateProContentHash(payload: string): Promise<string>`
- Produces constant: `PRIVATE_PRO_SYNC_WINDOW_MS = 60_000`
- Produces constant: `PRIVATE_PRO_SYNC_MAX_PAYLOAD_BYTES = 786_432`

- [ ] **Step 1: Replace the old whole-conversation protocol tests with failing v1 codec tests**

Add tests equivalent to:

```ts
test('builds a deterministic slash-free record key', () => {
  const key = privateProRecordKey('chat-message', 'chat/a\0message/b');
  assert.equal(key, privateProRecordKey('chat-message', 'chat/a\0message/b'));
  assert.doesNotMatch(key, /\//);
});

test('canonical JSON is ASCII and stable across object key order', () => {
  const left = privateProCanonicalJson({ z: 'cafe', a: '\u2603' });
  const right = privateProCanonicalJson({ a: '\u2603', z: 'cafe' });
  assert.equal(left, right);
  assert.match(left, /^[\x00-\x7f]*$/);
});

test('rejects payloads over the exact v1 bound', () => {
  const payload = `"${'a'.repeat(PRIVATE_PRO_SYNC_MAX_PAYLOAD_BYTES)}"`;
  assert.throws(() => assertPrivateProPayloadSize(payload), /too large/i);
});
```

Define test fixtures for all record families:

```ts
const recordTypes = [
  'credential-service', 'model-service', 'settings', 'persona', 'folder',
  'scratch', 'chat-meta', 'chat-message', 'asset',
] as const;
```

- [ ] **Step 2: Run the focused test and verify the missing codec failure**

Run:

```powershell
npx tsx --test src/modules/private-pro/sync/privatePro.sync.protocol.test.ts
```

Expected: FAIL because the v1 codec exports and schemas do not exist.

- [ ] **Step 3: Implement exact wire schemas**

Use these public shapes:

```ts
export type PrivateProSyncRecordType = z.infer<typeof PrivateProSyncRecordTypeSchema>;
export type PrivateProSyncMutationKind = 'put' | 'delete';

export interface PrivateProSyncRecordDocument {
  recordType: PrivateProSyncRecordType;
  logicalId: string;
  schemaVersion: number;
  payload: string;
  contentHash: string;
  revision: number;
  mutationId: string;
  writerId: string;
  deleted: boolean;
  updatedAt: unknown;
}

export interface PrivateProSyncTombstoneDocument {
  recordKey: string;
  recordType: PrivateProSyncRecordType;
  logicalId: string;
  deletedRevision: number;
  mutationId: string;
  writerId: string;
  deletedAt: unknown;
}
```

Use UUID validation for mutation and writer IDs, positive integers for revisions and schema versions, logical IDs of 1-512 UTF-16 code units, 64-character lowercase SHA-256 hashes, and an empty payload only when `deleted === true`.

- [ ] **Step 4: Implement canonical serialization and chat split schemas**

Move message fields out of `SyncConversationSchema` into:

```ts
export const SyncChatMetaSchema = z.object({
  conversationId: z.string().min(1),
  userTitle: z.string().optional(),
  autoTitle: z.string().optional(),
  isArchived: z.boolean().optional(),
  userSymbol: z.string().optional(),
  systemPurposeId: z.string().min(1),
  created: z.number(),
  updated: z.number().nullable(),
}).strict();

export const SyncChatMessageSchema = z.object({
  conversationId: z.string().min(1),
  message: SyncMessageSchema,
}).strict();
```

Sort reconstructed messages by `message.created`, then `message.id`. Do not include `_abortController`, generator metrics, incognito conversations, or `pendingIncomplete` messages.

- [ ] **Step 5: Run focused checks**

Run:

```powershell
npx tsx --test src/modules/private-pro/sync/privatePro.sync.protocol.test.ts
npx tsc --noEmit --pretty
npx eslint src/modules/private-pro/config/privatePro.config.ts src/modules/private-pro/sync/privatePro.sync.schemas.ts src/modules/private-pro/sync/privatePro.sync.codec.ts src/modules/private-pro/sync/privatePro.sync.serialize.ts src/modules/private-pro/sync/privatePro.sync.protocol.test.ts
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit the v1 protocol**

```powershell
git add src/modules/private-pro/config/privatePro.config.ts src/modules/private-pro/sync/privatePro.sync.schemas.ts src/modules/private-pro/sync/privatePro.sync.codec.ts src/modules/private-pro/sync/privatePro.sync.serialize.ts src/modules/private-pro/sync/privatePro.sync.protocol.test.ts
git commit -m "Cloud: define seamless sync protocol"
```

---

### Task 2: Move portable serializers into projection-based plaintext sync

**Files:**
- Create: `src/modules/private-pro/sync/privatePro.sync.serializers.ts`
- Create: `src/modules/private-pro/sync/serializers/chat.ts`
- Create: `src/modules/private-pro/sync/serializers/models.ts`
- Create: `src/modules/private-pro/sync/serializers/settings.ts`
- Create: `src/modules/private-pro/sync/serializers/persona.ts`
- Create: `src/modules/private-pro/sync/serializers/folder.ts`
- Create: `src/modules/private-pro/sync/serializers/scratch.ts`
- Modify: `src/common/stores/chat/store-chats.ts`
- Test: `src/modules/private-pro/sync/privatePro.sync.serializers.test.ts`

**Interfaces:**
- Consumes: v1 codec and schemas from Task 1.
- Produces: `PrivateProSyncLocalMutation`
- Produces: `PrivateProSyncSerializedRecord`
- Produces: `PrivateProSyncSerializer<T>`
- Produces: `PrivateProSyncProjection`
- Produces: `createPrivateProSyncSerializers(extraSerializers?: readonly PrivateProSyncSerializer<unknown>[]): readonly PrivateProSyncSerializer<unknown>[]`
- Produces chat store helpers: `chatSyncApplyMeta`, `chatSyncApplyMessage`, `chatSyncRemoveMessage`, and `chatSyncMaterialize`.

- [ ] **Step 1: Write failing serializer and projection tests**

Cover:

```ts
test('splits one conversation into one metadata record and finalized message records', async () => {
  const records = await snapshotChatRecords(conversationFixture());
  assert.deepEqual(records.map(record => record.recordType), ['chat-meta', 'chat-message', 'chat-message']);
});

test('materializes messages when listener delivery arrives before metadata', async () => {
  await projection.stage(messageRecord('chat-1', 'message-2', 20));
  assert.equal(chatSyncExists('chat-1'), false);
  await projection.stage(metaRecord('chat-1'));
  assert.deepEqual(chatSyncSnapshot()[0].messages.map(message => message.id), ['message-2']);
});

test('merges concurrent message IDs deterministically', async () => {
  await projection.stage(metaRecord('chat-1'));
  await projection.stage(messageRecord('chat-1', 'b', 10));
  await projection.stage(messageRecord('chat-1', 'a', 10));
  assert.deepEqual(chatSyncSnapshot()[0].messages.map(message => message.id), ['a', 'b']);
});
```

Also assert every existing vault serializer inclusion remains represented: credential services, model services, settings groups, personas, folders, and Scratch. Task 8 supplies the asset serializer through the `extraSerializers` argument after its concrete local port exists.

- [ ] **Step 2: Run the test and verify failure**

Run:

```powershell
npx tsx --test src/modules/private-pro/sync/privatePro.sync.serializers.test.ts
```

Expected: FAIL because the plaintext registry and chat projection helpers do not exist.

- [ ] **Step 3: Define the projection interfaces**

Use these signatures:

```ts
export interface PrivateProSyncSerializedRecord<T = unknown> {
  recordType: PrivateProSyncRecordType;
  logicalId: string;
  projectionKey: string;
  schemaVersion: number;
  value: T;
  referencedAssetIds: readonly string[];
}

export interface PrivateProSyncPreparedRecord {
  recordType: PrivateProSyncRecordType;
  logicalId: string;
  recordKey: string;
  projectionKey: string;
  schemaVersion: number;
  payload: string;
  contentHash: string;
  referencedAssetIds: readonly string[];
}

export type PrivateProSyncLocalMutation =
  | { kind: 'put'; record: PrivateProSyncSerializedRecord }
  | { kind: 'delete'; recordType: PrivateProSyncRecordType; logicalId: string; projectionKey: string; schemaVersion: number };

export interface PrivateProSyncSerializer<T> {
  recordType: PrivateProSyncRecordType;
  schemaVersion: number;
  conflictPolicy: 'replace' | 'message-identity';
  snapshot(): Promise<readonly PrivateProSyncSerializedRecord<T>[]>;
  validate(logicalId: string, value: unknown): Promise<T>;
  subscribe(listener: (mutation: PrivateProSyncLocalMutation) => void): () => void;
}

export interface PrivateProSyncProjection {
  apply(projectionKey: string, records: readonly PrivateProSyncSerializedRecord[]): Promise<void>;
  remove(projectionKey: string): Promise<void>;
}
```

All remote projection applications run under the engine's suppression scope. Serializers never know about Firestore, revisions, mutation IDs, encryption, or devices.

- [ ] **Step 4: Move and rename the existing logical serializers**

Use `git mv` for the six non-chat files from `vault/serializers` into `sync/serializers`, then remove vault naming and crypto-key dependencies. Preserve the current Zod projections and store APIs. Change exports from `privateProVault...Serializer` to `privateProSync...Serializer`.

- [ ] **Step 5: Implement chat projection helpers**

`chatSyncMaterialize(meta, messages)` must construct one `DConversation` with `_abortController: null`, messages sorted by `(created, id)`, and token count equal to the deterministic sum of stored message token counts. A message without metadata remains staged in local sync storage and does not create a placeholder conversation. Deleting metadata removes the conversation; deleting one message rematerializes the conversation without that message.

- [ ] **Step 6: Run focused checks**

Run:

```powershell
npx tsx --test src/modules/private-pro/sync/privatePro.sync.protocol.test.ts src/modules/private-pro/sync/privatePro.sync.serializers.test.ts
npx tsc --noEmit --pretty
npx eslint src/modules/private-pro/sync src/common/stores/chat/store-chats.ts
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit the serializer registry**

```powershell
git add src/modules/private-pro/sync src/common/stores/chat/store-chats.ts src/modules/private-pro/vault/serializers
git commit -m "Cloud: project portable sync records"
```

---

## Stage 2: Durable scheduling and direct Firestore

### Task 3: Build the UID-scoped local database and generation-safe outbox

**Files:**
- Create: `src/modules/private-pro/sync/privatePro.sync.db.ts`
- Test: `src/modules/private-pro/sync/privatePro.sync.db.test.ts`

**Interfaces:**
- Consumes: record types and serialized records from Tasks 1-2.
- Produces: `PrivateProSyncDB`
- Produces: `PrivateProLocalRecordState`
- Produces: `PrivateProOutboxState`
- Produces: `PrivateProRemoteBaseState`
- Produces: `PrivateProCoordinatorLease`
- Produces: `privateProSyncDB`
- Consumes: `PrivateProSyncPreparedRecord` from Task 2 after serializer values pass through the Task 1 codec.

- [ ] **Step 1: Write failing fake IndexedDB tests**

Test these exact invariants:

```ts
test('replaces payload and increments generation inside one 60-second window', async () => {
  await db.recordLocalPut(uid, first, 1_000);
  await db.recordLocalPut(uid, second, 2_000);
  const pending = await db.getOutbox(uid, second.recordKey);
  assert.equal(pending?.generation, 2);
  assert.equal(pending?.payload, second.payload);
  assert.equal(pending?.dueAtMs, 61_000);
});

test('acknowledges only the generation that was sent', async () => {
  const sent = await db.recordLocalPut(uid, first, 1_000);
  await db.recordLocalPut(uid, second, 2_000);
  await db.acknowledge(uid, sent.recordKey, sent.generation, remoteBase(1), 61_000);
  assert.equal((await db.getOutbox(uid, sent.recordKey))?.generation, 2);
});

test('clears only one UID namespace', async () => {
  await seedUid(db, 'uid-a');
  await seedUid(db, 'uid-b');
  await db.clearUid('uid-a');
  assert.equal((await db.listLocalRecords('uid-a')).length, 0);
  assert.notEqual((await db.listLocalRecords('uid-b')).length, 0);
});
```

- [ ] **Step 2: Run the DB test and verify failure**

Run:

```powershell
npx tsx --test src/modules/private-pro/sync/privatePro.sync.db.test.ts
```

Expected: FAIL because `PrivateProSyncDB` does not exist.

- [ ] **Step 3: Implement the v1 Dexie schema**

Use database name `private-pro-workspace-v1` and these tables:

```ts
localRecords: '[uid+recordKey], uid, recordType, projectionKey, generation, contentHash'
outbox: '[uid+recordKey], uid, dueAtMs, leaseUntilMs, blocked'
remoteBases: '[uid+recordKey], uid, revision, mutationId, deleted'
quarantine: '++id, uid, recordKey, createdAtMs'
assets: '[uid+assetId], uid, assetId, updatedAtMs'
leases: '[uid+name], uid, expiresAtMs, fence'
meta: '[uid+key], uid'
```

Keep exactly one outbox row per UID and record key. A later local edit replaces its payload and mutation ID but preserves the first edit's due time until a send occurs.

- [ ] **Step 4: Implement atomic mutation and acknowledgement methods**

Expose:

```ts
recordLocalPut(uid, record: PrivateProSyncPreparedRecord, nowMs): Promise<PrivateProOutboxState>
recordLocalDelete(uid, identity, nowMs): Promise<PrivateProOutboxState>
leaseDue(uid, nowMs, leaseMs): Promise<PrivateProOutboxState | null>
retry(uid, recordKey, generation, nowMs, delayMs, errorCode): Promise<void>
rebase(uid, recordKey, generation, remoteBase, nowMs): Promise<void>
acknowledge(uid, recordKey, sentGeneration, remoteBase, sentAtMs): Promise<void>
discardAcrossTombstone(uid, recordKey, remoteBase): Promise<void>
```

When a newer generation exists at acknowledgement time, update its base revision and enforce `dueAtMs >= sentAtMs + 60_000`; never delete or replace its payload.

- [ ] **Step 5: Run focused checks**

```powershell
npx tsx --test src/modules/private-pro/sync/privatePro.sync.db.test.ts
npx tsc --noEmit --pretty
npx eslint src/modules/private-pro/sync/privatePro.sync.db.ts src/modules/private-pro/sync/privatePro.sync.db.test.ts
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit durable sync state**

```powershell
git add src/modules/private-pro/sync/privatePro.sync.db.ts src/modules/private-pro/sync/privatePro.sync.db.test.ts
git commit -m "Cloud: persist seamless sync state"
```

---

### Task 4: Elect exactly one flush coordinator per UID

**Files:**
- Create: `src/modules/private-pro/sync/privatePro.sync.coordinator.ts`
- Test: `src/modules/private-pro/sync/privatePro.sync.coordinator.test.ts`

**Interfaces:**
- Consumes: coordinator lease methods from Task 3.
- Produces: `PrivateProSyncCoordinator`
- Produces: `createPrivateProSyncCoordinator(options)`

- [ ] **Step 1: Write failing leadership tests using injected ports**

Cover one Web Lock leader, follower wakeup, leader shutdown, fallback lease fencing, expired lease takeover, and a stale fenced owner being unable to renew.

Use this public contract:

```ts
export interface PrivateProSyncCoordinator {
  start(runLeader: (signal: AbortSignal) => Promise<void>): Promise<void>;
  wake(): void;
  stop(): Promise<void>;
  isLeader(): boolean;
}
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npx tsx --test src/modules/private-pro/sync/privatePro.sync.coordinator.test.ts`

Expected: FAIL because the coordinator module does not exist.

- [ ] **Step 3: Implement Web Lock leadership**

Request `private-pro-sync:${uid}` in exclusive mode and hold it until `stop()` aborts the leader lifetime. Followers use `BroadcastChannel('private-pro-sync:${uid}')` to send `wake` and `signed-out` messages. Never transfer record payloads through the channel.

- [ ] **Step 4: Implement the fenced IndexedDB fallback**

Use a 15,000 ms lease, renew every 5,000 ms, and increment a monotonically stored `fence` on takeover. Every fallback outbox lease records the current fence; a stale owner cannot acknowledge or retry after losing leadership.

- [ ] **Step 5: Run focused checks and commit**

```powershell
npx tsx --test src/modules/private-pro/sync/privatePro.sync.coordinator.test.ts
npx tsc --noEmit --pretty
npx eslint src/modules/private-pro/sync/privatePro.sync.coordinator.ts src/modules/private-pro/sync/privatePro.sync.coordinator.test.ts
git add src/modules/private-pro/sync/privatePro.sync.coordinator.ts src/modules/private-pro/sync/privatePro.sync.coordinator.test.ts
git commit -m "Cloud: coordinate seamless sync tabs"
```

Expected: tests and checks exit 0 before the commit.

---

### Task 5: Implement direct Firestore transactions, receipts, and listeners

**Files:**
- Create: `src/modules/private-pro/sync/privatePro.sync.transport.ts`
- Create: `src/modules/private-pro/sync/privatePro.sync.firebase.ts`
- Test: `src/modules/private-pro/sync/privatePro.sync.firebase.test.ts`
- Modify: `src/modules/private-pro/firebase/firebase.client.ts`

**Interfaces:**
- Consumes: wire schemas from Task 1.
- Produces: `PrivateProSyncTransport`
- Produces: `PrivateProSyncWriteInput`
- Produces: `PrivateProSyncWriteResult`
- Produces: `PrivateProSyncRemoteEvent`
- Produces: `createPrivateProFirebaseSyncTransport(uid: string): PrivateProSyncTransport`

- [ ] **Step 1: Write failing transaction and listener adapter tests**

Test an injected Firestore port for:

- Missing record plus base revision 0 creates revision 1.
- Matching base revision writes exactly the next revision.
- Existing mutation receipt returns `already-committed` without rewriting.
- Wrong base returns `conflict` with the canonical record.
- A put against a deleted canonical record returns `deleted`.
- Delete updates the canonical document and creates one immutable tombstone.
- Listener events with `hasPendingWrites === true` are ignored.
- Committed record and tombstone events are schema parsed before emission.

Define results exactly:

```ts
export type PrivateProSyncWriteResult =
  | { status: 'accepted'; revision: number }
  | { status: 'already-committed'; revision: number }
  | { status: 'conflict'; canonical: PrivateProSyncRemoteRecord }
  | { status: 'deleted'; canonical: PrivateProSyncRemoteRecord };
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npx tsx --test src/modules/private-pro/sync/privatePro.sync.firebase.test.ts`

Expected: FAIL because the transport modules do not exist.

- [ ] **Step 3: Implement exact v1 paths and transaction behavior**

Use:

```ts
const root = `users/${uid}/workspaces/v1`;
const recordPath = recordType === 'asset'
  ? `${root}/assets/${recordKey}`
  : `${root}/records/${recordKey}`;
const receiptPath = `${root}/mutationReceipts/${mutationId}`;
const tombstonePath = `${root}/tombstones/${recordKey}`;
```

Every accepted transaction writes the canonical record and creates its immutable receipt with `serverTimestamp()`. Delete additionally creates the immutable tombstone and stores an empty canonical payload. No v1 serializer emits recreation of a deleted logical ID.

- [ ] **Step 4: Implement committed listeners**

Attach listeners to `records`, `assets`, and `tombstones` with `{ includeMetadataChanges: true }`. Ignore local echoes by checking `change.doc.metadata.hasPendingWrites`. Return one unsubscribe that closes all three listeners. Errors are sanitized to `permission`, `offline`, `quota`, or `unknown` categories.

- [ ] **Step 5: Make Firestore explicitly memory-only and App Check-first**

Initialize App Check before Firestore/Storage and use `initializeFirestore(app, { localCache: memoryLocalCache() })`. Do not call `persistentLocalCache`, `enableIndexedDbPersistence`, or `enableMultiTabIndexedDbPersistence`.

- [ ] **Step 6: Run focused checks and commit**

```powershell
npx tsx --test src/modules/private-pro/sync/privatePro.sync.firebase.test.ts
npx tsc --noEmit --pretty
npx eslint src/modules/private-pro/firebase/firebase.client.ts src/modules/private-pro/sync/privatePro.sync.transport.ts src/modules/private-pro/sync/privatePro.sync.firebase.ts src/modules/private-pro/sync/privatePro.sync.firebase.test.ts
git add src/modules/private-pro/firebase/firebase.client.ts src/modules/private-pro/sync/privatePro.sync.transport.ts src/modules/private-pro/sync/privatePro.sync.firebase.ts src/modules/private-pro/sync/privatePro.sync.firebase.test.ts
git commit -m "Cloud: connect direct Firebase sync"
```

Expected: tests and checks exit 0 before the commit.

---

## Stage 3: Outbound and inbound convergence

### Task 6: Build the 60-second outbound scheduler and acknowledgement state machine

**Files:**
- Create: `src/modules/private-pro/sync/privatePro.sync.outbound.ts`
- Test: `src/modules/private-pro/sync/privatePro.sync.outbound.test.ts`

**Interfaces:**
- Consumes: serializers, DB, coordinator, and transport from Tasks 2-5.
- Produces: `PrivateProSyncOutbound`
- Produces: `createPrivateProSyncOutbound(dependencies)`
- Produces: `privateProClassifySyncError(error)` and capped retry timing.

- [ ] **Step 1: Write failing fake-clock outbound tests**

Required tests:

```ts
test('continuous typing emits one write at the end of the first minute', async () => {
  for (let second = 0; second < 60; second++) {
    clock.set(second * 1_000);
    emitSetting(`value-${second}`);
  }
  assert.equal(transport.writes.length, 0);
  await clock.advance(1_000);
  assert.equal(transport.writes.length, 1);
  assert.match(transport.writes[0].payload, /value-59/);
});

test('an acknowledgement cannot clear or apply a newer generation', async () => {
  const sent = await outbound.capture(firstMutation);
  await outbound.capture(secondMutation);
  await outbound.handleCommitted(sent.mutationId, 1);
  assert.equal(await runtimeValue(), 'second');
  assert.equal((await db.getOutbox(uid, sent.recordKey))?.generation, 2);
});
```

Also cover sign-out immediate drain, transient retry, terminal permission failure, conflict rebase for replace records, message-ID collision quarantine, and delete winning over a stale put.

- [ ] **Step 2: Run the test and verify failure**

Run: `npx tsx --test src/modules/private-pro/sync/privatePro.sync.outbound.test.ts`

Expected: FAIL because the outbound scheduler does not exist.

- [ ] **Step 3: Capture mutations immediately and wake the leader**

Subscribe to every serializer before cache hydration. Canonicalize and validate every put, persist it to `localRecords`, update the one-row outbox, then call `coordinator.wake()`. Suppression scope prevents remote projection work from entering this path.

- [ ] **Step 4: Process due mutations only as leader**

Lease one due row, call `assets.ensureUploaded()` for its referenced asset IDs, send the exact leased generation, and classify the result:

- `accepted` or `already-committed`: wait for or synthesize the committed acknowledgement, then call generation-safe `acknowledge`.
- `conflict` plus `replace`: rebase only if the leased generation is still current, then retry with capped jitter.
- `conflict` plus `message-identity`: quarantine if the canonical hash differs.
- `deleted`: discard the pending put and stage the canonical deletion.
- network/unavailable: retry with capped exponential backoff and jitter.
- permission/schema/quota: block that row and expose one sanitized error category.

- [ ] **Step 5: Enforce acknowledgement safety in code structure**

The outbound module may call DB acknowledgement methods and status callbacks only. It must not receive a serializer `apply` function. Add a source assertion test that `privatePro.sync.outbound.ts` contains no `.apply(` call and imports no runtime store module.

- [ ] **Step 6: Run focused checks and commit**

```powershell
npx tsx --test src/modules/private-pro/sync/privatePro.sync.db.test.ts src/modules/private-pro/sync/privatePro.sync.outbound.test.ts
npx tsc --noEmit --pretty
npx eslint src/modules/private-pro/sync/privatePro.sync.outbound.ts src/modules/private-pro/sync/privatePro.sync.outbound.test.ts
git add src/modules/private-pro/sync/privatePro.sync.outbound.ts src/modules/private-pro/sync/privatePro.sync.outbound.test.ts
git commit -m "Cloud: coalesce seamless sync writes"
```

Expected: tests and checks exit 0 before the commit.

---

### Task 7: Reconcile local cache and remote events without blocking the app

**Files:**
- Create: `src/modules/private-pro/sync/privatePro.sync.reconcile.ts`
- Test: `src/modules/private-pro/sync/privatePro.sync.reconcile.test.ts`
- Create: `src/modules/private-pro/sync/privatePro.sync.engine.ts`
- Test: `src/modules/private-pro/sync/privatePro.sync.engine.test.ts`
- Create: `src/modules/private-pro/sync/store-private-pro-sync.ts`

**Interfaces:**
- Consumes: Tasks 2-6.
- Produces: `PrivateProSyncReconciler`
- Produces: `PrivateProSyncEngine`
- Produces: `createPrivateProSyncEngine(dependencies)`
- Produces: `privateProSyncStore`
- Consumes an ephemeral per-engine `writerId` and an in-memory `localOrigins` map keyed by record key with that tab's latest local generation and mutation ID.

- [ ] **Step 1: Write failing reconciler tests**

Test:

- Local cached records apply under suppression.
- A user edit captured before cache hydration is not overwritten by older cached data.
- A committed remote record applies when there is no newer local generation.
- A committed remote replace record updates the base but not runtime when a newer local generation exists.
- A committed mutation originating in this tab acknowledges without applying its sent snapshot.
- The same committed mutation arriving in a sibling tab applies normally when that tab has no newer local mutation.
- A remote tombstone deletes the matching local projection and discards stale pending work.
- A message event arriving before metadata remains staged, then materializes when metadata arrives.
- Two different message IDs from two writers both remain.
- Same message ID with different content is quarantined.
- Invalid payloads are quarantined without printing the payload.

- [ ] **Step 2: Run reconciler tests and verify failure**

Run: `npx tsx --test src/modules/private-pro/sync/privatePro.sync.reconcile.test.ts`

Expected: FAIL because the reconciler does not exist.

- [ ] **Step 3: Implement projection-based remote application**

Validate and persist the remote record first. Resolve its `projectionKey`, load all non-deleted local records for that projection, then call the projection adapter under suppression. For chat projections, metadata is required and messages are sorted by `(created, id)`. A deletion rematerializes or removes the projection from remaining records.

Each engine instance owns a fresh UUID `writerId` and remembers only mutations captured by that tab in `localOrigins`. Capture allocates the new generation and updates `localOrigins` synchronously before the first asynchronous DB write. If a committed event has the same writer and mutation ID, acknowledge it without applying its payload. If it originated in another tab or device, apply it only when this tab has no `localOrigins` generation newer than the committed event's acknowledged base. Shared Dexie generation state controls cloud ordering; the per-tab origin map prevents another tab's older committed echo from replacing active edits in this runtime.

- [ ] **Step 4: Write failing engine lifecycle tests**

Use fake serializers, DB, transport, and coordinator. Assert `start()` subscribes before local cache application, returns without waiting for a server snapshot, reaches `offline` without hiding children, resumes pending work on `online`, and closes every listener/channel on `stop()`.

- [ ] **Step 5: Implement the engine orchestrator**

Use this interface:

```ts
export interface PrivateProSyncEngine {
  start(): Promise<void>;
  retryNow(): Promise<void>;
  flushNow(timeoutMs: number): Promise<{ pending: number }>;
  pendingCount(): Promise<number>;
  stop(): Promise<void>;
}
```

Startup order:

1. Subscribe to local serializers.
2. Start the coordinator.
3. Begin applying UID-scoped cached records under suppression.
4. Attach Firestore listeners.
5. Wake the leader for durable pending work.
6. Resolve `start()` without waiting for remote catch-up.

- [ ] **Step 6: Implement compact status**

Store only phase, pending count, last sanitized category, retry callback, and last successful sync time. Derive `synced` only when pending count is zero and the listener is current; use `local` while cached state is usable before a server snapshot.

- [ ] **Step 7: Run focused checks and commit**

```powershell
npx tsx --test src/modules/private-pro/sync/privatePro.sync.reconcile.test.ts src/modules/private-pro/sync/privatePro.sync.engine.test.ts
npx tsc --noEmit --pretty
npx eslint src/modules/private-pro/sync/privatePro.sync.reconcile.ts src/modules/private-pro/sync/privatePro.sync.engine.ts src/modules/private-pro/sync/store-private-pro-sync.ts
git add src/modules/private-pro/sync/privatePro.sync.reconcile.ts src/modules/private-pro/sync/privatePro.sync.reconcile.test.ts src/modules/private-pro/sync/privatePro.sync.engine.ts src/modules/private-pro/sync/privatePro.sync.engine.test.ts src/modules/private-pro/sync/store-private-pro-sync.ts
git commit -m "Cloud: reconcile seamless sync records"
```

Expected: tests and checks exit 0 before the commit.

---

## Stage 4: Attachments and application lifecycle

### Task 8: Replace encrypted assets with UID-scoped local blobs and direct resumable Storage

**Files:**
- Create: `src/modules/private-pro/assets/privatePro.assets.schemas.ts`
- Create: `src/modules/private-pro/assets/privatePro.assets.local.ts`
- Replace: `src/modules/private-pro/assets/privatePro.assets.client.ts`
- Test: `src/modules/private-pro/assets/privatePro.assets.client.test.ts`
- Modify: `src/modules/private-pro/sync/privatePro.sync.serializers.ts`
- Create: `src/modules/private-pro/sync/serializers/asset.ts`
- Modify: `src/modules/private-pro/sync/privatePro.sync.engine.ts`
- Modify: `src/modules/dblobs/dblobs.db.ts`
- Test: `src/modules/dblobs/dblobs.private-pro.test.ts`

**Interfaces:**
- Consumes: sync DB asset table and outbound asset hook.
- Produces: `PrivateProAssetManifest`
- Produces: `PrivateProAssetLocalPort`
- Produces: `PrivateProAssetClient`
- Produces: `activatePrivateProAssetPersistence(uid, port)`
- Produces: `createPrivateProAssetClient(uid, storage, transport, local)`

- [ ] **Step 1: Rewrite DBlob Private Pro tests to require UID-scoped durability**

Assert a Private Pro asset survives a new local-port instance for the same UID, is invisible to a second UID, and is removed only from the selected UID during clear. Remove expectations that encrypted mode keeps DBlobs only in a process-local map.

- [ ] **Step 2: Write failing direct asset client tests**

Use a fake Storage port and assert:

- Original bytes are decoded from DBlob base64 and uploaded with `uploadBytesResumable`.
- Optional `thumb256` bytes use a separate object.
- Retries resume the same object path.
- Manifest writes occur only after every required object finishes.
- Remote hydration reconstructs the exact DBlob dates, metadata, origin, scope, and base64.
- Cross-account paths are never accepted from a remote manifest.
- Deletion removes the manifest through sync and attempts every object cleanup idempotently.

- [ ] **Step 3: Run asset tests and verify failure**

```powershell
npx tsx --test src/modules/dblobs/dblobs.private-pro.test.ts src/modules/private-pro/assets/privatePro.assets.client.test.ts
```

Expected: FAIL because direct asset modules and the UID port do not exist.

- [ ] **Step 4: Define the plaintext manifest and exact object paths**

Use:

```ts
users/{uid}/workspace-v1/assets/{assetId}/original
users/{uid}/workspace-v1/assets/{assetId}/thumb256
```

The Firestore asset manifest lives at `users/{uid}/workspaces/v1/assets/{recordKey}` and contains only validated metadata, MIME types, byte sizes, SHA-256 hashes, and the two fixed object IDs. It never accepts a caller-supplied bucket or arbitrary path.

- [ ] **Step 5: Implement local asset delegation**

When Private Pro is enabled, DBlob CRUD delegates to the active `PrivateProAssetLocalPort`, which reads and writes the sync DB `assets` table under the active UID. Open builds continue to use the existing `Big-AGI` Dexie table unchanged.

- [ ] **Step 6: Implement direct upload and hydration**

Use `uploadBytesResumable`, `getBytes`, and `deleteObject`. Set custom metadata `uid`, `assetId`, `kind`, and `sha256`; validate it after download. Expose:

```ts
ensureUploaded(assetIds: readonly string[]): Promise<void>
hydrate(assetIds: readonly string[]): Promise<void>
delete(assetId: string): Promise<void>
clearLocal(): Promise<void>
```

The asset serializer emits `referencedAssetIds: [assetId]`. Due asset-manifest rows sort before other records, and `ensureUploaded` must finish before the manifest transaction. A referencing chat-message row remains deferred until every referenced asset manifest has an acknowledged remote revision. Remote chat projection may proceed while `hydrate` runs, but missing assets remain retryable and do not block unrelated records.

- [ ] **Step 7: Run focused checks and commit**

```powershell
npx tsx --test src/modules/dblobs/dblobs.private-pro.test.ts src/modules/private-pro/assets/privatePro.assets.client.test.ts src/modules/private-pro/sync/privatePro.sync.engine.test.ts
npx tsc --noEmit --pretty
npx eslint src/modules/private-pro/assets src/modules/private-pro/sync/serializers/asset.ts src/modules/dblobs/dblobs.db.ts
git add src/modules/private-pro/assets src/modules/private-pro/sync/privatePro.sync.serializers.ts src/modules/private-pro/sync/serializers/asset.ts src/modules/private-pro/sync/privatePro.sync.engine.ts src/modules/dblobs/dblobs.db.ts src/modules/dblobs/dblobs.private-pro.test.ts
git commit -m "Cloud: sync private attachments directly"
```

Expected: tests and checks exit 0 before the commit.

---

### Task 9: Mount non-blocking sync, simplify the account UI, and make sign-out deterministic

**Files:**
- Create: `src/modules/private-pro/sync/ProviderPrivateProSync.tsx`
- Test: `src/modules/private-pro/sync/ProviderPrivateProSync.test.tsx`
- Create: `src/modules/private-pro/ui/PrivateProSyncStatus.tsx`
- Replace: `src/modules/private-pro/ui/PrivateProAccountControl.tsx`
- Modify: `src/modules/private-pro/persistence/privatePro.persistence.ts`
- Test: `src/modules/private-pro/persistence/privatePro.persistence.test.ts`
- Modify: `src/common/providers/single-tab/ProviderSingleTab.tsx`
- Test: `src/common/providers/single-tab/ProviderSingleTab.test.tsx`
- Modify: `src/modules/private-pro/auth/privatePro.auth.client.ts`
- Modify: `src/modules/private-pro/auth/privatePro.auth.procedures.server.ts`
- Modify: `src/modules/private-pro/auth/privatePro.auth.service.ts`
- Test: `src/modules/private-pro/auth/privatePro.auth.service.test.ts`
- Modify: `src/modules/private-pro/auth/privatePro.auth.router.ts`
- Modify: `src/modules/private-pro/config/privatePro.config.server.ts`
- Modify: `src/server/env.server.ts`
- Modify: `src/server/trpc/trpc.server.ts`
- Modify: `tools/private-pro/manage-access.ts`
- Test: `tools/private-pro/manage-access.test.ts`
- Modify: `pages/_app.tsx`

**Interfaces:**
- Consumes: engine, status, assets, auth, and DB.
- Produces: `usePrivateProSync()`
- Produces: `PrivateProUnsyncedChangesError`
- Produces: `activatePrivateProManagedPersistence(uid)` and `clearPrivateProManagedPersistence(uid)`
- Produces: `ProviderSingleTab({ enabled, children })`

- [ ] **Step 1: Write failing provider and UI tests**

Assert:

- Disabled Private Pro renders children without creating Firebase sync.
- Signed-in Private Pro renders children immediately while engine startup is pending.
- No setup, unlock, recovery, or reconnect screen appears.
- Engine cleanup runs on account change and unmount.
- `signOut()` attempts a 5,000 ms drain.
- Remaining pending changes throw `PrivateProUnsyncedChangesError(count)` until the user confirms discard.
- Confirmed sign-out clears runtime stores, UID sync DB state, UID assets, and Firebase auth, then reloads.
- Account UI contains only email, compact status, retry, and sign-out.

- [ ] **Step 2: Write failing single-tab bypass tests**

Render `ProviderSingleTab` with `enabled={false}` and assert children render without calling the instance-lock hook. Render with `enabled={true}` and retain the existing leader/follower behavior.

- [ ] **Step 3: Run tests and verify failure**

```powershell
npx tsx --test src/modules/private-pro/sync/ProviderPrivateProSync.test.tsx src/common/providers/single-tab/ProviderSingleTab.test.tsx src/modules/private-pro/persistence/privatePro.persistence.test.ts
```

Expected: FAIL because the provider, simplified lifecycle, and bypass do not exist.

- [ ] **Step 4: Convert encrypted persistence into managed runtime persistence**

Retain the current explicit portable/sensitive key allowlists and volatile adapters, but rename encrypted-state APIs to managed Private Pro APIs. The sync DB, not `localStorage`, becomes durable portable storage. Remove password/asset-encryption copy and expose one atomic clear function that resets volatile Zustand values, DBlobs, and UID sync tables.

- [ ] **Step 5: Implement the provider and sign-out flow**

Mount after `ProviderPrivatePro`. Generate a fresh non-secret `writerId` for each mounted engine instance, create serializers/assets/transport/engine, call `start()` without gating children, and stop all resources on cleanup. Do not persist or share `writerId` between tabs. Expose:

```ts
retry(): Promise<void>
signOut(options?: { discardPending?: boolean }): Promise<void>
phase: 'local' | 'syncing' | 'synced' | 'offline' | 'error'
pending: number
```

- [ ] **Step 6: Remove vault device request headers and middleware**

`privateProGetRequestHeaders()` returns only Firebase ID and optional App Check headers. Stop parsing `x-private-pro-device-id` in the tRPC context. Delete `PrivateProVaultProcedureDependencies`, `createPrivateProVaultProcedure`, and `createPrivateProVaultPutKeysetProcedure`; retain bootstrap and current-account premium procedures used by non-sync server routes.

- [ ] **Step 7: Remove attachment quota state from authentication and access management**

Reduce the preserved account shape to:

```ts
export interface PrivateProAccountRecord {
  uid: string;
  email: string;
  active: boolean;
  accessEpoch: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PrivateProBootstrap {
  uid: string;
  email: string;
  accessEpoch: number;
}
```

Remove `attachmentQuotaBytes`, `quotaBytes`, `usedBytes`, and `reservedBytes` from config, environment validation, bootstrap, account tests, status procedures, and `manage-access`. Existing production fields may remain harmlessly in preserved account documents until the cloud reset removes them, but no runtime code may read or write them.

- [ ] **Step 8: Mount the new provider and allow multiple Private Pro tabs**

Change `_app.tsx` to:

```tsx
<ProviderPrivatePro>
  <ProviderPrivateProSync>
    <ApplicationWithTRPC {...props} />
  </ProviderPrivateProSync>
</ProviderPrivatePro>
```

Pass `enabled={!privateProClientConfig.enabled}` to the global single-tab provider so Open builds stay single-instance and Private Pro relies on the sync coordinator.

- [ ] **Step 9: Run focused checks and commit**

```powershell
npx tsx --test src/modules/private-pro/sync/ProviderPrivateProSync.test.tsx src/common/providers/single-tab/ProviderSingleTab.test.tsx src/modules/private-pro/persistence/privatePro.persistence.test.ts src/modules/private-pro/auth/privatePro.auth.service.test.ts tools/private-pro/manage-access.test.ts
npx tsc --noEmit --pretty
npx eslint pages/_app.tsx src/modules/private-pro/sync/ProviderPrivateProSync.tsx src/modules/private-pro/ui src/modules/private-pro/persistence src/modules/private-pro/auth src/modules/private-pro/config/privatePro.config.server.ts src/server/env.server.ts src/server/trpc/trpc.server.ts tools/private-pro/manage-access.ts tools/private-pro/manage-access.test.ts src/common/providers/single-tab
git add pages/_app.tsx src/modules/private-pro/sync/ProviderPrivateProSync.tsx src/modules/private-pro/sync/ProviderPrivateProSync.test.tsx src/modules/private-pro/ui src/modules/private-pro/persistence src/modules/private-pro/auth src/modules/private-pro/config/privatePro.config.server.ts src/server/env.server.ts src/server/trpc/trpc.server.ts tools/private-pro/manage-access.ts tools/private-pro/manage-access.test.ts src/common/providers/single-tab
git commit -m "Cloud: open seamless private workspaces"
```

Expected: tests and checks exit 0 before the commit.

---

## Stage 5: Rules, cutover, and removal

### Task 10: Permit only current-UID v1 Firestore and Storage operations

**Files:**
- Replace: `firestore.rules`
- Replace: `storage.rules`
- Modify: `firestore.indexes.json`
- Replace: `test/firebase/private-pro.rules.test.ts`
- Create: `test/firebase/private-pro.sync.test.ts`

**Interfaces:**
- Consumes: exact v1 paths and schemas from Tasks 1, 5, and 8.
- Produces: authenticated direct browser access for the current UID only.

- [ ] **Step 1: Write failing emulator rule tests before changing rules**

Import `assertSucceeds` and test:

- Current UID plus current claims can read/list its v1 records, receipts, tombstones, and asset manifests.
- Anonymous, wrong UID, missing claim, stale epoch, and inactive account fail.
- A valid create writes revision 1 and a matching immutable receipt atomically.
- A valid update increments revision by exactly 1 and creates a new receipt.
- Skipped revisions, changed identity fields, extra fields, non-ASCII/oversized payloads, and arbitrary timestamps fail.
- Delete is represented only by a canonical deleted revision plus matching tombstone; document delete fails.
- Tombstones and receipts cannot be updated or deleted.
- Legacy plaintext and encrypted vault paths remain denied.
- Current UID can upload, download, and delete fixed v1 asset objects with bounded size and exact metadata.
- Wrong UID, stale epoch, arbitrary object names, missing metadata, and oversized objects fail.

- [ ] **Step 2: Write the real-transport two-client emulator test**

Create two authenticated contexts for the same UID with different writer IDs and assert:

1. Both create different `chat-message` records and both remain queryable.
2. Two writes to one settings record resolve by transaction revision.
3. A stale client cannot put after another client deletes the record.
4. A duplicate mutation ID returns the existing receipt without a new revision.

- [ ] **Step 3: Run the emulator suite and verify denial failures**

Run:

```powershell
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-21.0.4.7-hotspot'
$env:PATH="$env:JAVA_HOME\bin;$env:PATH"
npm run test:firebase:exec
```

Expected: FAIL because the current rules deny all browser operations.

- [ ] **Step 4: Implement Firestore current-account and transactional invariants**

Use a shared `currentAccount(uid)` rule function that checks authenticated UID, `privatePro == true`, numeric matching epoch, and active account document. Validate exact keys with `keys().hasOnly`. Require `updatedAt == request.time`, ASCII payload length `<= 786432`, and `getAfter()` links between canonical record, receipt, and tombstone documents in the same atomic write.

- [ ] **Step 5: Implement Storage ownership and object constraints**

Use `firestore.get()` on `users/{uid}` to enforce active matching epoch. Permit only `original` and `thumb256` below one asset ID. Bound original objects to the configured maximum and thumbnails to 2 MiB. Require metadata `uid`, `assetId`, `kind`, and a lowercase 64-character `sha256`. Deny listing broad account prefixes.

- [ ] **Step 6: Remove unused encrypted indexes and run the emulator suite**

Run: `npm run test:firebase:exec`

Expected: all rule and transport integration tests pass.

- [ ] **Step 7: Run static checks and commit**

```powershell
npx eslint test/firebase
npx tsc --noEmit --pretty
git add firestore.rules storage.rules firestore.indexes.json test/firebase
git commit -m "Cloud: authorize seamless Firebase workspaces"
```

---

### Task 11: Delete the encrypted vault and add deterministic first-launch cleanup

**Files:**
- Create: `src/modules/private-pro/sync/privatePro.sync.cutover.ts`
- Test: `src/modules/private-pro/sync/privatePro.sync.cutover.test.ts`
- Modify: `src/modules/private-pro/sync/ProviderPrivateProSync.tsx`
- Delete: `src/modules/private-pro/vault/**`
- Delete: `src/modules/private-pro/ui/PrivateProVaultSetup.tsx`
- Delete: `src/modules/private-pro/ui/PrivateProVaultUnlock.tsx`
- Delete: `src/modules/private-pro/ui/PrivateProVaultStatus.tsx`
- Delete: `src/modules/private-pro/ui/PrivateProVaultRecoveryRecommendation.tsx`
- Delete: encrypted asset server files and tests superseded by Task 8
- Delete: `src/modules/trade/privateProEncryptedBackup.ts`
- Delete: `src/modules/trade/privateProEncryptedBackup.test.ts`
- Delete: `app/api/private-pro/sweep-expired/**`
- Modify: `src/server/trpc/trpc.router-cloud.ts`
- Modify: `vercel.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Delete: `tools/private-pro/test-helpers/privatePro.vault.password.test-helpers.ts`
- Modify: `tools/private-pro/dependency-security.test.ts`
- Modify: `tools/private-pro/src-import-boundaries.test.ts`

**Interfaces:**
- Produces: `runPrivateProWorkspaceV1LocalCutover(port): Promise<void>`
- Removes all vault APIs, crypto, backup, device, recovery, and server sync surfaces.

- [ ] **Step 1: Write failing local cutover tests**

Use an injected browser storage/indexedDB port. Seed `private-pro-vault-v1`, legacy `private-pro-sync-v1`, `private-pro-vault-device:*`, old portable keys, and old DBlobs. Assert the cutover deletes those values, preserves Firebase Auth keys, creates marker `private-pro-cutover:workspace-v1`, and becomes an idempotent no-op on the second run.

- [ ] **Step 2: Run the cutover test and verify failure**

Run: `npx tsx --test src/modules/private-pro/sync/privatePro.sync.cutover.test.ts`

Expected: FAIL because the cutover module does not exist.

- [ ] **Step 3: Implement and mount first-launch cleanup**

Run cleanup before creating the v1 sync engine. Delete databases by exact name, remove only known Private Pro portable/sensitive keys and `private-pro-vault-device:` prefixes, clear the legacy Big-AGI asset table, and preserve Firebase Auth persistence. Write the marker only after every deletion succeeds.

- [ ] **Step 4: Remove the vault source tree and server registrations**

Delete the listed source and test files, including `src/modules/private-pro/assets/privatePro.assets.deployment.test.ts` and the password test helper outside the vault tree. Remove `privateProVault` and `privateProVaultAssets` from the cloud router. Remove the sweep cron route and the only `vercel.json` cron entry. If `vercel.json` becomes an empty object with no other behavior, delete it. Update import-boundary and dependency-security assertions so they require the new direct Firebase browser modules and reject deleted vault imports.

- [ ] **Step 5: Remove crypto-only dependencies**

Run:

```powershell
rg -n "hash-wasm|argon2|privateProVault|PrivateProVault|encrypted backup|vault password|recovery key" src app pages tools package.json
```

After every remaining match is either intentional historical documentation or removed code, run `npm uninstall hash-wasm`. Do not remove a package still used outside the deleted vault.

- [ ] **Step 6: Run deletion-boundary tests and checks**

```powershell
npx tsx --test src/modules/private-pro/sync/privatePro.sync.cutover.test.ts src/modules/private-pro/sync/ProviderPrivateProSync.test.tsx src/modules/private-pro/assets/privatePro.assets.client.test.ts
npm run tscheck
npm run lint
rg -n "privateProVault|PrivateProVault|privateProEncryptedBackup|hash-wasm" src app pages tools package.json
```

Expected: tests, typecheck, and lint pass; the final search has no mounted or executable vault references.

- [ ] **Step 7: Commit vault removal**

```powershell
git add -A src/modules/private-pro src/modules/trade app/api/private-pro src/server/trpc/trpc.router-cloud.ts pages/_app.tsx tools/private-pro/test-helpers tools/private-pro/dependency-security.test.ts tools/private-pro/src-import-boundaries.test.ts vercel.json package.json package-lock.json
git commit -m "Cloud: remove encrypted private vault"
```

---

### Task 12: Add a dry-run-first cloud reset and update the production release gates

**Files:**
- Create: `tools/private-pro/reset-workspaces.ts`
- Test: `tools/private-pro/reset-workspaces.test.ts`
- Modify: `package.json`
- Modify: `tools/private-pro/security-audit.ts`
- Modify: `tools/private-pro/security-audit.test.ts`
- Modify: `infra/private-pro/firebase-origin-restrictions.md`
- Modify: `infra/private-pro/gcp-runtime-role.yaml`
- Modify: `docs/deploy-private-pro-firebase.md`
- Modify: `docs/environment-variables.md`

**Interfaces:**
- Produces script: `npm run private-pro:reset-workspaces`
- Produces: `buildPrivateProResetPlan(input): PrivateProResetPlan`
- Produces execute gate: `--execute --confirm <project-id>`
- Updates security audit to expect direct Firestore/Storage browser API targets while anonymous probes remain denied.

- [ ] **Step 1: Write failing reset-plan tests**

Test that the pure planner:

- Preserves every Firebase Auth identity. Preserves and rotates `users/{uid}` account documents only for verified identities in the current normalized `PRIVATE_PRO_ALLOWED_EMAILS` set.
- Deletes old `vault`, legacy plaintext sync, old asset/upload collections, and any pre-release `workspaces/v1` subtrees.
- Deletes Storage prefixes `users/{uid}/vault`, `users/{uid}/assets`, `users/{uid}/chatUploads`, and `users/{uid}/workspace-v1`.
- Removes obsolete `quotaBytes`, `usedBytes`, and `reservedBytes` fields from preserved account documents.
- Deletes or deactivates non-approved account documents, clears their Private Pro claims, and revokes their refresh tokens.
- Increments `accessEpoch`, refreshes matching claims, and revokes refresh tokens for every preserved approved account.
- Refuses execution without both `--execute` and exact project-ID confirmation.
- Defaults to a count-only dry run with no writes.

- [ ] **Step 2: Run the reset test and verify failure**

Run: `npx tsx --test tools/private-pro/reset-workspaces.test.ts`

Expected: FAIL because the reset module does not exist.

- [ ] **Step 3: Implement bounded batch deletion and account rotation**

Page through Auth users and Firestore account documents. Use Admin SDK recursive deletion only on exact per-UID subtrees, batch Storage object deletion by exact prefix, then update the preserved account and Auth claims. Print UIDs, document counts, object counts, and epoch transitions, never payloads, emails beyond the already-admin-visible account identifier, API keys, or object bytes.

Add:

```json
"private-pro:reset-workspaces": "tsx tools/private-pro/reset-workspaces.ts"
```

- [ ] **Step 4: Update browser API-key and CORS release expectations**

The exact required browser API services become:

```ts
firebaseappcheck.googleapis.com
identitytoolkit.googleapis.com
securetoken.googleapis.com
firestore.googleapis.com
firebasestorage.googleapis.com
```

Derive the exact bucket CORS policy from a captured `uploadBytesResumable`, `getBytes`, and `deleteObject` browser trace against the deployed Firebase SDK version. The checked-in SDK currently uses `POST`, `PUT`, `GET`, and `DELETE`, Firebase auth/App Check/version headers, and `X-Goog-Upload-*` request/response headers. Encode only the observed two approved origins, methods, request headers, and exposed response headers; add a deterministic audit fixture asserting that exact policy. Do not copy the old signed-URL CORS policy.

- [ ] **Step 5: Update audit language and runtime IAM**

Anonymous Firestore and Storage probes must still be denied, so rename findings to make that explicit rather than claiming all browser access is denied. Remove vault-only Storage and broad Firestore list/delete permissions from the Vercel runtime role after confirming the remaining Admin bootstrap path needs only account get/create/update and Firebase Auth get/update.

- [ ] **Step 6: Rewrite deployment and environment documentation**

Document this exact cutover order:

1. Verify local tests and emulator rules.
2. Deploy v1 Firestore and Storage rules/indexes.
3. Update browser API-key restrictions and bucket CORS.
4. Confirm App Check metrics for Firestore and Storage, then enforce both.
5. Run `npm run private-pro:reset-workspaces` and review the dry-run counts.
6. Run `npm run private-pro:reset-workspaces -- --execute --confirm <project-id>`.
7. Deploy the new application build.
8. Sign in again in clean profiles and complete the two-browser acceptance checks.

Remove vault password, recovery, encrypted backup, upload reservation, quota, cron, signed URL, and ciphertext claims from current deployment documentation. Remove `PRIVATE_PRO_ATTACHMENT_QUOTA_BYTES` from environment validation and docs. Keep historical specs unchanged.

- [ ] **Step 7: Run tool and documentation checks**

```powershell
npx tsx --test tools/private-pro/reset-workspaces.test.ts tools/private-pro/security-audit.test.ts
npm run tscheck
npx eslint tools/private-pro
$docs = Get-Content -Raw 'docs/deploy-private-pro-firebase.md','docs/environment-variables.md','infra/private-pro/firebase-origin-restrictions.md'
if ($docs -match '\bT[B]D\b|\bT[O]DO\b' -or $docs.Contains([char]0x2014)) { throw 'Documentation contains a placeholder or prohibited punctuation.' }
```

Expected: all commands exit 0 and documentation validation does not throw.

- [ ] **Step 8: Commit reset tooling and release gates**

```powershell
git add tools/private-pro/reset-workspaces.ts tools/private-pro/reset-workspaces.test.ts tools/private-pro/security-audit.ts tools/private-pro/security-audit.test.ts infra/private-pro/firebase-origin-restrictions.md infra/private-pro/gcp-runtime-role.yaml docs/deploy-private-pro-firebase.md docs/environment-variables.md package.json package-lock.json
git commit -m "Cloud: prepare seamless sync cutover"
```

---

## Stage 6: Full verification and destructive rollout

### Task 13: Verify the complete replacement and perform the approved greenfield cutover

**Files:**
- Modify only implementation or documentation files whose failure is proven by the commands below.

**Interfaces:**
- Produces a branch satisfying the approved seamless-sync specification and a reset production workspace ready for first users.

- [ ] **Step 1: Run all Private Pro unit tests together**

```powershell
npx tsx --test "src/modules/private-pro/**/*.test.ts" "src/modules/dblobs/dblobs.private-pro.test.ts" "tools/private-pro/**/*.test.ts"
```

Expected: zero failures.

- [ ] **Step 2: Run Firebase Emulator tests**

```powershell
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-21.0.4.7-hotspot'
$env:PATH="$env:JAVA_HOME\bin;$env:PATH"
npm run test:firebase:exec
```

Expected: zero failures and no emulator open-handle leak.

- [ ] **Step 3: Run repository tests, typecheck, lint, and production build**

```powershell
npm test
tsc --noEmit --pretty
npm run lint
npm run build
```

Expected: every command exits 0. Do not substitute `next build` for the earlier focused typecheck/lint loops.

- [ ] **Step 4: Audit forbidden remnants and data leaks**

```powershell
rg -n "privateProVault|PrivateProVault|vault password|recovery key|encrypted backup|hash-wasm|Argon2" src app pages tools package.json
rg -n "console\.(log|warn|error)|Sentry|captureException|analytics" src/modules/private-pro
rg -n "persistentLocalCache|enableIndexedDbPersistence|enableMultiTabIndexedDbPersistence" src/modules/private-pro
git diff --check
git status --short --branch
```

Expected: no executable vault remnants, no workspace payload logging, no Firestore durable cache enablement, no whitespace errors, and only intentional changes.

- [ ] **Step 5: Prove one-minute and acknowledgement behavior with deterministic tests**

Run the outbound and engine test files with test-name filtering for continuous typing, newer generation acknowledgement, two-message merge, offline reconnect, stale deletion, and tab failover. Record the passing test names in the final handoff.

- [ ] **Step 6: Run the production security audit in report-only mode**

```powershell
npm run private-pro:security-audit -- --report-only
```

Expected: browser API-key, CORS, App Check, IAM, anonymous rule probes, and recovery controls are readable. Any live-state blocker must be resolved through the documented production change rather than bypassed in code.

- [ ] **Step 7: Deploy rules and inspect the destructive dry run**

After the user deploys the verified branch or makes the required remote Git action, deploy Firebase rules/indexes and run:

```powershell
npm run private-pro:reset-workspaces
```

Expected: the command prints only disposable workspace/account epoch counts and performs no mutation.

- [ ] **Step 8: Execute the already-approved greenfield reset**

With the intended production project selected and the dry-run counts reviewed:

```powershell
npm run private-pro:reset-workspaces -- --execute --confirm $env:NEXT_PUBLIC_FIREBASE_PROJECT_ID
```

Expected: old workspace subtrees and objects are removed, account documents and Auth identities remain, epochs increase, claims refresh, and refresh tokens are revoked.

- [ ] **Step 9: Perform two-browser live acceptance**

Using two independent clean browser profiles signed into the same approved account:

1. Confirm both profiles open after Google bootstrap without vault UI.
2. Type continuously in one synced setting for more than two minutes and verify at most one committed record revision per minute.
3. Confirm no acknowledgement moves the field back to an older value.
4. Add different messages to the same chat from both profiles and confirm both remain.
5. Change one setting from both profiles and confirm the later committed write wins without a prompt.
6. Take one profile offline, edit, reconnect, and confirm automatic upload.
7. Delete a chat while the other profile is stale and confirm it cannot resurrect the chat.
8. Upload an attachment, interrupt connectivity, resume, and open it in the other profile.
9. Sign out and confirm local plaintext state is cleared.
10. Sign in as a second approved account and confirm an empty isolated workspace.

- [ ] **Step 10: Commit only verification-driven fixes**

If Steps 1-9 prove a defect, add a failing regression test first, implement the narrow fix, rerun the affected focused suite plus Steps 1-4, and commit the exact changed files with:

```powershell
git commit -m "Cloud: harden seamless private sync"
```

If verification requires no source change, do not create an empty commit.

---

## Execution order

Execute Tasks 1-13 serially. Tasks 1-5 define stable protocol, persistence, coordination, and transport contracts. Tasks 6-7 implement convergence. Task 8 adds assets. Task 9 mounts the replacement without deleting rollback code. Task 10 proves Firebase authorization. Only then may Task 11 delete the vault. Task 12 updates production tooling and release gates. Task 13 performs full verification and the already-approved destructive greenfield reset.

Do not combine commits across task boundaries. Do not delete a vault file until its replacement behavior has a passing focused test. Do not run the production reset before the v1 rules and verified client are ready.

## Completion evidence

The final handoff must include:

- Current branch and commit list.
- Exact verification commands, exit codes, and test counts.
- The passing one-minute coalescing and acknowledgement-safety test names.
- Firebase Emulator test results for UID isolation, revision enforcement, tombstones, receipts, and Storage paths.
- The reset dry-run summary and executed reset summary without payload contents.
- Live two-browser acceptance results.
- Any external check skipped, with its missing prerequisite named precisely.
- Confirmation that no development server was started or stopped.
- Confirmation that no branch was pushed.
