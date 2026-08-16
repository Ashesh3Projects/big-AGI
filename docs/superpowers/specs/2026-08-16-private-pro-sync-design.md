# Private Pro Sync Design

## Summary

Build a private hosted variant of Big-AGI on branch `pro`. Vercel hosts the application and its trusted server endpoints. Firebase provides Google authentication, Firestore synchronization, and Cloud Storage for attachments. Access is limited to a small server-side email allowlist. Every approved account receives the private Pro entitlement automatically. There is no billing, subscription, seat, or public registration flow.

The implementation is an independent MIT-compatible hosted layer for this fork. It does not copy or depend on Big-AGI's unavailable private `dev` implementation.

## Goals

- Allow Google sign-in for 4-5 approved email addresses.
- Reject every unapproved account before it can use cloud resources.
- Give every approved account the private Pro entitlement automatically.
- Keep each account's chats, personas, and attachments isolated.
- Preserve Big-AGI's local-first and offline behavior.
- Automatically upload existing local chats, personas, and attachments after the first approved sign-in.
- Synchronize changes across devices in near real time.
- Enforce a 1 GiB attachment quota per account.
- Deploy the application on Vercel and use Firebase Blaze with no-cost quotas where possible.

## Non-goals

- Stripe, subscriptions, billing, seats, family plans, or public signup.
- Sharing chats or attachments between approved accounts.
- Synchronizing model configuration, provider API keys, general settings, notes, rambles, or Scratch Clip history.
- Synchronizing incognito chats or incomplete AI generations.
- Reproducing the private Zync protocol or claiming compatibility with Big-AGI Pro.
- End-to-end encryption beyond Firebase and HTTPS transport/storage protections.
- Perfect semantic merging of concurrent edits to the same chat.

## Architecture

### Application

The Next.js application remains on Vercel. Existing Edge AI routes stay unchanged. Authentication bootstrap, sync mutations, quota operations, and signed attachment upload endpoints run in the Node.js cloud router because they require Firebase Admin credentials.

### Firebase

- Firebase Authentication supplies Google sign-in.
- Firestore stores account state, chat manifests and chunks, personas, tombstones, device records, migrations, quota reservations, and attachment metadata.
- Cloud Storage stores attachment bytes under user-scoped paths.
- Firebase App Check protects direct client Firestore access where supported.
- Firebase Admin SDK runs only on Vercel.

### Trust boundary

The browser may authenticate with Google and read its own synchronized data, but it cannot assign entitlements, alter another account, reserve arbitrary quota, or upload directly without server authorization. Vercel verifies Firebase ID tokens, canonicalizes the email address, checks the allowlist, and performs privileged operations.

## Authentication and entitlement

### Configuration

The deployment defines:

- `PRIVATE_PRO_ALLOWED_EMAILS`: comma-separated, normalized Google email addresses.
- Firebase public web configuration for the browser.
- Firebase Admin service-account credentials for Vercel.
- Firebase Storage bucket name.
- Optional App Check configuration.

Secrets remain server-only. Public Firebase web configuration is not treated as a secret.

### Sign-in flow

1. The user signs in with Google through Firebase Authentication.
2. The browser obtains a Firebase ID token and calls the Vercel bootstrap endpoint.
3. Vercel verifies the token, requires a verified email, and checks the normalized email against the allowlist.
4. Vercel creates or updates the account record and sets the `privatePro` custom claim.
5. The browser refreshes its ID token and opens the synchronized vault.
6. Rejected users are signed out and shown a terse access-denied screen.

The backend derives account identity from the verified token. Client-provided UIDs or email addresses never select an account.

### Session revocation

Removing an email from the allowlist blocks Vercel bootstrap and privileged endpoints immediately. The administrative revocation command clears the custom claim, increments the account access epoch, and revokes Firebase refresh tokens. Firebase ID tokens already issued can remain valid briefly, so the design does not promise instantaneous invalidation of every direct Firebase request. Sensitive mutations require the current access epoch or a fresh server check.

## Browser vault binding

Automatic migration creates a privacy risk when multiple approved people use the same browser profile. To prevent uploading one person's local data into another account:

- An unbound browser profile binds to the first approved Firebase UID that enables sync.
- The binding is stored locally and included in the migration journal.
- Signing into a different UID in the same browser profile does not upload or expose the existing local vault.
- The UI requires exporting or explicitly resetting the local synchronized vault before rebinding.
- Signing back into the bound UID resumes normally.

The device identifier is distinct from this account binding and may be reused for telemetry-free device registration.

## Synchronized data

### Included

