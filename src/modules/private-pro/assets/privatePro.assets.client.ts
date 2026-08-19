import { deleteObject, getBytes, getMetadata, ref, uploadBytesResumable, type FullMetadata, type UploadTask } from 'firebase/storage';

import type { DBlobDBAsset } from '~/modules/dblobs/dblobs.types';
import { getPrivateProClientStorage } from '../firebase/firebase.client';
import { assertPrivateProPayloadSize, privateProCanonicalJson, privateProContentHash } from '../sync/privatePro.sync.codec';
import type { PrivateProAssetUploadLease } from '../sync/privatePro.sync.db';
import { PrivateProSyncTransportError } from '../sync/privatePro.sync.transport';
import type { PrivateProAssetActivationGuard, PrivateProAssetLocalPort } from './privatePro.assets.local';
import {
  PrivateProAssetManifestSchema,
  PrivateProAssetStorageCustomMetadataSchema,
  type PrivateProAssetManifest,
  type PrivateProAssetObjectKind,
} from './privatePro.assets.schemas';


export interface PrivateProAssetStorageMetadata {
  contentType: string;
  customMetadata: { uid: string; assetId: string; kind: PrivateProAssetObjectKind; sha256: string };
}

export interface PrivateProAssetStoragePort {
  uploadBytesResumable(path: string, bytes: Uint8Array, metadata: PrivateProAssetStorageMetadata, signal?: AbortSignal): Promise<void>;
  getBytes(path: string, signal?: AbortSignal): Promise<Uint8Array>;
  getMetadata(path: string, signal?: AbortSignal): Promise<PrivateProAssetStorageMetadata>;
  deleteObject(path: string): Promise<void>;
}

export interface PrivateProAssetManifestTransport {
  wake(): void;
}

export interface PrivateProAssetLockPort {
  request<T>(name: string, signal: AbortSignal | undefined, callback: (lockSignal: AbortSignal | undefined) => Promise<T>): Promise<T>;
}

export interface PrivateProAssetUploadLeasePort {
  acquireAssetUploadLease(uid: string, assetId: string, nowMs: number, leaseMs: number): Promise<PrivateProAssetUploadLease | null>;
  renewAssetUploadLease(uid: string, assetId: string, fence: number, ownerToken: string, nowMs: number, leaseMs: number): Promise<PrivateProAssetUploadLease | null>;
  ownsAssetUploadLease(uid: string, assetId: string, fence: number, ownerToken: string, expiresAtMs: number, nowMs: number): Promise<boolean>;
  releaseAssetUploadLease(uid: string, assetId: string, fence: number, ownerToken: string): Promise<void>;
}

export interface PrivateProAssetUploadLeaseOptions {
  port: PrivateProAssetUploadLeasePort;
  leaseMs?: number;
  renewEveryMs?: number;
  retryEveryMs?: number;
  now?: () => number;
}

export interface PrivateProAssetClient {
  ensureUploaded(assetIds: readonly string[], signal?: AbortSignal): Promise<void>;
  hydrate(assetIds: readonly string[], signal?: AbortSignal): Promise<void>;
  delete(assetId: string, guard?: PrivateProAssetActivationGuard): Promise<void>;
  clearLocal(): Promise<void>;
}

interface PrivateProAssetUploadLeaseGuard {
  readonly signal: AbortSignal;
  assertOwned(): Promise<void>;
}

interface PrivateProAssetDurableLeasePort {
  request<T>(assetId: string, signal: AbortSignal | undefined, callback: (guard: PrivateProAssetUploadLeaseGuard) => Promise<T>): Promise<T>;
}

function objectPath(uid: string, assetId: string, kind: PrivateProAssetObjectKind): string {
  return `users/${uid}/workspace-v1/assets/${assetId}/${kind}`;
}

function base64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000)
    parts.push(String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.byteLength))));
  return btoa(parts.join(''));
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Private Pro attachment operation aborted.', 'AbortError');
}

