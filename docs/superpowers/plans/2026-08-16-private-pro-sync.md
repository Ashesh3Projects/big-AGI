# Private Pro Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an allowlist-only Firebase-backed private Pro variant with Google sign-in, automatic local migration, multi-device chat/persona synchronization, and 1 GiB per-user attachment storage.

**Architecture:** Vercel hosts Big-AGI and all trusted mutations. Firebase Authentication supplies identity, Firestore supplies read-only realtime client listeners plus server-owned records, and Cloud Storage holds attachment bytes uploaded through short-lived signed URLs. A dedicated local IndexedDB outbox preserves local-first behavior, while explicit serializers prevent model settings, API keys, notes, incognito chats, and incomplete generations from entering cloud payloads.

**Tech Stack:** Next.js 15, React 18, TypeScript 6, tRPC 11, Zustand 5, Dexie 4, Firebase Web SDK 12.17.1, Firebase Admin 14.2.0, JOSE 6.2.9, Firebase Emulator Suite 15.27.0, Node test runner through `tsx`.

**Spec:** `docs/superpowers/specs/2026-08-16-private-pro-sync-design.md`

## Global Constraints

- Work only on branch `pro`.
- Never push any branch. The user manages all remote Git writes.
- Never start or stop a development server.
- Use normal hyphens, never em dashes, in prose, code comments, and UI copy.
- Keep Firebase Admin imports out of Edge and browser bundles.
- Keep existing Edge AI routes and provider behavior unchanged.
- Approved accounts are configured only through `PRIVATE_PRO_ALLOWED_EMAILS` and receive `privatePro: true` automatically.
- Every account has an isolated vault. No sharing exists between approved accounts.
- Bind each browser profile to its first synchronized UID. Require explicit export/reset before rebinding.
- Synchronize only non-incognito persisted chats, user personas, and referenced binary assets.
- Never synchronize model configuration, API keys, general settings, notes, rambles, Scratch Clip history, transient fields, or incomplete AI generations.
- Preserve local-first behavior. Firebase and Vercel outages must not block local chat use.
- Route every cloud mutation through Vercel. Browser Firestore access is read-only.
- Enforce 1 GiB of finalized plus reserved attachment bytes per UID.
- Use explicit Zod schemas and serialization allowlists. Never serialize Zustand state or `localStorage` wholesale.
- Use sync revisions and hashes as conflict clocks. Do not use `DConversation.updated` as a revision.
- Run `npm run tscheck`, `npm run lint`, `npm test`, Firebase emulator tests, and `npm run build` before completion.

---

## File structure

### Configuration and Firebase boundaries

- `src/modules/private-pro/config/privatePro.config.ts`: client-safe feature flags and limits.
- `src/modules/private-pro/config/privatePro.config.server.ts`: server allowlist and Firebase Admin configuration.
- `src/modules/private-pro/config/privatePro.config.test.ts`: normalization and validation tests.
- `src/modules/private-pro/firebase/firebase.client.ts`: lazy browser Firebase app/auth/firestore/App Check initialization.
- `src/modules/private-pro/firebase/firebase.admin.ts`: lazy Node-only Firebase Admin app/auth/firestore/storage initialization.
- `src/modules/private-pro/firebase/firebase.token.ts`: Edge-compatible Firebase ID-token verification with JOSE.
- `src/modules/private-pro/firebase/firebase.token.test.ts`: JWT verification tests with an in-memory JWK set.
- `src/modules/private-pro/firebase/firebase.appcheck.server.ts`: Node-only Firebase App Check verification for protected Vercel mutations.
- `src/modules/private-pro/auth/privatePro.auth.procedures.server.ts`: Node-only App Check and current-account procedure bases.

### Authentication

- `src/modules/private-pro/auth/privatePro.auth.types.ts`: identity, bootstrap, and entitlement types.
- `src/modules/private-pro/auth/privatePro.auth.service.ts`: framework-independent bootstrap and revocation logic.
- `src/modules/private-pro/auth/privatePro.auth.service.test.ts`: allowlist, claim, epoch, and rejection tests.
- `src/modules/private-pro/auth/privatePro.auth.router.ts`: Node tRPC bootstrap/status procedures.
- `src/modules/private-pro/auth/privatePro.auth.client.ts`: browser sign-in, sign-out, token, and App Check headers.
- `src/modules/private-pro/auth/ProviderPrivatePro.tsx`: application gate and bootstrap lifecycle.
- `src/modules/private-pro/auth/PrivateProAuthScreen.tsx`: sign-in, access-denied, and configuration UI.

### Sync protocol and server

- `src/modules/private-pro/sync/privatePro.sync.schemas.ts`: cloud document and request schemas.
- `src/modules/private-pro/sync/privatePro.sync.serialize.ts`: explicit chat/persona serialization and parsing.
- `src/modules/private-pro/sync/privatePro.sync.chunk.ts`: UTF-8 chunking and hashing.
- `src/modules/private-pro/sync/privatePro.sync.protocol.test.ts`: serialization, exclusion, size, and hash tests.
- `src/modules/private-pro/sync/privatePro.sync.repository.ts`: repository interface and domain errors.
- `src/modules/private-pro/sync/privatePro.sync.repository.firebase.ts`: Firestore implementation.
- `src/modules/private-pro/sync/privatePro.sync.service.ts`: prepare/chunk/commit/delete/persona operations.
- `src/modules/private-pro/sync/privatePro.sync.service.test.ts`: in-memory repository transaction tests.
- `src/modules/private-pro/sync/privatePro.sync.router.ts`: premium tRPC procedures.

### Local engine

- `src/modules/private-pro/sync/privatePro.sync.db.ts`: Dexie outbox, entity state, migration journal, binding, and quarantine.
- `src/modules/private-pro/sync/privatePro.sync.db.test.ts`: fake IndexedDB tests.
- `src/modules/private-pro/sync/privatePro.sync.transport.ts`: typed tRPC/Firestore transport adapter.
- `src/modules/private-pro/sync/privatePro.sync.engine.ts`: migration, scanning, outbox processing, listeners, retries, and conflict copies.
- `src/modules/private-pro/sync/privatePro.sync.engine.test.ts`: two-device fake transport and offline/reconnect tests.
- `src/modules/private-pro/sync/ProviderPrivateProSync.tsx`: starts and stops the engine after authentication.
- `src/modules/private-pro/sync/store-private-pro-sync.ts`: UI-facing sync state and quota store.

### Attachments

