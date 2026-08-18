# Firebase production origin restrictions

Status: local preparation only. No command in an approval-required section has been run.

## Accepted state

Production accepts exactly these browser origins:

- `https://chatgpt.ashesh.dev`
- `https://big-agi-243b6.firebaseapp.com`

Firebase Authentication authorized domains are the matching hostnames only. The Vercel production deployment has exactly the `chatgpt.ashesh.dev` alias. A Vercel alias may be preserved only as a separately approved conditional rollback target. It is not accepted current state.

The configured Firebase browser API key has these exact HTTP referrers:

- `https://chatgpt.ashesh.dev/*`
- `https://big-agi-243b6.firebaseapp.com/*`

The configured browser key has these exact API targets:

- `firebaseappcheck.googleapis.com`
- `identitytoolkit.googleapis.com`
- `securetoken.googleapis.com`

`firebase/firestore` remains imported only by the unmounted legacy plaintext sync transport. Task 19 denies all browser Firestore and Storage SDK paths. Mounted providers use Firebase Auth and App Check in the browser, authenticated Vercel procedures for data access, and object-specific signed URLs for file transfer. The installed `@firebase/app-check` 0.13.0 package has no Installations dependency and calls only the App Check exchange endpoint with the Firebase browser key. Therefore `firestore.googleapis.com`, `firebasestorage.googleapis.com`, and `firebaseinstallations.googleapis.com` are excluded from this browser key. Firebase Admin APIs use server credentials, not this browser key.

Private Pro sends `Referrer-Policy: strict-origin-when-cross-origin`. Cross-origin Firebase requests therefore carry the exact application origin needed by HTTP-referrer restrictions, without path or query data. `no-referrer` is not accepted because it suppresses the Referer required to authorize the restricted browser key.

The installed Firebase Web SDK loads reCAPTCHA Enterprise JavaScript from Google and exchanges App Check tokens through the Firebase App Check endpoint. reCAPTCHA site-key domain configuration is separate from Google Cloud browser API-key API targets. Do not add `recaptchaenterprise.googleapis.com` to the Firebase browser key without a captured request proving the browser sends this key to that service.

The Cloud Storage bucket has exactly one CORS rule:

```json
[
  {
    "origin": [
      "https://chatgpt.ashesh.dev",
      "https://big-agi-243b6.firebaseapp.com"
    ],
    "method": ["GET", "PUT"],
    "responseHeader": ["Content-Type", "x-goog-meta-sha256"],
    "maxAgeSeconds": 3600
  }
]
```

Mounted browser uploads use `PUT` with `content-type` and `x-goog-meta-sha256`. Downloads use `GET` and consume the body without `Range` or response-header access. `HEAD`, `Range`, and `ETag` are excluded until a mounted call requires them.

## Redacted evidence schema

Save before and after evidence as JSON containing only booleans and counts. Never save API key strings, access tokens, key resource IDs, service-account key IDs, Firebase user data, or raw command payloads.

```json
{
  "schemaVersion": 1,
  "phase": "before",
  "collectedAt": "ISO-8601 timestamp",
  "projectId": "big-agi-243b6",
  "headers": {
    "referrerPolicyMismatchCount": 0
  },
  "browserApiKey": {
    "resolved": true,
    "projectNumberUnreadableCount": 0,
    "resourceProjectUnverifiedCount": 0,
    "resourceLocationUnverifiedCount": 0,
    "keyCount": 1,
    "referrerCount": 2,
    "missingReferrerCount": 0,
    "staleReferrerCount": 0,
    "broadReferrerCount": 0,
    "duplicateReferrerCount": 0,
    "apiTargetCount": 3,
    "missingApiTargetCount": 0,
    "unrelatedApiTargetCount": 0,
    "duplicateApiTargetCount": 0
  },
  "authorizedDomains": {
    "domainCount": 2,
    "missingCount": 0,
    "staleCount": 0,
    "wildcardCount": 0
  },
  "deploymentAliases": {
    "ready": true,
    "production": true,
    "exactAliasCount": 1,
    "staleAliasCount": 0
  },
  "bucketCors": {
    "readable": true,
    "ruleCount": 1,
    "missingOriginCount": 0,
    "staleOriginCount": 0,
    "wildcardOriginCount": 0,
    "missingMethodCount": 0,
    "extraMethodCount": 0,
    "wildcardMethodCount": 0,
    "missingHeaderCount": 0,
    "extraHeaderCount": 0,
    "wildcardHeaderCount": 0,
    "duplicateOriginCount": 0,
    "duplicateMethodCount": 0,
    "duplicateHeaderCount": 0
  }
}
```

Change `phase` to `after` for verification. The security audit emits the canonical redacted classifier report. Unreadable state is a blocker, not a zero count.

## Read-only collection

These commands do not mutate cloud state. Do not save or paste their raw output. Feed it directly to the security audit or reduce it immediately to the schema above.

