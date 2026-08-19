import type { DBlobAssetId, DBlobAssetType, DBlobDBAsset, DBlobDBContextId, DBlobDBScopeId } from '~/modules/dblobs/dblobs.types';
import type { PrivateProSyncDB } from '../sync/privatePro.sync.db';
import { PrivateProAssetManifestSchema, type PrivateProAssetManifest } from './privatePro.assets.schemas';


export interface PrivateProAssetLocalPort {
  getAsset(assetId: string): Promise<DBlobDBAsset | undefined>;
  getAssets(assetIds: readonly string[]): Promise<DBlobDBAsset[]>;
  listAssets(): Promise<DBlobDBAsset[]>;
  putAsset(asset: DBlobDBAsset): Promise<void>;
  putHydratedAsset(asset: DBlobDBAsset): Promise<void>;
  updateAsset(assetId: string, updates: Partial<DBlobDBAsset>): Promise<boolean>;
  deleteAsset(assetId: string): Promise<void>;
  clear(): Promise<void>;
  getManifest(assetId: string): Promise<PrivateProAssetManifest | undefined>;
  listManifests(): Promise<PrivateProAssetManifest[]>;
  putManifest(manifest: PrivateProAssetManifest): Promise<void>;
  deleteManifest(assetId: string): Promise<void>;
  subscribe(listener: () => Promise<void> | void): () => void;
}

interface ActivePrivateProAssetPersistence {
  generation: number;
  uid: string;
  port: PrivateProAssetLocalPort;
}

let activationGeneration = 0;
let active: ActivePrivateProAssetPersistence | null = null;

export function activatePrivateProAssetPersistence(uid: string | null, port: PrivateProAssetLocalPort | null): void {
  activationGeneration++;
  active = uid && port ? { generation: activationGeneration, uid, port } : null;
}

export function getActivePrivateProAssetPersistence(): ActivePrivateProAssetPersistence | null {
  return active;
}

export async function runActivePrivateProAssetOperation<T>(
  operation: (port: PrivateProAssetLocalPort) => Promise<T>,
): Promise<T | undefined> {
  const selected = active;
  if (!selected) return undefined;
  const result = await operation(selected.port);
  if (active?.generation !== selected.generation || active.uid !== selected.uid)
    throw new DOMException('Private Pro asset persistence changed.', 'AbortError');
  return result;
}

export function createPrivateProAssetLocalPort(uid: string, db: PrivateProSyncDB): PrivateProAssetLocalPort {
  if (!uid) throw new TypeError('Private Pro asset UID is required.');
  const listeners = new Set<() => Promise<void> | void>();
  const emit = async () => { await Promise.all([...listeners].map(listener => listener())); };
  const asset = async (assetId: string) => {
    const state = await db.assets.get([uid, assetId]);
    return state?.asset ? structuredClone(state.asset) : undefined;
  };
  const writeAsset = async (value: DBlobDBAsset, preserveManifest: boolean) => {
    const current = await db.assets.get([uid, value.id]);
    await db.assets.put({
      uid, assetId: value.id, asset: structuredClone(value), manifest: preserveManifest ? current?.manifest : undefined,
      uploadStatus: preserveManifest && current?.manifest ? 'remote' : 'pending', hydrationStatus: 'ready', updatedAtMs: Date.now(),
    });
    await emit();
  };
  return {
    getAsset: asset,
    async getAssets(assetIds) {
      const values = await Promise.all(assetIds.map(asset));
      return values.filter((value): value is DBlobDBAsset => !!value);
    },
    async listAssets() {
      return (await db.assets.where('uid').equals(uid).toArray()).flatMap(state => state.asset ? [structuredClone(state.asset)] : []);
    },
    putAsset: value => writeAsset(value, false),
    putHydratedAsset: value => writeAsset(value, true),
    async updateAsset(assetId, updates) {
      const current = await asset(assetId);
      if (!current) return false;
      await this.putAsset({ ...current, ...structuredClone(updates) } as DBlobDBAsset);
      return true;
    },
    async deleteAsset(assetId) {
      const current = await db.assets.get([uid, assetId]);
      if (!current) return;
      if (current.manifest) await db.assets.put({ ...current, asset: undefined, hydrationStatus: 'missing', updatedAtMs: Date.now() });
      else await db.assets.delete([uid, assetId]);
      await emit();
    },
    async clear() {
      await db.assets.where('uid').equals(uid).delete();
      await emit();
    },
    async getManifest(assetId) {
      const manifest = (await db.assets.get([uid, assetId]))?.manifest;
      return manifest ? structuredClone(manifest) : undefined;
    },
    async listManifests() {
      return (await db.assets.where('uid').equals(uid).toArray()).flatMap(state => state.manifest ? [structuredClone(state.manifest)] : []);
    },
    async putManifest(input) {
      const manifest = PrivateProAssetManifestSchema.parse(input);
      if (manifest.uid !== uid) throw new TypeError('Private Pro asset manifest identity is invalid.');
      const current = await db.assets.get([uid, manifest.assetId]);
      await db.assets.put({
        uid, assetId: manifest.assetId, asset: current?.asset, manifest: structuredClone(manifest),
        uploadStatus: current?.asset ? 'ready' : current?.uploadStatus ?? 'remote',
        hydrationStatus: current?.asset ? 'ready' : current?.hydrationStatus ?? 'pending', updatedAtMs: Date.now(),
      });
      await emit();
    },
    async deleteManifest(assetId) {
      const current = await db.assets.get([uid, assetId]);
      if (!current) return;
      if (current.asset) await db.assets.put({ ...current, manifest: undefined, uploadStatus: 'pending', updatedAtMs: Date.now() });
      else await db.assets.delete([uid, assetId]);
      await emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type PrivateProAssetQuery = {
  assetType: DBlobAssetType;
  contextId: DBlobDBContextId;
  scopeId: DBlobDBScopeId;
};

export type PrivateProAssetIdentity = DBlobAssetId;
