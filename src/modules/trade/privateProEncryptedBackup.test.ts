import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { deriveVaultSubkey, decryptVaultRecord, encryptVaultRecord, importVaultMasterKey } from '../private-pro/vault/privatePro.vault.crypto';
import { generateRecoveryKey } from '../private-pro/vault/privatePro.vault.recovery';
import { rewrapPrivateProVaultPassword } from '../private-pro/vault/privatePro.vault.keyset';
import {
  PRIVATE_PRO_PBKDF2_MIN_ITERATIONS,
} from '../private-pro/vault/privatePro.vault.schemas';
import type { PrivateProVaultEnvelope, PrivateProVaultKeyset } from '../private-pro/vault/privatePro.vault.types';
import { realArgon2idWorkerResponse, withVaultPasswordWorker } from '../../../tools/private-pro/test-helpers/privatePro.vault.password.test-helpers';
import { FlashBackup } from './BackupRestore';
import {
  createPrivateProEncryptedBackupStream,
  importPrivateProEncryptedBackup,
  PRIVATE_PRO_ENCRYPTED_BACKUP_DEFAULT_MAX_LINE_BYTES,
  PRIVATE_PRO_ENCRYPTED_BACKUP_DEFAULT_MAX_TOTAL_CIPHERTEXT_BYTES,
  PRIVATE_PRO_ENCRYPTED_BACKUP_MAX_ASSET_CIPHERTEXT_BYTES,
  type PrivateProEncryptedBackupApplyInput,
  type PrivateProEncryptedBackupAsset,
  type PrivateProEncryptedBackupSource,
} from './privateProEncryptedBackup';


const SENTINEL_API_KEY = 'sk-private-pro-sentinel-api-key';
const VAULT_ID = 'uid-derived-vault-test';
const PASSWORD = 'correct horse battery staple';
const WRONG_PASSWORD = 'wrong horse battery staple';
const SALT_BYTES = Uint8Array.from({ length: 16 }, (_, index) => index);


function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

function zeroBytesBase64(byteLength: number): string {
  const completeGroups = Math.floor(byteLength / 3);
  const remainder = byteLength % 3;
  return `${'AAAA'.repeat(completeGroups)}${remainder === 1 ? 'AA==' : remainder === 2 ? 'AAA=' : ''}`;
}

async function passwordWrappingKey(password: string): Promise<CryptoKey> {
  const passwordBytes = new TextEncoder().encode(password);
  const passwordKey = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: SALT_BYTES,
    iterations: PRIVATE_PRO_PBKDF2_MIN_ITERATIONS,
  }, passwordKey, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}

async function wrapMasterKey(masterKeyBytes: Uint8Array, wrappingKey: CryptoKey, nonceByte: number): Promise<{
  nonceBase64: string;
  ciphertextBase64: string;
  ciphertextBytes: number;
}> {
  const nonce = new Uint8Array(12).fill(nonceByte);
  const exportableMasterKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(masterKeyBytes),
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt'],
  );
  const ciphertext = new Uint8Array(await crypto.subtle.wrapKey(
    'raw',
    exportableMasterKey,
    wrappingKey,
    { name: 'AES-GCM', iv: nonce },
  ));
  return {
    nonceBase64: bytesToBase64(nonce),
    ciphertextBase64: bytesToBase64(ciphertext),
    ciphertextBytes: ciphertext.byteLength,
  };
}