- `src/modules/private-pro/assets/privatePro.assets.types.ts`: reservations, metadata, and quota types.
- `src/modules/private-pro/assets/privatePro.assets.service.ts`: reservation/finalization/download/cleanup domain logic.
- `src/modules/private-pro/assets/privatePro.assets.service.test.ts`: quota and idempotency tests.
- `src/modules/private-pro/assets/privatePro.assets.router.ts`: signed upload/download procedures.
- `src/modules/private-pro/assets/privatePro.assets.client.ts`: DBlob upload/download and hydration.

### Firebase resources, administration, and documentation

- `firebase.json`: emulator and rules configuration.
- `firestore.rules`: UID, claim, epoch, shape, and read-only client rules.
- `storage.rules`: deny direct writes and restrict reads.
- `firestore.indexes.json`: sync and cleanup indexes.
- `test/firebase/private-pro.rules.test.ts`: emulator security tests.
- `tools/private-pro/manage-access.ts`: allowlist entitlement sync and revocation command.
- `docs/deploy-private-pro-firebase.md`: Firebase/Vercel deployment guide.

### Existing files modified

- `package.json`, `package-lock.json`: Firebase, JOSE, emulator, and fake IndexedDB dependencies/scripts.
- `next.config.ts`: externalize `firebase-admin` from Node bundles.
- `src/server/env.server.ts`: validate private Pro and Firebase environment variables.
- `src/server/trpc/trpc.server.ts`: optional verified identity in context plus real auth/premium middleware.
- `src/server/trpc/trpc.router-cloud.ts`: mount auth, sync, and asset routers.
- `src/common/util/trpc.client.ts`: attach Firebase ID and App Check tokens to Node requests.
- `pages/_app.tsx`: install auth and sync providers in the correct order.
- `src/common/stores/chat/store-chats.ts`: narrow sync snapshot/apply helpers.
- `src/apps/personas/store-app-personas.ts`: narrow sync snapshot/apply helpers.
- `src/modules/dblobs/dblobs.db.ts`: idempotent same-ID asset put/list helpers.
- `src/common/stores/blob/dblobs-portability.ts`: export new asset helpers.
- `src/common/layout/optima/nav/DesktopNav.tsx`, `src/common/layout/optima/nav/MobileNav.tsx`: account/sync controls.
- `docs/environment-variables.md`: private Pro variables.

---

### Task 1: Firebase configuration foundation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `next.config.ts`
- Modify: `src/server/env.server.ts`
- Create: `src/modules/private-pro/config/privatePro.config.ts`
- Create: `src/modules/private-pro/config/privatePro.config.server.ts`
- Test: `src/modules/private-pro/config/privatePro.config.test.ts`

**Interfaces:**
- Produces: `normalizePrivateProEmail(email: string): string`
- Produces: `parsePrivateProAllowlist(raw: string | undefined): ReadonlySet<string>`
- Produces: `isPrivateProEmailAllowed(email: string, allowlist: ReadonlySet<string>): boolean`
- Produces: `privateProClientConfig` and `getPrivateProServerConfig()`.

- [ ] **Step 1: Install pinned runtime and test dependencies**

Run:

```powershell
npm install firebase@12.17.1 firebase-admin@14.2.0 jose@6.2.9
npm install --save-dev firebase-tools@15.27.0 @firebase/rules-unit-testing@5.0.1 fake-indexeddb@6.2.4
```

Expected: `package.json` and `package-lock.json` contain the pinned packages.

- [ ] **Step 2: Write failing configuration tests**

Create `privatePro.config.test.ts` with Node test cases equivalent to:

```ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isPrivateProEmailAllowed, normalizePrivateProEmail, parsePrivateProAllowlist } from './privatePro.config.server';

describe('private Pro allowlist', () => {
  test('normalizes case and surrounding whitespace', () => {
    assert.equal(normalizePrivateProEmail('  Friend@Example.COM '), 'friend@example.com');
  });

  test('drops empty and duplicate entries', () => {
    assert.deepEqual([...parsePrivateProAllowlist('a@example.com, A@example.com, ,b@example.com')], [
      'a@example.com',
      'b@example.com',
    ]);
  });

  test('requires an exact email match', () => {
    const allowlist = parsePrivateProAllowlist('friend@example.com');
    assert.equal(isPrivateProEmailAllowed('friend@example.com', allowlist), true);
    assert.equal(isPrivateProEmailAllowed('other@example.com', allowlist), false);
  });
});
```

- [ ] **Step 3: Run the test and verify the missing-module failure**

Run: `npx tsx --test src/modules/private-pro/config/privatePro.config.test.ts`

Expected: FAIL because `privatePro.config.server.ts` does not exist.

- [ ] **Step 4: Implement client-safe and server-only configuration**

Implement:

```ts
export const PRIVATE_PRO_ATTACHMENT_QUOTA_BYTES = 1024 * 1024 * 1024;
export const PRIVATE_PRO_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const PRIVATE_PRO_CHAT_CHUNK_BYTES = 180 * 1024;

export const privateProClientConfig = {
  enabled: process.env.NEXT_PUBLIC_PRIVATE_PRO_ENABLED === 'true',
  firebase: {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? '',
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? '',
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? '',
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? '',
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? '',
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? '',
  },
  appCheckSiteKey: process.env.NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY ?? '',
} as const;
```

Server configuration must normalize escaped newlines in `FIREBASE_PRIVATE_KEY`, reject an enabled deployment with an empty allowlist, and expose only parsed values. Add corresponding Zod entries and `experimental__runtimeEnv` entries in `env.server.ts`. Add `firebase-admin` to `serverExternalPackages` in `next.config.ts`.

- [ ] **Step 5: Run focused tests and static checks**

Run:

```powershell
npx tsx --test src/modules/private-pro/config/privatePro.config.test.ts
npx tsc --noEmit --pretty
npx eslint src/modules/private-pro/config src/server/env.server.ts next.config.ts
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit the configuration foundation**

```powershell
git add package.json package-lock.json next.config.ts src/server/env.server.ts src/modules/private-pro/config
git commit -m "Cloud: add Firebase private Pro configuration"
```

---

### Task 2: Edge-safe identity and real tRPC authorization

**Files:**
- Create: `src/modules/private-pro/firebase/firebase.token.ts`
- Create: `src/modules/private-pro/firebase/firebase.token.test.ts`
- Create: `src/modules/private-pro/auth/privatePro.auth.types.ts`
- Modify: `src/server/trpc/trpc.server.ts`

**Interfaces:**
- Produces: `verifyFirebaseIdToken(token: string, options?: VerifyOptions): Promise<PrivateProIdentity>`
- Produces context field: `privateProIdentity: PrivateProIdentity | null`
- Produces: `publicProcedure` and `edgeProcedure` that require a verified allowlisted identity whenever private Pro is enabled, while retaining open-source behavior when disabled.
- Produces: `authedProcedure` requiring a verified allowlisted email.
- Produces: `premiumProcedure` requiring `privatePro === true` and numeric `privateProEpoch`.

- [ ] **Step 1: Write JWT verification tests**

Generate an RSA key pair with JOSE in the test, sign a Firebase-shaped token, and inject `createLocalJWKSet({ keys: [publicJwk] })`. Assert valid issuer/audience/email verification succeeds and wrong audience, expired token, unverified email, or missing bearer fails.

The accepted identity must have this exact shape:

```ts
export interface PrivateProIdentity {
  uid: string;
  email: string;
  emailVerified: boolean;
  privatePro: boolean;
  privateProEpoch: number | null;
  issuedAt: number;
  expiresAt: number;
}
```

- [ ] **Step 2: Run the token test and verify failure**

Run: `npx tsx --test src/modules/private-pro/firebase/firebase.token.test.ts`

Expected: FAIL because the verifier does not exist.

- [ ] **Step 3: Implement JOSE verification without Firebase Admin imports**

Use the Firebase Secure Token JWK endpoint and validate:

```ts
const issuer = `https://securetoken.google.com/${projectId}`;
const { payload } = await jwtVerify(token, jwks, {
  algorithms: ['RS256'],
  audience: projectId,
  issuer,
});
```

Require `sub`, `email`, `email_verified === true`, `iat`, and `exp`. Normalize the email. Convert claims with strict boolean/number checks.

- [ ] **Step 4: Extend the tRPC context and middleware**

Parse `Authorization: Bearer <token>` only when present. Verification failure leaves a structured authentication error for middleware, without breaking public procedures. Implement middleware equivalent to:

```ts
const requireAuthed = t.middleware(({ ctx, next }) => {
  const identity = ctx.privateProIdentity;
  if (!identity || !isPrivateProEmailAllowed(identity.email, serverConfig.allowedEmails))
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx: { ...ctx, privateProIdentity: identity } });
});

const requirePremium = requireAuthed.unstable_pipe(({ ctx, next }) => {
  if (!ctx.privateProIdentity.privatePro || ctx.privateProIdentity.privateProEpoch === null)
    throw new TRPCError({ code: 'FORBIDDEN' });
  return next({ ctx });
});
```

Define `requireDeploymentAccess` so it passes anonymous requests only when `NEXT_PUBLIC_PRIVATE_PRO_ENABLED !== 'true'`; otherwise it performs the same verified-token and allowlist checks as `requireAuthed`. Build `publicProcedure` and `edgeProcedure` on this middleware so all existing public and Edge routes become allowlist-only on the `pro` deployment, including AIX, model listing, browsing, sharing, speech, and YouTube routes. The Google sign-in UI itself requires no application API route before it obtains a Firebase token.

- [ ] **Step 5: Run tests, typecheck, and focused lint**

Run:

```powershell
npx tsx --test src/modules/private-pro/firebase/firebase.token.test.ts
npm run tscheck
npx eslint src/modules/private-pro/firebase src/modules/private-pro/auth/privatePro.auth.types.ts src/server/trpc/trpc.server.ts
```

Expected: exit 0.

- [ ] **Step 6: Commit identity middleware**

```powershell
git add src/modules/private-pro/firebase src/modules/private-pro/auth/privatePro.auth.types.ts src/server/trpc/trpc.server.ts
git commit -m "Cloud: enforce private Pro identity"
```

---

### Task 3: Firebase Admin bootstrap and browser authentication gate

**Files:**
- Create: `src/modules/private-pro/firebase/firebase.admin.ts`
- Create: `src/modules/private-pro/firebase/firebase.appcheck.server.ts`
- Create: `src/modules/private-pro/firebase/firebase.client.ts`
- Create: `src/modules/private-pro/auth/privatePro.auth.procedures.server.ts`
- Create: `src/modules/private-pro/auth/privatePro.auth.service.ts`
- Create: `src/modules/private-pro/auth/privatePro.auth.service.test.ts`
- Create: `src/modules/private-pro/auth/privatePro.auth.router.ts`
- Create: `src/modules/private-pro/auth/privatePro.auth.client.ts`
- Create: `src/modules/private-pro/auth/ProviderPrivatePro.tsx`
- Create: `src/modules/private-pro/auth/PrivateProAuthScreen.tsx`
- Create: `src/modules/private-pro/sync/ProviderPrivateProSync.tsx`
- Modify: `src/server/trpc/trpc.router-cloud.ts`
- Modify: `src/common/util/trpc.client.ts`
- Modify: `pages/_app.tsx`

**Interfaces:**
- Produces: `bootstrapPrivateProAccount(identity, ports): Promise<PrivateProBootstrap>`
- Produces tRPC procedures: `privateProAuth.bootstrap`, `privateProAuth.status`.
- Produces procedure bases: `privateProBootstrapProcedure` and `privateProNodePremiumProcedure`.
- Produces: `privateProGetRequestHeaders(): Promise<Record<string, string>>`.
- Produces React context: `usePrivateProAuth()`.

- [ ] **Step 1: Write bootstrap service tests against fake ports**

Define an admin port rather than mocking Firebase modules:

```ts
export interface PrivateProAuthAdminPort {
  getAccount(uid: string): Promise<PrivateProAccountRecord | null>;
  saveAccount(record: PrivateProAccountRecord): Promise<void>;
  setClaims(uid: string, claims: { privatePro: true; privateProEpoch: number }): Promise<void>;
  revokeRefreshTokens(uid: string): Promise<void>;
}
```

Test initial epoch `1`, idempotent bootstrap, rejected email, verified-email requirement, and stale claim refresh.

- [ ] **Step 2: Run the service test and verify failure**

Run: `npx tsx --test src/modules/private-pro/auth/privatePro.auth.service.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement Admin initialization and bootstrap service**

Initialize one Admin app lazily with `getApps()` and `cert()`. Export `getPrivateProAdminAuth()`, `getPrivateProFirestore()`, `getPrivateProStorageBucket()`, and `getPrivateProAdminAppCheck()`.

The account document must include:

