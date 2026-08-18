# Encrypted private vault verification

## Status

**NOT READY FOR PRODUCTION.**

Local verification completed against code commit `e86685620ab4392a60b0af46ca181332cd687662` on 2026-08-18 IST. The branch still has approval-gated live-control blockers, nine high dependency audit findings, and unexecuted clean-profile and multi-device acceptance.

This verification was local and read-only except for generated files inside the isolated worktree. It did not:

- start or stop a development server;
- deploy or push;
- use a real user account;
- change IAM, WIF, API keys, Auth domains, aliases, bucket CORS, App Check, deletion protection, PITR, backups, exports, restore targets, or retention;
- create an attestor key, trust descriptor, restore artifact, or signed restore evidence;
- alter the main checkout.

## Scope

- Branch: `codex/private-pro-encrypted-vault`
- Worktree: `F:\Projects\big-agi\.worktrees\private-pro-encrypted-vault`
- Verified code commit: `e86685620ab4392a60b0af46ca181332cd687662`
- Verification timezone: Asia/Calcutta, UTC+05:30
- OS: Windows 10 Pro, 10.0.19045, x64
- Node.js: `v24.5.0`
- npm: `11.5.1`
- TypeScript: `6.0.3`
- Next.js: `15.5.23`
- Firebase CLI: `15.27.0`
- Firebase emulator Java: Microsoft OpenJDK `21.0.4+7-LTS`

## Restore audit evidence isolation

The Task 22 follow-on was implemented with test-first development and committed separately as `e86685620` with subject `Security: isolate restore audit evidence`.

The audit now:

1. captures `PRIVATE_PRO_FIRESTORE_RESTORE_EVIDENCE_BASE64` and the optional expected release commit synchronously at audit startup;
2. stores the captured values in a frozen audit-input object;
3. removes active and obsolete restore-evidence and restore-HMAC variables from `process.env` before any collector, `Promise.all`, `GoogleAuth`, `execFile`, or credential executable can start;
4. retains Google ADC and WIF environment variables;
5. passes the captured values explicitly to the restore-evidence collector;
6. never restores consumed evidence variables in production code.

TDD evidence:

| Phase | Command | Result |
|---|---|---|
| RED | `npx cross-env NODE_ENV=development tsx --test tools/private-pro/security-audit.test.ts` | 49 tests: 48 passed, 1 failed. Expected failure: `runSecurityAuditWithCollector` did not exist. |
| GREEN | Same focused command | 49 passed, 0 failed. |
| Broad tool regression | `npm run test:private-pro-tools` | 54 passed, 0 failed. |
| Focused type check | `npx tsc --ignoreConfig --noEmit --target es2022 --module ESNext --moduleResolution Bundler --esModuleInterop --skipLibCheck --strict --types node --lib dom,dom.iterable,ESNext tools/private-pro/security-audit.ts tools/private-pro/security-audit.test.ts` | Passed. |

The regression test executes two audit invocations in one process. It proves that:

- a fake Google credential executable inheriting raw `process.env` cannot see the signed evidence, expected commit, legacy HMAC, obsolete evidence path, or obsolete evidence root;
- the generic child-process wrapper cannot see the signed evidence, expected commit, or legacy HMAC;
- `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES`, and the configured WIF principal variable remain available;
- the explicitly passed signed evidence still verifies its signature and release binding;
- repeated invocation produces the same result;
- only the test restores environment state in its `finally` block.

## Worktree dependency repair

Before repair, `npm run tscheck` produced 337 JSX/React errors in 152 files and ESLint stopped inside the Rushstack patch. Investigation showed that this worktree's `node_modules` was incomplete. `@emotion/react` and `@emotion/styled` were present in `package-lock.json` but absent locally, so TypeScript walked up to the main checkout and loaded a second React/Emotion declaration tree.

The repair was limited to the isolated worktree:

```text
npm install --ignore-scripts --no-audit --no-fund
```

Evidence:

- the dry run identified the missing lockfile-declared packages;
- the install restored 151 packages and reconciled 57 package entries in `node_modules`;
- `package.json` SHA-256 stayed `48C9E86D877B9B3E23838361C71F8B8A26B74BECFD49183512867D7F52A58071`;
- `package-lock.json` SHA-256 stayed `E4D788B320ADAC96D58A20E959A0287ACB2778E1265E2AF8881D59A7ACCB826D`;
- Git remained clean;
- local resolution selected the worktree copies of Emotion, React, and React types;
- `tsc --listFilesOnly` no longer loaded React or Emotion declarations from the main checkout;
- `npm run tscheck` and `npm run lint` then passed.

