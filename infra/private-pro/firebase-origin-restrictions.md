# Firebase production origin restrictions

Status: local preparation only. No cloud change in this document has been executed.

## Accepted state

Approved browser origins:

- `https://chatgpt.ashesh.dev`
- `https://big-agi-243b6.firebaseapp.com`

Firebase Authentication authorized domains are the matching hostnames. The production deployment has only the `chatgpt.ashesh.dev` alias.

The Firebase browser API key has these exact referrers:

- `https://chatgpt.ashesh.dev/*`
- `https://big-agi-243b6.firebaseapp.com/*`

It has these exact API targets:

- `firebaseappcheck.googleapis.com`
- `identitytoolkit.googleapis.com`
- `securetoken.googleapis.com`
- `firestore.googleapis.com`
- `firebasestorage.googleapis.com`

Private Pro uses Firebase Auth, App Check, Firestore, and Storage directly in approved browsers. Anonymous Firestore and Storage probes remain denied by rules. The browser referrer policy is `strict-origin-when-cross-origin`.

The bucket has exactly this CORS policy. `infra/private-pro/firebase-storage-cors-trace.json` records the installed `@firebase/storage` 0.14.4 evidence for `uploadBytesResumable`, `getBytes`, `getMetadata`, and `deleteObject`. The SDK uses POST, GET, and DELETE. The trace separates request headers from response headers read by the SDK. Cloud Storage `responseHeader` must contain the exact combined preflight and exposed-header set below.

```json
[
  {
    "origin": [
      "https://chatgpt.ashesh.dev",
      "https://big-agi-243b6.firebaseapp.com"
    ],
    "method": ["DELETE", "GET", "POST"],
    "responseHeader": [
      "Authorization",
      "Content-Type",
      "X-Firebase-AppCheck",
      "X-Firebase-GMPID",
      "X-Firebase-Storage-Version",
      "X-Goog-Upload-Command",
      "X-Goog-Upload-Header-Content-Length",
      "X-Goog-Upload-Header-Content-Type",
      "X-Goog-Upload-Offset",
      "X-Goog-Upload-Protocol",
      "X-Goog-Upload-Size-Received",
      "X-Goog-Upload-Status",
      "X-Goog-Upload-URL"
    ],
    "maxAgeSeconds": 3600
  }
]
```

Do not use wildcard origins, methods, headers, or referrers.

## Audit collection

Most audit collectors are read-only. The Firestore and Storage rule probes use the approved Origin and Referer plus `PRIVATE_PRO_SECURITY_AUDIT_APP_CHECK_TOKEN`, but send no Firebase Auth token. This lets the public browser API key and App Check pass so the result isolates Rules. The Storage read probe lists the fixed `users/{uid}/workspace-v1/assets/` prefix, which rules deny even when the prefix is empty. The Storage write probe matches the installed SDK multipart format and uses a unique operation-derived asset path. Unexpected allowed writes require operator Admin cleanup and remain blockers if cleanup cannot be confirmed. A missing token produces unknown blocking results and no endpoint fetch. Do not save raw API key, App Check token, IAM, Auth, or bucket output. Reduce it to counts and booleans.

Obtain a fresh short-lived App Check token from a clean approved browser immediately before the audit, then set it only in the current PowerShell process. The audit consumes and removes it, excludes it from child processes, and never logs it. Do not store it in dotenv files, CI, Vercel, profiles, command history, or reports.

```powershell
$ProjectId=$env:NEXT_PUBLIC_FIREBASE_PROJECT_ID
$Bucket=$env:NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
# Paste the short-lived value without echoing it, then clear it after the command.
$env:PRIVATE_PRO_SECURITY_AUDIT_APP_CHECK_TOKEN='<token-from-clean-approved-browser>'

gcloud projects describe $ProjectId --format=json
npm run private-pro:security-audit -- --report-only
Remove-Item Env:PRIVATE_PRO_SECURITY_AUDIT_APP_CHECK_TOKEN -ErrorAction SilentlyContinue
gcloud services api-keys lookup $env:NEXT_PUBLIC_FIREBASE_API_KEY --project=$ProjectId --format=json
gcloud storage buckets describe "gs://$Bucket" --format=json
vercel inspect chatgpt.ashesh.dev --format=json --non-interactive
```

Read Firebase Auth config with an access token held only in memory:

```powershell
$AccessToken = gcloud auth print-access-token
$Headers = @{ Authorization = "Bearer $AccessToken" }
Invoke-RestMethod -Method Get -Uri "https://identitytoolkit.googleapis.com/v2/projects/$ProjectId/config" -Headers $Headers
Remove-Variable AccessToken
```

## Approval-required changes

Do not run this section without explicit approval and a redacted before snapshot. Create `cors.private-pro.json` from the accepted CORS JSON above. Create `auth-domains.private-pro.json` with only the two accepted hostnames.

```powershell
$ProjectId=$env:NEXT_PUBLIC_FIREBASE_PROJECT_ID
$Bucket=$env:NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
$KeyResourceName='projects/PROJECT_NUMBER/locations/global/keys/KEY_ID'

gcloud services api-keys update $KeyResourceName --project=$ProjectId --allowed-referrers='https://chatgpt.ashesh.dev/*,https://big-agi-243b6.firebaseapp.com/*' --api-target=service=firebaseappcheck.googleapis.com --api-target=service=identitytoolkit.googleapis.com --api-target=service=securetoken.googleapis.com --api-target=service=firestore.googleapis.com --api-target=service=firebasestorage.googleapis.com

$AccessToken = gcloud auth print-access-token
$Headers = @{ Authorization = "Bearer $AccessToken"; 'Content-Type' = 'application/json' }
Invoke-RestMethod -Method Patch -Uri "https://identitytoolkit.googleapis.com/v2/projects/$ProjectId/config?updateMask=authorizedDomains" -Headers $Headers -InFile 'auth-domains.private-pro.json'
Remove-Variable AccessToken

gcloud storage buckets update "gs://$Bucket" --cors-file='cors.private-pro.json'
```

Keep separate local rollback files for the previous authorized domains, API key restrictions, and bucket CORS. Roll back only the affected surface. Never clear restrictions.

## Verification

- Run `npm run private-pro:security-audit` with a fresh transient App Check token and require zero origin, key, CORS, IAM, or no-Auth rule blockers. `--report-only` still performs the active probes.
- In a clean approved browser, complete Google sign-in and obtain App Check tokens.
- Confirm authenticated direct Firestore sync and Storage upload, download, metadata, and delete.
- Confirm App Check-qualified requests with no Firebase Auth remain denied by Firestore and Storage Rules. All four probes must return 403. A 401, 404, or missing token is unknown, not proof of a Rules denial.
- Confirm an unapproved origin cannot sign in or use bucket CORS.
- Confirm App Check metrics for Firestore and Storage before enforcing both products.

## References

- Firebase API key restrictions: <https://firebase.google.com/docs/projects/api-keys#api_restrictions>
- Google Cloud API key update: <https://cloud.google.com/sdk/gcloud/reference/services/api-keys/update>
- Cloud Storage CORS: <https://cloud.google.com/storage/docs/cors-configurations>
- Firebase App Check: <https://firebase.google.com/docs/app-check>
