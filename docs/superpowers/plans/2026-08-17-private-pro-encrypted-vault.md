# Private Pro Encrypted Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace private Pro plaintext persistence and partial cloud sync with a blocking, multi-device, end-to-end encrypted vault for chats, attachments, AI credentials, model configuration, and portable settings.

**Architecture:** Implement this as four release stages: security hardening, browser cryptographic/persistence foundation, encrypted segmented synchronization and migration, then live rollout. The browser alone holds plaintext and encryption keys; Vercel assigns revisions and stores opaque envelopes in Firebase. Private Pro startup stays blocked until the remembered device or password unlocks the vault and all current server revisions are downloaded and applied.

**Tech Stack:** Next.js 15, React 18, TypeScript 6, Zustand 5, Dexie 4, Web Crypto AES-GCM/HKDF/PBKDF2, Argon2id WASM worker, Firebase Auth/Firestore/Storage/App Check, tRPC 11, Zod 4, Firebase Emulator Suite, Node test runner through `tsx`.

**Spec:** `docs/superpowers/specs/2026-08-17-private-pro-encrypted-vault-design.md`

## Global Constraints

- Never start or stop a development server.
- Use normal hyphens, never em dashes, in prose, code comments, commits, and UI copy.
- Keep Open/self-hosted behavior unchanged unless a security fix is safe and explicitly tested for both builds.
- Never serialize localStorage or Zustand state wholesale into the cloud vault.
- Never persist the raw vault password, password-derived key, or plaintext vault master key.
- Never log plaintext records, API keys, tokens, key envelopes, ciphertext, or provider request bodies.
- Every production-code change follows test-first red-green-refactor.
- No reachable critical or high production dependency advisory may remain when credential sync is enabled.
- Do not delete legacy plaintext data until its encrypted replacement has been uploaded, downloaded, decrypted, and validated.
- Do not push or deploy until the user explicitly approves that action.

---

## File structure

### Security hardening

- `next.config.ts`: security headers and production CSP.
- `src/common/security/securityHeaders.ts`: header/CSP construction and testable policy helpers.
- `src/common/security/securityHeaders.test.ts`: exact policy tests.
- `src/modules/blocks/code/code-renderers/svgSanitize.ts`: shared strict SVG sanitizer.
- `src/modules/blocks/code/code-renderers/svgSanitize.test.ts`: malicious SVG fixtures.
- `src/modules/blocks/code/code-renderers/RenderCodeHtmlIFrame.tsx`: opaque sandboxed generated HTML.
- `src/modules/blocks/code/code-renderers/RenderCodeSVG.tsx`: sanitized SVG rendering.
- `src/modules/blocks/code/code-renderers/RenderCodeMermaid.tsx`: sanitized Mermaid SVG and text-only errors.
- `src/modules/blocks/code/code-renderers/RenderCodePlantUML.tsx`: sanitized PlantUML SVG and text-only errors.
- `src/apps/chat/components/live-svg/LiveSvgAnimator.tsx`: retain sanitized SVG guarantee at the final sink.
- `src/modules/blocks/code/code-renderers/contentExecution.security.test.ts`: same-origin/XSS regression tests.
- `package.json`, `package-lock.json`: patched production dependencies and Argon2id dependency.

### Vault cryptography and local persistence

- `src/modules/private-pro/vault/privatePro.vault.types.ts`: envelope, keyset, record, index, and state types.
- `src/modules/private-pro/vault/privatePro.vault.schemas.ts`: Zod wire/storage schemas.
- `src/modules/private-pro/vault/privatePro.vault.crypto.ts`: AES-GCM, HKDF, HMAC, wrapping, and authenticated-data helpers.
- `src/modules/private-pro/vault/privatePro.vault.password.worker.ts`: Argon2id worker entry point.
- `src/modules/private-pro/vault/privatePro.vault.password.ts`: worker client and PBKDF2 compatibility fallback.
- `src/modules/private-pro/vault/privatePro.vault.recovery.ts`: printable recovery-key generation/parsing/checksum.
- `src/modules/private-pro/vault/privatePro.vault.crypto.test.ts`: known-answer, tamper, and nonce tests.
- `src/modules/private-pro/vault/privatePro.vault.db.ts`: Dexie encrypted cache/outbox/device-key/migration database.
- `src/modules/private-pro/vault/privatePro.vault.db.test.ts`: IndexedDB and non-exportable `CryptoKey` tests.
- `src/modules/private-pro/vault/privatePro.vault.session.ts`: runtime key/session lifecycle and best-effort clearing.

### Portable serializers and adapters

- `src/modules/private-pro/vault/privatePro.vault.recordIds.ts`: opaque ID derivation and record family mapping.
- `src/modules/private-pro/vault/privatePro.vault.serializers.ts`: registry and common validation.
- `src/modules/private-pro/vault/serializers/*.ts`: focused serializers for models/credentials, settings groups, chats, personas, folders, Scratch Clip, and asset manifests.
- `src/modules/private-pro/vault/privatePro.vault.serializers.test.ts`: portable inclusion/exclusion matrix.
- Existing stores under `src/apps/**/store-*`, `src/common/stores/**`, and `src/modules/**/store-*`: narrow snapshot/apply/subscribe adapters only.
- `src/modules/trade/BackupRestore.tsx`: encrypted export/import, with explicit legacy plaintext warning.

### Server storage and sync

- `src/modules/private-pro/vault/privatePro.vault.repository.ts`: server repository contract.
- `src/modules/private-pro/vault/privatePro.vault.repository.firebase.ts`: Firestore implementation.
- `src/modules/private-pro/vault/privatePro.vault.service.ts`: compare-and-swap, index, keyset, and migration service.
- `src/modules/private-pro/vault/privatePro.vault.router.ts`: authenticated tRPC procedures.
- `src/modules/private-pro/vault/privatePro.vault.service.test.ts`: in-memory service tests.
- `src/modules/private-pro/vault/privatePro.vault.transport.ts`: browser transport.
- `src/modules/private-pro/vault/privatePro.vault.engine.ts`: blocking hydration, mutation replay, and conflict behavior.
- `src/modules/private-pro/vault/privatePro.vault.engine.test.ts`: simulated multi-PC tests.
- `src/modules/private-pro/vault/ProviderPrivateProVault.tsx`: startup gate and lifecycle.
- `src/modules/private-pro/vault/store-private-pro-vault.ts`: UI status only, without secret material.
- `pages/_app.tsx`: install vault provider before application UI.
- `src/server/trpc/trpc.router-cloud.ts`: mount the vault router.

### Encrypted assets and migration

- `src/modules/private-pro/vault/privatePro.vault.assets.crypto.ts`: asset chunk encryption/decryption.
- `src/modules/private-pro/vault/privatePro.vault.assets.client.ts`: encrypted upload/download orchestration.
- `src/modules/private-pro/vault/privatePro.vault.assets.service.ts`: opaque encrypted-object quota/finalization.
- `src/modules/private-pro/vault/privatePro.vault.assets.firebase.ts`: signed encrypted chunk storage.
- `src/modules/private-pro/vault/privatePro.vault.migration.ts`: local/cloud migration state machine.
- `src/modules/private-pro/vault/privatePro.vault.migration.test.ts`: interruption and verification tests.
- `src/modules/private-pro/ui/PrivateProVaultSetup.tsx`: password/recovery setup.
- `src/modules/private-pro/ui/PrivateProVaultUnlock.tsx`: password/recovery unlock.
- `src/modules/private-pro/ui/PrivateProVaultStatus.tsx`: blocking sync/migration/reconnect screens.
- `src/modules/private-pro/ui/PrivateProAccountControl.tsx`: password change, device revocation, encrypted export, logout.

