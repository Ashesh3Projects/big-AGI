import type { DBlobAssetId, DBlobAssetType, DBlobDBAsset, DBlobDBContextId, DBlobDBScopeId } from '~/modules/dblobs/dblobs.types';
import type { PrivateProSyncAssetState, PrivateProSyncDB } from '../sync/privatePro.sync.db';
import { privateProCanonicalJson } from '../sync/privatePro.sync.codec';
import { PrivateProAssetManifestSchema, type PrivateProAssetManifest } from './privatePro.assets.schemas';


export interface PrivateProAssetActivationGuard {
  readonly signal: AbortSignal;
  assertActive(): void;
}

export interface PrivateProAssetSnapshot {
  asset: DBlobDBAsset;
  contentGeneration: number;
}

export interface PrivateProAssetHydrationSnapshot {
  manifest: PrivateProAssetManifest;
  contentGeneration: number;
  publishedContentGeneration: number;
  publishedManifestHash: string;
  hasLocalAsset: boolean;
}

export interface PrivateProAssetLocalPort {
  getAsset(assetId: string, guard?: PrivateProAssetActivationGuard): Promise<DBlobDBAsset | undefined>;
  getAssetState(assetId: string, guard?: PrivateProAssetActivationGuard): Promise<PrivateProSyncAssetState | undefined>;
  getAssetSnapshot(assetId: string, guard?: PrivateProAssetActivationGuard): Promise<PrivateProAssetSnapshot | undefined>;
  getHydrationSnapshot(assetId: string): Promise<PrivateProAssetHydrationSnapshot | undefined>;
  getAssets(assetIds: readonly string[], guard?: PrivateProAssetActivationGuard): Promise<DBlobDBAsset[]>;
  listAssets(guard?: PrivateProAssetActivationGuard): Promise<DBlobDBAsset[]>;
  putAsset(asset: DBlobDBAsset, guard?: PrivateProAssetActivationGuard): Promise<void>;
  putHydratedAsset(asset: DBlobDBAsset, manifest: PrivateProAssetManifest, manifestHash: string, guard?: PrivateProAssetActivationGuard): Promise<void>;
  putHydratedAssetIfCurrent(asset: DBlobDBAsset, snapshot: PrivateProAssetHydrationSnapshot): Promise<boolean>;
  updateAsset(assetId: string, updates: Partial<DBlobDBAsset>, guard?: PrivateProAssetActivationGuard): Promise<boolean>;
  deleteAsset(assetId: string, guard?: PrivateProAssetActivationGuard): Promise<void>;
  clear(guard?: PrivateProAssetActivationGuard): Promise<void>;
  getManifest(assetId: string, guard?: PrivateProAssetActivationGuard): Promise<PrivateProAssetManifest | undefined>;
  listManifests(guard?: PrivateProAssetActivationGuard): Promise<PrivateProAssetManifest[]>;
  putManifest(manifest: PrivateProAssetManifest, manifestHash?: string, guard?: PrivateProAssetActivationGuard): Promise<void>;
  putManifestIfCurrent(assetId: string, contentGeneration: number, manifest: PrivateProAssetManifest, manifestHash: string, guard?: PrivateProAssetActivationGuard): Promise<boolean>;
  deleteManifest(assetId: string, guard?: PrivateProAssetActivationGuard): Promise<void>;
  subscribe(listener: () => Promise<void> | void): () => void;
}

export type PrivateProAssetDelete = (assetId: string, guard?: PrivateProAssetActivationGuard) => Promise<void>;

interface ActivePrivateProAssetPersistence {
  generation: number;
  uid: string;
  port: PrivateProAssetLocalPort;
  deleteAsset: PrivateProAssetDelete;
  controller: AbortController;
  operations: Set<Promise<unknown>>;
}

let activationGeneration = 0;
let active: ActivePrivateProAssetPersistence | null = null;
let transition: Promise<void> | null = null;

function abortError(): DOMException {
  return new DOMException('Private Pro asset persistence changed.', 'AbortError');
}

export function activatePrivateProAssetPersistence(uid: string | null, port: PrivateProAssetLocalPort | null, deleteAsset?: PrivateProAssetDelete): Promise<void> {
  const transitionId = ++activationGeneration;
  const previous = active;
  const priorTransition = transition;
  active = null;
  previous?.controller.abort();
  const barrier = (async () => {
    await priorTransition;
    if (previous) await Promise.allSettled([...previous.operations]);
    if (transitionId !== activationGeneration) return;
    active = uid && port ? {
      generation: transitionId, uid, port,
      deleteAsset: deleteAsset ?? ((assetId, guard) => port.deleteAsset(assetId, guard)),
      controller: new AbortController(), operations: new Set(),
    } : null;
  })();
  const settled = barrier.finally(() => { if (transition === settled) transition = null; });
  transition = settled;
  return transition;
}

