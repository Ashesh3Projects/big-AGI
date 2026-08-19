import { deleteObject, getBytes, getMetadata, ref, uploadBytesResumable, type FullMetadata, type UploadTask } from 'firebase/storage';

import type { DBlobDBAsset } from '~/modules/dblobs/dblobs.types';
import { getPrivateProClientStorage } from '../firebase/firebase.client';
import { assertPrivateProPayloadSize, privateProCanonicalJson, privateProContentHash } from '../sync/privatePro.sync.codec';
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

export interface PrivateProAssetClient {
  ensureUploaded(assetIds: readonly string[], signal?: AbortSignal): Promise<void>;
  hydrate(assetIds: readonly string[], signal?: AbortSignal): Promise<void>;
  delete(assetId: string, guard?: PrivateProAssetActivationGuard): Promise<void>;
  clearLocal(): Promise<void>;
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
): PrivateProAssetClient {
  if (!uid) throw new TypeError('Private Pro asset UID is required.');
  const uploadQueues = new Map<string, Promise<void>>();

  function currentGeneration(assetId: string, expected: number, signal?: AbortSignal): Promise<void> {
    abortIfNeeded(signal);
    return local.getAssetState(assetId).then(current => {
      abortIfNeeded(signal);
      if (!current?.asset || current.contentGeneration !== expected) throw new DOMException('Private Pro attachment upload superseded.', 'AbortError');
    });
  }

  function enqueueUpload(assetId: string, signal?: AbortSignal): Promise<void> {
    const previous = uploadQueues.get(assetId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      abortIfNeeded(signal);
      const snapshot = await local.getAssetSnapshot(assetId);
      if (!snapshot) throw new Error('Private Pro attachment is unavailable locally.');
      const { manifest, manifestHash, bytes } = await manifestFromAsset(uid, snapshot.asset, snapshot.contentGeneration);
      try {
        for (const kind of ['original', 'thumb256'] as const) {
          await currentGeneration(assetId, snapshot.contentGeneration, signal);
          const object = kind === 'original' ? manifest.objects.original : manifest.objects.thumb256;
          if (!object) continue;
          await storage.uploadBytesResumable(objectPath(uid, assetId, kind), bytes.get(kind)!, {
            contentType: object.mimeType, customMetadata: { uid, assetId, kind, sha256: object.sha256 },
          }, signal);
          await currentGeneration(assetId, snapshot.contentGeneration, signal);
        }
      } catch (error) {
        storageError(error);
      }
      if (!await local.putManifestIfCurrent(assetId, snapshot.contentGeneration, manifest, manifestHash))
        throw new PrivateProSyncTransportError('offline');
      transport.wake();
    });
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

function isObjectNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'storage/object-not-found';
}
