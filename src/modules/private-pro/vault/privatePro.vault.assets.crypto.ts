import * as z from 'zod/v4';

import { deriveVaultSubkey, hmacVaultIdentifier } from './privatePro.vault.crypto';


export const PRIVATE_PRO_VAULT_ASSET_CIPHER_SUITE = 'AES-256-GCM+HKDF-SHA-256';
export const PRIVATE_PRO_VAULT_ASSET_MAX_CIPHERTEXT_CHUNK_BYTES = 4 * 1024 * 1024;
export const PRIVATE_PRO_VAULT_ASSET_MAX_PLAINTEXT_CHUNK_BYTES = PRIVATE_PRO_VAULT_ASSET_MAX_CIPHERTEXT_CHUNK_BYTES - 16;
export const PRIVATE_PRO_VAULT_ASSET_MAX_MANIFEST_BYTES = 256 * 1024;
export const PRIVATE_PRO_VAULT_ASSET_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

const AES_GCM_NONCE_BYTES = 12;
const FRAME_HEADER_BYTES = 24;
const FRAME_MAGIC = Uint8Array.of(0x42, 0x41, 0x56, 0x4c, 0x54, 0x30, 0x30, 0x31); // BAVLT001
const OPAQUE_ID = /^[A-Za-z0-9_-]{43}$/;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

const AssetOriginSchema = z.discriminatedUnion('ot', [
  z.object({
    ot: z.literal('user'),
    source: z.literal('attachment'),
    media: z.string().min(1).max(200),
    url: z.string().max(32 * 1024).optional(),
    fileName: z.string().max(2_000).optional(),
  }).strict(),
  z.object({
    ot: z.literal('generated'),
    source: z.literal('ai-text-to-image'),
    generatorName: z.string().max(2_000),
    prompt: z.string().max(PRIVATE_PRO_VAULT_ASSET_MAX_MANIFEST_BYTES),
    parameters: z.record(z.string().min(1).max(256), z.json()),
    generatedAt: z.string().max(100).optional(),
  }).strict(),
]);

const ImageAssetMetadataSchema = z.object({
  width: z.number().int().nonnegative().max(1_000_000),
  height: z.number().int().nonnegative().max(1_000_000),
  averageColor: z.string().max(100).optional(),
  author: z.string().max(2_000).optional(),
  tags: z.array(z.string().max(1_000)).max(256).optional(),
  description: z.string().max(32 * 1024).optional(),
}).strict();

const AudioAssetMetadataSchema = z.object({
  duration: z.number().nonnegative().max(365 * 24 * 60 * 60),
  sampleRate: z.number().positive().max(1_000_000),
  bitrate: z.number().positive().max(1_000_000_000).optional(),
  channels: z.number().int().positive().max(128).optional(),
}).strict();