export async function runActivePrivateProAssetOperation<T>(
  operation: (port: PrivateProAssetLocalPort, guard: PrivateProAssetActivationGuard, deleteAsset: PrivateProAssetDelete) => Promise<T>,
): Promise<{ active: false } | { active: true; value: T }> {
  if (!active && transition) await transition;
  const selected = active;
  if (!selected) return { active: false };
  const guard: PrivateProAssetActivationGuard = {
    signal: selected.controller.signal,
    assertActive() {
      if (selected.controller.signal.aborted || active !== selected || active.generation !== selected.generation || active.uid !== selected.uid) throw abortError();
    },
  };
  const tracked = Promise.resolve().then(async () => {
    guard.assertActive();
    const value = await operation(selected.port, guard, selected.deleteAsset);
    guard.assertActive();
    return value;
  });
  selected.operations.add(tracked);
  try {
    return { active: true, value: await tracked };
  } finally {
    selected.operations.delete(tracked);
  }
}

function cloneState(state: PrivateProSyncAssetState): PrivateProSyncAssetState {
  return structuredClone(state);
}

export function createPrivateProAssetLocalPort(uid: string, db: PrivateProSyncDB): PrivateProAssetLocalPort {
  if (!uid) throw new TypeError('Private Pro asset UID is required.');
  const listeners = new Set<() => Promise<void> | void>();
  const emit = async () => { await Promise.all([...listeners].map(listener => listener())); };
  const assert = (guard?: PrivateProAssetActivationGuard) => guard?.assertActive();
  const guardedTransaction = async <T>(guard: PrivateProAssetActivationGuard | undefined, callback: () => Promise<T>): Promise<T> => {
    return db.transaction('rw', db.assets, async transaction => {
      const abort = () => transaction.abort();
      guard?.signal.addEventListener('abort', abort, { once: true });
      try {
        assert(guard);
        const result = await callback();
        assert(guard);
        return result;
      } finally {
        guard?.signal.removeEventListener('abort', abort);
      }
    });
  };
  const state = async (assetId: string, guard?: PrivateProAssetActivationGuard) => {
    assert(guard);
    const value = await db.assets.get([uid, assetId]);
    assert(guard);
    return value ? cloneState(value) : undefined;
  };
  const writeUserAsset = async (value: DBlobDBAsset, guard?: PrivateProAssetActivationGuard) => {
    await guardedTransaction(guard, async () => {
      const current = await db.assets.get([uid, value.id]);
      assert(guard);
      await db.assets.put({
        uid, assetId: value.id, asset: structuredClone(value), contentGeneration: (current?.contentGeneration ?? 0) + 1,
        uploadStatus: 'pending', hydrationStatus: 'ready', updatedAtMs: Date.now(),
      });
    });
    await emit();
  };
  return {
    async getAsset(assetId, guard) { return (await state(assetId, guard))?.asset; },
    getAssetState: state,
    async getAssetSnapshot(assetId, guard) {
      const current = await state(assetId, guard);
      return current?.asset ? { asset: structuredClone(current.asset), contentGeneration: current.contentGeneration } : undefined;
    },
    async getHydrationSnapshot(assetId) {
      const current = await state(assetId);
      if (!current?.manifest || current.publishedContentGeneration === undefined || !current.publishedManifestHash) return undefined;
      return {
        manifest: current.manifest, contentGeneration: current.contentGeneration,
        publishedContentGeneration: current.publishedContentGeneration, publishedManifestHash: current.publishedManifestHash,
        hasLocalAsset: !!current.asset,
      };
    },
    async getAssets(assetIds, guard) {
      const values = await Promise.all(assetIds.map(assetId => state(assetId, guard)));
      assert(guard);
      return values.flatMap(value => value?.asset ? [structuredClone(value.asset)] : []);
    },
    async listAssets(guard) {
      assert(guard);
      const values = await db.assets.where('uid').equals(uid).toArray();
      assert(guard);
      return values.flatMap(value => value.asset ? [structuredClone(value.asset)] : []);
    },
    putAsset: writeUserAsset,
    async putHydratedAsset(asset, manifest, manifestHash, guard) {
      await guardedTransaction(guard, async () => {
        const current = await db.assets.get([uid, asset.id]);
        assert(guard);
        await db.assets.put({
          uid, assetId: asset.id, asset: structuredClone(asset), manifest: structuredClone(manifest),
          contentGeneration: manifest.contentGeneration, publishedContentGeneration: manifest.contentGeneration,
          publishedManifestHash: manifestHash, uploadStatus: 'remote', hydrationStatus: 'ready', updatedAtMs: Date.now(),
        });
      });
    },
    async putHydratedAssetIfCurrent(asset, snapshot) {
      let committed = false;
      await db.transaction('rw', db.assets, async () => {
        const current = await db.assets.get([uid, asset.id]);
        if (!current || current.asset || current.contentGeneration !== snapshot.contentGeneration ||
            current.publishedContentGeneration !== snapshot.publishedContentGeneration ||
            current.publishedManifestHash !== snapshot.publishedManifestHash ||
            !current.manifest || privateProCanonicalJson(current.manifest) !== privateProCanonicalJson(snapshot.manifest)) return;
        committed = true;
        await db.assets.put({ ...current, asset: structuredClone(asset), hydrationStatus: 'ready', updatedAtMs: Date.now() });
      });
      return committed;
    },
    async updateAsset(assetId, updates, guard) {
      let changed = false;
      await guardedTransaction(guard, async () => {
        const current = await db.assets.get([uid, assetId]);
        assert(guard);
        if (!current?.asset) return;
        changed = true;
        await db.assets.put({
          uid, assetId, asset: { ...current.asset, ...structuredClone(updates) } as DBlobDBAsset,
          contentGeneration: current.contentGeneration + 1, uploadStatus: 'pending', hydrationStatus: 'ready', updatedAtMs: Date.now(),
        });
      });
      if (changed) await emit();
      return changed;
    },
    async deleteAsset(assetId, guard) {
      await guardedTransaction(guard, async () => {
        const current = await db.assets.get([uid, assetId]);
        assert(guard);
        if (!current) return;
        if (current.manifest) await db.assets.put({ ...current, asset: undefined, hydrationStatus: 'missing', updatedAtMs: Date.now() });
        else await db.assets.delete([uid, assetId]);
      });
      await emit();
    },
    async clear(guard) {
      await guardedTransaction(guard, async () => { await db.assets.where('uid').equals(uid).delete(); });
      await emit();
    },
    async getManifest(assetId, guard) { return (await state(assetId, guard))?.manifest; },
    async listManifests(guard) {
      assert(guard);
      const values = await db.assets.where('uid').equals(uid).toArray();
      assert(guard);
      return values.flatMap(value => value.manifest ? [structuredClone(value.manifest)] : []);
    },
    async putManifest(input, manifestHash = '', guard) {
      const manifest = PrivateProAssetManifestSchema.parse(input);
      if (manifest.uid !== uid) throw new TypeError('Private Pro asset manifest identity is invalid.');
      await guardedTransaction(guard, async () => {
        const current = await db.assets.get([uid, manifest.assetId]);
        assert(guard);
        await db.assets.put({
          uid, assetId: manifest.assetId, asset: current?.asset, manifest: structuredClone(manifest),
          contentGeneration: manifest.contentGeneration, publishedContentGeneration: manifest.contentGeneration,
          publishedManifestHash: manifestHash || current?.publishedManifestHash, uploadStatus: current?.asset ? 'ready' : 'remote',
          hydrationStatus: current?.asset ? 'ready' : current?.hydrationStatus ?? 'pending', updatedAtMs: Date.now(),
        });
      });
      await emit();
    },
    async putManifestIfCurrent(assetId, contentGeneration, input, manifestHash, guard) {
      const manifest = PrivateProAssetManifestSchema.parse(input);
      if (manifest.uid !== uid || manifest.assetId !== assetId || manifest.contentGeneration !== contentGeneration)
        throw new TypeError('Private Pro asset manifest identity is invalid.');
      let committed = false;
      await guardedTransaction(guard, async () => {
        const current = await db.assets.get([uid, assetId]);
        assert(guard);
        if (!current?.asset || current.contentGeneration !== contentGeneration) return;
        committed = true;
        await db.assets.put({
          ...current, manifest: structuredClone(manifest), publishedContentGeneration: contentGeneration,
          publishedManifestHash: manifestHash, uploadStatus: 'ready', updatedAtMs: Date.now(),
        });
      });
      if (committed) await emit();
      return committed;
    },
    async deleteManifest(assetId, guard) {
      await guardedTransaction(guard, async () => {
        const current = await db.assets.get([uid, assetId]);
        assert(guard);
        if (!current) return;
        if (current.asset) await db.assets.put({
          uid, assetId, asset: current.asset, contentGeneration: current.contentGeneration,
          uploadStatus: 'pending', hydrationStatus: current.hydrationStatus, updatedAtMs: Date.now(),
        });
        else await db.assets.delete([uid, assetId]);
      });
      await emit();
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

export type PrivateProAssetQuery = { assetType: DBlobAssetType; contextId: DBlobDBContextId; scopeId: DBlobDBScopeId };
export type PrivateProAssetIdentity = DBlobAssetId;
