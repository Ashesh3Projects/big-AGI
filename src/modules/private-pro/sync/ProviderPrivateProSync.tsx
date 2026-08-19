import * as React from 'react';
import type { User } from 'firebase/auth';
import { useStore } from 'zustand';

import { activatePrivateProAssetPersistence, createPrivateProAssetLocalPort, deactivatePrivateProAssetPersistence } from '../assets/privatePro.assets.local';
import { createPrivateProAssetClient } from '../assets/privatePro.assets.client';
import { usePrivateProAuth } from '../auth/ProviderPrivatePro';
import { privateProClientConfig } from '../config/privatePro.config';
import { activatePrivateProManagedPersistence, clearPrivateProManagedPersistence, deactivatePrivateProManagedPersistence, privateProManagedPersistenceUid } from '../persistence/privatePro.persistence';
import { createPrivateProSyncCoordinator, type PrivateProSyncCoordinator } from './privatePro.sync.coordinator';
import { privateProSyncDB } from './privatePro.sync.db';
import { createPrivateProSyncEngine, type PrivateProSyncEngine } from './privatePro.sync.engine';
import { createPrivateProFirebaseSyncTransport } from './privatePro.sync.firebase';
import { createPrivateProAssetSerializer, createPrivateProSyncSerializers } from './privatePro.sync.serializers';
import { clearPrivateProManagedRuntimeStores } from './privatePro.sync.runtime';
import { createPrivateProSyncStore, type PrivateProSyncStore } from './store-private-pro-sync';


const ASSET_UPLOAD_LEASE_TIMING = { leaseMs: 15_000, renewEveryMs: 5_000, retryEveryMs: 250 } as const;

export interface PrivateProSyncLifecycleEngine extends Pick<PrivateProSyncEngine, 'start' | 'retryNow' | 'flushNow' | 'pendingCount' | 'stop'> {}

interface PreparedPrivateProSync {
  engine: PrivateProSyncLifecycleEngine;
  coordinator?: Pick<PrivateProSyncCoordinator, 'broadcastSignedOut'>;
}

interface PrivateProSyncLifecycleDependencies {
  uid: string;
  statusStore: PrivateProSyncStore;
  prepare(): Promise<PreparedPrivateProSync>;
  deactivate(uid: string): Promise<void>;
  clear(uid: string): Promise<void>;
  firebaseSignOut(): Promise<void>;
  reload(): void;
  pendingCount(): Promise<number>;
}

export interface PrivateProSyncLifecycle {
  start: () => Promise<void>;
  retry: () => Promise<void>;
  signOut: (options?: { discardPending?: boolean }) => Promise<void>;
  stop: () => Promise<void>;
}

export class PrivateProUnsyncedChangesError extends Error {
  constructor(readonly count: number) {
    super(`${count} Private Pro change${count === 1 ? '' : 's'} could not be synchronized.`);
    this.name = 'PrivateProUnsyncedChangesError';
  }
}

class PrivateProLifecycleError extends Error {
  constructor() {
    super('Private Pro could not complete the requested operation.');
    this.name = 'PrivateProLifecycleError';
  }
}

function rememberFailure(current: unknown, next: unknown): unknown {
  return current ?? next;
}

