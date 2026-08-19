# Private Pro Seamless Firebase Sync Design

**Date:** 2026-08-19
**Status:** Approved design
**Branch:** `pro`

## Summary

Replace the Private Pro encrypted vault with a direct, authenticated Firebase synchronization layer. Maximum seamlessness takes priority over application-level secrecy. Firebase Authentication, the approved-email allowlist, per-account ownership rules, access epochs, App Check, and HTTPS remain the trust boundary. Chats, settings, provider credentials, API keys, personas, folders, Scratch data, and attachment metadata may be stored as plaintext Firebase document fields.

Private Pro is still a greenfield service. Existing encrypted cloud data, encrypted assets, local vault databases, remembered-device registrations, keysets, recovery material, and encrypted backups are disposable. The cutover is destructive and has no migration or compatibility window.

This design supersedes:

- `docs/superpowers/specs/2026-08-16-private-pro-sync-design.md`
- `docs/superpowers/specs/2026-08-17-private-pro-encrypted-vault-design.md`

Those files remain historical records only.

## Goals

- Give every approved Google account its own private synchronized workspace.
- Open the application as soon as Google authentication and allowlist bootstrap succeed.
- Keep all editing local-first and non-blocking after the application opens.
- Synchronize multiple devices and tabs automatically through Firestore realtime listeners.
- Coalesce active edits so a record is written to Firestore no more than once per 60-second window during normal use.
- Prevent an acknowledgement or local Firestore echo from replacing a newer local edit.
- Merge concurrent chat additions without replacing an entire conversation.
- Continue locally through temporary network or Firebase failures and resume automatically.
- Make sign-in, sign-out, synchronization, and attachment handling require no vault-specific user decisions.

## Non-goals

- End-to-end encryption or any other application-level encryption.
- Vault passwords, recovery keys, remembered-device authorization, key rotation, or encrypted exports.
- Preserving or migrating existing Private Pro cloud or local vault data.
- Sharing a workspace between approved Google accounts.
- Collaborative editing between different accounts.
- Conflict prompts for ordinary settings or metadata edits.
- Cold startup while Google authentication or the required allowlist bootstrap cannot be established.
- A custom per-account attachment quota transaction system in the first version. Firebase billing alerts, platform quotas, per-object size limits, and operational monitoring provide the initial bounds.

## Accepted trust model

The user explicitly accepts server-readable synchronized data. Firebase and trusted application administrators may technically read workspace documents and stored attachments. API keys and provider credentials are plaintext application data inside the authenticated account boundary.

The design still requires basic isolation and hygiene:

- The server verifies Google-backed Firebase ID tokens and the approved-email allowlist.
- Every browser Firestore or Storage operation is restricted to `request.auth.uid`.
- A `privatePro` custom claim and matching current access epoch are required.
- The account document must remain active.
- App Check is enforced in production after the existing monitored rollout mechanism.
- Logs, analytics, Sentry, and user-visible error messages never include workspace payloads, API keys, credentials, tokens, or attachment contents.
- Existing CSP, origin restrictions, token handling, and cross-account emulator coverage remain in force.

This is account isolation, not protection from a compromised signed-in browser session, Firebase administrator, or application administrator.

## Chosen architecture

### Direct Firebase client synchronization

The authenticated browser reads and writes its own Firestore workspace directly. Firestore realtime listeners provide the remote change stream. Firebase Storage resumable uploads handle attachment bytes. Vercel remains responsible for authentication bootstrap, allowlist enforcement, claim issuance, account activation and revocation, and any administrative operations.

No custom WebSocket or SSE service is added. Firestore already supplies the required streaming transport, reconnection behavior, ordering, and SDK integration. A server-mediated tRPC sync service would add latency and operational failure modes without improving the accepted trust boundary.

### Runtime provider

Replace `ProviderPrivateProVault` with `ProviderPrivateProSync` beneath the existing `ProviderPrivatePro` authentication provider.

`ProviderPrivateProSync` has four responsibilities:

1. Load the authenticated UID's account-scoped local workspace.
2. Start the local mutation observer and durable outbox.
3. Attach Firestore realtime listeners for the UID's workspace.
4. Expose a compact non-blocking status: `local`, `syncing`, `synced`, `offline`, or `error`.

Authentication and allowlist bootstrap remain the only opening gate. Synchronization catch-up never replaces the application with a blocking setup, unlock, hydration, reconnect, or recovery screen.

### Local persistence ownership

Existing Big-AGI stores remain the immediate source used by the UI. Portable state is persisted in an account-scoped local database identified by Firebase UID. A small dedicated IndexedDB sync database stores pending mutations, local generation counters, the last applied remote revision, suppressed-echo state, and quarantined validation failures.

