# Task 21 report

## Status

Local preparation complete. No cloud mutation, API-key update, authorized-domain change, bucket CORS update, Vercel alias change, OAuth change, deployment, or secret rotation was performed.

Commit subject: `Security: prepare Firebase origin restrictions`.

## Browser API ruling

The exact production browser API-key target allowlist is:

- `firebaseappcheck.googleapis.com`
- `identitytoolkit.googleapis.com`
- `securetoken.googleapis.com`

The mounted browser code imports and calls Firebase Auth and Firebase App Check. The installed `@firebase/app-check` 0.13.0 package calls the App Check exchange endpoint directly and has no Installations dependency.

`firestore.googleapis.com` and `firebasestorage.googleapis.com` were removed from the browser-key allowlist. Task 19 denies all browser Firestore and Storage SDK access. The only browser Firestore consumer is the unmounted legacy plaintext sync transport. The mounted provider tree uses authenticated Vercel procedures for Firestore and Storage metadata, plus object-specific signed URLs for browser file transfer. Firebase Admin APIs use server credentials and are unrelated to the browser API key.

The App Check reCAPTCHA Enterprise provider loads Google reCAPTCHA JavaScript. reCAPTCHA site-key domain registration is separate from Google Cloud browser API-key API targets. The plan does not add `recaptchaenterprise.googleapis.com` without a captured request proving that the Firebase browser key is sent to it.

## Exact accepted state

- Browser origins: `https://chatgpt.ashesh.dev` and `https://big-agi-243b6.firebaseapp.com`.
- Browser API-key referrers: the matching two origins with `/*`.
- Firebase Auth domains: `chatgpt.ashesh.dev` and `big-agi-243b6.firebaseapp.com` only.
- Vercel deployment alias: `chatgpt.ashesh.dev` only. Any Vercel alias is conditional rollback state, not accepted current state.
- Bucket CORS: one rule, exact two origins, methods `GET` and `PUT`, headers `Content-Type` and `x-goog-meta-sha256`.
- `HEAD`, `Range`, and `ETag` are excluded because mounted browser code does not use them.
- Wildcard origins, methods, headers, referrers, stale aliases, and localhost are blocked.

## Changes

- Strengthened exact Firebase Auth domain, deployment alias, and browser API-key classifiers.
- Changed browser-key collection to resolve `NEXT_PUBLIC_FIREBASE_API_KEY` and inspect only that configured key. Unrelated project API keys no longer affect the browser-key classifier, and the key string is never printed.
- Added fail-closed Cloud Storage bucket CORS inspection for the current `gcloud storage buckets describe` `cors_config` shape and the API `cors` shape.
- Added CORS findings for unreadable state, exact rule count, missing/stale/wildcard origins, missing/extra/wildcard methods, and missing/extra/wildcard headers.
- Added the bucket CORS collector to the report-only and blocking audits.
- Updated the deployment guide with exact production restrictions and rollout blockers.
- Added `infra/private-pro/firebase-origin-restrictions.md` with read-only collection, redaction schema, approval-required mutation commands, rollback commands, and verification checks.
- Saved `.superpowers/sdd/2026-08-17-private-pro-encrypted-vault/task-21-before-redacted.json` with counts and booleans only.

## TDD

Initial RED:

```text
32 tests: 28 passed, 4 failed
```

The failures proved that the old six-service API allowlist rejected the exact mounted four-service state, Firestore and Storage were not treated as unrelated browser targets, and bucket CORS inspection did not exist.

Configured-key lookup RED:

```text
33 tests: 32 passed, 1 failed
inspectApiKeyLookup is not a function
```

Wildcard CORS mutation RED:

```text
33 tests: 32 passed, 1 failed
expected wildcardOrigins 1, received 0
```

Final focused GREEN:

```text
33 tests: 33 passed, 0 failed
```

Fixtures cover exact good state, empty restrictions, wildcard/stale/missing referrers, extra/missing API targets, localhost/stale/duplicate Auth domains, duplicate/stale aliases, unreadable and empty bucket CORS, wildcard/broad CORS, extra methods, and missing signed-upload headers.

## Read-only live collection

The report-only audit and focused collectors ran against `big-agi-243b6`. No raw key material, key IDs, access tokens, alias names, Auth domains, or CORS origin values were saved.

Redacted relevant state:

- Deployment is ready and production.
- Exact custom-domain alias count: 1.
- Stale deployment alias count: 2.
- Firebase Auth config: unreadable with an authorization-class HTTP response. Audit blocks.
- Browser API key: `NEXT_PUBLIC_FIREBASE_API_KEY` was absent from this shell, so the exact configured key could not be resolved. Audit blocks.
- Bucket CORS is readable with one rule.
- Missing required bucket origin count: 1.
- Stale bucket origin count: 2.
- Extra bucket method count: 1.
- Missing required method/header counts: 0.
- Wildcard origin/method/header counts: 0.
- App Check service config: unreadable with an authorization-class HTTP response. Audit blocks.