export function createPrivateProSyncLifecycle(dependencies: PrivateProSyncLifecycleDependencies): PrivateProSyncLifecycle {
  let epoch = 0;
  let prepared: PreparedPrivateProSync | null = null;
  let startPromise: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let signOutPromise: Promise<void> | null = null;

  async function stopPrepared(current: PreparedPrivateProSync | null): Promise<void> {
    if (current) await current.engine.stop();
  }

  async function stop(): Promise<void> {
    if (stopping) return stopping;
    const stopEpoch = ++epoch;
    const current = prepared;
    prepared = null;
    startPromise = null;
    stopping = (async () => {
      let failure: unknown = null;
      try { await stopPrepared(current); } catch (error) { failure = rememberFailure(failure, error); }
      if (epoch === stopEpoch) {
        try { await dependencies.deactivate(dependencies.uid); } catch (error) { failure = rememberFailure(failure, error); }
      }
      if (failure) throw new PrivateProLifecycleError();
    })().finally(() => { stopping = null; });
    return stopping;
  }

  return {
    async start(): Promise<void> {
      if (prepared || startPromise) return startPromise ?? Promise.resolve();
      const startEpoch = ++epoch;
      startPromise = (async () => {
        let next: PreparedPrivateProSync | null = null;
        try {
          next = await dependencies.prepare();
          if (epoch !== startEpoch) return;
          prepared = next;
          await next.engine.start();
          if (epoch === startEpoch) dependencies.statusStore.setState({ phase: 'local', lastCategory: null });
        } catch {
          if (epoch === startEpoch) dependencies.statusStore.setState({ phase: 'error', lastCategory: 'unknown' });
        } finally {
          if (epoch !== startEpoch || dependencies.statusStore.getState().phase === 'error') {
            prepared = null;
            if (next) try { await next.engine.stop(); } catch {}
            try { await dependencies.deactivate(dependencies.uid); } catch {}
          }
        }
      })().finally(() => { if (epoch === startEpoch) startPromise = null; });
      return startPromise;
    },

    async retry(): Promise<void> {
      if (!prepared) return this.start();
      await prepared.engine.retryNow();
    },

    async signOut(options = {}): Promise<void> {
      if (signOutPromise) return signOutPromise;
      signOutPromise = (async () => {
      const current = prepared;
      let pending: number;
      try {
        pending = current
          ? (await current.engine.flushNow(5_000)).pending
          : await dependencies.pendingCount();
      } catch {
        pending = await dependencies.pendingCount();
      }
      if (pending > 0 && !options.discardPending) throw new PrivateProUnsyncedChangesError(pending);

      ++epoch;
      prepared = null;
      startPromise = null;
      current?.coordinator?.broadcastSignedOut?.();
      let failure: unknown = null;
      try { await stopPrepared(current); } catch (error) { failure = rememberFailure(failure, error); }
      try { await dependencies.deactivate(dependencies.uid); } catch (error) { failure = rememberFailure(failure, error); }
      try { await dependencies.clear(dependencies.uid); } catch (error) { failure = rememberFailure(failure, error); }
      try { await dependencies.firebaseSignOut(); } catch (error) { failure = rememberFailure(failure, error); }
      try { dependencies.reload(); } catch (error) { failure = rememberFailure(failure, error); }
      if (failure) throw new PrivateProLifecycleError();
      })().finally(() => { signOutPromise = null; });
      return signOutPromise;
    },

    stop,
  };
}

interface PrivateProSyncContextValue {
  phase: ReturnType<PrivateProSyncStore['getState']>['phase'];
  pending: number;
  retry: () => Promise<void>;
  signOut: (options?: { discardPending?: boolean }) => Promise<void>;
}

const PrivateProSyncContext = React.createContext<PrivateProSyncContextValue | null>(null);

export function ProviderPrivateProSync(props: { children: React.ReactNode }) {
  if (!privateProClientConfig.enabled) return props.children;
  return <ProviderPrivateProSyncEnabled>{props.children}</ProviderPrivateProSyncEnabled>;
}

function ProviderPrivateProSyncEnabled(props: { children: React.ReactNode }) {
  const auth = usePrivateProAuth();
  if (!auth.user || !auth.bootstrap) return props.children;
  return <ProductionPrivateProSyncAccount
    user={auth.user}
    firebaseSignOut={auth.firebaseSignOut}
    previousUid={privateProManagedPersistenceUid()}
  >{props.children}</ProductionPrivateProSyncAccount>;
}

