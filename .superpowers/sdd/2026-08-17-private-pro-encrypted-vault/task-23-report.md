# Task 23 report

## Status

Local verification complete. Live browser, device, account, deployment, and cloud-control acceptance remains pending.

**NOT READY FOR PRODUCTION.**

No deployment, push, real-account operation, IAM/WIF/API-key/Auth-domain/CORS mutation, deletion-protection/PITR/backup/restore mutation, attestor-key creation, or development-server start/stop occurred.

## Commits

- Base: `257f22a59a10ebe6cc4577a2aa274dd65851e986`
- Carried Task 22 fix: `e86685620ab4392a60b0af46ca181332cd687662` - `Security: isolate restore audit evidence`
- Initial verification evidence: `85ecbda112214c495423b96f1b7fc0ca109cb8a0` - `Docs: verify encrypted private vault`
- Acknowledgment test stabilization: `bf7ff8848` - `Test: stabilize vault acknowledgement verification`
- Audit one-shot coverage: `b9b04d6a1` - `Test: verify one-shot restore audit evidence`
- Fix-round evidence and this report: commit containing this update with subject `Docs: refresh encrypted vault verification`

## Carried security fix

The audit captures restore-evidence inputs into a frozen object and removes active/obsolete evidence and HMAC variables from `process.env` before collectors or GoogleAuth can start. Google ADC and WIF variables remain. The evidence collector receives the captured input explicitly. Production code does not restore consumed variables.

TDD:

- RED: 49 focused audit tests, 48 passed and 1 failed because `runSecurityAuditWithCollector` was missing.
- GREEN: 49/49 focused audit tests passed.
- Broad Private Pro tools: 54/54 passed.
- Focused TypeScript and `git diff --check`: passed.

Coverage includes a raw-environment credential executable, the generic child wrapper, explicit signed-evidence verification, retained Google ADC/WIF state, one-shot evidence consumption, and deterministic verification only after identical evidence is explicitly re-injected before the next audit startup. Environment restoration exists only in test cleanup.

## Dependency baseline repair

The earlier 337 React/JSX type errors and Rushstack startup failure came from an incomplete worktree `node_modules`: Emotion packages declared in the lockfile were absent, so tools loaded React/Emotion declarations from the main checkout.

`npm install --ignore-scripts --no-audit --no-fund` repaired only the isolated worktree. Package and lockfile hashes did not change, Git stayed clean, and no broad cache or main checkout was altered. TypeScript and ESLint then passed.

## Fix round 1

Review reproduced the acknowledgment barrier test as flaky. The original test waited for the server write and one timer turn, but the `beforeAcknowledgeCommit` hook runs later inside an IndexedDB transaction. The timer did not establish that ordering.

Production behavior did not change. The test now uses explicit deferred signals through the existing hook: acknowledgment entered, stop requested, stop observed blocked, then acknowledgment released.

Evidence:

- RED: 9 failures in 12 fresh-process runs at the old line 669 assertion.
- GREEN stress: 30 passed in 30 fresh-process runs.
- Engine test file: 20 passed, 0 failed.
- Exact focused suite: 213 passed, 0 failed.
- All Private Pro source and tool tests: 339 passed, 0 failed.
- Key-free `npm test`: 301 passed, 19 skipped, 0 failed.
- `npm run tscheck`: passed.
- `npm run lint`: passed.

The restore-audit test and documentation now state the one-shot contract exactly. A startup consumes the evidence variables. A second startup without re-injection receives an empty frozen input. Deterministic matching verification requires explicitly re-injecting identical evidence before the later startup. Focused audit tests passed 49/49.

## Verification

- Focused vault/trade/security/code-renderer tests: 213 passed, 0 failed.
- All Private Pro source tests: 285 passed, 0 failed.
- Private Pro tools: 54 passed, 0 failed.
- Firebase emulator with Microsoft OpenJDK 21: 35 passed, 0 failed.
- `npm run tscheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed. The tracked `next-env.d.ts` generator delta was reverted.
- `npm test` with ambient live-vendor credentials: 301 passed, 18 skipped, 1 failed. The only failure was unrelated live Groq catalog drift for three stale curated IDs. No Private Pro test failed.
- Key-free deterministic `npm test`: 301 passed, 19 live-vendor skips, 0 failed.
- `npm audit --omit=dev`: exit 1 with 9 high and 10 moderate findings.
- Clean-tree audit report-only: exit 0 by contract, 46 pass, 8 warn, 44 block.
- Clean-tree blocking audit: expected exit 1, same 46 pass, 8 warn, 44 block.
- `git diff --check`: passed before documentation edits.
- Fix round 1 named-test stress: 30/30 passed.
- Fix round 1 exact focused suite: 213/213 passed.
- Fix round 1 all Private Pro source and tools: 339/339 passed.
- Fix round 1 key-free repository suite: 301 passed, 19 skipped, 0 failed.
- Fix round 1 `npm run tscheck` and `npm run lint`: passed.
- Final post-one-shot combined engine/audit tests: 69/69 passed.
- Final post-one-shot exact focused suite: 213/213 passed.
- Final post-one-shot all Private Pro source and tools: 339/339 passed.

## Plaintext review

Existing tests and source scans cover ciphertext-only encrypted exports, plaintext-field rejection in the vault database, encrypted outbox content, explicit serializers, secret-free errors, hydrated-asset cleanup, and denial of encrypted and former plaintext Firebase paths. No operational plaintext-migration symbol or canonical migration-rehearsal instruction remains.

The generic legacy `Export All` remains unencrypted and explicitly warns that it can contain API keys. It is not accepted as a Private Pro vault backup.

## Blockers

- Nine high dependency findings remain. Runtime-reachable paths include user DOCX conversion; other high paths are Next build/image tooling, Cheerio's installed Undici dependency, Puppeteer proxy parsing, and conditional bundle analysis. No high finding was silently waived.
- Production headers and alias state do not pass the audit.
- Authorized-domain, browser-key, and App Check collectors do not pass.
- Bucket CORS has missing/stale origins and an extra method.
- Firestore deletion protection is disabled. PITR/RPO/RTO/cost selection remains pending.
- Restore trust is unconfigured and no approved signed restore evidence exists.
- Runtime identity, deployed role, project policy, and service-account policy do not pass.
- Read-only Firebase write probes remain unknown.
- Clean-profile first setup, encrypted export/restore, PC A/PC B sync, logout, recovery, and password rotation were not executed.

## Evidence

Durable matrix: `docs/superpowers/2026-08-18-private-pro-encrypted-vault-verification.md`

## Cloud boundary

Cloud mutations: zero.
