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
  prepare(isCurrent: () => boolean): Promise<PreparedPrivateProSync>;
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
  interface StartAttempt {
    id: number;
    cancelled: boolean;
    promise: Promise<void>;
    engine?: PreparedPrivateProSync;
    stopInitiated?: boolean;
  }

  let generation = 0;
  let attempt: StartAttempt | null = null;
  let prepared: { id: number; value: PreparedPrivateProSync } | null = null;
  let stopCleanup: Promise<void> | null = null;
  let signOutPromise: Promise<void> | null = null;
  let closing = false;
  let decisionInProgress = false;
  let decisionGate: { promise: Promise<void>; resolve: () => void } | null = null;

  function createGate(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    return { promise: new Promise<void>(resolve_ => { resolve = resolve_; }), resolve };
  }

  function stopEngine(value: PreparedPrivateProSync | undefined, owner?: StartAttempt): void {
    if (!value || owner?.stopInitiated) return;
    if (owner) owner.stopInitiated = true;
    let stopped: Promise<void>;
    try { stopped = value.engine.stop(); } catch (error) { stopped = Promise.reject(error); }
    stopped.catch(() => {});
  }

  function beginDeactivate(): Promise<void> {
    if (stopCleanup) return stopCleanup;
    let cleanup: Promise<void>;
    try { cleanup = dependencies.deactivate(dependencies.uid); } catch (error) { cleanup = Promise.reject(error); }
    const sanitized = cleanup.catch(() => { throw new PrivateProLifecycleError(); });
    stopCleanup = sanitized;
    void sanitized.finally(() => { if (stopCleanup === sanitized) stopCleanup = null; }).catch(() => {});
    return sanitized;
  }

  function canOwnStart(owner: StartAttempt): boolean {
    return attempt === owner && owner.id === generation && !owner.cancelled && !closing;
  }

  async function waitForDecision(owner: StartAttempt): Promise<boolean> {
    while (decisionInProgress && canOwnStart(owner)) {
      const gate = decisionGate;
      if (!gate) break;
      await gate.promise;
    }
    return canOwnStart(owner);
  }

  async function runStart(owner: StartAttempt): Promise<void> {
    if (!canOwnStart(owner)) return;
    let next: PreparedPrivateProSync | undefined;
    try {
      next = await dependencies.prepare(() => canOwnStart(owner));
      owner.engine = next;
      if (!await waitForDecision(owner)) {
        stopEngine(next, owner);
        return;
      }
      await next.engine.start();
      if (!await waitForDecision(owner)) {
        stopEngine(next, owner);
        return;
      }
      prepared = { id: owner.id, value: next };
      if (attempt === owner) attempt = null;
      dependencies.statusStore.setState({ phase: 'local', lastCategory: null });
    } catch {
      stopEngine(next, owner);
      if (canOwnStart(owner)) {
        attempt = null;
        dependencies.statusStore.setState({ phase: 'error', lastCategory: 'unknown' });
        try { await beginDeactivate(); } catch {}
      }
    }
  }

  function start(): Promise<void> {
    if (prepared || closing) return Promise.resolve();
    if (decisionInProgress && decisionGate) return decisionGate.promise.then(start);
    if (stopCleanup) {
      const cleanup = stopCleanup;
      return cleanup.then(() => {}, () => {}).then(() => {
        if (stopCleanup === cleanup) stopCleanup = null;
        return start();
      });
    }
    if (attempt) return attempt.promise;
    const owner = { id: ++generation, cancelled: false, promise: Promise.resolve() } satisfies StartAttempt;
    attempt = owner;
    owner.promise = Promise.resolve().then(() => runStart(owner));
    owner.promise.catch(() => {});
    return owner.promise;
  }

  function stop(): Promise<void> {
    generation++;
    const currentAttempt = attempt;
    if (currentAttempt) currentAttempt.cancelled = true;
    attempt = null;
    const current = prepared?.value;
    prepared = null;
    stopEngine(current);
    return beginDeactivate();
  }

  function finishDecision(): void {
    decisionInProgress = false;
    decisionGate?.resolve();
    decisionGate = null;
  }

  return {
    start,

    async retry(): Promise<void> {
      if (closing) return;
      if (decisionInProgress && decisionGate) {
        await decisionGate.promise;
        return this.retry();
      }
      if (stopCleanup) {
        const cleanup = stopCleanup;
        await cleanup.catch(() => {});
        if (stopCleanup === cleanup) stopCleanup = null;
        return this.retry();
      }
      if (!prepared) return start();
      await prepared.value.engine.retryNow();
    },

    async signOut(options = {}): Promise<void> {
      if (signOutPromise) return signOutPromise;
      signOutPromise = (async () => {
        decisionInProgress = true;
        decisionGate = createGate();
        const decisionOwner = prepared?.value ?? null;
        let pending: number | null = null;
        try {
          pending = decisionOwner
            ? (await decisionOwner.engine.flushNow(5_000)).pending
            : await dependencies.pendingCount();
        } catch {
          try { pending = await dependencies.pendingCount(); } catch {}
        }
        if (pending === null && !options.discardPending) {
          finishDecision();
          throw new PrivateProLifecycleError();
        }
        if (pending !== null && pending > 0 && !options.discardPending) {
          finishDecision();
          throw new PrivateProUnsyncedChangesError(pending);
        }

        closing = true;
        generation++;
        const currentAttempt = attempt;
        if (currentAttempt) currentAttempt.cancelled = true;
        attempt = null;
        const current = prepared?.value ?? null;
        prepared = null;
        finishDecision();
        let failure: unknown = null;
        try { current?.coordinator?.broadcastSignedOut?.(); } catch (error) { failure = rememberFailure(failure, error); }
        stopEngine(current ?? undefined);
        stopEngine(currentAttempt?.engine, currentAttempt ?? undefined);
        try { await beginDeactivate(); } catch (error) { failure = rememberFailure(failure, error); }
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
    async prepare(isCurrent) {
      if (previousUid && previousUid !== uid) {
        await deactivatePrivateProAssetPersistence(previousUid);
        await deactivatePrivateProManagedPersistence(previousUid, clearPrivateProManagedRuntimeStores);
      }
      if (!isCurrent()) throw new PrivateProLifecycleError();
      await activatePrivateProManagedPersistence(uid);
      const local = createPrivateProAssetLocalPort(uid, privateProSyncDB);
      const coordinator = createPrivateProSyncCoordinator({ uid, leases: privateProSyncDB });
      const transport = createPrivateProFirebaseSyncTransport(uid);
      const assets = createPrivateProAssetClient(uid, undefined, { wake: () => coordinator.wake() }, local, undefined, {
        port: privateProSyncDB,
        ...ASSET_UPLOAD_LEASE_TIMING,
      });
      if (!isCurrent()) throw new PrivateProLifecycleError();
      await activatePrivateProAssetPersistence(uid, local, (assetId, guard) => assets.delete(assetId, guard));
      if (!isCurrent()) {
        await deactivatePrivateProAssetPersistence(uid);
        throw new PrivateProLifecycleError();
      }
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