The application owns this durable cache rather than depending on an opaque Firestore disk cache. This makes 60-second coalescing, acknowledgement safety, account switching, and deterministic sign-out clearing testable. Firestore may use its normal in-memory cache; durable retry state remains in the application outbox.

Multiple tabs share the account-scoped outbox. Exactly one tab per UID holds a named Web Lock and acts as the flush coordinator. Other tabs may enqueue mutations and attach their own listeners, but they signal the coordinator through `BroadcastChannel` rather than sending independently. If Web Locks are unavailable, an IndexedDB lease with a fencing token provides the same single-writer guarantee. Coordinator loss releases or expires the lease, and the successor resumes from persisted due times. Mutation IDs still make crash-boundary retries idempotent, but single-writer tab coordination is a correctness requirement.

## Firestore model

All new synchronized data lives below a versioned root that old encrypted clients do not know:

```text
users/{uid}
users/{uid}/workspaces/v1
users/{uid}/workspaces/v1/records/{recordKey}
users/{uid}/workspaces/v1/tombstones/{tombstoneId}
users/{uid}/workspaces/v1/assets/{assetId}
```

Attachment bytes use:

```text
users/{uid}/workspace-v1/assets/{assetId}/{objectId}
```

`recordKey` is a stable URL-safe encoding of record type plus logical ID. It is deterministic but not secret. The document also contains the explicit record type and logical ID so the client can validate identity before applying it.

Every record document contains:

- `recordType`
- `logicalId`
- `schemaVersion`
- validated plaintext `payload`
- `revision`, starting at 1 and increasing by exactly 1
- `mutationId`
- `writerId`
- `deleted`
- `updatedAt`, assigned by Firestore

Documents are bounded below Firestore's size limit, including metadata overhead. A serialized record that exceeds the configured safe bound remains local and produces a compact synchronization error. Large binary content belongs in Firebase Storage rather than a Firestore payload.

### Record families

The existing portable serializers are retained conceptually, moved out of the vault namespace, and stripped of cryptographic IDs and key dependencies. The synchronized families are:

- `credential-service`, one record per provider service, including its plaintext setup and API keys.
- `model-service`, one record per provider service's model configuration.
- `settings`, one record per narrow settings group.
- `persona`, one record per persona ID.
- `folder`, one record per folder ID.
- `scratch`, one record per Scratch logical record.
- `chat-meta`, one record per conversation containing titles, flags, ordering metadata, and other non-message state.
- `chat-message`, one finalized message per stable message ID, including its conversation ID.
- `asset`, one metadata record per attachment.

Streaming or incomplete assistant messages are not uploaded. Finalization creates or updates the stable `chat-message` record. Splitting chat metadata from messages means simultaneous message additions merge as a union of IDs instead of competing replacements of an entire conversation snapshot.

### Deletion model

Deletes write a canonical deleted record revision and an immutable tombstone. Tombstones are retained indefinitely for this greenfield service. A stale pending write based on a revision before the deletion is never automatically rebased across that deletion.

An explicit recreation after the client has observed the tombstone is a new incarnation and may reuse a user-facing logical identifier only through the serializer's deliberate recreation path. Routine settings resets write a default settings payload rather than deleting the singleton settings record.

This prevents an old tab or reconnecting device from silently resurrecting deleted chats, messages, personas, folders, or assets.

## Synchronization protocol

### Local mutation capture and coalescing

Serializer subscriptions emit logical `put` or `delete` mutations. Applying a local mutation performs these steps immediately:

1. Update the existing runtime store through its normal API.
2. Increment the record's persisted local generation counter.
3. Replace that record's pending outbox entry with the newest validated snapshot and generation.
4. Open a 60-second coalescing window if one is not already open.

At the end of the window, the coordinator sends only the newest snapshot for that record. Continuous editing therefore produces at most one normal Firestore write per record per minute, not one write per keystroke. The next edit after a flush opens the next window. Content identical to the acknowledged canonical value is removed from the outbox without a network write.

Explicit lifecycle operations such as sign-out may request an immediate best-effort drain so acknowledged user work is not discarded. This is an exceptional boundary operation, not the normal edit path.

### Compare-and-set transaction

Each outgoing mutation includes the last remote revision observed for that record. A Firestore transaction reads the canonical document and:

- Treats an already committed matching `mutationId` as success without another revision.
- Creates a missing document at revision 1 when permitted.
- Accepts an update only from the expected base revision and writes the next revision.
- Rejects malformed identities, schemas, or unsafe sizes before the runtime can apply them.

Security rules independently require valid ownership, claims, epoch, document shape, bounded fields, and an exact revision increment. The transaction supplies convergence semantics; the rules protect the account boundary and document invariants.

