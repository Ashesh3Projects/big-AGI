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
| Bundle analyzer WebSocket | Production `@next/bundle-analyzer@15.1.12` -> `ws@7.5.10` | Dev-only `@next/bundle-analyzer@15.5.23` -> `ws@7.5.11` | Analyzer moved to `devDependencies`; the nested WebSocket is patched for developer analysis builds. Normal build passes with `ANALYZE_BUNDLE` unset. |
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
- `src/modules/browse/browse.clean-html.test.ts`
- `.superpowers/sdd/2026-08-17-private-pro-encrypted-vault/task-24-dependencies-report.md`
