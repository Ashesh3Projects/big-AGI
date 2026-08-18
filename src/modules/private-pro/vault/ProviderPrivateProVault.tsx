import * as React from 'react';
import type { User } from 'firebase/auth';

import { downloadBlob } from '~/common/util/downloadUtils';
import { apiAsyncNode } from '~/common/util/trpc.client';
import {
  type PrivateProEncryptedBackupCredential,
} from '~/modules/trade/privateProEncryptedBackup';

import { usePrivateProAuth } from '../auth/ProviderPrivatePro';
import { privateProClientConfig } from '../config/privatePro.config';
import { PrivateProVaultSetup } from '../ui/PrivateProVaultSetup';
import { PrivateProVaultStatus } from '../ui/PrivateProVaultStatus';
import { PrivateProVaultUnlock } from '../ui/PrivateProVaultUnlock';
import { PrivateProVaultRecoveryRecommendation } from '../ui/PrivateProVaultRecoveryRecommendation';
import { deriveVaultSubkey, hmacVaultIdentifier } from './privatePro.vault.crypto';
import { privateProVaultDB } from './privatePro.vault.db';
import { createPrivateProVaultEngine, type PrivateProVaultEngine } from './privatePro.vault.engine';
import { createPrivateProVaultBackupStream, importPrivateProVaultBackup, PrivateProVaultBackupCommittedError } from './privatePro.vault.backup';
import {
  createPrivateProRememberedUnlock,
  createPrivateProVaultKeyset,
  restorePrivateProRememberedUnlock,
  rewrapPrivateProVaultPassword,
  rewrapPrivateProVaultPasswordWithRecovery,
  unlockPrivateProVaultCredentialsWithPassword,
  unlockPrivateProVaultCredentialsWithRecovery,
} from './privatePro.vault.keyset';
import { createPrivateProVaultSerializers, privateProVaultSerializers } from './privatePro.vault.serializers';
import { collectPrivateProVaultAssetIds, createPrivateProVaultAssetClient, type PrivateProVaultAssetClient } from './privatePro.vault.assets.client';
import { privateProVaultSession } from './privatePro.vault.session';
import { createPrivateProVaultStore, privateProVaultStore, type PrivateProVaultPhase } from './store-private-pro-vault';
import { createPrivateProVaultTransport } from './privatePro.vault.transport';
import type { PrivateProVaultDeviceMetadata, PrivateProVaultKeyset } from './privatePro.vault.types';
import { clearPrivateProVaultDeviceId, createPrivateProOpaqueId, resolvePrivateProVaultRequestDeviceId } from './privatePro.vault.device';
import { signPrivateProVaultDeviceRegistration } from './privatePro.vault.registration';
import {
  clearPrivateProPlaintextPortablePersistence,
  clearPrivateProVolatilePortableState,
  setPrivateProEncryptedPersistenceActive,
  privateProPortableAssetBeforeUnload,
} from '../persistence/privatePro.persistence';


export type PrivateProVaultPublicPhase = 'setup' | 'locked' | 'hydrating' | 'ready' | 'reconnecting' | 'error';
export type PrivateProVaultLifecyclePhase = PrivateProVaultPublicPhase;

export interface PrivateProVaultPublicState {
  phase: PrivateProVaultPublicPhase;
  busy: boolean;
  error: string | null;
  recoveryKey: string | null;
  revokeOtherDevicesRecommended: boolean;
}

