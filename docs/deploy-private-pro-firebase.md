# Private Pro Firebase deployment

This branch adds a private hosted layer for a small allowlist of Google accounts. It is independent of Big-AGI's hosted Pro implementation.

Vercel hosts the application. Firebase Authentication supplies Google sign-in, Firestore stores synchronized records, and Cloud Storage stores attachments. Every approved account receives private Pro access without Stripe or subscription logic.

This deployment is greenfield: launch requires zero existing plaintext Private Pro users or data. If any legacy plaintext user data exists or is introduced before launch, stop rollout. Design, implement, test, and review a separate migration before enabling the encrypted vault.

## Requirements

- A Vercel project connected to branch `pro`.
- A Firebase project on the Blaze plan. Cloud Storage for Firebase requires Blaze even when usage stays inside no-cost quotas.
- A Cloud Storage bucket in `us-central1`, `us-west1`, or `us-east1` if you want the current no-cost bucket quotas described by Firebase pricing.
- Google sign-in accounts for every approved user.
- Java 21 for Firebase Emulator Suite tests. This machine has `C:\Program Files\Microsoft\jdk-21.0.4.7-hotspot`.

## Firebase project

1. Create a Firebase project.
2. Upgrade the project to Blaze.
3. Open Authentication, enable Google, and choose a support email.
4. Set Authentication - Settings - Authorized domains to exactly `chatgpt.ashesh.dev` and `big-agi-243b6.firebaseapp.com`. Production must not retain localhost, stale Vercel aliases, or wildcard domains.
5. Create a Firestore database in Native mode.
6. Create the default Cloud Storage bucket in an eligible region if no-cost quotas are important.
7. Add a Web App and copy its public browser configuration.
8. Prepare a dedicated runtime identity. Prefer Vercel OIDC plus Google Workload Identity Federation (WIF) so the deployment uses short-lived Application Default Credentials (ADC). This repository does not claim that the Vercel issuer, workload identity pool, provider, or service-account impersonation is configured or live.

The checked-in manifest at `infra/private-pro/gcp-runtime-role.yaml` defines the exact custom project role for mounted application paths:

- `firebaseauth.users.get`
- `firebaseauth.users.update`
- `datastore.databases.get`
- `datastore.entities.get`
- `datastore.entities.list`
- `datastore.entities.create`
- `datastore.entities.update`
- `datastore.entities.delete`
- `storage.objects.get`
- `storage.objects.create`
- `storage.objects.delete`

Firebase ID tokens and Firebase App Check tokens are verified locally from Google public keys. Those two verification operations require no project IAM permission. The current runtime uses Auth user reads, custom-claim updates and refresh-token revocation; Firestore document, query, batch-get, transaction, create, update, and delete operations; Storage object metadata reads and object deletion; and signed upload/download URLs. The still-mounted plaintext sync and asset server procedures are included until they are removed from the production router and scheduled sweep.

Signed URL generation under ADC/WIF needs remote blob signing. Keep this outside the custom project role. Grant `roles/iam.serviceAccountTokenCreator` on only the dedicated runtime service account to that service account itself. The relevant permission is `iam.serviceAccounts.signBlob`; do not grant Token Creator at project scope or to the external OIDC principal. The external principal receives only `roles/iam.workloadIdentityUser` on the runtime service account for WIF impersonation.

The custom role intentionally excludes project updates, bucket creation/deletion, ruleset/release mutation, API-key administration, IAM policy mutation, unrelated Firebase products, and broad Firebase/Storage/Datastore administration. Every permission and binding still requires live staging validation before provisioning is accepted.

Example commands are templates only. Running them mutates cloud IAM and requires explicit approval:

```powershell
$ProjectId='YOUR_PROJECT_ID'
$RuntimeServiceAccount='private-pro-runtime@YOUR_PROJECT_ID.iam.gserviceaccount.com'
$RuntimePrincipal='principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/attribute.repository/ORG/REPOSITORY'

gcloud iam roles create privateProRuntime --project=$ProjectId --title="Private Pro Firebase runtime" --description="Mounted Private Pro Auth, Firestore, and Storage object calls only." --stage=GA --permissions="datastore.databases.get,datastore.entities.create,datastore.entities.delete,datastore.entities.get,datastore.entities.list,datastore.entities.update,firebaseauth.users.get,firebaseauth.users.update,storage.objects.create,storage.objects.delete,storage.objects.get"
gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:$RuntimeServiceAccount" --role="projects/$ProjectId/roles/privateProRuntime"
gcloud iam service-accounts add-iam-policy-binding $RuntimeServiceAccount --project=$ProjectId --member=$RuntimePrincipal --role=roles/iam.workloadIdentityUser
gcloud iam service-accounts add-iam-policy-binding $RuntimeServiceAccount --project=$ProjectId --member="serviceAccount:$RuntimeServiceAccount" --role=roles/iam.serviceAccountTokenCreator
```

