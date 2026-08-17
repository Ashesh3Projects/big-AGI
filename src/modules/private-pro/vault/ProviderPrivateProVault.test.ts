import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  createPrivateProVaultLifecycle,
  privateProVaultPasswordStrength,
  type PrivateProVaultLifecycleDependencies,
  type PrivateProVaultLifecyclePhase,
} from './ProviderPrivateProVault';
import { PrivateProVaultSetup } from '../ui/PrivateProVaultSetup';
import { PrivateProVaultStatus } from '../ui/PrivateProVaultStatus';
import { PrivateProVaultUnlock } from '../ui/PrivateProVaultUnlock';
import {
  rewrapPrivateProVaultPassword,
  unlockPrivateProVaultWithPassword,
  unlockPrivateProVaultWithRecovery,
} from './privatePro.vault.keyset';
import { generateRecoveryKey } from './privatePro.vault.recovery';
import { PRIVATE_PRO_PBKDF2_MIN_ITERATIONS } from './privatePro.vault.schemas';
import type { PrivateProVaultKeyset } from './privatePro.vault.types';
import { realArgon2idWorkerResponse, withVaultPasswordWorker } from '../../../../tools/private-pro/test-helpers/privatePro.vault.password.test-helpers';


interface Harness {
  deps: PrivateProVaultLifecycleDependencies<string, string>;
  phases: PrivateProVaultLifecyclePhase[];
  resolveApply?: () => void;
  runtimePhase(phase: 'ready' | 'reconnecting' | 'migrating' | 'error'): void;
  counts: {
    activate: number;
    bootstrap: number;
    logout: number;
    passwordUnlock: number;
    recoveryUnlock: number;
    remember: number;
    setup: number;
  };
}