```ts
interface PrivateProAccountRecord {
  uid: string;
  email: string;
  active: boolean;
  accessEpoch: number;
  quotaBytes: number;
  usedBytes: number;
  reservedBytes: number;
  createdAtMs: number;
  updatedAtMs: number;
}
```

- [ ] **Step 4: Add bootstrap/status tRPC procedures**

Create Node-only procedure bases:

```ts
export const privateProBootstrapProcedure = authedProcedure.use(requirePrivateProAppCheck);
export const privateProNodePremiumProcedure = premiumProcedure
  .use(requirePrivateProAppCheck)
  .use(requireActiveAccountAndCurrentEpoch);
```

`bootstrap` uses `privateProBootstrapProcedure`, calls the Admin service, sets claims, and returns `{ uid, email, accessEpoch, quotaBytes, usedBytes, reservedBytes }`. `status` uses `privateProNodePremiumProcedure`. Export the Node-only procedure bases for the sync and asset routers in later tasks.

Implement App Check verification with `getPrivateProAdminAppCheck().verifyToken(token)`. When `NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY` is configured, protected mutations require `x-firebase-appcheck`; local emulator/test configuration may explicitly disable enforcement. Bootstrap is the only authenticated procedure allowed before a refreshed private Pro claim, but it still verifies App Check when enforcement is enabled. `requireActiveAccountAndCurrentEpoch` reads the account document through Firebase Admin and rejects inactive accounts or claim epochs that do not match `account.accessEpoch`.

- [ ] **Step 5: Add browser Firebase initialization and token headers**

Lazy initialize Auth, Firestore, and optional App Check. Implement Google popup with redirect fallback. `privateProGetRequestHeaders()` returns the current ID token and optional App Check token:

```ts
return {
  authorization: `Bearer ${await user.getIdToken()}`,
  ...(appCheckToken && { 'x-firebase-appcheck': appCheckToken }),
};
```

Attach these headers to `apiAsync`, `apiQuery`, `apiStream`, `apiAsyncNode`, and `apiStreamNode`. This is required because `publicProcedure` and `edgeProcedure` become deployment-gated when private Pro is enabled. Do not verify tokens with Firebase Admin on Edge; the Edge-safe JOSE verifier from Task 2 handles those requests.

- [ ] **Step 6: Install the application auth gate**

Provider order in `_app.tsx`:

```tsx
<ProviderTheming emotionCache={emotionCache}>
  <ProviderPrivatePro>
    <ProviderSingleTab>
      <ProviderBackendCapabilities>
        <ProviderBootstrapLogic>
          <ProviderPrivateProSync>
            {appContent}
          </ProviderPrivateProSync>
        </ProviderBootstrapLogic>
      </ProviderBackendCapabilities>
    </ProviderSingleTab>
  </ProviderPrivatePro>
</ProviderTheming>
```

For this task, use a temporary passthrough `ProviderPrivateProSync` stub that Task 7 replaces. The auth screen must distinguish sign-in, bootstrapping, denied, misconfigured, and signed-in states.

- [ ] **Step 7: Run auth tests and repository checks**

Run:

```powershell
npx tsx --test src/modules/private-pro/auth/privatePro.auth.service.test.ts
npm run tscheck
npx eslint src/modules/private-pro/auth src/modules/private-pro/firebase/firebase.admin.ts src/modules/private-pro/firebase/firebase.client.ts src/server/trpc/trpc.router-cloud.ts src/common/util/trpc.client.ts pages/_app.tsx
```

Expected: exit 0.

- [ ] **Step 8: Commit authentication**

```powershell
git add src/modules/private-pro/auth src/modules/private-pro/firebase/firebase.admin.ts src/modules/private-pro/firebase/firebase.client.ts src/server/trpc/trpc.router-cloud.ts src/common/util/trpc.client.ts pages/_app.tsx
git commit -m "Cloud: add allowlisted Google sign-in"
```

---

### Task 4: Explicit sync schemas, serialization, hashing, and chat chunks

**Files:**
- Create: `src/modules/private-pro/sync/privatePro.sync.schemas.ts`
- Create: `src/modules/private-pro/sync/privatePro.sync.serialize.ts`
- Create: `src/modules/private-pro/sync/privatePro.sync.chunk.ts`
- Test: `src/modules/private-pro/sync/privatePro.sync.protocol.test.ts`
- Modify: `src/common/stores/chat/store-chats.ts`
- Modify: `src/apps/personas/store-app-personas.ts`

**Interfaces:**
- Produces: `serializeSyncConversation(conversation: DConversation): SyncConversation | null`
- Produces: `parseSyncConversation(value: unknown): DConversation`
- Produces: `serializeSyncPersona(persona: SimplePersona): SyncPersona`
- Produces: `splitSyncPayload(json: string, maxBytes: number): SyncChunk[]`
- Produces: `privateProHash(value: string | Uint8Array): Promise<string>`
- Produces store helpers: `chatSyncSnapshot`, `chatSyncUpsert`, `chatSyncDelete`, `personaSyncSnapshot`, `personaSyncUpsert`, `personaSyncDelete`.

- [ ] **Step 1: Write protocol tests**

Cover:

- Incognito conversation returns `null`.
- `_abortController` and `pendingIncomplete` never appear in serialized JSON.
- Incomplete chats are skipped until no message has `pendingIncomplete`.
- Model stores, API keys, Scratch Clip, and arbitrary localStorage values are not accepted by any serializer API.
- Persona fields round-trip exactly.
- A Unicode payload split at 180 KiB reconstructs byte-for-byte.
- Every chunk is below the configured byte limit.
- Equal input hashes match and one-byte differences do not.

- [ ] **Step 2: Run protocol tests and verify failure**

Run: `npx tsx --test src/modules/private-pro/sync/privatePro.sync.protocol.test.ts`

Expected: FAIL because schemas and serializers do not exist.

- [ ] **Step 3: Implement Zod schemas and explicit serializers**

Use discriminated, versioned envelopes:

```ts
export const SyncConversationSchema = z.object({
  schemaVersion: z.literal(1),
  conversation: z.object({
    id: z.string().min(1),
    systemPurposeId: z.string().optional(),
    messages: z.array(SyncMessageSchema),
    autoTitle: z.string().optional(),
    userTitle: z.string().optional(),
    isArchived: z.boolean().optional(),
    userSymbol: z.string().optional(),
    tokenCount: z.number(),
    created: z.number(),
    updated: z.number(),
  }),
});
```

Recreate `_abortController: null` only after parsing. Preserve current converters and sanitizers on remote hydration.