`gcp-runtime-role.yaml` is the machine-tested source of truth. Keep the command permission list identical to its `runtimeRole.includedPermissions` list.

The production security audit verifies deployed state, not only this local manifest. Set the expected identity and exact WIF members:

```dotenv
PRIVATE_PRO_RUNTIME_SERVICE_ACCOUNT_EMAIL=private-pro-runtime@your-project.iam.gserviceaccount.com
PRIVATE_PRO_WIF_RUNTIME_PRINCIPALS=principalSet://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/vercel-prod/attribute.repository/example-org/example-repository
```

The audit then blocks unless all of these are true:

- ADC independently resolves an active service-account email and it exactly matches `PRIVATE_PRO_RUNTIME_SERVICE_ACCOUNT_EMAIL`. The configured email is only an expectation, not proof of active identity.
- `projects/PROJECT_ID/roles/privateProRuntime` exists, is active at `GA`, and its deployed permission list exactly matches the manifest.
- The runtime service account has exactly the custom runtime role at project scope. Any extra project role, including `roles/storage.objectAdmin`, an arbitrary custom role, or project-scoped Token Creator, blocks.
- Each configured WIF principal has only `roles/iam.workloadIdentityUser` on the runtime service account.
- The runtime service account is the sole `roles/iam.serviceAccountTokenCreator` member on itself. An external principal with Token Creator blocks.
- The service-account IAM policy contains no other roles or members.

If active ADC credentials, the deployed role, project policy, service-account policy, or expected WIF principals cannot be read and verified, the audit reports a blocker. `--report-only` still prints the complete report but does not make unreadable state acceptable.

Every WIF entry must be an exact Google IAM external principal. Accepted forms are:

- `principal://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/subject/SUBJECT`
- `principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/attribute.ATTRIBUTE_NAME/ATTRIBUTE_VALUE`
- `principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/group/GROUP_ID`

All configured entries must use the same numeric project number and workload identity pool. Wildcards, pool-wide principals, non-global locations, empty components, and IAM member types such as `user:`, `serviceAccount:`, `domain:`, `allUsers`, or `allAuthenticatedUsers` are rejected.

## App Check

Use reCAPTCHA Enterprise. Do not register a reCAPTCHA v3 provider.

1. Create a score-based reCAPTCHA Enterprise site key for the exact production domains.
2. Register the Firebase Web App with the reCAPTCHA Enterprise App Check provider and that site key.
3. Leave Firebase product enforcement disabled initially. This is the metrics-only phase.
4. Set `NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY` in the Vercel Production environment and redeploy.
5. Verify every private Pro bootstrap, sync, and attachment request carries `x-firebase-appcheck`, and verify the Firebase App Check metrics show valid production traffic.
6. Enable enforcement for Firestore, then Storage, observing errors and metrics after each change.

Production private Pro refuses to start without the site key. Protected Vercel procedures also reject missing or invalid App Check tokens before account and data operations. App Check is additive: Firebase ID-token verification, allowlist status, active-account checks, and access-epoch checks remain mandatory.

For local development or Firebase Emulator Suite use, App Check enforcement may remain disabled. When testing token exchange against a real Firebase project, register a debug token in Firebase Console - App Check - Apps - Manage debug tokens. Before Firebase initializes, set the browser global to that exact registered value:

```js
self.FIREBASE_APPCHECK_DEBUG_TOKEN = 'registered-debug-token';
```

Development defaults to Firebase's generated debug-token path when a site key is configured. Copy the generated token from the browser console and register it before expecting valid exchange. Never set a debug token in the Vercel Production environment or commit one to source control.

Rollback order:

1. Disable Firestore or Storage App Check enforcement in Firebase for the affected product.
2. Keep the reCAPTCHA Enterprise registration, production site key, and Vercel server verification active while diagnosing metrics and client failures.
3. Never disable Firebase ID-token verification, active-account checks, allowlist enforcement, or access-epoch checks as part of App Check rollback.

