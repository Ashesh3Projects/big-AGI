import * as React from 'react';
import type { User } from 'firebase/auth';
import { Alert, Button, CircularProgress, Sheet, Stack, Typography } from '@mui/joy';
import { useStore } from 'zustand';

import { activatePrivateProAssetPersistence, createPrivateProAssetLocalPort, deactivatePrivateProAssetPersistence } from '../assets/privatePro.assets.local';
import { createPrivateProAssetClient } from '../assets/privatePro.assets.client';
import { usePrivateProAuth } from '../auth/ProviderPrivatePro';
import { privateProClientConfig } from '../config/privatePro.config';
import { activatePrivateProManagedPersistence, clearPrivateProManagedPersistence, deactivatePrivateProManagedPersistence, privateProManagedPersistenceOwnership, releasePrivateProManagedPersistence, type PrivateProPersistenceOwner } from '../persistence/privatePro.persistence';
import { createPrivateProSyncCoordinator, type PrivateProSyncCoordinator } from './privatePro.sync.coordinator';
import { privateProRecordKey } from './privatePro.sync.codec';
import { privateProSyncDB } from './privatePro.sync.db';
import { createPrivateProSyncEngine, type PrivateProSyncEngine, type PrivateProSyncStartupMutation } from './privatePro.sync.engine';
import { createPrivateProFirebaseSyncTransport } from './privatePro.sync.firebase';
import { createPrivateProAssetSerializer, createPrivateProSyncSerializers } from './privatePro.sync.serializers';
import type { PrivateProSyncLocalMutation, PrivateProSyncSerializer } from './privatePro.sync.serializers';
import { clearPrivateProManagedRuntimeStores } from './privatePro.sync.runtime';
import { createPrivateProWorkspaceV1ProductionCutoverPort, runPrivateProWorkspaceV1LocalCutover } from './privatePro.sync.cutover';
import { createPrivateProSyncStore, type PrivateProSyncStore } from './store-private-pro-sync';


const ASSET_UPLOAD_LEASE_TIMING = { leaseMs: 15_000, renewEveryMs: 5_000, retryEveryMs: 250 } as const;
const usePrivateProLayoutEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;

function privateProStartupMutationKey(mutation: PrivateProSyncLocalMutation): string {
  const identity = mutation.kind === 'put' ? mutation.record : mutation;
  return `${identity.recordType}:${identity.logicalId}`;
}

export function createPrivateProStartupMutationBuffer(
  serializers: readonly PrivateProSyncSerializer<unknown>[],
  durableGeneration: (mutation: PrivateProSyncLocalMutation) => Promise<number> = async () => 0,
): {
  active(): boolean;
  start(): void;
  closeAndTake(): readonly PrivateProSyncStartupMutation[];
  noteLiveMutation(mutation: PrivateProSyncLocalMutation): number;
  currentVersion(key: string): number;
  restore(entry: PrivateProSyncStartupMutation): boolean;
  stop(): void;
} {
  const mutations = new Map<string, PrivateProSyncStartupMutation>();
  const versions = new Map<string, number>();
  let active = false;
  const unsubscribers: Array<() => void> = [];
  const nextVersion = (key: string) => {
    const version = (versions.get(key) ?? 0) + 1;
    versions.set(key, version);
    return version;
  };
  const subscribe = () => {
    if (active) return;
    active = true;
    unsubscribers.push(...serializers.map(serializer => serializer.subscribe(mutation => {
      if (!active) return;
      const key = privateProStartupMutationKey(mutation);
      mutations.delete(key);
      mutations.set(key, {
        key,
        version: nextVersion(key),
        mutation: structuredClone(mutation),
        baselineGeneration: durableGeneration(mutation),
      });
    })));
  };
  return {
    active: () => active,
    start: subscribe,
    closeAndTake: () => {
      active = false;
      unsubscribers.splice(0).forEach(unsubscribe => unsubscribe());
      const frozen = [...mutations.values()].map(entry => ({
        ...entry,
        mutation: structuredClone(entry.mutation),
      }));
      mutations.clear();
      return frozen;
    },
    noteLiveMutation: mutation => nextVersion(privateProStartupMutationKey(mutation)),
    currentVersion: key => versions.get(key) ?? 0,
    restore: entry => {
      if ((versions.get(entry.key) ?? 0) !== entry.version) return false;
      mutations.set(entry.key, { ...entry, mutation: structuredClone(entry.mutation) });
      subscribe();
      return true;
    },
    stop: () => {
      active = false;
      unsubscribers.splice(0).forEach(unsubscribe => unsubscribe());
    },
  };
}