### Firebase and deployment

- `firestore.rules`, `storage.rules`, `firestore.indexes.json`: encrypted vault paths and deny-by-default rules.
- `test/firebase/private-pro.rules.test.ts`: expanded cross-account and encrypted path tests.
- `src/modules/private-pro/firebase/firebase.client.ts`: reCAPTCHA Enterprise App Check provider.
- `src/modules/private-pro/firebase/firebase.appcheck.server.ts`: mandatory production enforcement.
- `src/modules/private-pro/config/privatePro.config.ts`, `privatePro.config.server.ts`: feature flags, cipher limits, App Check enforcement.
- `docs/deploy-private-pro-firebase.md`: App Check, least privilege, browser-key restrictions, recovery, and rollout.
- `tools/private-pro/security-audit.ts`: deterministic deployment audit without printing secrets.
- `tools/private-pro/security-audit.test.ts`: configuration classification tests.

---

## Stage 1: Security hardening

### Task 1: Patch the production framework and dependency floor

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: existing full repository checks

**Interfaces:**
- Consumes: the existing Next.js 15 Pages Router build and Firebase Admin production bundle workaround.
- Produces: a patched dependency graph compatible with later encrypted-vault work.

- [ ] **Step 1: Capture the failing security baseline**

Run:

```powershell
npm audit --omit=dev --json > $env:TEMP\big-agi-audit-before.json
$audit = Get-Content -Raw $env:TEMP\big-agi-audit-before.json | ConvertFrom-Json
if ($audit.metadata.vulnerabilities.critical -lt 1) { throw 'Expected the current critical advisory baseline.' }
```

Expected: command records at least one critical production advisory, including the current Next.js range.

- [ ] **Step 2: Add a dependency-policy test before changing versions**

Create `tools/private-pro/dependency-security.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import packageJson from '../../package.json' with { type: 'json' };

test('uses the approved patched private Pro dependency floors', () => {
  assert.match(packageJson.dependencies.next, /^~15\.(?:5\.(?:2[3-9]|[3-9]\d)|[6-9]\.)/);
  assert.match(packageJson.dependencies.nanoid, /^(?:\^|~)?(?:5\.1\.1[6-9]|5\.[2-9]|6\.)/);
  assert.match(packageJson.dependencies['puppeteer-core'], /^(?:\^|~)?25\./);
});
```

- [ ] **Step 3: Run the policy test to verify RED**

Run: `npx tsx --test tools/private-pro/dependency-security.test.ts`

Expected: FAIL because Next.js, nanoid, and puppeteer-core are below the approved floors.

- [ ] **Step 4: Update dependencies deliberately**

Run:

```powershell
npm install next@15.5.23 nanoid@^5.1.16 puppeteer-core@^25.7.0
```

Do not upgrade Firebase Admin in this step. Its ESM/runtime issue needs its own production-bundle proof.

- [ ] **Step 5: Verify the dependency policy and application**

Run:

```powershell
npx tsx --test tools/private-pro/dependency-security.test.ts
npm run tscheck
npm run lint
npm test
npm run build
npm audit --omit=dev --json > $env:TEMP\big-agi-audit-after-framework.json
```

Expected: policy, typecheck, lint, tests, and build pass. Audit no longer reports the patched Next.js, nanoid, or puppeteer-core advisories. Classify unrelated remaining advisories before continuing.

- [ ] **Step 6: Commit**

```powershell
git add package.json package-lock.json tools/private-pro/dependency-security.test.ts
git commit -m "Build: patch private Pro dependencies"
```

### Task 2: Isolate generated HTML from the application origin

**Files:**
- Modify: `src/modules/blocks/code/code-renderers/RenderCodeHtmlIFrame.tsx`
- Create: `src/modules/blocks/code/code-renderers/contentExecution.security.test.ts`

**Interfaces:**
- Consumes: `RenderCodeHtmlIFrame({ htmlCode, isFullscreen })`.
- Produces: `htmlSandboxPolicy(): string` and a generated iframe without same-origin access.

- [ ] **Step 1: Write the failing sandbox test**

Create the test:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { htmlSandboxPolicy } from './RenderCodeHtmlIFrame';

test('generated HTML cannot share the application origin', () => {
  const tokens = htmlSandboxPolicy().split(/\s+/).filter(Boolean);
  assert.equal(tokens.includes('allow-same-origin'), false);
  assert.equal(tokens.includes('allow-top-navigation'), false);
  assert.equal(tokens.includes('allow-popups-to-escape-sandbox'), false);
});
```

- [ ] **Step 2: Run to verify RED**

Run: `npx cross-env NODE_ENV=development tsx --test src/modules/blocks/code/code-renderers/contentExecution.security.test.ts`

Expected: FAIL because `htmlSandboxPolicy` does not exist and the current iframe contains `allow-same-origin`.

- [ ] **Step 3: Implement the opaque sandbox**

Export:

```ts
export function htmlSandboxPolicy(): string {
  return 'allow-scripts allow-forms';
}
```

Use `sandbox={htmlSandboxPolicy()}`. Remove same-origin access. Add an iframe-local CSP meta before writing content:

```ts
meta.httpEquiv = 'Content-Security-Policy';
meta.content = "default-src 'none'; img-src data: blob: https:; media-src data: blob: https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src https:; form-action 'none'; base-uri 'none'";
```

Keep navigation and popup capabilities absent.

- [ ] **Step 4: Verify**

Run:

```powershell
npx cross-env NODE_ENV=development tsx --test src/modules/blocks/code/code-renderers/contentExecution.security.test.ts
npx eslint src/modules/blocks/code/code-renderers/RenderCodeHtmlIFrame.tsx src/modules/blocks/code/code-renderers/contentExecution.security.test.ts
npm run tscheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/modules/blocks/code/code-renderers/RenderCodeHtmlIFrame.tsx src/modules/blocks/code/code-renderers/contentExecution.security.test.ts
git commit -m "Security: isolate generated HTML"
```

### Task 3: Sanitize every generated SVG sink

**Files:**
- Create: `src/modules/blocks/code/code-renderers/svgSanitize.ts`
- Create: `src/modules/blocks/code/code-renderers/svgSanitize.test.ts`
- Modify: `src/modules/blocks/code/code-renderers/RenderCodeSVG.tsx`
- Modify: `src/modules/blocks/code/code-renderers/RenderCodeMermaid.tsx`
- Modify: `src/modules/blocks/code/code-renderers/RenderCodePlantUML.tsx`
- Modify: `src/apps/chat/components/live-svg/LiveSvgAnimator.tsx`

**Interfaces:**
- Produces: `sanitizeRenderedSvg(svg: string): string`.
- Guarantees: no scripts, event handlers, foreignObject, external resource URLs, javascript URLs, or active animation/event elements reach `dangerouslySetInnerHTML`.

- [ ] **Step 1: Write malicious fixture tests**

```ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { sanitizeRenderedSvg } from './svgSanitize';

