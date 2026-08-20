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
  reject(error: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolve_, reject_) => { resolve = resolve_; reject = reject_; });
  return { promise, resolve, reject };
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

class DelayedLocks {
  readonly requests: Array<{ callback: () => Promise<void>; done: Deferred<void> }> = [];

  request(_name: string, _options: LockOptions, callback: () => Promise<void>): Promise<void> {
    const done = deferred<void>();
    this.requests.push({ callback, done });
    return done.promise;
  }

  async invoke(index: number): Promise<void> {
    const request = this.requests[index];
    if (!request) assert.fail(`Missing delayed Web Lock request ${index}.`);
    try {
      await request.callback();
      request.done.resolve();
    } catch (error) {
      request.done.reject(error);
    }
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
  private nextAcquireGate: { entered: Deferred<void>; release: Deferred<void> } | null = null;
  private nextReleaseGate: { entered: Deferred<void>; release: Deferred<void> } | null = null;
  readonly releases: LeaseIdentity[] = [];
  renewCalls = 0;

  async acquireCoordinatorLease(_uid: string, _name: string, nowMs: number, leaseMs: number) {
    if (this.current && this.current.expiresAtMs > nowMs) return null;
    this.current = {
      expiresAtMs: nowMs + leaseMs,
      fence: (this.current?.fence ?? 0) + 1,
      ownerToken: `owner-${++this.ownerNumber}`,
    };
    const acquired = this.snapshot();
    const gate = this.nextAcquireGate;
    this.nextAcquireGate = null;
    if (gate) {
      gate.entered.resolve();
      await gate.release.promise;
    }
    return acquired;
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
    const gate = this.nextReleaseGate;
    this.nextReleaseGate = null;
    if (gate) {
      gate.entered.resolve();
      await gate.release.promise;
    }
    const failure = this.releaseFailure;
    this.releaseFailure = null;
    if (failure) throw failure;
  }

  deferRenewal(): void {
    this.renewal = deferred();
    this.renewalIdentity = this.current ? { fence: this.current.fence, ownerToken: this.current.ownerToken } : null;
  }

  deferNextAcquire(): { entered: Promise<void>; resolve(): void } {
    const entered = deferred<void>();
    const release = deferred<void>();
    this.nextAcquireGate = { entered, release };
    return { entered: entered.promise, resolve: () => release.resolve() };
  }

  deferNextRelease(): { entered: Promise<void>; resolve(): void } {
    const entered = deferred<void>();
    const release = deferred<void>();
    this.nextReleaseGate = { entered, release };
    return { entered: entered.promise, resolve: () => release.resolve() };
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

  test('reports a leader rejection already settled immediately before stop', async () => {
    const scheduler = new ManualScheduler();
    const leases = new FakeLeasePort();
    const leader = deferred<void>();
    const failure = new Error('leader rejected before stop');
    const coordinator = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));
    await coordinator.start(() => leader.promise);

    leader.reject(failure);

    await assert.rejects(coordinator.stop(), error => error === failure);
    assert.equal(coordinator.isLeader(), false);
  });

  test('reports an acquire rejection already settled immediately before stop', async () => {
    const scheduler = new ManualScheduler();
    const failure = new Error('acquire rejected before stop');
    const acquire = deferred<PrivateProCoordinatorLease | null>();
    const leases: PrivateProCoordinatorLeasePort = {
      acquireCoordinatorLease: () => acquire.promise,
      renewCoordinatorLease: async () => null,
      releaseCoordinatorLease: async () => {},
    };
    const coordinator = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));
    const starting = coordinator.start(async () => {});

    acquire.reject(failure);

