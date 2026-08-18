import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { importVaultMasterKey } from './privatePro.vault.crypto';
import {
  PRIVATE_PRO_VAULT_ASSET_MAX_CIPHERTEXT_CHUNK_BYTES,
  decryptPrivateProVaultAsset,
  encryptPrivateProVaultAsset,
  privateProVaultAssetId,
  type PrivateProVaultAssetManifest,
} from './privatePro.vault.assets.crypto';


const VAULT_ID = 'uid-private-vault';
const MANIFEST: PrivateProVaultAssetManifest = {
  formatVersion: 1,
  schemaVersion: 1,
  assetId: 'dblob-sensitive-name',
  contextId: 'global',
  scopeId: 'app-chat',
  assetType: 'image',
  label: 'private-photo.png',
  contentType: 'image/png',
  origin: { ot: 'user', source: 'attachment', media: 'file-open', fileName: 'private-photo.png' },
  metadata: { width: 640, height: 480, description: 'private label' },
  createdAt: '2026-08-17T00:00:00.000Z',
  updatedAt: '2026-08-17T00:00:00.000Z',
};

async function fixture(byteLength = PRIVATE_PRO_VAULT_ASSET_MAX_CIPHERTEXT_CHUNK_BYTES + 257) {
  const masterKey = await importVaultMasterKey(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
  const plaintext = Uint8Array.from({ length: byteLength }, (_, index) => index % 251);
  const opaqueAssetId = await privateProVaultAssetId(masterKey, MANIFEST.assetId);
  const chunks = await encryptPrivateProVaultAsset({
    masterKey,
    vaultId: VAULT_ID,
    opaqueAssetId,
    keyVersion: 3,
    manifest: MANIFEST,
    plaintext,
  });
  return { masterKey, plaintext, chunks };
}

function cloneChunks<T>(value: T): T {
  return structuredClone(value);
}

describe('private Pro vault asset chunk cryptography', () => {
  test('frames the encrypted manifest with payload bytes in chunk zero', async () => {
    const { masterKey, plaintext, chunks } = await fixture(1024);

    assert.equal(chunks.length, 1, 'a small manifest and payload must share chunk zero');
    assert.equal(chunks[0].plaintextBytes > plaintext.byteLength, true, 'chunk zero includes bounded manifest framing');
    const decrypted = await decryptPrivateProVaultAsset({ masterKey, vaultId: VAULT_ID, chunks });

    assert.deepEqual(decrypted.manifest, MANIFEST);
    assert.deepEqual(decrypted.plaintext, plaintext);
  });

  test('round trips an empty payload as one framed manifest chunk', async () => {
    const { masterKey, plaintext, chunks } = await fixture(0);

    assert.equal(chunks.length, 1);
    const decrypted = await decryptPrivateProVaultAsset({ masterKey, vaultId: VAULT_ID, chunks });
    assert.deepEqual(decrypted.manifest, MANIFEST);
    assert.equal(plaintext.byteLength, 0);
    assert.equal(decrypted.plaintext.byteLength, 0);
  });

  test('round trips a multi-chunk attachment within the 4 MiB ciphertext bound', async () => {
    const { masterKey, plaintext, chunks } = await fixture();

    assert.equal(chunks.length >= 2, true, 'framed first chunk plus continuation chunks');
    assert.equal(chunks.every(chunk => chunk.ciphertextBytes <= PRIVATE_PRO_VAULT_ASSET_MAX_CIPHERTEXT_CHUNK_BYTES), true);
    const decrypted = await decryptPrivateProVaultAsset({ masterKey, vaultId: VAULT_ID, chunks });

    assert.deepEqual(decrypted.manifest, MANIFEST);
    assert.deepEqual(decrypted.plaintext, plaintext);
  });

  test('rejects reordered and missing chunks', async () => {
    const { masterKey, chunks } = await fixture();

    await assert.rejects(
      decryptPrivateProVaultAsset({ masterKey, vaultId: VAULT_ID, chunks: [chunks[1], chunks[0], ...chunks.slice(2)] }),
      /order|index/i,
    );
    await assert.rejects(
      decryptPrivateProVaultAsset({ masterKey, vaultId: VAULT_ID, chunks: chunks.slice(0, -1) }),
      /missing|count/i,
    );
  });

  test('rejects corrupt ciphertext and authenticated metadata changes', async () => {
    const { masterKey, chunks } = await fixture(1024);
    const corrupt = cloneChunks(chunks);
    const ciphertext = Uint8Array.from(atob(corrupt[0].ciphertextBase64), character => character.charCodeAt(0));
    ciphertext[0] ^= 0x80;
    corrupt[0].ciphertextBase64 = btoa(String.fromCharCode(...ciphertext));

    await assert.rejects(decryptPrivateProVaultAsset({ masterKey, vaultId: VAULT_ID, chunks: corrupt }));

    for (const mutate of [
      (copy: typeof chunks) => { copy[0].opaqueAssetId = 'B'.repeat(43); },
      (copy: typeof chunks) => { copy[0].chunkCount++; },
      (copy: typeof chunks) => { copy[0].totalPlaintextBytes++; },
      (copy: typeof chunks) => { copy[0].plaintextBytes++; },
      (copy: typeof chunks) => { copy[0].opaqueChunkId = 'C'.repeat(43); },
      (copy: typeof chunks) => { copy[0].keyVersion++; },
      (copy: typeof chunks) => { copy[0].schemaVersion++; },
    ]) {
      const changed = cloneChunks(chunks);
      mutate(changed);
      await assert.rejects(decryptPrivateProVaultAsset({ masterKey, vaultId: VAULT_ID, chunks: changed }));
    }
  });

  test('uses a unique 96-bit nonce for every encrypted chunk', async () => {
    const { masterKey, chunks } = await fixture();
    const nonces = chunks.map(chunk => chunk.nonceBase64);

    assert.equal(new Set(nonces).size, nonces.length);
    assert.equal(nonces.every(nonce => atob(nonce).length === 12), true);

    const duplicate = cloneChunks(chunks);
    duplicate[1].nonceBase64 = duplicate[0].nonceBase64;
    await assert.rejects(decryptPrivateProVaultAsset({ masterKey, vaultId: VAULT_ID, chunks: duplicate }), /nonce/i);
  });

  test('keeps filename, content type, label, and origin inside the encrypted manifest', async () => {
    const { chunks } = await fixture(64);
    const visible = JSON.stringify(chunks);

    assert.equal(visible.includes(MANIFEST.assetId), false);
    assert.equal(visible.includes(MANIFEST.label), false);
    assert.equal(visible.includes(MANIFEST.contentType), false);
    assert.equal(visible.includes('private-photo.png'), false);
    assert.equal(visible.includes('file-open'), false);
    assert.equal(visible.includes('private label'), false);
  });

  test('rejects mismatched asset MIME and excessively nested metadata', async () => {
    const masterKey = await importVaultMasterKey(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
    const opaqueAssetId = await privateProVaultAssetId(masterKey, MANIFEST.assetId);
    await assert.rejects(encryptPrivateProVaultAsset({
      masterKey,
      vaultId: VAULT_ID,
      opaqueAssetId,
      keyVersion: 1,
      manifest: { ...MANIFEST, assetType: 'audio' } as unknown as PrivateProVaultAssetManifest,
      plaintext: new Uint8Array(1),
    }), /mime|type|invalid/i);

    let nested: unknown = 'secret';
    for (let index = 0; index < 34; index++) nested = { nested };
    await assert.rejects(encryptPrivateProVaultAsset({
      masterKey,
      vaultId: VAULT_ID,
      opaqueAssetId,
      keyVersion: 1,
      manifest: { ...MANIFEST, metadata: nested } as unknown as PrivateProVaultAssetManifest,
      plaintext: new Uint8Array(1),
    }), /nested/i);
  });
});
