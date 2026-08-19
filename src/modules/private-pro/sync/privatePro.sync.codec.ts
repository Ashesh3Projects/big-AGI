import type * as z from 'zod/v4';

import { PRIVATE_PRO_SYNC_MAX_PAYLOAD_BYTES } from '../config/privatePro.config';
import type { PrivateProSyncRecordType } from './privatePro.sync.schemas';


const textEncoder = new TextEncoder();

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
  const bytes = textEncoder.encode(`${recordType}\0${logicalId}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
