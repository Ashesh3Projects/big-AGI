# Private Pro Encrypted Vault Design

## Summary

Extend the private Pro deployment into a full multi-device encrypted vault. The vault synchronizes chats, personas, attachments, AI provider configuration, API keys, model configuration, and portable application settings. Encryption and decryption happen only in the browser. Firebase and Vercel store ciphertext plus minimal synchronization metadata and never receive the vault password or unwrapped vault master key.

Private Pro is online-gated. After Google sign-in, startup remains blocked until the device unlocks the vault, downloads the latest accepted server revisions, decrypts them, applies them locally, and reaches a current synchronized state. An existing remembered device unlocks automatically until explicit logout. A new device requires the vault password or printable recovery key.

This design replaces the earlier explicit exclusion of model configuration, API keys, general settings, and plaintext cloud records. It does not change the Open/self-hosted build.

## Goals

- Recreate the user's portable Big-AGI experience on a new computer after Google sign-in and vault unlock.
- Synchronize AI providers, endpoints, API keys, custom models, model parameters, assignments, and portable settings.
- End-to-end encrypt chats, personas, settings, credentials, and attachment bytes before cloud upload.
- Store no raw vault password or plaintext vault data in Firebase, Vercel logs, analytics, or cloud metadata.
- Remember an unlocked browser securely until explicit logout.
- Download and apply all latest remote revisions before the user may edit or use the app.
- Merge independent settings records without losing unrelated changes from another computer.
- Use server-assigned monotonic revisions instead of device clocks for conflict decisions.
- Migrate existing plaintext local and cloud data without loss, then remove legacy plaintext copies after verification.
- Harden the live application before encrypted credential synchronization is enabled.

## Non-goals

- Supporting offline startup or offline editing in private Pro.
- Protecting data on an already-unlocked compromised device.
- Protecting against a malicious browser extension, compromised operating system, or malicious JavaScript served by a compromised deployment account.
- Making Firebase project administrators unable to delete ciphertext or synchronization metadata.
- Recovering a vault after the password, recovery key, and all remembered devices are lost.
- Synchronizing browser permissions, filesystem handles, transient UI state, logs, metrics, caches, Firebase sessions, or device identifiers as user configuration.
- Synchronizing incognito chats or incomplete generations.

## Threat model

### Protected

- Accidental or unauthorized Firebase database and Storage reads expose ciphertext, not user content or API keys.
- Cross-account Firebase access is denied by UID, entitlement, and access epoch.
- Vercel request handlers and logs do not see plaintext synchronized content.
- A leaked storage object or database export does not reveal plaintext.
- A stolen vault password database does not exist because the server never receives the password.
- Tampering with ciphertext, record identity, type, schema, or revision is detected during authenticated decryption.

### Not protected

- An unlocked browser can use the decrypted secrets required to operate Big-AGI.
- A malicious extension or compromised OS can observe keystrokes, DOM state, or network requests from the unlocked browser.
- Malicious code deployed to the production origin can access the unlocked vault. Deployment-account security and content-execution hardening remain critical.
- A user can intentionally export or copy their own keys and data.

## Architecture

### Browser

The browser is the only plaintext trust boundary. It owns:

- Password-based key derivation and recovery-key parsing.
- Vault master-key wrapping and unwrapping.
- Record and attachment encryption/decryption.
- Explicit portable-state serialization and validation.
- Remembered-device key storage in IndexedDB.
- Blocking startup hydration and application of remote revisions.
- Local mutation observation and encrypted upload.

Plaintext durable state must no longer be stored in ordinary localStorage or plaintext IndexedDB for private Pro. Runtime stores may hold decrypted values in memory while the vault is unlocked. Durable browser persistence is encrypted.

### Vercel

Vercel remains the only mutation authority. It:

- Verifies Firebase ID tokens, App Check tokens, allowlist membership, entitlement, and access epoch.
- Assigns monotonically increasing record revisions and authoritative server timestamps.
- Enforces compare-and-swap writes and record size limits.
- Stores opaque encrypted envelopes and attachment chunks.
- Never receives the password, password-derived key, unwrapped master key, plaintext records, or plaintext attachment bytes.

### Firebase

Firestore stores account state, wrapped-key metadata, encrypted record manifests, encrypted record payloads, tombstones, device metadata, migration journals, and quota state. Cloud Storage stores encrypted attachment chunks. Direct browser writes remain denied. Direct browser reads are removed for vault ciphertext where practical and replaced with authenticated Vercel reads so App Check, entitlement, and current account state are checked consistently.