export interface PrivateProVaultLifecycleDependencies<TKeyset, TMasterKey, TEnrollmentKey = unknown> {
  isOnline(): boolean;
  bootstrap(): Promise<{ keyset: TKeyset | null; rememberedDeviceKnown: boolean }>;
  restoreRemembered(keyset: TKeyset): Promise<TMasterKey | null>;
  unlockPassword(keyset: TKeyset, password: string): Promise<{ masterKey: TMasterKey; enrollmentKey: TEnrollmentKey }>;
  unlockRecovery(keyset: TKeyset, recoveryKey: string, newPassword: string): Promise<{ keyset: TKeyset; masterKey: TMasterKey; enrollmentKey: TEnrollmentKey }>;
  commitRecovery(previousKeyset: TKeyset, rotatedKeyset: TKeyset): Promise<'committed' | 'conflict'>;
  setup(password: string): Promise<{ keyset: TKeyset; masterKey: TMasterKey; enrollmentKey: TEnrollmentKey; recoveryKey: string }>;
  commitSetup(keyset: TKeyset, operationId: string): Promise<'committed' | 'conflict'>;
  remember(masterKey: TMasterKey, keyset: TKeyset): Promise<void>;
  register(keyset: TKeyset, enrollmentKey: TEnrollmentKey): Promise<void>;
  activate(masterKey: TMasterKey, keyset: TKeyset): Promise<void>;
  subscribeRuntime(listener: (phase: 'hydrating' | 'ready' | 'reconnecting' | 'error') => void): () => void;
  logout(): Promise<void>;
  onState?(state: PrivateProVaultPublicState): void;
  createOperationId?(): string;
}

export interface PrivateProVaultLifecycle {
  getState(): PrivateProVaultPublicState;
  subscribe(listener: (state: PrivateProVaultPublicState) => void): () => void;
  start(): Promise<void>;
  retry(): Promise<void>;
  setup(password: string): Promise<void>;
  acknowledgeRecoveryKey(): Promise<void>;
  unlockWithPassword(password: string): Promise<void>;
  unlockWithRecovery(recoveryKey: string, newPassword: string): Promise<void>;
  logout(): Promise<void>;
  destroy(): void;
}

export interface PrivateProVaultRuntimeState {
  engine: PrivateProVaultEngine | null;
  keyset: PrivateProVaultKeyset | null;
  masterKey: CryptoKey | null;
  devices: PrivateProVaultDeviceMetadata[];
  assets: PrivateProVaultAssetClient | null;
}

export async function runPrivateProVaultBackupImport(
  engine: Pick<PrivateProVaultEngine, 'stopAndWait' | 'hydrateBeforeOpen' | 'start' | 'whenCurrent'>,
  store: ReturnType<typeof createPrivateProVaultStore>,
  importBackup: () => Promise<unknown>,
): Promise<void> {
  await engine.stopAndWait();
  let committed = false;
  try {
    await importBackup();
    committed = true;
    await engine.hydrateBeforeOpen();
    await engine.start();
    await engine.whenCurrent();
    if (!store.getState().ready) throw new Error('Encrypted backup merge did not reach a verified current state.');
  } catch (error) {
    if (committed || error instanceof PrivateProVaultBackupCommittedError) {
      const message = 'Encrypted backup committed to the cloud, but local hydration failed. Restart to reconcile.';
      store.getState().setState({ phase: 'error', ready: false, lastError: message });
      throw new PrivateProVaultBackupCommittedError(message, { cause: error });
    }
    await engine.hydrateBeforeOpen();
    await engine.start();
    await engine.whenCurrent();
    throw error;
  }
}

export interface PrivateProVaultRuntimeCleanupPort {
  clearSession(uid: string): Promise<void>;
  clearDeviceId(uid: string): void;
  deleteVaultDB?(): Promise<void>;
  signOut(): Promise<void>;
  reload?(): void;
}

async function clearPrivateProVaultRuntime(
  runtime: PrivateProVaultRuntimeState,
  uid: string,
  port: PrivateProVaultRuntimeCleanupPort,
) {
  if (runtime.engine) await runtime.engine.logoutAndClear();
  else {
    await runtime.assets?.clearHydratedAssets();
    await port.clearSession(uid);
  }
  runtime.engine = null;
  runtime.masterKey = null;
  runtime.keyset = null;
  runtime.assets = null;
  runtime.devices = [];
  await clearPrivateProPlaintextPortablePersistence();
  clearPrivateProVolatilePortableState();
  port.clearDeviceId(uid);
}

export async function logoutPrivateProVaultRuntime(
  runtime: PrivateProVaultRuntimeState,
  uid: string,
  port: PrivateProVaultRuntimeCleanupPort,
) {
  await clearPrivateProVaultRuntime(runtime, uid, port);
  await port.signOut();
}

