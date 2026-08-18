# Task 20 report

## Status

Complete for code, tests, documentation, manifest, and local/static audit.

Cloud IAM provisioning, staging deployment, protected live probes, credential disablement, and key deletion were not performed. Those actions remain approval-gated for Tasks 21 and 24.

## Changes

- Firebase Admin now uses Application Default Credentials when static credentials are absent.
- A complete `FIREBASE_CLIENT_EMAIL` plus `FIREBASE_PRIVATE_KEY` pair remains supported and is classified as `static-key-fallback`.
- A partial static pair is rejected. Credential-construction errors do not expose private-key material.
- The pure `selectPrivateProFirebaseCredential()` helper selects and constructs credentials through injectable factories without initializing a global Admin app.
- `createPrivateProAdminAppOptions()` builds deterministic project ID, bucket, and credential initialization options.
- Server config exposes the safe credential source and makes static credential fields optional.
- App Check support is unchanged. Firebase ID-token and App Check verification use Google public keys and require no project IAM permission.
- The security audit accepts ADC/WIF without `FIREBASE_CLIENT_EMAIL`, warns when an ADC identity cannot be attributed, warns on static fallback, blocks partial static credentials, blocks broad roles, and validates the checked-in permission manifest.
- Deployment documentation prefers Vercel OIDC plus Google WIF without claiming it is configured. It documents static fallback rotation/removal and the approval gates.
- Browser Firestore and Storage documentation now matches Task 19's catch-all browser denial.

## Runtime permission manifest

`infra/private-pro/gcp-runtime-role.yaml` contains this exact custom project-role allowlist:

- `datastore.databases.get`
- `datastore.entities.create`
- `datastore.entities.delete`
- `datastore.entities.get`
- `datastore.entities.list`
- `datastore.entities.update`
- `firebaseauth.users.get`
- `firebaseauth.users.update`
- `storage.objects.create`
- `storage.objects.delete`
- `storage.objects.get`

The list covers the mounted Auth user/claim/token-revocation calls, Firestore document/query/batch/transaction operations, encrypted vault records and assets, and the still-mounted plaintext sync/asset server paths found in Task 19.

`iam.serviceAccounts.signBlob` is not in the custom project role. Signed URL generation uses a separate `roles/iam.serviceAccountTokenCreator` binding scoped to the dedicated runtime service account, with the service account as its own member. The external WIF principal receives only `roles/iam.workloadIdentityUser` on that service account.

The manifest excludes project update, bucket create/delete, ruleset/release mutation, API-key administration, IAM policy mutation, and unrelated Firebase product administration.

## TDD

Initial focused RED: 29 tests, 22 passed, 7 failed.

The failures covered missing ADC selection, missing static fallback classification, missing partial-pair rejection, missing deterministic Admin options, missing ADC-aware audit identity selection, missing static-fallback audit classification, and the absent permission manifest.

Additional RED covered certificate-factory errors that could echo a private-key sentinel and incorrect WIF signer-binding scope.

Final focused config, Firebase Admin, App Check, audit, manifest, and docs/config contract run: 36 passed, 0 failed.

## Verification

- Focused config/Firebase/audit/manifest/docs tests: 36 passed, 0 failed.
- Security-audit unit tests: 19 passed, 0 failed in the final audit-only run before the combined focused run.
- All Private Pro source/tool/encrypted-backup tests: 305 passed, 4 failed. The four failures are the existing duplicate-React invalid-hook-call failures in three vault accessibility renders and one legacy backup warning render. No Task 20 test failed.
- Focused changed-file TypeScript project: passed. The temporary project file was deleted and is not committed.
- `npm run tscheck`: blocked by the existing cross-worktree React type collision. The tools leg reported 5 ReactNode/JSX errors; the root leg reported 351 errors in 153 unrelated files.
- `npm run build`: compilation passed, then type validation failed at `pages/_app.tsx` with the same duplicate-React `bigint is not assignable to ReactNode` collision.
- ESLint: blocked before file analysis by the existing `@rushstack/eslint-patch` caller-recognition error.
- `npm run private-pro:security-audit -- --report-only`: exited 0 and validated every local runtime-role manifest check. The report remained non-passing because of existing live deployment, API-key, dependency, rules-probe, and unattributed-current-identity findings. No live state was changed.
- `git diff --check`: passed.

## Unverified live work

