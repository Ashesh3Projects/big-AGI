# Private Pro Firebase deployment

Private Pro is an allowlisted hosted mode with direct authenticated Firebase synchronization. Each approved Google account owns one isolated workspace.

Synchronized records and attachments are server-readable plaintext in Firestore and Cloud Storage. Firebase project operators and authorized Google Cloud administrators can read them. The browser validates downloaded schemas and quarantines invalid records. A compromised same-UID browser is outside the Firestore Rules integrity boundary.

The Open and self-hosted build stays local-first when `NEXT_PUBLIC_PRIVATE_PRO_ENABLED` is not `true`.

## Firebase resources

Configure:

- Firebase Authentication with Google sign-in
- Cloud Firestore in Native mode
- Cloud Storage
- Firebase App Check with reCAPTCHA Enterprise
- one Firebase Web App for the production browser configuration

Deploy the checked-in `firestore.rules`, `firestore.indexes.json`, and `storage.rules`. Private Pro data is confined to:

- `users/{uid}` for the active account record
- `users/{uid}/workspaces/v1` for synchronized records, assets, tombstones, and mutation receipts
- `users/{uid}/workspace-v1/assets/{assetId}/{kind}` for attachment objects

Rules require the authenticated UID, the active account epoch, App Check where configured, strict schemas, and fixed versioned paths. Broad Storage listing is denied.

## Runtime identity

The application Admin SDK is limited to account bootstrap and current-account access checks. The custom role in `infra/private-pro/gcp-runtime-role.yaml` contains only:

- `datastore.databases.get`
- `datastore.entities.get`
- `datastore.entities.create`
- `datastore.entities.update`
- `firebaseauth.users.get`
- `firebaseauth.users.update`

The runtime service account has that custom project role. Workload Identity Federation has only `roles/iam.workloadIdentityUser` on the runtime service account. There is no Storage permission, Firestore list/delete permission, or service-account signing binding in the runtime manifest.

The reset tool is an operator command. Run it with operator credentials that can list and update Auth users, recursively delete Firestore data, and list and delete Storage objects. Do not add those permissions to the application runtime role.

## Environment

Required browser configuration:

```dotenv
NEXT_PUBLIC_PRIVATE_PRO_ENABLED=true
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY=
```

Required server configuration:

```dotenv
PRIVATE_PRO_ALLOWED_EMAILS=you@example.com,friend@example.com
PRIVATE_PRO_SECURITY_AUDIT_UID=existing-approved-firebase-uid
```

The v1 attachment size limit is a fixed 64 MiB rule and schema constant. It is not deployment configuration.

Runtime identity configuration:

```dotenv
PRIVATE_PRO_RUNTIME_SERVICE_ACCOUNT_EMAIL=private-pro-runtime@your-project.iam.gserviceaccount.com
PRIVATE_PRO_WIF_RUNTIME_PRINCIPALS=principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL/attribute.repository/ORG/REPO
```

Static Firebase Admin credentials are an optional fallback and are also accepted by the local reset tool:

```dotenv
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
```

The private key supports escaped `\n`. Never expose server credentials through `NEXT_PUBLIC_*` variables.

## Browser restrictions

Follow `infra/private-pro/firebase-origin-restrictions.md`. The browser key has exactly two approved referrers and these five API targets:

- `firebaseappcheck.googleapis.com`
- `identitytoolkit.googleapis.com`
- `securetoken.googleapis.com`
- `firestore.googleapis.com`
- `firebasestorage.googleapis.com`

The bucket CORS rule is the exact checked-in Firebase Web Storage SDK policy. Do not use wildcard CORS or copy an older object-transfer policy.

## Access

Normalize `PRIVATE_PRO_ALLOWED_EMAILS` as comma-separated lowercase exact addresses. Access requires a verified Firebase Auth email in that set.

The normal bootstrap creates or refreshes `users/{uid}` and matching claims. After routine allowlist changes, use the existing access tool:

```powershell
npm run private-pro:sync-access
```

