# Task 23 report

## Status

Local verification complete. Live browser, device, account, deployment, and cloud-control acceptance remains pending.

**NOT READY FOR PRODUCTION.**

No deployment, push, real-account operation, IAM/WIF/API-key/Auth-domain/CORS mutation, deletion-protection/PITR/backup/restore mutation, attestor-key creation, or development-server start/stop occurred.

## Commits

- Base: `257f22a59a10ebe6cc4577a2aa274dd65851e986`
- Carried Task 22 fix: `e86685620ab4392a60b0af46ca181332cd687662` - `Security: isolate restore audit evidence`
- Verification evidence and this report: commit containing this file with subject `Docs: verify encrypted private vault`

## Carried security fix

The audit captures restore-evidence inputs into a frozen object and removes active/obsolete evidence and HMAC variables from `process.env` before collectors or GoogleAuth can start. Google ADC and WIF variables remain. The evidence collector receives the captured input explicitly. Production code does not restore consumed variables.

TDD:

- RED: 49 focused audit tests, 48 passed and 1 failed because `runSecurityAuditWithCollector` was missing.
- GREEN: 49/49 focused audit tests passed.
- Broad Private Pro tools: 54/54 passed.
- Focused TypeScript and `git diff --check`: passed.

Coverage includes a raw-environment credential executable, the generic child wrapper, explicit signed-evidence verification, retained Google ADC/WIF state, and two deterministic audit invocations in one process. Environment restoration exists only in test cleanup.

## Dependency baseline repair

The earlier 337 React/JSX type errors and Rushstack startup failure came from an incomplete worktree `node_modules`: Emotion packages declared in the lockfile were absent, so tools loaded React/Emotion declarations from the main checkout.

`npm install --ignore-scripts --no-audit --no-fund` repaired only the isolated worktree. Package and lockfile hashes did not change, Git stayed clean, and no broad cache or main checkout was altered. TypeScript and ESLint then passed.

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