## Cryptography

### Vault master key

- Create one random 256-bit vault master key with `crypto.getRandomValues`.
- Use AES-256-GCM for record and attachment encryption.
- The master key is exportable only during initial wrapping inside the browser and is immediately re-imported as non-exportable for normal use.
- The plaintext master-key bytes are zeroed on a best-effort basis after wrapping. JavaScript cannot guarantee physical memory erasure.

### Password wrapping

- Derive a 256-bit key-encryption key from the user password with Argon2id in a browser worker.
- Parameters are versioned and calibrated to a target duration on supported devices, with minimum memory and iteration floors defined by implementation tests.
- Use a unique random salt per vault.
- Wrap the vault master key with AES-256-GCM using the password-derived key.
- Store only the salt, Argon2id parameters, wrapping nonce, wrapped master key, key version, and verifier metadata.
- Password changes rewrap the same vault master key and do not re-encrypt all records.

PBKDF2-SHA-256 may be supported only as a compatibility fallback for browsers where the selected Argon2id implementation cannot run. New vaults prefer Argon2id.

### Recovery key

- Generate an independent random 256-bit recovery key.
- Display it once as a printable grouped base32 string with a checksum.
- Use it to wrap the same vault master key in a separate AES-256-GCM envelope.
- Store only the recovery-wrapped master key and metadata in the cloud.
- A recovery unlock requires the complete recovery key and permits setting a new password.

### Remembered device

The raw password is never stored. After a successful password or recovery unlock:

1. Generate a device key-encryption key as a non-exportable AES-GCM `CryptoKey`.
2. Store the non-exportable key through IndexedDB structured cloning.
3. Wrap the vault master key with the device key.
4. Store the device-wrapped master key and non-secret metadata in the encrypted-vault IndexedDB database.

Reloads and browser restarts unwrap automatically. Explicit logout deletes the device key, device-wrapped master key, decrypted caches, Firebase local authentication state, and all plaintext runtime stores. Clearing browser storage requires password or recovery-key entry again.

### Record encryption

Each record has a stable identity and is encrypted independently. AES-GCM additional authenticated data binds:

- Vault format version.
- UID-derived vault identifier.
- Record type.
- Record ID.
- Schema version.
- Server revision targeted by the envelope.
- Cipher suite and key version.

Every encryption uses a fresh random 96-bit nonce. Nonces are stored with ciphertext. The server rejects duplicate operation IDs and assigns revisions transactionally. Clients reject envelopes whose authenticated metadata does not match their expected record identity.

### Hashes and leakage

Plain SHA-256 hashes of low-entropy secrets or settings must not be stored because they enable guessing. Content deduplication identifiers use HMAC-SHA-256 under a key derived from the vault master key. Firebase may observe ciphertext sizes, record types, update frequency, revisions, and opaque record IDs. These are accepted metadata leaks.

## Vault records

### Record granularity

Use a segmented vault rather than one global snapshot. Independent records prevent an unrelated edit from overwriting newer data from another device.

Record families:

- `credential-service/{serviceId}`: provider setup including API keys, endpoints, organizations, regions, and client-side-fetch choice.
- `model-service/{serviceId}`: service label, model catalog customizations, visibility, pricing, parameters, clones, and assignments scoped to that service.
- `settings/{groupId}`: one explicit portable settings group per existing store or cohesive subset.
- `chat/{chatId}`: one non-incognito finalized conversation.
- `persona/{personaId}`: one user persona.
- `folder/{folderId}`: chat folder metadata.
- `scratch/{recordId}`: portable Scratch Clip content and bounded history.
- `asset/{assetId}/chunk/{chunkId}`: encrypted attachment chunks plus an encrypted asset manifest.
- `tombstone/{recordType}:{recordId}`: encrypted deletion intent with visible opaque routing metadata.

Provider credentials and model configuration may be serialized together when they share one existing service object, but their record type remains explicit so future schema migration can split them safely.

### Included portable data

- AI providers, custom endpoints, API keys, regions, organizations, vendor-specific setup, and client-side-fetch preferences.
- Model catalogs, custom models, labels, visibility, stars, context/output overrides, pricing, parameters, and assignments.
- Chat, call, Beam, image, speech, browsing, Google integration, UI, theme, UX labs, folders, and other user-facing configuration.
- Chats, personas, folders, referenced assets, and Scratch Clip content.
- Share-management deletion credentials and other secrets required to manage user-created resources.

