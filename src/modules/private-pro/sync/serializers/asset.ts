import type { PrivateProAssetLocalPort } from '../../assets/privatePro.assets.local';
import { PrivateProAssetManifestSchema, type PrivateProAssetManifest } from '../../assets/privatePro.assets.schemas';
import type { PrivateProSyncLocalMutation, PrivateProSyncSerializer, PrivateProSyncSerializedRecord } from '../privatePro.sync.serializers';
import { privateProCanonicalJson, privateProContentHash } from '../privatePro.sync.codec';


export function createPrivateProAssetSerializer(uid: string, local: PrivateProAssetLocalPort): PrivateProSyncSerializer<PrivateProAssetManifest> {
  const serialized = (manifest: PrivateProAssetManifest): PrivateProSyncSerializedRecord<PrivateProAssetManifest> => ({
    recordType: 'asset', logicalId: manifest.assetId, projectionKey: manifest.assetId, schemaVersion: 1,
    value: structuredClone(manifest), referencedAssetIds: [manifest.assetId],
  });
  return {
    recordType: 'asset',
    schemaVersion: 1,
    conflictPolicy: 'replace',
    async snapshot() {
      const manifests = await local.listManifests();
      return manifests.map(input => {
        const manifest = PrivateProAssetManifestSchema.parse(input);
        if (manifest.uid !== uid) throw new TypeError('Private Pro asset manifest identity is invalid.');
        return serialized(manifest);
      });
    },
    async validate(logicalId, input) {
      const manifest = PrivateProAssetManifestSchema.parse(input);
      if (manifest.uid !== uid || manifest.assetId !== logicalId) throw new TypeError('Private Pro asset manifest identity is invalid.');
      return manifest;
    },
    project(logicalId, manifest) {
      if (manifest.uid !== uid || manifest.assetId !== logicalId) throw new TypeError('Private Pro asset manifest identity is invalid.');
      return { projectionKey: manifest.assetId, referencedAssetIds: [manifest.assetId] };
    },
    projection: {
      async apply(projectionKey, records) {
        const record = records.find(candidate => candidate.recordType === 'asset' && candidate.logicalId === projectionKey);
        if (record) {
          const manifest = PrivateProAssetManifestSchema.parse(record.value);
          await local.putManifest(manifest, await privateProContentHash(privateProCanonicalJson(manifest)));
        }
        else await local.deleteManifest(projectionKey);
      },
      remove: projectionKey => local.deleteManifest(projectionKey),
    },
    subscribe(listener) {
      let previous = new Map<string, string>();
      let stopped = false;
      const capture = async () => {
        const currentManifests = await local.listManifests();
        if (stopped) return;
        const current = new Map(currentManifests.map(manifest => [manifest.assetId, JSON.stringify(manifest)]));
        const mutations: PrivateProSyncLocalMutation[] = [];
        for (const manifest of currentManifests) {
          if (previous.get(manifest.assetId) !== current.get(manifest.assetId)) mutations.push({ kind: 'put', record: serialized(manifest) });
        }
        for (const assetId of previous.keys()) {
          if (!current.has(assetId)) mutations.push({ kind: 'delete', recordType: 'asset', logicalId: assetId, projectionKey: assetId, schemaVersion: 1 });
        }
        previous = current;
        mutations.forEach(listener);
      };
      let queue = local.listManifests().then(manifests => { previous = new Map(manifests.map(manifest => [manifest.assetId, JSON.stringify(manifest)])); });
      const unsubscribe = local.subscribe(() => queue = queue.then(capture));
      return () => { stopped = true; unsubscribe(); };
    },
  };
}