- Non-incognito conversations with messages and persisted metadata.
- User-created personas.
- Binary assets referenced by synchronized conversations or personas.
- Minimal synchronization metadata: revisions, hashes, devices, tombstones, migration state, and quota state.

### Excluded

- LLM/provider configuration and API keys.
- `localStorage` as a whole.
- App settings, UI preferences, workspace file handles, metrics, logs, Scratch Clip history, notes, and rambles.
- Incognito chats.
- Empty unsaved chats unless the existing persistence rules save them.
- Abort controllers and other transient fields.
- Messages marked incomplete while an AI response is streaming.

Serialization uses explicit allowlists and schemas. It never serializes raw Zustand state wholesale.

## Firestore model

All documents live below `users/{uid}`. Security rules require `request.auth.uid == uid`, `privatePro == true`, and the current account access epoch where appropriate.

Suggested collections:

```text
users/{uid}
users/{uid}/devices/{deviceId}
users/{uid}/chats/{chatId}
users/{uid}/chats/{chatId}/chunks/{chunkId}
users/{uid}/personas/{personaId}
users/{uid}/assets/{assetId}
users/{uid}/tombstones/{entityKey}
users/{uid}/migrations/{migrationId}
users/{uid}/quotaReservations/{reservationId}
```

### Chats

The chat manifest contains identity, titles, archive state, timestamps, schema version, revision, content hash, ordered chunk IDs, referenced asset IDs, and deletion state. Messages are serialized into deterministic size-limited chunks so no Firestore document approaches the 1 MiB limit. Chunk boundaries are stable when possible to avoid rewriting the entire conversation after a small append.

### Personas

Each persona is one document with an explicit schema version, revision, content hash, timestamps, and sanitized persona data. Remote data passes the same runtime schema used by migration and local hydration.

### Tombstones

Deletes create tombstones containing entity type, entity ID, base revision, deletion revision, device ID, and timestamp. Tombstones propagate deletion and prevent an offline stale device from resurrecting removed data. A scheduled or administrative maintenance command may compact old tombstones only after a conservative retention period.

### Assets

Firestore holds metadata only: content type, byte size, hash, storage path, timestamps, referencing entities, and upload state. Cloud Storage holds the bytes at a path derived from the verified UID and asset ID.

## Local sync engine

### Local-first behavior

Existing local storage remains the immediate source used by the UI. The sync layer observes durable entity changes and records operations in a dedicated IndexedDB outbox. Network availability never blocks chat editing or AI use.

The local sync database stores:

- Account binding.
- Outbox operations.
- Last acknowledged remote revision per entity.
- Migration journal.
- Remote cursor/listener state.
- Quarantined invalid records.

### Upload behavior

- Durable changes enter the outbox after a short debounce.
- Incomplete streamed messages do not upload.
- A finalized message or edit produces a serialized entity revision.
- Identical content hashes are ignored.
- Operations retry transient failures with capped exponential backoff and jitter.
- Authentication, permission, schema, and quota failures stop retrying and surface a user-visible sync status.

### Download behavior

Firestore listeners receive manifests, personas, tombstones, and attachment metadata for the signed-in UID. The client validates schemas and revisions before merging them into local state. Invalid or oversized records are quarantined and never replace valid local data.

### Conflicts

Every mutation supplies the base revision it observed. A server transaction accepts the write only when the base revision matches the current revision.

If two devices edit the same entity concurrently:

- The first accepted mutation becomes the next canonical revision.
- The rejected client downloads the canonical revision.
- If its local content differs, it creates a new conflict copy with a new entity ID and a title suffix indicating the originating device and time.
- Both versions remain available. No user data is silently discarded.

The sync engine uses its own revisions and hashes. Existing chat `updated` timestamps are presentation metadata and are not conflict clocks.

## Automatic first migration

The first approved sign-in starts migration automatically after the browser vault is bound.

1. Inventory eligible local chats and personas using the same filters as normal persistence.
2. Inventory only binary assets referenced by eligible entities.
3. Create an idempotent migration journal keyed by UID, device ID, and local entity ID.
4. Upload entity manifests, chunks, personas, and attachments in bounded batches.
5. Mark each item complete only after remote verification.
6. Resume unfinished items after reload, crash, or connectivity loss.
7. Start continuous sync without deleting local source data.

Stable IDs and content hashes make retries idempotent. Existing remote entities are merged using the normal revision rules rather than overwritten blindly.

## Attachment upload and quota

### Quota

Each account receives a 1 GiB attachment quota. Firestore text does not count toward this product quota, but Firebase platform quotas still apply.