export async function fullWipePrivateProVaultRuntime(
  runtime: PrivateProVaultRuntimeState,
  uid: string,
  port: PrivateProVaultRuntimeCleanupPort,
) {
  await clearPrivateProVaultRuntime(runtime, uid, port);
  await port.deleteVaultDB?.();
  await port.signOut();
  port.reload?.();
}

export interface PrivateProVaultContextValue extends PrivateProVaultPublicState {
  retry(): Promise<void>;
  setup(password: string): Promise<void>;
  acknowledgeRecoveryKey(): Promise<void>;
  unlockWithPassword(password: string): Promise<void>;
  unlockWithRecovery(recoveryKey: string, newPassword: string): Promise<void>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  createEncryptedExport(): Promise<void>;
  importEncryptedBackup(stream: ReadableStream<Uint8Array>, credential: PrivateProEncryptedBackupCredential): Promise<void>;
  revokeOtherDevices(): Promise<void>;
  logout(): Promise<void>;
  fullLocalWipe(): Promise<void>;
}

const INITIAL_STATE: PrivateProVaultPublicState = {
  phase: 'hydrating',
  busy: false,
  error: null,
  recoveryKey: null,
  revokeOtherDevicesRecommended: false,
};

const INVALID_CREDENTIALS = 'Vault password or recovery key is incorrect.';


export function privateProVaultPasswordStrength(password: string): { acceptable: boolean; label: string } {
  if (password.length < 14) return { acceptable: false, label: 'Too short' };
  const categories = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(pattern => pattern.test(password)).length;
  const words = password.trim().split(/\s+/).filter(Boolean).length;
  return { acceptable: true, label: password.length >= 20 || words >= 4 || categories >= 3 ? 'Strong' : 'Acceptable' };
}

function errorForPhase(phase: PrivateProVaultPublicPhase): string {
  if (phase === 'reconnecting') return 'Reconnect to open your encrypted vault.';
  if (phase === 'locked') return INVALID_CREDENTIALS;
  return 'The encrypted vault could not be opened.';
}

