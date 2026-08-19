import type { PrivateProVaultEnvelope } from './privatePro.vault.types';


export interface PrivateProVaultRestoreChunkRecord {
  opaqueRecordId: string;
  baseRevision: number;
  envelope: PrivateProVaultEnvelope;
}

export function canonicalPrivateProVaultJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPrivateProVaultJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalPrivateProVaultJson(nested)}`)
    .join(',')}}`;
}

export function canonicalPrivateProVaultRestoreChunk(records: readonly PrivateProVaultRestoreChunkRecord[]): string {
  return canonicalPrivateProVaultJson({
    kind: 'private-pro-vault-restore-chunk/v1',
    records,
  });
}

export function privateProVaultBytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function digestPrivateProVaultRestoreChunk(
  records: readonly PrivateProVaultRestoreChunkRecord[],
): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalPrivateProVaultRestoreChunk(records)));
  return privateProVaultBytesToBase64Url(new Uint8Array(digest));
}