Aggregate quotas cannot be safely enforced only with Cloud Storage rules. Client writes to the synchronized attachment prefix are denied by default.

### Upload flow

1. The client asks Vercel to reserve bytes for an asset hash and size.
2. Vercel verifies the user, allowlist, claim, file limit, rate limit, and available quota in a Firestore transaction.
3. Vercel creates a short-lived, path-scoped signed upload URL and reservation.
4. The browser uploads directly to Cloud Storage.
5. The client calls finalize.
6. Vercel reads authoritative object metadata, verifies size, hash metadata where available, path, and content type, then converts reserved bytes to used bytes.
7. Failed or expired uploads release reservations. Orphan cleanup deletes unfinalized objects.

Reads use authorized Firebase access or short-lived signed downloads. Storage paths are never accepted from arbitrary client input.

### Limits

- 1 GiB total attachment bytes per account.
- Configurable maximum bytes per individual file.
- Configurable request and byte rate limits per UID.
- Content-type allowlist compatible with Big-AGI attachments.
- Deduplication by content hash within an account where safe.

## Security rules

Firestore rules enforce authenticated UID ownership, the private Pro claim, access epoch, allowed document shapes, and bounded field sizes. Client writes are limited to the safe read/list surface or disabled for collections whose invariants require server transactions.

Storage rules deny arbitrary writes to synchronized asset paths. Reads require matching UID, entitlement, and expected object paths. Uploads use Vercel-authorized signed URLs and are finalized server-side.

The Firebase Emulator Suite tests rules against cross-account access, missing claims, stale epochs, malformed documents, direct uploads, and deleted accounts.

## UI

The hosted variant adds:

- Google sign-in and account menu.
- Access-denied screen for unapproved accounts.
- Compact sync state: local, migrating, syncing, synced, offline, conflict, quota blocked, or error.
- Migration progress during first sign-in.
- Storage usage display.
- Conflict-copy notification.
- Sign-out without deleting local data.
- Explicit export/reset flow before changing the account bound to a browser profile.

Disabling or signing out of sync never deletes local data. The application remains useful offline after prior hydration.

## Failure handling

- Firebase outage: continue locally and retain the outbox.
- Vercel outage: continue locally; privileged operations retry later.
- Token expiry: pause sync, refresh authentication, and retry.
- Allowlist removal: stop sync, revoke sessions administratively, preserve local data.
- Firestore quota exhaustion: pause remote operations and present the exact category.
- Attachment quota exhaustion: reject new reservations without affecting existing data.
- Corrupt remote data: quarantine and report; never overwrite local state.
- Migration interruption: resume from the journal.
- Partial attachment upload: expire reservation and delete orphaned object.

## Testing

### Unit tests

- Email normalization and allowlist decisions.
- Explicit serialization exclusions for API keys, model settings, notes, incognito chats, and transient fields.
- Deterministic chat chunking and size bounds.
- Content hashing, revisions, conflict copies, and tombstones.
- Migration journaling and idempotency.
- Browser vault binding.
- Quota reservation, finalization, expiration, and deduplication.
- Retry classification and backoff.

### Emulator integration tests

- Google-token-equivalent authenticated sessions in the Firebase Emulator Suite.
- Account isolation across Firestore and Storage.
- Claim and access-epoch enforcement.
- Direct-upload denial.
- Two simulated devices editing, deleting, going offline, and reconnecting.
- Automatic migration restart after interruption.
- Attachment reservation/finalization and quota exhaustion.

### Repository verification

- `npm run tscheck`
- `npm run lint`
- `npm test`
- Firebase Emulator Suite rule and integration tests
- `npm run build`

No dev server is started or stopped by the implementation workflow.

## Deployment

Deployment documentation will cover:

- Creating a Firebase project on Blaze.
- Selecting a no-cost-quota Storage region where applicable.
- Enabling Google Authentication.
- Creating Firestore and Storage resources.
- Configuring App Check.
- Installing Firestore indexes and security rules.
- Setting Vercel environment variables and Firebase Admin credentials.
- Defining the email allowlist and quota limits.
- Running administrative entitlement sync and revocation commands.
- Monitoring Firebase usage and setting Google Cloud billing budgets/alerts. Budget alerts are notifications, not hard spending caps.

## Implementation boundaries

The hosted layer will be isolated under focused authentication and sync modules. Existing chat and persona stores receive narrow adapters or subscriptions instead of broad rewrites. The `authedProcedure` and `premiumProcedure` compatibility points become real middleware on branch `pro`. Cloud/auth/sync changes remain branch-specific and are not intended for upstream `main`.