### Excluded data

- Firebase refresh/ID tokens and Google OAuth session state.
- Browser device ID, vault device binding ID, and remembered-device key.
- File System Access API handles and browser permissions.
- Logs, metrics, PostHog/analytics identifiers, caches, generated build metadata, and transient modal/pane state that does not affect the portable experience.
- Abort controllers, active streams, pending uploads, temporary drafts not durably saved by the app, incomplete AI generations, and incognito chats.

### Explicit serializers

Do not upload localStorage wholesale. Define a versioned serializer and parser for every included record family. Each serializer must:

- Include only portable fields.
- Validate with Zod before encryption and after decryption.
- Separate secrets from telemetry and logs.
- Reject functions, class instances, `CryptoKey`, file handles, object URLs, DOM objects, and unknown transient fields.
- Support deterministic record discovery without exposing plaintext record names to the server.

The existing full JSON export remains available as a manual tool but receives an encrypted export option before credential sync ships. The UI must warn that legacy unencrypted exports contain API keys.

## Startup and online gate

Private Pro requires the following ordered gate:

1. Establish network connectivity to the application and authentication services.
2. Restore or complete Google sign-in.
3. Verify allowlist entitlement and current access epoch through Vercel.
4. Load wrapped-key metadata.
5. Auto-unlock with the remembered device key, or request password/recovery key.
6. Download the remote record index and every remote revision newer than the local encrypted cache.
7. Decrypt, validate, and stage all downloaded records.
8. Resolve pending local encrypted operations against current server revisions.
9. Atomically apply the staged current vault to runtime stores.
10. Enable the application only after no unapplied newer remote revision remains.

If connectivity, authentication, App Check, decryption, validation, or synchronization fails, show a blocking reconnect/unlock/recovery screen. Do not open the app with stale portable settings. There is no private Pro offline mode.

## Synchronization and conflicts

### Server revisions

Every record has a server-assigned integer revision. The client submits:

- Record type and opaque record ID.
- Base revision.
- Idempotent operation ID.
- Ciphertext envelope targeting `baseRevision + 1`.

A Firestore transaction accepts the write only when the current revision equals the supplied base revision, then assigns the next revision and server timestamp. Device clocks are presentation-only and never decide ordering.

### Download-before-edit

Settings and application editing remain disabled until the startup gate applies all current remote revisions. This guarantees that opening PC B after an API key was added on PC A first downloads and applies that key. A subsequent theme change on PC B updates only the theme/settings record and cannot erase the credential-service record.

### Independent edits

Edits to different records merge naturally because each record has an independent revision. Settings groups must be narrow enough that unrelated settings do not share a conflict domain.

### Same-record conflicts

The latest server-accepted write wins for replaceable settings and credentials. When a client receives a revision conflict:

1. Download and decrypt the current canonical record.
2. Reapply the exact local user mutation to the canonical record when the mutation adapter supports it.
3. Encrypt and resubmit against the new base revision.

If the mutation cannot be replayed safely, keep the canonical record and show a conflict prompt containing no secret values. Chats keep the existing conflict-copy behavior rather than silently discarding either version.

### Connectivity loss

An unlocked running app that loses connectivity enters a blocking reconnect state before further portable mutations are accepted. It may preserve unsent typed composer text in encrypted local memory/storage, but it cannot perform AI calls or allow settings edits until current remote revisions are reconciled.

## Local encrypted persistence

Create a dedicated IndexedDB database for:

- Non-exportable remembered-device `CryptoKey`.
- Device-wrapped master-key envelope.
- Encrypted record cache.
- Encrypted outbox operations.
- Applied remote revisions and index cursor.
- Migration journal.
- Quarantined invalid ciphertext envelopes.

Private Pro store adapters must stop writing plaintext portable values to existing localStorage keys and plaintext IndexedDB cells. During the transition, reads may import legacy values once, but post-migration writes go only through encrypted persistence. Runtime Zustand stores continue to expose their current typed APIs so most UI code does not need cryptographic knowledge.

## Attachment encryption

- Encrypt attachments in bounded chunks in a worker before upload.
- Use a per-asset content-encryption key derived from the vault master key and asset ID through HKDF-SHA-256, or a random per-asset key wrapped by the master key.
- Each chunk uses a fresh nonce and binds asset ID, chunk index, plaintext byte length, content type, and schema as authenticated data.
- Store encrypted bytes only. Plain content type, filename, label, and origin metadata move inside the encrypted asset manifest.
- Server quota uses ciphertext size. The UI may display approximate plaintext usage after decrypting manifests.
- Signed upload URLs remain path-scoped, short-lived, and authorized after identity, entitlement, App Check, rate, and quota checks.
- Downloads return ciphertext only and are decrypted after hash and authenticated-encryption verification.