## Storage CORS

Signed attachment uploads are direct browser `PUT` requests. Downloads are direct browser `GET` requests. Apply this exact production bucket CORS policy:

```json
[
  {
    "origin": [
      "https://chatgpt.ashesh.dev",
      "https://big-agi-243b6.firebaseapp.com"
    ],
    "method": ["GET", "PUT"],
    "responseHeader": [
      "Content-Type",
      "x-goog-meta-sha256"
    ],
    "maxAgeSeconds": 3600
  }
]
```

Apply it with Google Cloud CLI:

```powershell
gcloud storage buckets update gs://YOUR_BUCKET --cors-file=cors.json
```

The mounted upload paths send `Content-Type` and `x-goog-meta-sha256`. Mounted downloads do not use `HEAD`, `Range`, or exposed `ETag`. Do not add unused methods or headers. Do not use `*` for origins, methods, or headers.

## Production browser restrictions

The accepted production state is defined in `infra/private-pro/firebase-origin-restrictions.md`. The security audit blocks unless:

- Firebase Auth authorized domains are exactly `chatgpt.ashesh.dev` and `big-agi-243b6.firebaseapp.com`.
- The production deployment is ready, targets production, and has exactly the `chatgpt.ashesh.dev` alias. A Vercel alias may exist only as a separately approved conditional rollback target, not accepted current state.
- The configured Firebase browser API key referrers are exactly `https://chatgpt.ashesh.dev/*` and `https://big-agi-243b6.firebaseapp.com/*`.
- That key targets exactly `firebaseappcheck.googleapis.com`, `identitytoolkit.googleapis.com`, and `securetoken.googleapis.com`.
- Bucket CORS is readable and exactly matches the policy above.

Task 19 denies all browser Firestore and Storage SDK access. `firebase/firestore` is referenced only by the unmounted legacy plaintext sync transport. Mounted browser code uses Firebase Auth, App Check, and signed Storage URLs. The installed `@firebase/app-check` 0.13.0 package calls the App Check endpoint directly and has no Installations dependency. Therefore `firestore.googleapis.com`, `firebasestorage.googleapis.com`, and `firebaseinstallations.googleapis.com` are not browser-key targets. Firebase Admin APIs use server credentials and are unrelated to browser API-key restrictions.

Private Pro must emit `Referrer-Policy: strict-origin-when-cross-origin`. HTTP-referrer API-key restrictions depend on a cross-origin Referer. This policy sends only `https://chatgpt.ashesh.dev/` to Firebase APIs and omits path and query data. `no-referrer` is incompatible with the restricted browser key and blocks rollout.

Save redacted before and after snapshots using the schema in the restriction plan. Unreadable state blocks rollout. Cloud changes, alias removal, and deployment still require explicit user approval.

## Rules and indexes

Authenticate Firebase CLI with the intended Google account, then deploy the checked-in rules:

```powershell
npx firebase use YOUR_FIREBASE_PROJECT_ID
npx firebase deploy --only firestore:rules,firestore:indexes,storage
```

Firestore and Storage browser SDK access is denied for all paths. Authenticated Vercel procedures perform Firestore operations through the Admin SDK. Attachment upload and download use short-lived object-specific signed URLs.

Removing access blocks Vercel procedures immediately, revokes refresh tokens, and rotates the access epoch. Already issued signed URLs remain valid only until their short expiry.

## Vercel variables

Set these variables for Production and any Preview environment intended to use private Pro:

```dotenv
NEXT_PUBLIC_PRIVATE_PRO_ENABLED=true
PRIVATE_PRO_ALLOWED_EMAILS=you@example.com,friend@example.com

NEXT_PUBLIC_FIREBASE_API_KEY=example-public-api-key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your-project.firebasestorage.app
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=1234567890
NEXT_PUBLIC_FIREBASE_APP_ID=1:1234567890:web:example
NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY=example-recaptcha-enterprise-site-key

PRIVATE_PRO_ATTACHMENT_QUOTA_BYTES=1073741824
PRIVATE_PRO_MAX_FILE_BYTES=67108864
PRIVATE_PRO_UPLOAD_RATE_WINDOW_MS=60000
PRIVATE_PRO_UPLOAD_RATE_MAX_REQUESTS=30
PRIVATE_PRO_UPLOAD_RATE_MAX_BYTES=268435456
CRON_SECRET=replace-with-a-long-random-secret
```