    await assert.rejects(coordinator.stop(), error => error === failure);
    await starting;
  });

  for (const [label, cancellation] of [
    ['Error named AbortError', Object.assign(new Error('cancelled'), { name: 'AbortError' })],
    ['nested abort cause', new Error('wrapped cancellation', { cause: { error: new DOMException('cancelled', 'AbortError') } })],
  ] as const) {
    test(`filters ${label} during the stop microtask checkpoint`, async () => {
      const scheduler = new ManualScheduler();
      const leases = new FakeLeasePort();
      const leader = deferred<void>();
      const coordinator = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));
      await coordinator.start(() => leader.promise);

      leader.reject(cancellation);

      await coordinator.stop();
      assert.equal(coordinator.isLeader(), false);
    });
  }

  test('ignores a leader rejection after the stop checkpoint and preserves restart', async () => {
    const scheduler = new ManualScheduler();
    const leases = new FakeLeasePort();
    const leader = deferred<void>();
    const started: string[] = [];
    const coordinator = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));
    await coordinator.start(() => leader.promise);

    await coordinator.stop();
    leader.reject(new Error('leader rejected after stop checkpoint'));
    await coordinator.start(leaderRunner(started, 'replacement'));
    await settle();

    assert.deepEqual(started, ['replacement:2']);
    await coordinator.stop();
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

    assert.deepEqual(leases.releases[0], { fence: 1, ownerToken: 'owner-1' });
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
    assert.deepEqual(leases.releases[0], { fence: 1, ownerToken: 'owner-1' });
    assert.equal(second.isLeader(), true);
    await second.stop();
  });

  test('stop does not wait for a leader callback that ignores abort and late completion cannot clear a restarted leader', async () => {
    const scheduler = new ManualScheduler();
    const leases = new FakeLeasePort();
    const firstLeader = deferred<void>();
    const started: string[] = [];
    const coordinator = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));

    await coordinator.start(async context => {
      started.push(`first:${context.coordinatorFence}`);
      await firstLeader.promise;
    });
    await Promise.race([
      coordinator.stop(),
      new Promise<never>((_, reject) => setImmediate(() => reject(new Error('stop waited for leader callback')))),
    ]);
    await coordinator.start(leaderRunner(started, 'second'));
    firstLeader.resolve();
    await settle();

    assert.deepEqual(started, ['first:1', 'second:2']);
    assert.equal(coordinator.isLeader(), true);
    assert.equal(scheduler.activeTimerCount(), 2);
    await coordinator.stop();
  });

  test('stop does not wait for a fenced release that never settles', async () => {
    const scheduler = new ManualScheduler();
    const leases = new FakeLeasePort();
    const started: string[] = [];
    const coordinator = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));
    await coordinator.start(leaderRunner(started, 'first'));
    const release = leases.deferNextRelease();

    await Promise.race([
      coordinator.stop(),
      new Promise<never>((_, reject) => setImmediate(() => reject(new Error('stop waited for fenced release')))),
    ]);
    await release.entered;
    await coordinator.start(leaderRunner(started, 'second'));
    assert.deepEqual(started, ['first:1', 'second:2']);
    assert.equal(coordinator.isLeader(), true);
    release.resolve();
    await settle();
    assert.equal(coordinator.isLeader(), true);
    await coordinator.stop();
  });

  test('stop does not wait for a Web Lock request that never settles', async () => {
    const never = new Promise<void>(() => {});
    const locks = { request: () => never };
    const coordinator = createPrivateProSyncCoordinator(options('uid-a', { locks }));
    await coordinator.start(async () => {});

    await Promise.race([
      coordinator.stop(),
      new Promise<never>((_, reject) => setImmediate(() => reject(new Error('stop waited for Web Lock request')))),
    ]);
    assert.equal(coordinator.isLeader(), false);
  });

  test('a delayed stale Web Lock callback cannot lead after restart', async () => {
    const locks = new DelayedLocks();
    const started: string[] = [];
    const coordinator = createPrivateProSyncCoordinator(options('uid-a', { locks }));
    await coordinator.start(leaderRunner(started, 'stale'));
    await coordinator.stop();
    await coordinator.start(leaderRunner(started, 'current'));

    await locks.invoke(0);
    assert.deepEqual(started, []);
    assert.equal(coordinator.isLeader(), false);

    const current = locks.invoke(1);
    await settle();
    assert.deepEqual(started, ['current:0']);
    assert.equal(coordinator.isLeader(), true);
    await coordinator.stop();
    await current;
  });

  test('stop does not wait for acquire and a late stale lease is released before the restarted generation leads', async () => {
    const scheduler = new ManualScheduler();
    const leases = new FakeLeasePort();
    const acquire = leases.deferNextAcquire();
    const started: string[] = [];
    const coordinator = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));
    const staleStart = coordinator.start(leaderRunner(started, 'stale'));
    await acquire.entered;

    await Promise.race([
      coordinator.stop(),
      new Promise<never>((_, reject) => setImmediate(() => reject(new Error('stop waited for acquire')))),
    ]);
    await coordinator.start(leaderRunner(started, 'current'));
    acquire.resolve();
    await staleStart;
    await scheduler.advance(5_000);

    assert.deepEqual(started, ['current:2']);
    assert.deepEqual(leases.releases[0], { fence: 1, ownerToken: 'owner-1' });
    assert.equal(coordinator.isLeader(), true);
    await coordinator.stop();
  });

  test('late renewal completion cannot change the restarted generation or its owner', async () => {
    const scheduler = new ManualScheduler();
    const leases = new FakeLeasePort();
    const started: string[] = [];
    const coordinator = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));
    await coordinator.start(leaderRunner(started, 'first'));
    leases.deferRenewal();
    await scheduler.advance(5_000);
    await coordinator.stop();
    await coordinator.start(leaderRunner(started, 'second'));

    leases.resolveRenewal(scheduler.nowMs, 15_000);
    await settle();

    assert.deepEqual(started, ['first:1', 'second:2']);
    assert.equal(coordinator.isLeader(), true);
    assert.equal(scheduler.activeTimerCount(), 2);
    await coordinator.stop();
  });

  test('late rejected leader work cannot report failure into a restarted generation', async () => {
    const scheduler = new ManualScheduler();
    const leases = new FakeLeasePort();
    const firstLeader = deferred<void>();
    const coordinator = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));
    await coordinator.start(() => firstLeader.promise);
    await coordinator.stop();
    await coordinator.start(leaderRunner([], 'second'));

    firstLeader.reject(new Error('stale leader failed'));
    await settle();

    await coordinator.stop();
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
    await coordinator.start(leaderRunner(started, 'first'));
    leases.failNextRelease(new Error('release failed'));
    await coordinator.stop();
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
