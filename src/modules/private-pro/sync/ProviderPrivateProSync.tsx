import * as React from 'react';
import type { User } from 'firebase/auth';
import { useStore } from 'zustand';

import { activatePrivateProAssetPersistence, createPrivateProAssetLocalPort, deactivatePrivateProAssetPersistence } from '../assets/privatePro.assets.local';
import { createPrivateProAssetClient } from '../assets/privatePro.assets.client';
import { usePrivateProAuth } from '../auth/ProviderPrivatePro';
import { privateProClientConfig } from '../config/privatePro.config';
import { activatePrivateProManagedPersistence, clearPrivateProManagedPersistence, deactivatePrivateProManagedPersistence, privateProManagedPersistenceOwnership, releasePrivateProManagedPersistence, type PrivateProPersistenceOwner } from '../persistence/privatePro.persistence';
import { createPrivateProSyncCoordinator, type PrivateProSyncCoordinator } from './privatePro.sync.coordinator';
import { privateProSyncDB } from './privatePro.sync.db';
import { createPrivateProSyncEngine, type PrivateProSyncEngine } from './privatePro.sync.engine';
import { createPrivateProFirebaseSyncTransport } from './privatePro.sync.firebase';
import { createPrivateProAssetSerializer, createPrivateProSyncSerializers } from './privatePro.sync.serializers';
import { clearPrivateProManagedRuntimeStores } from './privatePro.sync.runtime';
import { createPrivateProWorkspaceV1ProductionCutoverPort, runPrivateProWorkspaceV1LocalCutover } from './privatePro.sync.cutover';
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
  prepare(isCurrent: () => boolean, owner: PrivateProPersistenceOwner): Promise<PreparedPrivateProSync>;
  release?(uid: string, owner: PrivateProPersistenceOwner): Promise<void>;
  /** @deprecated Use release for non-destructive owner cleanup. */
  deactivate?(uid: string, owner: PrivateProPersistenceOwner): Promise<void>;
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

interface PrivateProPersistencePrepareDependencies<T> {
  uid: string;
  owner: PrivateProPersistenceOwner;
  previousOwnership: { uid: string; owner: PrivateProPersistenceOwner } | null;
  isCurrent(): boolean;
  runLocalCutover?(): Promise<void>;
  waitForPreviousOwner?(owner: PrivateProPersistenceOwner): Promise<void>;
  activateManaged(uid: string, owner: PrivateProPersistenceOwner): Promise<void>;
  deactivateManaged(uid: string, owner: PrivateProPersistenceOwner): Promise<unknown>;
  deactivateAssets(uid: string, owner: PrivateProPersistenceOwner): Promise<unknown>;
  releaseManaged?(uid: string, owner: PrivateProPersistenceOwner): Promise<unknown>;
  clearPrevious?(uid: string, owner: PrivateProPersistenceOwner): Promise<unknown>;
  prepareAssets(): Promise<T>;
}

const privateProLifecycleOwnerStops = new Map<PrivateProPersistenceOwner, () => Promise<void>>();

export async function waitForPrivateProSyncLifecycleOwner(owner: PrivateProPersistenceOwner): Promise<void> {
  await privateProLifecycleOwnerStops.get(owner)?.().catch(() => {});
}

function assertPrivateProPrepareCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) throw new PrivateProLifecycleError();
}