function ProductionPrivateProSyncAccount(props: { user: User; firebaseSignOut: () => Promise<void>; previousUid: string | null; children: React.ReactNode }) {
  const statusStore = React.useMemo(createPrivateProSyncStore, [props.user.uid]);
  const lifecycle = React.useMemo(
    () => createProductionLifecycle(props.user.uid, props.previousUid, props.firebaseSignOut, statusStore),
    [props.firebaseSignOut, props.previousUid, props.user.uid, statusStore],
  );
  return <ProviderPrivateProSyncAccount uid={props.user.uid} statusStore={statusStore} lifecycle={lifecycle}>{props.children}</ProviderPrivateProSyncAccount>;
}

export function ProviderPrivateProSyncAccount(props: {
  uid: string;
  statusStore: PrivateProSyncStore;
  lifecycle: PrivateProSyncLifecycle;
  children?: React.ReactNode;
}) {
  const phase = useStore(props.statusStore, state => state.phase);
  const pending = useStore(props.statusStore, state => state.pending);
  const retry = React.useCallback(() => props.lifecycle.retry(), [props.lifecycle]);
  const signOut = React.useCallback((options?: { discardPending?: boolean }) => props.lifecycle.signOut(options), [props.lifecycle]);
  React.useEffect(() => {
    void props.lifecycle.start();
    return () => { void props.lifecycle.stop().catch(() => {}); };
  }, [props.lifecycle, props.uid]);
  const value = React.useMemo<PrivateProSyncContextValue>(() => ({
    phase,
    pending,
    retry,
    signOut,
  }), [pending, phase, retry, signOut]);
  return <PrivateProSyncContext.Provider value={value}>{props.children}</PrivateProSyncContext.Provider>;
}

function createProductionLifecycle(uid: string, previousUid: string | null, firebaseSignOut: () => Promise<void>, statusStore: PrivateProSyncStore): PrivateProSyncLifecycle {
  return createPrivateProSyncLifecycle({
    uid,
    statusStore,
    async prepare() {
      if (previousUid && previousUid !== uid) {
        await deactivatePrivateProAssetPersistence(previousUid);
        await deactivatePrivateProManagedPersistence(previousUid, clearPrivateProManagedRuntimeStores);
      }
      await activatePrivateProManagedPersistence(uid);
      const local = createPrivateProAssetLocalPort(uid, privateProSyncDB);
      const coordinator = createPrivateProSyncCoordinator({ uid, leases: privateProSyncDB });
      const transport = createPrivateProFirebaseSyncTransport(uid);
      const assets = createPrivateProAssetClient(uid, undefined, { wake: () => coordinator.wake() }, local, undefined, {
        port: privateProSyncDB,
        ...ASSET_UPLOAD_LEASE_TIMING,
      });
      await activatePrivateProAssetPersistence(uid, local, (assetId, guard) => assets.delete(assetId, guard));
      const assetSerializer = createPrivateProAssetSerializer(uid, local, category => {
        statusStore.setState({ phase: category === 'offline' ? 'offline' : 'error', lastCategory: category });
      });
      const engine = createPrivateProSyncEngine({
        uid,
        writerId: crypto.randomUUID(),
        serializers: createPrivateProSyncSerializers([assetSerializer]),
        db: privateProSyncDB,
        coordinator,
        transport,
        assets,
        runSuppressed: callback => callback(),
        statusStore,
      });
      return { engine, coordinator };
    },
    deactivate: async () => {
      if (await deactivatePrivateProAssetPersistence(uid)) await deactivatePrivateProManagedPersistence(uid, clearPrivateProManagedRuntimeStores);
    },
    clear: uidToClear => clearPrivateProManagedPersistence(uidToClear, privateProSyncDB, clearPrivateProManagedRuntimeStores),
    firebaseSignOut,
    reload: () => window.location.reload(),
    pendingCount: () => privateProSyncDB.pendingCount(uid),
  });
}

export function usePrivateProSync(): PrivateProSyncContextValue {
  const value = React.useContext(PrivateProSyncContext);
  if (!value) throw new Error('usePrivateProSync must be used inside ProviderPrivateProSync.');
  return value;
}
