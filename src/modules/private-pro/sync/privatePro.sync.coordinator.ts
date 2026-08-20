import type { PrivateProCoordinatorLease } from './privatePro.sync.db';


const COORDINATOR_NAME = 'sync';
const FALLBACK_LEASE_MS = 15_000;
const FALLBACK_RENEW_MS = 5_000;

type CoordinatorMessage = 'wake' | 'signed-out';
type IntervalHandle = ReturnType<typeof globalThis.setInterval>;

interface BroadcastChannelPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: CoordinatorMessage): void;
  close(): void;
}

interface BroadcastChannelConstructor {
  new(name: string): BroadcastChannelPort;
}

interface WebLocksPort {
  request(name: string, options: LockOptions, callback: () => Promise<void>): Promise<void>;
}

interface LeaseIdentity {
  fence: number;
  ownerToken: string;
}

interface GenerationTimer {
  generation: number;
  handle: IntervalHandle;
}

export interface PrivateProCoordinatorLeasePort {
  acquireCoordinatorLease(uid: string, name: string, nowMs: number, leaseMs: number): Promise<PrivateProCoordinatorLease | null>;
  renewCoordinatorLease(uid: string, name: string, fence: number, ownerToken: string, nowMs: number, leaseMs: number): Promise<PrivateProCoordinatorLease | null>;
  releaseCoordinatorLease(uid: string, name: string, fence: number, ownerToken: string): Promise<void>;
}

export interface PrivateProSyncLeaderContext {
  signal: AbortSignal;
  coordinatorFence: number;
}

export interface PrivateProSyncCoordinatorOptions {
  uid: string;
  leases?: PrivateProCoordinatorLeasePort;
  locks?: WebLocksPort;
  broadcastChannel?: BroadcastChannelConstructor;
  now?: () => number;
  setInterval?: (callback: () => void, ms: number) => IntervalHandle;
  clearInterval?: (id: IntervalHandle) => void;
  onWake?: () => void;
  onSignedOut?: () => void;
}

export interface PrivateProSyncCoordinator {
  start(runLeader: (context: PrivateProSyncLeaderContext) => Promise<void>): Promise<void>;
  wake(): void;
  broadcastSignedOut?(): void;
  stop(): Promise<void>;
  isLeader(): boolean;
}


function sameLeaseIdentity(left: LeaseIdentity | null, right: LeaseIdentity | null): boolean {
  return !!left && !!right && left.fence === right.fence && left.ownerToken === right.ownerToken;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}