export function createPrivateProVaultLifecycle<TKeyset, TMasterKey, TEnrollmentKey>(
  deps: PrivateProVaultLifecycleDependencies<TKeyset, TMasterKey, TEnrollmentKey>,
): PrivateProVaultLifecycle {
  let state = INITIAL_STATE;
  let keyset: TKeyset | null = null;
  let masterKey: TMasterKey | null = null;
  let activationReady = false;
  let pendingSetup: { keyset: TKeyset; masterKey: TMasterKey; enrollmentKey: TEnrollmentKey; recoveryKey: string; operationId: string } | null = null;
  let confirmation: Promise<void> | null = null;
  let destroyed = false;
  let unsubscribeRuntime: (() => void) | undefined;
  const listeners = new Set<(state: PrivateProVaultPublicState) => void>();

  const setState = (patch: Partial<PrivateProVaultPublicState>) => {
    if (destroyed) return;
    state = { ...state, ...patch };
    deps.onState?.(state);
    listeners.forEach(listener => listener(state));
  };

  const bindRuntime = () => {
    unsubscribeRuntime?.();
    unsubscribeRuntime = deps.subscribeRuntime(phase => setState({
      phase,
      busy: false,
      error: phase === 'error' ? errorForPhase('error') : phase === 'reconnecting' ? errorForPhase('reconnecting') : null,
    }));
  };

  const activate = async (nextMasterKey: TMasterKey, nextKeyset: TKeyset) => {
    activationReady = false;
    masterKey = nextMasterKey;
    keyset = nextKeyset;
    setState({ phase: 'hydrating', busy: true, error: null });
    try {
      await deps.activate(nextMasterKey, nextKeyset);
      bindRuntime();
      activationReady = true;
      setState({ phase: 'ready', busy: false, error: null });
    } catch {
      masterKey = null;
      keyset = null;
      setState({ phase: 'error', busy: false, error: errorForPhase('error') });
    }
  };

  const start = async () => {
    if (!deps.isOnline()) {
      setState({ phase: 'reconnecting', busy: false, error: errorForPhase('reconnecting') });
      return;
    }
    setState({ phase: 'hydrating', busy: true, error: null, recoveryKey: null });
    try {
      const bootstrap = await deps.bootstrap();
      keyset = bootstrap.keyset;
      if (!keyset) {
        setState({ phase: 'setup', busy: false, error: null });
        return;
      }
      if (!bootstrap.rememberedDeviceKnown) {
        setState({ phase: 'locked', busy: false, error: null });
        return;
      }
      const remembered = await deps.restoreRemembered(keyset);
      if (!remembered) {
        setState({ phase: 'locked', busy: false, error: null });
        return;
      }
      await activate(remembered, keyset);
    } catch {
      setState({ phase: deps.isOnline() ? 'error' : 'reconnecting', busy: false, error: errorForPhase(deps.isOnline() ? 'error' : 'reconnecting') });
    }
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    retry: start,
    async setup(password) {
      if (!privateProVaultPasswordStrength(password).acceptable) {
        setState({ phase: 'setup', error: 'Use at least 14 characters.' });
        return;
      }
      setState({ phase: 'setup', busy: true, error: null });
      try {
        const created = await deps.setup(password);
        pendingSetup = { ...created, operationId: deps.createOperationId?.() ?? `setup-${crypto.randomUUID()}` };
        setState({ phase: 'setup', busy: false, error: null, recoveryKey: created.recoveryKey });
      } catch {
        setState({ phase: 'setup', busy: false, error: 'The encrypted vault could not be created.' });
      }
    },
    async acknowledgeRecoveryKey() {
      if (confirmation) return confirmation;
      if (!pendingSetup || !state.recoveryKey) return;
      const pending = pendingSetup;
      confirmation = (async () => {
        setState({ phase: 'setup', busy: true, error: null });
        try {
          const result = await deps.commitSetup(pending.keyset, pending.operationId);
          if (result === 'conflict') {
            pendingSetup = null;
            const bootstrap = await deps.bootstrap();
            keyset = bootstrap.keyset;
            masterKey = null;
            setState({ phase: 'locked', busy: false, error: 'This vault already exists. Unlock it to continue.', recoveryKey: null });
            return;
          }
          await deps.remember(pending.masterKey, pending.keyset);
          await deps.register(pending.keyset, pending.enrollmentKey);
          await deps.activate(pending.masterKey, pending.keyset);
          masterKey = pending.masterKey;
          keyset = pending.keyset;
          activationReady = true;
          bindRuntime();
          pendingSetup = null;
          setState({ phase: 'ready', busy: false, error: null, recoveryKey: null });
        } catch {
          setState({ phase: 'setup', busy: false, error: 'The encrypted vault could not be created.', recoveryKey: pending.recoveryKey });
        } finally {
          confirmation = null;
        }
      })();
      return confirmation;
    },
    async unlockWithPassword(password) {
      if (!keyset) return start();
      setState({ phase: 'locked', busy: true, error: null });
      try {
        const unlocked = await deps.unlockPassword(keyset, password);
        await deps.remember(unlocked.masterKey, keyset);
        await deps.register(keyset, unlocked.enrollmentKey);
        await activate(unlocked.masterKey, keyset);
      } catch {
        setState({ phase: 'locked', busy: false, error: INVALID_CREDENTIALS });
      }
    },
    async unlockWithRecovery(recoveryKey, newPassword) {
      if (!keyset) return start();
      if (!privateProVaultPasswordStrength(newPassword).acceptable) {
        setState({ phase: 'locked', busy: false, error: 'Use at least 14 characters for the new password.' });
        return;
      }
      setState({ phase: 'locked', busy: true, error: null });
      try {
        const unlocked = await deps.unlockRecovery(keyset, recoveryKey, newPassword);
        const commit = await deps.commitRecovery(keyset, unlocked.keyset);
        if (commit === 'conflict') throw new Error('Vault keyset changed.');
        keyset = unlocked.keyset;
        await deps.remember(unlocked.masterKey, unlocked.keyset);
        await deps.register(unlocked.keyset, unlocked.enrollmentKey);
        await activate(unlocked.masterKey, unlocked.keyset);
        setState({ revokeOtherDevicesRecommended: true });
      } catch {
        setState({ phase: 'locked', busy: false, error: INVALID_CREDENTIALS });
      }
    },
    async logout() {
      unsubscribeRuntime?.();
      unsubscribeRuntime = undefined;
      masterKey = null;
      keyset = null;
      activationReady = false;
      pendingSetup = null;
      await deps.logout();
      setState({ phase: 'locked', busy: false, error: null, recoveryKey: null });
    },
    destroy() {
      destroyed = true;
      unsubscribeRuntime?.();
      listeners.clear();
      masterKey = null;
      keyset = null;
      pendingSetup = null;
    },
  };
}

