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

  let channel: BroadcastChannelPort | null = null;
  let started = false;
  let stopped = false;
  let leader = false;
  let coordinatorFailure: unknown = null;
  let runLeader: ((context: PrivateProSyncLeaderContext) => Promise<void>) | null = null;
  let leaderAbort: AbortController | null = null;
  let webLockAbort: AbortController | null = null;
  let webLockRequest: Promise<void> | null = null;
  let leadership: Promise<void> | null = null;
  let fallbackLease: PrivateProCoordinatorLease | null = null;
  let fallbackIdentity: LeaseIdentity | null = null;
  let fallbackPollTimer: IntervalHandle | null = null;
  let fallbackRenewTimer: IntervalHandle | null = null;
  let fallbackAttempt: Promise<void> | null = null;
  let renewalPromise: Promise<void> | null = null;

  function rememberFailure(error: unknown, signal?: AbortSignal): void {
    if (coordinatorFailure || (signal?.aborted && isAbortError(error)) || (stopped && isAbortError(error))) return;
    coordinatorFailure = error;
  }

  function ensureChannel(): void {
    if (channel || !broadcastChannel) return;
    channel = new broadcastChannel(lockName);
    channel.onmessage = event => {
      if (event.data === 'wake') options.onWake?.();
      if (event.data === 'signed-out') options.onSignedOut?.();
    };
  }

  function clearFallbackRenewTimer(): void {
    if (fallbackRenewTimer === null) return;
    cancelInterval(fallbackRenewTimer);
    fallbackRenewTimer = null;
  }

  function clearFallbackPollTimer(): void {
    if (fallbackPollTimer === null) return;
    cancelInterval(fallbackPollTimer);
    fallbackPollTimer = null;
  }

  async function releaseFallbackIdentity(identity: LeaseIdentity | null): Promise<void> {
    if (!identity || !options.leases) return;
    await options.leases.releaseCoordinatorLease(options.uid, COORDINATOR_NAME, identity.fence, identity.ownerToken);
  }

  async function runAsLeader(lease: PrivateProCoordinatorLease | null): Promise<void> {
    if (stopped || !runLeader) return;
    const identity = lease ? { fence: lease.fence, ownerToken: lease.ownerToken } : null;
    leader = true;
    leaderAbort = new AbortController();
    if (lease) {
      fallbackLease = lease;
      fallbackIdentity = identity;
      fallbackRenewTimer = scheduleInterval(() => {
        if (!renewalPromise && fallbackLease && fallbackIdentity) void renewFallbackLease(fallbackLease, fallbackIdentity);
      }, FALLBACK_RENEW_MS);
    }
    try {
      await runLeader({ signal: leaderAbort.signal, coordinatorFence: lease?.fence ?? 0 });
    } catch (error) {
      rememberFailure(error, leaderAbort.signal);
    } finally {
      leader = false;
      leaderAbort = null;
      clearFallbackRenewTimer();
      if (!stopped) {
        await releaseFallbackIdentity(identity);
        if (sameLeaseIdentity(fallbackIdentity, identity)) {
          fallbackLease = null;
          fallbackIdentity = null;
        }
      }
    }
  }

  async function renewFallbackLease(lease: PrivateProCoordinatorLease, identity: LeaseIdentity): Promise<void> {
    if (stopped || !leader || !options.leases || !sameLeaseIdentity(fallbackIdentity, identity)) return;
    renewalPromise = (async () => {
      const renewed = await options.leases!.renewCoordinatorLease(
        options.uid,
        COORDINATOR_NAME,
        identity.fence,
        identity.ownerToken,
        now(),
        FALLBACK_LEASE_MS,
      );
      if (stopped || !leader || !sameLeaseIdentity(fallbackIdentity, identity)) {
        if (renewed) await releaseFallbackIdentity(identity);
        return;
      }
      if (renewed) {
        fallbackLease = renewed;
        return;
      }
      clearFallbackRenewTimer();
      leaderAbort?.abort();
    })();
    try {
      await renewalPromise;
    } catch (error) {
      rememberFailure(error);
      if (sameLeaseIdentity(fallbackIdentity, identity)) leaderAbort?.abort();
    } finally {
      renewalPromise = null;
    }
  }

  async function attemptFallbackLeadership(): Promise<void> {
    if (stopped || leader || fallbackAttempt || !options.leases || !runLeader) return;
    fallbackAttempt = (async () => {
      const lease = await options.leases!.acquireCoordinatorLease(options.uid, COORDINATOR_NAME, now(), FALLBACK_LEASE_MS);
      if (!lease) return;
      if (stopped) {
        await releaseFallbackIdentity(lease);
        return;
      }
      leadership = runAsLeader(lease);
      await Promise.resolve();
    })();
    try {
      await fallbackAttempt;
    } catch (error) {
      rememberFailure(error);
    } finally {
      fallbackAttempt = null;
    }
  }

  function startFallbackPolling(): void {
    if (fallbackPollTimer !== null) return;
    fallbackPollTimer = scheduleInterval(() => { void attemptFallbackLeadership(); }, FALLBACK_RENEW_MS);
  }

  return {
    async start(nextRunLeader): Promise<void> {
      if (started) return;
      started = true;
      stopped = false;
      coordinatorFailure = null;
      runLeader = nextRunLeader;
      ensureChannel();

      if (locks) {
        webLockAbort = new AbortController();
        webLockRequest = locks.request(lockName, { mode: 'exclusive', signal: webLockAbort.signal }, async () => {
          leadership = runAsLeader(null);
          await leadership;
        }).catch(error => {
          if (!(stopped && isAbortError(error))) rememberFailure(error, webLockAbort?.signal);
        });
        return;
      }

      await attemptFallbackLeadership();
      if (options.leases) startFallbackPolling();
    },

    wake(): void {
      options.onWake?.();
      channel?.postMessage('wake');
    },

    async stop(): Promise<void> {
      if (!started) return;
      stopped = true;
      channel?.postMessage('signed-out');
      clearFallbackPollTimer();
      clearFallbackRenewTimer();
      webLockAbort?.abort();
      leaderAbort?.abort();
      await fallbackAttempt;
      await renewalPromise;
      await leadership;
      await releaseFallbackIdentity(fallbackIdentity);
      await webLockRequest;
      channel?.close();
      channel = null;
      started = false;
      runLeader = null;
      webLockAbort = null;
      fallbackLease = null;
      fallbackIdentity = null;
      if (coordinatorFailure) throw coordinatorFailure;
    },

    isLeader(): boolean {
      return leader;
    },
  };
}