### Acknowledgement safety

Every sent snapshot is tagged with its local generation and mutation ID. Listener events with Firestore `hasPendingWrites` metadata are local echoes and are never applied back into runtime stores.

When the server-committed event arrives:

- If its mutation ID matches the in-flight mutation, it acknowledges only the sent generation.
- If the local generation is still equal to the sent generation, the record becomes clean.
- If the local generation has advanced, the acknowledgement updates the remote base revision but leaves the newer pending snapshot and runtime value untouched.

An acknowledgement never calls a serializer's `apply` method with the sent snapshot. This invariant directly prevents old acknowledgements from reverting newer keystrokes.

### Remote application

A server-committed remote record is schema-validated before use.

- If the record has no newer local generation, apply it under mutation-observer suppression and persist the new base revision.
- If a newer local generation exists, retain the local runtime value, record the newer remote base, and allow the pending local mutation to converge according to its record policy.
- If validation fails, quarantine metadata about the failure, keep the valid local value, and show one compact synchronization error without payload details.

### Automatic conflict policies

- Chat message additions merge by stable message ID.
- Independent records converge independently.
- Replaceable settings, credentials, models, and chat metadata use latest server-committed write wins. On a base-revision race, the coordinator reads the canonical record and retries the still-current local generation against that revision.
- A stale put is not retried across a deletion tombstone.
- Stable ID collisions with different chat-message contents are treated as validation errors rather than silently replacing a message.

There are no routine conflict prompts or conflict-copy conversations.

## Attachments

Attachment bytes upload directly to the authenticated UID's Firebase Storage path using resumable uploads. Firestore stores validated plaintext metadata, including object IDs, content type, byte size, content hash, upload state, and referencing records.

Storage rules require matching UID, Private Pro claim, allowed path, bounded object size, and permitted metadata. Downloads use the authenticated Firebase client. Upload progress and retry are background status only and never block unrelated chats or settings.

Deleting an attachment writes the Firestore tombstone and removes its Storage objects. A failed object cleanup is retryable administrative debris; the tombstone remains canonical so stale clients cannot restore the reference.

## Authentication, revocation, and account switching

The existing Google sign-in and server bootstrap flow remains:

1. Firebase Authentication completes Google sign-in.
2. Vercel verifies the ID token, email verification, and approved-email allowlist.
3. Vercel activates the account document and sets `privatePro` plus `privateProEpoch` claims.
4. The browser refreshes its ID token and opens the UID-scoped local workspace.

Removing an email from the allowlist, deactivating an account, or incrementing its epoch stops new Firestore and Storage operations once the rules observe the mismatched account state and token claim. Administrative revocation also revokes Firebase refresh tokens.

Sign-out stops listeners, makes a short best-effort pending drain when online, clears runtime stores, clears the UID-scoped sync database and portable cache, broadcasts the sign-out to other tabs, signs out of Firebase, and reloads to the account gate. Cloud data remains. If pending work cannot be drained, the sign-out UI states that unsynchronized local changes will be discarded before final confirmation.

No approved account can open another approved account's local cache or Firebase workspace.

## Failure behavior

- **Network loss after opening:** continue locally, persist pending mutations, show `offline`, and retry automatically.
- **Firebase listener interruption:** retain local state and outbox; reconnect with capped exponential backoff and jitter.
- **Expired token:** pause network work, refresh authentication, and retry.
- **Permission or epoch failure:** stop synchronization and return to the authentication/access screen without exposing cached data to another account.
- **Firestore quota or billing failure:** continue locally and show the exact non-secret category.
- **Oversized or invalid local record:** retain it locally, do not send it, and show one compact error.
- **Invalid remote record:** quarantine it and never replace valid local state.
- **Attachment failure:** retain metadata and retryable upload state without blocking text records.
- **Application restart:** reload the account-scoped local workspace and resume the durable outbox after bootstrap.

## User interface

Remove all vault-specific setup and management surfaces:

- Password creation and unlock.
- Recovery-key display and recovery flow.
- Remembered-device enrollment and revocation recommendations.
- Encrypted backup import and export.
- Blocking hydration and reconnect gates.
- Vault-specific full-wipe controls and error copy.

Keep Google sign-in, access-denied handling, account display, sign-out, and a compact background sync indicator. Normal operation requires no synchronization settings. Errors provide retry or sign-in actions without exposing data values.

## Destructive cutover

The cutover preserves only Firebase Authentication identities and approved account records.

