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
4. Add the production Vercel domain and any custom domain to Authentication - Settings - Authorized domains.
5. Create a Firestore database in Native mode.
6. Create the default Cloud Storage bucket in an eligible region if no-cost quotas are important.
7. Add a Web App and copy its public browser configuration.
8. Create a service account key for the Vercel server.

The service account needs permission to:

- verify and manage Firebase Authentication users and claims;
- read/write Firestore account, sync, quota, and attachment metadata;
- sign Cloud Storage URLs;
- read object metadata and delete orphan objects.

Use narrowly scoped Google Cloud roles where practical. The service-account JSON is a secret. Do not place it in a `NEXT_PUBLIC_` variable.

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

Signed attachment uploads are direct browser `PUT` requests. Apply a bucket CORS policy for your exact domains. Save this locally as `cors.json`, replacing the example origins:

```json
[
  {
    "origin": [
      "https://your-project.vercel.app",
      "https://chat.example.com"
    ],
    "method": ["GET", "HEAD", "PUT"],
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

Do not use `*` for production origins.

## Rules and indexes

Authenticate Firebase CLI with the intended Google account, then deploy the checked-in rules:

```powershell
npx firebase use YOUR_FIREBASE_PROJECT_ID
npx firebase deploy --only firestore:rules,firestore:indexes,storage
```

Firestore browser access is read-only and scoped to the authenticated UID, private Pro claim, active account record, and matching access epoch. Storage browser writes are denied. Attachment uploads use short-lived signed URLs from Vercel.

Cloud Storage rules cannot read Firestore account documents. Removing access blocks all Vercel mutations immediately, revokes refresh tokens, and rotates the access epoch. A previously issued Firebase ID token can continue direct Storage reads until it refreshes or expires.

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

FIREBASE_CLIENT_EMAIL=firebase-adminsdk@example-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nREPLACE_ME\n-----END PRIVATE KEY-----\n"

PRIVATE_PRO_ATTACHMENT_QUOTA_BYTES=1073741824
PRIVATE_PRO_MAX_FILE_BYTES=67108864
PRIVATE_PRO_UPLOAD_RATE_WINDOW_MS=60000
PRIVATE_PRO_UPLOAD_RATE_MAX_REQUESTS=30
PRIVATE_PRO_UPLOAD_RATE_MAX_BYTES=268435456
CRON_SECRET=replace-with-a-long-random-secret
```

Firebase browser values and the App Check site key are public by design. The private key and service-account email are server configuration. Vercel stores multiline private keys safely; the application also accepts escaped `\n` sequences.

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

The suite verifies cross-account denial, claim and epoch enforcement, inactive-account denial, read-only Firestore access, direct Storage upload denial, and UID-scoped Storage reads.

## Deployment

Before step 1, confirm there are zero existing plaintext Private Pro users, chats, personas, assets, credentials, settings, or cloud records. If this is false, stop. A separate migration design, implementation, test plan, and review must finish before encrypted-vault rollout.

1. Push branch `pro` using your normal Git workflow.
2. Select branch `pro` for the Vercel production project or create a separate Vercel project.
3. Add all environment variables.
4. Register reCAPTCHA Enterprise App Check in metrics-only mode.
5. Deploy Firebase rules and indexes.
6. Apply Storage CORS.
7. Deploy Vercel and verify valid App Check metrics and request headers.
8. Enable Firestore and Storage App Check enforcement in that order.
9. Sign in with one allowlisted Google account.
10. Start with an empty browser profile and complete encrypted vault password/recovery setup before creating portable data.
11. Add a sentinel chat, setting, credential, and attachment, then open a second clean browser/device and confirm the encrypted vault reconstructs them before the app becomes editable.
12. Create and restore an encrypted backup in a clean profile.
13. Try a non-allowlisted account and confirm it receives Access denied.

## Production checks

- The account menu shows the approved Google email.
- The sync state reaches Synced.
- Local model settings and API keys appear on another approved device only after vault unlock and encrypted hydration.
- Incognito chats do not appear on another device.
- Deleting a chat propagates to another device.
- Concurrent edits preserve a conflict copy.
- Direct Firestore writes and direct Storage uploads fail.
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