```powershell
$ProjectId='big-agi-243b6'
$Bucket='big-agi-243b6.firebasestorage.app'

gcloud projects describe $ProjectId --format=json
npm run private-pro:security-audit -- --report-only
gcloud services api-keys lookup $env:NEXT_PUBLIC_FIREBASE_API_KEY --project=$ProjectId --format=json
gcloud services api-keys describe KEY_RESOURCE_NAME --project=$ProjectId --format=json
gcloud storage buckets describe "gs://$Bucket" --format=json
vercel inspect chatgpt.ashesh.dev --format=json --non-interactive
```

For Firebase Auth config, use an access token only in memory:

```powershell
$AccessToken = gcloud auth print-access-token
$Headers = @{ Authorization = "Bearer $AccessToken" }
Invoke-RestMethod -Method Get -Uri "https://identitytoolkit.googleapis.com/v2/projects/$ProjectId/config" -Headers $Headers
Remove-Variable AccessToken
```

## Approval-required change commands

Do not run this section without explicit user approval and a saved redacted before snapshot.

Create `cors.private-pro.json` locally from the accepted CORS JSON above. Create `auth-domains.private-pro.json` containing only:

```json
{
  "authorizedDomains": [
    "chatgpt.ashesh.dev",
    "big-agi-243b6.firebaseapp.com"
  ]
}
```

Then substitute the resolved key resource name and any stale alias confirmed by the before snapshot:

```powershell
$ProjectId='big-agi-243b6'
$Bucket='big-agi-243b6.firebasestorage.app'
$KeyResourceName='projects/PROJECT_NUMBER/locations/global/keys/KEY_ID'

gcloud services api-keys update $KeyResourceName --project=$ProjectId --allowed-referrers='https://chatgpt.ashesh.dev/*,https://big-agi-243b6.firebaseapp.com/*' --api-target=service=firebaseappcheck.googleapis.com --api-target=service=identitytoolkit.googleapis.com --api-target=service=securetoken.googleapis.com

$AccessToken = gcloud auth print-access-token
$Headers = @{ Authorization = "Bearer $AccessToken"; 'Content-Type' = 'application/json' }
Invoke-RestMethod -Method Patch -Uri "https://identitytoolkit.googleapis.com/v2/projects/$ProjectId/config?updateMask=authorizedDomains" -Headers $Headers -InFile 'auth-domains.private-pro.json'
Remove-Variable AccessToken

gcloud storage buckets update "gs://$Bucket" --cors-file='cors.private-pro.json'
vercel alias remove STALE_ALIAS --yes --non-interactive
```

## Rollback

The before snapshot must include separate local rollback files containing the prior authorized-domain array and prior bucket CORS object. The prior API-key restrictions and alias names must be recorded in a local restricted operator note, not committed. Roll back only the affected surface:

```powershell
gcloud services api-keys update $KeyResourceName --project=$ProjectId --allowed-referrers='PRIOR_EXACT_REFERRERS' --api-target=service=PRIOR_SERVICE_1 --api-target=service=PRIOR_SERVICE_2

$AccessToken = gcloud auth print-access-token
$Headers = @{ Authorization = "Bearer $AccessToken"; 'Content-Type' = 'application/json' }
Invoke-RestMethod -Method Patch -Uri "https://identitytoolkit.googleapis.com/v2/projects/$ProjectId/config?updateMask=authorizedDomains" -Headers $Headers -InFile 'auth-domains.before.private-pro.json'
Remove-Variable AccessToken

gcloud storage buckets update "gs://$Bucket" --cors-file='cors.before.private-pro.json'
vercel alias set CURRENT_PRODUCTION_DEPLOYMENT PRIOR_ALIAS --non-interactive
```

Never use `--clear-restrictions`, wildcard origins, wildcard headers, wildcard methods, wildcard referrers, or project-wide Firebase Admin permissions as rollback.

## Verification

- Save the redacted after snapshot and run `npm run private-pro:security-audit` without `--report-only`.
- Confirm the audit has zero blockers for deployment aliases, Firebase Auth domains, browser API key restrictions, and bucket CORS.
- Use a clean production browser profile on `https://chatgpt.ashesh.dev`.
- Complete Google popup sign-in and redirect fallback.
- Confirm Firebase App Check returns a token and protected bootstrap accepts it.
- Confirm encrypted vault bootstrap and server Firestore operations succeed.
- Upload and download an encrypted attachment through signed URLs.
- Confirm browser Firestore and Storage SDK probes remain denied.
- Confirm a removed localhost, stale Vercel alias, or unapproved origin cannot sign in or use bucket CORS.
- If a check fails, restore only the exact missing origin, API target, method, or header after capturing the failing request. Do not restore broad access.

## References

- Google Cloud API key update syntax: <https://cloud.google.com/sdk/gcloud/reference/services/api-keys/update>
- Firebase API-key restriction guidance: <https://firebase.google.com/docs/projects/api-keys#api_restrictions>
- Identity Platform project config update: <https://cloud.google.com/identity-platform/docs/reference/rest/v2/projects/updateConfig>
- Cloud Storage CORS configuration: <https://cloud.google.com/storage/docs/cors-configurations>
- Firebase App Check reCAPTCHA Enterprise: <https://firebase.google.com/docs/app-check/web/recaptcha-enterprise-provider>
