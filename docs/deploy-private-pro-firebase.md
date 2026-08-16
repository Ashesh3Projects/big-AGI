# Private Pro Firebase deployment

This branch adds a private hosted layer for a small allowlist of Google accounts. It is independent of Big-AGI's hosted Pro implementation.

Vercel hosts the application. Firebase Authentication supplies Google sign-in, Firestore stores synchronized records, and Cloud Storage stores attachments. Every approved account receives private Pro access without Stripe or subscription logic.

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

1. Register the Firebase Web App with reCAPTCHA v3 App Check.
2. Add the Vercel production domain and custom domain to the reCAPTCHA site configuration.
3. Set `NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY` in Vercel.
4. Deploy and verify bootstrap/sync requests carry `x-firebase-appcheck`.
5. Enable App Check enforcement gradually in the Firebase console after production traffic is verified.

Protected Vercel mutations verify App Check whenever the site-key variable is configured. Firestore and Storage SDK enforcement is configured in Firebase.

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
NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY=example-public-site-key

FIREBASE_CLIENT_EMAIL=firebase-adminsdk@example-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nREPLACE_ME\n-----END PRIVATE KEY-----\n"

PRIVATE_PRO_ATTACHMENT_QUOTA_BYTES=1073741824
PRIVATE_PRO_MAX_FILE_BYTES=67108864
```

Firebase browser values and the App Check site key are public by design. The private key and service-account email are server configuration. Vercel stores multiline private keys safely; the application also accepts escaped `\n` sequences.

Do not put model/provider API keys into the private Pro sync configuration. Model settings and API keys remain browser-local.

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

1. Push branch `pro` using your normal Git workflow.
2. Select branch `pro` for the Vercel production project or create a separate Vercel project.
3. Add all environment variables.
4. Deploy Firebase rules and indexes.
5. Apply Storage CORS.
6. Deploy Vercel.
7. Sign in with one allowlisted Google account.
8. Confirm existing local chats, personas, and referenced attachments enter the migration queue automatically.
9. Open the app on a second browser/device and confirm the same private vault downloads.
10. Try a non-allowlisted account and confirm it receives Access denied.

## Production checks

- The account menu shows the approved Google email.
- The sync state reaches Synced.
- Local model settings and API keys do not appear on another device.
- Incognito chats do not appear on another device.
- Deleting a chat propagates to another device.
- Concurrent edits preserve a conflict copy.
- Direct Firestore writes and direct Storage uploads fail.
- Removing an email and running access sync blocks its server mutations.

## Usage and spending

Configure Google Cloud billing budgets and alerts for the Firebase project. Budget alerts send notifications. They are not hard spending caps and do not automatically stop Firebase or Cloud Storage usage.

Monitor:

- Firestore reads, writes, stored bytes, and network egress;
- Cloud Storage bytes, operations, and egress;
- Vercel function execution and bandwidth;
- per-account `usedBytes` and `reservedBytes` in Firestore.

The application enforces a 1 GiB attachment quota per account by default. Firebase platform quotas and billing remain project-wide.
