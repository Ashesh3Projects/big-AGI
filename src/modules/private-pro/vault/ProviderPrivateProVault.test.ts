import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  createPrivateProVaultLifecycle,
  fullWipePrivateProVaultRuntime,
  logoutPrivateProVaultRuntime,
  ProviderPrivateProVault,
  privateProVaultPasswordStrength,
  type PrivateProVaultLifecycleDependencies,
  type PrivateProVaultLifecyclePhase,
} from './ProviderPrivateProVault';
import { PrivateProVaultSetup } from '../ui/PrivateProVaultSetup';
import { PrivateProVaultStatus } from '../ui/PrivateProVaultStatus';
import { PrivateProVaultUnlock } from '../ui/PrivateProVaultUnlock';
import {
  rewrapPrivateProVaultPassword,
  rewrapPrivateProVaultPasswordWithRecovery,
  unlockPrivateProVaultWithPassword,
  unlockPrivateProVaultWithRecovery,
} from './privatePro.vault.keyset';
import { generateRecoveryKey } from './privatePro.vault.recovery';
import { PRIVATE_PRO_PBKDF2_MIN_ITERATIONS } from './privatePro.vault.schemas';
import type { PrivateProVaultEnrollmentAuthority, PrivateProVaultKeyset } from './privatePro.vault.types';
import { createPrivateProVaultEnrollmentAuthority } from './privatePro.vault.registration';
import { realArgon2idWorkerResponse, withVaultPasswordWorker } from '../../../../tools/private-pro/test-helpers/privatePro.vault.password.test-helpers';
import { privateProClientConfig } from '../config/privatePro.config';
import { getPrivateProVaultDeviceId, resolvePrivateProVaultRequestDeviceId } from './privatePro.vault.device';


interface Harness {
  deps: PrivateProVaultLifecycleDependencies<string, string, string>;
  phases: PrivateProVaultLifecyclePhase[];
  operationIds: string[];
  registrationKeys: string[];
  resolveApply?: () => void;
  runtimePhase(phase: 'ready' | 'reconnecting' | 'migrating' | 'error'): void;
  counts: {
    activate: number;
    bootstrap: number;
    logout: number;
    passwordUnlock: number;
    recoveryUnlock: number;
    commitRecovery: number;
    commitSetup: number;
    remember: number;
    register: number;
    setup: number;
  };
}

function createHarness(options: {
  keyset?: string | null;
  rememberedKey?: string | null;
  rememberedDeviceKnown?: boolean;
  online?: boolean;
  passwordError?: Error;
  recoveryError?: Error;
  activationError?: Error;
  commitError?: Error;
  deferApply?: boolean;
} = {}): Harness {
  const counts = {
    activate: 0,
    bootstrap: 0,
    logout: 0,
    passwordUnlock: 0,
    recoveryUnlock: 0,
    commitRecovery: 0,
    commitSetup: 0,
    remember: 0,
    register: 0,
    setup: 0,
  };
  const phases: PrivateProVaultLifecyclePhase[] = [];
  const operationIds: string[] = [];
  const registrationKeys: string[] = [];
  let runtimeListener: ((phase: 'ready' | 'reconnecting' | 'migrating' | 'error') => void) | undefined;
  let resolveApply: (() => void) | undefined;

  const deps: PrivateProVaultLifecycleDependencies<string, string, string> = {
    isOnline: () => options.online ?? true,
    bootstrap: async () => {
      counts.bootstrap++;
      return {
        keyset: options.keyset === undefined ? 'keyset-1' : options.keyset,
        rememberedDeviceKnown: options.rememberedDeviceKnown ?? true,
      };
    },
    restoreRemembered: async () => options.rememberedKey === undefined ? null : options.rememberedKey,
    unlockPassword: async (_keyset, _password) => {
      counts.passwordUnlock++;
      if (options.passwordError) throw options.passwordError;
      return { masterKey: 'password-master-key', enrollmentKey: 'password-enrollment-key' };
    },
    unlockRecovery: async (_keyset, _recoveryKey, _newPassword) => {
      counts.recoveryUnlock++;
      if (options.recoveryError) throw options.recoveryError;
      return { keyset: 'keyset-2', masterKey: 'recovery-master-key', enrollmentKey: 'recovery-enrollment-key' };
    },
    commitRecovery: async () => { counts.commitRecovery++; return 'committed'; },
    setup: async (_password) => {
      counts.setup++;
      return { keyset: 'keyset-1', masterKey: 'setup-master-key', enrollmentKey: 'setup-enrollment-key', recoveryKey: 'AAAA-BBBB-CCCC-DDDD' };
    },
    commitSetup: async (_keyset, operationId) => {
      counts.commitSetup++;
      operationIds.push(operationId);
      if (options.commitError) throw options.commitError;
      return 'committed';
    },
    remember: async () => { counts.remember++; },
    register: async (_keyset, enrollmentKey) => { counts.register++; registrationKeys.push(enrollmentKey); },
    activate: async () => {
      counts.activate++;
      if (options.activationError) throw options.activationError;
      if (options.deferApply) await new Promise<void>(resolve => { resolveApply = resolve; });
    },
    subscribeRuntime: listener => {
      runtimeListener = listener;
      return () => { runtimeListener = undefined; };
    },
    logout: async () => { counts.logout++; },
    onState: state => phases.push(state.phase),
    createOperationId: () => 'setup-operation-1',
  };

  return {
    deps,
    phases,
    operationIds,
    registrationKeys,
    counts,
    get resolveApply() { return resolveApply; },
    runtimePhase: phase => runtimeListener?.(phase),
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function pbkdf2WrappingKey(password: string, salt: Uint8Array<ArrayBuffer>, usages: KeyUsage[]): Promise<CryptoKey> {
  const passwordKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt,
    iterations: PRIVATE_PRO_PBKDF2_MIN_ITERATIONS,
  }, passwordKey, { name: 'AES-GCM', length: 256 }, false, usages);
}