## Migration

### Preconditions

- Complete dependency and content-execution security hardening.
- Deploy and verify new encrypted schemas, endpoints, rules, App Check, and quotas.
- Require a fresh manual encrypted export before destructive plaintext cleanup.

### Local migration

1. Freeze portable edits behind the startup/migration screen.
2. Inventory all included legacy localStorage and IndexedDB records through explicit serializers.
3. Create or unlock the encrypted vault.
4. Encrypt every record and attachment into the local encrypted cache.
5. Decrypt and validate every local encrypted envelope before upload.
6. Upload in idempotent batches and verify server revisions and ciphertext hashes.
7. Download the resulting cloud index and verify it reconstructs the same portable state.
8. Mark the migration committed.
9. Remove included plaintext localStorage and plaintext IndexedDB values.

### Cloud migration

Existing plaintext chat/persona documents and plaintext attachment objects remain readable only during migration. The client downloads them through the authorized legacy path, validates them, encrypts them, and uploads encrypted replacements. After the client verifies the encrypted cloud copy:

- Vercel marks the account encryption migration complete.
- Legacy rules deny further plaintext reads.
- A server cleanup job deletes plaintext Firestore revisions and plaintext Storage objects.
- Cleanup is idempotent and retains a bounded encrypted migration audit record without plaintext.

Never delete a plaintext source until its encrypted replacement has been uploaded, downloaded, decrypted, and schema-validated successfully.

## Password, recovery, and logout

### First setup

- Require password entry twice.
- Reject weak passwords with a local strength meter and minimum length.
- Generate and display the recovery key before accepting setup completion.
- Require the user to confirm selected recovery-key groups.
- Create an encrypted export after vault creation and before legacy deletion.

### Password change

- Require an unlocked vault.
- Derive a new password wrapping key and upload a compare-and-swap wrapped-key version.
- Retain the recovery-wrapped master key.
- Invalidate old password envelopes after the new envelope is confirmed.

### Recovery

- Use the recovery key to unwrap the master key.
- Require setting a new password.
- Rotate the remembered-device key on the recovering device.
- Record a non-secret security event and offer revocation of all other remembered-device registrations.

### Logout

Explicit logout:

- Stops synchronization and removes Firebase authentication persistence.
- Deletes the remembered-device key and wrapped master key.
- Clears decrypted runtime stores and plaintext drafts.
- Removes decrypted caches and legacy plaintext storage.
- Retains only ciphertext that is useless without a future password/recovery unlock, or removes all local ciphertext when the user selects a full local wipe.

## Security hardening prerequisites

Encrypted credential sync must not be enabled until all items below pass verification.

### Dependency remediation

- Upgrade Next.js from 15.1.12 to a supported patched 15.x release, initially 15.5.23 or later compatible 15.x.
- Update direct vulnerable dependencies including nanoid and puppeteer-core where compatibility tests permit.
- Resolve Firebase Admin advisories without reintroducing the production ESM crash. Upgrade, override vulnerable transitive packages, or replace the affected path, then run the production bundle probe.
- Run `npm audit --omit=dev` and document any remaining advisories with reachability analysis and compensating controls. No reachable critical or high vulnerability may remain at release.

### Content execution and XSS

- Remove `allow-same-origin` from generated HTML iframes. Generated HTML must run in an opaque sandboxed origin with scripts and forms disabled by default. Any interactive opt-in mode must remain cross-origin and unable to access application storage.
- Sanitize SVG before every `dangerouslySetInnerHTML` path, including model-generated SVG, Mermaid output, PlantUML output, and live SVG.
- Do not insert untrusted error strings as HTML.
- Add tests proving generated HTML/SVG cannot read parent localStorage, IndexedDB, cookies, Firebase tokens, or vault objects.
- Add a production Content Security Policy compatible with required Firebase, Vercel, AI-provider, and worker connections. Avoid `unsafe-eval`; minimize `unsafe-inline` through nonces or hashes.

### HTTP headers

Set and verify at least:

- `Content-Security-Policy`.
- `Strict-Transport-Security` with includeSubDomains where domain ownership permits.
- `X-Content-Type-Options: nosniff`.
- `Referrer-Policy: no-referrer` or a documented equally strict policy.
- `Permissions-Policy` denying unused powerful features.
- `frame-ancestors 'none'` in CSP and `X-Frame-Options: DENY` as legacy defense.
- `Cross-Origin-Opener-Policy` where OAuth popup compatibility permits.

Remove unnecessary wildcard CORS response headers from HTML and authenticated API responses.

### Firebase and Google Cloud

- Enable Firebase App Check with reCAPTCHA Enterprise for the production web app.
- Roll out metrics first, then enforce App Check for Firestore, Storage, and every private Vercel procedure.
- Restrict the Firebase browser API key by exact production/referrer origins and only required APIs.
- Remove stale Firebase authorized domains and stale Storage CORS origins after deployment verification.
- Preserve Firestore UID, claim, active account, and epoch checks. Add encrypted-vault paths and cross-account emulator tests.
- Deny direct browser Storage access for new encrypted assets. Use authenticated short-lived signed URLs.
- Enable Firestore point-in-time recovery or scheduled encrypted exports if cost is accepted.
- Enable Firestore database deletion protection.

### Service identity

- Replace the broad `roles/firebase.sdkAdminServiceAgent` runtime grant with purpose-built least-privilege roles covering only required Auth, Firestore, Storage object, signing, and App Check verification operations.
- Prefer Vercel OIDC and Google Cloud Workload Identity Federation for short-lived runtime credentials.
- If Vercel runtime federation is not viable, create a dedicated least-privilege runtime service account, rotate the static key, store it only as a sensitive Vercel secret, and add a scheduled rotation procedure.
- Remove the legacy broad Admin SDK service-account key after the replacement is verified.

### Analytics and logging

- Keep PostHog and Google Analytics disabled for private Pro.
- Redact authorization headers, Firebase tokens, App Check tokens, vault envelopes, ciphertext, key metadata, API keys, provider request bodies, and decrypted validation errors from logs.
- Add automated secret-canary tests that fail if known sentinel credentials appear in server logs, client exceptions, or analytics payloads.

## Firebase model

Suggested opaque paths:

```text
users/{uid}
users/{uid}/vault/keysets/{keyVersion}
users/{uid}/vault/records/{opaqueRecordId}
users/{uid}/vault/tombstones/{opaqueRecordId}
users/{uid}/vault/devices/{deviceId}
users/{uid}/vault/migrations/{migrationId}
users/{uid}/vault/uploads/{operationId}
users/{uid}/vault/uploads/{operationId}/chunks/{chunkId}
users/{uid}/vault/assets/{assetId}
```

Cloud Storage:

```text
users/{uid}/vault/assets/{opaqueAssetId}/{chunkId}
```

Visible documents contain only UID-scoped authorization state, opaque IDs, revisions, server timestamps, ciphertext byte lengths, cipher metadata, and ciphertext. Plain provider names, filenames, chat titles, model names, and API-key labels remain encrypted.

## API boundaries

All private vault procedures require:

- Verified Firebase ID token from the Google provider.
- Verified email and allowlist membership.
- `privatePro` claim with current positive access epoch.
- Active matching account record.
- Enforced App Check token.
- Bounded Zod-validated request sizes and identifiers.

Required operations:

- Read vault bootstrap/keyset metadata.
- List current opaque record revisions.
- Fetch encrypted records in bounded pages.
- Compare-and-swap put encrypted record.
- Compare-and-swap tombstone record.
- Reserve/finalize/release encrypted attachment chunks.
- Rotate password/recovery envelopes.
- Register/revoke remembered-device metadata without uploading a device unlock key.
- Commit and clean up encryption migration.

Rate-limit password-envelope attempts, record mutations, index scans, and attachment operations per UID and source. Password validation remains local, so rate limiting primarily protects metadata and denial-of-service surfaces.

## UI

### Blocking screens

- Connecting.
- Google sign-in.
- Vault password entry.
- Recovery-key entry.
- Initial vault setup and recovery-key confirmation.
- Downloading latest vault.
- Migrating and verifying encrypted data.
- Reconnecting after connectivity loss.
- Security/version upgrade required.

### Account panel

- Sync status and last accepted server revision.
- Encrypted storage usage.
- Change vault password.
- Show recovery-key replacement flow.
- Revoke remembered devices.
- Create encrypted backup.
- Logout and local-wipe choices.

Never display secrets in conflict messages, logs, toast details, or account diagnostics.

