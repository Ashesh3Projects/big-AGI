import { decryptVaultRecord, deriveVaultSubkey } from './privatePro.vault.crypto';
import type { PrivateProVaultAssetClient } from './privatePro.vault.assets.client';
import type { PrivateProVaultDB } from './privatePro.vault.db';
import type { PrivateProVaultSerializer } from './privatePro.vault.serializers';
import type { PrivateProVaultEnvelope, PrivateProVaultKeyset, PrivateProVaultRecordType } from './privatePro.vault.types';
import {
  createPrivateProEncryptedBackupStream,
  importPrivateProEncryptedBackup,
  type PrivateProEncryptedBackupCredential,
  type PrivateProEncryptedBackupSource,
} from '~/modules/trade/privateProEncryptedBackup';


const textDecoder = new TextDecoder('utf-8', { fatal: true });

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
    createAssetClient(masterKey: CryptoKey, keyVersion: number, vaultId: string): PrivateProVaultAssetClient;
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
      await serializer.validate(envelope.recordId, JSON.parse(textDecoder.decode(plaintext)) as unknown);
    },
    async input => {
      if (input.header.vaultId !== deps.uid) throw new Error('Encrypted backup belongs to another vault.');
      const assets = deps.createAssetClient(input.masterKey, input.header.keyset.keyVersion, input.header.vaultId);
      const staged = await Promise.all(input.records.map(async envelope => ({
        envelope,
        serializer: serializers.get(envelope.recordType)!,
        value: await decryptAndValidate({ uid: input.header.vaultId, masterKey: input.masterKey, serializers: deps.serializers }, envelope),
      })));
      const runtimeBefore = new Map<PrivateProVaultRecordType, Array<{ recordId: string; value: unknown }>>();
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