Firebase browser values and the App Check site key are public by design. In the preferred ADC/WIF mode, omit both `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY`. The Firebase Admin SDK selects `application-default`; the workload identity provider supplies the short-lived runtime credential. `PRIVATE_PRO_RUNTIME_SERVICE_ACCOUNT_EMAIL` configures the identity the audit expects. The audit separately resolves the active ADC service-account email and blocks if it cannot verify an exact match.

If WIF is not viable in the deployed Vercel environment, use a dedicated static key only as an explicit fallback:

```dotenv
FIREBASE_CLIENT_EMAIL=private-pro-runtime@your-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nREPLACE_ME\n-----END PRIVATE KEY-----\n"
PRIVATE_PRO_RUNTIME_SERVICE_ACCOUNT_EMAIL=private-pro-runtime@your-project.iam.gserviceaccount.com
```

The application classifies this mode as `static-key-fallback`. Both static variables must be present or both absent. A partial pair is rejected without printing the key. Vercel stores multiline private keys safely; escaped `\n` sequences are accepted. Never place either value in a `NEXT_PUBLIC_` variable.

Static fallback rotation and removal:

1. Create a second key for the same dedicated least-privilege runtime service account. Do not delete the working key.
2. Replace the two Vercel fallback variables in a non-production environment and deploy.
3. Run the protected staging Auth, App Check, Firestore transaction/query, Storage metadata/delete, and signed upload/download probes.
4. Promote the verified pair to production and monitor protected endpoints.
5. Disable the old key only after the replacement passes. Observe one full rollback window.
6. Delete the old key only with separate explicit approval.
7. When WIF is verified, remove both static variables, deploy ADC/WIF, repeat protected probes, then disable and later delete the final static key under the same approval gates.

Set the App Check site key for Production before enabling `NEXT_PUBLIC_PRIVATE_PRO_ENABLED=true`. Any Vercel Preview that enables private Pro must also set it. Local Development may omit it for emulator work. Do not add `FIREBASE_APPCHECK_DEBUG_TOKEN` to Vercel Production.

Do not put model/provider API keys into Vercel environment variables or plaintext sync configuration. In the Open/self-hosted build, provider credentials remain browser-local unless the operator adds separate infrastructure. In Private Pro, provider credentials, model settings, and API keys are encrypted in the browser and synchronized only as ciphertext through the encrypted vault. Vercel and Firebase must never receive their plaintext values.

The checked-in `vercel.json` invokes `/api/private-pro/sweep-expired` daily, which is compatible with Vercel Hobby cron limits. Vercel sends `CRON_SECRET` as a bearer token. The job releases expired quota reservations and deletes any unfinalized attachment objects.

Upload reservations are also limited per UID by request count and requested bytes. The defaults allow 30 reservations and 256 MiB of requested data per 60-second window. Firestore updates the rate window in the same transaction as the quota reservation, so concurrent Vercel instances enforce one account-wide limit.

Enable Firestore TTL for the rate-window collection group so expired counters are deleted automatically:

```powershell
gcloud firestore fields ttls update expiresAt --collection-group=uploadRateWindows --enable-ttl
```

## Access management

After changing `PRIVATE_PRO_ALLOWED_EMAILS`, run the entitlement synchronization command from an environment containing the same Firebase Admin credentials:

```powershell
npm run private-pro:sync-access
```

Revoke one account explicitly:

```powershell
npm run private-pro:revoke -- removed@example.com
```

The sync command:

- grants verified allowlisted users;
- refreshes stale custom-claim epochs;
- deactivates removed users;
- rotates access epochs;
- clears private Pro claims;
- revokes Firebase refresh tokens.

New Google users must sign in once so they exist in Firebase Authentication before the administrative command can find them. The normal application bootstrap also grants an allowlisted user on first sign-in.

## Emulator tests

Run rules tests with JDK 21 without changing the global Java installation:

```powershell
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-21.0.4.7-hotspot'
$env:PATH="$env:JAVA_HOME\bin;$env:PATH"
npm run test:firebase:exec
```

The suite verifies that browser Firestore reads and writes, Storage reads and writes, cross-account access, legacy plaintext paths, encrypted-vault paths, and Storage listing are denied.

