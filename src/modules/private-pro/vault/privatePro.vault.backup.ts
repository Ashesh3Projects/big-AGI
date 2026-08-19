import { decryptVaultRecord, deriveVaultSubkey, encryptVaultRecord } from './privatePro.vault.crypto';
import type { PrivateProVaultAssetClient } from './privatePro.vault.assets.client';
import type { PrivateProVaultDB } from './privatePro.vault.db';
import type { PrivateProVaultSerializer } from './privatePro.vault.serializers';
import type { PrivateProVaultEnvelope, PrivateProVaultKeyset } from './privatePro.vault.types';
import { PrivateProVaultAmbiguousTransportError, type PrivateProVaultTransport } from './privatePro.vault.transport';
import { collectPrivateProVaultAssetIds } from './privatePro.vault.assets.client';
import { PRIVATE_PRO_VAULT_FIRESTORE_MAX_CIPHERTEXT_BYTES } from './privatePro.vault.repository';
import { digestPrivateProVaultRestoreChunk } from './privatePro.vault.restore';
import {
  createPrivateProEncryptedBackupStream,
  importPrivateProEncryptedBackup,
  type PrivateProEncryptedBackupCredential,
  type PrivateProEncryptedBackupSource,
} from '~/modules/trade/privateProEncryptedBackup';


const textDecoder = new TextDecoder('utf-8', { fatal: true });
const textEncoder = new TextEncoder();
const RESTORE_CHUNK_MAX_RECORDS = 200;
const RESTORE_CHUNK_MAX_CIPHERTEXT_BYTES = 4 * 1024 * 1024;

export class PrivateProVaultBackupCommittedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PrivateProVaultBackupCommittedError';
  }
}

export interface PrivateProVaultBackupDependencies {
  uid: string;
  masterKey: CryptoKey;
  keyset: PrivateProVaultKeyset;
  db: PrivateProVaultDB;
  serializers: readonly PrivateProVaultSerializer<unknown>[];
  assets: PrivateProVaultAssetClient;
  collectAssetIds(recordType: string, value: unknown): string[];
}

interface FrozenRecord {
  envelope: PrivateProVaultEnvelope;
  value: unknown;
}

