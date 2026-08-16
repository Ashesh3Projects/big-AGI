import { SyncChunkSchema, type SyncChunk } from './privatePro.sync.schemas';


const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const blockSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += blockSize)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + blockSize));
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function privateProHash(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  const ownedBytes = Uint8Array.from(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', ownedBytes.buffer));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function splitSyncPayload(payload: string, maxBytes: number): Promise<SyncChunk[]> {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error('Sync chunk limit must be a positive integer.');
  const bytes = encoder.encode(payload);
  const chunks: SyncChunk[] = [];
  for (let offset = 0, index = 0; offset < bytes.length || (bytes.length === 0 && index === 0); offset += maxBytes, index++) {
    const chunkBytes = bytes.slice(offset, Math.min(bytes.length, offset + maxBytes));
    chunks.push(SyncChunkSchema.parse({
      id: index.toString(36).padStart(6, '0'),
      index,
      byteLength: chunkBytes.byteLength,
      hash: await privateProHash(chunkBytes),
      payloadBase64: bytesToBase64(chunkBytes),
    }));
    if (bytes.length === 0) break;
  }
  return chunks;
}

export async function joinSyncChunks(input: ReadonlyArray<SyncChunk>): Promise<string> {
  const chunks = [...input].map(chunk => SyncChunkSchema.parse(chunk)).sort((a, b) => a.index - b.index);
  const decoded: Uint8Array[] = [];
  let totalBytes = 0;
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    if (chunk.index !== index) throw new Error('Sync chunks are incomplete or duplicated.');
    const bytes = base64ToBytes(chunk.payloadBase64);
    if (bytes.byteLength !== chunk.byteLength || await privateProHash(bytes) !== chunk.hash)
      throw new Error(`Sync chunk ${chunk.id} failed validation.`);
    decoded.push(bytes);
    totalBytes += bytes.byteLength;
  }

  const payload = new Uint8Array(totalBytes);
  let offset = 0;
  for (const bytes of decoded) {
    payload.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return decoder.decode(payload);
}