function createProductionDependencies(
  user: User,
  signOut: () => Promise<void>,
  runtime: PrivateProVaultRuntimeState,
): PrivateProVaultLifecycleDependencies<PrivateProVaultKeyset, CryptoKey, CryptoKey> {
  let deviceId = '';
  return {
    isOnline: () => typeof navigator === 'undefined' || navigator.onLine,
    async bootstrap() {
      deviceId = await resolvePrivateProVaultRequestDeviceId(user.uid, privateProVaultDB);
      const result = await apiAsyncNode.privateProVault.bootstrap.mutate({ deviceId });
      runtime.devices = [];
      runtime.keyset = result.keyset?.keyset ?? null;
      return {
        keyset: runtime.keyset,
        rememberedDeviceKnown: !!result.device && result.device.revokedAtMs === null && result.device.keyVersion === result.keyset?.keyset.keyVersion,
      };
    },
    async restoreRemembered(keyset) {
      const [deviceKey, wrapped] = await Promise.all([
        privateProVaultDB.getDeviceKey(user.uid),
        privateProVaultDB.wrappedKeys.get(user.uid),
      ]);
      if (!deviceKey || !wrapped) return null;
      try {
        const masterKey = await restorePrivateProRememberedUnlock(deviceKey, wrapped.envelope);
        privateProVaultSession.unlock(user.uid, masterKey);
        runtime.masterKey = masterKey;
        runtime.keyset = keyset;
        return masterKey;
      } catch {
        await privateProVaultDB.deleteDeviceUnlock(user.uid);
        return null;
      }
    },
    unlockPassword: (keyset, password) => unlockPrivateProVaultCredentialsWithPassword(keyset, password, user.uid),
    async unlockRecovery(keyset, recoveryKey, newPassword) {
      const credentials = await unlockPrivateProVaultCredentialsWithRecovery(keyset, recoveryKey, user.uid);
      const rotated = await rewrapPrivateProVaultPasswordWithRecovery(keyset, recoveryKey, newPassword, user.uid);
      return { keyset: rotated, ...credentials };
    },
    async commitRecovery(keyset, rotated) {
      const result = await apiAsyncNode.privateProVault.putKeyset.mutate({
        operationId: `recover-${crypto.randomUUID()}`,
        baseWrappingVersion: keyset.wrappingVersion,
        keyset: rotated,
        securityEvent: { eventId: createPrivateProOpaqueId(), deviceId, type: 'recovery-password-reset' },
      });
      return result.status === 'conflict' ? 'conflict' : 'committed';
    },
    async setup(password) {
      await clearPrivateProPlaintextPortablePersistence();
      const created = await createPrivateProVaultKeyset(password, user.uid);
      runtime.keyset = created.keyset;
      runtime.masterKey = created.masterKey;
      return created;
    },
    async commitSetup(keyset, operationId) {
      const result = await apiAsyncNode.privateProVault.putKeyset.mutate({
        operationId,
        baseWrappingVersion: 0,
        keyset,
      });
      return result.status === 'conflict' ? 'conflict' : 'committed';
    },
    async remember(masterKey, keyset) {
      const remembered = await createPrivateProRememberedUnlock(masterKey);
      await privateProVaultDB.transaction('rw', [privateProVaultDB.deviceKeys, privateProVaultDB.wrappedKeys], async () => {
        await privateProVaultDB.storeDeviceKey(user.uid, remembered.deviceKey, deviceId);
        await privateProVaultDB.wrappedKeys.put({ uid: user.uid, envelope: remembered.envelope });
      });
      privateProVaultSession.unlock(user.uid, masterKey);
      runtime.masterKey = masterKey;
      runtime.keyset = keyset;
    },
    async register(keyset, enrollmentKey) {
      const existing = await apiAsyncNode.privateProVault.bootstrap.mutate({ deviceId });
      if (existing.device && existing.device.revokedAtMs === null && existing.device.keyVersion === keyset.keyVersion) return;
      const operationId = `register-${crypto.randomUUID()}`;
      const challenge = await apiAsyncNode.privateProVault.beginDeviceRegistration.mutate({ deviceId, keyVersion: keyset.keyVersion });
      const signatureBase64 = await signPrivateProVaultDeviceRegistration(enrollmentKey, {
        uid: user.uid, ...challenge,
      });
      await apiAsyncNode.privateProVault.completeDeviceRegistration.mutate({ operationId, ...challenge, signatureBase64 });
    },
    async activate(masterKey, keyset) {
      await runtime.engine?.stopAndWait();
      const identifierKey = await deriveVaultSubkey(masterKey, 'record-identifiers', 'portable-state', ['sign']);
      const assets = createPrivateProVaultAssetClient({ vaultId: user.uid, masterKey, keyVersion: keyset.keyVersion });
      const engine = createPrivateProVaultEngine({
        uid: user.uid,
        keyVersion: keyset.keyVersion,
        masterKey,
        vaultContext: { vaultId: user.uid },
        db: privateProVaultDB,
        serializers: createPrivateProVaultSerializers(identifierKey),
        transport: createPrivateProVaultTransport(),
        store: privateProVaultStore,
        assets: {
          referencedAssetIds: collectPrivateProVaultAssetIds,
          prepareForUpload: (assetIds, signal) => assets.prepareForUpload(assetIds, signal),
          prepareForHydrate: (assetIds, signal) => assets.prepareForHydrate(assetIds, signal),
          clearHydratedAssets: () => assets.clearHydratedAssets(),
        },
      });
      runtime.engine = engine;
      runtime.assets = assets;
      await engine.hydrateBeforeOpen();
      await engine.start();
      const current = privateProVaultStore.getState();
      if (!current.ready) throw new Error('Vault hydration did not reach ready.');
      runtime.devices = await apiAsyncNode.privateProVault.listDevices.query();
    },
    subscribeRuntime(listener) {
      const mapPhase = (phase: PrivateProVaultPhase): 'hydrating' | 'ready' | 'reconnecting' | 'error' => {
        if (phase === 'ready') return 'ready';
        if (phase === 'reconnecting') return 'reconnecting';
        if (phase === 'hydrating') return 'hydrating';
        return 'error';
      };
      return privateProVaultStore.subscribe(state => listener(mapPhase(state.phase)));
    },
    async logout() {
      await logoutPrivateProVaultRuntime(runtime, user.uid, {
        clearSession: uid => privateProVaultSession.logoutAndClear(uid),
        clearDeviceId: clearPrivateProVaultDeviceId,
        signOut,
      });
    },
  };
}