async function fixture(): Promise<{
  source: PrivateProEncryptedBackupSource;
  record: PrivateProVaultEnvelope;
  recoveryKey: string;
  masterKey: CryptoKey;
}> {
  const masterKeyBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 32);
  const masterKey = await importVaultMasterKey(masterKeyBytes);
  const recordId = 'opaque-credential-record';
  const recordKey = await deriveVaultSubkey(masterKey, 'record-encryption', `credential-service/${recordId}`, ['encrypt', 'decrypt']);
  const record = await encryptVaultRecord(recordKey, {
    vaultId: VAULT_ID,
    formatVersion: 1,
    recordType: 'credential-service',
    recordId,
    schemaVersion: 1,
    keyVersion: 1,
    revision: 1,
  }, new TextEncoder().encode(JSON.stringify({ serviceId: 'openai', apiKey: SENTINEL_API_KEY })));

  const passwordEnvelope = await wrapMasterKey(masterKeyBytes, await passwordWrappingKey(PASSWORD), 1);
  const recovery = generateRecoveryKey();
  const recoveryWrappingKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(recovery.bytes),
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
  const recoveryEnvelope = await wrapMasterKey(masterKeyBytes, recoveryWrappingKey, 2);
  recovery.bytes.fill(0);

  const keyset: PrivateProVaultKeyset = {
    formatVersion: 1,
    keyVersion: 1,
    wrappingVersion: 1,
    passwordEnvelope: {
      formatVersion: 1,
      keyVersion: 1,
      kdf: {
        algorithm: 'pbkdf2-sha256',
        saltBase64: bytesToBase64(SALT_BYTES),
        iterations: PRIVATE_PRO_PBKDF2_MIN_ITERATIONS,
      },
      ...passwordEnvelope,
    },
    recoveryEnvelope: {
      formatVersion: 1,
      keyVersion: 1,
      recoveryVersion: 1,
      ...recoveryEnvelope,
    },
  };

  const asset: PrivateProEncryptedBackupAsset = {
    kind: 'asset',
    formatVersion: 1,
    assetId: 'opaque-asset',
    chunkId: 'chunk-0',
    chunkIndex: 0,
    keyVersion: 1,
    nonceBase64: bytesToBase64(new Uint8Array(12).fill(3)),
    ciphertextBase64: bytesToBase64(new Uint8Array(20).fill(4)),
    ciphertextBytes: 20,
  };

  return {
    source: {
      vaultId: VAULT_ID,
      keyset,
      masterKey,
      createdAtMs: 1_765_000_000_000,
      records: async function* () { yield record; },
      assets: async function* () { yield asset; },
    },
    record,
    recoveryKey: recovery.display,
    masterKey,
  };
}

async function encryptedRecord(masterKey: CryptoKey, recordId: string, apiKey: string): Promise<PrivateProVaultEnvelope> {
  const recordKey = await deriveVaultSubkey(masterKey, 'record-encryption', `credential-service/${recordId}`, ['encrypt', 'decrypt']);
  return encryptVaultRecord(recordKey, {
    vaultId: VAULT_ID,
    formatVersion: 1,
    recordType: 'credential-service',
    recordId,
    schemaVersion: 1,
    keyVersion: 1,
    revision: 1,
  }, new TextEncoder().encode(JSON.stringify({ serviceId: recordId, apiKey })));
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<{ bytes: Uint8Array; chunks: number }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
  }
  const byteLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, chunks: chunks.length };
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const midpoint = Math.floor(bytes.byteLength / 2);
      controller.enqueue(bytes.slice(0, midpoint));
      controller.enqueue(bytes.slice(midpoint));
      controller.close();
    },
  });
}

async function decryptFixtureRecord(input: PrivateProEncryptedBackupApplyInput): Promise<string> {
  const record = input.records[0];
  const key = await deriveVaultSubkey(
    input.masterKey,
    'record-encryption',
    `${record.recordType}/${record.recordId}`,
    ['encrypt', 'decrypt'],
  );
  const plaintext = await decryptVaultRecord(key, record, { vaultId: input.header.vaultId });
  return new TextDecoder().decode(plaintext);
}