- Confirm the Vercel OIDC issuer and deployed runtime support the intended WIF token exchange.
- Provision the workload identity pool/provider, dedicated runtime service account, custom project role, project binding, WIF impersonation binding, and service-account-scoped signing binding.
- Validate every manifest permission with a staging identity across Auth bootstrap/claim/revocation, App Check, Firestore reads/queries/transactions/writes/deletes, Storage metadata/delete, and signed upload/download paths.
- Confirm the still-mounted plaintext sync and asset procedures and scheduled sweep operate with the same role until their later removal.
- Promote only after protected staging probes pass. Do not disable or delete the working static key before the replacement is verified and rollback time has elapsed.

## Commit

Subject: `Security: use least-privilege Firebase identity`

## Fix round 1

Status: complete.

### Review findings

The first implementation validated the local manifest and selected broad-role names, but it did not verify the deployed custom role or both deployed IAM policy scopes. It also treated the configured ADC service-account email as identity proof and accepted malformed manifest shapes through permissive object/string coercion.

### Changes

- Added deployed custom-role collection with:
  - `gcloud iam roles describe projects/PROJECT_ID/roles/privateProRuntime --format=json`.
  - Exact role name, `GA` stage, non-deleted state, and permission equality checks against the manifest.
- Replaced role-name blocklisting as the primary runtime-service-account policy check with exact allowed sets:
  - Project scope permits only `projects/PROJECT_ID/roles/privateProRuntime` for the runtime service account.
  - Any other project role for that service account blocks, including predefined object roles or arbitrary custom roles.
  - Any project-scoped `roles/iam.serviceAccountTokenCreator` binding blocks, regardless of member.
- Added service-account policy collection with `gcloud iam service-accounts get-iam-policy` and an exact matrix:
  - Every configured WIF member receives only `roles/iam.workloadIdentityUser`.
  - The runtime service account is the sole Token Creator member on itself.
  - External Token Creator members, extra members, extra roles, malformed bindings, and duplicate expected bindings block.
- Added `PRIVATE_PRO_WIF_RUNTIME_PRINCIPALS` as the comma-separated exact WIF-member expectation used by the live audit.
- Split expected identity from verified active identity:
  - `PRIVATE_PRO_RUNTIME_SERVICE_ACCOUNT_EMAIL` is only the expected service account.
  - ADC is resolved independently through the transitive `google-auth-library`: obtain an ADC access token, then read the credential's `client_email`.
  - Missing, non-service-account, or mismatched ADC identity blocks.
  - `gcloud auth list` and local gcloud user identity are not used as Vercel ADC proof.
  - Static fallback remains bound to its explicit paired client email and private key.
- Replaced permissive manifest coercion with an exact schema check for every relevant object and array:
  - Exact root, role, local-verification, WIF-binding, signing-binding, and validation keys.
  - Exact schema version, role ID, stage, placeholders, scopes, roles, permission, task gates, and signing member.
  - String-only, unique, sorted exact permission list.
  - Duplicate permissions, object entries, extra keys, wrong order, wrong placeholders/scopes, and `signBlob` in the custom role block.
- Added production audit collectors for the deployed role, project policy, and service-account policy. Collector failure is a blocker; `--report-only` prints it without changing the result.
- Updated deployment and environment-variable documentation with the live audit contract and fail-closed behavior.

### TDD

Fix-round RED:

```text
24 tests: 19 passed, 5 failed
```

The failures were the missing strict manifest schema, deployed-role comparison, exact project-role allowlist, service-account IAM policy matrix, and independent ADC principal verification.

Fix-round GREEN:

```text
41 focused config, Firebase Admin, App Check, audit, manifest, and docs tests passed, 0 failed
```

The adversarial manifest suite covers non-object roots, extra keys at every relevant level, wrong schema version/role/stage/placeholders/scopes, duplicate/non-string/unsorted permissions, missing and extra validation fields, and accidental `iam.serviceAccounts.signBlob` inclusion.

### Verification

- Focused config/Firebase Admin/App Check/audit/manifest/docs tests: 41 passed, 0 failed.
- `npm run private-pro:security-audit -- --report-only`: exited 0 and printed the report. The strict local manifest passed. Active ADC, deployed role, project policy, and service-account policy remained blockers because this local environment lacks the expected production identity/policy configuration. No cloud state was changed.
- `git diff --check`: passed.
- Tools TypeScript remains blocked only by the known cross-worktree duplicate React types: 5 JSX/ReactNode errors in 4 unrelated application files. No Task 20 TypeScript error was reported before that baseline failure.

### Cloud boundary

No IAM role, IAM policy, service account, workload identity provider, credential, deployment, or key was created, updated, disabled, or deleted. Live staging verification and provisioning remain approval-gated for Tasks 21 and 24.