No generated `.next` directory, broad cache, or main-checkout dependency tree was deleted.

## Command matrix

All timestamps are 2026-08-18 UTC+05:30.

| Status | Start - end | Command | Result |
|---|---|---|---|
| PASS | 21:11:30 - 21:11:47 | `npx cross-env NODE_ENV=development tsx --test "src/modules/private-pro/vault/**/*.test.ts" "src/modules/trade/privateProEncryptedBackup.test.ts" "src/common/security/*.test.ts" "src/modules/blocks/code/code-renderers/*.test.ts"` | 213 passed, 0 failed. |
| PASS | 21:12:43 - 21:13:00 | `npx --no-install cross-env NODE_ENV=development tsx --test "src/modules/private-pro/**/*.test.ts" "src/modules/trade/privateProEncryptedBackup.test.ts"` | 285 passed, 0 failed. |
| PASS | 21:13:09 - 21:13:11 | `npm run test:private-pro-tools` | 54 passed, 0 failed. |
| PASS | 21:13:17 - 21:13:32 | `npm run test:firebase:exec` with Microsoft JDK 21 | 35 passed, 0 failed. Emulator stopped normally. Permission-denied log lines were expected assertions. |
| PASS | 21:13:53 - 21:14:20 | `npm run tscheck` | Both root and tools TypeScript projects passed. |
| PASS | 21:14:32 - 21:14:55 | `npm run lint` | Passed. |
| KNOWN UNRELATED BASELINE | 21:15:01 - 21:15:20 | `npm test` with the ambient live-vendor environment | Private Pro tools passed 54/54. Repository result: 301 passed, 18 skipped, 1 failed. The only failure was the live Groq model-list drift check. Current upstream omitted three curated IDs: `minimaxai/minimax-m2.7`, `llama-3.3-70b-versatile`, and `llama-3.1-8b-instant`. No Private Pro test failed. |
| PASS | 21:15:48 - 21:16:07 | `npm test` in a process with live-vendor keys and local-host opt-ins removed | 301 passed, 19 live-vendor tests skipped, 0 failed. This is the deterministic local repository baseline. |
| PASS | 21:16:18 - 21:17:21 | `npm run build` | Compiled, linted, type-checked, generated 17 static pages, and completed trace collection. Next warned that multiple worktree lockfiles caused parent-root inference. The generated `next-env.d.ts` line was reverted. |
| BLOCKED | 21:17:41 - 21:17:45 | `npm audit --omit=dev` | Exit 1: 19 findings, including 9 high and 10 moderate. See dependency ruling below. |
| PASS WITH BLOCKERS REPORTED | 21:24:56 - 21:25:00 | `npm run private-pro:security-audit -- --report-only` | Exit 0 by report-only contract. Summary: 46 pass, 8 warn, 44 block. The clean-worktree check passed. |
| EXPECTED BLOCKING FAILURE | 21:25:00 - 21:25:04 | `npm run private-pro:security-audit` | Exit 1. Same 46 pass, 8 warn, 44 block findings. |
| PASS | 21:25:04 | `git diff --check` | Passed against the clean verified code commit. |

## Repository test baseline

The live Groq failure is not hidden by the key-free run. Both results are required evidence:

- the environment-bearing run proves current upstream model drift outside Private Pro;
- the key-free run proves the deterministic repository suite is locally green;
- all focused and broad Private Pro tests passed in both contexts.

Refreshing the Groq catalog is separate LLM vendor maintenance and was not performed in this verification task.

## Plaintext leakage review

No Private Pro vault plaintext leakage was found in the tested durable-store, backup, transport, or error surfaces.

Automated and static evidence includes:

- `privatePro.vault.db.test.ts` rejects plaintext fields in persisted encrypted records and validates non-exportable stored device keys;
- `privateProEncryptedBackup.test.ts` proves the encrypted export does not contain a plaintext API key and validates the full ciphertext stream before applying data;
- `privatePro.vault.engine.test.ts` proves the encrypted outbox does not retain plaintext fragments;
- `privatePro.vault.serializers.test.ts` verifies the explicit portable-state inclusion and exclusion matrix;
- `ProviderPrivateProVault.test.ts` and router tests prove raw password, activation, Firebase, and storage errors do not enter visible state or client errors;
- encrypted asset tests keep filename, MIME type, label, and origin inside the encrypted manifest and clear vault-hydrated plaintext on logout;
- Firebase emulator tests deny browser reads, writes, deletes, list queries, and collection-group scans for encrypted vault paths and former plaintext paths;
- source scans found no operational plaintext-migration symbol or canonical migration-rehearsal instruction.