export async function preparePrivateProPersistenceOwner<T>(
  dependencies: PrivateProPersistencePrepareDependencies<T>,
): Promise<T> {
  const { uid, owner, previousOwnership } = dependencies;
  const isCurrent = () => dependencies.isCurrent();
  let managedActivated = false;
  let assetsActivated = false;
  try {
    if (dependencies.runLocalCutover) {
      assertPrivateProPrepareCurrent(isCurrent);
      await dependencies.runLocalCutover();
      assertPrivateProPrepareCurrent(isCurrent);
    }
    if (previousOwnership) {
      assertPrivateProPrepareCurrent(isCurrent);
      await dependencies.waitForPreviousOwner?.(previousOwnership.owner);
      assertPrivateProPrepareCurrent(isCurrent);
    }
    if (previousOwnership && previousOwnership.uid !== uid) {
      assertPrivateProPrepareCurrent(isCurrent);
      await dependencies.deactivateAssets(previousOwnership.uid, previousOwnership.owner);
      assertPrivateProPrepareCurrent(isCurrent);
      await (dependencies.clearPrevious ?? dependencies.deactivateManaged)(previousOwnership.uid, previousOwnership.owner);
      assertPrivateProPrepareCurrent(isCurrent);
    }
    assertPrivateProPrepareCurrent(isCurrent);
    await dependencies.activateManaged(uid, owner);
    managedActivated = true;
    assertPrivateProPrepareCurrent(isCurrent);
    assetsActivated = true;
    const prepared = await dependencies.prepareAssets();
    assertPrivateProPrepareCurrent(isCurrent);
    return prepared;
  } catch (error) {
    if (assetsActivated) {
      try { await dependencies.deactivateAssets(uid, owner); } catch {}
    }
    if (managedActivated) {
      try { await (dependencies.releaseManaged ?? dependencies.deactivateManaged)(uid, owner); } catch {}
    }
    throw error;
  }
}