const AssetManifestBaseSchema = z.object({
  formatVersion: z.literal(1),
  schemaVersion: z.literal(1),
  assetId: z.string().min(1).max(512),
  contextId: z.literal('global'),
  scopeId: z.enum(['app-chat', 'app-draw', 'attachment-drafts']),
  label: z.string().max(2_000),
  origin: AssetOriginSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

const PrivateProVaultAssetManifestSchema = z.discriminatedUnion('assetType', [
  AssetManifestBaseSchema.extend({
    assetType: z.literal('image'),
    contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    metadata: ImageAssetMetadataSchema,
  }).strict(),
  AssetManifestBaseSchema.extend({
    assetType: z.literal('audio'),
    contentType: z.enum(['audio/mpeg', 'audio/wav']),
    metadata: AudioAssetMetadataSchema,
  }).strict(),
]);

export type PrivateProVaultAssetManifest = z.infer<typeof PrivateProVaultAssetManifestSchema>;

export interface PrivateProVaultAssetChunk {
  formatVersion: 1;
  schemaVersion: 1;
  keyVersion: number;
  opaqueAssetId: string;
  opaqueChunkId: string;
  chunkIndex: number;
  chunkCount: number;
  totalPlaintextBytes: number;
  plaintextBytes: number;
  nonceBase64: string;
  ciphertextBase64: string;
  ciphertextBytes: number;
}

export interface PrivateProVaultAssetChunkAADInput extends Omit<PrivateProVaultAssetChunk, 'nonceBase64' | 'ciphertextBase64' | 'ciphertextBytes'> {
  vaultId: string;
}

export type PrivateProVaultAssetChunkEncryptor = (
  key: CryptoKey,
  aad: PrivateProVaultAssetChunkAADInput,
  plaintext: Uint8Array,
  nonce: Uint8Array,
  signal?: AbortSignal,
) => Promise<PrivateProVaultAssetChunk>;

export type PrivateProVaultAssetPlaintextSource = Uint8Array | Blob | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

export interface EncryptPrivateProVaultAssetStreamInput {
  masterKey: CryptoKey;
  vaultId: string;
  opaqueAssetId: string;
  keyVersion: number;
  manifest: PrivateProVaultAssetManifest;
  plaintextBytes: number;
  source: PrivateProVaultAssetPlaintextSource;
  signal?: AbortSignal;
  encryptChunk?: PrivateProVaultAssetChunkEncryptor;
}

export interface EncryptPrivateProVaultAssetInput extends Omit<
  EncryptPrivateProVaultAssetStreamInput,
  'plaintextBytes' | 'source'
> {
  plaintext: Uint8Array;
}

export interface DecryptPrivateProVaultAssetInput {
  masterKey: CryptoKey;
  vaultId: string;
  chunks: readonly PrivateProVaultAssetChunk[];
}

export interface PrivateProVaultAssetChunkPlan {
  manifest: PrivateProVaultAssetManifest;
  manifestBytes: Uint8Array<ArrayBuffer>;
  firstPayloadBytes: number;
  totalFramedPlaintextBytes: number;
  chunkPlaintextBytes: readonly number[];
}

export type PrivateProVaultAssetStoredChunkMetadata = Omit<
  PrivateProVaultAssetChunk,
  'nonceBase64' | 'ciphertextBase64'
>;


function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff)
        throw new Error('Vault asset strings must contain valid Unicode text.');
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error('Vault asset strings must contain valid Unicode text.');
    }
  }
}

function assertJsonStrings(value: unknown, depth = 0): void {
  if (depth > 32) throw new Error('Encrypted asset metadata is nested too deeply.');
  if (typeof value === 'string') {
    assertUnicodeScalarString(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonStrings(item, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assertUnicodeScalarString(key);
      assertJsonStrings(item, depth + 1);
    }
  }
}

function lengthPrefixed(...values: string[]): Uint8Array<ArrayBuffer> {
  const encoded = values.map(value => {
    assertUnicodeScalarString(value);
    return `${textEncoder.encode(value).byteLength}:${value}`;
  });
  return textEncoder.encode(encoded.join('|'));
}

function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000)
    parts.push(String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.byteLength))));
  return btoa(parts.join(''));
}

function base64ToBytes(value: string, expectedBytes?: number): Uint8Array<ArrayBuffer> {
  if (value.length % 4 !== 0) throw new Error('Encrypted asset bytes must use canonical base64.');
  try {
    const binary = atob(value);
    if (btoa(binary) !== value || expectedBytes !== undefined && binary.length !== expectedBytes)
      throw new Error('invalid');
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    throw new Error('Encrypted asset bytes must use canonical base64.');
  }
}

function assetChunkAAD(input: PrivateProVaultAssetChunkAADInput): Uint8Array<ArrayBuffer> {
  return lengthPrefixed(
    'big-agi/private-pro/vault/asset-chunk-aad/v1',
    input.vaultId,
    input.opaqueAssetId,
    input.opaqueChunkId,
    String(input.chunkIndex),
    String(input.chunkCount),
    String(input.totalPlaintextBytes),
    String(input.plaintextBytes),
    String(input.keyVersion),
    String(input.schemaVersion),
    String(input.formatVersion),
    PRIVATE_PRO_VAULT_ASSET_CIPHER_SUITE,
  );
}