async function privateProStartupDurableGeneration(uid: string, mutation: PrivateProSyncLocalMutation): Promise<number> {
  const identity = mutation.kind === 'put' ? mutation.record : mutation;
  const recordKey = privateProRecordKey(identity.recordType, identity.logicalId);
  const [local, pending] = await Promise.all([
    privateProSyncDB.getLocalRecord(uid, recordKey),
    privateProSyncDB.getOutbox(uid, recordKey),
  ]);
  return Math.max(local?.generation ?? 0, pending?.generation ?? 0);
}

export async function preparePrivateProCrossUidTransition(dependencies: {
  uid: string;
  previousOwnership: { uid: string; owner: PrivateProPersistenceOwner };
  isCurrent(): boolean;
  waitForPreviousOwner?(owner: PrivateProPersistenceOwner): Promise<void>;
  deactivateAssets(uid: string, owner: PrivateProPersistenceOwner): Promise<unknown>;
  clearPrevious(uid: string, owner: PrivateProPersistenceOwner): Promise<unknown>;
  beforeObserve(): void;
}): Promise<void> {
  const { uid, previousOwnership } = dependencies;
  if (previousOwnership.uid === uid) return;
  const isCurrent = () => dependencies.isCurrent();
  assertPrivateProPrepareCurrent(isCurrent);
  await dependencies.waitForPreviousOwner?.(previousOwnership.owner);
  assertPrivateProPrepareCurrent(isCurrent);
  await dependencies.deactivateAssets(previousOwnership.uid, previousOwnership.owner);
  assertPrivateProPrepareCurrent(isCurrent);
  await dependencies.clearPrevious(previousOwnership.uid, previousOwnership.owner);
  assertPrivateProPrepareCurrent(isCurrent);
  dependencies.beforeObserve();
}

export function createPrivateProBufferedSyncLifecycle(
  lifecycle: PrivateProSyncLifecycle,
  startupBuffer: ReturnType<typeof createPrivateProStartupMutationBuffer>,
): PrivateProSyncLifecycle {
  return {
    start() {
      startupBuffer.start();
      return lifecycle.start();
    },
    retry: lifecycle.retry,
    signOut: lifecycle.signOut,
    async stop() {
      startupBuffer.stop();
      await lifecycle.stop();
    },
  };
}

export interface PrivateProSyncLifecycleEngine extends Pick<PrivateProSyncEngine, 'start' | 'retryNow' | 'flushNow' | 'pendingCount' | 'stop'> {}

