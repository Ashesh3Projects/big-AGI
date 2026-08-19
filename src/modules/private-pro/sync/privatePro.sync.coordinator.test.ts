import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  createPrivateProSyncCoordinator,
  type PrivateProCoordinatorLeasePort,
  type PrivateProSyncCoordinator,
  type PrivateProSyncCoordinatorOptions,
} from './privatePro.sync.coordinator';


interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolve_ => { resolve = resolve_; });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 40; index++) await Promise.resolve();
}

class FakeLocks {
  private readonly queues = new Map<string, (() => void)[]>();
  private readonly held = new Set<string>();

  request(name: string, _options: LockOptions, callback: () => Promise<void>): Promise<void> {
    const done = deferred<void>();
    const run = () => {
      this.held.add(name);
      void callback().then(() => done.resolve()).finally(() => {
        this.held.delete(name);
        const queue = this.queues.get(name);
        queue?.shift();
        queue?.[0]?.();
      });
    };
    const queue = this.queues.get(name) ?? [];
    this.queues.set(name, queue);
    queue.push(run);
    if (!this.held.has(name) && queue.length === 1) run();
    return done.promise;
  }
}

class FakeBroadcastChannel {
  static readonly channels = new Map<string, Set<FakeBroadcastChannel>>();
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly sent: unknown[] = [];

  constructor(readonly name: string) {
    const peers = FakeBroadcastChannel.channels.get(name) ?? new Set();
    peers.add(this);
    FakeBroadcastChannel.channels.set(name, peers);
  }

  postMessage(message: unknown): void {
    this.sent.push(message);
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
  private readonly timers = new Set<() => void>();

  now = (): number => this.nowMs;
  setInterval = (callback: () => void): ReturnType<typeof globalThis.setInterval> => {
    this.timers.add(callback);
    return this.timers.size;
  };
  clearInterval = (_id: ReturnType<typeof globalThis.setInterval>): void => {};

  async advance(ms: number): Promise<void> {
    this.nowMs += ms;
    for (const callback of this.timers) callback();
    await settle();
  }
}

class FakeLeasePort implements PrivateProCoordinatorLeasePort {
  private current: { expiresAtMs: number; fence: number; ownerToken: string } | null = null;
  private ownerNumber = 0;

  async acquireCoordinatorLease(_uid: string, _name: string, nowMs: number, leaseMs: number) {
    if (this.current && this.current.expiresAtMs > nowMs) return null;
    this.current = {
      expiresAtMs: nowMs + leaseMs,
      fence: (this.current?.fence ?? 0) + 1,
      ownerToken: `owner-${++this.ownerNumber}`,
    };
    return { uid: 'uid', name: 'sync', ...this.current };
  }

  async renewCoordinatorLease(_uid: string, _name: string, fence: number, ownerToken: string, nowMs: number, leaseMs: number) {
    if (!this.current || this.current.expiresAtMs <= nowMs || this.current.fence !== fence || this.current.ownerToken !== ownerToken) return null;
    this.current.expiresAtMs = nowMs + leaseMs;
    return { uid: 'uid', name: 'sync', ...this.current };
  }

  async releaseCoordinatorLease(_uid: string, _name: string, fence: number, ownerToken: string): Promise<void> {
    if (this.current?.fence === fence && this.current.ownerToken === ownerToken) this.current.expiresAtMs = 0;
  }
}

function options(uid: string, extra: Partial<PrivateProSyncCoordinatorOptions> = {}): PrivateProSyncCoordinatorOptions {
  return { uid, broadcastChannel: FakeBroadcastChannel, ...extra };
}

function leaderRunner(started: string[], id: string): (signal: AbortSignal) => Promise<void> {
  return signal => new Promise(resolve => {
    started.push(id);
    signal.addEventListener('abort', resolve, { once: true });
  });
}


describe('Private Pro sync coordinator', () => {
  test('elects one Web Lock leader and lets the waiting follower take over after shutdown', async () => {
    const locks = new FakeLocks();
    const started: string[] = [];
    const first = createPrivateProSyncCoordinator(options('uid-a', { locks }));
    const second = createPrivateProSyncCoordinator(options('uid-a', { locks }));

    await Promise.all([first.start(leaderRunner(started, 'first')), second.start(leaderRunner(started, 'second'))]);
    await settle();
    assert.deepEqual(started, ['first']);
    assert.equal(first.isLeader(), true);
    assert.equal(second.isLeader(), false);

    await first.stop();
    await settle();
    assert.deepEqual(started, ['first', 'second']);
    assert.equal(second.isLeader(), true);
    await second.stop();
  });

  test('broadcasts a wake signal without carrying a workspace record payload', async () => {
    const received: unknown[] = [];
    const sender = createPrivateProSyncCoordinator(options('uid-a'));
    const receiver = createPrivateProSyncCoordinator(options('uid-a', { onWake: () => received.push('wake') }));

    await Promise.all([sender.start(async () => {}), receiver.start(async () => {})]);
    sender.wake();

    assert.deepEqual(received, ['wake']);
    await Promise.all([sender.stop(), receiver.stop()]);
  });

  test('broadcasts a signed-out signal when the coordinator stops', async () => {
    const received: string[] = [];
    const sender = createPrivateProSyncCoordinator(options('uid-a'));
    const receiver = createPrivateProSyncCoordinator(options('uid-a', { onSignedOut: () => received.push('signed-out') }));

    await Promise.all([sender.start(async () => {}), receiver.start(async () => {})]);
    await sender.stop();

    assert.deepEqual(received, ['signed-out']);
    await receiver.stop();
  });

  test('uses one fenced fallback leader and releases it for the waiting follower', async () => {
    const scheduler = new ManualScheduler();
    const leases = new FakeLeasePort();
    const started: string[] = [];
    const first = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));
    const second = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));

    await Promise.all([first.start(leaderRunner(started, 'first')), second.start(leaderRunner(started, 'second'))]);
    assert.deepEqual(started, ['first']);
    assert.equal(first.isLeader(), true);

    await first.stop();
    await scheduler.advance(5_000);
    assert.deepEqual(started, ['first', 'second']);
    assert.equal(second.isLeader(), true);
    await second.stop();
  });

  test('keeps renewing the current fallback lease before it expires', async () => {
    const scheduler = new ManualScheduler();
    const leases = new FakeLeasePort();
    const started: string[] = [];
    const first = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));
    const second = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));

    await Promise.all([first.start(leaderRunner(started, 'first')), second.start(leaderRunner(started, 'second'))]);
    await scheduler.advance(5_000);
    await scheduler.advance(5_000);
    await scheduler.advance(5_000);
    await scheduler.advance(5_000);
    await scheduler.advance(5_000);

    assert.deepEqual(started, ['first']);
    assert.equal(first.isLeader(), true);
    await Promise.all([first.stop(), second.stop()]);
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

    assert.deepEqual(started, ['first', 'second']);
    assert.equal(first.isLeader(), false);
    assert.equal(second.isLeader(), true);
    await Promise.all([first.stop(), second.stop()]);
  });

  test('releases a completed fallback leader lease so another coordinator can take over', async () => {
    const scheduler = new ManualScheduler();
    const leases = new FakeLeasePort();
    const started: string[] = [];
    const first = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));
    const second = createPrivateProSyncCoordinator(options('uid-a', { leases, ...scheduler }));

    await first.start(async () => { started.push('first'); });
    await second.start(leaderRunner(started, 'second'));
    await scheduler.advance(5_000);

    assert.deepEqual(started, ['first', 'second']);
    assert.equal(second.isLeader(), true);
    await Promise.all([first.stop(), second.stop()]);
  });
});