- [ ] **Step 4: Implement deterministic UTF-8 chunking and SHA-256**

Chunk encoded bytes at a fixed maximum and decode each chunk independently only at reconstruction time by concatenating bytes first. Store `{ id, index, byteLength, hash, payloadBase64 }` so no surrogate or multi-byte boundary can corrupt text.

- [ ] **Step 5: Add narrow store adapters**

Chat adapters use existing persistence filtering and conversation repair logic. Persona adapters export no general store mutation. Remote apply methods must accept a suppression callback so Task 7 can prevent feedback loops.

- [ ] **Step 6: Run tests and checks**

Run:

```powershell
npx tsx --test src/modules/private-pro/sync/privatePro.sync.protocol.test.ts
npm run tscheck
npx eslint src/modules/private-pro/sync/privatePro.sync.schemas.ts src/modules/private-pro/sync/privatePro.sync.serialize.ts src/modules/private-pro/sync/privatePro.sync.chunk.ts src/common/stores/chat/store-chats.ts src/apps/personas/store-app-personas.ts
```

Expected: exit 0.

- [ ] **Step 7: Commit protocol primitives**

```powershell
git add src/modules/private-pro/sync src/common/stores/chat/store-chats.ts src/apps/personas/store-app-personas.ts
git commit -m "Cloud: define private sync protocol"
```

---

### Task 5: Revisioned Firestore sync service and router

**Files:**
- Create: `src/modules/private-pro/sync/privatePro.sync.repository.ts`
- Create: `src/modules/private-pro/sync/privatePro.sync.repository.firebase.ts`
- Create: `src/modules/private-pro/sync/privatePro.sync.service.ts`
- Test: `src/modules/private-pro/sync/privatePro.sync.service.test.ts`
- Create: `src/modules/private-pro/sync/privatePro.sync.router.ts`
- Modify: `src/server/trpc/trpc.router-cloud.ts`

**Interfaces:**
- Produces: `prepareChatMutation`, `putChatChunk`, `commitChatMutation`, `deleteChat`, `putPersona`, `deletePersona`.
- Produces router namespace: `privateProSync`.
- Consumes: identity from `premiumProcedure` and explicit sync schemas from Task 4.

- [ ] **Step 1: Write an in-memory repository and failing service tests**

Test these exact outcomes:

- New chat with `baseRevision: 0` prepares revision 1.
- Matching base revision commits and increments once.
- Repeating the same `operationId` is idempotent.
- Stale base revision returns `{ status: 'conflict', currentRevision, currentHash }` without writes.
- Commit fails until every declared chunk exists and matches byte length/hash.
- Delete creates a monotonic tombstone and hides the manifest.
- Offline stale upsert cannot resurrect a tombstoned chat.
- Persona upsert/delete follows the same base-revision rules.
- UID is always taken from the service identity, not input.

- [ ] **Step 2: Run service tests and verify failure**

Run: `npx tsx --test src/modules/private-pro/sync/privatePro.sync.service.test.ts`

Expected: FAIL because service/repository modules do not exist.

- [ ] **Step 3: Implement repository interfaces and domain errors**

Use explicit methods, not a generic document API:

```ts
export interface PrivateProSyncRepository {
  prepareChat(uid: string, request: PrepareChatRequest): Promise<PrepareChatResult>;
  putPreparedChatChunk(uid: string, operationId: string, chunk: SyncChunk): Promise<void>;
  commitPreparedChat(uid: string, operationId: string): Promise<CommitChatResult>;
  deleteChat(uid: string, request: DeleteEntityRequest): Promise<DeleteEntityResult>;
  putPersona(uid: string, request: PutPersonaRequest): Promise<PutEntityResult>;
  deletePersona(uid: string, request: DeleteEntityRequest): Promise<DeleteEntityResult>;
}
```

- [ ] **Step 4: Implement Firestore staging and atomic manifest commits**

Store staged chunks under `users/{uid}/chatUploads/{operationId}/chunks/{chunkId}`. `prepare` creates an expiring upload record after a transaction checks the current manifest/tombstone. `commit` verifies known chunk documents, copies them into the immutable revision path `users/{uid}/chats/{chatId}/revisions/{revision}/chunks/{chunkId}`, then a transaction changes only the active manifest pointer and upload status. Old immutable revisions remain readable until cleanup.

- [ ] **Step 5: Add premium tRPC routes**

Build every procedure on `privateProNodePremiumProcedure`. Validate every payload with Zod and map domain conflicts to typed results instead of generic 500 errors. Limit chunk request size below the Vercel front-door limit.

- [ ] **Step 6: Run focused and repository checks**

Run:

```powershell
npx tsx --test src/modules/private-pro/sync/privatePro.sync.service.test.ts
npm run tscheck
npx eslint src/modules/private-pro/sync src/server/trpc/trpc.router-cloud.ts
```

Expected: exit 0.

- [ ] **Step 7: Commit server synchronization**

```powershell
git add src/modules/private-pro/sync src/server/trpc/trpc.router-cloud.ts
git commit -m "Cloud: add revisioned sync service"
```

---

### Task 6: Durable local outbox, binding, and migration journal

**Files:**
- Create: `src/modules/private-pro/sync/privatePro.sync.db.ts`
- Test: `src/modules/private-pro/sync/privatePro.sync.db.test.ts`

**Interfaces:**
- Produces: `PrivateProSyncDB`.
- Produces: `bindVault(uid)`, `resetVaultBinding()`, `enqueueOperation()`, `leaseNextOperation()`, `ackOperation()`, `retryOperation()`, `getEntityState()`, `putEntityState()`, `recordMigrationItem()`, `quarantineRemoteRecord()`.

- [ ] **Step 1: Write fake IndexedDB tests**

Import `fake-indexeddb/auto` and test:

- First UID binds successfully.
- Same UID is idempotent.
- Different UID returns `binding-conflict` without mutation.
- Enqueue deduplicates by `uid/entityType/entityId/contentHash`.
- Leasing is exclusive and expired leases recover.
- Retry increments attempts and schedules a capped delay.
- Acknowledgement updates entity revision/hash and removes the outbox record atomically.
- Migration completion is resumable per entity.
- Quarantine records preserve error and payload metadata without entering entity state.

- [ ] **Step 2: Run DB tests and verify failure**

Run: `npx tsx --test src/modules/private-pro/sync/privatePro.sync.db.test.ts`

Expected: FAIL because the database module does not exist.

- [ ] **Step 3: Implement focused Dexie tables**