The full report-only audit remains blocked, as required. It also reports existing unrelated header, IAM/runtime identity, dependency advisory, and write-probe blockers.

## Verification

- `npx cross-env NODE_ENV=development tsx --test tools/private-pro/security-audit.test.ts`: 33 passed, 0 failed.
- `npm run private-pro:security-audit -- --report-only`: completed, emitted counts/booleans only, and reported current blockers.
- Redacted snapshot JSON parse: passed.
- `git diff --check`: passed.
- Focused ESLint was blocked before file analysis by the local `@rushstack/eslint-patch` caller-recognition error.
- `npm run tscheck` was blocked by the existing duplicate React type baseline: 337 unrelated JSX errors in 152 files.
- `npx tsc --noEmit --pretty -p tools/tsconfig.json` reached the same baseline and reported 5 unrelated React JSX errors in 4 imported source files. It reported no error in the changed audit files.

## Approval-gated next actions

After explicit user approval:

1. Load the production Firebase browser API key into the operator shell and rerun the read-only audit so its exact current restrictions can be reduced to the before schema.
2. Use credentials with read access to Firebase Auth and App Check config. Save counts only.
3. Save restricted local rollback copies of the exact prior API-key restrictions, authorized-domain array, bucket CORS object, and stale alias names. Do not commit them.
4. Apply only the commands in `infra/private-pro/firebase-origin-restrictions.md` for the browser key, Auth domains, bucket CORS, and confirmed stale aliases.
5. Save the redacted after snapshot and run the blocking audit without `--report-only`.
6. In a clean profile on `https://chatgpt.ashesh.dev`, verify Google sign-in, redirect fallback, App Check, encrypted vault bootstrap, signed encrypted upload/download, and browser Firestore/Storage denial.
7. If a check fails, restore only the exact required origin, API target, method, or header. Do not restore wildcard or unrestricted state.

## Fix round 1/5

Status: implemented locally. No cloud mutation or deployment was performed.

### Findings addressed

1. Changed the Private Pro response header from `Referrer-Policy: no-referrer` to `strict-origin-when-cross-origin`. HTTP-referrer-restricted Firebase browser keys require a Referer on cross-origin requests. The new policy sends only the application origin and does not send path or query data cross-origin. The live audit now blocks any other Referrer-Policy value.
2. Removed `firebaseinstallations.googleapis.com` from the browser API-key allowlist and the explicit CSP sources. The mounted `@firebase/app-check` 0.13.0 package has no Installations dependency and its exchange request goes directly to `content-firebaseappcheck.googleapis.com` with the browser key. The exact browser API-key target set is now App Check, Identity Toolkit, and Secure Token.
3. Bound the configured browser key resource to the selected project. The audit reads the numeric project number with `gcloud projects describe`, requires `projects/<expected-number>/locations/global/keys/...`, rejects a different project or non-global location, and never prints the resource name or project number.
4. Updated the security design, deployment guide, operator plan, and redacted snapshot schema. The new header and project-binding evidence is recorded as counts only.

### TDD

Initial fix-round RED:

```text
36 tests: 32 passed, 4 failed
```

The failures proved that the header still used `no-referrer`, the CSP still allowed Installations, the audit still required Installations, and project-number/key-resource binding did not exist.

Exact referrer-policy audit RED:

```text
37 tests: 36 passed, 1 failed
isAllowedReferrerPolicy is not a function
```

Project-number collector RED:

```text
38 tests: 37 passed, 1 failed
collectProjectNumber is not a function
```

### Read-only live collection

- `gcloud projects describe big-agi-243b6 --format=json` succeeded.
- The numeric project number was not printed or saved.
- `NEXT_PUBLIC_FIREBASE_API_KEY` remains absent from this shell, so key-resource project/location matching remains unverified and blocks.

### Approval-gated state

The approval-required API-key update command now contains exactly three API targets. Referrers remain exactly `https://chatgpt.ashesh.dev/*` and `https://big-agi-243b6.firebaseapp.com/*`. No mutation command was run.

### Verification

- Focused header and security-audit command: 38 passed, 0 failed.
- `npm run private-pro:security-audit -- --report-only`: completed and now blocks the deployed non-matching Referrer-Policy while keeping output to booleans and counts.
- Direct `next.config.ts` integration probe with `NEXT_PUBLIC_PRIVATE_PRO_ENABLED=true`: one route header rule, exact `strict-origin-when-cross-origin`, and no explicit Installations CSP source.
- Read-only project-number collection: readable; the number was not printed or saved.
- Redacted snapshot JSON parse: passed.
- `git diff --check`: passed.
- Focused ESLint remains blocked before file analysis by the local `@rushstack/eslint-patch` caller-recognition error.
- Private-Pro-enabled `npm run build`: application compilation passed, then the existing duplicate React type baseline stopped type checking at `pages/_app.tsx:42` (`ProviderSingleTab` JSX type mismatch). The build did not reach route-manifest generation.