interface PreparedPrivateProSync {
  engine: PrivateProSyncLifecycleEngine;
  coordinator?: Pick<PrivateProSyncCoordinator, 'broadcastSignedOut'>;
  resumeStartupCapture?(): void;
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
  beforeObserve?(): void;
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
    if (!previousOwnership) {
      dependencies.beforeObserve?.();
    } else if (previousOwnership.uid === uid) {
      dependencies.beforeObserve?.();
      assertPrivateProPrepareCurrent(isCurrent);
      await dependencies.waitForPreviousOwner?.(previousOwnership.owner);
      assertPrivateProPrepareCurrent(isCurrent);
    } else {
      assertPrivateProPrepareCurrent(isCurrent);
      await dependencies.waitForPreviousOwner?.(previousOwnership.owner);
      assertPrivateProPrepareCurrent(isCurrent);
      await dependencies.deactivateAssets(previousOwnership.uid, previousOwnership.owner);
      assertPrivateProPrepareCurrent(isCurrent);
      await (dependencies.clearPrevious ?? dependencies.deactivateManaged)(previousOwnership.uid, previousOwnership.owner);
      assertPrivateProPrepareCurrent(isCurrent);
      dependencies.beforeObserve?.();
    }
    if (dependencies.runLocalCutover) {
      assertPrivateProPrepareCurrent(isCurrent);
      await dependencies.runLocalCutover();
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
      if (canOwnStart(owner)) next?.resumeStartupCapture?.();
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

export function privateProRequiresCrossUidTransition(
  uid: string,
  previousOwnership: { uid: string; owner: PrivateProPersistenceOwner } | null,
): boolean {
  return !!previousOwnership && previousOwnership.uid !== uid;
}

function ProductionPrivateProSyncAccount(props: {
  user: User;
  firebaseSignOut: () => Promise<void>;
  previousOwnership: { uid: string; owner: PrivateProPersistenceOwner } | null;
  children: React.ReactNode;
}) {
  if (privateProRequiresCrossUidTransition(props.user.uid, props.previousOwnership)) {
    return <CrossUidPrivateProSyncAccount
      user={props.user}
      firebaseSignOut={props.firebaseSignOut}
      previousOwnership={props.previousOwnership!}
    >{props.children}</CrossUidPrivateProSyncAccount>;
  }
  return <ReadyPrivateProSyncAccount {...props} />;
}

export async function runPrivateProTransitionSignOut(
  firebaseSignOut: () => Promise<void>,
  reload: () => void,
): Promise<boolean> {
  let succeeded = true;
  try {
    await firebaseSignOut();
  } catch {
    succeeded = false;
  } finally {
    try { reload(); } catch { succeeded = false; }
  }
  return succeeded;
}

export function PrivateProWorkspaceTransitionScreen(props: {
  failed: boolean;
  busy: boolean;
  actionError: boolean;
  onRetry: () => void;
  onSignOut: () => void;
}) {
  return <Sheet sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2 }}>
    <Stack spacing={2} alignItems='center' textAlign='center'>
      <Typography level='h2'>Private Pro</Typography>
      {props.failed ? <>
        <Alert color='danger'>Unable to prepare your private workspace.</Alert>
        {props.actionError && <Alert color='danger'>Unable to complete sign-out.</Alert>}
        <Stack direction='row' spacing={1}>
          <Button disabled={props.busy} onClick={props.onRetry}>Retry</Button>
          <Button variant='plain' color='neutral' loading={props.busy} onClick={props.onSignOut}>Sign out</Button>
        </Stack>
      </> : <>
        <CircularProgress />
        <Typography textColor='text.secondary'>Preparing your private workspace...</Typography>
      </>}
    </Stack>
  </Sheet>;
}

function CrossUidPrivateProSyncAccount(props: {
  user: User;
  firebaseSignOut: () => Promise<void>;
  previousOwnership: { uid: string; owner: PrivateProPersistenceOwner };
  children: React.ReactNode;
}) {
  const startupSerializers = React.useMemo(() => createPrivateProSyncSerializers(), []);
  const startupBuffer = React.useMemo(
    () => createPrivateProStartupMutationBuffer(startupSerializers, mutation => privateProStartupDurableGeneration(props.user.uid, mutation)),
    [props.user.uid, startupSerializers],
  );
  const [attempt, setAttempt] = React.useState(0);
  const [phase, setPhase] = React.useState<'preparing' | 'ready' | 'error'>('preparing');
  const [signingOut, setSigningOut] = React.useState(false);
  const [actionError, setActionError] = React.useState(false);
  usePrivateProLayoutEffect(() => {
    let current = true;
    setPhase('preparing');
    void preparePrivateProCrossUidTransition({
      uid: props.user.uid,
      previousOwnership: props.previousOwnership,
      isCurrent: () => current,
      waitForPreviousOwner: waitForPrivateProSyncLifecycleOwner,
      deactivateAssets: deactivatePrivateProAssetPersistence,
      clearPrevious: uidToClear => clearPrivateProManagedPersistence(uidToClear, privateProSyncDB, clearPrivateProManagedRuntimeStores),
      beforeObserve: () => startupBuffer.start(),
    }).then(() => {
      if (current) setPhase('ready');
    }, () => {
      if (current) setPhase('error');
    });
    return () => {
      current = false;
      startupBuffer.stop();
    };
  }, [attempt, props.previousOwnership.owner, props.previousOwnership.uid, props.user.uid, startupBuffer]);
  if (phase !== 'ready') return <PrivateProWorkspaceTransitionScreen
    failed={phase === 'error'}
    busy={signingOut}
    actionError={actionError}
    onRetry={() => { setActionError(false); setAttempt(value => value + 1); }}
    onSignOut={() => {
      setSigningOut(true);
      setActionError(false);
      void runPrivateProTransitionSignOut(props.firebaseSignOut, () => window.location.reload())
        .then(succeeded => { if (!succeeded) setActionError(true); })
        .finally(() => setSigningOut(false));
    }}
  />;
  return <ReadyPrivateProSyncAccount
    user={props.user}
    firebaseSignOut={props.firebaseSignOut}
    previousOwnership={null}
    startupSerializers={startupSerializers}
    startupBuffer={startupBuffer}
  >{props.children}</ReadyPrivateProSyncAccount>;
}