function firebaseStoragePort(): PrivateProAssetStoragePort {
  const storage = getPrivateProClientStorage();
  const upload = (task: UploadTask, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    const abort = () => {
      task.cancel();
      reject(new DOMException('Private Pro attachment upload aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    task.on('state_changed', undefined, error => {
      signal?.removeEventListener('abort', abort);
      reject(error);
    }, () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    });
    if (signal?.aborted) abort();
  });
  const toMetadata = (metadata: FullMetadata): PrivateProAssetStorageMetadata => ({
    contentType: metadata.contentType ?? '',
    customMetadata: PrivateProAssetStorageCustomMetadataSchema.parse(metadata.customMetadata ?? {}),
  });
  return {
    uploadBytesResumable: (path, bytes, metadata, signal) => upload(uploadBytesResumable(ref(storage, path), bytes, metadata), signal),
    async getBytes(path, signal) {
      abortIfNeeded(signal);
      const bytes = new Uint8Array(await getBytes(ref(storage, path)));
      abortIfNeeded(signal);
      return bytes;
    },
    async getMetadata(path, signal) {
      abortIfNeeded(signal);
      const metadata = toMetadata(await getMetadata(ref(storage, path)));
      abortIfNeeded(signal);
      return metadata;
    },
    deleteObject: path => deleteObject(ref(storage, path)),
  };
}

async function objectManifest(kind: PrivateProAssetObjectKind, mimeType: string, bytes: Uint8Array) {
  return { objectId: kind, kind, mimeType, byteSize: bytes.byteLength, sha256: await sha256(bytes) } as const;
}

async function manifestFromAsset(uid: string, asset: DBlobDBAsset, contentGeneration: number): Promise<{ manifest: PrivateProAssetManifest; manifestHash: string; bytes: Map<PrivateProAssetObjectKind, Uint8Array> }> {
  const original = base64Bytes(asset.data.base64);
  const objects = new Map<PrivateProAssetObjectKind, Uint8Array>([['original', original]]);
  const originalManifest = await objectManifest('original', asset.data.mimeType, original);
  const common = {
    formatVersion: 1, schemaVersion: 1, uid, assetId: asset.id, contentGeneration, contextId: asset.contextId, scopeId: asset.scopeId,
    label: asset.label, origin: structuredClone(asset.origin), createdAt: asset.createdAt.toISOString(), updatedAt: asset.updatedAt.toISOString(),
  } as const;
  if (asset.assetType === 'audio') {
    const manifest = PrivateProAssetManifestSchema.parse({ ...common, assetType: 'audio', metadata: structuredClone(asset.metadata), objects: { original: originalManifest } });
    const payload = privateProCanonicalJson(manifest); assertPrivateProPayloadSize(payload);
    return { manifest, manifestHash: await privateProContentHash(payload), bytes: objects };
  }
  const thumb = asset.cache.thumb256 ? base64Bytes(asset.cache.thumb256.base64) : undefined;
  if (thumb) objects.set('thumb256', thumb);
  const manifest = PrivateProAssetManifestSchema.parse({
      ...common, assetType: 'image', metadata: structuredClone(asset.metadata),
      objects: { original: originalManifest, ...(thumb && { thumb256: await objectManifest('thumb256', asset.cache.thumb256!.mimeType, thumb) }) },
    });
  const payload = privateProCanonicalJson(manifest); assertPrivateProPayloadSize(payload);
  return { manifest, manifestHash: await privateProContentHash(payload), bytes: objects };
}

function storageError(error: unknown): never {
  if (error instanceof DOMException && error.name === 'AbortError') throw error;
  if (error instanceof TypeError || error instanceof RangeError || error instanceof PrivateProSyncTransportError) throw error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === 'storage/unauthorized' || code === 'storage/unauthenticated') throw new PrivateProSyncTransportError('permission');
  if (code === 'storage/quota-exceeded' || code === 'storage/resource-exhausted') throw new PrivateProSyncTransportError('quota');
  if (code === 'storage/retry-limit-exceeded' || code === 'storage/canceled' || code === 'storage/unknown') throw new PrivateProSyncTransportError('offline');
  throw new PrivateProSyncTransportError('unknown');
}

