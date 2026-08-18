# Task 24 dependency hardening report

## Summary

Cleared every critical and high production dependency finding without upgrading Next.js to 16 or Firebase Admin to 14.

- Base: `059b312e40b44f25881983452f59fc148a3e1a22`
- Worktree: `F:\Projects\big-agi\.worktrees\private-pro-encrypted-vault`
- Scope: local dependency hardening only
- Cloud, deploy, push: not performed
- Lockfile: generated only by npm, `lockfileVersion: 3`

## Audit result

| Audit | Critical | High | Moderate | Total | Exit |
| --- | ---: | ---: | ---: | ---: | ---: |
| Task 23 baseline, `npm audit --omit=dev --json` | 0 | 9 | 10 | 19 | 1 |
| Final raw audit, `npm audit --omit=dev --json` | 0 | 0 | 8 | 8 | 1 |
| Final release threshold, `npm audit --omit=dev --audit-level=high --json` | 0 | 0 | 8 | 8 | 0 |

The raw final command exits 1 only because eight moderate Firebase Admin findings remain. No critical or high finding remains in the complete production audit.

Local audit evidence:

- `.superpowers/sdd/2026-08-17-private-pro-encrypted-vault/npm-audit-task24-before.json`
- `.superpowers/sdd/2026-08-17-private-pro-encrypted-vault/npm-audit-task24-final.json`
- `.superpowers/sdd/2026-08-17-private-pro-encrypted-vault/npm-audit-task24-final-high.json`

## Resolved findings

| Finding | Before | After | Resolution and proof |
| --- | --- | --- | --- |
| Mammoth XML parser | `mammoth@1.12.0` -> `@xmldom/xmldom@0.8.11` | `mammoth@1.12.1` -> `@xmldom/xmldom@0.8.14` | Same 0.8 parser line, patched above every audit threshold. Real minimal DOCX conversion and malformed ZIP rejection pass. |
| Mammoth recursion helper | `underscore@1.13.7` | `underscore@1.13.8` | Mammoth, lop, and duck all dedupe to the patched release. |
| Cheerio networking dependency | `cheerio@1.2.0` -> `undici@7.20.0` | `cheerio@1.2.0` -> `undici@7.29.0` | Latest audited-safe 7.x release. Browse cleaner tests exercise the real Cheerio entry without network calls. |
| Puppeteer proxy IP parser | Invalid optional peer reuse of dev `proxy-agent@6.5.0` -> `ip-address@10.2.0` | `puppeteer-core@25.8.0` -> `@puppeteer/browsers@3.2.1` -> `proxy-agent@8.0.2` -> `ip-address@10.5.0` | A direct production `proxy-agent` dependency is required because Puppeteer's browser package declares optional peer `>=8.0.1`. Firebase Tools retains its separate dev-only 6.x copy. `npm ls` reports the production peer as valid. |
| Bundle analyzer WebSocket | Production `@next/bundle-analyzer@15.1.12` -> `ws@7.5.10` | Production `@next/bundle-analyzer@15.5.23` -> `ws@7.5.11` | The statically imported config plugin remains installed for source production config loading, while its nested WebSocket is patched. Normal build passes with `ANALYZE_BUNDLE` unset. |
| Next PostCSS | `next@15.5.23` -> `postcss@8.4.31` | `next@15.5.23` -> `postcss@8.5.26` | Kept Next 15. Build, typecheck, lint, and tests pass. |
| Next nested Nano ID | `postcss@8.4.31` -> `nanoid@3.3.11` | `postcss@8.5.26` -> `nanoid@3.3.18` | Explicit nested override prevents regression to the vulnerable 3.x range. |
| Next optional Sharp | Nested `sharp@0.34.5` plus root `sharp@0.35.2` | One deduped `sharp@0.35.3` | Root Sharp upgraded and a `$sharp` override makes Next reuse it. The vulnerable nested package and platform packages are absent. |
| Next aggregate | High through PostCSS and Sharp | No audit node | Cleared by the compatible transitive overrides above, without a Next 16 major upgrade. |

Low-risk moderate cleanup also moved `dompurify` from `3.3.3` to `3.4.13` and YAML 1.x from `1.10.2` to `1.10.3`.

## Remaining moderate findings

Eight moderate nodes remain in the Firebase Admin 13 production graph:

- `firebase-admin`
- `@google-cloud/firestore`
- `@google-cloud/storage`
- `google-gax`
- `gaxios`
- `retry-request`
- `teeny-request`
- `uuid@9.0.1`

npm proposes Firebase Admin `14.2.0`, a semver-major application dependency change. Overriding UUID 9 to 11 across the Google clients also crosses declared major ranges. Neither change is required to clear the critical/high release threshold, so this pass leaves the tested Firebase Admin 13 runtime graph intact.

## Dependency policy

`tools/private-pro/dependency-security.test.ts` now prevents regression of:

