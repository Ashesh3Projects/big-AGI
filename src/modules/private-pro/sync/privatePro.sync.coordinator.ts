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

export interface PrivateProCoordinatorLeasePort {
  acquireCoordinatorLease(uid: string, name: string, nowMs: number, leaseMs: number): Promise<PrivateProCoordinatorLease | null>;
  renewCoordinatorLease(uid: string, name: string, fence: number, ownerToken: string, nowMs: number, leaseMs: number): Promise<PrivateProCoordinatorLease | null>;
  releaseCoordinatorLease(uid: string, name: string, fence: number, ownerToken: string): Promise<void>;
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
  start(runLeader: (signal: AbortSignal) => Promise<void>): Promise<void>;
  wake(): void;
  stop(): Promise<void>;
  isLeader(): boolean;
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
  let runLeader: ((signal: AbortSignal) => Promise<void>) | null = null;
  let leaderAbort: AbortController | null = null;
  let webLockAbort: AbortController | null = null;
  let leadership: Promise<void> | null = null;
  let fallbackLease: PrivateProCoordinatorLease | null = null;
  let fallbackPollTimer: IntervalHandle | null = null;
  let fallbackRenewTimer: IntervalHandle | null = null;
  let fallbackAttempt: Promise<void> | null = null;

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

  async function endLeadership(releaseFallbackLease: boolean): Promise<void> {
    const lease = fallbackLease;
    fallbackLease = null;
    clearFallbackRenewTimer();
    if (leaderAbort) leaderAbort.abort();
    if (releaseFallbackLease && lease && options.leases)
      await options.leases.releaseCoordinatorLease(options.uid, COORDINATOR_NAME, lease.fence, lease.ownerToken);
  }

  async function runAsLeader(lease: PrivateProCoordinatorLease | null): Promise<void> {
    if (stopped || !runLeader) return;
    leader = true;
    leaderAbort = new AbortController();
    if (lease) {
      fallbackLease = lease;
      fallbackRenewTimer = scheduleInterval(() => {
        if (fallbackLease) void renewFallbackLease(fallbackLease);
      }, FALLBACK_RENEW_MS);
    }
    try {
      await runLeader(leaderAbort.signal);
    } finally {
      leader = false;
      leaderAbort = null;
      const mustRelease = fallbackLease === lease;
      await endLeadership(mustRelease);
    }
  }

  async function renewFallbackLease(lease: PrivateProCoordinatorLease): Promise<void> {
    if (stopped || fallbackLease !== lease || !options.leases) return;
    const renewed = await options.leases.renewCoordinatorLease(
      options.uid,
      COORDINATOR_NAME,
      lease.fence,
      lease.ownerToken,
      now(),
      FALLBACK_LEASE_MS,
    );
    if (renewed) {
      fallbackLease = renewed;
      return;
    }
    if (fallbackLease === lease) {
      fallbackLease = null;
      clearFallbackRenewTimer();
      leaderAbort?.abort();
    }
  }

  async function attemptFallbackLeadership(): Promise<void> {
    if (stopped || leader || fallbackAttempt || !options.leases || !runLeader) return;
    fallbackAttempt = (async () => {
      const lease = await options.leases!.acquireCoordinatorLease(options.uid, COORDINATOR_NAME, now(), FALLBACK_LEASE_MS);
      if (!lease) return;
      if (stopped) {
        await options.leases!.releaseCoordinatorLease(options.uid, COORDINATOR_NAME, lease.fence, lease.ownerToken);
        return;
      }
      leadership = runAsLeader(lease);
      await Promise.resolve();
    })();
    try {
      await fallbackAttempt;
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
      runLeader = nextRunLeader;
      ensureChannel();

      if (locks) {
        webLockAbort = new AbortController();
        void locks.request(lockName, { mode: 'exclusive', signal: webLockAbort.signal }, async () => {
          leadership = runAsLeader(null);
          await leadership;
        }).catch(error => {
          if (!stopped) throw error;
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
      webLockAbort?.abort();
      clearFallbackPollTimer();
      await endLeadership(true);
      await fallbackAttempt;
      await leadership;
      channel?.close();
      channel = null;
      started = false;
      runLeader = null;
      webLockAbort = null;
    },

    isLeader(): boolean {
      return leader;
    },
  };
}
