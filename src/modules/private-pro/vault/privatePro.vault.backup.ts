import { decryptVaultRecord, deriveVaultSubkey, encryptVaultRecord } from './privatePro.vault.crypto';
import type { PrivateProVaultAssetClient } from './privatePro.vault.assets.client';
import type { PrivateProVaultDB } from './privatePro.vault.db';
import type { PrivateProVaultSerializer } from './privatePro.vault.serializers';
import type { PrivateProVaultEnvelope, PrivateProVaultKeyset } from './privatePro.vault.types';
import type { PrivateProVaultTransport } from './privatePro.vault.transport';
import { collectPrivateProVaultAssetIds } from './privatePro.vault.assets.client';
import {
  createPrivateProEncryptedBackupStream,
  importPrivateProEncryptedBackup,
  type PrivateProEncryptedBackupCredential,
  type PrivateProEncryptedBackupSource,
} from '~/modules/trade/privateProEncryptedBackup';


const textDecoder = new TextDecoder('utf-8', { fatal: true });
const textEncoder = new TextEncoder();

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
  },
) {
  const serializers = serializerMap(deps.serializers);
  return importPrivateProEncryptedBackup(
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
        const backupAssets = (deps.createBackupAssetClient ?? deps.createAssetClient)?.(
          input.masterKey, input.header.keyset.keyVersion, input.header.vaultId,
        );
        if (!backupAssets) throw new Error('Encrypted backup asset staging is unavailable.');
        const staged = await Promise.all(input.records.map(async envelope => {
          const serializer = serializers.get(envelope.recordType)!;
          const value = await decryptAndNormalize(input.header.vaultId, input.masterKey, serializer, envelope);
          return { serializer, value, recordId: await serializer.recordIdFor(value) };
        }));
        const assetIds = [...new Set(staged.flatMap(record => collectPrivateProVaultAssetIds(record.serializer.recordType, record.value)))];
        const materializedAssetIds = await backupAssets.importAssetChunks(input.assets);
        let cloudCommitted = false;
        try {
          await deps.activeAssets.prepareForUpload(assetIds);
          const index = await deps.transport.getIndex();
          const revisions = new Map(index.map(entry => [`${entry.recordType}:${entry.opaqueRecordId}`, entry.revision]));
          const mergeRecords = await Promise.all(staged.map(async record => {
            const baseRevision = revisions.get(`${record.serializer.recordType}:${record.recordId}`) ?? 0;
            const key = await deriveVaultSubkey(
              activeMasterKey, 'record-encryption', `${record.serializer.recordType}:${record.recordId}`, ['encrypt'],
            );
            const envelope = await encryptVaultRecord(key, {
              vaultId: deps.uid,
              formatVersion: 1,
              recordType: record.serializer.recordType,
              recordId: record.recordId,
              schemaVersion: record.serializer.schemaVersion,
              keyVersion: activeKeyVersion,
              revision: baseRevision + 1,
            }, textEncoder.encode(JSON.stringify(record.value)));
            return { ...record, baseRevision, envelope };
          }));
          const operationId = deps.createOperationId?.() ?? `restore-${crypto.randomUUID()}`;
          const mergeInput = {
            operationId,
            records: mergeRecords.map(record => ({
              opaqueRecordId: record.recordId,
              baseRevision: record.baseRevision,
              envelope: record.envelope,
            })),
          };
          let result;
          try {
            result = await deps.transport.mergeBackup(mergeInput);
          } catch (error) {
            if (!(error instanceof TypeError) || !deps.transport.isOnline()) throw error;
            result = await deps.transport.mergeBackup(mergeInput);
          }
          if (result.status === 'conflict') throw new Error('The cloud vault changed during backup merge. Retry the merge.');
          cloudCommitted = true;
          const committedById = new Map(result.records.map(record => [record.opaqueRecordId, record]));
          if (committedById.size !== mergeRecords.length)
            throw new PrivateProVaultBackupCommittedError('Cloud backup merge committed, but exact verification is incomplete. Restart to reconcile.');
          const verifiedIndex = await deps.transport.getIndex();
          const restoredIds = new Set(mergeRecords.map(record => `${record.serializer.recordType}:${record.recordId}`));
          const relevantIndex = verifiedIndex
            .filter(entry => restoredIds.has(`${entry.recordType}:${entry.opaqueRecordId}`))
            .sort((left, right) => left.opaqueRecordId.localeCompare(right.opaqueRecordId));
          const verifiedEnvelopes = await deps.transport.getRecords(relevantIndex.map(entry => entry.opaqueRecordId));
          const verifiedById = new Map(verifiedEnvelopes.map(envelope => [envelope.recordId, envelope]));
          for (const record of mergeRecords) {
            const receipt = committedById.get(record.recordId);
            const entry = relevantIndex.find(candidate => candidate.opaqueRecordId === record.recordId);
            const envelope = verifiedById.get(record.recordId);
            if (
              !receipt || !entry || !envelope
              || receipt.revision !== record.envelope.revision
              || entry.recordType !== record.serializer.recordType
              || entry.revision !== record.envelope.revision
              || entry.keyVersion !== activeKeyVersion
              || envelope.recordType !== record.serializer.recordType
              || envelope.recordId !== record.recordId
              || envelope.schemaVersion !== record.serializer.schemaVersion
              || envelope.keyVersion !== activeKeyVersion
              || envelope.revision !== record.envelope.revision
            ) throw new PrivateProVaultBackupCommittedError('Cloud backup merge committed, but exact verification metadata mismatched. Restart to reconcile.');
            const verifiedValue = await decryptAndValidate(
              { uid: deps.uid, masterKey: activeMasterKey, serializers: deps.serializers }, envelope,
            );
            if (canonicalJson(verifiedValue) !== canonicalJson(record.value))
              throw new PrivateProVaultBackupCommittedError('Cloud backup merge committed, but exact verification mismatch was detected. Restart to reconcile.');
          }
          if (verifiedEnvelopes.length !== mergeRecords.length)
            throw new PrivateProVaultBackupCommittedError('Cloud backup merge committed, but exact verification is incomplete. Restart to reconcile.');
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
}