The older generic `Export All` feature remains an unencrypted local backup surface and explicitly warns that it can contain API keys. It is not the Private Pro encrypted backup and must not be used as release evidence for the vault.

## Dependency audit ruling

No critical finding was reported. The nine high findings are not waived. The branch remains blocked until the production audit no longer reports reachable high findings or a separately approved dependency change removes the vulnerable production package path.

| Package path | Severity | Reachability and current control | Ruling |
|---|---|---|---|
| Mammoth -> `@xmldom/xmldom` | High | User-supplied DOCX data reaches Mammoth's XML parser. The local adapter does not call the vulnerable XML serializer directly, but user-controlled document structure reaches the affected dependency. | BLOCKED. Upgrade or replace the path. |
| Mammoth -> `underscore` | High | User-supplied DOCX conversion reaches Mammoth's recursive collection helpers. There is no verified depth bound proving the reported recursion issue unreachable. | BLOCKED. Upgrade or replace the path. |
| Next -> `postcss` and nested `nanoid` | High | Used during reviewed-source builds, not from a normal user request. Builds do not accept untrusted CSS or source maps in this workflow. | Compensating build control exists, but the security audit still blocks. Upgrade the patched Next/PostCSS path. |
| Next optional `sharp@0.34.5` | High | `next.config.ts` sets `images.unoptimized: true`; application source does not import Sharp; the direct root Sharp is `0.35.2`. | Not observed on the runtime image path, but installed production metadata still blocks the audit. Remove or update the nested vulnerable copy. |
| Cheerio -> `undici@7.20.0` | High | The application imports the full Cheerio entry but calls only `load()` on HTML already fetched by Puppeteer. It does not call Cheerio networking or WebSocket APIs. | Current call path avoids the affected network APIs, but the vulnerable runtime package remains installed. Upgrade or remove the full entry dependency. |
| Puppeteer proxy stack -> `ip-address@10.2.0` | High | Conditional proxy parsing path. Local verification did not prove that every deployment disables proxy configuration, so SSRF classification bypasses cannot be declared unreachable. | BLOCKED. Upgrade the dependency path. |
| Bundle analyzer -> `ws@7.5.10` | High | Loaded only when `ANALYZE_BUNDLE` is set. The verified production build did not enable it. | Build-only compensating control exists, but the package is in the production dependency tree. Move analyzer tooling to development-only or upgrade it. |
| PostHog -> `dompurify` | Moderate | Optional analytics load only. Product-tour sanitization uses string input and fixed `ADD_TAGS`/`ADD_ATTR` arrays, not function predicates or `IN_PLACE`. Surveys are disabled. | Upgrade required before relying on remote HTML product tours. |
| Firebase Admin/Google clients -> `uuid@9` | Moderate | Observed Firebase Admin use is UUID v4. The reported unsafe caller-supplied buffer behavior affects other UUID modes. | No affected application call was found, but upgrade remains required. |
| Emotion build chain -> `yaml@1.10.2` | Moderate | Build-time configuration parser; production requests do not supply YAML. | Build-only compensating control. Upgrade when the Emotion build chain allows it. |

`npm audit` also reports production-tree metadata through optional or conditional package paths. The blocking audit intentionally treats the aggregate high count as a release blocker even where a local reachability control exists.

## Security audit blockers

The final clean-tree report-only and blocking runs both produced 46 pass, 8 warn, and 44 block findings.

| Area | Current blocker |
|---|---|
| Deployment headers | CSP, wildcard-CORS absence, `nosniff`, referrer policy, permissions policy, frame denial, and cross-origin opener policy did not pass. HSTS passed. |
| Deployment aliases | Two stale aliases remain. |
| Firebase Auth and browser key | Authorized-domain and browser-API-key collectors were unreadable in this local environment. They do not count as passing. |
| Bucket CORS | One required origin is missing, two stale origins remain, and one extra method is present. |
| App Check | Collector was unreadable. Live enforcement is not accepted. |
| Firestore recovery | Deletion protection is disabled. PITR/RPO/RTO selection remains a warning pending a cost and recovery decision. |
| Restore evidence | No approved rehearsal ran. Evidence, independent trust, signature, provenance, release binding, target isolation, counts, hashes, application acceptance, and cleanup evidence remain blocked. The final clean-worktree check passed. |
| Runtime identity and IAM | The expected runtime identity is not configured or actively verified. Deployed custom role, project policy, and service-account policy collectors did not pass. IAM and service-account-key observations remain warnings where identity attribution is unavailable. |
| Dependencies | Nine high findings block. Ten moderate findings warn. |
| Firebase rule probes | Anonymous Firestore and Storage reads were denied. Write state remained unknown in the read-only audit and therefore blocks. Emulator rules passed locally. |

