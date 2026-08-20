import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  createPrivateProSyncCoordinator,
  type PrivateProCoordinatorLeasePort,
  type PrivateProSyncCoordinatorOptions,
  type PrivateProSyncLeaderContext,
} from './privatePro.sync.coordinator';
import { createPrivateProSyncEngine } from './privatePro.sync.engine';
import { createPrivateProSyncLifecycle } from './ProviderPrivateProSync';
import { createPrivateProSyncStore } from './store-private-pro-sync';


interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolve_ => { resolve = resolve_; });
  return { promise, resolve };
}

function abortError(): DOMException {
  return new DOMException('The request was aborted.', 'AbortError');
}

async function settle(): Promise<void> {
  for (let index = 0; index < 40; index++) await Promise.resolve();
}

interface LockRequest {
  done: Deferred<void>;
  callback: () => Promise<void>;
  started: boolean;
  aborted: boolean;
}

class FakeLocks {
  private readonly queues = new Map<string, LockRequest[]>();
  private readonly held = new Set<string>();

  request(name: string, options: LockOptions, callback: () => Promise<void>): Promise<void> {
    const request: LockRequest = { done: deferred(), callback, started: false, aborted: false };
    const queue = this.queues.get(name) ?? [];
    this.queues.set(name, queue);
    queue.push(request);
    options.signal?.addEventListener('abort', () => {
      if (request.started || request.aborted) return;
      request.aborted = true;
      const index = queue.indexOf(request);
      if (index >= 0) queue.splice(index, 1);
      request.done.resolve(Promise.reject(abortError()));
      this.pump(name);
    }, { once: true });
    this.pump(name);
    return request.done.promise;
  }

  waiting(name: string): number {
    return (this.queues.get(name) ?? []).filter(request => !request.started && !request.aborted).length;
  }

  private pump(name: string): void {
    if (this.held.has(name)) return;
    const queue = this.queues.get(name);
    const request = queue?.find(candidate => !candidate.aborted);
    if (!queue || !request) return;
    const index = queue.indexOf(request);
    queue.splice(index, 1);
    request.started = true;
    this.held.add(name);
    void request.callback().then(
      () => request.done.resolve(),
      error => request.done.resolve(Promise.reject(error)),
    ).finally(() => {
      this.held.delete(name);
      this.pump(name);
    });
  }
}

class FakeBroadcastChannel {
  static readonly channels = new Map<string, Set<FakeBroadcastChannel>>();
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;

  constructor(readonly name: string) {
    const peers = FakeBroadcastChannel.channels.get(name) ?? new Set();
    peers.add(this);
    FakeBroadcastChannel.channels.set(name, peers);
  }

  postMessage(message: unknown): void {
    for (const peer of FakeBroadcastChannel.channels.get(this.name) ?? []) {
      if (peer !== this) peer.onmessage?.({ data: message } as MessageEvent<unknown>);
    }
  }

  close(): void {
    const peers = FakeBroadcastChannel.channels.get(this.name);
    peers?.delete(this);
    if (!peers?.size) FakeBroadcastChannel.channels.delete(this.name);
  }
}

class ManualScheduler {
  nowMs = 0;
  private nextId = 1;
  private readonly timers = new Map<number, () => void>();

  now = (): number => this.nowMs;
  setInterval = (callback: () => void): ReturnType<typeof globalThis.setInterval> => {
    const id = this.nextId++;
    this.timers.set(id, callback);
    return id as unknown as ReturnType<typeof globalThis.setInterval>;
  };
  clearInterval = (id: ReturnType<typeof globalThis.setInterval>): void => {
    this.timers.delete(id as unknown as number);
  };

  activeTimerCount(): number {
    return this.timers.size;
  }

  async advance(ms: number): Promise<void> {
    this.nowMs += ms;
    for (const callback of [...this.timers.values()]) callback();
    await settle();
  }
}

interface LeaseIdentity {
  fence: number;
  ownerToken: string;
}

class FakeLeasePort implements PrivateProCoordinatorLeasePort {
  private current: ({ expiresAtMs: number } & LeaseIdentity) | null = null;
  private ownerNumber = 0;
  private renewal: Deferred<ReturnType<FakeLeasePort['snapshot']> | null> | null = null;
  private renewalIdentity: LeaseIdentity | null = null;
  private releaseFailure: Error | null = null;
  readonly releases: LeaseIdentity[] = [];
  renewCalls = 0;