function assetChunkNonceInput(aad: PrivateProVaultAssetChunkAADInput, plaintext: Uint8Array): Uint8Array<ArrayBuffer> {
  const domain = textEncoder.encode('big-agi/private-pro/vault/asset-plaintext-nonce/v2');
  const aadBytes = assetChunkAAD(aad);
  const nonceInput = new Uint8Array(8 + domain.byteLength + aadBytes.byteLength + plaintext.byteLength);
  const view = new DataView(nonceInput.buffer);
  view.setUint32(0, domain.byteLength, false);
  nonceInput.set(domain, 4);
  view.setUint32(4 + domain.byteLength, aadBytes.byteLength, false);
  nonceInput.set(aadBytes, 8 + domain.byteLength);
  nonceInput.set(plaintext, 8 + domain.byteLength + aadBytes.byteLength);
  domain.fill(0);
  aadBytes.fill(0);
  return nonceInput;
}

function assertSafePositive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
}

function assertSafeNonnegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer.`);
}

function assertOpaqueId(value: string, label: string): void {
  if (!OPAQUE_ID.test(value)) throw new Error(`${label} must be an opaque identifier.`);
}

function abortError(): DOMException {
  return new DOMException('The encrypted attachment operation was aborted.', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function bestEffortCleanup(cleanup: () => unknown): () => void {
  let invoked = false;
  return () => {
    if (invoked) return;
    invoked = true;
    try {
      void Promise.resolve(cleanup()).catch(() => undefined);
    } catch {
      // Cleanup is best effort and must never replace the primary result.
    }
  };
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal, onAbort?: () => void): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => undefined);
    onAbort?.();
    throw abortError();
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', handleAbort);
      action();
    };
    const handleAbort = () => finish(() => {
      onAbort?.();
      reject(abortError());
    });
    signal.addEventListener('abort', handleAbort, { once: true });
    promise.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );
  });
}

async function assetCipherKey(masterKey: CryptoKey, opaqueAssetId: string, usage: 'encrypt' | 'decrypt') {
  return deriveVaultSubkey(masterKey, 'asset-encryption/v1', opaqueAssetId, [usage]);
}

async function assetIdentifierKey(masterKey: CryptoKey, opaqueAssetId: string) {
  return deriveVaultSubkey(masterKey, 'asset-identifiers/v1', opaqueAssetId, ['sign']);
}

async function assetNonceKey(masterKey: CryptoKey, opaqueAssetId: string) {
  return deriveVaultSubkey(masterKey, 'asset-plaintext-nonces/v2', opaqueAssetId, ['sign']);
}

async function chunkId(key: CryptoKey, index: number): Promise<string> {
  return hmacVaultIdentifier(key, 'chunk', String(index));
}

async function chunkNonce(
  key: CryptoKey,
  aad: PrivateProVaultAssetChunkAADInput,
  plaintext: Uint8Array,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const nonceInput = assetChunkNonceInput(aad, plaintext);
  try {
    const signature = new Uint8Array(await awaitWithAbort(crypto.subtle.sign('HMAC', key, nonceInput), signal));
    try {
      return signature.slice(0, AES_GCM_NONCE_BYTES);
    } finally {
      signature.fill(0);
    }
  } finally {
    nonceInput.fill(0);
  }
}

function validateManifest(input: unknown): { manifest: PrivateProVaultAssetManifest; bytes: Uint8Array<ArrayBuffer> } {
  assertJsonStrings(input);
  const manifest = PrivateProVaultAssetManifestSchema.parse(input);
  const bytes = textEncoder.encode(JSON.stringify(manifest));
  if (bytes.byteLength > PRIVATE_PRO_VAULT_ASSET_MAX_MANIFEST_BYTES)
    throw new Error('Encrypted asset manifest exceeds the size limit.');
  return { manifest, bytes };
}

export function privateProVaultAssetChunkPlan(
  manifestInput: PrivateProVaultAssetManifest,
  totalPlaintextBytes: number,
): PrivateProVaultAssetChunkPlan {
  assertSafeNonnegative(totalPlaintextBytes, 'Encrypted asset plaintext size');
  if (totalPlaintextBytes > PRIVATE_PRO_VAULT_ASSET_MAX_PAYLOAD_BYTES)
    throw new Error('Attachment exceeds the encrypted asset limit.');
  const { manifest, bytes: manifestBytes } = validateManifest(manifestInput);
  const firstCapacity = PRIVATE_PRO_VAULT_ASSET_MAX_PLAINTEXT_CHUNK_BYTES - FRAME_HEADER_BYTES - manifestBytes.byteLength;
  if (firstCapacity < 0) throw new Error('Encrypted asset manifest exceeds the chunk limit.');
  const firstPayloadBytes = Math.min(totalPlaintextBytes, firstCapacity);
  const chunkPlaintextBytes = [FRAME_HEADER_BYTES + manifestBytes.byteLength + firstPayloadBytes];
  let remaining = totalPlaintextBytes - firstPayloadBytes;
  while (remaining > 0) {
    const size = Math.min(remaining, PRIVATE_PRO_VAULT_ASSET_MAX_PLAINTEXT_CHUNK_BYTES);
    chunkPlaintextBytes.push(size);
    remaining -= size;
  }
  return {
    manifest,
    manifestBytes,
    firstPayloadBytes,
    totalFramedPlaintextBytes: FRAME_HEADER_BYTES + manifestBytes.byteLength + totalPlaintextBytes,
    chunkPlaintextBytes,
  };
}

function framedFirstChunk(manifestBytes: Uint8Array, payload: Uint8Array, totalPayloadBytes: number): Uint8Array<ArrayBuffer> {
  const framed = new Uint8Array(FRAME_HEADER_BYTES + manifestBytes.byteLength + payload.byteLength);
  framed.set(FRAME_MAGIC, 0);
  const view = new DataView(framed.buffer);
  view.setUint32(8, manifestBytes.byteLength, false);
  view.setUint32(12, payload.byteLength, false);
  view.setUint32(16, totalPayloadBytes, false);
  view.setUint32(20, 0, false);
  framed.set(manifestBytes, FRAME_HEADER_BYTES);
  framed.set(payload, FRAME_HEADER_BYTES + manifestBytes.byteLength);
  return framed;
}

function validateChunkShape(chunk: PrivateProVaultAssetChunk): void {
  assertOpaqueId(chunk.opaqueAssetId, 'Encrypted asset ID');
  assertOpaqueId(chunk.opaqueChunkId, 'Encrypted chunk ID');
  assertSafePositive(chunk.keyVersion, 'Encrypted asset key version');
  assertSafeNonnegative(chunk.chunkIndex, 'Encrypted asset chunk index');
  assertSafePositive(chunk.chunkCount, 'Encrypted asset chunk count');
  assertSafeNonnegative(chunk.totalPlaintextBytes, 'Encrypted asset plaintext size');
  assertSafePositive(chunk.plaintextBytes, 'Encrypted asset chunk plaintext size');
  if (chunk.formatVersion !== 1 || chunk.schemaVersion !== 1)
    throw new Error('Encrypted asset schema is unsupported.');
  if (chunk.ciphertextBytes !== chunk.plaintextBytes + 16 || chunk.ciphertextBytes > PRIVATE_PRO_VAULT_ASSET_MAX_CIPHERTEXT_CHUNK_BYTES)
    throw new Error('Encrypted asset chunk size is invalid.');
}

export async function encryptPrivateProVaultAssetChunk(
  key: CryptoKey,
  aad: PrivateProVaultAssetChunkAADInput,
  plaintext: Uint8Array,
  nonceInput?: Uint8Array,
  signal?: AbortSignal,
): Promise<PrivateProVaultAssetChunk> {
  throwIfAborted(signal);
  const nonce = nonceInput ? Uint8Array.from(nonceInput) : crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_BYTES));
  try {
    if (nonce.byteLength !== AES_GCM_NONCE_BYTES) throw new Error('Encrypted asset nonce length is invalid.');
    const ciphertext = new Uint8Array(await awaitWithAbort(crypto.subtle.encrypt({
      name: 'AES-GCM',
      iv: nonce,
      additionalData: assetChunkAAD(aad),
    }, key, new Uint8Array(plaintext)), signal));
    if (ciphertext.byteLength > PRIVATE_PRO_VAULT_ASSET_MAX_CIPHERTEXT_CHUNK_BYTES)
      throw new Error('Encrypted asset chunk exceeds the ciphertext limit.');
    return {
      formatVersion: aad.formatVersion,
      schemaVersion: aad.schemaVersion,
      keyVersion: aad.keyVersion,
      opaqueAssetId: aad.opaqueAssetId,
      opaqueChunkId: aad.opaqueChunkId,
      chunkIndex: aad.chunkIndex,
      chunkCount: aad.chunkCount,
      totalPlaintextBytes: aad.totalPlaintextBytes,
      plaintextBytes: aad.plaintextBytes,
      nonceBase64: bytesToBase64(nonce),
      ciphertextBase64: bytesToBase64(ciphertext),
      ciphertextBytes: ciphertext.byteLength,
    };
  } finally {
    nonce.fill(0);
  }
}

async function* sourceChunks(source: PrivateProVaultAssetPlaintextSource, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  throwIfAborted(signal);
  if (source instanceof Uint8Array) {
    if (source.byteLength) yield source;
    return;
  }
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    const reader = source.stream().getReader();
    const cancel = bestEffortCleanup(() => reader.cancel());
    const release = bestEffortCleanup(() => reader.releaseLock());
    try {
      while (true) {
        const result = await awaitWithAbort(reader.read(), signal, cancel);
        if (result.done) return;
        throwIfAborted(signal);
        if (result.value.byteLength) yield result.value;
      }
    } finally {
      if (signal?.aborted) cancel();
      release();
    }
  }
  else if ('getReader' in source) {
    const reader = source.getReader();
    const cancel = bestEffortCleanup(() => reader.cancel());
    const release = bestEffortCleanup(() => reader.releaseLock());
    try {
      while (true) {
        const result = await awaitWithAbort(reader.read(), signal, cancel);
        if (result.done) return;
        throwIfAborted(signal);
        if (result.value.byteLength) yield result.value;
      }
    } finally {
      if (signal?.aborted) cancel();
      release();
    }
  }
  else {
    const iterable = source as AsyncIterable<Uint8Array>;
    const iterator = iterable[Symbol.asyncIterator]();
    const close = bestEffortCleanup(() => iterator.return?.());
    try {
      while (true) {
        const result = await awaitWithAbort(iterator.next(), signal, close);
        if (result.done) return;
        throwIfAborted(signal);
        if (!(result.value instanceof Uint8Array)) throw new Error('Encrypted asset source emitted invalid bytes.');
        if (result.value.byteLength) yield result.value;
      }
    } finally {
      if (signal?.aborted) close();
    }
  }
}

class BoundedSourceReader {
  private remainder: Uint8Array | null = null;
  private readonly iterator: AsyncIterator<Uint8Array>;
  private readonly close: () => void;

  constructor(source: PrivateProVaultAssetPlaintextSource, private readonly signal?: AbortSignal) {
    this.iterator = sourceChunks(source, signal)[Symbol.asyncIterator]();
    this.close = bestEffortCleanup(() => this.iterator.return?.());
  }

  async readExactly(size: number): Promise<Uint8Array<ArrayBuffer>> {
    const output = new Uint8Array(size);
    let offset = 0;
    try {
      while (offset < size) {
        throwIfAborted(this.signal);
        if (!this.remainder) {
          const next = await this.iterator.next();
          if (next.done) throw new Error('Encrypted asset source ended before its declared size.');
          this.remainder = Uint8Array.from(next.value);
        }
        const copied = Math.min(size - offset, this.remainder.byteLength);
        output.set(this.remainder.subarray(0, copied), offset);
        this.remainder.subarray(0, copied).fill(0);
        offset += copied;
        this.remainder = copied === this.remainder.byteLength ? null : this.remainder.subarray(copied);
      }
      return output;
    } catch (error) {
      output.fill(0);
      this.remainder?.fill(0);
      this.remainder = null;
      if (this.signal?.aborted) this.close();
      throw error;
    }
  }

  async assertDone(): Promise<void> {
    throwIfAborted(this.signal);
    if (this.remainder?.byteLength) throw new Error('Encrypted asset source exceeds its declared size.');
    const next = await this.iterator.next();
    if (!next.done) throw new Error('Encrypted asset source exceeds its declared size.');
  }
}

export async function privateProVaultAssetId(masterKey: CryptoKey, assetId: string): Promise<string> {
  assertUnicodeScalarString(assetId);
  const key = await deriveVaultSubkey(masterKey, 'asset-logical-identifiers/v1', 'dblob-assets', ['sign']);
  return hmacVaultIdentifier(key, 'asset', assetId);
}

export async function* encryptPrivateProVaultAssetChunks(
  input: EncryptPrivateProVaultAssetStreamInput,
): AsyncGenerator<PrivateProVaultAssetChunk> {
  throwIfAborted(input.signal);
  assertOpaqueId(input.opaqueAssetId, 'Encrypted asset ID');
  assertSafePositive(input.keyVersion, 'Encrypted asset key version');
  if (!input.vaultId) throw new Error('Encrypted assets require a vault ID.');
  const plan = privateProVaultAssetChunkPlan(input.manifest, input.plaintextBytes);
  if (await privateProVaultAssetId(input.masterKey, plan.manifest.assetId) !== input.opaqueAssetId)
    throw new Error('Encrypted asset identity does not match its manifest.');
  throwIfAborted(input.signal);
  const [key, identifierKey, nonceKey] = await Promise.all([
    assetCipherKey(input.masterKey, input.opaqueAssetId, 'encrypt'),
    assetIdentifierKey(input.masterKey, input.opaqueAssetId),
    assetNonceKey(input.masterKey, input.opaqueAssetId),
  ]);
  const reader = new BoundedSourceReader(input.source, input.signal);
  const encryptChunk = input.encryptChunk ?? encryptPrivateProVaultAssetChunk;
  try {
    for (let chunkIndex = 0; chunkIndex < plan.chunkPlaintextBytes.length; chunkIndex++) {
      throwIfAborted(input.signal);
      const payloadBytes = chunkIndex === 0
        ? plan.firstPayloadBytes
        : plan.chunkPlaintextBytes[chunkIndex];
      const payload = await reader.readExactly(payloadBytes);
      const plaintext = chunkIndex === 0 ? framedFirstChunk(plan.manifestBytes, payload, input.plaintextBytes) : payload;
      try {
        throwIfAborted(input.signal);
        const opaqueChunkId = await chunkId(identifierKey, chunkIndex);
        const aad = {
          vaultId: input.vaultId,
          formatVersion: 1 as const,
          schemaVersion: 1 as const,
          keyVersion: input.keyVersion,
          opaqueAssetId: input.opaqueAssetId,
          opaqueChunkId,
          chunkIndex,
          chunkCount: plan.chunkPlaintextBytes.length,
          totalPlaintextBytes: plan.totalFramedPlaintextBytes,
          plaintextBytes: plaintext.byteLength,
        };
        const nonce = await chunkNonce(nonceKey, aad, plaintext, input.signal);
        try {
          yield await encryptChunk(key, aad, plaintext, nonce, input.signal);
        } finally {
          nonce.fill(0);
        }
      } finally {
        plaintext.fill(0);
        if (plaintext !== payload) payload.fill(0);
      }
    }
    await reader.assertDone();
  } finally {
    plan.manifestBytes.fill(0);
  }
}

export async function encryptPrivateProVaultAsset(
  input: EncryptPrivateProVaultAssetInput,
): Promise<PrivateProVaultAssetChunk[]> {
  throwIfAborted(input.signal);
  const chunks: PrivateProVaultAssetChunk[] = [];
  for await (const chunk of encryptPrivateProVaultAssetChunks({
    ...input,
    plaintextBytes: input.plaintext.byteLength,
    source: input.plaintext,
  })) chunks.push(chunk);
  return chunks;
}

function parseFirstChunkFrame(plaintext: Uint8Array): {
  manifest: PrivateProVaultAssetManifest;
  manifestBytes: Uint8Array<ArrayBuffer>;
  payload: Uint8Array;
  totalPayloadBytes: number;
} {
  if (plaintext.byteLength < FRAME_HEADER_BYTES)
    throw new Error('Encrypted asset manifest frame is truncated.');
  for (let index = 0; index < FRAME_MAGIC.byteLength; index++) {
    if (plaintext[index] !== FRAME_MAGIC[index]) throw new Error('Encrypted asset manifest frame is invalid.');
  }
  const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  const manifestLength = view.getUint32(8, false);
  const payloadLength = view.getUint32(12, false);
  const totalPayloadBytes = view.getUint32(16, false);
  const reserved = view.getUint32(20, false);
  if (
    manifestLength === 0
    || manifestLength > PRIVATE_PRO_VAULT_ASSET_MAX_MANIFEST_BYTES
    || payloadLength > totalPayloadBytes
    || reserved !== 0
    || FRAME_HEADER_BYTES + manifestLength + payloadLength !== plaintext.byteLength
  ) throw new Error('Encrypted asset manifest framing is invalid.');
  const manifestBytes = Uint8Array.from(plaintext.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + manifestLength));
  let decoded: unknown;
  try {
    decoded = JSON.parse(textDecoder.decode(manifestBytes));
  } catch {
    throw new Error('Encrypted asset manifest is invalid.');
  }
  const manifest = validateManifest(decoded).manifest;
  if (JSON.stringify(manifest) !== textDecoder.decode(manifestBytes))
    throw new Error('Encrypted asset manifest is not canonical.');
  return {
    manifest,
    manifestBytes,
    payload: plaintext.subarray(FRAME_HEADER_BYTES + manifestLength),
    totalPayloadBytes,
  };
}

export async function decryptPrivateProVaultAssetToSink(
  input: DecryptPrivateProVaultAssetInput,
  write: (chunk: Uint8Array) => void | Promise<void>,
): Promise<PrivateProVaultAssetManifest> {
  if (!input.vaultId || input.chunks.length === 0) throw new Error('Encrypted asset chunks are missing.');
  const first = input.chunks[0];
  validateChunkShape(first);
  if (first.chunkIndex !== 0 || first.chunkCount !== input.chunks.length)
    throw new Error('Encrypted asset chunk count or order is invalid.');
  if (first.totalPlaintextBytes > PRIVATE_PRO_VAULT_ASSET_MAX_PAYLOAD_BYTES + PRIVATE_PRO_VAULT_ASSET_MAX_MANIFEST_BYTES + FRAME_HEADER_BYTES)
    throw new Error('Encrypted asset exceeds the plaintext size limit.');
  const totalFramedPlaintextBytes = input.chunks.reduce((sum, chunk) => sum + chunk.plaintextBytes, 0);
  if (!Number.isSafeInteger(totalFramedPlaintextBytes) || first.totalPlaintextBytes !== totalFramedPlaintextBytes)
    throw new Error('Encrypted asset total plaintext size is invalid.');

  const [key, identifierKey] = await Promise.all([
    assetCipherKey(input.masterKey, first.opaqueAssetId, 'decrypt'),
    assetIdentifierKey(input.masterKey, first.opaqueAssetId),
  ]);
  const nonces = new Set<string>();
  let manifest: PrivateProVaultAssetManifest | null = null;
  let plan: PrivateProVaultAssetChunkPlan | null = null;
  let written = 0;
  try {
    for (let index = 0; index < input.chunks.length; index++) {
      const chunk = input.chunks[index];
      validateChunkShape(chunk);
      if (
        chunk.chunkIndex !== index
        || chunk.chunkCount !== first.chunkCount
        || chunk.opaqueAssetId !== first.opaqueAssetId
        || chunk.keyVersion !== first.keyVersion
        || chunk.totalPlaintextBytes !== first.totalPlaintextBytes
        || chunk.opaqueChunkId !== await chunkId(identifierKey, index)
      ) throw new Error('Encrypted asset chunk order or metadata is invalid.');
      if (nonces.has(chunk.nonceBase64)) throw new Error('Encrypted asset chunks reuse a nonce.');
      nonces.add(chunk.nonceBase64);

      let plaintext: Uint8Array<ArrayBuffer>;
      try {
        plaintext = new Uint8Array(await crypto.subtle.decrypt({
          name: 'AES-GCM',
          iv: base64ToBytes(chunk.nonceBase64, AES_GCM_NONCE_BYTES),
          additionalData: assetChunkAAD({ vaultId: input.vaultId, ...chunk }),
        }, key, base64ToBytes(chunk.ciphertextBase64, chunk.ciphertextBytes)));
      } catch {
        throw new Error('Encrypted asset authentication failed.');
      }
      try {
        if (plaintext.byteLength !== chunk.plaintextBytes)
          throw new Error('Encrypted asset chunk plaintext size is invalid.');
        if (index === 0) {
          const frame = parseFirstChunkFrame(plaintext);
          manifest = frame.manifest;
          plan = privateProVaultAssetChunkPlan(manifest, frame.totalPayloadBytes);
          if (
            plan.totalFramedPlaintextBytes !== first.totalPlaintextBytes
            || plan.chunkPlaintextBytes.length !== first.chunkCount
            || plan.chunkPlaintextBytes[0] !== chunk.plaintextBytes
            || await privateProVaultAssetId(input.masterKey, manifest.assetId) !== first.opaqueAssetId
          ) throw new Error('Encrypted asset manifest does not match its chunks.');
          await write(frame.payload);
          written += frame.payload.byteLength;
          frame.manifestBytes.fill(0);
        } else {
          if (!plan || plan.chunkPlaintextBytes[index] !== chunk.plaintextBytes)
            throw new Error('Encrypted asset chunk sizing is invalid.');
          await write(plaintext);
          written += plaintext.byteLength;
        }
      } finally {
        plaintext.fill(0);
      }
    }
    if (!manifest || !plan || written !== plan.totalFramedPlaintextBytes - FRAME_HEADER_BYTES - plan.manifestBytes.byteLength)
      throw new Error('Encrypted asset is missing plaintext bytes.');
    return manifest;
  } finally {
    plan?.manifestBytes.fill(0);
  }
}

export async function decryptPrivateProVaultAsset(
  input: DecryptPrivateProVaultAssetInput,
): Promise<{ manifest: PrivateProVaultAssetManifest; plaintext: Uint8Array<ArrayBuffer> }> {
  const output = new Uint8Array(input.chunks[0]?.totalPlaintextBytes ?? 0);
  let offset = 0;
  const manifest = await decryptPrivateProVaultAssetToSink(input, chunk => {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return { manifest, plaintext: output.slice(0, offset) };
}

export function encodePrivateProVaultAssetChunkObject(chunk: PrivateProVaultAssetChunk): Uint8Array<ArrayBuffer> {
  validateChunkShape(chunk);
  const nonce = base64ToBytes(chunk.nonceBase64, AES_GCM_NONCE_BYTES);
  const ciphertext = base64ToBytes(chunk.ciphertextBase64, chunk.ciphertextBytes);
  const object = new Uint8Array(nonce.byteLength + ciphertext.byteLength);
  object.set(nonce, 0);
  object.set(ciphertext, nonce.byteLength);
  return object;
}

export function decodePrivateProVaultAssetChunkObject(
  metadata: PrivateProVaultAssetStoredChunkMetadata,
  object: Uint8Array,
): PrivateProVaultAssetChunk {
  if (object.byteLength !== AES_GCM_NONCE_BYTES + metadata.ciphertextBytes)
    throw new Error('Encrypted asset object size is invalid.');
  const chunk: PrivateProVaultAssetChunk = {
    ...metadata,
    nonceBase64: bytesToBase64(object.subarray(0, AES_GCM_NONCE_BYTES)),
    ciphertextBase64: bytesToBase64(object.subarray(AES_GCM_NONCE_BYTES)),
  };
  validateChunkShape(chunk);
  return chunk;
}