describe('private Pro encrypted backup', () => {
  test('streams ciphertext-only lines and never exports a plaintext API key', async () => {
    const { source } = await fixture();
    const output = await collectStream(createPrivateProEncryptedBackupStream(source));
    const text = new TextDecoder().decode(output.bytes);

    assert.equal(text.includes(SENTINEL_API_KEY), false);
    assert.equal(output.chunks >= 4, true);
    assert.match(text, /vnd\.agi\.private-pro-encrypted-backup/);
  });

  test('unlocks, validates, and applies with the correct password', async () => {
    const { source } = await fixture();
    const output = await collectStream(createPrivateProEncryptedBackupStream(source));
    let decrypted = '';

    const result = await importPrivateProEncryptedBackup(
      streamFromBytes(output.bytes),
      { kind: 'password', password: PASSWORD },
      async ({ plaintext }) => JSON.parse(new TextDecoder().decode(plaintext)),
      async input => { decrypted = await decryptFixtureRecord(input); },
    );

    assert.equal(JSON.parse(decrypted).apiKey, SENTINEL_API_KEY);
    assert.deepEqual(result, { recordCount: 1, assetCount: 1, reloadRequired: true });
  });

  test('exports and imports keyVersion-1 records after password wrappingVersion advances', async () => {
    const { source } = await fixture();
    source.keyset = await withVaultPasswordWorker(
      realArgon2idWorkerResponse,
      () => rewrapPrivateProVaultPassword(source.keyset, PASSWORD, 'new correct horse battery staple'),
    );
    assert.equal(source.keyset.keyVersion, 1);
    assert.equal(source.keyset.wrappingVersion, 2);
    const output = await collectStream(createPrivateProEncryptedBackupStream(source));
    let appliedKeyVersion = 0;

    await withVaultPasswordWorker(realArgon2idWorkerResponse, () => importPrivateProEncryptedBackup(
      streamFromBytes(output.bytes),
      { kind: 'password', password: 'new correct horse battery staple' },
      ({ envelope }) => { appliedKeyVersion = envelope.keyVersion; },
      async () => {},
    ));

    assert.equal(appliedKeyVersion, 1);
  });

  test('unlocks, validates, and applies with the correct recovery key', async () => {
    const { source, recoveryKey } = await fixture();
    const output = await collectStream(createPrivateProEncryptedBackupStream(source));
    let decrypted = '';

    await importPrivateProEncryptedBackup(
      streamFromBytes(output.bytes),
      { kind: 'recovery', recoveryKey },
      async ({ plaintext }) => JSON.parse(new TextDecoder().decode(plaintext)),
      async input => { decrypted = await decryptFixtureRecord(input); },
    );

    assert.equal(JSON.parse(decrypted).apiKey, SENTINEL_API_KEY);
  });

  test('wrong password and recovery credentials fail without applying ciphertext', async () => {
    const { source, recoveryKey } = await fixture();
    const output = await collectStream(createPrivateProEncryptedBackupStream(source));
    let applyCalls = 0;
    const apply = async () => { applyCalls++; };
    const validate = async () => undefined;

    await assert.rejects(
      importPrivateProEncryptedBackup(streamFromBytes(output.bytes), { kind: 'password', password: WRONG_PASSWORD }, validate, apply),
      /credentials are invalid/i,
    );
    const wrongRecoveryKey = `${recoveryKey.slice(0, -1)}${recoveryKey.endsWith('A') ? 'B' : 'A'}`;
    await assert.rejects(
      importPrivateProEncryptedBackup(streamFromBytes(output.bytes), { kind: 'recovery', recoveryKey: wrongRecoveryKey }, validate, apply),
      /credentials are invalid/i,
    );
    assert.equal(applyCalls, 0);
  });

  test('validates the complete stream and every decrypted record before one apply', async () => {
    const { source } = await fixture();
    const output = await collectStream(createPrivateProEncryptedBackupStream(source));
    const text = new TextDecoder().decode(output.bytes);
    const malformed = new TextEncoder().encode(text.replace('"assetCount":1', '"assetCount":2'));
    let applyCalls = 0;

    await assert.rejects(
      importPrivateProEncryptedBackup(
        streamFromBytes(malformed),
        { kind: 'password', password: PASSWORD },
        async ({ plaintext }) => JSON.parse(new TextDecoder().decode(plaintext)),
        async () => { applyCalls++; },
      ),
      /count/i,
    );
    assert.equal(applyCalls, 0);

    await assert.rejects(
      importPrivateProEncryptedBackup(
        streamFromBytes(output.bytes),
        { kind: 'password', password: PASSWORD },
        async () => { throw new Error('portable record invalid'); },
        async () => { applyCalls++; },
      ),
      /portable record invalid/i,
    );
    assert.equal(applyCalls, 0);
  });

  test('rejects a truncated stream without applying', async () => {
    const { source } = await fixture();
    const output = await collectStream(createPrivateProEncryptedBackupStream(source));
    const lines = new TextDecoder().decode(output.bytes).trimEnd().split('\n');
    const truncated = new TextEncoder().encode(`${lines.slice(0, -1).join('\n')}\n`);
    let applyCalls = 0;

    await assert.rejects(
      importPrivateProEncryptedBackup(
        streamFromBytes(truncated),
        { kind: 'password', password: PASSWORD },
        async () => undefined,
        async () => { applyCalls++; },
      ),
      /end/i,
    );
    assert.equal(applyCalls, 0);
  });

  test('rejects duplicate ciphertext identities and mismatched asset key versions before apply', async () => {
    const { source } = await fixture();
    const output = await collectStream(createPrivateProEncryptedBackupStream(source));
    const lines = new TextDecoder().decode(output.bytes).trimEnd().split('\n');
    const duplicateRecord = new TextEncoder().encode(`${[lines[0], lines[1], lines[1], lines[2], '{"kind":"end","recordCount":2,"assetCount":1}'].join('\n')}\n`);
    const wrongAssetVersion = new TextEncoder().encode(`${lines.map(line => line.includes('"kind":"asset"') ? line.replace('"keyVersion":1', '"keyVersion":2') : line).join('\n')}\n`);
    let applyCalls = 0;

    for (const bytes of [duplicateRecord, wrongAssetVersion]) {
      await assert.rejects(
        importPrivateProEncryptedBackup(
          streamFromBytes(bytes),
          { kind: 'password', password: PASSWORD },
          async () => undefined,
          async () => { applyCalls++; },
        ),
        /duplicate record|transcript authentication|asset key version/i,
      );
    }
    assert.equal(applyCalls, 0);
  });

  test('authenticates deletion even when an attacker rewrites end counts and byte totals', async () => {
    const { source } = await fixture();
    const output = await collectStream(createPrivateProEncryptedBackupStream(source));
    const lines = new TextDecoder().decode(output.bytes).trimEnd().split('\n');
    const asset = JSON.parse(lines[2]) as { ciphertextBytes: number };
    const end = JSON.parse(lines[3]) as Record<string, unknown>;
    end.recordCount = 0;
    end.totalCiphertextBytes = asset.ciphertextBytes;
    const tampered = new TextEncoder().encode(`${[lines[0], lines[2], JSON.stringify(end)].join('\n')}\n`);
    let applyCalls = 0;

    await assert.rejects(
      importPrivateProEncryptedBackup(
        streamFromBytes(tampered),
        { kind: 'password', password: PASSWORD },
        async () => undefined,
        async () => { applyCalls++; },
      ),
      /transcript authentication/i,
    );
    assert.equal(applyCalls, 0);
  });

  test('authenticates the order of otherwise valid record lines', async () => {
    const { source, masterKey } = await fixture();
    const second = await encryptedRecord(masterKey, 'opaque-credential-record-2', 'second-secret');
    const twoRecordSource: PrivateProEncryptedBackupSource = {
      ...source,
      records: async function* () {
        for await (const record of source.records()) yield record;
        yield second;
      },
    };
    const output = await collectStream(createPrivateProEncryptedBackupStream(twoRecordSource));
    const lines = new TextDecoder().decode(output.bytes).trimEnd().split('\n');
    const reordered = new TextEncoder().encode(`${[lines[0], lines[2], lines[1], ...lines.slice(3)].join('\n')}\n`);
    let applyCalls = 0;

    await assert.rejects(
      importPrivateProEncryptedBackup(
        streamFromBytes(reordered),
        { kind: 'password', password: PASSWORD },
        async () => undefined,
        async () => { applyCalls++; },
      ),
      /transcript authentication/i,
    );
    assert.equal(applyCalls, 0);
  });

  test('enforces record, asset, ciphertext-byte, and line limits before apply', async () => {
    const { source } = await fixture();
    const output = await collectStream(createPrivateProEncryptedBackupStream(source));
    const limits = [
      { maxRecords: 0 },
      { maxAssetChunks: 0 },
      { maxTotalCiphertextBytes: 1 },
      { maxLineBytes: 32 },
    ];
    let applyCalls = 0;

    for (const limit of limits) {
      await assert.rejects(
        importPrivateProEncryptedBackup(
          streamFromBytes(output.bytes),
          { kind: 'password', password: PASSWORD },
          async () => undefined,
          async () => { applyCalls++; },
          limit,
        ),
        /limit|too many|oversized/i,
      );
    }
    assert.equal(applyCalls, 0);
  });

  test('uses a 128 MiB aggregate, 4 MiB asset chunks, and a line cap that fits a maximum asset chunk', () => {
    assert.equal(PRIVATE_PRO_ENCRYPTED_BACKUP_DEFAULT_MAX_TOTAL_CIPHERTEXT_BYTES, 128 * 1024 * 1024);
    assert.equal(PRIVATE_PRO_ENCRYPTED_BACKUP_MAX_ASSET_CIPHERTEXT_BYTES, 4 * 1024 * 1024);
    assert.equal(PRIVATE_PRO_ENCRYPTED_BACKUP_DEFAULT_MAX_LINE_BYTES, 6 * 1024 * 1024);

    const encodedAssetCiphertextBytes = Math.ceil(PRIVATE_PRO_ENCRYPTED_BACKUP_MAX_ASSET_CIPHERTEXT_BYTES / 3) * 4;
    const assetMetadataBytes = new TextEncoder().encode(`${JSON.stringify({
      kind: 'asset',
      formatVersion: 1,
      assetId: '\0'.repeat(512),
      chunkId: '\0'.repeat(512),
      chunkIndex: Number.MAX_SAFE_INTEGER,
      keyVersion: Number.MAX_SAFE_INTEGER,
      nonceBase64: 'A'.repeat(16),
      ciphertextBase64: '',
      ciphertextBytes: PRIVATE_PRO_ENCRYPTED_BACKUP_MAX_ASSET_CIPHERTEXT_BYTES,
    })}\n`).byteLength;
    assert.equal(
      PRIVATE_PRO_ENCRYPTED_BACKUP_DEFAULT_MAX_LINE_BYTES >= encodedAssetCiphertextBytes + assetMetadataBytes,
      true,
    );

  });

  test('rejects asset chunk metadata above the 4 MiB ciphertext format limit', async () => {
    const { source } = await fixture();
    const oversizedBytes = 4 * 1024 * 1024 + 1;
    const oversizedAsset: PrivateProEncryptedBackupAsset = {
      kind: 'asset',
      formatVersion: 1,
      assetId: 'opaque-asset',
      chunkId: 'chunk-too-large',
      chunkIndex: 0,
      keyVersion: 1,
      nonceBase64: bytesToBase64(new Uint8Array(12)),
      ciphertextBase64: zeroBytesBase64(oversizedBytes),
      ciphertextBytes: oversizedBytes,
    };
    const oversizedSource: PrivateProEncryptedBackupSource = {
      ...source,
      assets: async function* () { yield oversizedAsset; },
    };

    await assert.rejects(
      collectStream(createPrivateProEncryptedBackupStream(oversizedSource)),
      /less than or equal|ciphertextBytes|too big|maximum/i,
    );
  });

  test('imports multiple ordered chunks for one asset identity', async () => {
    const { source } = await fixture();
    const chunks: PrivateProEncryptedBackupAsset[] = [0, 1].map(index => ({
      kind: 'asset',
      formatVersion: 1,
      assetId: 'opaque-multi-chunk-asset',
      chunkId: `chunk-${index}`,
      chunkIndex: index,
      keyVersion: 1,
      nonceBase64: bytesToBase64(new Uint8Array(12).fill(index + 1)),
      ciphertextBase64: bytesToBase64(new Uint8Array(20).fill(index + 2)),
      ciphertextBytes: 20,
    }));
    const multiChunkSource: PrivateProEncryptedBackupSource = {
      ...source,
      assets: async function* () { yield* chunks; },
    };
    const output = await collectStream(createPrivateProEncryptedBackupStream(multiChunkSource));
    let imported: readonly PrivateProEncryptedBackupAsset[] = [];

    await importPrivateProEncryptedBackup(
      streamFromBytes(output.bytes),
      { kind: 'password', password: PASSWORD },
      async () => undefined,
      async input => { imported = input.assets; },
    );

    assert.deepEqual(imported.map(chunk => [chunk.assetId, chunk.chunkId, chunk.chunkIndex]), [
      ['opaque-multi-chunk-asset', 'chunk-0', 0],
      ['opaque-multi-chunk-asset', 'chunk-1', 1],
    ]);
  });

  test('counts the exact raw UTF-8 line bytes at the configured boundary', async () => {
    const { source } = await fixture();
    const output = await collectStream(createPrivateProEncryptedBackupStream(source));
    const lines = new TextDecoder().decode(output.bytes).trimEnd().split('\n');
    const maximumLineBytes = Math.max(...lines.map(line => new TextEncoder().encode(`${line}\n`).byteLength));

    await collectStream(createPrivateProEncryptedBackupStream(source, { maxLineBytes: maximumLineBytes }));
    await assert.rejects(
      collectStream(createPrivateProEncryptedBackupStream(source, { maxLineBytes: maximumLineBytes - 1 })),
      /oversized line/i,
    );

    await importPrivateProEncryptedBackup(
      streamFromBytes(output.bytes),
      { kind: 'password', password: PASSWORD },
      async () => undefined,
      async () => undefined,
      { maxLineBytes: maximumLineBytes },
    );
    await assert.rejects(
      importPrivateProEncryptedBackup(
        streamFromBytes(output.bytes),
        { kind: 'password', password: PASSWORD },
        async () => undefined,
        async () => undefined,
        { maxLineBytes: maximumLineBytes - 1 },
      ),
      /oversized line/i,
    );
  });

  test('requires header, records, assets, end, and immediate EOF with no blank lines', async () => {
    const { source } = await fixture();
    const output = await collectStream(createPrivateProEncryptedBackupStream(source));
    const lines = new TextDecoder().decode(output.bytes).trimEnd().split('\n');
    const variants = [
      `${lines[0]}\n\n${lines.slice(1).join('\n')}\n`,
      `${lines.join('\n')}\n \n`,
      `${lines.join('\n')}\n${lines.at(-1)}\n`,
      `${lines.join('\n')}\n{"kind":"record"}\n`,
      `${[lines[0], lines[2], lines[1], lines[3]].join('\n')}\n`,
      lines.join('\n'),
    ];
    let applyCalls = 0;

    for (const variant of variants) {
      await assert.rejects(
        importPrivateProEncryptedBackup(
          streamFromBytes(new TextEncoder().encode(variant)),
          { kind: 'password', password: PASSWORD },
          async () => undefined,
          async () => { applyCalls++; },
        ),
        /blank|after.*end|record.*asset|newline|order/i,
      );
    }
    assert.equal(applyCalls, 0);
  });

  test('legacy Export All warns that plaintext backups contain API keys', () => {
    const markup = renderToStaticMarkup(React.createElement(FlashBackup, {}));

    assert.match(markup, /unencrypted/i);
    assert.match(markup, /API keys/i);
  });
});