function createHarness(options: {
  keyset?: string | null;
  rememberedKey?: string | null;
  online?: boolean;
  passwordError?: Error;
  recoveryError?: Error;
  activationError?: Error;
  deferApply?: boolean;
} = {}): Harness {
  const counts = {
    activate: 0,
    bootstrap: 0,
    logout: 0,
    passwordUnlock: 0,
    recoveryUnlock: 0,
    remember: 0,
    setup: 0,
  };
  const phases: PrivateProVaultLifecyclePhase[] = [];
  let runtimeListener: ((phase: 'ready' | 'reconnecting' | 'migrating' | 'error') => void) | undefined;
  let resolveApply: (() => void) | undefined;

  const deps: PrivateProVaultLifecycleDependencies<string, string> = {
    isOnline: () => options.online ?? true,
    bootstrap: async () => {
      counts.bootstrap++;
      return { keyset: options.keyset === undefined ? 'keyset-1' : options.keyset };
    },
    restoreRemembered: async () => options.rememberedKey === undefined ? null : options.rememberedKey,
    unlockPassword: async (_keyset, _password) => {
      counts.passwordUnlock++;
      if (options.passwordError) throw options.passwordError;
      return 'password-master-key';
    },
    unlockRecovery: async (_keyset, _recoveryKey, _newPassword) => {
      counts.recoveryUnlock++;
      if (options.recoveryError) throw options.recoveryError;
      return { keyset: 'keyset-2', masterKey: 'recovery-master-key' };
    },
    setup: async (_password) => {
      counts.setup++;
      return { keyset: 'keyset-1', masterKey: 'setup-master-key', recoveryKey: 'AAAA-BBBB-CCCC-DDDD' };
    },
    remember: async () => { counts.remember++; },
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
  };

  return {
    deps,
    phases,
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

async function pbkdf2WrappingKey(password: string, salt: Uint8Array<ArrayBuffer>, usage: 'wrapKey' | 'unwrapKey'): Promise<CryptoKey> {
  const passwordKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt,
    iterations: PRIVATE_PRO_PBKDF2_MIN_ITERATIONS,
  }, passwordKey, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

async function keysetFixture(password: string): Promise<{ keyset: PrivateProVaultKeyset; recoveryKey: string }> {
  const masterBytes = new Uint8Array(32).fill(0x42);
  const masterKey = await crypto.subtle.importKey('raw', masterBytes, 'AES-GCM', true, ['wrapKey']);
  const salt = new Uint8Array(new ArrayBuffer(16));
  salt.fill(0x11);
  const recovery = generateRecoveryKey();
  const passwordNonce = new Uint8Array(12).fill(0x22);
  const recoveryNonce = new Uint8Array(12).fill(0x33);
  const recoveryWrapping = await crypto.subtle.importKey('raw', new Uint8Array(recovery.bytes), { name: 'AES-GCM', length: 256 }, false, ['wrapKey']);
  const passwordCiphertext = new Uint8Array(await crypto.subtle.wrapKey(
    'raw', masterKey, await pbkdf2WrappingKey(password, salt, 'wrapKey'), { name: 'AES-GCM', iv: passwordNonce },
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
  test('new users remain blocked in setup until keyset creation and remote apply complete', async () => {
    const harness = createHarness({ keyset: null, deferApply: true });
    const lifecycle = createPrivateProVaultLifecycle(harness.deps);

    await lifecycle.start();
    assert.equal(lifecycle.getState().phase, 'setup');

    const setup = lifecycle.setup('correct horse battery staple');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(lifecycle.getState().phase, 'hydrating');
    assert.equal(lifecycle.getState().recoveryKey, 'AAAA-BBBB-CCCC-DDDD');
    assert.equal(harness.counts.remember, 1);
    harness.resolveApply?.();
    await setup;

    assert.equal(lifecycle.getState().phase, 'setup');
    lifecycle.acknowledgeRecoveryKey();
    assert.equal(lifecycle.getState().phase, 'ready');
    assert.equal(lifecycle.getState().recoveryKey, null);
  });

  test('remembered devices auto-unlock before the application opens', async () => {
    const harness = createHarness({ keyset: 'keyset-1', rememberedKey: 'remembered-master-key' });
    const lifecycle = createPrivateProVaultLifecycle(harness.deps);

    await lifecycle.start();

    assert.equal(lifecycle.getState().phase, 'ready');
    assert.equal(harness.counts.passwordUnlock, 0);
    assert.equal(harness.counts.activate, 1);
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
  });

  test('recovery keys unlock and expose no recovery secret in state', async () => {
    const harness = createHarness({ keyset: 'keyset-1', rememberedKey: null });
    const lifecycle = createPrivateProVaultLifecycle(harness.deps);

    await lifecycle.start();
    await lifecycle.unlockWithRecovery('AAAA-BBBB-CCCC-DDDD', 'new correct horse battery staple');

    assert.equal(lifecycle.getState().phase, 'ready');
    assert.equal(lifecycle.getState().recoveryKey, null);
    assert.equal(harness.counts.recoveryUnlock, 1);
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

  test('logout destroys remembered and in-memory unlock state before returning to auth', async () => {
    const harness = createHarness({ keyset: 'keyset-1', rememberedKey: 'remembered-master-key' });
    const lifecycle = createPrivateProVaultLifecycle(harness.deps);
    await lifecycle.start();

    await lifecycle.logout();

    assert.equal(harness.counts.logout, 1);
    assert.equal(lifecycle.getState().phase, 'locked');
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
  test('setup exposes labelled password confirmation and recovery confirmation controls', () => {
    const passwordMarkup = renderToStaticMarkup(React.createElement(PrivateProVaultSetup, {
      busy: false,
      error: null,
      recoveryKey: null,
      onSetup: async () => {},
      onRecoveryConfirmed: () => {},
    }));
    const recoveryMarkup = renderToStaticMarkup(React.createElement(PrivateProVaultSetup, {
      busy: false,
      error: null,
      recoveryKey: 'AAAA-BBBB-CCCC-DDDD',
      onSetup: async () => {},
      onRecoveryConfirmed: () => {},
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
  test('unlocks persisted PBKDF2 keysets without trying the Argon2 worker', async () => {
    const { keyset } = await keysetFixture('old vault password');

    const masterKey = await unlockPrivateProVaultWithPassword(keyset, 'old vault password');

    assert.equal(masterKey.algorithm.name, 'HKDF');
    assert.equal(masterKey.extractable, false);
  });

  test('password rotation requires the current password and preserves recovery unlock', async () => {
    const { keyset, recoveryKey } = await keysetFixture('old vault password');

    await assert.rejects(rewrapPrivateProVaultPassword(keyset, 'wrong vault password', 'new vault password long'));
    const rotated = await withVaultPasswordWorker(
      realArgon2idWorkerResponse,
      () => rewrapPrivateProVaultPassword(keyset, 'old vault password', 'new vault password long'),
    );

    assert.equal(rotated.keyVersion, 2);
    await assert.rejects(unlockPrivateProVaultWithPassword(rotated, 'old vault password'));
    assert.equal((await withVaultPasswordWorker(
      realArgon2idWorkerResponse,
      () => unlockPrivateProVaultWithPassword(rotated, 'new vault password long'),
    )).algorithm.name, 'HKDF');
    assert.equal((await unlockPrivateProVaultWithRecovery(rotated, recoveryKey)).algorithm.name, 'HKDF');
  });
});