async function keysetFixture(password: string): Promise<{ keyset: PrivateProVaultKeyset; recoveryKey: string }> {
  const masterBytes = new Uint8Array(32).fill(0x42);
  const masterKey = await crypto.subtle.importKey('raw', masterBytes, 'AES-GCM', true, ['wrapKey']);
  const salt = new Uint8Array(new ArrayBuffer(16));
  salt.fill(0x11);
  const recovery = generateRecoveryKey();
  const passwordNonce = new Uint8Array(12).fill(0x22);
  const recoveryNonce = new Uint8Array(12).fill(0x33);
  const recoveryWrapping = await crypto.subtle.importKey('raw', new Uint8Array(recovery.bytes), { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
  const passwordWrapping = await pbkdf2WrappingKey(password, salt, ['wrapKey', 'unwrapKey']);
  const enrollmentAuthority = (await createPrivateProVaultEnrollmentAuthority(passwordWrapping, recoveryWrapping, 'uid-test', 1)).authority;
  const passwordCiphertext = new Uint8Array(await crypto.subtle.wrapKey(
    'raw', masterKey, passwordWrapping, { name: 'AES-GCM', iv: passwordNonce },
  ));
  const recoveryCiphertext = new Uint8Array(await crypto.subtle.wrapKey(
    'raw', masterKey, recoveryWrapping, { name: 'AES-GCM', iv: recoveryNonce },
  ));
  recovery.bytes.fill(0);
  masterBytes.fill(0);
  return {
    recoveryKey: recovery.display,
    keyset: {
      formatVersion: 1,
      keyVersion: 1,
      wrappingVersion: 1,
      enrollmentAuthority,
      passwordEnvelope: {
        formatVersion: 1,
        keyVersion: 1,
        kdf: { algorithm: 'pbkdf2-sha256', saltBase64: bytesToBase64(salt), iterations: PRIVATE_PRO_PBKDF2_MIN_ITERATIONS },
        nonceBase64: bytesToBase64(passwordNonce),
        ciphertextBase64: bytesToBase64(passwordCiphertext),
        ciphertextBytes: passwordCiphertext.byteLength,
      },
      recoveryEnvelope: {
        formatVersion: 1,
        keyVersion: 1,
        recoveryVersion: 1,
        nonceBase64: bytesToBase64(recoveryNonce),
        ciphertextBase64: bytesToBase64(recoveryCiphertext),
        ciphertextBytes: recoveryCiphertext.byteLength,
      },
    },
  };
}


describe('private Pro vault lifecycle', () => {
  test('normal logout clears tracked hydrated assets before sign-out when no engine is active', async () => {
    const order: string[] = [];
    const runtime = {
      engine: null,
      keyset: null,
      masterKey: null,
      devices: [],
      assets: { async clearHydratedAssets() { order.push('assets'); } },
    } as never;

    await logoutPrivateProVaultRuntime(runtime, 'uid-test', {
      async clearSession() { order.push('session'); },
      clearDeviceId() { order.push('device'); },
      async signOut() { order.push('signout'); },
    });

    assert.deepEqual(order, ['assets', 'session', 'device', 'signout']);
  });

  test('logout joins an active migration before clearing session and signing out', async () => {
    const order: string[] = [];
    const runtime = {
      engine: null, keyset: null, masterKey: null, devices: [], assets: null,
      migration: { async stopAndWait() { order.push('migration'); } },
    } as never;
    await logoutPrivateProVaultRuntime(runtime, 'uid-test', {
      async clearSession() { order.push('session'); },
      clearDeviceId() { order.push('device'); },
      async signOut() { order.push('signout'); },
    });
    assert.deepEqual(order, ['migration', 'session', 'device', 'signout']);
  });

  test('full wipe routes through engine logout before deleting the vault database and reloading', async () => {
    const order: string[] = [];
    const runtime = {
      engine: { async logoutAndClear() { order.push('engine'); } },
      keyset: null,
      masterKey: null,
      devices: [],
      assets: null,
    } as never;

    await fullWipePrivateProVaultRuntime(runtime, 'uid-test', {
      async clearSession() { order.push('session'); },
      clearDeviceId() { order.push('device'); },
      async deleteVaultDB() { order.push('db'); },
      async signOut() { order.push('signout'); },
      reload() { order.push('reload'); },
    });

    assert.deepEqual(order, ['engine', 'device', 'db', 'signout', 'reload']);
  });

  test('full wipe joins an active migration before deleting the vault database', async () => {
    const order: string[] = [];
    const runtime = {
      engine: null, keyset: null, masterKey: null, devices: [], assets: null,
      migration: { async stopAndWait() { order.push('migration'); } },
    } as never;
    await fullWipePrivateProVaultRuntime(runtime, 'uid-test', {
      async clearSession() { order.push('session'); },
      clearDeviceId() { order.push('device'); },
      async deleteVaultDB() { order.push('db'); },
      async signOut() { order.push('signout'); },
    });
    assert.deepEqual(order, ['migration', 'session', 'device', 'db', 'signout']);
  });

  test('new users remain blocked in setup until keyset creation and remote apply complete', async () => {
    const harness = createHarness({ keyset: null, deferApply: true });
    const lifecycle = createPrivateProVaultLifecycle(harness.deps);

    await lifecycle.start();
    assert.equal(lifecycle.getState().phase, 'setup');

    await lifecycle.setup('correct horse battery staple');
    assert.equal(lifecycle.getState().phase, 'setup');
    assert.equal(lifecycle.getState().recoveryKey, 'AAAA-BBBB-CCCC-DDDD');
    assert.equal(harness.counts.commitSetup, 0);
    assert.equal(harness.counts.remember, 0);
    assert.equal(harness.counts.register, 0);
    assert.equal(harness.counts.activate, 0);
    const setup = lifecycle.acknowledgeRecoveryKey();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(lifecycle.getState().phase, 'setup');
    assert.equal(lifecycle.getState().busy, true);
    harness.resolveApply?.();
    await setup;

    assert.equal(lifecycle.getState().phase, 'ready');
    assert.equal(lifecycle.getState().recoveryKey, null);
    assert.deepEqual(harness.registrationKeys, ['setup-enrollment-key']);
  });

  test('failed setup confirmation preserves the recovery key and retry succeeds', async () => {
    const failing = createHarness({ keyset: null, commitError: new Error('remote failure') });
    const failingLifecycle = createPrivateProVaultLifecycle(failing.deps);
    await failingLifecycle.start();
    await failingLifecycle.setup('correct horse battery staple');
    await failingLifecycle.acknowledgeRecoveryKey();
    assert.deepEqual(failingLifecycle.getState(), {
      phase: 'setup',
      busy: false,
      error: 'The encrypted vault could not be created.',
      recoveryKey: 'AAAA-BBBB-CCCC-DDDD',
    });

    failing.deps.commitSetup = async () => { failing.counts.commitSetup++; return 'committed'; };
    await failingLifecycle.acknowledgeRecoveryKey();
    assert.equal(failingLifecycle.getState().phase, 'ready');
    assert.equal(failingLifecycle.getState().recoveryKey, null);
    assert.deepEqual(failing.operationIds, ['setup-operation-1']);
  });

  test('failed activation preserves the recovery key and retries the same setup commit', async () => {
    const harness = createHarness({ keyset: null, activationError: new Error('apply failure') });
    const lifecycle = createPrivateProVaultLifecycle(harness.deps);
    await lifecycle.start();
    await lifecycle.setup('correct horse battery staple');

    await lifecycle.acknowledgeRecoveryKey();
    assert.equal(lifecycle.getState().recoveryKey, 'AAAA-BBBB-CCCC-DDDD');
    harness.deps.activate = async () => { harness.counts.activate++; };
    await lifecycle.acknowledgeRecoveryKey();

    assert.equal(lifecycle.getState().phase, 'ready');
    assert.deepEqual(harness.operationIds, ['setup-operation-1', 'setup-operation-1']);
  });

  test('remembered devices auto-unlock before the application opens', async () => {
    const harness = createHarness({ keyset: 'keyset-1', rememberedKey: 'remembered-master-key' });
    const lifecycle = createPrivateProVaultLifecycle(harness.deps);

    await lifecycle.start();

    assert.equal(lifecycle.getState().phase, 'ready');
    assert.equal(harness.counts.passwordUnlock, 0);
    assert.equal(harness.counts.activate, 1);
    assert.equal(harness.counts.register, 0);
    assert.deepEqual(harness.registrationKeys, []);
  });

  test('remembered unlock stays locked when bootstrap does not recognize the durable device ID', async () => {
    const harness = createHarness({ keyset: 'keyset-1', rememberedKey: 'remembered-master-key', rememberedDeviceKnown: false });
    const lifecycle = createPrivateProVaultLifecycle(harness.deps);

    await lifecycle.start();

    assert.equal(lifecycle.getState().phase, 'locked');
    assert.equal(harness.counts.activate, 0);
    assert.equal(harness.counts.register, 0);
  });

  test('new devices unlock with the password and remember the device', async () => {
    const harness = createHarness({ keyset: 'keyset-1', rememberedKey: null });
    const lifecycle = createPrivateProVaultLifecycle(harness.deps);

    await lifecycle.start();
    assert.equal(lifecycle.getState().phase, 'locked');
    await lifecycle.unlockWithPassword('vault password');

    assert.equal(lifecycle.getState().phase, 'ready');
    assert.equal(harness.counts.passwordUnlock, 1);
    assert.equal(harness.counts.remember, 1);
    assert.equal(harness.counts.register, 1);
    assert.deepEqual(harness.registrationKeys, ['password-enrollment-key']);
  });

  test('recovery keys unlock and expose no recovery secret in state', async () => {
    const harness = createHarness({ keyset: 'keyset-1', rememberedKey: null });
    const lifecycle = createPrivateProVaultLifecycle(harness.deps);

    await lifecycle.start();
    await lifecycle.unlockWithRecovery('AAAA-BBBB-CCCC-DDDD', 'new correct horse battery staple');

    assert.equal(lifecycle.getState().phase, 'ready');
    assert.equal(lifecycle.getState().recoveryKey, null);
    assert.equal(harness.counts.recoveryUnlock, 1);
    assert.equal(harness.counts.register, 1);
    assert.equal(harness.counts.commitRecovery, 1);
    assert.deepEqual(harness.registrationKeys, ['recovery-enrollment-key']);
  });

  test('wrong passwords stay locked and return one secret-free failure', async () => {
    const secret = 'raw upstream password failure: vault password';
    const harness = createHarness({ keyset: 'keyset-1', rememberedKey: null, passwordError: new Error(secret) });
    const lifecycle = createPrivateProVaultLifecycle(harness.deps);

    await lifecycle.start();
    await lifecycle.unlockWithPassword('vault password');

    assert.equal(lifecycle.getState().phase, 'locked');
    assert.equal(lifecycle.getState().error, 'Vault password or recovery key is incorrect.');
    assert.equal(JSON.stringify(lifecycle.getState()).includes(secret), false);
  });

  test('offline startup blocks before keyset or local state is opened', async () => {
    const harness = createHarness({ online: false, keyset: 'keyset-1', rememberedKey: 'remembered-master-key' });
    const lifecycle = createPrivateProVaultLifecycle(harness.deps);

    await lifecycle.start();

    assert.equal(lifecycle.getState().phase, 'reconnecting');
    assert.equal(harness.counts.bootstrap, 0);
    assert.equal(harness.counts.activate, 0);
  });

  test('remote revision regression blocks startup without exposing the engine error', async () => {
    const secret = 'rollback record credential-service:opaque-id';
    const harness = createHarness({
      keyset: 'keyset-1',
      rememberedKey: 'remembered-master-key',
      activationError: new Error(secret),
    });
    const lifecycle = createPrivateProVaultLifecycle(harness.deps);

    await lifecycle.start();

    assert.equal(lifecycle.getState().phase, 'error');
    assert.equal(lifecycle.getState().error, 'The encrypted vault could not be opened.');
    assert.equal(JSON.stringify(lifecycle.getState()).includes(secret), false);
  });

  test('ready is emitted only after remote records are applied', async () => {
    const harness = createHarness({ keyset: 'keyset-1', rememberedKey: 'remembered-master-key', deferApply: true });
    const lifecycle = createPrivateProVaultLifecycle(harness.deps);

    const start = lifecycle.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(lifecycle.getState().phase, 'hydrating');
    assert.equal(harness.phases.includes('ready'), false);
    harness.resolveApply?.();
    await start;

    assert.equal(lifecycle.getState().phase, 'ready');
  });

  test('runtime reconnect and migration phases block an already-open application', async () => {
    const harness = createHarness({ keyset: 'keyset-1', rememberedKey: 'remembered-master-key' });
    const lifecycle = createPrivateProVaultLifecycle(harness.deps);
    await lifecycle.start();

    harness.runtimePhase('reconnecting');
    assert.equal(lifecycle.getState().phase, 'reconnecting');
    harness.runtimePhase('migrating');
    assert.equal(lifecycle.getState().phase, 'migrating');
    harness.runtimePhase('ready');
    assert.equal(lifecycle.getState().phase, 'ready');
  });

  test('retry resumes an unlocked migration without returning to password unlock', async () => {
    const harness = createHarness({ keyset: 'keyset-1', rememberedKey: 'remembered-master-key' });
    let first = true;
    harness.deps.activate = async () => {
      harness.counts.activate++;
      if (first) {
        first = false;
        throw new Error('migration needs export confirmation');
      }
    };
    const lifecycle = createPrivateProVaultLifecycle(harness.deps);

    await lifecycle.start();
    assert.equal(lifecycle.getState().phase, 'error');
    await lifecycle.retry();

    assert.equal(lifecycle.getState().phase, 'ready');
    assert.equal(harness.counts.bootstrap, 1);
    assert.equal(harness.counts.activate, 2);
  });

  test('logout destroys remembered and in-memory unlock state before returning to auth', async () => {
    const harness = createHarness({ keyset: 'keyset-1', rememberedKey: 'remembered-master-key' });
    const lifecycle = createPrivateProVaultLifecycle(harness.deps);
    await lifecycle.start();

    await lifecycle.logout();

    assert.equal(harness.counts.logout, 1);
    assert.equal(lifecycle.getState().phase, 'locked');
  });

  test('destroy joins a deferred bootstrap and prevents remembered unlock or activation', async () => {
    const harness = createHarness({ keyset: 'keyset-1', rememberedKey: 'remembered-master-key' });
    let releaseBootstrap = () => {};
    harness.deps.bootstrap = async () => {
      harness.counts.bootstrap++;
      await new Promise<void>(resolve => { releaseBootstrap = resolve; });
      return { keyset: 'keyset-1', rememberedDeviceKnown: true };
    };
    const lifecycle = createPrivateProVaultLifecycle(harness.deps);
    const start = lifecycle.start();
    await new Promise(resolve => setTimeout(resolve, 0));

    const stopped = lifecycle.stopAndWait();
    releaseBootstrap();
    await stopped;
    await start;

    assert.equal(harness.counts.activate, 0);
    assert.equal(lifecycle.getState().phase, 'hydrating');
  });

  test('destroy joins a deferred password unlock and prevents remember, register, and activation', async () => {
    const harness = createHarness({ keyset: 'keyset-1', rememberedKey: null });
    const lifecycle = createPrivateProVaultLifecycle(harness.deps);
    await lifecycle.start();
    let releaseUnlock = () => {};
    harness.deps.unlockPassword = async () => {
      harness.counts.passwordUnlock++;
      await new Promise<void>(resolve => { releaseUnlock = resolve; });
      return { masterKey: 'late-master-key', enrollmentKey: 'late-enrollment-key' };
    };
    const unlock = lifecycle.unlockWithPassword('correct horse battery staple');
    await new Promise(resolve => setTimeout(resolve, 0));

    const stopped = lifecycle.stopAndWait();
    releaseUnlock();
    await stopped;
    await unlock;

    assert.equal(harness.counts.remember, 0);
    assert.equal(harness.counts.register, 0);
    assert.equal(harness.counts.activate, 0);
  });

  test('a second start invalidates the previous UID bootstrap before activation or state publication', async () => {
    const harness = createHarness({ keyset: 'keyset-1', rememberedKey: 'remembered-master-key' });
    let releaseFirst = () => {};
    let bootstrapCall = 0;
    harness.deps.bootstrap = async () => {
      harness.counts.bootstrap++;
      bootstrapCall++;
      if (bootstrapCall === 1) await new Promise<void>(resolve => { releaseFirst = resolve; });
      return { keyset: 'keyset-1', rememberedDeviceKnown: true };
    };
    const lifecycle = createPrivateProVaultLifecycle(harness.deps);
    const first = lifecycle.start();
    await new Promise(resolve => setTimeout(resolve, 0));

    await lifecycle.start();
    releaseFirst();
    await first;

    assert.equal(harness.counts.activate, 1);
    assert.equal(lifecycle.getState().phase, 'ready');
  });

  test('password strength enforces the local minimum while accepting long passphrases', () => {
    assert.deepEqual(privateProVaultPasswordStrength('short'), {
      acceptable: false,
      label: 'Too short',
    });
    assert.deepEqual(privateProVaultPasswordStrength('correct horse battery staple'), {
      acceptable: true,
      label: 'Strong',
    });
  });
});


describe('private Pro vault accessibility', () => {
  test('disabled private Pro renders the open application without vault context', () => {
    const enabled = privateProClientConfig.enabled;
    Object.defineProperty(privateProClientConfig, 'enabled', { configurable: true, value: false });
    try {
      const markup = renderToStaticMarkup(React.createElement(ProviderPrivateProVault, null, React.createElement('main', null, 'Open build')));
      assert.match(markup, /<main>Open build<\/main>/);
      assert.doesNotMatch(markup, /Opening encrypted vault/);
    } finally {
      Object.defineProperty(privateProClientConfig, 'enabled', { configurable: true, value: enabled });
    }
  });
  test('setup exposes labelled password confirmation and recovery confirmation controls', () => {
    const passwordMarkup = renderToStaticMarkup(React.createElement(PrivateProVaultSetup, {
      busy: false,
      error: null,
      recoveryKey: null,
      onSetup: async () => {},
      onRecoveryConfirmed: async () => {},
    }));
    const recoveryMarkup = renderToStaticMarkup(React.createElement(PrivateProVaultSetup, {
      busy: false,
      error: null,
      recoveryKey: 'AAAA-BBBB-CCCC-DDDD',
      onSetup: async () => {},
      onRecoveryConfirmed: async () => {},
    }));

    assert.match(passwordMarkup, /<label[^>]*>Vault password<\/label>/);
    assert.match(passwordMarkup, /<label[^>]*>Confirm password<\/label>/);
    assert.match(passwordMarkup, /type="password"/);
    assert.match(recoveryMarkup, /<label[^>]*>Recovery key groups<\/label>/);
    assert.match(recoveryMarkup, /Save recovery key/);
  });

  test('unlock provides password and recovery tabs without ever rendering a stored recovery key', () => {
    const markup = renderToStaticMarkup(React.createElement(PrivateProVaultUnlock, {
      busy: false,
      error: null,
      onPassword: async () => {},
      onRecovery: async () => {},
      onLogout: async () => {},
    }));

    assert.match(markup, /Vault password/);
    assert.match(markup, /Recovery key/);
    assert.match(markup, /Sign out/);
    assert.doesNotMatch(markup, /AAAA-BBBB-CCCC-DDDD/);
  });

  test('blocking status uses an announced region and a keyboard-operable retry button', () => {
    const markup = renderToStaticMarkup(React.createElement(PrivateProVaultStatus, {
      phase: 'reconnecting',
      error: null,
      onRetry: async () => {},
      onLogout: async () => {},
    }));

    assert.match(markup, /role="status"/);
    assert.match(markup, /Reconnect/);
    assert.match(markup, /<button/);
  });
});


describe('private Pro vault keyset lifecycle', () => {
  test('persists one opaque device ID per authenticated UID without exposing a device key', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };

    const first = await getPrivateProVaultDeviceId('uid-a', storage);
    assert.equal(await getPrivateProVaultDeviceId('uid-a', storage), first);
    assert.notEqual(await getPrivateProVaultDeviceId('uid-b', storage), first);
    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    assert.equal([...values.values()].some(value => value.includes('CryptoKey')), false);
  });

  test('uses the durable remembered-device ID after localStorage is cleared', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const rememberedId = 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr';
    const db = { getDeviceUnlock: async () => ({ key: {} as CryptoKey, deviceId: rememberedId }) };
    values.clear();

    assert.equal(await resolvePrivateProVaultRequestDeviceId('uid-a', db, storage), rememberedId);
    assert.equal(values.size, 0);
  });

  test('generates a proposed ID only when no remembered device key exists', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const proposed = await resolvePrivateProVaultRequestDeviceId('uid-a', { getDeviceUnlock: async () => null }, storage);

    assert.match(proposed, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(values.size, 1);
  });

  test('does not fall back to localStorage when a remembered key lacks a valid device identity', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };

    await assert.rejects(
      resolvePrivateProVaultRequestDeviceId('uid-a', { getDeviceUnlock: async () => ({ deviceId: '' }) }, storage),
      /identity is invalid/i,
    );
    assert.equal(values.size, 0);
  });

  test('unlocks persisted PBKDF2 keysets without trying the Argon2 worker', async () => {
    const { keyset } = await keysetFixture('old vault password');

    const masterKey = await unlockPrivateProVaultWithPassword(keyset, 'old vault password');

    assert.equal(masterKey.algorithm.name, 'HKDF');
    assert.equal(masterKey.extractable, false);
  });

  test('password rotation requires the current password and preserves recovery unlock', async () => {
    const { keyset, recoveryKey } = await keysetFixture('old vault password');

    await assert.rejects(rewrapPrivateProVaultPassword(keyset, 'wrong vault password', 'new vault password long', 'uid-test'));
    const rotated = await withVaultPasswordWorker(
      realArgon2idWorkerResponse,
      () => rewrapPrivateProVaultPassword(keyset, 'old vault password', 'new vault password long', 'uid-test'),
    );

    assert.equal(rotated.keyVersion, 1);
    assert.equal(rotated.wrappingVersion, 2);
    assert.equal(rotated.passwordEnvelope.keyVersion, 1);
    assert.equal(rotated.recoveryEnvelope.keyVersion, 1);
    await assert.rejects(unlockPrivateProVaultWithPassword(rotated, 'old vault password'));
    assert.equal((await withVaultPasswordWorker(
      realArgon2idWorkerResponse,
      () => unlockPrivateProVaultWithPassword(rotated, 'new vault password long'),
    )).algorithm.name, 'HKDF');
    assert.equal((await unlockPrivateProVaultWithRecovery(rotated, recoveryKey)).algorithm.name, 'HKDF');
  });

  test('recovery password reset preserves both recovery envelopes', async () => {
    const { keyset, recoveryKey } = await keysetFixture('old vault password');

    const rotated = await withVaultPasswordWorker(
      realArgon2idWorkerResponse,
      () => rewrapPrivateProVaultPasswordWithRecovery(keyset, recoveryKey, 'new vault password long', 'uid-test'),
    );

    assert.equal(rotated.keyVersion, 1);
    assert.equal(rotated.wrappingVersion, 2);
    assert.deepEqual(rotated.recoveryEnvelope, keyset.recoveryEnvelope);
    assert.deepEqual(rotated.enrollmentAuthority.recoveryEnvelope, keyset.enrollmentAuthority.recoveryEnvelope);
    assert.notDeepEqual(rotated.passwordEnvelope, keyset.passwordEnvelope);
    assert.notDeepEqual(rotated.enrollmentAuthority.passwordEnvelope, keyset.enrollmentAuthority.passwordEnvelope);
  });
});
