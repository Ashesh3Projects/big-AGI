import { apiAsyncNode } from '~/common/util/trpc.client';
import { getDBAsset, putDBAsset } from '~/common/stores/blob/dblobs-portability';
import type { DBlobAssetId, DBlobDBAsset } from '~/modules/dblobs/dblobs.types';
import { convert_Base64_To_UInt8Array, convert_UInt8Array_To_Base64 } from '~/common/util/blobUtils';

import { privateProHash } from '../sync/privatePro.sync.chunk';


function assetMetadata(asset: DBlobDBAsset) {
  return {
    assetType: asset.assetType,
    label: asset.label,
    origin: JSON.parse(JSON.stringify(asset.origin)),
    metadata: JSON.parse(JSON.stringify(asset.metadata)),
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
  };
}

export async function privateProUploadDBAsset(assetId: DBlobAssetId): Promise<void> {
  const asset = await getDBAsset<DBlobDBAsset>(assetId);
  if (!asset) throw new Error(`Local attachment ${assetId} was not found.`);
  const bytes = convert_Base64_To_UInt8Array(asset.data.base64, 'private-pro-asset-upload');
  const contentHash = await privateProHash(bytes);
  const operationId = `asset-${contentHash.slice(0, 32)}-${assetId}`.slice(0, 160);
  const reservation = await apiAsyncNode.privateProAssets.reserveUpload.mutate({
    operationId,
    assetId,
    contentHash,
    contentType: asset.data.mimeType,
    requestedBytes: bytes.byteLength,
    metadata: assetMetadata(asset),
  });
  if (reservation.status === 'already-uploaded') return;

  const response = await fetch(reservation.uploadUrl, {
    method: 'PUT',
    headers: reservation.requiredHeaders,
    body: bytes,
  });
  if (!response.ok) throw new Error(`Attachment upload failed with HTTP ${response.status}.`);
  await apiAsyncNode.privateProAssets.finalizeUpload.mutate({ operationId });
}

export async function privateProHydrateDBAsset(assetId: DBlobAssetId): Promise<void> {
  if (await getDBAsset(assetId)) return;
  const { downloadUrl, asset } = await apiAsyncNode.privateProAssets.getDownload.query({ assetId });
  const response = await fetch(downloadUrl);
  if (!response.ok) throw new Error(`Attachment download failed with HTTP ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (await privateProHash(bytes) !== asset.contentHash) throw new Error('Downloaded attachment failed its content hash.');

  await putDBAsset({
    id: asset.assetId,
    contextId: 'global',
    scopeId: 'app-chat',
    assetType: asset.metadata.assetType as DBlobDBAsset['assetType'],
    label: asset.metadata.label,
    data: {
      mimeType: asset.contentType as DBlobDBAsset['data']['mimeType'],
      base64: convert_UInt8Array_To_Base64(bytes, 'private-pro-asset-download'),
    },
    origin: asset.metadata.origin as DBlobDBAsset['origin'],
    metadata: asset.metadata.metadata as DBlobDBAsset['metadata'],
    createdAt: new Date(asset.metadata.createdAt),
    updatedAt: new Date(asset.metadata.updatedAt),
    cache: {},
  } as DBlobDBAsset);
}