describe('SVG sanitizer', () => {
  test('removes active content and external references', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <script>alert(1)</script>
      <foreignObject><iframe srcdoc="bad"></iframe></foreignObject>
      <image href="javascript:alert(1)" />
      <a href="https://evil.invalid/"><text>open</text></a>
    </svg>`;
    const clean = sanitizeRenderedSvg(dirty);
    assert.doesNotMatch(clean, /script|foreignObject|onload|javascript:|evil\.invalid/i);
    assert.match(clean, /^<svg\b/);
  });

  test('rejects non-SVG roots', () => {
    assert.throws(() => sanitizeRenderedSvg('<html></html>'), /SVG/i);
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run: `npx cross-env NODE_ENV=development tsx --test src/modules/blocks/code/code-renderers/svgSanitize.test.ts`

Expected: FAIL because the sanitizer does not exist.

- [ ] **Step 3: Implement a strict allowlist sanitizer**

Use `DOMParser` in the browser implementation and a pure XML parser path usable by tests. Allow only required SVG structural, shape, gradient, clipping, text, and accessibility elements. Drop:

```text
script, foreignObject, iframe, object, embed, audio, video, animate, animateMotion,
animateTransform, set, discard, use with external href, and all unknown elements
```

Drop attributes beginning with `on`, `href`/`xlink:href` unless they are local fragments, `style` values containing `url(`, and any URL outside an internal `#fragment` or safe data image policy.

- [ ] **Step 4: Apply at every sink**

Sanitize immediately before `dangerouslySetInnerHTML`. Render errors as React text nodes, never by placing error strings into HTML.

- [ ] **Step 5: Verify**

Run:

```powershell
npx cross-env NODE_ENV=development tsx --test src/modules/blocks/code/code-renderers/svgSanitize.test.ts src/modules/blocks/code/code-renderers/contentExecution.security.test.ts
npx eslint src/modules/blocks/code/code-renderers src/apps/chat/components/live-svg/LiveSvgAnimator.tsx
npm run tscheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/modules/blocks/code/code-renderers src/apps/chat/components/live-svg/LiveSvgAnimator.tsx
git commit -m "Security: sanitize generated SVG"
```

### Task 4: Add production security headers and remove wildcard CORS

**Files:**
- Create: `src/common/security/securityHeaders.ts`
- Create: `src/common/security/securityHeaders.test.ts`
- Modify: `next.config.ts`

**Interfaces:**
- Produces: `privateProSecurityHeaders(): Array<{ key: string; value: string }>` and `privateProContentSecurityPolicy(): string`.

- [ ] **Step 1: Write exact header tests**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { privateProSecurityHeaders } from './securityHeaders';

test('private Pro emits the required browser security headers', () => {
  const headers = new Map(privateProSecurityHeaders().map(({ key, value }) => [key.toLowerCase(), value]));
  assert.match(headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.match(headers.get('content-security-policy') ?? '', /object-src 'none'/);
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
  assert.doesNotMatch(headers.get('content-security-policy') ?? '', /unsafe-eval/);
});
```

- [ ] **Step 2: Run to verify RED**

Run: `npx cross-env NODE_ENV=development tsx --test src/common/security/securityHeaders.test.ts`

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement a private Pro policy**

Build a policy permitting only the application, Firebase Auth/Firestore/Storage/App Check, Google OAuth, required AI-provider connections, blob/data media, and dedicated workers. Keep analytics origins absent. Add HSTS, nosniff, no-referrer, permissions policy, DENY framing, and COOP `same-origin-allow-popups` for Google sign-in compatibility.

Apply the headers through `nextConfig.headers()` only when `NEXT_PUBLIC_PRIVATE_PRO_ENABLED === 'true'`.

- [ ] **Step 4: Verify local policy and production build**

Run:

```powershell
npx cross-env NODE_ENV=development tsx --test src/common/security/securityHeaders.test.ts
npm run tscheck
npx eslint next.config.ts src/common/security
npm run build
```

Expected: PASS. Inspect generated routes for header configuration. Do not deploy yet.

- [ ] **Step 5: Commit**

```powershell
git add next.config.ts src/common/security
git commit -m "Security: add private Pro browser policy"
```

### Task 5: Enable and enforce Firebase App Check

**Files:**
- Modify: `src/modules/private-pro/firebase/firebase.client.ts`
- Modify: `src/modules/private-pro/firebase/firebase.appcheck.server.ts`
- Modify: `src/modules/private-pro/config/privatePro.config.ts`
- Modify: `src/modules/private-pro/config/privatePro.config.server.ts`
- Modify: `src/modules/private-pro/config/privatePro.config.test.ts`
- Create: `src/modules/private-pro/firebase/firebase.appcheck.server.test.ts`
- Modify: `docs/deploy-private-pro-firebase.md`

**Interfaces:**
- Produces: mandatory production `privateProGetAppCheckToken()` behavior and server `verifyPrivateProAppCheckToken()` enforcement.

- [ ] **Step 1: Write failing configuration tests**

First extract a pure exported parser from the current environment-backed configuration:

```ts
export interface PrivateProServerConfigInput {
  enabled: boolean;
  nodeEnv: string | undefined;
  allowedEmails: string | undefined;
  firebaseProjectId: string | undefined;
  firebaseClientEmail: string | undefined;
  firebasePrivateKey: string | undefined;
  firebaseStorageBucket: string | undefined;
  appCheckSiteKey: string | undefined;
}

export function parsePrivateProServerConfig(input: PrivateProServerConfigInput): PrivateProServerConfig;
```

Add tests proving:

```ts
assert.throws(
  () => parsePrivateProServerConfig({
    enabled: true,
    nodeEnv: 'production',
    allowedEmails: 'friend@example.com',
    firebaseProjectId: 'project',
    firebaseClientEmail: 'service@example.iam.gserviceaccount.com',
    firebasePrivateKey: 'key',
    firebaseStorageBucket: 'bucket',
    appCheckSiteKey: '',
  }),
  /App Check/i,
);
```

Add a server verifier test where a missing token is rejected in production private Pro.

- [ ] **Step 2: Run to verify RED**

Run:

```powershell
npx cross-env NODE_ENV=development tsx --test src/modules/private-pro/config/privatePro.config.test.ts src/modules/private-pro/firebase/firebase.appcheck.server.test.ts
```

Expected: FAIL because production currently permits disabled App Check.

- [ ] **Step 3: Implement reCAPTCHA Enterprise App Check**

Use `ReCaptchaEnterpriseProvider`, not the v3 provider. Production private Pro configuration is invalid without a site key and enforced server verification. Development/emulator mode may use a documented debug token.

- [ ] **Step 4: Add operational rollout documentation**

Document metrics-only registration, Vercel environment variables, debug tokens for emulator use, enforcement ordering, and rollback that never disables ID-token/epoch checks.

- [ ] **Step 5: Verify**

Run tests, TypeScript, lint, build, and Firebase emulator tests. Expected: missing/invalid App Check tokens fail all private Pro procedures.

- [ ] **Step 6: Commit**

```powershell
git add src/modules/private-pro/firebase src/modules/private-pro/config docs/deploy-private-pro-firebase.md
git commit -m "Security: enforce private Pro App Check"
```

### Task 6: Create a deterministic live security audit tool

**Files:**
- Create: `tools/private-pro/security-audit.ts`
- Create: `tools/private-pro/security-audit.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces CLI: `npm run private-pro:security-audit`.
- Output contains booleans/counts only, never secret values.

- [ ] **Step 1: Write classification tests**

Test pure functions that classify headers, authorized domains, API-key restrictions, App Check state, IAM roles, key age, dependency counts, and Firebase rule probes. Include tests that a wildcard CORS header, missing CSP, disabled App Check, broad Admin SDK role, and unrestricted browser API key are release blockers.

- [ ] **Step 2: Run to verify RED**

Expected: FAIL because the audit module does not exist.

- [ ] **Step 3: Implement read-only collectors and redacted output**

Use HTTPS/gcloud/vercel CLI reads. Never print env values, tokens, service-account private key IDs, OAuth secrets, or API keys. Emit a JSON report with `pass`, `warn`, and `block` findings.

- [ ] **Step 4: Verify against fixtures and live environment**

Run:

```powershell
npx tsx --test tools/private-pro/security-audit.test.ts
npm run private-pro:security-audit
```

Expected before remediation: the live report still blocks on App Check, browser-key restrictions, stale domains/origins, broad service identity, or any unpatched advisories. This task does not mutate cloud state.

- [ ] **Step 5: Commit**

```powershell
git add tools/private-pro/security-audit.ts tools/private-pro/security-audit.test.ts package.json
git commit -m "Security: audit private Pro deployment"
```

---

## Stage 2: Vault cryptography and encrypted local storage

### Task 7: Define encrypted vault wire types and schemas

**Files:**
- Create: `src/modules/private-pro/vault/privatePro.vault.types.ts`
- Create: `src/modules/private-pro/vault/privatePro.vault.schemas.ts`
- Create: `src/modules/private-pro/vault/privatePro.vault.schemas.test.ts`

**Interfaces:**
- Produces:

```ts
export type PrivateProVaultRecordType =
  | 'credential-service' | 'model-service' | 'settings' | 'chat'
  | 'persona' | 'folder' | 'scratch' | 'asset-manifest';

export interface PrivateProVaultEnvelope {
  formatVersion: 1;
  recordType: PrivateProVaultRecordType;
  recordId: string;
  schemaVersion: number;
  keyVersion: number;
  revision: number;
  nonceBase64: string;
  ciphertextBase64: string;
  ciphertextBytes: number;
}
```

- [ ] **Step 1: Write failing schema tests**

Test accepted valid envelopes and rejection of unknown record types, zero/negative revisions, malformed base64, oversized ciphertext, and unexpected fields.

- [ ] **Step 2: Run to verify RED**

Run: `npx cross-env NODE_ENV=development tsx --test src/modules/private-pro/vault/privatePro.vault.schemas.test.ts`

- [ ] **Step 3: Implement strict Zod schemas**

Use `.strict()` objects and explicit maximum ciphertext sizes. Define keyset, password envelope, recovery envelope, device metadata, record index, tombstone, and operation schemas.

- [ ] **Step 4: Verify and commit**

Run test, lint, and tscheck, then commit:

```powershell
git add src/modules/private-pro/vault/privatePro.vault.types.ts src/modules/private-pro/vault/privatePro.vault.schemas.ts src/modules/private-pro/vault/privatePro.vault.schemas.test.ts
git commit -m "Cloud: define encrypted vault protocol"
```

### Task 8: Implement browser cryptography primitives

**Files:**
- Create: `src/modules/private-pro/vault/privatePro.vault.crypto.ts`
- Create: `src/modules/private-pro/vault/privatePro.vault.crypto.test.ts`

**Interfaces:**
- Produces:

```ts
export function generateVaultMasterKeyBytes(): Uint8Array;
export function importVaultMasterKey(bytes: Uint8Array, extractable?: boolean): Promise<CryptoKey>;
export function vaultRecordAAD(input: VaultRecordAADInput): Uint8Array;
export function encryptVaultRecord(key: CryptoKey, aad: VaultRecordAADInput, plaintext: Uint8Array): Promise<PrivateProVaultEnvelope>;
export function decryptVaultRecord(key: CryptoKey, envelope: PrivateProVaultEnvelope): Promise<Uint8Array>;
export function deriveVaultSubkey(masterKey: CryptoKey, purpose: string, id: string, usages: KeyUsage[]): Promise<CryptoKey>;
export function hmacVaultIdentifier(key: CryptoKey, namespace: string, value: string): Promise<string>;
```

- [ ] **Step 1: Write failing round-trip and tamper tests**

Cover plaintext round trip and failures when changing UID context, record type, ID, schema, revision, nonce, or ciphertext. Generate 10,000 encryptions and assert nonce uniqueness.

- [ ] **Step 2: Run to verify RED**

- [ ] **Step 3: Implement AES-GCM, HKDF-SHA-256, and HMAC-SHA-256**

Use Web Crypto only. Do not add a JavaScript crypto implementation for these primitives.

- [ ] **Step 4: Verify and commit**

```powershell
npx cross-env NODE_ENV=development tsx --test src/modules/private-pro/vault/privatePro.vault.crypto.test.ts
npx eslint src/modules/private-pro/vault/privatePro.vault.crypto.ts src/modules/private-pro/vault/privatePro.vault.crypto.test.ts
npm run tscheck
git add src/modules/private-pro/vault/privatePro.vault.crypto.ts src/modules/private-pro/vault/privatePro.vault.crypto.test.ts
git commit -m "Cloud: encrypt private vault records"
```

### Task 9: Implement password derivation and recovery keys

**Files:**
- Create: `src/modules/private-pro/vault/privatePro.vault.password.worker.ts`
- Create: `src/modules/private-pro/vault/privatePro.vault.password.ts`
- Create: `src/modules/private-pro/vault/privatePro.vault.recovery.ts`
- Create: `src/modules/private-pro/vault/privatePro.vault.password.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces:

```ts
export interface VaultPasswordKdfParams { algorithm: 'argon2id'; memoryKiB: number; iterations: number; parallelism: number; saltBase64: string; }
export async function derivePasswordWrappingKey(password: string, params: VaultPasswordKdfParams): Promise<CryptoKey>;
export function generateRecoveryKey(): { display: string; bytes: Uint8Array };
export function parseRecoveryKey(display: string): Uint8Array;
```

- [ ] **Step 1: Select and pin the Argon2id package**

Evaluate maintained browser-compatible packages by license, WASM integrity, CSP compatibility, bundle size, worker support, and current advisories. Record the chosen package and exact version in the spec's implementation notes. Do not use a CDN-loaded WASM binary.

- [ ] **Step 2: Write failing KDF and recovery tests**

Use a fixed password/salt known-answer fixture, wrong-password unwrap failure, recovery-key round trip, checksum failure, whitespace normalization, and minimum parameter enforcement.

- [ ] **Step 3: Run to verify RED**

- [ ] **Step 4: Implement worker isolation and compatibility fallback**

Run Argon2id only in the worker. Keep PBKDF2-SHA-256 fallback versioned and unavailable for new vault creation unless the worker reports a supported incompatibility.

- [ ] **Step 5: Verify and commit**

Run focused tests, CSP worker build, lint, tscheck, and production build. Commit:

```powershell
git add package.json package-lock.json src/modules/private-pro/vault/privatePro.vault.password* src/modules/private-pro/vault/privatePro.vault.recovery.ts
git commit -m "Cloud: derive private vault keys"
```

### Task 10: Persist a remembered non-exportable device key

**Files:**
- Create: `src/modules/private-pro/vault/privatePro.vault.db.ts`
- Create: `src/modules/private-pro/vault/privatePro.vault.db.test.ts`
- Create: `src/modules/private-pro/vault/privatePro.vault.session.ts`

**Interfaces:**
- Produces:

```ts
export class PrivateProVaultDB {
  storeDeviceKey(uid: string, key: CryptoKey): Promise<void>;
  getDeviceKey(uid: string): Promise<CryptoKey | null>;
  deleteDeviceUnlock(uid: string): Promise<void>;
  putEncryptedRecord(uid: string, envelope: PrivateProVaultEnvelope): Promise<void>;
  listEncryptedRecords(uid: string): Promise<PrivateProVaultEnvelope[]>;
}
```

- [ ] **Step 1: Write IndexedDB tests**

Use `fake-indexeddb`. Generate a non-exportable AES key, store and retrieve it, assert `extractable === false`, assert `exportKey` rejects, and prove it can unwrap a test master key. Test logout deletion.

- [ ] **Step 2: Run to verify RED**

- [ ] **Step 3: Implement focused Dexie tables**

Tables: `deviceKeys`, `wrappedKeys`, `records`, `outbox`, `revisions`, `migration`, and `quarantine`. Never store decrypted values.

- [ ] **Step 4: Implement session lifecycle**

Keep the unwrapped master `CryptoKey` only in module memory/React context. Provide explicit `lock()` and `logoutAndClear()` paths.

- [ ] **Step 5: Verify and commit**

```powershell
npx cross-env NODE_ENV=development tsx --test src/modules/private-pro/vault/privatePro.vault.db.test.ts
npx eslint src/modules/private-pro/vault/privatePro.vault.db.ts src/modules/private-pro/vault/privatePro.vault.session.ts
npm run tscheck
git add src/modules/private-pro/vault/privatePro.vault.db.ts src/modules/private-pro/vault/privatePro.vault.db.test.ts src/modules/private-pro/vault/privatePro.vault.session.ts
git commit -m "Cloud: remember encrypted vault devices"
```

---

## Stage 3: Portable state and encrypted synchronization

### Task 11: Build the portable record serializer registry

**Files:**
- Create: `src/modules/private-pro/vault/privatePro.vault.recordIds.ts`
- Create: `src/modules/private-pro/vault/privatePro.vault.serializers.ts`
- Create: `src/modules/private-pro/vault/privatePro.vault.serializers.test.ts`
- Create: `src/modules/private-pro/vault/serializers/models.ts`
- Create: `src/modules/private-pro/vault/serializers/settings.ts`
- Create: `src/modules/private-pro/vault/serializers/chat.ts`
- Create: `src/modules/private-pro/vault/serializers/persona.ts`
- Create: `src/modules/private-pro/vault/serializers/folder.ts`
- Create: `src/modules/private-pro/vault/serializers/scratch.ts`

**Interfaces:**
- Produces:

```ts
export interface PrivateProVaultSerializer<T> {
  recordType: PrivateProVaultRecordType;
  schemaVersion: number;
  snapshot(): Promise<Array<{ recordId: string; value: T }>>;
  apply(recordId: string, value: T): Promise<void>;
  remove(recordId: string): Promise<void>;
  subscribe(listener: (mutation: PrivateProPortableMutation) => void): () => void;
}
export const privateProVaultSerializers: readonly PrivateProVaultSerializer<unknown>[];
```

- [ ] **Step 1: Write the inclusion/exclusion matrix first**

Create fixtures containing sentinel API keys, provider endpoints, custom model parameters, theme, Google key, speech key, share deletion key, chat, persona, folder, Scratch Clip, Firebase token, device ID, logger data, metric data, file handle stub, abort controller, incognito chat, and incomplete message.

Assert included values round-trip and excluded values never appear in serialized JSON.

- [ ] **Step 2: Run to verify RED**

- [ ] **Step 3: Implement explicit serializers by store**

Use current store versions and existing migration logic. Group settings into narrow conflict domains. Give every group an explicit constant ID and Zod schema.

- [ ] **Step 4: Add narrow adapters to existing stores**

Expose snapshot/apply/subscribe functions. Do not expose raw Zustand state or persistence internals.

- [ ] **Step 5: Verify and commit**

Run focused tests, existing store tests, lint, and tscheck. Commit all serializer/adapters together:

```powershell
git add src/modules/private-pro/vault/serializers src/modules/private-pro/vault/privatePro.vault.recordIds.ts src/modules/private-pro/vault/privatePro.vault.serializers.ts src/modules/private-pro/vault/privatePro.vault.serializers.test.ts src/apps src/common/stores src/modules
git commit -m "Cloud: serialize portable private vault state"
```

### Task 12: Add encrypted export and import

**Files:**
- Modify: `src/modules/trade/BackupRestore.tsx`
- Create: `src/modules/trade/privateProEncryptedBackup.ts`
- Create: `src/modules/trade/privateProEncryptedBackup.test.ts`

**Interfaces:**
- Produces encrypted backup schema `vnd.agi.private-pro-encrypted-backup` containing keyset metadata plus ciphertext records/assets only.

- [ ] **Step 1: Write failing export tests**

Assert a sentinel API key is absent from exported bytes, the encrypted export decrypts with the correct password/recovery key, wrong credentials fail, and the legacy plaintext export UI displays an explicit API-key warning.

- [ ] **Step 2: Run to verify RED**

- [ ] **Step 3: Implement streaming encrypted export/import**

Use existing file-save paths but stream ciphertext records. Never stringify the decrypted complete vault as one object. Validate before applying and require a blocking reload after import.

- [ ] **Step 4: Verify and commit**

```powershell
npx cross-env NODE_ENV=development tsx --test src/modules/trade/privateProEncryptedBackup.test.ts
npx eslint src/modules/trade/BackupRestore.tsx src/modules/trade/privateProEncryptedBackup.ts
npm run tscheck
git add src/modules/trade
git commit -m "Cloud: export encrypted private vaults"
```

### Task 13: Implement the encrypted vault server repository and service

**Files:**
- Create: `src/modules/private-pro/vault/privatePro.vault.repository.ts`
- Create: `src/modules/private-pro/vault/privatePro.vault.repository.firebase.ts`
- Create: `src/modules/private-pro/vault/privatePro.vault.service.ts`
- Create: `src/modules/private-pro/vault/privatePro.vault.service.test.ts`

**Interfaces:**
- Produces compare-and-swap keyset/record/index operations.

```ts
export interface PutVaultRecordInput {
  operationId: string;
  opaqueRecordId: string;
  baseRevision: number;
  envelope: PrivateProVaultEnvelope;
}
export type PutVaultRecordResult =
  | { status: 'committed'; revision: number; serverUpdatedAtMs: number }
  | { status: 'unchanged'; revision: number; serverUpdatedAtMs: number }
  | { status: 'conflict'; currentRevision: number };
```

- [ ] **Step 1: Write in-memory service tests**

Cover first write, idempotent repeat, conflicting operation ID, stale base revision, independent record revisions, tombstone, paged index, keyset CAS, migration phase CAS, size bounds, and UID scoping.

- [ ] **Step 2: Run to verify RED**

- [ ] **Step 3: Implement service without inspecting ciphertext**

The service validates envelope shape and authenticated metadata consistency available outside ciphertext but cannot decrypt. Assign revision and `serverUpdatedAtMs` transactionally.

- [ ] **Step 4: Implement Firebase repository**

Use only `users/{uid}/vault/**`. Store records under opaque IDs. Add bounded paging and no collection-group queries that cross user scope except administrative cleanup with explicit safeguards.

- [ ] **Step 5: Verify and commit**

```powershell
npx cross-env NODE_ENV=development tsx --test src/modules/private-pro/vault/privatePro.vault.service.test.ts
npx eslint src/modules/private-pro/vault/privatePro.vault.repository.ts src/modules/private-pro/vault/privatePro.vault.repository.firebase.ts src/modules/private-pro/vault/privatePro.vault.service.ts
npm run tscheck
git add src/modules/private-pro/vault/privatePro.vault.repository* src/modules/private-pro/vault/privatePro.vault.service*
git commit -m "Cloud: store encrypted private vault records"
```

### Task 14: Expose protected encrypted vault procedures

**Files:**
- Create: `src/modules/private-pro/vault/privatePro.vault.router.ts`
- Create: `src/modules/private-pro/vault/privatePro.vault.router.test.ts`
- Modify: `src/server/trpc/trpc.router-cloud.ts`

**Interfaces:**
- Produces tRPC procedures: `bootstrap`, `getIndex`, `getRecords`, `putRecord`, `deleteRecord`, `putKeyset`, `commitMigration`, and `revokeDevice`.

- [ ] **Step 1: Write router authorization and size tests**

Use caller contexts for unauthenticated, missing App Check, wrong UID, stale epoch, inactive account, and current entitled account. Assert the first five fail and the current account succeeds.

- [ ] **Step 2: Run to verify RED**

- [ ] **Step 3: Implement strict inputs and mount router**

All procedures use `privateProNodePremiumProcedure`. Never accept UID from input. Bound page size, record count, ciphertext bytes, and operation IDs.

- [ ] **Step 4: Verify and commit**

```powershell
npx cross-env NODE_ENV=development tsx --test src/modules/private-pro/vault/privatePro.vault.router.test.ts
npx eslint src/modules/private-pro/vault/privatePro.vault.router.ts src/server/trpc/trpc.router-cloud.ts
npm run tscheck
git add src/modules/private-pro/vault/privatePro.vault.router* src/server/trpc/trpc.router-cloud.ts
git commit -m "Cloud: expose encrypted vault API"
```

### Task 15: Build the blocking multi-device vault engine

**Files:**
- Create: `src/modules/private-pro/vault/privatePro.vault.transport.ts`
- Create: `src/modules/private-pro/vault/privatePro.vault.engine.ts`
- Create: `src/modules/private-pro/vault/privatePro.vault.engine.test.ts`
- Create: `src/modules/private-pro/vault/store-private-pro-vault.ts`

**Interfaces:**
- Produces:

```ts
export interface PrivateProVaultEngine {
  hydrateBeforeOpen(): Promise<void>;
  start(): Promise<void>;
  stop(): void;
  whenCurrent(): Promise<void>;
  logoutAndClear(): Promise<void>;
}
```

- [ ] **Step 1: Write the PC A/PC B acceptance simulation**

Test sequence:

1. PC A writes `credential-service/openai` with a sentinel key.
2. PC B has an older cache and calls `hydrateBeforeOpen()`.
3. Assert PC B cannot report `ready` until it downloads/decrypts/applies the credential.
4. PC B changes `settings/theme`.
5. Assert the credential record revision/value is unchanged and the theme record advances.

Also test offline startup blocks, device clocks do not affect order, stale base conflicts refetch, exact mutation replay, and remote index rollback blocks.

- [ ] **Step 2: Run to verify RED**

- [ ] **Step 3: Implement download-before-edit hydration**

Stage decrypted records separately, validate the complete stage, then apply by serializer dependency order. Do not partially open the app.

- [ ] **Step 4: Implement online mutation flow**

Record local portable mutations as encrypted outbox entries. Before accepting edits after a reconnect, fetch the current index. Independent record writes proceed separately.

- [ ] **Step 5: Implement same-record conflict policy**

Mutation adapters replay exact semantic changes where supported. Chats create conflict copies. Otherwise block and request a user choice without displaying secret values.

- [ ] **Step 6: Verify and commit**

```powershell
npx cross-env NODE_ENV=development tsx --test src/modules/private-pro/vault/privatePro.vault.engine.test.ts
npx eslint src/modules/private-pro/vault/privatePro.vault.transport.ts src/modules/private-pro/vault/privatePro.vault.engine.ts src/modules/private-pro/vault/store-private-pro-vault.ts
npm run tscheck
git add src/modules/private-pro/vault/privatePro.vault.transport.ts src/modules/private-pro/vault/privatePro.vault.engine* src/modules/private-pro/vault/store-private-pro-vault.ts
git commit -m "Cloud: synchronize encrypted private vaults"
```

### Task 16: Integrate setup, unlock, startup blocking, and logout

**Files:**
- Create: `src/modules/private-pro/vault/ProviderPrivateProVault.tsx`
- Create: `src/modules/private-pro/ui/PrivateProVaultSetup.tsx`
- Create: `src/modules/private-pro/ui/PrivateProVaultUnlock.tsx`
- Create: `src/modules/private-pro/ui/PrivateProVaultStatus.tsx`
- Modify: `src/modules/private-pro/ui/PrivateProAccountControl.tsx`
- Modify: `src/modules/private-pro/auth/ProviderPrivatePro.tsx`
- Modify: `pages/_app.tsx`
- Create: `src/modules/private-pro/vault/ProviderPrivateProVault.test.ts`

**Interfaces:**
- Produces React context with locked/setup/hydrating/ready/reconnecting/migrating/error states and password/recovery/logout actions.

- [ ] **Step 1: Write provider state-machine tests**

Test new user setup, remembered-device auto-unlock, new-device password unlock, recovery unlock, wrong password, offline startup block, newer remote revision block, ready state only after apply, reconnect block, and logout key destruction.

- [ ] **Step 2: Run to verify RED**

- [ ] **Step 3: Implement the provider before application UI**

Provider order:

```tsx
<ProviderPrivatePro>
  <ProviderPrivateProVault>
    <ProviderTRPC>
      <Application />
    </ProviderTRPC>
  </ProviderPrivateProVault>
</ProviderPrivatePro>
```

Preserve any required tRPC dependency by splitting an auth-only client from the application client rather than opening the application before hydration.

- [ ] **Step 4: Implement password/recovery UX**

Require password confirmation, local strength check, recovery-key display and group confirmation, and terse failure states. Never render the recovery key after setup unless rotating to a newly generated key.

- [ ] **Step 5: Implement account actions**

Change password, create encrypted export, revoke other devices, explicit logout, and full local wipe.

- [ ] **Step 6: Verify and commit**

Run provider tests, accessibility-oriented component tests, lint, tscheck, and build. Commit:

```powershell
git add pages/_app.tsx src/modules/private-pro/auth/ProviderPrivatePro.tsx src/modules/private-pro/ui src/modules/private-pro/vault/ProviderPrivateProVault*
git commit -m "Cloud: gate private Pro on encrypted vault"
```

### Task 17: Encrypt attachment chunks and metadata

**Files:**
- Create: `src/modules/private-pro/vault/privatePro.vault.assets.crypto.ts`
- Create: `src/modules/private-pro/vault/privatePro.vault.assets.crypto.test.ts`
- Create: `src/modules/private-pro/vault/privatePro.vault.assets.client.ts`
- Create: `src/modules/private-pro/vault/privatePro.vault.assets.service.ts`
- Create: `src/modules/private-pro/vault/privatePro.vault.assets.service.test.ts`
- Create: `src/modules/private-pro/vault/privatePro.vault.assets.firebase.ts`

**Interfaces:**
- Produces chunk encryption and opaque upload service. Quota counts ciphertext bytes.

- [ ] **Step 1: Write chunk cryptography tests**

Cover multi-chunk round trip, reordered/missing/corrupt chunk rejection, authenticated metadata changes, unique nonces, and no plaintext filename/content type outside the encrypted manifest.

- [ ] **Step 2: Run to verify RED**

- [ ] **Step 3: Implement client chunk encryption in a worker**

Use a bounded chunk size and stream where browser APIs permit. Keep only one or a few plaintext chunks in memory.

- [ ] **Step 4: Implement opaque server reservation/finalization**

Validate ciphertext size/hash metadata and object path, not plaintext content metadata. Retain per-UID rate and quota limits.

- [ ] **Step 5: Verify and commit**

Run focused tests and existing attachment tests, then commit:

```powershell
git add src/modules/private-pro/vault/privatePro.vault.assets*
git commit -m "Cloud: encrypt private vault attachments"
```

---

## Stage 4: Migration, Firebase enforcement, and rollout

### Task 18: Implement resumable plaintext-to-encrypted migration

**Files:**
- Create: `src/modules/private-pro/vault/privatePro.vault.migration.ts`
- Create: `src/modules/private-pro/vault/privatePro.vault.migration.test.ts`
- Modify: `src/modules/private-pro/vault/ProviderPrivateProVault.tsx`
- Modify: legacy sync modules under `src/modules/private-pro/sync/**`

**Interfaces:**
- Produces migration phases: `inventory`, `encrypt-local`, `upload`, `verify-cloud`, `commit`, `cleanup-local`, `cleanup-cloud`, `complete`.

- [ ] **Step 1: Write interruption tests for every phase**

For each phase, simulate process interruption and restart. Assert no plaintext source is deleted before `verify-cloud`, repeat operations are idempotent, and completion reconstructs equivalent portable state.

- [ ] **Step 2: Run to verify RED**

- [ ] **Step 3: Implement encrypted local migration journal**

Journal contains opaque IDs, phases, revisions, and encrypted error context only.

- [ ] **Step 4: Implement cloud conversion and verification**

Download authorized legacy chats/personas/assets, validate, encrypt, upload, download ciphertext, decrypt, and compare the serialized portable state.

- [ ] **Step 5: Implement cleanup gates**

Require an encrypted export confirmation and committed server migration state before deleting included plaintext local keys or invoking legacy cloud cleanup.

- [ ] **Step 6: Verify and commit**

```powershell
npx cross-env NODE_ENV=development tsx --test src/modules/private-pro/vault/privatePro.vault.migration.test.ts
npx eslint src/modules/private-pro/vault/privatePro.vault.migration.ts src/modules/private-pro/vault/ProviderPrivateProVault.tsx
npm run tscheck
git add src/modules/private-pro/vault/privatePro.vault.migration* src/modules/private-pro/vault/ProviderPrivateProVault.tsx src/modules/private-pro/sync
git commit -m "Cloud: migrate private data into encrypted vaults"
```

### Task 19: Secure Firebase rules for encrypted vault paths

**Files:**
- Modify: `firestore.rules`
- Modify: `storage.rules`
- Modify: `firestore.indexes.json`
- Modify: `test/firebase/private-pro.rules.test.ts`

**Interfaces:**
- Produces deny-by-default encrypted-vault rules. Browser writes remain denied. New encrypted Storage direct reads are denied.

- [ ] **Step 1: Add failing emulator tests**

Test own-account permitted metadata reads only where still required, cross-account denial, stale epoch denial, missing claim denial, every direct write denial, and every encrypted Storage direct read/write denial.

- [ ] **Step 2: Run to verify RED**

Run: `npm run test:firebase:exec`

- [ ] **Step 3: Implement encrypted path rules and indexes**

Allow only the minimum client reads needed for Auth/bootstrapping. Prefer Vercel procedures for encrypted records/assets. Keep catch-all deny.

- [ ] **Step 4: Verify and commit**

```powershell
npm run test:firebase:exec
npx eslint test/firebase
git add firestore.rules storage.rules firestore.indexes.json test/firebase/private-pro.rules.test.ts
git commit -m "Security: lock encrypted Firebase vaults"
```

### Task 20: Replace the broad Firebase runtime identity

**Files:**
- Modify: `src/modules/private-pro/firebase/firebase.admin.ts`
- Modify: `src/modules/private-pro/config/privatePro.config.server.ts`
- Modify: `docs/deploy-private-pro-firebase.md`
- Modify: `tools/private-pro/security-audit.ts`
- Create: `infra/private-pro/gcp-runtime-role.yaml` or an exact documented `gcloud` command file

**Interfaces:**
- Produces Application Default Credentials support and a least-privilege permission manifest.

- [ ] **Step 1: Add credential-source and permission tests**

Test that production accepts ADC/WIF without a private key, static-key mode is explicitly classified as fallback, and the permission manifest excludes project update, bucket creation/deletion, ruleset mutation, and unrelated Firebase product administration.

- [ ] **Step 2: Run to verify RED**

- [ ] **Step 3: Define least-privilege permissions from actual calls**

Include only required Auth user/claim/session operations, Firestore entity operations, Storage object operations, signed-URL signing, and App Check verification. Validate each permission with a live staging identity.

- [ ] **Step 4: Implement ADC/WIF-friendly initialization**

Use `applicationDefault()` when explicit static credentials are absent. Keep Firebase public config separate.

- [ ] **Step 5: Provision and verify outside production first**

Prefer Vercel OIDC plus Google Workload Identity Federation if runtime OIDC tokens are supported by the deployed environment. Otherwise provision a dedicated least-privilege service account and rotate the static key. Do not delete the working credential until protected live probes pass with the replacement.

- [ ] **Step 6: Verify and commit**

Run unit tests, build, staging protected endpoint probes, and the audit tool. Commit code/docs/manifest. Cloud IAM mutation and old-key deletion require explicit user approval at execution time.

### Task 21: Restrict Firebase browser access and production origins

**Files:**
- Modify: `docs/deploy-private-pro-firebase.md`
- Modify: `tools/private-pro/security-audit.ts`
- No application code unless Firebase SDK compatibility requires it.

**Interfaces:**
- Produces exact allowed origins/domains and required API allowlist.

- [ ] **Step 1: Add audit fixtures for exact restrictions**

Production allowed origins:

```text
https://chatgpt.ashesh.dev
https://big-agi-243b6.firebaseapp.com
```

Retain a current Vercel production alias only if OAuth or operational rollback requires it. Remove stale deployment aliases and localhost from production after verification.

- [ ] **Step 2: Verify fixture RED against current live configuration**

Expected: current browser API key has an empty browser restriction and current authorized domains/CORS include stale entries.

- [ ] **Step 3: Apply cloud restrictions with a rollback list**

Restrict browser referrers and API targets to the Firebase APIs actually used. Update OAuth/Firebase authorized domains and bucket CORS. Keep a saved redacted before/after report.

- [ ] **Step 4: Verify live sign-in, App Check, Firestore bootstrap, and encrypted uploads**

Use a clean browser profile and the production custom domain. If any check fails, restore only the necessary exact origin/API, not broad wildcards.

- [ ] **Step 5: Commit documentation/audit updates**

Cloud mutations require explicit user approval at execution time.

### Task 22: Add database recovery controls and encrypted cleanup jobs

**Files:**
- Create: `pages/api/private-pro/cleanup-legacy-vault.ts`
- Create: `src/modules/private-pro/vault/privatePro.vault.cleanup.ts`
- Create: `src/modules/private-pro/vault/privatePro.vault.cleanup.test.ts`
- Modify: `vercel.json`
- Modify: `docs/deploy-private-pro-firebase.md`

**Interfaces:**
- Produces idempotent cleanup of only verified migrated plaintext records/assets and documented Firestore recovery configuration.

- [ ] **Step 1: Write cleanup safety tests**

Assert the job skips accounts without committed migration, skips unverified records, deletes only known legacy paths, is idempotent, and requires the cron secret.

- [ ] **Step 2: Run to verify RED**

- [ ] **Step 3: Implement bounded cleanup**

Process a limited number of accounts/records per run. Record counts only. Never log IDs, titles, ciphertext, or errors containing payloads.

- [ ] **Step 4: Enable Firestore deletion protection and decide PITR**

Deletion protection is required. PITR or scheduled encrypted exports require an explicit cost decision at execution time.

- [ ] **Step 5: Verify and commit**

Run tests and a dry-run cleanup against staging fixtures, then commit.

### Task 23: Full verification and two-device acceptance

**Files:**
- Modify documentation only if verification reveals missing operational steps.

**Interfaces:**
- Produces release evidence, not new functionality.

- [ ] **Step 1: Run focused vault tests**

```powershell
npx cross-env NODE_ENV=development tsx --test "src/modules/private-pro/vault/**/*.test.ts" "src/modules/trade/privateProEncryptedBackup.test.ts" "src/common/security/*.test.ts" "src/modules/blocks/code/code-renderers/*.test.ts"
```

Expected: zero failures.

- [ ] **Step 2: Run Firebase emulator tests**

Run: `npm run test:firebase:exec`

Expected: zero failures.

- [ ] **Step 3: Run repository checks**

```powershell
npm run tscheck
npm run lint
npm test
npm run build
npm audit --omit=dev
git diff --check
```

Expected: typecheck, lint, build, and diff pass. Repository tests have no private-vault regression; any unrelated live-vendor failure is captured separately. Audit has no reachable critical/high blocker.

- [ ] **Step 4: Run security audit**

Run: `npm run private-pro:security-audit`

Expected: no blocking finding. Warnings must have written reachability/compensating-control notes.

- [ ] **Step 5: Rehearse migration on a copied test vault**

Use sentinel credentials and non-sensitive copied data. Interrupt every phase, recover, validate encrypted reconstruction, and verify plaintext cleanup is gated.

- [ ] **Step 6: Perform clean PC A/PC B acceptance**

1. PC A unlocks and adds a sentinel provider key.
2. PC B signs in with an empty local profile and cannot open before vault unlock/hydration.
3. PC B unlocks and sees the provider configuration before settings become editable.
4. PC B changes theme.
5. PC A receives the theme revision without losing the provider key.
6. Logout PC B and confirm reload requires password/recovery.
7. Recover in a third clean profile using the recovery key, rotate password, and verify full reconstruction.

- [ ] **Step 7: Commit verification documentation**

```powershell
git add docs
git commit -m "Docs: verify encrypted private vault"
```

### Task 24: Production rollout

**Files:**
- No new code expected.

**Interfaces:**
- Produces a migrated encrypted production vault with plaintext cleanup completed only after verification.

- [ ] **Step 1: Obtain explicit approval for cloud mutations, push, and deployment**

List exact Git commits, Firebase rule/index changes, App Check enforcement, IAM changes, API-key/origin restrictions, deletion protection, scheduled jobs, and deployment target.

- [ ] **Step 2: Deploy security hardening with encrypted vault feature disabled**

Verify sign-in, existing sync, headers, App Check monitoring, dependency/runtime health, and no analytics.

- [ ] **Step 3: Enable encrypted vault for a staging/test account**

Complete setup, export, migration, clean-device hydration, logout, and recovery.

- [ ] **Step 4: Enable production vault setup for the user**

Require password, recovery-key confirmation, and encrypted export before migration continues.

- [ ] **Step 5: Migrate and verify production data**

Do not delete plaintext. First verify the encrypted cloud index reconstructs the same portable state on a clean second profile.

- [ ] **Step 6: Commit migration and clean plaintext**

Remove legacy local/cloud plaintext only after the verification gate reports success.

- [ ] **Step 7: Enable encrypted credential and settings mutation sync**

Repeat the real PC A API-key, PC B theme acceptance test.

- [ ] **Step 8: Final live audit**

Verify deployment revision, clean Git state, protected endpoints, App Check enforcement, Firebase rules, headers, dependency audit, IAM/key state, encrypted Storage objects, password logout behavior, and recovery.

---

## Self-review checklist

- Every spec data family maps to Task 11 or Task 17.
- Password, recovery, remembered devices, password change, and logout map to Tasks 8-10 and 16.
- Download-before-edit and PC A/PC B behavior map to Task 15 and Task 23.
- Plaintext local/cloud migration and cleanup map to Tasks 18 and 22.
- XSS, CSP, headers, dependencies, App Check, Firebase restrictions, and least privilege map to Tasks 1-6 and 19-21.
- Recovery and destructive cleanup gates are tested before production rollout.
- No step instructs the executor to store the raw password or serialize localStorage wholesale.