## Database recovery

Before production approval, follow `infra/private-pro/firestore-recovery-controls.md`.

The read-only Task 22 collection on 2026-08-18 found Firestore deletion protection disabled. This is a deployment blocker. Enabling it is a cloud mutation and still requires explicit approval for the exact command in the recovery runbook.

PITR is also disabled. Do not enable PITR or provision scheduled exports until the product owner selects an RPO/RTO and the cost approver accepts the current location, edition, storage, operation, runtime, and retention estimate. The Task 12 password-encrypted archive is interactive and must not be described or implemented as a server-scheduled backup without a separate safe noninteractive key design. A managed Firestore export preserves stored ciphertext and metadata, but it is an infrastructure restore artifact rather than the user-facing encrypted archive.

No restore rehearsal may target `(default)`. Use a separate database or approved separate project, verify the application against it, and delete rehearsal resources only with separate cleanup approval.

## Deployment

Before step 1, confirm there are zero existing plaintext Private Pro users, chats, personas, assets, credentials, settings, or cloud records. If this is false, stop. A separate migration design, implementation, test plan, and review must finish before encrypted-vault rollout.

1. Clear the Firestore deletion-protection blocker using the separately approved command in the recovery runbook, then save a redacted verification snapshot.
2. Record the approved RPO/RTO and cost decision for PITR, scheduled Firestore ciphertext exports, both, or explicit acceptance of the remaining recovery risk. Do not infer approval from deletion-protection approval.
3. Obtain approval for IAM provisioning. Create the dedicated runtime identity, WIF provider or static fallback, custom project role, and runtime-service-account-scoped Token Creator binding outside production first.
4. Validate every manifest permission with a staging identity and protected endpoint probes. This Task 20 implementation has not performed that live validation.
5. Push branch `pro` using your normal Git workflow.
6. Select branch `pro` for the Vercel production project or create a separate Vercel project.
7. Add all environment variables.
8. Register reCAPTCHA Enterprise App Check in metrics-only mode.
9. Deploy Firebase rules and indexes.
10. Obtain separate approval for the exact browser-key, authorized-domain, deployment-alias, and Storage CORS changes in `infra/private-pro/firebase-origin-restrictions.md`. Save a redacted before snapshot, apply only the approved commands, and save a redacted after snapshot.
11. Deploy Vercel and verify valid App Check metrics and request headers.
12. Enable Firestore and Storage App Check enforcement in that order.
13. Sign in with one allowlisted Google account.
14. Start with an empty browser profile and complete encrypted vault password/recovery setup before creating portable data.
15. Add a sentinel chat, setting, credential, and attachment, then open a second clean browser/device and confirm the encrypted vault reconstructs them before the app becomes editable.
16. Create and restore an encrypted backup in a clean profile.
17. Complete the separately approved non-destructive Firestore restore rehearsal and record redacted evidence.
18. Try a non-allowlisted account and confirm it receives Access denied.

## Production checks

- The account menu shows the approved Google email.
- The sync state reaches Synced.
- Local model settings and API keys appear on another approved device only after vault unlock and encrypted hydration.
- Incognito chats do not appear on another device.
- Deleting a chat propagates to another device.
- Concurrent edits preserve a conflict copy.
- Direct Firestore writes and direct Storage uploads fail.
- Firestore deletion protection is enabled and the security audit reports no recovery-state blocker.
- The approved PITR or export recovery control matches the recorded RPO/RTO and current cost decision.
- The latest restore rehearsal used an isolated target, left `(default)` unchanged, and produced only redacted evidence.
- The security audit reports no blockers for the exact custom-domain deployment alias, Firebase Auth domains, browser API-key referrers/API targets, or bucket CORS.
- Removing an email and running access sync blocks its server mutations.
- Missing or invalid `x-firebase-appcheck` blocks every private Pro procedure.

## Usage and spending

Configure Google Cloud billing budgets and alerts for the Firebase project. Budget alerts send notifications. They are not hard spending caps and do not automatically stop Firebase or Cloud Storage usage.

Monitor:

- Firestore reads, writes, stored bytes, and network egress;
- Cloud Storage bytes, operations, and egress;
- Vercel function execution and bandwidth;
- per-account `usedBytes` and `reservedBytes` in Firestore.

The application enforces a 1 GiB attachment quota per account by default. Firebase platform quotas and billing remain project-wide.