The cutover reset is different. It deletes all known pre-release Private Pro data, rotates approved accounts, clears claims for non-approved identities, and preserves every Firebase Auth user.

## Reset

The reset command defaults to a count-only dry run:

```powershell
npm run private-pro:reset-workspaces
```

Before listing or deleting any object, it proves the configured bucket name and numeric project ownership against the configured Firebase project. It reads Auth users, account documents, exact legacy Firestore subtrees, and exact Storage prefixes. It prints only the project ID, UIDs, counts, epoch transitions, fixed stages, and fixed error codes. It does not print emails, claims, upstream error messages, document or object paths, payloads, credentials, or object bytes.

Execution requires both flags and an exact match with `NEXT_PUBLIC_FIREBASE_PROJECT_ID`:

```powershell
npm run private-pro:reset-workspaces -- --execute --confirm <project-id>
```

Execution refuses an empty allowlist. It never deletes Auth identities. Reset revision 1 uses the revisioned `privateProOperations/workspaceV1Reset-v1` journal and an executor lease. Firestore and Storage rules deny v1 browser access while that revision is running. Each Auth UID is fenced with an inactive fixed target epoch, cleared claims, and revoked tokens before cleanup. Approved verified identities receive a clean active account and matching claims at that same epoch after cleanup. Other account documents and all orphan account documents are deleted after cleanup. Refresh tokens are revoked again after final convergence. Reruns reuse journaled target epochs and phases. A future reset requires a new revision.

Do not run reset execution against production without separate approval of the reviewed dry-run counts.

## App Check

Register the two approved origins for reCAPTCHA Enterprise. Start Firestore and Storage in metrics mode. Verify valid production traffic and invalid traffic before enabling enforcement for both products.

The security audit treats missing or disabled enforcement as a blocker for release. Anonymous Firestore and Storage probes must remain denied after direct authenticated browser access is enabled.

## Emulator and local checks

Run rules tests with JDK 21:

```powershell
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-21.0.4.7-hotspot'
$env:PATH="$env:JAVA_HOME\bin;$env:PATH"
npm run test:firebase:exec
```

Run the cutover tool and audit tests:

```powershell
npx tsx --test tools/private-pro/reset-workspaces.test.ts tools/private-pro/security-audit.test.ts
```

## Cutover order

1. Verify local tests and emulator rules.
2. Deploy v1 Firestore and Storage rules and indexes.
3. Update browser API-key restrictions and bucket CORS.
4. Confirm App Check metrics for Firestore and Storage, then enforce both.
5. Run `npm run private-pro:reset-workspaces` and review the dry-run counts.
6. Run `npm run private-pro:reset-workspaces -- --execute --confirm <project-id>`.
7. Deploy the new application build.
8. Sign in again in clean profiles and complete the two-browser acceptance checks.

No command in this document records a production change as completed.

## Acceptance

- An approved verified Google account reaches `Synced`.
- A second clean browser reconstructs current chats, settings, personas, models, credentials, and attachments.
- Incognito and incomplete chats do not sync.
- Deletes and concurrent changes converge according to the v1 mutation rules.
- Attachment upload, download, metadata read, replacement, and delete work through Firebase Storage.
- A non-approved account is denied.
- Cross-account and anonymous Firestore and Storage access is denied.
- App Check is enforced for Firestore and Storage.
- The security audit reports no browser-key, origin, CORS, IAM, or anonymous-rule blocker.

## Recovery and spending

Configure Firestore deletion protection. Select PITR or managed backup controls only after an approved RPO, RTO, retention, location, and cost decision. Any restore rehearsal must use a new empty non-default database, deploy the current v1 rules and indexes, compare per-collection document counts and content hashes, exercise application reconstruction in an isolated environment, and delete the rehearsal resources only with separate approval. Recovery copies contain server-readable plaintext.

Configure Google Cloud budgets and alerts. Monitor Firestore operations and stored bytes, Storage operations and egress, App Check rejection metrics, and Vercel runtime usage. Budget alerts do not impose a hard spending cap.