Blocking mode must not be changed to report-only in release automation. Production readiness requires the blocking command itself to exit 0.

## Pending live acceptance

All items below are PENDING. None was simulated as a production success.

### Preconditions

- [ ] Resolve the nine high dependency findings and rerun `npm audit --omit=dev`.
- [ ] Complete and approve the header, alias, Auth-domain, browser-key, CORS, and App Check changes.
- [ ] Provision and validate the dedicated runtime identity, WIF or approved static fallback, custom role, project binding, service-account policy, and key state.
- [ ] Enable Firestore deletion protection after explicit approval.
- [ ] Record the approved RPO, RTO, cost, and PITR/backup/export decision.
- [ ] Configure an independently held restore attestor trust key after separate review.
- [ ] Run an approved non-destructive restore rehearsal and inject signed evidence only into the audit process.
- [ ] Make `npm run private-pro:security-audit` exit 0 in the release environment.
- [ ] Provide an approved deployment and test accounts. The verifier must not start or stop the application server.

### Clean-profile setup and reconstruction

- [ ] Open an empty browser profile with no Big-AGI localStorage, IndexedDB, cookies, service workers, or cached site data.
- [ ] Sign in with an approved test account and confirm there is no plaintext migration gate.
- [ ] Complete password setup and recovery-key confirmation.
- [ ] Store the recovery key outside browser storage and capture only a redacted completion record.
- [ ] Add sentinel portable state: provider configuration, one non-secret preference, one chat/persona record, and one encrypted asset where supported.
- [ ] Confirm application editing remains blocked until vault setup and hydration complete.
- [ ] Inspect browser durable stores for schema and ciphertext shape without copying secrets into evidence.
- [ ] Create the encrypted Private Pro export.
- [ ] Confirm the export does not contain the sentinel provider secret or other plaintext portable state.
- [ ] Restore the export into a second clean profile and verify complete reconstruction.
- [ ] Confirm the generic unencrypted `Export All` flow is not used for this acceptance.

### PC A and PC B

- [ ] PC A unlocks and adds a sentinel provider key.
- [ ] PC B signs in from an empty local profile and cannot open settings before vault unlock and hydration.
- [ ] PC B unlocks and sees the provider configuration before settings become editable.
- [ ] PC B changes the theme.
- [ ] PC A receives the theme revision without losing the provider key.
- [ ] A concurrent edit or reconnect does not regress the remote revision or expose plaintext.
- [ ] Log out PC B and reload. Password or recovery unlock is required again.
- [ ] Confirm logout clears remembered unlock material as selected and clears vault-hydrated plaintext assets.

### Recovery and rotation

- [ ] Use a third clean profile and the saved recovery key.
- [ ] Reconstruct all sentinel state before editing is enabled.
- [ ] Rotate the password.
- [ ] Verify the old password fails, the new password succeeds, and recovery access remains valid.
- [ ] Verify device registration, revocation, and remembered-device behavior match the selected policy.

### Evidence handling

- [ ] Record commit, deployment identifier, device/profile identifiers, timestamps, and pass/fail only.
- [ ] Do not record provider keys, recovery keys, passwords, tokens, raw IAM policies, project numbers, raw restore evidence, or ciphertext payloads.
- [ ] Attach redacted screenshots or hashes only where they prove a checklist result.
- [ ] Rerun report-only and blocking security audits after acceptance.

## Release decision

Local implementation and regression verification are complete for the encrypted vault code at `e86685620ab4392a60b0af46ca181332cd687662`.

The release decision remains **NOT READY FOR PRODUCTION** until:

1. all approval-gated controls are implemented and verified;
2. blocking security audit exits 0;
3. no reachable critical or high dependency finding remains;
4. clean-profile setup/export/restore passes;
5. PC A/PC B and recovery/password-rotation acceptance passes.