1. Deploy Firestore and Storage rules for the new `workspaces/v1` and `workspace-v1` paths before enabling the client.
2. Delete all old encrypted vault records, tombstones, keysets, devices, challenges, operations, restore sessions, backup receipts, security events, and encrypted asset objects.
3. Increment every preserved account's access epoch, clear stale Private Pro claims as needed, and revoke refresh tokens so every browser signs in again.
4. Deploy the new sync client and remove the encrypted vault tRPC procedures, repositories, services, crypto modules, password workers, backup code, device code, UI, and tests that assert encrypted behavior.
5. On first launch of the new build, delete old Private Pro vault IndexedDB databases and plaintext runtime remnants before creating the UID-scoped v1 cache.
6. Run emulator and live two-browser verification before treating the service as available.

There is no dual-read, dual-write, import, migration journal, or rollback compatibility layer. During the greenfield launch window, rollback is destructive: disable Private Pro or wipe `workspaces/v1` and redeploy. Once real user data is declared durable, future rollbacks must preserve v1 plaintext data or use a separately approved migration.

## Implementation boundaries

Retain and adapt:

- `src/modules/private-pro/auth/**`
- `src/modules/private-pro/config/**`
- `src/modules/private-pro/firebase/firebase.client.ts`
- The logical schemas and store adapters currently under `vault/serializers/**`
- Existing attachment serialization and blob-reference discovery where it is independent of encryption

Replace with focused sync modules:

- `ProviderPrivateProSync`
- Firestore record repository and listener adapter
- Durable coalescing outbox
- Generation and acknowledgement state machine
- Plaintext serializer registry
- Direct Storage asset client
- Compact sync status store and account-clearing lifecycle

Delete after equivalent behavior is verified:

- `src/modules/private-pro/vault/**`
- Vault password, keyset, crypto, device, registration, recovery, restore, and backup UI/modules
- Encrypted vault server router, service, repository, and transport
- Private Pro encrypted backup integration under `src/modules/trade`
- Crypto-only workers and dependencies that have no remaining callers

The implementation should keep units small: serialization, outbox scheduling, Firestore transactions, listener reconciliation, assets, and React lifecycle each have separate public interfaces and tests.

## Verification

### Unit tests

- Every serializer validates, normalizes, applies, removes, and suppresses remote echoes.
- The 60-second scheduler replaces repeated mutations with the newest generation and emits at most one normal write per record per window.
- Identical acknowledged content produces no write.
- Acknowledging generation N cannot apply or clear generation N+1.
- Local Firestore echoes are ignored.
- Remote records apply only when no newer local generation exists.
- Replace policies retry only the still-current local generation.
- Stale puts do not cross tombstones.
- Chat messages split from chat metadata and merge by stable ID.
- Invalid, oversized, and ID-colliding records remain unapplied and report sanitized errors.
- Sign-out clears the correct UID namespace and no other account namespace.

### Firebase Emulator integration tests

- Anonymous, wrong-UID, missing-claim, inactive-account, and stale-epoch reads and writes are denied.
- Valid users can access only their own `workspaces/v1` records and Storage paths.
- Rules enforce bounded document shapes, exact revision increments, and allowed record families.
- Duplicate mutation IDs are idempotent.
- Multiple tabs sharing one UID elect one flush coordinator, recover after coordinator loss, and do not duplicate or reorder outbox writes.
- Two simulated devices append different messages to one chat without loss.
- Two devices changing one settings record converge to the latest server-committed value.
- A stale tab cannot resurrect a deleted entity.
- Offline pending records upload after reconnect.
- Attachment upload, resume, download, deletion, and cross-account denial work.

### Browser verification

- Sign in to one account in two independent browser profiles.
- Type continuously for several minutes and confirm no record writes more frequently than once per minute during normal editing.
- Confirm an acknowledgement never moves the input or setting back to an older value.
- Add messages concurrently on both profiles and confirm both appear.
- Change the same setting on both profiles and confirm deterministic convergence without a prompt.
- Disconnect one profile, edit, reconnect, and confirm automatic convergence.
- Delete an entity while the other profile is stale and confirm it is not resurrected.
- Upload and resume an attachment.
- Sign out and confirm local plaintext stores and sync databases are removed.
- Sign in as another approved account and confirm an empty, isolated workspace.

### Repository verification

- `tsc --noEmit --pretty`
- `npm run lint`
- Relevant unit and integration tests
- Firebase Emulator Suite rule tests
- `npm run build` when runtime or bundling behavior warrants the full check

The implementation workflow never starts or stops a development server.

## Acceptance criteria

The replacement is complete when an approved user can sign in, use Big-AGI immediately, and see chats, messages, settings, credentials, models, personas, folders, Scratch content, and attachments converge across devices without vault ceremony or manual conflict management. Routine edits remain local-first, Firestore writes are coalesced, acknowledgements cannot revert newer work, stale clients cannot resurrect deletions, and every Firebase path remains isolated to the authenticated UID and current account epoch.