Use one database named `private-pro-sync-v1` with tables:

```ts
bindings: '&key, uid'
outbox: '++id, &[dedupeKey], [uid+availableAtMs], leaseUntilMs'
entities: '&[uid+entityKey], uid, entityType, entityId, remoteRevision, localHash'
migrations: '&[uid+entityKey], uid, status, updatedAtMs'
quarantine: '++id, uid, entityKey, createdAtMs'
```

No synchronized content or API key material belongs in the binding table.

- [ ] **Step 4: Run DB tests and checks**

Run:

```powershell
npx tsx --test src/modules/private-pro/sync/privatePro.sync.db.test.ts
npm run tscheck
npx eslint src/modules/private-pro/sync/privatePro.sync.db.ts
```

Expected: exit 0.

- [ ] **Step 5: Commit durable local state**

```powershell
git add src/modules/private-pro/sync/privatePro.sync.db.ts src/modules/private-pro/sync/privatePro.sync.db.test.ts
git commit -m "Cloud: add durable sync outbox"
```

---

### Task 7: Client sync engine, automatic migration, realtime downloads, and conflict copies

**Files:**
- Create: `src/modules/private-pro/sync/privatePro.sync.transport.ts`
- Create: `src/modules/private-pro/sync/privatePro.sync.engine.ts`
- Test: `src/modules/private-pro/sync/privatePro.sync.engine.test.ts`
- Create: `src/modules/private-pro/sync/store-private-pro-sync.ts`
- Replace: `src/modules/private-pro/sync/ProviderPrivateProSync.tsx`
- Modify: `pages/_app.tsx`

**Interfaces:**
- Produces: `createPrivateProSyncEngine(deps): PrivateProSyncEngine` with `start()`, `stop()`, `scanNow()`, and `retryNow()`.
- Consumes store adapters from Task 4, outbox from Task 6, tRPC server from Task 5, and Firebase Firestore listeners.

- [ ] **Step 1: Write two-device engine tests using fake stores and transport**

Test:

- First start binds UID and auto-enqueues all eligible local chats/personas.
- Incognito and incomplete chats are absent from migration/outbox.
- Restart resumes unfinished migration without duplicate operations.
- Store changes debounce to one operation per final hash.
- Offline transport keeps the operation and schedules retry.
- Reconnect drains the outbox.
- Remote revision applies locally under suppression and does not echo-upload.
- Remote tombstone removes an unchanged local entity.
- Remote tombstone preserves unsynced local changes as a conflict copy before deleting the canonical entity.
- Stale local mutation creates a conflict copy with a new ID and preserves both versions.
- Different UID on the same binding enters `binding-conflict` and starts no listener.
- Invalid remote payload is quarantined and local data remains unchanged.

- [ ] **Step 2: Run engine tests and verify failure**

Run: `npx tsx --test src/modules/private-pro/sync/privatePro.sync.engine.test.ts`

Expected: FAIL because engine/transport modules do not exist.

- [ ] **Step 3: Implement typed transport**

The transport wraps `apiAsyncNode.privateProSync` and Firestore `onSnapshot` listeners. Listener queries are scoped below `users/{uid}` and unsubscribe on stop/sign-out. Remote chat application fetches the active immutable revision chunks, validates hashes, concatenates bytes, then parses the explicit schema.

- [ ] **Step 4: Implement migration and local scanning**

Wait for chat and persona persistence hydration. Bind the vault, register the device, read remote manifests, inventory local entities, and create migration entries. For same-ID/different-hash collisions, preserve the local entity as a conflict copy before download or upload.

- [ ] **Step 5: Implement outbox processing and retries**

Process one leased entity operation at a time per UID. Upload chat chunks sequentially, commit, and acknowledge the remote revision. Classify authentication/schema/quota errors as blocked and network/unavailable errors as retryable with capped exponential backoff and jitter.

- [ ] **Step 6: Implement realtime remote application**

Maintain a suppression set keyed by entity. Update entity state before applying remote store changes. Tombstones win over older manifests. Before applying a tombstone, compare the current local hash with the last acknowledged hash. If they differ, create a conflict copy and then delete the canonical entity. Set UI state to `synced` only when migration is complete and the outbox has no due/leased operations.

- [ ] **Step 7: Replace the provider stub**

Start the engine only after `usePrivateProAuth()` reports an approved bootstrapped user. Stop and unsubscribe on sign-out or account change. Keep local stores untouched on stop.

- [ ] **Step 8: Run engine tests and checks**

Run:

```powershell
npx tsx --test src/modules/private-pro/sync/privatePro.sync.engine.test.ts
npm run tscheck
npx eslint src/modules/private-pro/sync/privatePro.sync.transport.ts src/modules/private-pro/sync/privatePro.sync.engine.ts src/modules/private-pro/sync/store-private-pro-sync.ts src/modules/private-pro/sync/ProviderPrivateProSync.tsx pages/_app.tsx
```

Expected: exit 0.

- [ ] **Step 9: Commit the client engine**

```powershell
git add src/modules/private-pro/sync pages/_app.tsx
git commit -m "Cloud: synchronize private chats and personas"
```

---

### Task 8: Signed attachment uploads, quota accounting, and DBlob hydration

**Files:**
- Create: `src/modules/private-pro/assets/privatePro.assets.types.ts`
- Create: `src/modules/private-pro/assets/privatePro.assets.service.ts`
- Test: `src/modules/private-pro/assets/privatePro.assets.service.test.ts`
- Create: `src/modules/private-pro/assets/privatePro.assets.router.ts`
- Create: `src/modules/private-pro/assets/privatePro.assets.client.ts`
- Modify: `src/modules/dblobs/dblobs.db.ts`
- Modify: `src/common/stores/blob/dblobs-portability.ts`
- Modify: `src/modules/private-pro/sync/privatePro.sync.engine.ts`
- Modify: `src/server/trpc/trpc.router-cloud.ts`

**Interfaces:**
- Produces: `reserveAssetUpload`, `finalizeAssetUpload`, `getAssetDownload`, `releaseExpiredReservations`.
- Produces DBlob helpers: `putDBAsset(asset: DBlobDBAsset): Promise<void>` and `getDBAssetsByIds(ids: DBlobAssetId[]): Promise<DBlobDBAsset[]>`.
- Consumes `collectFragmentAssetIds` from chat storage.

- [ ] **Step 1: Write quota service tests with fake storage and account ports**

Test:

- Reservation succeeds when `used + reserved + requested <= quota`.
- The 1-byte-over limit is rejected.
- Duplicate hash returns the existing asset without reserving again.
- Same operation ID is idempotent.
- Finalization trusts authoritative object metadata, not client size.
- Size/hash/path/content-type mismatch deletes the object and releases reservation.
- Successful finalization moves bytes from reserved to used exactly once.
- Expired reservation releases bytes and removes an orphan object.
- A user cannot finalize another UID's path.

- [ ] **Step 2: Run attachment service tests and verify failure**

Run: `npx tsx --test src/modules/private-pro/assets/privatePro.assets.service.test.ts`

Expected: FAIL because asset modules do not exist.

- [ ] **Step 3: Implement quota transactions and signed URLs**

Use an account transaction for reservation/finalization. Sign uploads with required content type and `x-goog-meta-sha256` extension header. Store only server-derived paths:

```ts
const objectPath = `users/${uid}/assets/${assetId}`;
```

The finalize endpoint calls `file.getMetadata()` and compares `size`, `contentType`, and `metadata.sha256` with the reservation.

Build reserve, finalize, download, and cleanup procedures on `privateProNodePremiumProcedure` so App Check, account activity, and the current access epoch are enforced before storage work.

- [ ] **Step 4: Add idempotent same-ID DBlob writes**

Use Dexie `put`, not `add`, for remote hydration. Convert downloaded bytes to base64 and restore the original `DBlobDBAsset` metadata with its existing ID so current message references render unchanged.

- [ ] **Step 5: Integrate assets into migration and chat sync**

Before committing a chat, upload every referenced missing asset. After remote chat download, hydrate missing DBlobs before applying the chat. Record account-scoped asset references so a cleanup command can remove finalized assets with no live chat/persona references after a grace period.

- [ ] **Step 6: Run attachment tests and checks**

Run:

```powershell
npx tsx --test src/modules/private-pro/assets/privatePro.assets.service.test.ts
npm run tscheck
npx eslint src/modules/private-pro/assets src/modules/dblobs/dblobs.db.ts src/common/stores/blob/dblobs-portability.ts src/modules/private-pro/sync/privatePro.sync.engine.ts src/server/trpc/trpc.router-cloud.ts
```

Expected: exit 0.

- [ ] **Step 7: Commit attachment sync**

```powershell
git add src/modules/private-pro/assets src/modules/dblobs/dblobs.db.ts src/common/stores/blob/dblobs-portability.ts src/modules/private-pro/sync/privatePro.sync.engine.ts src/server/trpc/trpc.router-cloud.ts
git commit -m "Cloud: sync private attachments with quotas"
```

---

### Task 9: Account and sync status UI

**Files:**
- Create: `src/modules/private-pro/ui/PrivateProAccountControl.tsx`
- Create: `src/modules/private-pro/ui/PrivateProSyncStatus.tsx`
- Create: `src/modules/private-pro/ui/PrivateProVaultResetDialog.tsx`
- Create: `src/modules/private-pro/ui/privatePro.ui.ts`
- Test: `src/modules/private-pro/ui/privatePro.ui.test.ts`
- Modify: `src/common/layout/optima/nav/DesktopNav.tsx`
- Modify: `src/common/layout/optima/nav/MobileNav.tsx`
- Modify: `src/modules/private-pro/auth/PrivateProAuthScreen.tsx`

**Interfaces:**
- Consumes: `usePrivateProAuth()` and `usePrivateProSyncStore()`.
- Produces: account menu, migration progress, quota display, retry, sign-out, and reset/export guidance.

- [ ] **Step 1: Add deterministic view-model tests**

Extract `privateProSyncLabel(state)` and test labels for `local`, `migrating`, `syncing`, `synced`, `offline`, `conflict`, `quota-blocked`, `binding-conflict`, and `error`.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npx tsx --test src/modules/private-pro/ui/privatePro.ui.test.ts`

Expected: FAIL because UI view-model code does not exist.

- [ ] **Step 3: Implement compact desktop and mobile controls**

Use existing Joy components and icons. Do not add a new icon library. Show bytes used/quota, migration counts, last error, retry, and sign-out. Sign-out copy must state that local data remains.

- [ ] **Step 4: Implement binding-conflict reset flow**

The dialog must not silently delete. Link to the existing backup/export UI, require a typed confirmation phrase, clear only the sync database and synchronized local vault after confirmation, then permit rebinding. Model settings and API keys remain untouched.

- [ ] **Step 5: Run tests, typecheck, and lint**

Run:

```powershell
npx tsx --test src/modules/private-pro/ui/privatePro.ui.test.ts
npm run tscheck
npx eslint src/modules/private-pro/ui src/common/layout/optima/nav/DesktopNav.tsx src/common/layout/optima/nav/MobileNav.tsx src/modules/private-pro/auth/PrivateProAuthScreen.tsx
```

Expected: exit 0.

- [ ] **Step 6: Commit private Pro UI**

```powershell
git add src/modules/private-pro/ui src/common/layout/optima/nav/DesktopNav.tsx src/common/layout/optima/nav/MobileNav.tsx src/modules/private-pro/auth/PrivateProAuthScreen.tsx
git commit -m "Cloud: add private Pro account controls"
```

---

### Task 10: Firebase rules, emulator security tests, and indexes

**Files:**
- Create: `firebase.json`
- Create: `firestore.rules`
- Create: `storage.rules`
- Create: `firestore.indexes.json`
- Create: `test/firebase/private-pro.rules.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces scripts: `test:firebase` and `test:firebase:exec`.
- Enforces read-only client Firestore access and denied direct Storage writes.

- [ ] **Step 1: Write emulator tests before rules**

Use `initializeTestEnvironment` and contexts with claims. Test:

- Approved UID reads its account/chat/persona/tombstone/asset metadata.
- Different UID cannot read.
- Missing `privatePro`, inactive account, or stale `privateProEpoch` cannot read Firestore data.
- Client cannot write manifests, chunks, personas, tombstones, quota, reservations, or account fields.
- Direct Cloud Storage upload is denied.
- Approved UID can read only `users/{uid}/assets/*`.

- [ ] **Step 2: Add emulator scripts and run to verify failure**

Add:

```json
"test:firebase": "tsx --test test/firebase/**/*.test.ts",
"test:firebase:exec": "firebase emulators:exec --only firestore,storage --project demo-private-pro \"npm run test:firebase\""
```

Run: `npm run test:firebase:exec`

Expected: FAIL because rules/config do not exist or allow assertions do not pass.