function ReadyPrivateProSyncAccount(props: {
  user: User;
  firebaseSignOut: () => Promise<void>;
  previousOwnership: { uid: string; owner: PrivateProPersistenceOwner } | null;
  startupSerializers?: readonly PrivateProSyncSerializer<unknown>[];
  startupBuffer?: ReturnType<typeof createPrivateProStartupMutationBuffer>;
  children: React.ReactNode;
}) {
  const statusStore = React.useMemo(createPrivateProSyncStore, [props.user.uid]);
  const defaultStartupSerializers = React.useMemo(() => createPrivateProSyncSerializers(), []);
  const startupSerializers = props.startupSerializers ?? defaultStartupSerializers;
  const defaultStartupBuffer = React.useMemo(
    () => createPrivateProStartupMutationBuffer(defaultStartupSerializers, mutation => privateProStartupDurableGeneration(props.user.uid, mutation)),
    [defaultStartupSerializers, props.user.uid],
  );
  const startupBuffer = props.startupBuffer ?? defaultStartupBuffer;
  const previousOwner = props.previousOwnership?.owner ?? null;
  const previousUid = props.previousOwnership?.uid ?? null;
  const lifecycle = React.useMemo(
    () => createProductionLifecycle(
      props.user.uid,
      previousOwner && previousUid ? { uid: previousUid, owner: previousOwner } : null,
      props.firebaseSignOut,
      statusStore,
      startupSerializers,
      startupBuffer,
    ),
    [previousOwner, previousUid, props.firebaseSignOut, props.user.uid, startupBuffer, startupSerializers, statusStore],
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
  usePrivateProLayoutEffect(() => {
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
  startupSerializers: readonly PrivateProSyncSerializer<unknown>[] = createPrivateProSyncSerializers(),
  startupBuffer: ReturnType<typeof createPrivateProStartupMutationBuffer> = createPrivateProStartupMutationBuffer(
    startupSerializers,
    mutation => privateProStartupDurableGeneration(uid, mutation),
  ),
): PrivateProSyncLifecycle {
  const lifecycle = createPrivateProSyncLifecycle({
    uid,
    statusStore,
    async prepare(isCurrent, owner) {
      return preparePrivateProPersistenceOwner({
        uid,
        owner,
        previousOwnership,
        isCurrent,
        beforeObserve: () => startupBuffer.start(),
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
          const serializers = [...startupSerializers, assetSerializer];
          const engine = createPrivateProSyncEngine({
            uid,
            writerId: crypto.randomUUID(),
            serializers,
            startupBuffer,
            db: privateProSyncDB,
            coordinator,
            transport,
            assets,
            runSuppressed: callback => callback(),
            statusStore,
          });
          return { engine, coordinator, resumeStartupCapture: () => startupBuffer.start() };
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
  return createPrivateProBufferedSyncLifecycle(lifecycle, startupBuffer);
}

export function usePrivateProSync(): PrivateProSyncContextValue {
  const value = React.useContext(PrivateProSyncContext);
  if (!value) throw new Error('usePrivateProSync must be used inside ProviderPrivateProSync.');
  return value;
}