- direct Mammoth, Cheerio, Puppeteer, proxy-agent, and Sharp floors;
- every security override and exact compatible release;
- bundle analyzer production placement;
- resolved package-lock versions;
- absence of Next's nested Sharp copy;
- production placement of proxy-agent 8.

TDD evidence:

- Initial RED: 3 tests failed because the new dependency floors, overrides, and analyzer placement were absent.
- Graph RED: the lock policy failed because Next retained nested Sharp 0.34.5 and Puppeteer reused invalid dev proxy-agent 6.5.0.
- DOCX and browse RED: the DOCX adapter could not use Mammoth's Node input and the browse cleaner had no focused test boundary.
- GREEN: dependency policy 4/4 and affected DOCX/browse behavior 4/4 pass.

The DOCX adapter now selects Mammoth's Node `buffer` input only when `window` is absent. Browser behavior continues to use `arrayBuffer`. The browse cleaner implementation is unchanged; it is exported from its existing router file only to allow focused behavior tests.

## Verification

| Command | Result |
| --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund` | Passed from the generated npm v3 lockfile, 1,532 packages installed. The first attempt encountered stale completed `tsx` test workers holding `esbuild.exe`; after terminating only those exact worktree test helpers, the unchanged lockfile installed cleanly. |
| Dependency, DOCX, browse, Private Pro, security focused suite | 299 passed, 0 failed. |
| `npm run tscheck` | Passed. |
| `npm run lint` | Passed. |
| Key-free `npm test` with vendor credential variables removed | 305 passed, 19 key-gated skips, 0 failed. |
| `npm run build`, `ANALYZE_BUNDLE` unset | Passed on Next.js 15.5.23. Existing multiple-lockfile workspace-root and edge-runtime warnings remain. |
| `npm audit --omit=dev --audit-level=high --json` | Exit 0, 0 critical, 0 high. |
| `git diff --check` | Passed. |

One non-key-free `npm test` run used an inherited Groq key and reproduced the existing live catalog drift for three stale Groq model definitions. The dependency change did not affect that catalog. The required key-free run passed after vendor credentials were explicitly removed.

## Files

- `package.json`
- `package-lock.json`
- `tools/private-pro/dependency-security.test.ts`
- `src/common/attachment-drafts/file-converters/DocxToMarkdown.ts`
- `src/common/attachment-drafts/file-converters/DocxToMarkdown.test.ts`
- `src/modules/browse/browse.router.ts`
- `src/modules/browse/browse.clean-html.ts`
- `src/modules/browse/browse.clean-html.test.ts`
- `src/common/image/nextImageOptimizer.test.ts`
- `next.config.ts`
- `.superpowers/sdd/2026-08-17-private-pro-encrypted-vault/task-24-dependencies-report.md`

## Fix round 1

### Production Next config topology

`next.config.ts` statically imports `@next/bundle-analyzer`. A source deployment that installs with `npm ci --omit=dev` must still load that config before a production server or other Next command can run. The analyzer is therefore a production dependency even though analysis itself is build-only. Fix round 1 returns `@next/bundle-analyzer@15.5.23` to `dependencies` and retains the `webpack-bundle-analyzer -> ws@7.5.11` security override.

The same review found a second static config import, `@posthog/nextjs-config`, which remains development-only because it pulls a build upload CLI with separate advisories. `next.config.ts` now exports Next's supported async config function and dynamically imports PostHog tooling only during `PHASE_PRODUCTION_BUILD` when both `POSTHOG_API_KEY` and `POSTHOG_ENV_ID` are present. A regression test supplies both variables during `PHASE_PRODUCTION_SERVER`, blocks module loading, and proves the runtime config path does not resolve the dev-only package.

The production topology probe is:

1. install from the npm v3 lock with `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`;
2. verify the local production `node_modules` contains `@next/bundle-analyzer` and omits `@posthog/nextjs-config`;
3. load the real `next.config.ts` through Next's production-server config phase with PostHog variables deliberately present and reject any attempted PostHog module load;
4. restore all dependencies from the unchanged lockfile.

Fix round evidence: the production-only install added 681 packages; the local analyzer package existed, the local PostHog package was absent, `@next/bundle-analyzer@15.5.23 -> webpack-bundle-analyzer@4.10.1 -> ws@7.5.11` was valid, and `loadConfig(PHASE_PRODUCTION_SERVER, ...)` returned the real application config. The probe did not start a server. Bare Node resolution from a linked worktree can see the parent checkout's `node_modules`, so local package existence plus a regression probe that rejects any attempted PostHog module load are the isolation checks.

This finding applies to source-based production installs. The current Docker runner does not copy `next.config.ts`, so no Docker runtime failure is claimed.

The browse HTML cleaner is moved byte-for-byte into `browse.clean-html.ts`, apart from its export, so its tests no longer import the full router and trigger Puppeteer, tRPC, and environment side effects.

### Sharp 0.35 compatibility

Next 15.5.23 declares optional Sharp `^0.34.3`, while the advisory is fixed only in Sharp 0.35. The `$sharp` override deliberately crosses that declared minor line. `src/common/image/nextImageOptimizer.test.ts` calls Next 15's real `optimizeImage` implementation on the repository's 32 px PNG, resizes it, encodes WebP through Sharp 0.35.3, and verifies the output signature. This covers the actual Next image optimizer boundary even though static export configuration uses `images.unoptimized`.

### Firebase Admin moderate advisory chain

All eight remaining audit nodes are propagation from one advisory, not eight independent vulnerable implementations:

- Advisory: `GHSA-w5hq-g745-h8pq`, npm source `1119441`.
- Affected package: `uuid@9.0.1`, reported range `<11.1.1`.
- Affected API: missing caller-supplied buffer bounds checks in UUID v3, v5, and v6 when a `buf` argument is provided.

| Audit node | Dependency propagation | Application reachability |
| --- | --- | --- |
| `uuid` | Under `gaxios`, `google-gax`, and `teeny-request`. | Installed code inspection finds only `v4()` calls with no buffer or offset. No application code imports this production UUID copy. |
| `gaxios` | Uses `uuid.v4()` for a multipart boundary. | Firebase Admin authentication and Google client HTTP requests can reach gaxios, but the affected v3/v5/v6 buffer APIs are not called. |
| `teeny-request` | Uses `uuid.v4()` for a multipart boundary. | Storage and retry request paths can reach teeny-request, but no caller-supplied UUID buffer is used. |
| `retry-request` | Depends on teeny-request. | Storage metadata/delete and Google client retry paths are mounted. The UUID behavior remains the teeny-request no-argument `v4()` call. |
| `google-gax` | Uses `uuid.v4()` for internal request IDs and also depends on retry-request. | Firestore transactions, reads, queries, writes, and deletes are mounted. No v3/v5/v6 buffer call exists in the installed gax code. |
| `@google-cloud/firestore` | Depends on the affected google-gax range. | Private Pro uses document reads/writes, queries, batch gets, and transactions through `getPrivateProFirestore()`. |
| `@google-cloud/storage` | Depends on retry-request and teeny-request. | Private Pro reads object metadata, deletes objects, and creates v4 signed upload/download URLs through `getPrivateProStorageBucket()`. Browser upload/download bytes go directly to the signed URL. |
| `firebase-admin` | Aggregates the Firestore and Storage findings. | Private Pro also verifies Auth and App Check tokens, updates claims, and revokes refresh tokens. The reported UUID path is specifically through its Firestore and Storage optional clients. |

Compensating controls and limits:

- application code never calls UUID v3, v5, or v6 from this dependency graph;
- installed affected consumers call only UUID v4 without a destination buffer or offset;
- untrusted request fields become Firestore document IDs, query values, object paths, or validated service inputs, not UUID output buffers;
- exact input bounds, schema validation, authenticated UID scoping, App Check, quota limits, and fixed signed-URL headers remain enforced at the application boundary;
- the production security audit continues to warn on moderate findings and blocks any high or critical finding;
- `dependency-security.test.ts` runs the installed npm audit and accepts only these exact eight nodes and their exact propagation sources. Any new node, advisory source, severity, or count fails the policy test.

Upgrade trigger: move to Firebase Admin `14.2.0` after its production bundle, Auth/App Check, Firestore transaction/query, Storage signed URL/metadata/delete, emulator, typecheck, and build compatibility are verified. Upgrade earlier, or block release, if the UUID advisory expands beyond v3/v5/v6 caller-supplied buffers, any installed Google client begins passing a buffer/offset, the severity becomes high or critical, or a compatible Firebase Admin 13/Google client release removes the advisory chain. Do not override UUID 9 to 11 across undeclared major ranges.

### Fix round verification

| Command | Result |
| --- | --- |
| Dependency policy tests | 6 passed, including the live exact audit allowlist and production-server config load. |
| Next image optimizer and browse cleaner tests | 3 passed. Next 15 produced valid WebP through Sharp 0.35.3. |
| Production-only install and config probe | `npm ci --omit=dev` passed with 681 packages; local analyzer present, local PostHog absent, real production-server config loaded; no server started. |
| Full dependency restore | `npm ci --ignore-scripts --no-audit --no-fund` passed with 1,532 packages. |
| Focused dependency, DOCX, image, browse, Private Pro, security suite | 302 passed, 0 failed. |
| `npm run tscheck` | Passed. |
| `npm run lint` | Passed. |
| Key-free `npm test` | 306 passed, 19 key-gated skips, 0 failed. |
| `npm run build` | Passed on Next.js 15.5.23 with PostHog and analyzer disabled. |
| `npm audit --omit=dev --json` | 0 critical, 0 high, 8 moderate. |
| `npm audit --omit=dev --audit-level=high --json` | Exit 0. |
| Browse cleaner move comparison | Exact implementation match after adding the Cheerio import and module export. |
