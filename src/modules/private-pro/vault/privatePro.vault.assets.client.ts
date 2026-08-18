import { apiAsyncNode } from '~/common/util/trpc.client';
import { deleteDBAsset, getDBAsset, putDBAsset } from '~/common/stores/blob/dblobs-portability';
import type { DBlobAssetId, DBlobDBAsset } from '~/modules/dblobs/dblobs.types';
import type { PrivateProEncryptedBackupAsset } from '~/modules/trade/privateProEncryptedBackup';

import {
  decodePrivateProVaultAssetChunkObject,
  decryptPrivateProVaultAssetToSink,
  encodePrivateProVaultAssetChunkObject,
  encryptPrivateProVaultAssetChunks,
  privateProVaultAssetId,
  type PrivateProVaultAssetChunk,
  type PrivateProVaultAssetChunkAADInput,
  type PrivateProVaultAssetManifest,
  type PrivateProVaultAssetPlaintextSource,
  type PrivateProVaultAssetStoredChunkMetadata,
} from './privatePro.vault.assets.crypto';
import { privateProVaultDB } from './privatePro.vault.db';


const SHA256_HEX = /^[a-f0-9]{64}$/;

export interface PrivateProVaultAssetLocalPort {
  getAsset(assetId: string): Promise<DBlobDBAsset | undefined>;
  putAsset(asset: DBlobDBAsset): Promise<void>;
  deleteAsset(assetId: string): Promise<void>;
  hasAsset(assetId: string): Promise<boolean>;
  listHydratedAssetIds(uid: string): Promise<string[]>;
  markHydratedAsset(uid: string, assetId: string): Promise<void>;
  unmarkHydratedAsset(uid: string, assetId: string): Promise<void>;
  openAssetSource(asset: DBlobDBAsset): Promise<{
    plaintextBytes: number;
    source: PrivateProVaultAssetPlaintextSource;
  }>;
}

export interface PrivateProVaultAssetClientTransport {
  reserveUpload(input: {
    operationId: string;
    opaqueAssetId: string;
    chunks: Array<{
      opaqueChunkId: string;
      chunkIndex: number;
      ciphertextBytes: number;
      objectBytes: number;
      objectSha256: string;
    }>;
  }): Promise<{
    status: 'already-uploaded';
    opaqueAssetId: string;
    ciphertextBytes: number;
  } | {
    status: 'upload-required';
    operationId: string;
    opaqueAssetId: string;
    expiresAtMs: number;
    chunks: Array<{
      opaqueChunkId: string;
      chunkIndex: number;
      ciphertextBytes: number;
      objectBytes: number;
      objectSha256: string;
      objectPath: string;
      uploadUrl: string;
      requiredHeaders: Record<string, string>;
    }>;
  }>;
  uploadChunk(input: {
    chunkIndex: number;
    objectPath: string;
    uploadUrl: string;
    requiredHeaders: Record<string, string>;
    bytes: Uint8Array;
    signal?: AbortSignal;
  }): Promise<void>;
  finalizeUpload(operationId: string): Promise<{ status: 'ready'; opaqueAssetId: string; ciphertextBytes: number }>;
  releaseReservation(operationId: string): Promise<void>;
  getDownload(opaqueAssetId: string): Promise<{
    opaqueAssetId: string;
    ciphertextBytes: number;
    chunks: Array<{
      opaqueChunkId: string;
      chunkIndex: number;
      ciphertextBytes: number;
      objectBytes: number;
      objectSha256: string;
      objectPath: string;
      downloadUrl: string;
    }>;
  }>;
  downloadChunk(input: {
    chunkIndex: number;
    objectPath: string;
    downloadUrl: string;
    signal?: AbortSignal;
  }): Promise<Uint8Array>;
  hashBytes?(bytes: Uint8Array, signal?: AbortSignal): Promise<string>;
}

export interface PrivateProVaultAssetClientDependencies {
  vaultId: string;
  masterKey: CryptoKey;
  keyVersion: number;
  local?: PrivateProVaultAssetLocalPort;
  transport?: PrivateProVaultAssetClientTransport;
  createOperationId?: () => string;
}

