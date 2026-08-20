import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { describe, mock, test, type TestContext } from 'node:test';
import Dexie, { type Transaction } from 'dexie';

import { DBlobAssetType, DBlobMimeType, type DBlobDBAsset } from '~/modules/dblobs/dblobs.types';
import { createPrivateProSyncEngine } from '../sync/privatePro.sync.engine';
import { PrivateProSyncDB } from '../sync/privatePro.sync.db';
import { PrivateProSyncTransportError } from '../sync/privatePro.sync.transport';
import {
  createPrivateProAssetClient,
  type PrivateProAssetStorageMetadata,
  type PrivateProAssetLockPort,
  type PrivateProAssetStoragePort,
  type PrivateProAssetUploadLeasePort,
} from './privatePro.assets.client';
import { createPrivateProAssetLocalPort } from './privatePro.assets.local';
import type { PrivateProAssetManifest } from './privatePro.assets.schemas';


const UID = 'uid-a';

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function base64(input: Uint8Array): string {
  let binary = '';
  for (const byte of input) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fixture(id = 'asset-1', withThumb = true): Extract<DBlobDBAsset, { assetType: DBlobAssetType.IMAGE }> {
  return {
    id,
    contextId: 'global',
    scopeId: 'attachment-drafts',
    assetType: DBlobAssetType.IMAGE,
    label: 'Exact image label',
    data: { mimeType: DBlobMimeType.IMG_PNG, base64: base64(bytes('original bytes')) },
    origin: { ot: 'generated', source: 'ai-text-to-image', generatorName: 'test-generator', prompt: 'test prompt', parameters: { seed: 7, nested: { strength: 0.5 } }, generatedAt: '2026-08-19T01:00:00.000Z' },
    metadata: { width: 1024, height: 768, averageColor: '#123456', tags: ['one', 'two'] },
    createdAt: new Date('2026-08-19T00:00:00.000Z'),
    updatedAt: new Date('2026-08-19T00:05:00.000Z'),
    cache: withThumb ? { thumb256: { mimeType: DBlobMimeType.IMG_WEBP, base64: base64(bytes('thumb bytes')) } } : {},
  };
}

class FakeStorage implements PrivateProAssetStoragePort {
  readonly uploads: Array<{ path: string; bytes: Uint8Array; metadata: PrivateProAssetStorageMetadata }> = [];
  readonly objects = new Map<string, { bytes: Uint8Array; metadata: PrivateProAssetStorageMetadata }>();
  readonly deletes: string[] = [];
  failUploadPath: string | null = null;
  failDeletePaths = new Set<string>();

  async uploadBytesResumable(path: string, input: Uint8Array, metadata: PrivateProAssetStorageMetadata, _signal?: AbortSignal): Promise<void> {
    this.uploads.push({ path, bytes: Uint8Array.from(input), metadata: structuredClone(metadata) });
    if (path === this.failUploadPath) throw new Error('upload unavailable');
    this.objects.set(path, { bytes: Uint8Array.from(input), metadata: structuredClone(metadata) });
  }

  async getBytes(path: string): Promise<Uint8Array> {
    const object = this.objects.get(path);
    if (!object) throw new Error('object unavailable');
    return Uint8Array.from(object.bytes);
  }

  async getMetadata(path: string): Promise<PrivateProAssetStorageMetadata> {
    const object = this.objects.get(path);
    if (!object) throw new Error('metadata unavailable');
    return structuredClone(object.metadata);
  }

  async deleteObject(path: string): Promise<void> {
    this.deletes.push(path);
    if (this.failDeletePaths.has(path)) throw new Error('delete unavailable');
    this.objects.delete(path);
  }
}

class MissingObjectError extends Error {
  readonly code = 'storage/object-not-found';
}

class FakeLocks implements PrivateProAssetLockPort {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly activeCallbacks = new Map<string, number>();
  async request<T>(name: string, signal: AbortSignal | undefined, callback: (lockSignal: AbortSignal | undefined) => Promise<T>): Promise<T> {
    const previous = this.tails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.catch(() => {}).then(() => tail);
    this.tails.set(name, queued);
    await previous.catch(() => {});
    if (signal?.aborted) { release(); throw new DOMException('aborted', 'AbortError'); }
    this.activeCallbacks.set(name, (this.activeCallbacks.get(name) ?? 0) + 1);
    try { return await callback(signal); }
    finally {
      const active = (this.activeCallbacks.get(name) ?? 1) - 1;
      if (active) this.activeCallbacks.set(name, active);
      else this.activeCallbacks.delete(name);
      release();
      if (this.tails.get(name) === queued) this.tails.delete(name);
    }
  }

  active(name: string): number { return this.activeCallbacks.get(name) ?? 0; }
}

function harness(t: TestContext) {
  const name = `private-pro-assets-${crypto.randomUUID()}`;
  const db = new PrivateProSyncDB(name);
  const local = createPrivateProAssetLocalPort(UID, db);
  const storage = new FakeStorage();
  let wakes = 0;
  const locks = new FakeLocks();
  let nowMs = 0;
  const client = createPrivateProAssetClient(UID, storage, { wake: () => { wakes++; } }, local, locks, leaseFallback(db), {
    port: db,
    now: () => nowMs,
  });
  t.after(async () => {
    db.close();
    await Dexie.delete(name);
  });
  return { client, db, local, storage, locks, wakes: () => wakes, setNow: (value: number) => { nowMs = value; } };
}

function leaseFallback(db: PrivateProSyncDB) {
  return { port: db, leaseMs: 80, renewEveryMs: 15, retryEveryMs: 2 };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(resolve_ => { resolve = resolve_; });
  return { promise, resolve };
}

describe('Private Pro direct assets', () => {
  test('uploads decoded original and thumbnail bytes before exposing the manifest', async (t) => {
    const { client, local, storage } = harness(t);
    const asset = fixture();
    await local.putAsset(asset);

    await client.ensureUploaded([asset.id]);

    assert.deepEqual(storage.uploads.map(upload => [upload.path, new TextDecoder().decode(upload.bytes)]), [
      [`users/${UID}/workspace-v1/assets/${asset.id}/original`, 'original bytes'],
      [`users/${UID}/workspace-v1/assets/${asset.id}/thumb256`, 'thumb bytes'],
    ]);
    const manifest = await local.getManifest(asset.id);
    assert.equal(manifest?.objects.original.objectId, 'original');
    assert.equal(manifest?.objects.thumb256?.objectId, 'thumb256');
  });

  test('keeps a failed manifest pending and retries the same deterministic object path', async (t) => {
    const { client, local, storage } = harness(t);
    const asset = fixture('asset-retry', false);
    await local.putAsset(asset);
    storage.failUploadPath = `users/${UID}/workspace-v1/assets/${asset.id}/original`;

    await assert.rejects(client.ensureUploaded([asset.id]));
    assert.equal(await local.getManifest(asset.id), undefined);
    storage.failUploadPath = null;
    await client.ensureUploaded([asset.id]);

    assert.deepEqual(storage.uploads.map(upload => upload.path), [
      `users/${UID}/workspace-v1/assets/${asset.id}/original`,
      `users/${UID}/workspace-v1/assets/${asset.id}/original`,
    ]);
  });

  test('does not publish an uploaded manifest when content changes during upload', async (t) => {
    const { client, local, storage } = harness(t);
    const asset = fixture('asset-edit-upload', false);
    await local.putAsset(asset);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const upload = storage.uploadBytesResumable.bind(storage);
    storage.uploadBytesResumable = async (...args) => { started(); await gate; return upload(...args); };

    const uploading = client.ensureUploaded([asset.id]);
    await startedPromise;
    await local.putAsset({ ...asset, label: 'edited during upload' });
    release();
    await assert.rejects(uploading);

    assert.equal(await local.getManifest(asset.id), undefined);
    assert.equal((await local.getAssetState(asset.id))?.contentGeneration, 2);
  });

  test('does not overwrite a newer published manifest when an older upload finishes late', async (t) => {
    const { client, local, storage } = harness(t);
    const asset = fixture('asset-late-manifest', false);
    await local.putAsset(asset);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const upload = storage.uploadBytesResumable.bind(storage);
    let calls = 0;
    storage.uploadBytesResumable = async (...args) => { if (calls++ === 0) { started(); await gate; } return upload(...args); };
    const oldUpload = client.ensureUploaded([asset.id]);
    await startedPromise;
    await local.putAsset({ ...asset, label: 'newer' });
    storage.uploadBytesResumable = upload;
    const newerUpload = client.ensureUploaded([asset.id]);
    release();
    await assert.rejects(oldUpload);
    await newerUpload;
    const newer = await local.getManifest(asset.id);

    assert.equal((await local.getManifest(asset.id))?.contentGeneration, 2);
    assert.deepEqual(await local.getManifest(asset.id), newer);
  });

  test('serializes fixed-path uploads so a newer ensure leaves new bytes and manifest', async (t) => {
    const { client, local, storage } = harness(t);
    const oldAsset = fixture('asset-serialized', false);
    await local.putAsset(oldAsset);
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const upload = storage.uploadBytesResumable.bind(storage);
    let first = true;
    storage.uploadBytesResumable = async (...args) => {
      if (first) { first = false; started(); await gate; }
      return upload(...args);
    };
    const oldEnsure = client.ensureUploaded([oldAsset.id]);
    await startedPromise;
    const newAsset = { ...oldAsset, label: 'new', data: { ...oldAsset.data, base64: base64(bytes('new original bytes')) } };
    await local.putAsset(newAsset);
    const newEnsure = client.ensureUploaded([oldAsset.id]);
    release();
    await assert.rejects(oldEnsure);
    await newEnsure;

    assert.equal(new TextDecoder().decode(storage.objects.get(`users/${UID}/workspace-v1/assets/${oldAsset.id}/original`)!.bytes), 'new original bytes');
    assert.equal((await local.getManifest(oldAsset.id))?.contentGeneration, 2);
  });

  test('an aborted upload queue does not poison a later ensure', async (t) => {
    const { client, local, storage } = harness(t);
    const asset = fixture('asset-abort-queue', false);
    await local.putAsset(asset);
    const controller = new AbortController();
    storage.uploadBytesResumable = async (_path, _bytes, _metadata, signal) => new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    const aborted = client.ensureUploaded([asset.id], controller.signal);
    controller.abort();
    await assert.rejects(aborted, { name: 'AbortError' });
    storage.uploadBytesResumable = FakeStorage.prototype.uploadBytesResumable.bind(storage);

    await client.ensureUploaded([asset.id]);

    assert.equal((await local.getManifest(asset.id))?.contentGeneration, 1);
  });

  test('serializes uploads across client instances and leadership abort releases the lock', async (t) => {
    const { db, local, storage, locks } = harness(t);
    const oldAsset = fixture('asset-cross-client', false);
    await local.putAsset(oldAsset);
    const oldClient = createPrivateProAssetClient(UID, storage, { wake: () => {} }, local, locks, leaseFallback(db));
    const newClient = createPrivateProAssetClient(UID, storage, { wake: () => {} }, local, locks, leaseFallback(db));
    const controller = new AbortController();
    let started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    storage.uploadBytesResumable = async (_path, _bytes, _metadata, signal) => new Promise<void>((_resolve, reject) => {
      started();
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    const oldUpload = oldClient.ensureUploaded([oldAsset.id], controller.signal);
    await startedPromise;
    const newAsset = { ...oldAsset, data: { ...oldAsset.data, base64: base64(bytes('cross-client-new')) } };
    await local.putAsset(newAsset);
    storage.uploadBytesResumable = FakeStorage.prototype.uploadBytesResumable.bind(storage);
    const newUpload = newClient.ensureUploaded([oldAsset.id]);
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(oldUpload, { name: 'AbortError' });
    await newUpload;

    assert.equal(new TextDecoder().decode(storage.objects.get(`users/${UID}/workspace-v1/assets/${oldAsset.id}/original`)!.bytes), 'cross-client-new');
  });

  test('rejects before Storage when a Web Lock exists without a durable DB lease', async (t) => {
    const { local, storage } = harness(t);
    const asset = fixture('asset-lock-unavailable', false);
    await local.putAsset(asset);
    const client = createPrivateProAssetClient(UID, storage, { wake: () => {} }, local, new FakeLocks());

    await assert.rejects(client.ensureUploaded([asset.id]), error => error instanceof TypeError && /upload lease/i.test(error.message));

    assert.equal(storage.uploads.length, 0);
  });

  test('serializes Web-Locked and no-Web-Locks clients through one durable lease domain', async (t) => {
    const { db, local, storage, locks } = harness(t);
    const oldAsset = fixture('asset-mixed-lock-domain', false);
    await local.putAsset(oldAsset);
    const webLockedClient = createPrivateProAssetClient(UID, storage, { wake: () => {} }, local, locks, leaseFallback(db));
    const noWebLocksClient = createPrivateProAssetClient(UID, storage, { wake: () => {} }, local, null, leaseFallback(db));
    const upload = FakeStorage.prototype.uploadBytesResumable.bind(storage);
    const controller = new AbortController();
    const firstStarted = deferred();
    let firstCall = true;
    let concurrent = 0;
    let maxConcurrent = 0;
    storage.uploadBytesResumable = async (...args) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        if (firstCall) {
          firstCall = false;
          firstStarted.resolve();
          const signal = args[3];
          await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(new DOMException('aborted', 'AbortError'));
            if (signal?.aborted) abort();
            else signal?.addEventListener('abort', abort, { once: true });
          });
        }
        await upload(...args);
      } finally {
        concurrent--;
      }
    };

    const oldUpload = webLockedClient.ensureUploaded([oldAsset.id], controller.signal);
    await firstStarted.promise;
    const newAsset = { ...oldAsset, data: { ...oldAsset.data, base64: base64(bytes('mixed-domain-new')) } };
    await local.putAsset(newAsset);
    const newUpload = noWebLocksClient.ensureUploaded([oldAsset.id]);
    await delay(20);
    const maxBeforeCancellation = maxConcurrent;
    controller.abort();
    await assert.rejects(oldUpload, { name: 'AbortError' });
    await newUpload;

    assert.equal(maxBeforeCancellation, 1);
    assert.equal(maxConcurrent, 1);
    assert.equal(new TextDecoder().decode(storage.objects.get(`users/${UID}/workspace-v1/assets/${oldAsset.id}/original`)!.bytes), 'mixed-domain-new');
    assert.equal((await local.getManifest(oldAsset.id))?.contentGeneration, 2);
  });

  test('renews a durable DB lease while two no-Web-Locks clients serialize one fixed path', async (t) => {
    const { db, local, storage } = harness(t);
    const asset = fixture('asset-db-lease-serialized', false);
    await local.putAsset(asset);
    const renewalObserved = deferred();
    let renewals = 0;
    const observingLeasePort: PrivateProAssetUploadLeasePort = {
      acquireAssetUploadLease: (...args) => db.acquireAssetUploadLease(...args),
      async renewAssetUploadLease(...args) {
        renewals++;
        renewalObserved.resolve();
        return db.renewAssetUploadLease(...args);
      },
      releaseAssetUploadLease: (...args) => db.releaseAssetUploadLease(...args),
      ownsAssetUploadLease: (...args) => db.ownsAssetUploadLease(...args),
    };
    const leaseOptions = { port: observingLeasePort, leaseMs: 60_000, renewEveryMs: 10, retryEveryMs: 2 };
    const firstClient = createPrivateProAssetClient(UID, storage, { wake: () => {} }, local, null, leaseOptions);
    const secondClient = createPrivateProAssetClient(UID, storage, { wake: () => {} }, local, null, leaseOptions);
    const upload = storage.uploadBytesResumable.bind(storage);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    storage.uploadBytesResumable = async (...args) => {
      const call = calls++;
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        if (call === 0) { started(); await gate; }
        await upload(...args);
      } finally {
        concurrent--;
      }
    };

    const first = firstClient.ensureUploaded([asset.id]);
    await startedPromise;
    const second = secondClient.ensureUploaded([asset.id]);
    await renewalObserved.promise;
    const observedMax = maxConcurrent;
    release();
    await Promise.all([first, second]);

    assert.ok(renewals >= 1);
    assert.equal(observedMax, 1);
    assert.equal(maxConcurrent, 1);
  });

  test('releases an aborted durable DB lease so a second no-Web-Locks client completes', async (t) => {
    const { db, local, storage } = harness(t);
    const asset = fixture('asset-db-lease-abort', false);
    await local.putAsset(asset);
    const firstClient = createPrivateProAssetClient(UID, storage, { wake: () => {} }, local, null, leaseFallback(db));
    const secondClient = createPrivateProAssetClient(UID, storage, { wake: () => {} }, local, null, leaseFallback(db));
    const upload = storage.uploadBytesResumable.bind(storage);
    const controller = new AbortController();
    let firstCall = true;
    let started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    let secondEntered = false;
    storage.uploadBytesResumable = async (...args) => {
      if (!firstCall) {
        secondEntered = true;
        return upload(...args);
      }
      firstCall = false;
      started();
      const signal = args[3];
      return new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    };

    const first = firstClient.ensureUploaded([asset.id], controller.signal);
    await startedPromise;
    const second = secondClient.ensureUploaded([asset.id]);
    await delay(10);
    const enteredBeforeAbort = secondEntered;
    controller.abort();
    await assert.rejects(first, { name: 'AbortError' });
    await second;

    assert.equal(enteredBeforeAbort, false);
    assert.equal(secondEntered, true);
  });

  test('expires a stalled renewal before a successor publishes and prevents the stale fixed-path overwrite', async (t) => {
    const { db, local, storage } = harness(t);
    const oldAsset = fixture('asset-expired-renewal', false);
    await local.putAsset(oldAsset);
    const renewalStarted = deferred();
    const releaseRenewal = deferred();
    const stalledLeasePort: PrivateProAssetUploadLeasePort = {
      acquireAssetUploadLease: (...args) => db.acquireAssetUploadLease(...args),
      async renewAssetUploadLease(...args) {
        renewalStarted.resolve();
        await releaseRenewal.promise;
        return db.renewAssetUploadLease(...args);
      },
      releaseAssetUploadLease: (...args) => db.releaseAssetUploadLease(...args),
      ownsAssetUploadLease: (...args) => db.ownsAssetUploadLease(...args),
    };
    const leaseConfig = { leaseMs: 60, renewEveryMs: 10, retryEveryMs: 2 };
    const staleClient = createPrivateProAssetClient(UID, storage, { wake: () => {} }, local, null, { port: stalledLeasePort, ...leaseConfig });
    const successorClient = createPrivateProAssetClient(UID, storage, { wake: () => {} }, local, null, { port: db, ...leaseConfig });
    const upload = FakeStorage.prototype.uploadBytesResumable.bind(storage);
    const staleStorageStarted = deferred();
    const releaseStaleStorage = deferred();
    let firstCall = true;
    let staleCancelled = false;
    let staleWrote = false;
    storage.uploadBytesResumable = async (...args) => {
      if (!firstCall) return upload(...args);
      firstCall = false;
      staleStorageStarted.resolve();
      const signal = args[3];
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const abort = () => {
          if (settled) return;
          settled = true;
          staleCancelled = true;
          reject(new DOMException('aborted', 'AbortError'));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
        void releaseStaleStorage.promise.then(() => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', abort);
          resolve();
        });
      });
      await upload(...args);
      staleWrote = true;
    };

    const staleUpload = staleClient.ensureUploaded([oldAsset.id]);
    staleUpload.catch(() => {});
    await Promise.all([staleStorageStarted.promise, renewalStarted.promise]);
    const newAsset = { ...oldAsset, data: { ...oldAsset.data, base64: base64(bytes('successor-generation-two')) } };
    await local.putAsset(newAsset);
    await successorClient.ensureUploaded([oldAsset.id]);
    releaseStaleStorage.resolve();
    await delay(5);
    releaseRenewal.resolve();
    await assert.rejects(staleUpload, { name: 'AbortError' });

    assert.equal(staleCancelled, true);
    assert.equal(staleWrote, false);
    assert.equal(new TextDecoder().decode(storage.objects.get(`users/${UID}/workspace-v1/assets/${oldAsset.id}/original`)!.bytes), 'successor-generation-two');
    assert.equal((await local.getManifest(oldAsset.id))?.contentGeneration, 2);
  });

  test('a renewal that never settles cannot pin upload cleanup or its Web Lock', async (t) => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    t.after(() => mock.timers.reset());
    const { db, local, storage, locks } = harness(t);
    const asset = fixture('asset-never-renewed', false);
    await local.putAsset(asset);
    const renewalStarted = deferred();
    const never = new Promise<never>(() => {});
    const stalledLeasePort: PrivateProAssetUploadLeasePort = {
      acquireAssetUploadLease: (...args) => db.acquireAssetUploadLease(...args),
      renewAssetUploadLease: async () => { renewalStarted.resolve(); return never; },
      releaseAssetUploadLease: (...args) => db.releaseAssetUploadLease(...args),
      ownsAssetUploadLease: (...args) => db.ownsAssetUploadLease(...args),
    };
    const leaseConfig = {
      leaseMs: 60,
      renewEveryMs: 10,
      retryEveryMs: 2,
      now: Date.now,
    };
    const stalledClient = createPrivateProAssetClient(UID, storage, { wake: () => {} }, local, locks, { port: stalledLeasePort, ...leaseConfig });
    const successorClient = createPrivateProAssetClient(UID, storage, { wake: () => {} }, local, locks, { port: db, ...leaseConfig });
    const upload = FakeStorage.prototype.uploadBytesResumable.bind(storage);
    const storageStarted = deferred();
    let storageAborted = false;
    let firstCall = true;
    storage.uploadBytesResumable = async (...args) => {
      if (!firstCall) return upload(...args);
      firstCall = false;
      storageStarted.resolve();
      const signal = args[3];
      await new Promise<void>((_resolve, reject) => {
        const abort = () => {
          storageAborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    };

    let stalledSettled = false;
    const stalledUpload = stalledClient.ensureUploaded([asset.id]).finally(() => { stalledSettled = true; });
    stalledUpload.catch(() => {});
    await storageStarted.promise;
    mock.timers.tick(10);
    await Promise.resolve();
    await renewalStarted.promise;
    mock.timers.tick(50);
    for (let index = 0; index < 10; index++) {
      await Promise.resolve();
      await new Promise<void>(resolve => setImmediate(resolve));
    }

    const lockName = `private-pro-asset-upload:${UID}:${asset.id}`;
    assert.equal(storageAborted, true);
    assert.equal(stalledSettled, true);
    assert.equal(locks.active(lockName), 0);
    await assert.rejects(stalledUpload, { name: 'AbortError' });

    await successorClient.ensureUploaded([asset.id]);
    assert.equal((await local.getManifest(asset.id))?.contentGeneration, 1);
  });

  test('successful renewals reschedule expiry fencing for a long Web-Locked upload', async (t) => {
    const { db, local, storage, locks } = harness(t);
    const asset = fixture('asset-renewal-reschedule', false);
    await local.putAsset(asset);
    let renewals = 0;
    let ownershipChecks = 0;
    const observingLeasePort = {
      acquireAssetUploadLease: (...args: Parameters<PrivateProAssetUploadLeasePort['acquireAssetUploadLease']>) => db.acquireAssetUploadLease(...args),
      renewAssetUploadLease: (...args: Parameters<PrivateProAssetUploadLeasePort['renewAssetUploadLease']>) => {
        renewals++;
        return db.renewAssetUploadLease(...args);
      },
      releaseAssetUploadLease: (...args: Parameters<PrivateProAssetUploadLeasePort['releaseAssetUploadLease']>) => db.releaseAssetUploadLease(...args),
      ownsAssetUploadLease: (...args: Parameters<PrivateProAssetUploadLeasePort['ownsAssetUploadLease']>) => {
        ownershipChecks++;
        return db.ownsAssetUploadLease(...args);
      },
    };
    const client = createPrivateProAssetClient(UID, storage, { wake: () => {} }, local, locks, {
      port: observingLeasePort, leaseMs: 80, renewEveryMs: 15, retryEveryMs: 2,
    });
    const upload = FakeStorage.prototype.uploadBytesResumable.bind(storage);
    storage.uploadBytesResumable = async (...args) => {
      const signal = args[3];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 160);
        const abort = () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
      await upload(...args);
    };

    await client.ensureUploaded([asset.id]);

    assert.ok(renewals >= 2);
    assert.ok(ownershipChecks >= 3);
    assert.equal((await local.getManifest(asset.id))?.contentGeneration, 1);
  });

  test('rejects an oversized manifest before any Storage call', async (t) => {
    const { client, local, storage } = harness(t);
    const asset = { ...fixture('asset-oversized', false), label: 'x'.repeat(513) };
    await local.putAsset(asset);

    await assert.rejects(client.ensureUploaded([asset.id]), /too|length|large/i);

    assert.equal(storage.uploads.length, 0);
  });

  for (const [code, category] of [['storage/unauthorized', 'permission'], ['storage/quota-exceeded', 'quota'], ['storage/resource-exhausted', 'quota']] as const) {
    test(`maps ${code} to ${category}`, async (t) => {
      const { client, local, storage } = harness(t);
      const asset = fixture(`asset-${category}-${code}`, false);
      await local.putAsset(asset);
      storage.uploadBytesResumable = async () => { throw Object.assign(new Error('storage failed'), { code }); };

      await assert.rejects(client.ensureUploaded([asset.id]), error => error instanceof PrivateProSyncTransportError && error.category === category);
    });
  }

  test('hydrates exact DBlob values after validating metadata, hash, size, MIME, and UID', async (t) => {
    const source = harness(t);
    const asset = fixture('asset-hydrate');
    await source.local.putAsset(asset);
    await source.client.ensureUploaded([asset.id]);
    const manifest = await source.local.getManifest(asset.id);
    assert.ok(manifest);
    await source.local.deleteAsset(asset.id);
    await source.local.putManifest(manifest);

    await source.client.hydrate([asset.id]);

    assert.deepEqual(await source.local.getAsset(asset.id), asset);
    assert.deepEqual(await source.local.getManifest(asset.id), manifest);
    assert.ok((await source.local.getAsset(asset.id))?.createdAt instanceof Date);
  });

  test('does not overwrite a concurrent local edit when hydration finishes', async (t) => {
    const source = harness(t);
    const asset = fixture('asset-hydrate-cas', false);
    await source.local.putAsset(asset);
    await source.client.ensureUploaded([asset.id]);
    await source.local.deleteAsset(asset.id);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const getBytes = source.storage.getBytes.bind(source.storage);
    source.storage.getBytes = async path => { await gate; return getBytes(path); };
    const hydrating = source.client.hydrate([asset.id]);
    const edited = { ...asset, label: 'local edit', data: { ...asset.data, base64: base64(bytes('local new')) } };
    await source.local.putAsset(edited);
    release();
    await hydrating;

    assert.deepEqual(await source.local.getAsset(asset.id), edited);
    assert.equal((await source.local.getAssetState(asset.id))?.contentGeneration, 2);
  });

  test('aborts hydration at the final CAS write and leaves a cleared asset absent', async (t) => {
    const source = harness(t);
    const asset = fixture('asset-hydrate-abort', false);
    await source.local.putAsset(asset);
    await source.client.ensureUploaded([asset.id]);
    const manifest = await source.local.getManifest(asset.id);
    assert.ok(manifest);
    await source.local.deleteAsset(asset.id);
    await source.local.putManifest(manifest);
    const controller = new AbortController();
    const abort = (_modifications: object, _key: unknown, _value: unknown, transaction: Transaction) => {
      controller.abort();
      transaction.abort();
    };
    source.db.assets.hook('updating').subscribe(abort);

    await assert.rejects(source.client.hydrate([asset.id], controller.signal), { name: 'AbortError' });
    source.db.assets.hook('updating').unsubscribe(abort);
    await source.db.clearUid(UID);

    assert.equal(await source.local.getAssetState(asset.id), undefined);
  });

  test('engine stop aborts hydration at the final CAS write before UID clear', async (t) => {
    const source = harness(t);
    const asset = fixture('asset-hydrate-engine-stop', false);
    await source.local.putAsset(asset);
    await source.client.ensureUploaded([asset.id]);
    const manifest = await source.local.getManifest(asset.id);
    assert.ok(manifest);
    await source.local.deleteAsset(asset.id);
    await source.local.putManifest(manifest);
    const atFinalPut = deferred();
    const releaseFinalPut = deferred();
    const holdPut = () => {
      atFinalPut.resolve();
      return releaseFinalPut.promise;
    };
    source.db.assets.hook('updating').subscribe(holdPut);
    let hydrate!: (assetIds: readonly string[], signal?: AbortSignal) => Promise<void>;
    let triggerHydration!: () => void;
    const engine = createPrivateProSyncEngine({
      uid: UID,
      serializers: [],
      db: { pendingCount: async () => 0 },
      transport: { write: async () => { throw new Error('unused'); }, listen: () => () => {} },
      assets: { ensureUploaded: async () => {}, hydrate: (assetIds, signal) => hydrate(assetIds, signal) },
      runSuppressed: callback => callback(),
      createOutbound: () => ({
        start: async () => {}, retryNow: async () => {}, flushNow: async () => {}, wake: () => {},
        handleCommitted: async () => {}, stop: async () => {},
      }),
      createReconciler: hooks => {
        triggerHydration = () => hooks.onHydrate?.([asset.id], 1);
        return { applyCached: async () => {}, handle: async () => {} };
      },
    });
    hydrate = source.client.hydrate.bind(source.client);
    await engine.start();
    triggerHydration();
    await atFinalPut.promise;

    await engine.stop();
    await source.db.clearUid(UID);
    releaseFinalPut.resolve();
    await Promise.resolve();
    source.db.assets.hook('updating').unsubscribe(holdPut);

    assert.equal(await source.local.getAssetState(asset.id), undefined);
  });

  test('rejects a cross-account manifest without reading any object', async (t) => {
    const { client, local, storage } = harness(t);
    const manifest = {
      formatVersion: 1,
      schemaVersion: 1,
      uid: 'uid-b',
      assetId: 'asset-cross-account',
      contentGeneration: 1,
      assetType: 'image',
      contextId: 'global',
      scopeId: 'app-chat',
      label: 'invalid',
      origin: { ot: 'user', source: 'attachment', media: 'file-open' },
      createdAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:00.000Z',
      metadata: { width: 1, height: 1 },
      objects: { original: { objectId: 'original', kind: 'original', mimeType: 'image/png', byteSize: 1, sha256: 'a'.repeat(64) } },
    } as PrivateProAssetManifest;
    await assert.rejects(local.putManifest(manifest), /manifest identity/i);
    await client.hydrate([manifest.assetId]);
    assert.equal(storage.objects.size, 0);
  });

  test('deletes the manifest canonically and attempts both fixed object cleanups', async (t) => {
    const { client, local, storage, wakes } = harness(t);
    const asset = fixture('asset-delete');
    await local.putAsset(asset);
    await client.ensureUploaded([asset.id]);
    storage.failDeletePaths.add(`users/${UID}/workspace-v1/assets/${asset.id}/original`);

    await assert.rejects(client.delete(asset.id), /cleanup failed/i);

    assert.equal(await local.getManifest(asset.id), undefined);
    assert.equal(await local.getAsset(asset.id), undefined);
    assert.deepEqual(storage.deletes.sort(), [
      `users/${UID}/workspace-v1/assets/${asset.id}/original`,
      `users/${UID}/workspace-v1/assets/${asset.id}/thumb256`,
    ].sort());
    assert.ok(wakes() >= 2);
  });

  test('persists partial cleanup debt and a restarted client retries only the remaining fixed object', async (t) => {
    const { client, db, local, storage } = harness(t);
    const asset = fixture('asset-cleanup-restart');
    await local.putAsset(asset);
    await client.ensureUploaded([asset.id]);
    const originalPath = `users/${UID}/workspace-v1/assets/${asset.id}/original`;
    const thumbPath = `users/${UID}/workspace-v1/assets/${asset.id}/thumb256`;
    storage.failDeletePaths.add(thumbPath);

    await assert.rejects(client.delete(asset.id), /cleanup failed/i);

    assert.equal(storage.objects.has(originalPath), false);
    assert.equal(storage.objects.has(thumbPath), true);
    const debt = await db.assetCleanupDebt.get([UID, asset.id]);
    assert.deepEqual(debt, {
      uid: UID,
      assetId: asset.id,
      objectKinds: ['thumb256'],
      attemptCount: 1,
      nextAttemptAtMs: 1_000,
      leaseUntilMs: null,
      leaseToken: null,
      leaseFence: null,
      errorCategory: 'unknown',
    });
    assert.equal(JSON.stringify(debt).includes('users/'), false);
    assert.equal(JSON.stringify(debt).includes('original bytes'), false);

    storage.failDeletePaths.clear();
    const restarted = createPrivateProAssetClient(UID, storage, { wake: () => {} }, local, null, leaseFallback(db), {
      port: db,
      now: () => 1_000,
    });
    await restarted.processCleanupDebt();

    assert.equal(storage.objects.has(thumbPath), false);
    assert.equal(await db.assetCleanupDebt.get([UID, asset.id]), undefined);
  });

  test('treats already missing fixed objects as an idempotent delete success', async (t) => {
    const { client, local, storage } = harness(t);
    const asset = fixture('asset-delete-missing', false);
    await local.putAsset(asset);
    await client.ensureUploaded([asset.id]);
    storage.deleteObject = async path => { storage.deletes.push(path); throw new MissingObjectError(); };

    await client.delete(asset.id);

    assert.equal(await local.getManifest(asset.id), undefined);
    assert.equal(storage.deletes.length, 2);
  });
});