export function createPrivateProSyncLifecycle(dependencies: PrivateProSyncLifecycleDependencies): PrivateProSyncLifecycle {
  interface StartAttempt {
    id: number;
    owner: PrivateProPersistenceOwner;
    cancelled: boolean;
    promise: Promise<void>;
    engine?: PreparedPrivateProSync;
    prepareStarted?: boolean;
    stopInitiated?: boolean;
    stopPromise?: Promise<void>;
    stopCallback?: () => Promise<void>;
  }

  let generation = 0;
  let attempt: StartAttempt | null = null;
  let prepared: { attempt: StartAttempt; value: PreparedPrivateProSync } | null = null;
  let latestPrepared: { attempt: StartAttempt; value: PreparedPrivateProSync } | null = null;
  let stopCleanup: Promise<void> | null = null;
  const ownerCleanups = new Map<PrivateProPersistenceOwner, Promise<void>>();
  let latestAttempt: StartAttempt | null = null;
  let signOutPromise: Promise<void> | null = null;
  let closing = false;
  let decisionInProgress = false;
  let decisionGate: { promise: Promise<void>; resolve: () => void } | null = null;
  const releaseOwner = (uid: string, owner: PrivateProPersistenceOwner) => {
    if (dependencies.release) return dependencies.release(uid, owner);
    if (dependencies.deactivate) return dependencies.deactivate(uid, owner);
    return Promise.reject(new TypeError('Private Pro lifecycle release dependency is required.'));
  };

  function createGate(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    return { promise: new Promise<void>(resolve_ => { resolve = resolve_; }), resolve };
  }

  function stopEngine(value: PreparedPrivateProSync | undefined, owner: StartAttempt): Promise<void> {
    if (!value) return Promise.resolve();
    if (owner.stopPromise) return owner.stopPromise;
    owner.stopInitiated = true;
    let stopped: Promise<void>;
    try { stopped = value.engine.stop(); } catch (error) { stopped = Promise.reject(error); }
    stopped.catch(() => {});
    owner.stopPromise = stopped;
    return stopped;
  }

  function beginRelease(owner: StartAttempt | null, value?: PreparedPrivateProSync): Promise<void> {
    if (!owner) return Promise.resolve();
    const existing = ownerCleanups.get(owner.owner);
    if (existing) return existing;
    const cleanup = (async () => {
      let failure: unknown = null;
      try { await stopEngine(value, owner); } catch (error) { failure = rememberFailure(failure, error); }
      try { await releaseOwner(dependencies.uid, owner.owner); } catch (error) { failure = rememberFailure(failure, error); }
      if (failure) throw new PrivateProLifecycleError();
    })();
    const sanitized = cleanup.catch(error => { throw error instanceof PrivateProLifecycleError ? error : new PrivateProLifecycleError(); });
    ownerCleanups.set(owner.owner, sanitized);
    stopCleanup = sanitized;
    void sanitized.finally(() => {
      if (stopCleanup === sanitized) stopCleanup = null;
      if (privateProLifecycleOwnerStops.get(owner.owner) === owner.stopCallback) privateProLifecycleOwnerStops.delete(owner.owner);
    }).catch(() => {});
    return sanitized;
  }

  function stopOwner(owner: StartAttempt): Promise<void> {
    if (attempt === owner || prepared?.attempt === owner) {
      generation++;
      owner.cancelled = true;
    }
    if (attempt === owner) attempt = null;
    const value = prepared?.attempt === owner ? prepared.value : owner.engine;
    if (prepared?.attempt === owner) prepared = null;
    return beginRelease(owner, value);
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
      owner.prepareStarted = true;
      next = await dependencies.prepare(() => canOwnStart(owner), owner.owner);
      owner.engine = next;
      if (canOwnStart(owner)) latestPrepared = { attempt: owner, value: next };
      if (!await waitForDecision(owner)) {
        await stopEngine(next, owner).catch(() => {});
        return;
      }
      await next.engine.start();
      if (!await waitForDecision(owner)) {
        await stopEngine(next, owner).catch(() => {});
        return;
      }
      prepared = { attempt: owner, value: next };
      if (attempt === owner) attempt = null;
      dependencies.statusStore.setState({ phase: 'local', lastCategory: null });
    } catch {
      if (canOwnStart(owner)) {
        attempt = null;
        dependencies.statusStore.setState({ phase: 'error', lastCategory: 'unknown' });
        try { await beginRelease(owner, next); } catch {}
      } else {
        await stopEngine(next, owner).catch(() => {});
      }
    }
  }

  async function runQueuedStart(owner: StartAttempt): Promise<void> {
    while (canOwnStart(owner)) {
      if (decisionInProgress && decisionGate) {
        await decisionGate.promise;
        continue;
      }
      const cleanup = stopCleanup;
      if (cleanup) {
        await cleanup.catch(() => {});
        continue;
      }
      break;
    }
    if (canOwnStart(owner)) await runStart(owner);
  }

  function start(): Promise<void> {
    if (prepared || closing) return Promise.resolve();
    if (attempt) return attempt.promise;
    const owner: StartAttempt = {
      id: ++generation,
      owner: Symbol('private-pro-sync-owner'),
      cancelled: false,
      promise: Promise.resolve(),
    };
    attempt = owner;
    latestAttempt = owner;
    owner.stopCallback = () => stopOwner(owner);
    privateProLifecycleOwnerStops.set(owner.owner, owner.stopCallback);
    owner.promise = Promise.resolve().then(() => runQueuedStart(owner));
    owner.promise.catch(() => {});
    return owner.promise;
  }

  function stop(): Promise<void> {
    const existingCleanup = stopCleanup;
    generation++;
    const currentAttempt = attempt;
    if (currentAttempt) currentAttempt.cancelled = true;
    attempt = null;
    const currentPrepared = prepared;
    prepared = null;
    const owner = currentAttempt ?? currentPrepared?.attempt ?? latestAttempt;
    if (existingCleanup && !currentPrepared && currentAttempt && !currentAttempt.prepareStarted) return existingCleanup;
    return owner ? stopOwner(owner) : Promise.resolve();
  }

  function finishDecision(): void {
    decisionInProgress = false;
    decisionGate?.resolve();
    decisionGate = null;
  }

  return {
    start,

    retry(): Promise<void> {
      if (closing) return Promise.resolve();
      if (!prepared) return start();
      const current = prepared;
      return (async () => {
        if (decisionInProgress && decisionGate) await decisionGate.promise;
        if (closing || prepared !== current) return;
        await current.value.engine.retryNow();
      })();
    },

    async signOut(options = {}): Promise<void> {
      if (signOutPromise) return signOutPromise;
      signOutPromise = (async () => {
        decisionInProgress = true;
        decisionGate = createGate();
        const decisionPrepared = prepared;
        const decisionAttempt = attempt;
        const decisionOwner = decisionPrepared?.value ?? null;
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
        const currentAttempt = attempt ?? decisionAttempt;
        if (currentAttempt) currentAttempt.cancelled = true;
        attempt = null;
        const currentPrepared = prepared ?? decisionPrepared ?? latestPrepared;
        const current = currentPrepared?.value ?? currentAttempt?.engine ?? null;
        const newestPreparingOwner = latestAttempt?.prepareStarted
          && (!currentPrepared || latestAttempt.id > currentPrepared.attempt.id)
          ? latestAttempt
          : null;
        const currentOwner = newestPreparingOwner ?? currentPrepared?.attempt ?? currentAttempt ?? latestAttempt;
        prepared = null;
        latestPrepared = null;
        finishDecision();
        let failure: unknown = null;
        try { current?.coordinator?.broadcastSignedOut?.(); } catch (error) { failure = rememberFailure(failure, error); }
        const cleanups = new Set<Promise<void>>();
        if (currentPrepared) cleanups.add(beginRelease(currentPrepared.attempt, currentPrepared.value));
        if (currentAttempt) cleanups.add(beginRelease(currentAttempt, currentAttempt.engine));
        if (currentOwner) cleanups.add(beginRelease(currentOwner, currentOwner.engine));
        for (const cleanup of cleanups) {
          try { await cleanup; } catch (error) { failure = rememberFailure(failure, error); }
        }
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
    previousOwnership={privateProManagedPersistenceOwnership()}
  >{props.children}</ProductionPrivateProSyncAccount>;
}

function ProductionPrivateProSyncAccount(props: {
  user: User;
  firebaseSignOut: () => Promise<void>;
  previousOwnership: { uid: string; owner: PrivateProPersistenceOwner } | null;
  children: React.ReactNode;
}) {
  const statusStore = React.useMemo(createPrivateProSyncStore, [props.user.uid]);
  const previousOwner = props.previousOwnership?.owner ?? null;
  const previousUid = props.previousOwnership?.uid ?? null;
  const lifecycle = React.useMemo(
    () => createProductionLifecycle(
      props.user.uid,
      previousOwner && previousUid ? { uid: previousUid, owner: previousOwner } : null,
      props.firebaseSignOut,
      statusStore,
    ),
    [previousOwner, previousUid, props.firebaseSignOut, props.user.uid, statusStore],
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

function createProductionLifecycle(
  uid: string,
  previousOwnership: { uid: string; owner: PrivateProPersistenceOwner } | null,
  firebaseSignOut: () => Promise<void>,
  statusStore: PrivateProSyncStore,
): PrivateProSyncLifecycle {
  return createPrivateProSyncLifecycle({
    uid,
    statusStore,
    async prepare(isCurrent, owner) {
      return preparePrivateProPersistenceOwner({
        uid,
        owner,
        previousOwnership,
        isCurrent,
        runLocalCutover: async () => runPrivateProWorkspaceV1LocalCutover(await createPrivateProWorkspaceV1ProductionCutoverPort()),
        waitForPreviousOwner: waitForPrivateProSyncLifecycleOwner,
        activateManaged: activatePrivateProManagedPersistence,
        deactivateManaged: (uidToDeactivate, ownerToDeactivate) =>
          deactivatePrivateProManagedPersistence(uidToDeactivate, ownerToDeactivate, clearPrivateProManagedRuntimeStores),
        releaseManaged: releasePrivateProManagedPersistence,
        clearPrevious: uidToClear => clearPrivateProManagedPersistence(uidToClear, privateProSyncDB, clearPrivateProManagedRuntimeStores),
        deactivateAssets: deactivatePrivateProAssetPersistence,
        async prepareAssets() {
          const local = createPrivateProAssetLocalPort(uid, privateProSyncDB);
          const coordinator = createPrivateProSyncCoordinator({ uid, leases: privateProSyncDB });
          const transport = createPrivateProFirebaseSyncTransport(uid);
          const assets = createPrivateProAssetClient(uid, undefined, { wake: () => coordinator.wake() }, local, undefined, {
            port: privateProSyncDB,
            ...ASSET_UPLOAD_LEASE_TIMING,
          });
          assertPrivateProPrepareCurrent(isCurrent);
          await activatePrivateProAssetPersistence(uid, owner, local, (assetId, guard) => assets.delete(assetId, guard));
          assertPrivateProPrepareCurrent(isCurrent);
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
      });
    },
    release: async (_uid, owner) => {
      await deactivatePrivateProAssetPersistence(uid, owner);
      await releasePrivateProManagedPersistence(uid, owner);
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