interface PreparedChunk {
  chunk: PrivateProVaultAssetChunk;
  object: Uint8Array<ArrayBuffer>;
  objectSha256: string;
}


function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('The encrypted attachment operation was aborted.', 'AbortError');
}

function abortError(): DOMException {
  return new DOMException('The encrypted attachment operation was aborted.', 'AbortError');
}

function manifestFromAsset(asset: DBlobDBAsset): PrivateProVaultAssetManifest {
  const common = {
    formatVersion: 1,
    schemaVersion: 1,
    assetId: asset.id,
    contextId: asset.contextId,
    scopeId: asset.scopeId,
    label: asset.label,
    origin: JSON.parse(JSON.stringify(asset.origin)) as PrivateProVaultAssetManifest['origin'],
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
  } as const;
  return asset.assetType === 'image'
    ? {
      ...common,
      assetType: 'image',
      contentType: asset.data.mimeType,
      metadata: JSON.parse(JSON.stringify(asset.metadata)),
    }
    : {
      ...common,
      assetType: 'audio',
      contentType: asset.data.mimeType,
      metadata: JSON.parse(JSON.stringify(asset.metadata)),
    };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(',')}}`;
}

function assetFromManifest(manifest: PrivateProVaultAssetManifest, base64: string): DBlobDBAsset {
  return {
    id: manifest.assetId,
    contextId: manifest.contextId,
    scopeId: manifest.scopeId,
    assetType: manifest.assetType,
    label: manifest.label,
    data: {
      mimeType: manifest.contentType,
      base64,
    },
    origin: structuredClone(manifest.origin) as unknown as DBlobDBAsset['origin'],
    metadata: structuredClone(manifest.metadata) as unknown as DBlobDBAsset['metadata'],
    createdAt: new Date(manifest.createdAt),
    updatedAt: new Date(manifest.updatedAt),
    cache: {},
  } as DBlobDBAsset;
}

class StreamingBase64Encoder {
  private readonly parts: string[] = [];
  private remainder = new Uint8Array(0);

  write(bytes: Uint8Array): void {
    const input = new Uint8Array(this.remainder.byteLength + bytes.byteLength);
    input.set(this.remainder, 0);
    input.set(bytes, this.remainder.byteLength);
    const completeBytes = input.byteLength - input.byteLength % 3;
    if (completeBytes) this.parts.push(bytesToBase64(input.subarray(0, completeBytes)));
    this.remainder.fill(0);
    this.remainder = Uint8Array.from(input.subarray(completeBytes));
    input.fill(0);
  }

  finish(): string {
    if (this.remainder.byteLength) this.parts.push(bytesToBase64(this.remainder));
    this.remainder.fill(0);
    this.remainder = new Uint8Array(0);
    return this.parts.join('');
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000)
    parts.push(String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.byteLength))));
  return btoa(parts.join(''));
}

function base64ToStream(base64: string): { plaintextBytes: number; source: ReadableStream<Uint8Array> } {
  const completeQuartets = Math.floor(base64.length / 4);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const plaintextBytes = completeQuartets * 3 - padding;
  let offset = 0;
  const base64CharsPerChunk = 64 * 1024 - (64 * 1024) % 4;
  return {
    plaintextBytes,
    source: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= base64.length) return controller.close();
        const end = Math.min(offset + base64CharsPerChunk, base64.length);
        const binary = atob(base64.slice(offset, end));
        offset = end;
        controller.enqueue(Uint8Array.from(binary, character => character.charCodeAt(0)));
      },
    }),
  };
}

function defaultLocalPort(): PrivateProVaultAssetLocalPort {
  return {
    getAsset: assetId => getDBAsset<DBlobDBAsset>(assetId),
    putAsset: putDBAsset,
    deleteAsset: deleteDBAsset,
    async hasAsset(assetId) { return !!await getDBAsset(assetId); },
    async listHydratedAssetIds(uid) {
      return (await privateProVaultDB.hydratedAssets.where('uid').equals(uid).toArray()).map(record => record.assetId);
    },
    async markHydratedAsset(uid, assetId) { await privateProVaultDB.hydratedAssets.put({ uid, assetId }); },
    async unmarkHydratedAsset(uid, assetId) { await privateProVaultDB.hydratedAssets.delete([uid, assetId]); },
    async openAssetSource(asset) { return base64ToStream(asset.data.base64); },
  };
}

function defaultTransport(): PrivateProVaultAssetClientTransport {
  return {
    reserveUpload: input => apiAsyncNode.privateProAssets.reserveEncryptedUpload.mutate(input),
    async uploadChunk(input) {
      const response = await fetch(input.uploadUrl, {
        method: 'PUT',
        headers: input.requiredHeaders,
        body: new Uint8Array(input.bytes),
        signal: input.signal,
      });
      if (!response.ok) throw new Error(`Encrypted attachment upload failed with HTTP ${response.status}.`);
    },
    finalizeUpload: operationId => apiAsyncNode.privateProAssets.finalizeEncryptedUpload.mutate({ operationId }),
    async releaseReservation(operationId) {
      await apiAsyncNode.privateProAssets.releaseEncryptedReservation.mutate({ operationId });
    },
    getDownload: opaqueAssetId => apiAsyncNode.privateProAssets.getEncryptedDownload.query({ opaqueAssetId }),
    async downloadChunk(input) {
      const response = await fetch(input.downloadUrl, { signal: input.signal });
      if (!response.ok) throw new Error(`Encrypted attachment download failed with HTTP ${response.status}.`);
      return new Uint8Array(await response.arrayBuffer());
    },
    hashBytes: hashBytesAbortably,
  };
}

function hashBytesInWorker(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  if (typeof Worker === 'undefined') return sha256Hex(bytes, signal);
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./privatePro.vault.assets.worker.ts', import.meta.url), {
      name: 'private-pro-vault-assets',
      type: 'module',
    });
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', handleAbort);
      worker.terminate();
      action();
    };
    const handleAbort = () => finish(() => reject(abortError()));
    signal?.addEventListener('abort', handleAbort, { once: true });
    worker.addEventListener('message', event => {
      const response = event.data as Record<string, unknown> | null;
      if (response?.protocolVersion === 1 && response.kind === 'sha256' && typeof response.digestHex === 'string')
        finish(() => resolve(response.digestHex as string));
      else
        finish(() => reject(new Error('Encrypted attachment worker failed.')));
    }, { once: true });
    worker.addEventListener('error', () => finish(() => reject(new Error('Encrypted attachment worker failed.'))), { once: true });
    const copy = Uint8Array.from(bytes);
    worker.postMessage({ protocolVersion: 1, kind: 'sha256', bytes: copy }, [copy.buffer]);
  });
}

async function hashBytesAbortably(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  if (typeof Worker !== 'undefined') return hashBytesInWorker(bytes, signal);
  return sha256Hex(bytes, signal);
}

function encryptChunkInWorker(
  key: CryptoKey,
  aad: PrivateProVaultAssetChunkAADInput,
  plaintext: Uint8Array,
  nonce: Uint8Array,
  signal?: AbortSignal,
): Promise<PrivateProVaultAssetChunk> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./privatePro.vault.assets.worker.ts', import.meta.url), {
      name: 'private-pro-vault-assets',
      type: 'module',
    });
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', handleAbort);
      worker.terminate();
      action();
    };
    const handleAbort = () => finish(() => reject(abortError()));
    signal?.addEventListener('abort', handleAbort, { once: true });
    worker.addEventListener('message', event => {
      const response = event.data as Record<string, unknown> | null;
      if (response?.protocolVersion === 1 && response.kind === 'encrypt' && response.chunk)
        finish(() => resolve(response.chunk as PrivateProVaultAssetChunk));
      else
        finish(() => reject(new Error('Encrypted attachment worker failed.')));
    }, { once: true });
    worker.addEventListener('error', () => finish(() => reject(new Error('Encrypted attachment worker failed.'))), { once: true });
    const copy = Uint8Array.from(plaintext);
    const nonceCopy = Uint8Array.from(nonce);
    worker.postMessage({ protocolVersion: 1, kind: 'encrypt', key, aad, plaintext: copy, nonce: nonceCopy }, [copy.buffer, nonceCopy.buffer]);
  });
}

async function encryptChunkAbortably(
  key: CryptoKey,
  aad: PrivateProVaultAssetChunkAADInput,
  plaintext: Uint8Array,
  nonce: Uint8Array,
  signal?: AbortSignal,
): Promise<PrivateProVaultAssetChunk> {
  if (typeof Worker !== 'undefined') return encryptChunkInWorker(key, aad, plaintext, nonce, signal);
  return import('./privatePro.vault.assets.crypto').then(({ encryptPrivateProVaultAssetChunk }) =>
    encryptPrivateProVaultAssetChunk(key, aad, plaintext, nonce, signal));
}

async function sha256Hex(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
  throwIfAborted(signal);
  try {
    return [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
  } finally {
    digest.fill(0);
  }
}

function storedMetadata(chunk: PrivateProVaultAssetChunk): PrivateProVaultAssetStoredChunkMetadata {
  return {
    formatVersion: chunk.formatVersion,
    schemaVersion: chunk.schemaVersion,
    keyVersion: chunk.keyVersion,
    opaqueAssetId: chunk.opaqueAssetId,
    opaqueChunkId: chunk.opaqueChunkId,
    chunkIndex: chunk.chunkIndex,
    chunkCount: chunk.chunkCount,
    totalPlaintextBytes: chunk.totalPlaintextBytes,
    plaintextBytes: chunk.plaintextBytes,
    ciphertextBytes: chunk.ciphertextBytes,
  };
}

export function collectPrivateProVaultAssetIds(recordType: string, value: unknown): string[] {
  if (recordType !== 'chat' || !value || typeof value !== 'object') return [];
  const assetIds = new Set<string>();
  const visit = (candidate: unknown, depth: number) => {
    if (depth > 32 || !candidate || typeof candidate !== 'object') return;
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    const object = candidate as Record<string, unknown>;
    const dataRef = object.dataRef;
    if (dataRef && typeof dataRef === 'object') {
      const ref = dataRef as Record<string, unknown>;
      if (ref.reftype === 'dblob' && typeof ref.dblobAssetId === 'string') assetIds.add(ref.dblobAssetId);
    }
    for (const child of Object.values(object)) visit(child, depth + 1);
  };
  visit(value, 0);
  return [...assetIds];
}

async function preparedChunks(
  deps: Required<Pick<PrivateProVaultAssetClientDependencies, 'vaultId' | 'masterKey' | 'keyVersion'>>,
  asset: DBlobDBAsset,
  local: PrivateProVaultAssetLocalPort,
  hashBytes: (bytes: Uint8Array, signal?: AbortSignal) => Promise<string>,
  signal?: AbortSignal,
): Promise<{ opaqueAssetId: string; chunks: PreparedChunk[] }> {
  throwIfAborted(signal);
  const opaqueAssetId = await privateProVaultAssetId(deps.masterKey, asset.id);
  const manifest = manifestFromAsset(asset);
  const source = await local.openAssetSource(asset);
  throwIfAborted(signal);
  const chunks: PreparedChunk[] = [];
  try {
    for await (const chunk of encryptPrivateProVaultAssetChunks({
      masterKey: deps.masterKey,
      vaultId: deps.vaultId,
      opaqueAssetId,
      keyVersion: deps.keyVersion,
      manifest,
      plaintextBytes: source.plaintextBytes,
      source: source.source,
      signal,
      encryptChunk: encryptChunkAbortably,
    })) {
      throwIfAborted(signal);
      const object = encodePrivateProVaultAssetChunkObject(chunk);
      try {
        chunks.push({ chunk, object, objectSha256: await hashBytes(object, signal) });
      } catch (error) {
        object.fill(0);
        throw error;
      }
    }
    return { opaqueAssetId, chunks };
  } catch (error) {
    for (const chunk of chunks) chunk.object.fill(0);
    throw error;
  }
}

export function createPrivateProVaultAssetClient(deps: PrivateProVaultAssetClientDependencies) {
  if (!deps.vaultId || !Number.isSafeInteger(deps.keyVersion) || deps.keyVersion <= 0)
    throw new Error('Encrypted asset client configuration is invalid.');
  const local = deps.local ?? defaultLocalPort();
  const transport = deps.transport ?? defaultTransport();
  const hashBytes = transport.hashBytes
    ? (bytes: Uint8Array, signal?: AbortSignal) => transport.hashBytes!(bytes, signal)
    : sha256Hex;
  const createOperationId = deps.createOperationId ?? (() => `asset-${crypto.randomUUID()}`);
  const opaqueIds = new Map<string, string>();

  const opaqueAssetId = async (assetId: string) => {
    const existing = opaqueIds.get(assetId);
    if (existing) return existing;
    const created = await privateProVaultAssetId(deps.masterKey, assetId);
    opaqueIds.set(assetId, created);
    return created;
  };

  const orderedDownload = async (assetId: string) => {
    const opaqueId = await opaqueAssetId(assetId);
    const download = await transport.getDownload(opaqueId);
    if (download.opaqueAssetId !== opaqueId) throw new Error('Encrypted attachment download identity is invalid.');
    const ordered = [...download.chunks].sort((left, right) => left.chunkIndex - right.chunkIndex);
    if (ordered.some((chunk, index) => chunk.chunkIndex !== index))
      throw new Error('Encrypted attachment download order is invalid.');
    return { opaqueId, ordered };
  };

  const verifiedObject = async (
    chunk: Awaited<ReturnType<typeof orderedDownload>>['ordered'][number],
    signal?: AbortSignal,
  ) => {
    throwIfAborted(signal);
    const object = await transport.downloadChunk({ ...chunk, signal });
    if (object.byteLength !== chunk.objectBytes || !SHA256_HEX.test(chunk.objectSha256) || await hashBytes(object, signal) !== chunk.objectSha256)
      throw new Error('Encrypted attachment object hash or size is invalid.');
    return object;
  };

  const downloadChunks = async (assetId: string, signal?: AbortSignal) => {
    const { opaqueId, ordered } = await orderedDownload(assetId);
    const totalFramedPlaintextBytes = ordered.reduce((sum, chunk) => sum + chunk.ciphertextBytes - 16, 0);
    const chunks: PrivateProVaultAssetChunk[] = [];
    for (const chunk of ordered) {
      const object = await verifiedObject(chunk, signal);
      try {
        chunks.push(decodePrivateProVaultAssetChunkObject({
          formatVersion: 1,
          schemaVersion: 1,
          keyVersion: deps.keyVersion,
          opaqueAssetId: opaqueId,
          opaqueChunkId: chunk.opaqueChunkId,
          chunkIndex: chunk.chunkIndex,
          chunkCount: ordered.length,
          totalPlaintextBytes: totalFramedPlaintextBytes,
          plaintextBytes: chunk.ciphertextBytes - 16,
          ciphertextBytes: chunk.ciphertextBytes,
        }, object));
      } finally {
        object.fill(0);
      }
    }
    return chunks;
  };

  const decryptAsset = async (assetId: string, chunks: readonly PrivateProVaultAssetChunk[]) => {
    const encoder = new StreamingBase64Encoder();
    const manifest = await decryptPrivateProVaultAssetToSink(
      { masterKey: deps.masterKey, vaultId: deps.vaultId, chunks },
      plaintext => encoder.write(plaintext),
    );
    if (manifest.assetId !== assetId) throw new Error('Encrypted attachment manifest identity is invalid.');
    return assetFromManifest(manifest, encoder.finish());
  };

  const materializeAsset = async (asset: DBlobDBAsset): Promise<boolean> => {
    const existing = await local.getAsset(asset.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(asset))
        throw new Error('Encrypted backup attachment conflicts with an existing local asset.');
      return false;
    }
    await local.markHydratedAsset(deps.vaultId, asset.id);
    try {
      await local.putAsset(asset);
      return true;
    } catch (error) {
      await local.deleteAsset(asset.id).catch(() => undefined);
      await local.unmarkHydratedAsset(deps.vaultId, asset.id).catch(() => undefined);
      throw error;
    }
  };

  const rollbackAssets = async (assetIds: readonly string[]) => {
    for (const assetId of [...assetIds].reverse()) {
      await local.deleteAsset(assetId);
      await local.unmarkHydratedAsset(deps.vaultId, assetId);
    }
  };

  return {
    async describe(assetIds: readonly DBlobAssetId[], signal?: AbortSignal) {
      const descriptions = [];
      for (const assetId of [...new Set(assetIds)]) {
        throwIfAborted(signal);
        const asset = await local.getAsset(assetId);
        if (!asset) continue;
        const bytes = Uint8Array.from(atob(asset.data.base64), character => character.charCodeAt(0));
        try {
          descriptions.push({
            assetId,
            plaintextBytes: bytes.byteLength,
            contentSha256: await hashBytes(bytes, signal),
            manifestSha256: await hashBytes(new TextEncoder().encode(canonicalJson(manifestFromAsset(asset))), signal),
          });
        } finally {
          bytes.fill(0);
        }
      }
      return descriptions;
    },

    async verifyCloud(assets: readonly { assetId: string; plaintextBytes: number; contentSha256: string; manifestSha256: string }[], signal?: AbortSignal) {
      for (const expected of assets) {
        throwIfAborted(signal);
        const asset = await decryptAsset(expected.assetId, await downloadChunks(expected.assetId, signal));
        const bytes = Uint8Array.from(atob(asset.data.base64), character => character.charCodeAt(0));
        try {
          if (bytes.byteLength !== expected.plaintextBytes || await hashBytes(bytes, signal) !== expected.contentSha256
            || await hashBytes(new TextEncoder().encode(canonicalJson(manifestFromAsset(asset))), signal) !== expected.manifestSha256)
            throw new Error('Encrypted attachment differs from the frozen migration asset.');
        } finally {
          bytes.fill(0);
        }
      }
    },

    async deleteLocal(asset: { assetId: string }, signal?: AbortSignal) {
      throwIfAborted(signal);
      await local.deleteAsset(asset.assetId);
    },

    async prepareForUpload(
      assetIds: readonly DBlobAssetId[],
      signal?: AbortSignal,
      operationIds: Readonly<Record<string, string>> = {},
    ) {
      for (const assetId of [...new Set(assetIds)]) {
        throwIfAborted(signal);
        const asset = await local.getAsset(assetId);
        if (!asset) throw new Error(`Local encrypted attachment ${assetId} was not found.`);
        const prepared = await preparedChunks(deps, asset, local, hashBytes, signal);
        try {
          throwIfAborted(signal);
          const operationId = operationIds[assetId] ?? createOperationId();
          const reservation = await transport.reserveUpload({
            operationId,
            opaqueAssetId: prepared.opaqueAssetId,
            chunks: prepared.chunks.map(({ chunk, object, objectSha256 }) => ({
              opaqueChunkId: chunk.opaqueChunkId,
              chunkIndex: chunk.chunkIndex,
              ciphertextBytes: chunk.ciphertextBytes,
              objectBytes: object.byteLength,
              objectSha256,
            })),
          });
          if (reservation.status === 'already-uploaded') continue;
          try {
            for (const upload of reservation.chunks) {
              throwIfAborted(signal);
              const preparedChunk = prepared.chunks[upload.chunkIndex];
              if (!preparedChunk || preparedChunk.chunk.opaqueChunkId !== upload.opaqueChunkId)
                throw new Error('Encrypted attachment reservation order is invalid.');
              await transport.uploadChunk({ ...upload, bytes: preparedChunk.object, signal });
            }
            throwIfAborted(signal);
            await transport.finalizeUpload(operationId);
          } catch (error) {
            await transport.releaseReservation(operationId).catch(() => undefined);
            throw error;
          }
        } finally {
          for (const chunk of prepared.chunks) chunk.object.fill(0);
        }
      }
    },

    async prepareForHydrate(assetIds: readonly DBlobAssetId[], signal?: AbortSignal) {
      const materialized: string[] = [];
      try {
        for (const assetId of [...new Set(assetIds)]) {
          throwIfAborted(signal);
          if (await local.hasAsset(assetId)) continue;
          if (await materializeAsset(await decryptAsset(assetId, await downloadChunks(assetId, signal)))) materialized.push(assetId);
          throwIfAborted(signal);
        }
      } catch (error) {
        await rollbackAssets(materialized);
        throw error;
      }
    },

    async clearHydratedAssets() {
      for (const assetId of await local.listHydratedAssetIds(deps.vaultId)) {
        await local.deleteAsset(assetId);
        await local.unmarkHydratedAsset(deps.vaultId, assetId);
      }
    },

    async *exportAssetChunks(assetIds: readonly DBlobAssetId[], signal?: AbortSignal): AsyncGenerator<PrivateProEncryptedBackupAsset> {
      for (const assetId of [...new Set(assetIds)]) {
        const { opaqueId, ordered } = await orderedDownload(assetId);
        const totalPlaintextBytes = ordered.reduce((sum, chunk) => sum + chunk.ciphertextBytes - 16, 0);
        for (const chunk of ordered) {
          const object = await verifiedObject(chunk, signal);
          try {
            const decoded = decodePrivateProVaultAssetChunkObject({
              formatVersion: 1,
              schemaVersion: 1,
              keyVersion: deps.keyVersion,
              opaqueAssetId: opaqueId,
              opaqueChunkId: chunk.opaqueChunkId,
              chunkIndex: chunk.chunkIndex,
              chunkCount: ordered.length,
              totalPlaintextBytes,
              plaintextBytes: chunk.ciphertextBytes - 16,
              ciphertextBytes: chunk.ciphertextBytes,
            }, object);
            yield {
              kind: 'asset',
              formatVersion: 1,
              assetId: decoded.opaqueAssetId,
              chunkId: decoded.opaqueChunkId,
              chunkIndex: decoded.chunkIndex,
              keyVersion: decoded.keyVersion,
              nonceBase64: decoded.nonceBase64,
              ciphertextBase64: decoded.ciphertextBase64,
              ciphertextBytes: decoded.ciphertextBytes,
            };
          } finally {
            object.fill(0);
          }
        }
      }
    },

    async importAssetChunks(chunks: readonly PrivateProEncryptedBackupAsset[]) {
      const byAsset = new Map<string, PrivateProEncryptedBackupAsset[]>();
      for (const chunk of chunks) {
        const existing = byAsset.get(chunk.assetId) ?? [];
        existing.push(chunk);
        byAsset.set(chunk.assetId, existing);
      }
      const materialized: string[] = [];
      try {
        for (const [opaqueId, assetChunks] of byAsset) {
          const ordered = [...assetChunks].sort((left, right) => left.chunkIndex - right.chunkIndex);
          if (ordered.some((chunk, index) => chunk.chunkIndex !== index || chunk.assetId !== opaqueId))
            throw new Error('Encrypted backup attachment chunks are out of order.');
          const totalPlaintextBytes = ordered.reduce((sum, chunk) => sum + chunk.ciphertextBytes - 16, 0);
          const restored = ordered.map(chunk => ({
            formatVersion: 1 as const,
            schemaVersion: 1 as const,
            keyVersion: chunk.keyVersion,
            opaqueAssetId: chunk.assetId,
            opaqueChunkId: chunk.chunkId,
            chunkIndex: chunk.chunkIndex,
            chunkCount: ordered.length,
            totalPlaintextBytes,
            plaintextBytes: chunk.ciphertextBytes - 16,
            nonceBase64: chunk.nonceBase64,
            ciphertextBase64: chunk.ciphertextBase64,
            ciphertextBytes: chunk.ciphertextBytes,
          }));
          const encoder = new StreamingBase64Encoder();
          const manifest = await decryptPrivateProVaultAssetToSink(
            { masterKey: deps.masterKey, vaultId: deps.vaultId, chunks: restored },
            plaintext => encoder.write(plaintext),
          );
          if (await privateProVaultAssetId(deps.masterKey, manifest.assetId) !== opaqueId)
            throw new Error('Encrypted backup attachment identity is invalid.');
          const asset = assetFromManifest(manifest, encoder.finish());
          if (await materializeAsset(asset)) materialized.push(asset.id);
        }
        return materialized;
      } catch (error) {
        await rollbackAssets(materialized);
        throw error;
      }
    },

    rollbackImportedAssets: rollbackAssets,
  };
}

export type PrivateProVaultAssetClient = ReturnType<typeof createPrivateProVaultAssetClient>;