function serializerMap(serializers: readonly PrivateProVaultSerializer<unknown>[]) {
  return new Map(serializers.map(serializer => [serializer.recordType, serializer]));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(',')}}`;
}

function restoreChunks<T>(records: readonly T[], ciphertextBytes: (record: T) => number): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const record of records) {
    const recordBytes = ciphertextBytes(record);
    if (current.length && (current.length >= RESTORE_CHUNK_MAX_RECORDS
      || currentBytes + recordBytes > RESTORE_CHUNK_MAX_CIPHERTEXT_BYTES)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    if (recordBytes > RESTORE_CHUNK_MAX_CIPHERTEXT_BYTES)
      throw new Error('Encrypted backup record exceeds the cloud restore chunk limit.');
    current.push(record);
    currentBytes += recordBytes;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function retryAmbiguous<T>(transport: PrivateProVaultTransport, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof PrivateProVaultAmbiguousTransportError) || !transport.isOnline()) throw error;
    return operation();
  }
}

async function decryptAndValidate(
  deps: Pick<PrivateProVaultBackupDependencies, 'uid' | 'masterKey' | 'serializers'>,
  envelope: PrivateProVaultEnvelope,
) {
  const serializer = serializerMap(deps.serializers).get(envelope.recordType);
  if (!serializer || serializer.schemaVersion !== envelope.schemaVersion)
    throw new Error('Encrypted backup record schema is unsupported.');
  const key = await deriveVaultSubkey(
    deps.masterKey,
    'record-encryption',
    `${envelope.recordType}:${envelope.recordId}`,
    ['decrypt'],
  );
  const plaintext = await decryptVaultRecord(key, envelope, { vaultId: deps.uid });
  try {
    const value = JSON.parse(textDecoder.decode(plaintext)) as unknown;
    return await serializer.validate(envelope.recordId, value);
  } finally {
    plaintext.fill(0);
  }
}

async function decryptAndNormalize(
  uid: string,
  masterKey: CryptoKey,
  serializer: PrivateProVaultSerializer<unknown>,
  envelope: PrivateProVaultEnvelope,
) {
  const key = await deriveVaultSubkey(masterKey, 'record-encryption', `${envelope.recordType}:${envelope.recordId}`, ['decrypt']);
  const plaintext = await decryptVaultRecord(key, envelope, { vaultId: uid });
  try {
    return serializer.normalize(JSON.parse(textDecoder.decode(plaintext)) as unknown);
  } finally {
    plaintext.fill(0);
  }
}

async function freezeRecords(deps: PrivateProVaultBackupDependencies): Promise<FrozenRecord[]> {
  const envelopes = await deps.db.listEncryptedRecords(deps.uid);
  return Promise.all(envelopes.map(async envelope => ({
    envelope,
    value: await decryptAndValidate(deps, envelope),
  })));
}

export async function createPrivateProVaultBackupSource(
  deps: PrivateProVaultBackupDependencies,
): Promise<PrivateProEncryptedBackupSource> {
  const frozen = await freezeRecords(deps);
  const assetIds = [...new Set(frozen.flatMap(record => deps.collectAssetIds(record.envelope.recordType, record.value)))];
  await deps.assets.prepareForUpload(assetIds);
  return {
    vaultId: deps.uid,
    keyset: structuredClone(deps.keyset),
    masterKey: deps.masterKey,
    records: async function* () {
      for (const record of frozen) yield structuredClone(record.envelope);
    },
    assets: () => deps.assets.exportAssetChunks(assetIds),
  };
}

export async function createPrivateProVaultBackupStream(deps: PrivateProVaultBackupDependencies) {
  return createPrivateProEncryptedBackupStream(await createPrivateProVaultBackupSource(deps));
}

export async function importPrivateProVaultBackup(
  stream: ReadableStream<Uint8Array>,
  credential: PrivateProEncryptedBackupCredential,
  deps: Pick<PrivateProVaultBackupDependencies, 'uid' | 'db' | 'serializers'> & {
    activeMasterKey?: CryptoKey;
    activeKeyVersion?: number;
    activeAssets?: Pick<PrivateProVaultAssetClient, 'prepareForUpload'>;
    transport?: PrivateProVaultTransport;
    createBackupAssetClient?(masterKey: CryptoKey, keyVersion: number, vaultId: string): PrivateProVaultAssetClient;
    createAssetClient?(masterKey: CryptoKey, keyVersion: number, vaultId: string): PrivateProVaultAssetClient;
    createOperationId?(): string;
    verifyHydrated?(
      index: readonly import('./privatePro.vault.repository').PrivateProVaultIndexEntry[],
      envelopes: readonly PrivateProVaultEnvelope[],
    ): Promise<void>;
  },
) {
  const serializers = serializerMap(deps.serializers);
  let verifiedCloudHydration = false;
  const result = await importPrivateProEncryptedBackup(
    stream,
    credential,
    async ({ envelope, plaintext }) => {
      const serializer = serializers.get(envelope.recordType);
      if (!serializer || serializer.schemaVersion !== envelope.schemaVersion)
        throw new Error('Encrypted backup record schema is unsupported.');
      await serializer.normalize(JSON.parse(textDecoder.decode(plaintext)) as unknown);
    },
    async input => {
      if (input.header.vaultId !== deps.uid) throw new Error('Encrypted backup belongs to another vault.');
      if (deps.activeMasterKey && deps.activeKeyVersion && deps.activeAssets && deps.transport) {
        const activeMasterKey = deps.activeMasterKey;
        const activeKeyVersion = deps.activeKeyVersion;
        if (!deps.transport.isOnline()) throw new Error('Reconnect before merging an encrypted backup.');
        if (!deps.verifyHydrated) throw new Error('Encrypted backup restore hydration is unavailable.');
        if (!deps.transport.beginBackupRestore || !deps.transport.getBackupRestoreStatus
          || !deps.transport.mergeBackupRestoreChunk || !deps.transport.getBackupRestoreIndex
          || !deps.transport.getBackupRestoreRecords || !deps.transport.sealBackupRestore
          || !deps.transport.confirmBackupRestoreVerified)
          throw new Error('Encrypted backup restore sessions are unavailable.');
        const backupAssets = (deps.createBackupAssetClient ?? deps.createAssetClient)?.(
          input.masterKey, input.header.keyset.keyVersion, input.header.vaultId,
        );
        if (!backupAssets) throw new Error('Encrypted backup asset staging is unavailable.');
        const staged = await Promise.all(input.records.map(async envelope => {
          const serializer = serializers.get(envelope.recordType)!;
          const value = await decryptAndNormalize(input.header.vaultId, input.masterKey, serializer, envelope);
          const plaintext = textEncoder.encode(JSON.stringify(value));
          const projectedCiphertextBytes = plaintext.byteLength + 16;
          if (projectedCiphertextBytes > PRIVATE_PRO_VAULT_FIRESTORE_MAX_CIPHERTEXT_BYTES)
            throw new Error('Encrypted backup record exceeds the cloud record limit.');
          return { serializer, value, recordId: await serializer.recordIdFor(value), plaintext, projectedCiphertextBytes };
        }));
        const backupFingerprint = input.transcriptMacBase64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const restoreId = deps.createOperationId?.() ?? `restore-${backupFingerprint}`;
        const restoreStatus = await deps.transport.getBackupRestoreStatus(restoreId);
        const chunks = restoreChunks(staged, record => record.projectedCiphertextBytes);
        const assetIds = [...new Set(staged.flatMap(record => collectPrivateProVaultAssetIds(record.serializer.recordType, record.value)))];
        const materializedAssetIds = await backupAssets.importAssetChunks(input.assets);
        let cloudCommitted = false;
        try {
          await deps.activeAssets.prepareForUpload(assetIds);
          const index = restoreStatus
            && restoreStatus.phase !== 'completed'
            ? await deps.transport.getBackupRestoreIndex(restoreId)
            : await deps.transport.getIndex();
          const revisions = new Map(index.map(entry => [`${entry.recordType}:${entry.opaqueRecordId}`, entry.revision]));
          const nonceKey = await deriveVaultSubkey(activeMasterKey, 'backup-restore-nonce', backupFingerprint, ['sign']);
          const restoreChunksWithManifest = await Promise.all(chunks.map(async (chunk, chunkIndex) => {
            const records = await Promise.all(chunk.map(async record => {
              const currentRevision = revisions.get(`${record.serializer.recordType}:${record.recordId}`) ?? 0;
              const alreadyCommitted = restoreStatus !== null
                && restoreStatus.phase !== 'completed'
                && chunkIndex < restoreStatus.nextChunkIndex;
              if (alreadyCommitted && currentRevision < 1)
                throw new PrivateProVaultBackupCommittedError('Cloud backup restore progress is incomplete. Restart to reconcile.');
              const baseRevision = alreadyCommitted ? currentRevision - 1 : currentRevision;
              const key = await deriveVaultSubkey(
                activeMasterKey, 'record-encryption', `${record.serializer.recordType}:${record.recordId}`, ['encrypt'],
              );
              const nonce = new Uint8Array(await crypto.subtle.sign(
                'HMAC',
                nonceKey,
                textEncoder.encode(canonicalJson({
                  kind: 'private-pro-vault-restore-nonce/v1',
                  backupFingerprint,
                  recordType: record.serializer.recordType,
                  recordId: record.recordId,
                  revision: baseRevision + 1,
                })),
              )).slice(0, 12);
              const envelope = await encryptVaultRecord(key, {
                vaultId: deps.uid,
                formatVersion: 1,
                recordType: record.serializer.recordType,
                recordId: record.recordId,
                schemaVersion: record.serializer.schemaVersion,
                keyVersion: activeKeyVersion,
                revision: baseRevision + 1,
              }, record.plaintext, nonce);
              nonce.fill(0);
              return { ...record, baseRevision, envelope };
            }));
            return {
              records,
              chunkFingerprint: await digestPrivateProVaultRestoreChunk(records.map(record => ({
                opaqueRecordId: record.recordId,
                baseRevision: record.baseRevision,
                envelope: record.envelope,
              }))),
            };
          }));
          const totalRestoreCiphertextBytes = restoreChunksWithManifest
            .flatMap(chunk => chunk.records)
            .reduce((sum, record) => sum + record.envelope.ciphertextBytes, 0);
          const expectedRevisions = new Map<string, number>();
          if (restoreStatus && restoreStatus.nextChunkIndex > 0) {
            for (const record of restoreChunksWithManifest.slice(0, restoreStatus.nextChunkIndex).flatMap(chunk => chunk.records)) {
              const revision = revisions.get(`${record.serializer.recordType}:${record.recordId}`);
              if (!revision)
                throw new PrivateProVaultBackupCommittedError('Cloud backup restore progress is incomplete. Restart to reconcile.');
              expectedRevisions.set(record.recordId, revision);
            }
          }
          if (restoreStatus?.phase === 'completed') return;
          try {
            await retryAmbiguous(deps.transport, () => deps.transport!.beginBackupRestore!({
              restoreId,
              backupFingerprint,
              backupRecordCount: input.records.length,
              backupTotalCiphertextBytes: input.totalCiphertextBytes,
              chunkCount: restoreChunksWithManifest.length,
              recordCount: staged.length,
              chunkRecordCounts: restoreChunksWithManifest.map(chunk => chunk.records.length),
              chunkFingerprints: restoreChunksWithManifest.map(chunk => chunk.chunkFingerprint),
              totalCiphertextBytes: totalRestoreCiphertextBytes,
            }));
          } catch (error) {
            if (error instanceof PrivateProVaultAmbiguousTransportError) {
              cloudCommitted = true;
              throw new PrivateProVaultBackupCommittedError('Cloud backup restore status is ambiguous. Restart to reconcile.', { cause: error });
            }
            throw error;
          }
          cloudCommitted = true;
          const status = await deps.transport.getBackupRestoreStatus(restoreId);
          let nextChunkIndex = status?.nextChunkIndex ?? 0;
          for (let chunkIndex = nextChunkIndex; chunkIndex < restoreChunksWithManifest.length; chunkIndex++) {
            const chunk = restoreChunksWithManifest[chunkIndex].records;
            const result = await retryAmbiguous(deps.transport, () => deps.transport!.mergeBackupRestoreChunk!({
              restoreId,
              operationId: `restore-chunk-${backupFingerprint}:${chunkIndex}`,
              chunkIndex,
              chunkFingerprint: restoreChunksWithManifest[chunkIndex].chunkFingerprint,
              records: chunk.map(record => ({ opaqueRecordId: record.recordId, baseRevision: record.baseRevision, envelope: record.envelope })),
            }));
            if (result.status === 'conflict') throw new Error('The cloud vault changed during backup merge. Retry the merge.');
            for (const record of chunk) expectedRevisions.set(record.recordId, record.envelope.revision);
            nextChunkIndex = result.nextChunkIndex;
          }
          if (nextChunkIndex !== restoreChunksWithManifest.length)
            throw new PrivateProVaultBackupCommittedError('Cloud backup restore is incomplete. Restart to reconcile.');
          const sealed = await retryAmbiguous(deps.transport, () => deps.transport!.sealBackupRestore!({
            restoreId,
            operationId: `restore-seal-${backupFingerprint}`,
          }));
          const verifiedIndex = await deps.transport.getBackupRestoreIndex(restoreId);
          const restoredIds = new Set(staged.map(record => `${record.serializer.recordType}:${record.recordId}`));
          const relevantIndex = verifiedIndex
            .filter(entry => restoredIds.has(`${entry.recordType}:${entry.opaqueRecordId}`))
            .sort((left, right) => left.opaqueRecordId.localeCompare(right.opaqueRecordId));
          const allRecordEntries = verifiedIndex.filter(entry => entry.kind === 'record');
          const allVerifiedEnvelopes = await deps.transport.getBackupRestoreRecords(
            restoreId,
            allRecordEntries.map(entry => entry.opaqueRecordId),
          );
          const verifiedById = new Map(allVerifiedEnvelopes.map(envelope => [envelope.recordId, envelope]));
          const verifiedEnvelopes = relevantIndex.flatMap(entry => {
            const envelope = verifiedById.get(entry.opaqueRecordId);
            return envelope ? [envelope] : [];
          });
          for (const record of staged) {
            const entry = relevantIndex.find(candidate => candidate.opaqueRecordId === record.recordId);
            const envelope = verifiedById.get(record.recordId);
            const expectedRevision = expectedRevisions.get(record.recordId);
            if (
              !entry || !envelope || !expectedRevision
              || entry.recordType !== record.serializer.recordType
              || entry.revision !== expectedRevision
              || entry.keyVersion !== activeKeyVersion
              || envelope.recordType !== record.serializer.recordType
              || envelope.recordId !== record.recordId
              || envelope.schemaVersion !== record.serializer.schemaVersion
              || envelope.keyVersion !== activeKeyVersion
              || envelope.revision !== expectedRevision
            ) throw new PrivateProVaultBackupCommittedError('Cloud backup merge committed, but exact verification metadata mismatched. Restart to reconcile.');
            const verifiedValue = await decryptAndValidate(
              { uid: deps.uid, masterKey: activeMasterKey, serializers: deps.serializers }, envelope,
            );
            if (canonicalJson(verifiedValue) !== canonicalJson(record.value))
              throw new PrivateProVaultBackupCommittedError('Cloud backup merge committed, but exact verification mismatch was detected. Restart to reconcile.');
          }
          if (verifiedEnvelopes.length !== staged.length)
            throw new PrivateProVaultBackupCommittedError('Cloud backup merge committed, but exact verification is incomplete. Restart to reconcile.');
          if (allVerifiedEnvelopes.length !== allRecordEntries.length)
            throw new PrivateProVaultBackupCommittedError('Cloud backup restore record hydration is incomplete. Restart to reconcile.');
          await deps.verifyHydrated(verifiedIndex, allVerifiedEnvelopes);
          verifiedCloudHydration = true;
          await retryAmbiguous(deps.transport, () => deps.transport!.confirmBackupRestoreVerified!({
            restoreId,
            operationId: `restore-confirm-${backupFingerprint}`,
            sessionFingerprint: sealed.sessionFingerprint,
          }));
          return;
        } catch (error) {
          if (!cloudCommitted) {
            await backupAssets.rollbackImportedAssets(materializedAssetIds);
            throw error;
          }
          if (error instanceof PrivateProVaultBackupCommittedError) throw error;
          throw new PrivateProVaultBackupCommittedError(
            'Cloud backup merge committed, but local verification did not finish. Restart to reconcile.',
            { cause: error },
          );
        }
      }

      const assets = deps.createAssetClient?.(input.masterKey, input.header.keyset.keyVersion, input.header.vaultId);
      if (!assets) throw new Error('Encrypted backup asset restore is unavailable.');
      const staged = await Promise.all(input.records.map(async envelope => ({
        envelope,
        serializer: serializers.get(envelope.recordType)!,
        value: await decryptAndValidate({ uid: input.header.vaultId, masterKey: input.masterKey, serializers: deps.serializers }, envelope),
      })));
      const runtimeBefore = new Map<string, Array<{ recordId: string; value: unknown }>>();
      const durableBefore = await deps.db.records.where('uid').equals(deps.uid).toArray();
      const revisionBefore = await deps.db.revisions.where('uid').equals(deps.uid).toArray();
      const outboxBefore = await deps.db.outbox.where('uid').equals(deps.uid).toArray();
      for (const serializer of deps.serializers)
        runtimeBefore.set(serializer.recordType, await serializer.snapshot());
      let materializedAssetIds: string[] = [];
      try {
        materializedAssetIds = await assets.importAssetChunks(input.assets);
        for (const serializer of deps.serializers) {
          for (const current of await serializer.snapshot()) await serializer.remove(current.recordId);
          for (const record of staged) {
            if (record.serializer === serializer) await serializer.apply(record.envelope.recordId, record.value);
          }
        }
        await deps.db.transaction('rw', [deps.db.records, deps.db.revisions, deps.db.outbox], async () => {
          await deps.db.records.where('uid').equals(deps.uid).delete();
          await deps.db.revisions.where('uid').equals(deps.uid).delete();
          await deps.db.outbox.where('uid').equals(deps.uid).delete();
          for (const envelope of input.records) await deps.db.putEncryptedRecord(deps.uid, envelope);
          if (input.records.length) await deps.db.revisions.bulkPut(input.records.map(envelope => ({
            uid: deps.uid,
            recordType: envelope.recordType,
            recordId: envelope.recordId,
            revision: envelope.revision,
          })));
        });
      } catch (error) {
        for (const serializer of [...deps.serializers].reverse()) {
          for (const current of await serializer.snapshot()) await serializer.remove(current.recordId);
          for (const record of runtimeBefore.get(serializer.recordType) ?? []) await serializer.apply(record.recordId, record.value);
        }
        await deps.db.transaction('rw', [deps.db.records, deps.db.revisions, deps.db.outbox], async () => {
          await deps.db.records.where('uid').equals(deps.uid).delete();
          await deps.db.revisions.where('uid').equals(deps.uid).delete();
          await deps.db.outbox.where('uid').equals(deps.uid).delete();
          if (durableBefore.length) await deps.db.records.bulkPut(durableBefore);
          if (revisionBefore.length) await deps.db.revisions.bulkPut(revisionBefore);
          if (outboxBefore.length) await deps.db.outbox.bulkPut(outboxBefore);
        });
        await assets.rollbackImportedAssets(materializedAssetIds);
        throw error;
      }
    },
  );
  return { ...result, verifiedCloudHydration };
}