export function createPrivateProAssetClient(
  uid: string,
  storage: PrivateProAssetStoragePort = firebaseStoragePort(),
  transport: PrivateProAssetManifestTransport,
  local: PrivateProAssetLocalPort,
  locks?: PrivateProAssetLockPort | null,
  leaseOptions?: PrivateProAssetUploadLeaseOptions,
): PrivateProAssetClient {
  if (!uid) throw new TypeError('Private Pro asset UID is required.');
  const uploadQueues = new Map<string, Promise<void>>();
  const selectedLocks = locks === undefined ? browserLockPort() : locks;
  const durableLease = leaseOptions ? durableLeaseLockPort(uid, leaseOptions) : unavailableLeasePort();

  function requestUploadLease<T>(assetId: string, signal: AbortSignal | undefined, callback: (guard: PrivateProAssetUploadLeaseGuard) => Promise<T>): Promise<T> {
    const name = `private-pro-asset-upload:${uid}:${assetId}`;
    const request = (lockSignal?: AbortSignal) => durableLease.request(assetId, signal ?? lockSignal, callback);
    return selectedLocks ? selectedLocks.request(name, signal, request) : request(signal);
  }

  function currentGeneration(assetId: string, expected: number, signal?: AbortSignal): Promise<void> {
    abortIfNeeded(signal);
    return local.getAssetState(assetId).then(current => {
      abortIfNeeded(signal);
      if (!current?.asset || current.contentGeneration !== expected) throw new DOMException('Private Pro attachment upload superseded.', 'AbortError');
    });
  }

  function enqueueUpload(assetId: string, signal?: AbortSignal): Promise<void> {
    const previous = uploadQueues.get(assetId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => requestUploadLease(assetId, signal, async leaseGuard => {
      abortIfNeeded(leaseGuard.signal);
      const snapshot = await local.getAssetSnapshot(assetId);
      if (!snapshot) throw new Error('Private Pro attachment is unavailable locally.');
      const { manifest, manifestHash, bytes } = await manifestFromAsset(uid, snapshot.asset, snapshot.contentGeneration);
      try {
        for (const kind of ['original', 'thumb256'] as const) {
          await currentGeneration(assetId, snapshot.contentGeneration, leaseGuard.signal);
          const object = kind === 'original' ? manifest.objects.original : manifest.objects.thumb256;
          if (!object) continue;
          await leaseGuard.assertOwned();
          abortIfNeeded(leaseGuard.signal);
          await storage.uploadBytesResumable(objectPath(uid, assetId, kind), bytes.get(kind)!, {
            contentType: object.mimeType, customMetadata: { uid, assetId, kind, sha256: object.sha256 },
          }, leaseGuard.signal);
          abortIfNeeded(leaseGuard.signal);
          await leaseGuard.assertOwned();
          await currentGeneration(assetId, snapshot.contentGeneration, leaseGuard.signal);
        }
      } catch (error) {
        storageError(error);
      }
      await leaseGuard.assertOwned();
      abortIfNeeded(leaseGuard.signal);
      if (!await local.putManifestIfCurrent(assetId, snapshot.contentGeneration, manifest, manifestHash))
        throw new PrivateProSyncTransportError('offline');
      transport.wake();
    }));
    uploadQueues.set(assetId, task);
    task.finally(() => { if (uploadQueues.get(assetId) === task) uploadQueues.delete(assetId); }).catch(() => {});
    return task;
  }

  async function verifiedObject(manifest: PrivateProAssetManifest, kind: PrivateProAssetObjectKind, signal?: AbortSignal): Promise<Uint8Array> {
    if (manifest.uid !== uid) throw new TypeError('Private Pro asset manifest identity is invalid.');
    const object = kind === 'original' ? manifest.objects.original : manifest.objects.thumb256;
    if (!object || object.objectId !== kind || object.kind !== kind) throw new TypeError('Private Pro asset object identity is invalid.');
    const path = objectPath(uid, manifest.assetId, kind);
    let metadata: PrivateProAssetStorageMetadata;
    let bytes: Uint8Array;
    try {
      [metadata, bytes] = await Promise.all([storage.getMetadata(path, signal), storage.getBytes(path, signal)]);
    } catch (error) {
      storageError(error);
    }
    abortIfNeeded(signal);
    const custom = PrivateProAssetStorageCustomMetadataSchema.parse(metadata.customMetadata);
    if (metadata.contentType !== object.mimeType || custom.uid !== uid || custom.assetId !== manifest.assetId || custom.kind !== kind || custom.sha256 !== object.sha256 ||
        bytes.byteLength !== object.byteSize || await sha256(bytes) !== object.sha256)
      throw new TypeError('Private Pro attachment verification failed.');
    return bytes;
  }

  return {
    async ensureUploaded(assetIds, signal) {
      await Promise.all([...new Set(assetIds)].map(assetId => enqueueUpload(assetId, signal)));
    },

    async hydrate(assetIds, signal) {
      for (const assetId of new Set(assetIds)) {
        abortIfNeeded(signal);
        const snapshot = await local.getHydrationSnapshot(assetId);
        if (!snapshot || snapshot.hasLocalAsset) continue;
        const manifest = PrivateProAssetManifestSchema.parse(snapshot.manifest);
        if (manifest.uid !== uid || manifest.assetId !== assetId) throw new TypeError('Private Pro asset manifest identity is invalid.');
        const original = await verifiedObject(manifest, 'original', signal);
        const thumb = manifest.objects.thumb256 ? await verifiedObject(manifest, 'thumb256', signal) : undefined;
        const value = {
          id: manifest.assetId,
          contextId: manifest.contextId,
          scopeId: manifest.scopeId,
          assetType: manifest.assetType,
          label: manifest.label,
          data: { mimeType: manifest.objects.original.mimeType, base64: bytesBase64(original) },
          origin: structuredClone(manifest.origin),
          metadata: structuredClone(manifest.metadata),
          createdAt: new Date(manifest.createdAt),
          updatedAt: new Date(manifest.updatedAt),
          cache: thumb && manifest.objects.thumb256 ? { thumb256: { mimeType: manifest.objects.thumb256.mimeType, base64: bytesBase64(thumb) } } : {},
        } as DBlobDBAsset;
        abortIfNeeded(signal);
        await local.putHydratedAssetIfCurrent(value, snapshot);
      }
    },

    async delete(assetId, guard) {
      await local.deleteManifest(assetId, guard);
      await local.deleteAsset(assetId, guard);
      guard?.assertActive();
      transport.wake();
      const outcomes = await Promise.allSettled([
        storage.deleteObject(objectPath(uid, assetId, 'original')),
        storage.deleteObject(objectPath(uid, assetId, 'thumb256')),
      ]);
      const failed = outcomes.find(outcome => outcome.status === 'rejected' && !isObjectNotFound(outcome.reason));
      if (failed?.status === 'rejected') {
        try { storageError(failed.reason); } catch (error) { throw new Error('Private Pro attachment cleanup failed.', { cause: error }); }
      }
    },

    clearLocal: () => local.clear(),
  };
}