export function createPrivateProSyncCoordinator(options: PrivateProSyncCoordinatorOptions): PrivateProSyncCoordinator {
  const locks = options.locks ?? (typeof window !== 'undefined' ? globalThis.navigator?.locks : undefined);
  const broadcastChannel = options.broadcastChannel ?? (typeof window !== 'undefined' ? globalThis.BroadcastChannel : undefined);
  const now = options.now ?? Date.now;
  const scheduleInterval = options.setInterval ?? ((callback, ms) => globalThis.setInterval(callback, ms));
  const cancelInterval = options.clearInterval ?? (id => globalThis.clearInterval(id));
  const lockName = `private-pro-sync:${options.uid}`;

  let lifecycleGeneration = 0;
  let stoppingGeneration: number | null = null;
  let channel: BroadcastChannelPort | null = null;
  let started = false;
  let stopped = true;
  let leader = false;
  let coordinatorFailure: unknown = null;
  let runLeader: ((context: PrivateProSyncLeaderContext) => Promise<void>) | null = null;
  let leaderAbort: AbortController | null = null;
  let webLockAbort: AbortController | null = null;
  let webLockRequest: Promise<void> | null = null;
  let leadership: Promise<void> | null = null;
  let fallbackLease: PrivateProCoordinatorLease | null = null;
  let fallbackIdentity: LeaseIdentity | null = null;
  let fallbackPollTimer: GenerationTimer | null = null;
  let fallbackRenewTimer: GenerationTimer | null = null;
  let fallbackAttempt: Promise<void> | null = null;
  let renewalPromise: Promise<void> | null = null;

  function isCurrent(generation: number): boolean {
    return started && !stopped && stoppingGeneration === null && lifecycleGeneration === generation;
  }

  function canRememberFailure(generation: number): boolean {
    return lifecycleGeneration === generation && (isCurrent(generation) || stoppingGeneration === generation);
  }

  function rememberFailure(generation: number, error: unknown, signal?: AbortSignal): void {
    if (!canRememberFailure(generation) || coordinatorFailure || (signal?.aborted && isAbortError(error))) return;
    coordinatorFailure = error;
  }

  function detach(promise: Promise<unknown> | null | undefined): void {
    promise?.catch(() => {});
  }

  function releaseFallbackIdentity(identity: LeaseIdentity | null): Promise<void> {
    if (!identity || !options.leases) return Promise.resolve();
    try {
      const release = options.leases.releaseCoordinatorLease(options.uid, COORDINATOR_NAME, identity.fence, identity.ownerToken);
      release.catch(() => {});
      return release;
    } catch (error) {
      const release = Promise.reject(error);
      release.catch(() => {});
      return release;
    }
  }

  function ensureChannel(generation: number): void {
    if (channel || !broadcastChannel || !isCurrent(generation)) return;
    const created = new broadcastChannel(lockName);
    channel = created;
    created.onmessage = event => {
      if (!isCurrent(generation) || channel !== created) return;
      if (event.data === 'wake') options.onWake?.();
      if (event.data === 'signed-out') options.onSignedOut?.();
    };
  }

  function clearFallbackRenewTimer(generation?: number): void {
    if (!fallbackRenewTimer || (generation !== undefined && fallbackRenewTimer.generation !== generation)) return;
    cancelInterval(fallbackRenewTimer.handle);
    fallbackRenewTimer = null;
  }

  function clearFallbackPollTimer(generation?: number): void {
    if (!fallbackPollTimer || (generation !== undefined && fallbackPollTimer.generation !== generation)) return;
    cancelInterval(fallbackPollTimer.handle);
    fallbackPollTimer = null;
  }

  function scheduleFallbackRenewal(
    generation: number,
    identity: LeaseIdentity,
  ): void {
    if (!isCurrent(generation)) return;
    clearFallbackRenewTimer(generation);
    const handle = scheduleInterval(() => {
      if (!isCurrent(generation) || renewalPromise || !sameLeaseIdentity(fallbackIdentity, identity)) return;
      void renewFallbackLease(generation, identity);
    }, FALLBACK_RENEW_MS);
    fallbackRenewTimer = { generation, handle };
  }

  async function runAsLeader(
    generation: number,
    lease: PrivateProCoordinatorLease | null,
    runner: (context: PrivateProSyncLeaderContext) => Promise<void>,
  ): Promise<void> {
    if (!isCurrent(generation)) {
      if (lease) detach(releaseFallbackIdentity({ fence: lease.fence, ownerToken: lease.ownerToken }));
      return;
    }
    const identity = lease ? { fence: lease.fence, ownerToken: lease.ownerToken } : null;
    const controller = new AbortController();
    leader = true;
    leaderAbort = controller;
    if (lease) {
      fallbackLease = lease;
      fallbackIdentity = identity;
      scheduleFallbackRenewal(generation, identity!);
    }
    try {
      await runner({ signal: controller.signal, coordinatorFence: lease?.fence ?? 0 });
    } catch (error) {
      rememberFailure(generation, error, controller.signal);
    } finally {
      if (!isCurrent(generation)) {
        if (identity) detach(releaseFallbackIdentity(identity));
        return;
      }
      if (leaderAbort === controller) leaderAbort = null;
      leader = false;
      clearFallbackRenewTimer(generation);
      clearFallbackPollTimer(generation);
      if (sameLeaseIdentity(fallbackIdentity, identity)) {
        fallbackLease = null;
        fallbackIdentity = null;
      }
      if (identity) detach(releaseFallbackIdentity(identity));
    }
  }

  async function renewFallbackLease(
    generation: number,
    identity: LeaseIdentity,
  ): Promise<void> {
    if (!isCurrent(generation) || !leader || !options.leases || !sameLeaseIdentity(fallbackIdentity, identity)) return;
    const attempt = (async () => {
      const renewed = await options.leases!.renewCoordinatorLease(
        options.uid,
        COORDINATOR_NAME,
        identity.fence,
        identity.ownerToken,
        now(),
        FALLBACK_LEASE_MS,
      );
      if (!isCurrent(generation) || !leader || !sameLeaseIdentity(fallbackIdentity, identity)) {
        if (renewed) detach(releaseFallbackIdentity(identity));
        return;
      }
      if (renewed) {
        fallbackLease = renewed;
        return;
      }
      clearFallbackRenewTimer(generation);
      leaderAbort?.abort();
    })();
    renewalPromise = attempt;
    try {
      await attempt;
    } catch (error) {
      rememberFailure(generation, error);
      if (isCurrent(generation) && sameLeaseIdentity(fallbackIdentity, identity)) leaderAbort?.abort();
    } finally {
      if (isCurrent(generation) && renewalPromise === attempt) renewalPromise = null;
    }
  }

  async function attemptFallbackLeadership(
    generation: number,
    runner: (context: PrivateProSyncLeaderContext) => Promise<void>,
  ): Promise<void> {
    if (!isCurrent(generation) || leader || fallbackAttempt || !options.leases) return;
    const attempt = (async () => {
      let lease: PrivateProCoordinatorLease | null;
      try {
        lease = await options.leases!.acquireCoordinatorLease(options.uid, COORDINATOR_NAME, now(), FALLBACK_LEASE_MS);
      } catch (error) {
        rememberFailure(generation, error);
        return;
      }
      if (!lease) return;
      if (!isCurrent(generation)) {
        detach(releaseFallbackIdentity({ fence: lease.fence, ownerToken: lease.ownerToken }));
        return;
      }
      const task = runAsLeader(generation, lease, runner);
      if (isCurrent(generation)) leadership = task;
      detach(task);
    })();
    fallbackAttempt = attempt;
    try {
      await attempt;
    } finally {
      if (isCurrent(generation) && fallbackAttempt === attempt) fallbackAttempt = null;
    }
  }

  function startFallbackPolling(
    generation: number,
    runner: (context: PrivateProSyncLeaderContext) => Promise<void>,
  ): void {
    if (!isCurrent(generation) || fallbackPollTimer?.generation === generation) return;
    const handle = scheduleInterval(() => { void attemptFallbackLeadership(generation, runner); }, FALLBACK_RENEW_MS);
    fallbackPollTimer = { generation, handle };
  }

  return {
    async start(nextRunLeader): Promise<void> {
      if (started) return;
      const generation = ++lifecycleGeneration;
      stoppingGeneration = null;
      started = true;
      stopped = false;
      leader = false;
      coordinatorFailure = null;
      runLeader = nextRunLeader;
      ensureChannel(generation);

      if (locks) {
        const controller = new AbortController();
        webLockAbort = controller;
        let request: Promise<void>;
        try {
          request = locks.request(lockName, { mode: 'exclusive', signal: controller.signal }, async () => {
            if (!isCurrent(generation)) return;
            const task = runAsLeader(generation, null, nextRunLeader);
            if (isCurrent(generation)) leadership = task;
            await task;
          });
        } catch (error) {
          rememberFailure(generation, error, controller.signal);
          return;
        }
        const observed = request.catch(error => rememberFailure(generation, error, controller.signal));
        observed.catch(() => {});
        if (isCurrent(generation)) webLockRequest = observed;
        return;
      }

      await attemptFallbackLeadership(generation, nextRunLeader);
      if (isCurrent(generation) && options.leases) startFallbackPolling(generation, nextRunLeader);
    },

    wake(): void {
      options.onWake?.();
      channel?.postMessage('wake');
    },

    broadcastSignedOut(): void {
      if (channel) {
        channel.postMessage('signed-out');
        return;
      }
      if (!broadcastChannel) return;
      const broadcaster = new broadcastChannel(lockName);
      broadcaster.postMessage('signed-out');
      broadcaster.close();
    },

    async stop(): Promise<void> {
      if (!started) return;
      const generation = lifecycleGeneration;
      stoppingGeneration = generation;
      stopped = true;
      clearFallbackPollTimer();
      clearFallbackRenewTimer();

      const lockController = webLockAbort;
      const leaderController = leaderAbort;
      const identity = fallbackIdentity;
      const closingChannel = channel;
      const pending = [fallbackAttempt, leadership, webLockRequest, renewalPromise];

      try { lockController?.abort(); } catch {}
      try { leaderController?.abort(); } catch {}

      await Promise.resolve();

      const failure = coordinatorFailure;
      lifecycleGeneration++;
      stoppingGeneration = null;
      started = false;
      leader = false;
      coordinatorFailure = null;
      runLeader = null;
      leaderAbort = null;
      webLockAbort = null;
      webLockRequest = null;
      leadership = null;
      fallbackLease = null;
      fallbackIdentity = null;
      fallbackAttempt = null;
      renewalPromise = null;
      channel = null;

      try {
        if (closingChannel) {
          closingChannel.onmessage = null;
          closingChannel.close();
        }
      } catch {}
      if (identity) detach(releaseFallbackIdentity(identity));
      for (const task of pending) detach(task);
      if (failure) throw failure;
    },

    isLeader(): boolean {
      return leader;
    },
  };
}
