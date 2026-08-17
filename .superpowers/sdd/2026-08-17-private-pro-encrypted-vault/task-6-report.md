# Task 6 report

## Status

Implemented a deterministic, read-only private Pro security audit CLI.

## Changes

- Added pure classifiers for deployment headers and aliases, Firebase authorized domains, browser API-key restrictions, App Check enforcement, Firebase Admin IAM roles, service-account key counts and age, npm production advisories, and Firebase rule probes.
- Added live HTTPS, Vercel, gcloud, Google REST, and npm collectors. No cloud mutation commands are used.
- Added `npm run private-pro:security-audit`.
- The JSON report contains named keys whose values are booleans or integer counts only. It never emits domains, aliases, tokens, credentials, API-key values, service-account emails, key IDs, role names, package names, URLs, or upstream error text.
- Default execution prints the complete report and exits `1` when blockers exist. `--report-only` prints the identical report and exits `0` so CI or an operator can capture expected pre-remediation findings.

## TDD

RED:

```text
npx tsx --test tools/private-pro/security-audit.test.ts
exit 1: Cannot find module './security-audit'
```

Additional Windows launcher RED:

```text
uses Windows command executables for CLI collectors
TypeError: auditCommand is not a function
```

GREEN:

```text
npx tsx --test tools/private-pro/security-audit.test.ts
11 passed, 0 failed
```

## Verification

- `npx tsx --test tools/private-pro/security-audit.test.ts` - 11 passed.
- `npx eslint tools/private-pro/security-audit.ts tools/private-pro/security-audit.test.ts` - exit 0.
- `npm run tscheck` - exit 0.
- `npm run private-pro:security-audit -- --report-only` - exit 0, report `pass=false`, 19 pass findings, 3 warnings, and 14 blockers.
- Default `npm.cmd run private-pro:security-audit` - exit 1 with the blocking report.

## Live findings

The live report remains blocked before remediation as required. It records missing production response headers, two stale deployment aliases, unreadable authorized-domain and App Check configuration under the active Google credential, one browser key missing referrer restrictions, nine high production advisories, and unavailable non-mutating write-rule proof. It warns on one service-account user-style binding, one user-managed service-account key, and ten moderate advisories.

## Self-review

- Collector failures fail closed with one count and no error text.
- IAM classification is scoped to the Firebase Admin service identity, not all project principals.
- Service-account key IDs and API-key material are discarded before classification.
- The anonymous live rule collectors issue GET requests only. Missing-resource 404 responses do not count as proof of denial. Write checks remain blocked until an authenticated Firebase Rules simulation can prove them without mutation.
- `git diff --check` passes.

## Concerns

- The active Google credential cannot read Identity Platform authorized domains or App Check service enforcement, so those checks correctly block as unreadable.
- Live Firebase write-rule verification is intentionally conservative. The audit does not attempt anonymous writes, even to probe paths.

## Fix round 1

Addressed all six review findings.

- Replaced Windows `cmd.exe /c` execution with `execFile(..., { shell: false })`. Windows npm and gcloud shims are resolved to their underlying Node/Python entry points. Project, bucket, and configured service-account identifiers use strict validation.
- Added an execution regression using an argument containing `&`; the argument remains intact and no injected side-effect file is created.
- Browser API keys now require the exact production referrers, reject broad or stale referrers, require the explicit Firebase API service set, and block unrelated API targets.
- App Check passes only when every required service is present with `ENFORCED`; missing, unenforced, and unknown modes block.
- Malformed npm audit output, missing vulnerability metadata, and npm error payloads such as `EAUDITNOLOCK` block as unreadable.
- Runtime identity uses validated `FIREBASE_CLIENT_EMAIL` when configured, otherwise requires exactly one Firebase Admin identity. Missing or ambiguous identity and unreadable key data block.
- Firebase rule probes use `denied`, `allowed`, or `unknown`. Non-mutating live write probes remain explicitly `Unknown` blockers.

Fix verification:

- `npx tsx --test tools/private-pro/security-audit.test.ts` - 15 passed.
- `npx eslint tools/private-pro/security-audit.ts tools/private-pro/security-audit.test.ts` - exit 0.
- `npm run tscheck` - exit 0.
- `npm run private-pro:security-audit -- --report-only` - exit 0, report remains blocked with booleans/counts only.
- Default `npm.cmd run private-pro:security-audit` - exit 1.
- `git diff --check` - exit 0.