const PrivateProVaultContext = React.createContext<PrivateProVaultContextValue | null>(null);

export function ProviderPrivateProVault(props: { children: React.ReactNode }) {
  if (!privateProClientConfig.enabled) return props.children;
  return <ProviderPrivateProVaultEnabled>{props.children}</ProviderPrivateProVaultEnabled>;
}

function ProviderPrivateProVaultEnabled(props: { children: React.ReactNode }) {
  setPrivateProEncryptedPersistenceActive(true);
  const auth = usePrivateProAuth();
  const [state, setState] = React.useState<PrivateProVaultPublicState>(INITIAL_STATE);
  const [revokeBusy, setRevokeBusy] = React.useState(false);
  const lifecycleRef = React.useRef<PrivateProVaultLifecycle | null>(null);
  const runtimeRef = React.useRef<PrivateProVaultRuntimeState>({ engine: null, keyset: null, masterKey: null, devices: [], assets: null });

  React.useEffect(() => {
    window.addEventListener('beforeunload', privateProPortableAssetBeforeUnload);
    return () => window.removeEventListener('beforeunload', privateProPortableAssetBeforeUnload);
  }, []);

  React.useEffect(() => {
    if (!auth.user) return;
    const lifecycle = createPrivateProVaultLifecycle(createProductionDependencies(auth.user, auth.signOut, runtimeRef.current));
    const runtime = runtimeRef.current;
    lifecycleRef.current = lifecycle;
    const unsubscribe = lifecycle.subscribe(setState);
    setState(lifecycle.getState());
    void lifecycle.start();
    return () => {
      unsubscribe();
      runtime.engine?.stop();
      lifecycle.destroy();
      lifecycleRef.current = null;
    };
  }, [auth.signOut, auth.user]);

  const lifecycle = () => {
    const current = lifecycleRef.current;
    if (!current) throw new Error('Private Pro vault is unavailable.');
    return current;
  };

  const changePassword = React.useCallback(async (currentPassword: string, newPassword: string) => {
    const runtime = runtimeRef.current;
    if (!runtime.masterKey || !runtime.keyset || !privateProVaultPasswordStrength(newPassword).acceptable)
      throw new Error('Use at least 14 characters.');
    const rotated = await rewrapPrivateProVaultPassword(runtime.keyset, currentPassword, newPassword, auth.user!.uid);
    const result = await apiAsyncNode.privateProVault.putKeyset.mutate({
      operationId: `password-${crypto.randomUUID()}`,
      baseWrappingVersion: runtime.keyset.wrappingVersion,
      keyset: rotated,
      securityEvent: {
        eventId: createPrivateProOpaqueId(),
        deviceId: await resolvePrivateProVaultRequestDeviceId(auth.user!.uid, privateProVaultDB),
        type: 'password-changed',
      },
    });
    if (result.status === 'conflict') throw new Error('The vault changed on another device. Reconnect and try again.');
    runtime.keyset = rotated;
    setState(current => ({ ...current, revokeOtherDevicesRecommended: true }));
  }, [auth.user]);

  const createEncryptedExport = React.useCallback(async () => {
    const runtime = runtimeRef.current;
    if (!auth.user || !runtime.masterKey || !runtime.keyset) throw new Error('Unlock the vault first.');
    if (!runtime.assets) throw new Error('Encrypted asset client is unavailable.');
    const response = new Response(await createPrivateProVaultBackupStream({
      uid: auth.user.uid,
      keyset: runtime.keyset,
      masterKey: runtime.masterKey,
      db: privateProVaultDB,
      serializers: privateProVaultSerializers,
      assets: runtime.assets,
      collectAssetIds: collectPrivateProVaultAssetIds,
    }));
    const blob = await response.blob();
    downloadBlob(blob, `Big-AGI-private-pro-encrypted-${new Date().toISOString().slice(0, 10)}.ndjson`);
  }, [auth.user]);

  const importEncryptedBackup = React.useCallback(async (
    stream: ReadableStream<Uint8Array>,
    credential: PrivateProEncryptedBackupCredential,
  ) => {
    const runtime = runtimeRef.current;
    const user = auth.user;
    const assets = runtime.assets;
    const masterKey = runtime.masterKey;
    const keyset = runtime.keyset;
    if (!user || !assets || !masterKey || !keyset || !runtime.engine) throw new Error('Unlock the vault first.');
    const engine = runtime.engine;
    await runPrivateProVaultBackupImport(engine, privateProVaultStore, () => importPrivateProVaultBackup(stream, credential, {
        uid: user.uid,
        db: privateProVaultDB,
        serializers: privateProVaultSerializers,
        activeMasterKey: masterKey,
        activeKeyVersion: keyset.keyVersion,
        activeAssets: assets,
        transport: createPrivateProVaultTransport(),
        createBackupAssetClient: (masterKey, keyVersion, vaultId) => createPrivateProVaultAssetClient({ vaultId, masterKey, keyVersion }),
      }));
  }, [auth.user]);

  const revokeOtherDevices = React.useCallback(async () => {
    if (!auth.user) return;
    const currentId = await resolvePrivateProVaultRequestDeviceId(auth.user.uid, privateProVaultDB);
    const devices = runtimeRef.current.devices.filter(device => device.deviceId !== currentId && device.revokedAtMs === null);
    await Promise.all(devices.map(device => apiAsyncNode.privateProVault.revokeDevice.mutate({
      operationId: `revoke-${crypto.randomUUID()}`,
      deviceId: device.deviceId,
    })));
    runtimeRef.current.devices = runtimeRef.current.devices.map(device => devices.some(revoked => revoked.deviceId === device.deviceId)
      ? { ...device, revokedAtMs: Date.now() }
      : device);
    setState(current => ({ ...current, revokeOtherDevicesRecommended: false }));
  }, [auth.user]);

  const fullLocalWipe = React.useCallback(async () => {
    if (!auth.user) return;
    await fullWipePrivateProVaultRuntime(runtimeRef.current, auth.user.uid, {
      clearSession: uid => privateProVaultSession.logoutAndClear(uid),
      clearDeviceId: clearPrivateProVaultDeviceId,
      deleteVaultDB: () => privateProVaultDB.delete(),
      signOut: auth.signOut,
      reload: () => window.location.reload(),
    });
  }, [auth]);

  const value = React.useMemo<PrivateProVaultContextValue>(() => ({
    ...state,
    retry: () => lifecycle().retry(),
    setup: password => lifecycle().setup(password),
    acknowledgeRecoveryKey: () => lifecycle().acknowledgeRecoveryKey(),
    unlockWithPassword: password => lifecycle().unlockWithPassword(password),
    unlockWithRecovery: (recoveryKey, newPassword) => lifecycle().unlockWithRecovery(recoveryKey, newPassword),
    changePassword,
    createEncryptedExport,
    importEncryptedBackup,
    revokeOtherDevices,
    logout: () => lifecycle().logout(),
    fullLocalWipe,
  }), [changePassword, createEncryptedExport, fullLocalWipe, importEncryptedBackup, revokeOtherDevices, state]);

  if (state.phase === 'setup') return <PrivateProVaultSetup
    busy={state.busy}
    error={state.error}
    recoveryKey={state.recoveryKey}
    onSetup={password => value.setup(password)}
    onRecoveryConfirmed={() => value.acknowledgeRecoveryKey()}
  />;
  if (state.phase === 'locked') return <PrivateProVaultUnlock
    busy={state.busy}
    error={state.error}
    onPassword={password => value.unlockWithPassword(password)}
    onRecovery={(recoveryKey, newPassword) => value.unlockWithRecovery(recoveryKey, newPassword)}
    onLogout={() => value.logout()}
  />;
  if (state.phase !== 'ready') return <PrivateProVaultStatus phase={state.phase} error={state.error} onRetry={() => value.retry()} onLogout={() => value.logout()} />;

  return <PrivateProVaultContext.Provider value={value}>
    {state.revokeOtherDevicesRecommended && <PrivateProVaultRecoveryRecommendation
      busy={revokeBusy}
      onRevoke={async () => {
        setRevokeBusy(true);
        try {
          await value.revokeOtherDevices();
        } finally {
          setRevokeBusy(false);
        }
      }}
    />}
    {props.children}
  </PrivateProVaultContext.Provider>;
}

export function usePrivateProVault(): PrivateProVaultContextValue {
  const value = React.useContext(PrivateProVaultContext);
  if (!value) throw new Error('usePrivateProVault must be used inside ProviderPrivateProVault.');
  return value;
}