function browserLockPort(): PrivateProAssetLockPort | null {
  if (typeof navigator === 'undefined' || !navigator.locks) return null;
  return { request: (name, signal, callback) => navigator.locks.request(name, { mode: 'exclusive', signal }, () => callback(signal)) };
}

function unavailableLeasePort(): PrivateProAssetDurableLeasePort {
  return { request: async () => { throw new TypeError('Private Pro asset upload lease is unavailable.'); } };
}

function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  abortIfNeeded(signal);
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      globalThis.clearTimeout(timer);
      reject(new DOMException('Private Pro attachment operation aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function waitWithSignal(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  abortIfNeeded(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Private Pro attachment operation aborted.', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function durableLeaseLockPort(uid: string, options: PrivateProAssetUploadLeaseOptions): PrivateProAssetDurableLeasePort {
  const leaseMs = options.leaseMs ?? 15_000;
  const renewEveryMs = options.renewEveryMs ?? 5_000;
  const retryEveryMs = options.retryEveryMs ?? 250;
  const now = options.now ?? Date.now;
  if (leaseMs <= 0 || renewEveryMs <= 0 || retryEveryMs <= 0 || renewEveryMs >= leaseMs)
    throw new TypeError('Private Pro asset upload lease configuration is invalid.');
  return {
    async request(assetId, signal, callback) {
      if (!assetId) throw new TypeError('Private Pro asset upload lease identity is invalid.');
      let lease: PrivateProAssetUploadLease | null = null;
      while (!lease) {
        abortIfNeeded(signal);
        lease = await options.port.acquireAssetUploadLease(uid, assetId, now(), leaseMs);
        if (!lease) await delayWithSignal(retryEveryMs, signal);
      }
      const identity = { fence: lease.fence, ownerToken: lease.ownerToken };
      let currentLease = lease;
      let stopped = false;
      let renewal: Promise<void> | null = null;
      let renewalTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
      let expiryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
      let leaseFailure: unknown = null;
      const operationAbort = new AbortController();
      const abort = () => operationAbort.abort();
      const loseLease = (error: unknown) => {
        if (!leaseFailure) leaseFailure = error;
        operationAbort.abort();
      };
      const clearRenewalTimer = () => {
        if (renewalTimer !== null) globalThis.clearTimeout(renewalTimer);
        renewalTimer = null;
      };
      const clearExpiryTimer = () => {
        if (expiryTimer !== null) globalThis.clearTimeout(expiryTimer);
        expiryTimer = null;
      };
      const scheduleExpiry = () => {
        clearExpiryTimer();
        if (stopped || operationAbort.signal.aborted) return;
        const expectedExpiry = currentLease.expiresAtMs;
        const watchdog = () => {
          expiryTimer = null;
          if (stopped || currentLease.expiresAtMs !== expectedExpiry || operationAbort.signal.aborted) return;
          const remainingMs = expectedExpiry - now();
          if (remainingMs > 0) {
            expiryTimer = globalThis.setTimeout(watchdog, remainingMs);
            return;
          }
          loseLease(new DOMException('Private Pro attachment upload lease expired.', 'AbortError'));
        };
        expiryTimer = globalThis.setTimeout(watchdog, Math.max(0, expectedExpiry - now()));
      };
      const scheduleRenewal = () => {
        clearRenewalTimer();
        if (stopped || operationAbort.signal.aborted) return;
        renewalTimer = globalThis.setTimeout(() => {
          renewalTimer = null;
          if (stopped || renewal || operationAbort.signal.aborted) return;
          const expectedLease = currentLease;
          const attempt = Promise.resolve()
            .then(() => options.port.renewAssetUploadLease(uid, assetId, identity.fence, identity.ownerToken, now(), leaseMs))
            .then(renewed => {
              const completedAtMs = now();
              if (stopped) return;
              if (!renewed || renewed.uid !== uid || renewed.assetId !== assetId || renewed.fence !== identity.fence || renewed.ownerToken !== identity.ownerToken ||
                  renewed.expiresAtMs <= expectedLease.expiresAtMs || renewed.expiresAtMs <= completedAtMs || completedAtMs >= expectedLease.expiresAtMs) {
                loseLease(new PrivateProSyncTransportError('offline'));
                return;
              }
              currentLease = renewed;
              scheduleExpiry();
              scheduleRenewal();
            })
            .catch(() => {
              if (!stopped) loseLease(new PrivateProSyncTransportError('offline'));
            })
            .finally(() => { if (renewal === attempt) renewal = null; });
          renewal = attempt;
        }, renewEveryMs);
      };
      const assertOwned = async () => {
        for (;;) {
          abortIfNeeded(operationAbort.signal);
          const pendingRenewal = renewal;
          if (pendingRenewal) {
            await waitWithSignal(pendingRenewal, operationAbort.signal);
            continue;
          }
          const expectedLease = currentLease;
          let owned: boolean;
          try {
            owned = await options.port.ownsAssetUploadLease(
              uid, assetId, identity.fence, identity.ownerToken, expectedLease.expiresAtMs, now(),
            );
          } catch {
            const failure = new PrivateProSyncTransportError('offline');
            loseLease(failure);
            throw failure;
          }
          abortIfNeeded(operationAbort.signal);
          if (currentLease.expiresAtMs !== expectedLease.expiresAtMs || renewal) continue;
          if (!owned || now() >= expectedLease.expiresAtMs) {
            const failure = new PrivateProSyncTransportError('offline');
            loseLease(failure);
            throw failure;
          }
          return;
        }
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      scheduleExpiry();
      scheduleRenewal();
      try {
        abortIfNeeded(operationAbort.signal);
        const result = await callback({ signal: operationAbort.signal, assertOwned });
        if (leaseFailure) throw leaseFailure;
        abortIfNeeded(operationAbort.signal);
        return result;
      } finally {
        stopped = true;
        clearRenewalTimer();
        clearExpiryTimer();
        signal?.removeEventListener('abort', abort);
        operationAbort.abort();
        const pendingRenewal = renewal;
        await pendingRenewal;
        await options.port.releaseAssetUploadLease(uid, assetId, identity.fence, identity.ownerToken);
      }
    },
  };
}

function isObjectNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'storage/object-not-found';
}
