import type * as z from 'zod/v4';

import { PRIVATE_PRO_SYNC_MAX_PAYLOAD_BYTES } from '../config/privatePro.config';
import type { PrivateProSyncRecordType } from './privatePro.sync.schemas';


const textEncoder = new TextEncoder();

function sha256(input: Uint8Array): Uint8Array {
  const words = new Uint32Array(64);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const constants = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  new DataView(padded.buffer).setUint32(paddedLength - 4, bitLength, false);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = new DataView(padded.buffer, offset).getUint32(index * 4, false);
    for (let index = 16; index < 64; index++) {
      const a = words[index - 15];
      const b = words[index - 2];
      words[index] = (((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)) + words[index - 16] + (((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)) + words[index - 7];
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index++) {
      const sigma1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choice = (e & f) ^ (~e & g);
      const temp1 = h + sigma1 + choice + constants[index] + words[index];
      const sigma0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + temp1) >>> 0, c, b, a, (temp1 + sigma0 + majority) >>> 0];
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  const digest = new Uint8Array(32);
  const output = new DataView(digest.buffer);
  hash.forEach((word, index) => output.setUint32(index * 4, word, false));
  return digest;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON does not support non-finite numbers.');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, canonicalize(object[key])]));
  }
  throw new TypeError('Canonical JSON supports JSON values only.');
}

function asciiJson(value: string): string {
  return value.replace(/[\u0080-\u{10ffff}]/gu, character => {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0xffff) return `\\u${codePoint.toString(16).padStart(4, '0')}`;
    const surrogate = codePoint - 0x10000;
    return `\\u${(0xd800 + (surrogate >> 10)).toString(16)}\\u${(0xdc00 + (surrogate & 0x3ff)).toString(16)}`;
  });
}

export function privateProRecordKey(recordType: PrivateProSyncRecordType, logicalId: string): string {
  const prefix = textEncoder.encode(`${recordType}\0`);
  const key = new Uint8Array(prefix.length + 32);
  key.set(prefix);
  key.set(sha256(textEncoder.encode(logicalId)), prefix.length);
  return base64Url(key);
}

export function privateProCanonicalJson(value: unknown): string {
  const json = JSON.stringify(canonicalize(value));
  if (json === undefined) throw new TypeError('Canonical JSON requires a JSON value.');
  return asciiJson(json);
}

export function privateProParseCanonicalJson<T>(payload: string, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(payload));
}

export function assertPrivateProPayloadSize(payload: string): void {
  if (textEncoder.encode(payload).byteLength > PRIVATE_PRO_SYNC_MAX_PAYLOAD_BYTES)
    throw new RangeError('Private Pro sync payload is too large.');
}

export async function privateProContentHash(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(payload));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