- [ ] **Step 3: Implement Firestore rules**

Rules must read the account document and require:

```text
request.auth != null
request.auth.uid == uid
request.auth.token.privatePro == true
request.auth.token.privateProEpoch == account.accessEpoch
account.active == true
```

Allow reads only for documented synchronized collections. Deny all browser writes under `users/{uid}`.

- [ ] **Step 4: Implement Storage rules**

Deny every client write. Cloud Storage rules cannot read Firestore account documents, so allow reads only when the path UID matches `request.auth.uid` and token claims contain `privatePro == true` plus a numeric `privateProEpoch`. Signed URL uploads use service-account IAM and do not rely on Firebase Storage rules. Document that account deactivation and epoch changes become effective for direct Storage reads after token refresh or expiry, while Vercel mutations are blocked immediately.

- [ ] **Step 5: Add required indexes and run emulator tests**

Run: `npm run test:firebase:exec`

Expected: all rule tests pass.

- [ ] **Step 6: Run static checks and commit Firebase resources**

Run:

```powershell
npm run tscheck
npx eslint test/firebase
git add firebase.json firestore.rules storage.rules firestore.indexes.json test/firebase package.json package-lock.json
git commit -m "Cloud: secure Firebase private vaults"
```

---

### Task 11: Administration and deployment documentation

**Files:**
- Create: `tools/private-pro/manage-access.ts`
- Test: `tools/private-pro/manage-access.test.ts`
- Create: `docs/deploy-private-pro-firebase.md`
- Modify: `docs/environment-variables.md`
- Modify: `package.json`

**Interfaces:**
- Produces commands: `npm run private-pro:sync-access` and `npm run private-pro:revoke -- user@example.com`.

- [ ] **Step 1: Write pure access-diff tests**

Create `tools/private-pro/manage-access.test.ts` and test that the command computes `grant`, `refresh`, `revoke`, and `unchanged` sets from Firebase users/accounts plus the normalized environment allowlist.

- [ ] **Step 2: Run the test and verify failure**

Run: `npx tsx --test tools/private-pro/manage-access.test.ts`

Expected: FAIL because the management module does not exist.

- [ ] **Step 3: Implement entitlement sync and revocation**

`sync-access` pages through Firebase users, grants claims to allowlisted verified emails, creates/activates account records, and revokes non-allowlisted previously entitled users by incrementing epoch, clearing claims, setting `active: false`, and revoking refresh tokens. `revoke` performs the same operation for one normalized email.

- [ ] **Step 4: Write deployment documentation**

Document exact Firebase and Vercel steps, including:

- Blaze selection and budget alerts.
- Storage region selection among regions eligible for no-cost quotas.
- Google provider authorized domains and redirect URLs.
- Firestore Native mode and rules/index deployment.
- Storage CORS needed for signed browser uploads.
- App Check setup and enforcement rollout.
- Service account permissions.
- Every environment variable with an example that contains no real secret.
- Allowlist updates followed by `private-pro:sync-access`.
- Emulator commands and production smoke checks.
- Explicit warning that budget alerts are not hard spending caps.

- [ ] **Step 5: Run tests and documentation checks**

Run:

```powershell
npx tsx --test tools/private-pro/manage-access.test.ts
npm run tscheck
npx eslint tools/private-pro
$docs = Get-Content -Raw 'docs/deploy-private-pro-firebase.md','docs/environment-variables.md'
if ($docs -match '\bT[B]D\b|\bT[O]DO\b' -or $docs.Contains([char]0x2014)) { throw 'Documentation contains a placeholder or prohibited punctuation.' }
```

Expected: tests/checks pass and the documentation validation does not throw.

- [ ] **Step 6: Commit administration and deployment guide**

```powershell
git add tools/private-pro docs/deploy-private-pro-firebase.md docs/environment-variables.md package.json package-lock.json
git commit -m "Cloud: document private Pro deployment"
```

---

### Task 12: Full integration verification and hardening

**Files:**
- Modify only files required by failures found in this task.

**Interfaces:**
- Produces a branch that satisfies the approved spec and all verification gates.

- [ ] **Step 1: Run every private Pro unit test together**

Run:

```powershell
npx tsx --test "src/modules/private-pro/**/*.test.ts" "tools/private-pro/**/*.test.ts"
```

Expected: zero failures.

- [ ] **Step 2: Run Firebase Emulator Suite tests**

Run: `npm run test:firebase:exec`

Expected: zero failures and no open handles after emulator shutdown.

- [ ] **Step 3: Run repository unit tests**

Run: `npm test`

Expected: zero failing tests. Live vendor tests without credentials may report skips.

- [ ] **Step 4: Run typecheck and lint**

Run:

```powershell
npm run tscheck
npm run lint
```

Expected: both commands exit 0.

- [ ] **Step 5: Run production build**

Run: `npm run build`

Expected: exit 0, with Firebase Admin absent from Edge bundle errors and no missing environment validation failures for local builds.

- [ ] **Step 6: Audit security and exclusions**

Run:

```powershell
rg -n "API_KEY|apiKey|secret|token" src/modules/private-pro
rg -n "localStorage|store-llms|ScratchClip|ramble|_abortController|pendingIncomplete" src/modules/private-pro
git diff main...HEAD --check
git status --short --branch
```

Inspect every match. Confirm secrets are configuration references only, ID/App Check tokens are never logged/persisted, excluded stores have no serialization path, and the worktree contains only intentional changes.

- [ ] **Step 7: Perform a requirements checklist against the spec**

Verify each section of `docs/superpowers/specs/2026-08-16-private-pro-sync-design.md` has implemented code, tests, or deployment documentation. Record any deliberate limitation in the deployment guide before completion.

- [ ] **Step 8: Commit only verification-driven fixes**

If Step 1-7 required changes:

```powershell
git add <only-files-changed-for-verification>
git commit -m "Cloud: harden private Pro sync"
```

If no changes were required, do not create an empty commit.

---

## Execution order

Execute Tasks 1-12 serially. Each task consumes stable interfaces from earlier tasks. Do not start UI, emulator rules, or deployment work before the corresponding domain services pass their focused tests. Do not combine commits across task boundaries.

## Completion evidence

The final handoff must include:

- Current branch and commit list.
- Exact verification commands and their exit status/test counts.
- Any checks skipped because a local external prerequisite was unavailable, with the missing prerequisite named precisely.
- Firebase/Vercel variables the user still needs to supply.
- A reminder that no branch was pushed.