## Failure handling

- Wrong password: keep ciphertext untouched and allow retry with bounded local delay.
- Lost password: allow recovery key.
- Lost password and recovery key: explain that recovery is impossible without an unlocked remembered device.
- Corrupt envelope: quarantine it, block startup if it is required state, and offer recovery from prior encrypted revision/export.
- Remote rollback: detect revision/index regression and block instead of silently applying older state.
- App Check failure: block with a specific retry message without falling back to an unprotected endpoint.
- Migration interruption: resume from the encrypted local and server journals.
- Quota exhaustion: block the affected upload without deleting existing encrypted data.
- Dependency/security gate failure: do not enable encrypted credential sync in production.

## Testing

### Cryptography

- Known-answer and round-trip tests for Argon2id, PBKDF2 fallback, HKDF, AES-GCM, recovery-key checksum, and envelope authenticated data.
- Wrong password, nonce, record ID, type, revision, schema, UID, and corrupted ciphertext must fail closed.
- Unique nonce tests across high-volume record and chunk encryption.
- Confirm raw password and master-key material are absent from serialized databases, network requests, logs, and thrown error messages.

### Persistence and logout

- Store and restore a non-exportable device `CryptoKey` through IndexedDB.
- Remembered-device auto-unlock survives reload and browser restart.
- Explicit logout destroys automatic unlock and decrypted local state.
- Private Pro durable stores contain ciphertext only after migration.

### Synchronization

- PC A adds an API key, PC B startup downloads it before enabling settings, and PC B changes theme without overwriting the key.
- Independent record edits merge.
- Same-record compare-and-swap conflicts retry only through explicit mutation replay.
- Server revisions, not device timestamps, determine order.
- Startup blocks with stale cache, offline state, failed decryption, or unapplied newer revisions.
- Remote rollback and replayed operation IDs are rejected.

### Migration and recovery

- Import all explicitly included stores and exclude every non-portable field.
- Encrypt and verify existing plaintext local chats, personas, settings, keys, and assets.
- Convert legacy Firebase data and delete plaintext only after end-to-end verification.
- Resume after interruption at every migration phase.
- Password change rewraps without record re-encryption.
- Recovery key restores and rotates password.

### Security

- Firebase emulator cross-account read/write denial for every encrypted path.
- Direct Storage reads and writes denied.
- App Check missing/invalid tokens denied on every private endpoint.
- Generated HTML and SVG cannot access application origin storage or execute unsafe payloads.
- CSP/header integration tests against the production build.
- Secret canaries do not appear in logs or analytics.
- Dependency audit has no reachable critical/high release blocker.

### Release verification

- Focused unit and integration tests.
- Full repository test suite, with live vendor failures classified separately.
- Firebase Emulator Suite.
- TypeScript and ESLint.
- Production build and Vercel bundle/runtime probes.
- Real two-browser-profile multi-device acceptance test.
- Migration rehearsal using a copied test vault before the production account migration.
- Post-deploy live checks for headers, Firebase rules, App Check, sign-in, unlock, download-before-edit, upload, logout, and recovery.

## Rollout

1. Land and deploy security hardening without changing existing sync payloads.
2. Add encrypted vault code behind a server and client feature flag.
3. Enable App Check monitoring, then enforcement.
4. Run a test-account encrypted migration and destructive cleanup rehearsal.
5. Require the production user to create a password, save the recovery key, and create an encrypted export.
6. Migrate local and cloud plaintext data to encrypted records.
7. Verify reconstruction on a second clean browser profile.
8. Delete legacy plaintext cloud data and local persistence.
9. Enable encrypted credential/settings mutation sync.
10. Monitor error rates, App Check rejection, quota, and migration completion without logging plaintext.

Rollback before plaintext cleanup may return to legacy sync. After verified plaintext cleanup, rollback must use the encrypted vault or restore from the encrypted export. Never reintroduce plaintext credential synchronization as a rollback path.

## Success criteria

- A clean computer can sign in, enter the vault password, and reproduce the current portable app configuration before the app opens.
- A remembered device opens without password entry until explicit logout.
- A key added on PC A appears on PC B before PC B can edit settings.
- A theme change on PC B does not overwrite unrelated credentials or model settings.
- Firebase, Vercel, logs, and exported cloud records contain no plaintext chats, settings, attachments, or API keys.
- Logout removes automatic local unlock and decrypted durable data.
- Cross-account, XSS, App Check, migration, recovery, and dependency release gates pass.