  async acquireCoordinatorLease(_uid: string, _name: string, nowMs: number, leaseMs: number) {
    if (this.current && this.current.expiresAtMs > nowMs) return null;
    this.current = {
      expiresAtMs: nowMs + leaseMs,
      fence: (this.current?.fence ?? 0) + 1,
      ownerToken: `owner-${++this.ownerNumber}`,
    };
    return this.snapshot();
  }

  async renewCoordinatorLease(_uid: string, _name: string, fence: number, ownerToken: string, nowMs: number, leaseMs: number) {
    this.renewCalls++;
    if (!this.current || this.current.expiresAtMs <= nowMs || this.current.fence !== fence || this.current.ownerToken !== ownerToken) return null;
    if (this.renewal) {
      this.renewalIdentity = { fence, ownerToken };
      return this.renewal.promise;
    }
    this.current.expiresAtMs = nowMs + leaseMs;
    return this.snapshot();
  }

  async releaseCoordinatorLease(_uid: string, _name: string, fence: number, ownerToken: string): Promise<void> {
    this.releases.push({ fence, ownerToken });
    if (this.current?.fence === fence && this.current.ownerToken === ownerToken) {
      this.current.expiresAtMs = 0;
      this.current.ownerToken = `released-${ownerToken}`;
    }
    const failure = this.releaseFailure;
    this.releaseFailure = null;
    if (failure) throw failure;
  }

  deferRenewal(): void {
    this.renewal = deferred();
    this.renewalIdentity = this.current ? { fence: this.current.fence, ownerToken: this.current.ownerToken } : null;
  }

  failNextRelease(error: Error): void {
    this.releaseFailure = error;
  }

  resolveRenewal(nowMs: number, leaseMs: number): void {
    if (!this.renewal) assert.fail('Expected a deferred renewal.');
    const requestedIdentity = this.renewalIdentity;
    if (!requestedIdentity) assert.fail('Expected a deferred renewal identity.');
    const renewed = { ...requestedIdentity, expiresAtMs: nowMs + leaseMs };
    if (this.current?.fence === requestedIdentity.fence && this.current.ownerToken === requestedIdentity.ownerToken) this.current = renewed;
    this.renewal.resolve({ uid: 'uid', name: 'sync', ...renewed });
    this.renewal = null;
    this.renewalIdentity = null;
  }

  isAvailable(nowMs: number): boolean {
    return !this.current || this.current.expiresAtMs <= nowMs;
  }

  private snapshot() {
    if (!this.current) assert.fail('Expected a coordinator lease.');
    return { uid: 'uid', name: 'sync', ...this.current };
  }
}

function options(uid: string, extra: Partial<PrivateProSyncCoordinatorOptions> = {}): PrivateProSyncCoordinatorOptions {
  return { uid, broadcastChannel: FakeBroadcastChannel, ...extra };
}

function leaderRunner(started: string[], id: string): (context: PrivateProSyncLeaderContext) => Promise<void> {
  return context => new Promise(resolve => {
    started.push(`${id}:${context.coordinatorFence}`);
    context.signal.addEventListener('abort', () => resolve(), { once: true });
  });
}


describe('Private Pro sync coordinator', () => {
  test('elects one Web Lock leader with fence zero and lets the waiting follower take over after shutdown', async () => {
    const locks = new FakeLocks();
    const started: string[] = [];
    const first = createPrivateProSyncCoordinator(options('uid-a', { locks }));
    const second = createPrivateProSyncCoordinator(options('uid-a', { locks }));

    await Promise.all([first.start(leaderRunner(started, 'first')), second.start(leaderRunner(started, 'second'))]);
    await settle();
    assert.deepEqual(started, ['first:0']);
    assert.equal(first.isLeader(), true);
    assert.equal(second.isLeader(), false);

    await first.stop();
    await settle();
    assert.deepEqual(started, ['first:0', 'second:0']);
    assert.equal(second.isLeader(), true);
    await second.stop();
  });

  test('stopping a waiting Web Lock follower removes its lock request', async () => {
    const locks = new FakeLocks();
    const first = createPrivateProSyncCoordinator(options('uid-a', { locks }));
    const second = createPrivateProSyncCoordinator(options('uid-a', { locks }));

    await first.start(leaderRunner([], 'first'));
    await second.start(leaderRunner([], 'second'));
    assert.equal(locks.waiting('private-pro-sync:uid-a'), 1);

    await second.stop();
    assert.equal(locks.waiting('private-pro-sync:uid-a'), 0);
    await first.stop();
  });

  test('returns a Web Lock leader failure from stop after cleanup', async () => {
    const locks = new FakeLocks();
    const coordinator = createPrivateProSyncCoordinator(options('uid-a', { locks }));
    const failure = new Error('leader failed');

    await coordinator.start(async () => { throw failure; });
    await settle();

    await assert.rejects(coordinator.stop(), error => error === failure);
    assert.equal(coordinator.isLeader(), false);
  });

  test('broadcasts wake and signed-out signals without a workspace record payload', async () => {
    const received: string[] = [];
    const sender = createPrivateProSyncCoordinator(options('uid-a'));
    const receiver = createPrivateProSyncCoordinator(options('uid-a', {
      onWake: () => received.push('wake'),
      onSignedOut: () => received.push('signed-out'),
    }));

    await Promise.all([sender.start(async () => {}), receiver.start(async () => {})]);
    sender.wake();
    sender.broadcastSignedOut?.();
    await sender.stop();

    assert.deepEqual(received, ['wake', 'signed-out']);
    await receiver.stop();
  });

  test('uses one fenced fallback leader and releases it for the waiting follower', async () => {
    const scheduler = new ManualScheduler();
    const leases = new FakeLeasePort();
    const started: string[] = [];
    const first = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));
    const second = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));

    await Promise.all([first.start(leaderRunner(started, 'first')), second.start(leaderRunner(started, 'second'))]);
    assert.deepEqual(started, ['first:1']);
    assert.equal(first.isLeader(), true);

    await first.stop();
    await scheduler.advance(5_000);
    assert.deepEqual(started, ['first:1', 'second:2']);
    assert.equal(second.isLeader(), true);
    await second.stop();
  });

  test('serializes fallback renewals and keeps the latest lease alive before expiry', async () => {
    const scheduler = new ManualScheduler();
    const leases = new FakeLeasePort();
    const started: string[] = [];
    const coordinator = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));

    await coordinator.start(leaderRunner(started, 'leader'));
    leases.deferRenewal();
    await scheduler.advance(5_000);
    await scheduler.advance(5_000);
    assert.equal(leases.renewCalls, 1);

    leases.resolveRenewal(scheduler.nowMs, 15_000);
    await settle();
    await scheduler.advance(10_000);
    assert.deepEqual(started, ['leader:1']);
    assert.equal(coordinator.isLeader(), true);
    await coordinator.stop();
  });

  test('releases a renewed fallback lease by fence and owner identity when the leader completes', async () => {
    const scheduler = new ManualScheduler();
    const leases = new FakeLeasePort();
    const completion = deferred<void>();
    const coordinator = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));

    await coordinator.start(async () => completion.promise);
    leases.deferRenewal();
    await scheduler.advance(5_000);
    leases.resolveRenewal(scheduler.nowMs, 15_000);
    await settle();
    completion.resolve();
    await settle();

    assert.deepEqual(leases.releases, [{ fence: 1, ownerToken: 'owner-1' }]);
    assert.equal(leases.isAvailable(scheduler.nowMs), true);
    assert.equal(scheduler.activeTimerCount(), 0);
    await coordinator.stop();
  });

  test('does not restore a fallback lease after stop races a delayed renewal', async () => {
    const scheduler = new ManualScheduler();
    const leases = new FakeLeasePort();
    const coordinator = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));

    await coordinator.start(leaderRunner([], 'leader'));
    leases.deferRenewal();
    await scheduler.advance(5_000);
    const stopped = coordinator.stop();
    await settle();
    leases.resolveRenewal(scheduler.nowMs, 15_000);
    await stopped;

    assert.equal(coordinator.isLeader(), false);
    assert.equal(leases.isAvailable(scheduler.nowMs), true);
    assert.equal(scheduler.activeTimerCount(), 0);
  });

  test('a renewal that never settles cannot pin fallback stop or successor acquisition', async () => {
    const scheduler = new ManualScheduler();
    const leases = new FakeLeasePort();
    const started: string[] = [];
    const first = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));
    const second = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));

    await first.start(leaderRunner(started, 'first'));
    leases.deferRenewal();
    await scheduler.advance(5_000);
    await second.start(leaderRunner(started, 'second'));

    await Promise.race([
      first.stop(),
      new Promise<never>((_, reject) => setImmediate(() => reject(new Error('fallback stop waited for renewal')))),
    ]);
    await scheduler.advance(5_000);

    assert.deepEqual(started, ['first:1', 'second:2']);
    assert.deepEqual(leases.releases, [{ fence: 1, ownerToken: 'owner-1' }]);
    assert.equal(second.isLeader(), true);
    await second.stop();
  });

  test('a renewal that never settles cannot pin engine stop before a successor acquires', async () => {
    const scheduler = new ManualScheduler();
    const leases = new FakeLeasePort();
    const started: string[] = [];
    const first = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));
    const second = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));
    const engine = createPrivateProSyncEngine({
      uid: 'uid-a', serializers: [], db: { pendingCount: async () => 0 }, runSuppressed: callback => callback(),
      transport: { write: async () => { throw new Error('unused'); }, listen: () => () => {} },
      createOutbound: () => ({
        start: () => first.start(leaderRunner(started, 'engine')),
        retryNow: async () => {}, flushNow: async () => {}, wake: () => {}, handleCommitted: async () => {},
        stop: () => first.stop(),
      }),
      createReconciler: () => ({ applyCached: async () => {}, handle: async () => {} }),
    });

    await engine.start();
    leases.deferRenewal();
    await scheduler.advance(5_000);
    await second.start(leaderRunner(started, 'successor'));

    await Promise.race([
      engine.stop(),
      new Promise<never>((_, reject) => setImmediate(() => reject(new Error('engine stop waited for renewal')))),
    ]);
    await scheduler.advance(5_000);

    assert.deepEqual(started, ['engine:1', 'successor:2']);
    assert.equal(second.isLeader(), true);
    await second.stop();
  });

  test('never-settling renewals cannot pin remount or confirmed sign-out cleanup', async () => {
    const scheduler = new ManualScheduler();
    const leases = new FakeLeasePort();
    const started: string[] = [];
    const cleanup: string[] = [];
    let attempt = 0;
    const lifecycle = createPrivateProSyncLifecycle({
      uid: 'uid-a', statusStore: createPrivateProSyncStore(),
      prepare: async () => {
        const id = ++attempt;
        const coordinator = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));
        return {
          engine: {
            start: () => coordinator.start(leaderRunner(started, `mount-${id}`)),
            async retryNow() {}, async flushNow() { return { pending: 0 }; }, async pendingCount() { return 0; },
            stop: () => coordinator.stop(),
          },
          coordinator,
        };
      },
      release: async () => { cleanup.push('release'); },
      clear: async () => { cleanup.push('clear'); },
      firebaseSignOut: async () => { cleanup.push('auth'); },
      reload: () => { cleanup.push('reload'); },
      pendingCount: async () => 0,
    });

    await lifecycle.start();
    leases.deferRenewal();
    await scheduler.advance(5_000);
    await Promise.race([
      lifecycle.stop(),
      new Promise<never>((_, reject) => setImmediate(() => reject(new Error('remount stop waited for renewal')))),
    ]);
    await lifecycle.start();
    leases.deferRenewal();
    await scheduler.advance(5_000);

    await Promise.race([
      lifecycle.signOut({ discardPending: true }),
      new Promise<never>((_, reject) => setImmediate(() => reject(new Error('sign-out waited for renewal')))),
    ]);
    const successor = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));
    await successor.start(leaderRunner(started, 'post-signout'));

    assert.deepEqual(started, ['mount-1:1', 'mount-2:2', 'post-signout:3']);
    assert.deepEqual(cleanup, ['release', 'release', 'clear', 'auth', 'reload']);
    await successor.stop();
  });

  test('a failed fenced release still finishes cleanup and permits a restart', async () => {
    const scheduler = new ManualScheduler();
    const leases = new FakeLeasePort();
    const started: string[] = [];
    const coordinator = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));
    const failure = new Error('release failed');

    await coordinator.start(leaderRunner(started, 'first'));
    leases.failNextRelease(failure);
    await assert.rejects(coordinator.stop(), error => error === failure);
    assert.equal(scheduler.activeTimerCount(), 0);

    await coordinator.start(leaderRunner(started, 'second'));
    assert.deepEqual(started, ['first:1', 'second:2']);
    await coordinator.stop();
  });

  test('takes over an expired fallback lease and rejects the stale fenced owner renewal', async () => {
    const scheduler = new ManualScheduler();
    const leases = new FakeLeasePort();
    const started: string[] = [];
    const first = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));
    const second = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));

    await first.start(leaderRunner(started, 'first'));
    await second.start(leaderRunner(started, 'second'));
    await scheduler.advance(15_000);

    assert.deepEqual(started, ['first:1', 'second:2']);
    assert.equal(first.isLeader(), false);
    assert.equal(second.isLeader(), true);
    await Promise.all([first.stop(), second.stop()]);
  });
});
