import { PRIVATE_PRO_VAULT_FIRESTORE_MAX_CIPHERTEXT_BYTES } from './privatePro.vault.repository';
import { decryptVaultRecord, deriveVaultSubkey, encryptVaultRecord, type PrivateProVaultContext } from './privatePro.vault.crypto';
import {
  type PrivateProVaultDB,
  type PrivateProVaultEncryptedRecord,
  type PrivateProVaultOutboxRecord,
} from './privatePro.vault.db';
import type {
  PrivateProPortableMutation,
  PrivateProVaultSerializer,
} from './privatePro.vault.serializers';
import type { PrivateProVaultState, PrivateProVaultStore } from './store-private-pro-vault';
import {
  PrivateProVaultChunkRequiredError,
  type PrivateProVaultIndexEntry,
  type PrivateProVaultTransport,
} from './privatePro.vault.transport';
import type {
  PrivateProVaultEnvelope,
  PrivateProVaultOperation,
  PrivateProVaultRecordType,
} from './privatePro.vault.types';


const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

interface StagedRecord {
  serializer: PrivateProVaultSerializer<unknown>;
  recordId: string;
  value: unknown;
  envelope: PrivateProVaultEnvelope;
}

interface PrivateProVaultEngineDependencies {
  uid: string;
  keyVersion: number;
  masterKey: CryptoKey;
  vaultContext: PrivateProVaultContext;
  db: PrivateProVaultDB;
  serializers: readonly PrivateProVaultSerializer<unknown>[];
  transport: PrivateProVaultTransport;
  store: PrivateProVaultStore;
  now?: () => number;
  createOperationId?: () => string;
}

export interface PrivateProVaultEngine {
  hydrateBeforeOpen(): Promise<void>;
  start(): Promise<void>;
  stop(): void;
  whenCurrent(): Promise<void>;
  logoutAndClear(): Promise<void>;
}

export class PrivateProVaultRollbackError extends Error {
  constructor() {
    super('Remote encrypted vault index regression detected.');
    this.name = 'PrivateProVaultRollbackError';
  }
}

function recordKey(recordType: PrivateProVaultRecordType, recordId: string): string {
  return `${recordType}:${recordId}`;
}

function operationRecord(operation: PrivateProVaultOperation) {
  return operation.kind === 'put'
    ? { recordType: operation.envelope.recordType, recordId: operation.envelope.recordId }
    : { recordType: operation.tombstone.recordType, recordId: operation.tombstone.recordId };
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof PrivateProVaultChunkRequiredError) return 'This encrypted record requires chunked sync support.';
  if (error instanceof PrivateProVaultRollbackError) return 'The remote vault revision moved backwards.';
  if (error instanceof TypeError) return 'Reconnect to update your encrypted vault.';
  return 'The encrypted vault could not be synchronized.';
}

function isRecordEntry(entry: PrivateProVaultIndexEntry): entry is Extract<PrivateProVaultIndexEntry, { kind: 'record' }> {
  return entry.kind === 'record';
}

export function createPrivateProVaultEngine(deps: PrivateProVaultEngineDependencies): PrivateProVaultEngine {
  const serializers = new Map(deps.serializers.map(serializer => [serializer.recordType, serializer]));
  const now = deps.now ?? Date.now;
  const createOperationId = deps.createOperationId ?? (() => crypto.randomUUID());
  let stopped = true;
  let started = false;
  let suppressLocalEvents = 0;
  let work = Promise.resolve();
  let unsubscribeConnectivity: (() => void) | undefined;
  let unsubscribeSerializers: Array<() => void> = [];
  let nextLocalSequence: number | undefined;

  const setStatus = (state: Partial<Omit<PrivateProVaultState, 'setState'>>) => deps.store.getState().setState(state);

  const pendingCount = async () => deps.db.outbox.where('uid').equals(deps.uid).count();

  const refreshPending = async () => setStatus({ pendingOperations: await pendingCount() });

  const allocateLocalSequence = async () => {
    if (nextLocalSequence === undefined) {
      const existing = await deps.db.outbox.where('uid').equals(deps.uid).toArray();
      nextLocalSequence = existing.reduce((maximum, record) => Math.max(maximum, record.localSequence ?? 0), 0) + 1;
    }
    return nextLocalSequence++;
  };

  const queue = (task: () => Promise<void>) => {
    const next = work.then(task, task);
    work = next.catch(() => {});
    return next;
  };

  const withSuppressedEvents = async <T>(task: () => Promise<T>): Promise<T> => {
    suppressLocalEvents++;
    try {
      return await task();
    } finally {
      suppressLocalEvents--;
    }
  };

  const serializerFor = (recordType: PrivateProVaultRecordType) => {
    const serializer = serializers.get(recordType);
    if (!serializer) throw new Error(`No serializer is registered for encrypted vault record type ${recordType}.`);
    return serializer;
  };

  const recordCipherKey = (recordType: PrivateProVaultRecordType, recordId: string, usage: 'encrypt' | 'decrypt') =>
    deriveVaultSubkey(deps.masterKey, 'record-encryption', recordKey(recordType, recordId), [usage]);

  const decryptAndValidate = async (envelope: PrivateProVaultEnvelope): Promise<StagedRecord> => {
    const serializer = serializerFor(envelope.recordType);
    if (envelope.schemaVersion !== serializer.schemaVersion)
      throw new Error('Encrypted vault record schema is unsupported.');
    const key = await recordCipherKey(envelope.recordType, envelope.recordId, 'decrypt');
    const plaintext = await decryptVaultRecord(key, envelope, deps.vaultContext);
    const value = JSON.parse(textDecoder.decode(plaintext)) as unknown;
    return {
      serializer,
      recordId: envelope.recordId,
      value: await serializer.validate(envelope.recordId, value),
      envelope,
    };
  };

  const encryptPut = async (mutation: Extract<PrivateProPortableMutation, { kind: 'put' }>, baseRevision: number, operationId: string) => {
    const serializer = serializerFor(mutation.recordType);
    const value = await serializer.validate(mutation.recordId, mutation.value);
    const key = await recordCipherKey(mutation.recordType, mutation.recordId, 'encrypt');
    const envelope = await encryptVaultRecord(key, {
      ...deps.vaultContext,
      formatVersion: 1,
      recordType: mutation.recordType,
      recordId: mutation.recordId,
      schemaVersion: mutation.schemaVersion,
      keyVersion: deps.keyVersion,
      revision: baseRevision + 1,
    }, textEncoder.encode(JSON.stringify(value)));
    return {
      formatVersion: 1,
      operationId,
      kind: 'put',
      baseRevision,
      envelope,
    } satisfies PrivateProVaultOperation;
  };

  const mutationOperation = async (mutation: PrivateProPortableMutation, baseRevision: number, operationId: string): Promise<PrivateProVaultOperation> => {
    if (mutation.kind === 'put') return encryptPut(mutation, baseRevision, operationId);
    return {
      formatVersion: 1,
      operationId,
      kind: 'delete',
      baseRevision,
      tombstone: {
        formatVersion: 1,
        recordType: mutation.recordType,
        recordId: mutation.recordId,
        revision: baseRevision + 1,
        keyVersion: deps.keyVersion,
        operationId,
        deletedAtMs: now(),
      },
    };
  };

  const captureRuntime = async () => new Map(await Promise.all(deps.serializers.map(async serializer => [
    serializer.recordType,
    await serializer.snapshot(),
  ] as const)));

  const replaceRuntime = async (records: readonly StagedRecord[]) => {
    const before = await captureRuntime();
    try {
      await withSuppressedEvents(async () => {
        for (const serializer of deps.serializers) {
          for (const current of await serializer.snapshot()) await serializer.remove(current.recordId);
          for (const record of records) {
            if (record.serializer === serializer) await serializer.apply(record.recordId, record.value);
          }
        }
      });
    } catch (error) {
      await withSuppressedEvents(async () => {
        for (const serializer of [...deps.serializers].reverse()) {
          for (const current of await serializer.snapshot()) await serializer.remove(current.recordId);
          for (const record of before.get(serializer.recordType) ?? []) await serializer.apply(record.recordId, record.value);
        }
      });
      throw error;
    }
  };

  const assertIndexCurrent = async (index: readonly PrivateProVaultIndexEntry[]) => {
    const remoteByKey = new Map(index.map(entry => [recordKey(entry.recordType, entry.opaqueRecordId), entry]));
    const localRevisions = await deps.db.revisions.where('uid').equals(deps.uid).toArray();
    for (const local of localRevisions) {
      const remote = remoteByKey.get(recordKey(local.recordType, local.recordId));
      if (!remote || remote.revision < local.revision) throw new PrivateProVaultRollbackError();
    }
  };

  const downloadStage = async (index: readonly PrivateProVaultIndexEntry[]) => {
    const cached = new Map((await deps.db.listEncryptedRecords(deps.uid)).map(envelope => [
      recordKey(envelope.recordType, envelope.recordId),
      envelope,
    ]));
    const needed = index.filter(isRecordEntry).filter(entry => {
      const envelope = cached.get(recordKey(entry.recordType, entry.opaqueRecordId));
      return !envelope || envelope.revision !== entry.revision;
    });
    const downloaded = await deps.transport.getRecords(needed.map(entry => entry.opaqueRecordId));
    const downloadedByKey = new Map(downloaded.map(envelope => [recordKey(envelope.recordType, envelope.recordId), envelope]));
    const envelopes = index.filter(isRecordEntry).map(entry => {
      const key = recordKey(entry.recordType, entry.opaqueRecordId);
      const envelope = downloadedByKey.get(key) ?? cached.get(key);
      if (!envelope || envelope.revision !== entry.revision || envelope.keyVersion !== entry.keyVersion)
        throw new Error('Encrypted vault index and record payload disagree.');
      return envelope;
    });
    return {
      records: await Promise.all(envelopes.map(decryptAndValidate)),
      envelopes,
    };
  };

  const persistCurrent = async (index: readonly PrivateProVaultIndexEntry[], envelopes: readonly PrivateProVaultEnvelope[]) => {
    await deps.db.transaction('rw', [deps.db.records, deps.db.revisions], async () => {
      await deps.db.records.where('uid').equals(deps.uid).delete();
      await deps.db.revisions.where('uid').equals(deps.uid).delete();
      if (envelopes.length) await deps.db.records.bulkPut(envelopes.map(envelope => ({
        uid: deps.uid,
        recordType: envelope.recordType,
        recordId: envelope.recordId,
        revision: envelope.revision,
        envelope: structuredClone(envelope),
      } satisfies PrivateProVaultEncryptedRecord)));
      if (index.length) await deps.db.revisions.bulkPut(index.map(entry => ({
        uid: deps.uid,
        recordType: entry.recordType,
        recordId: entry.opaqueRecordId,
        revision: entry.revision,
      })));
    });
  };

  const fetchCanonical = async (recordType: PrivateProVaultRecordType, recordId: string, expectedRevision: number) => {
    const envelopes = await deps.transport.getRecords([recordId]);
    const envelope = envelopes.find(candidate => candidate.recordType === recordType && candidate.recordId === recordId);
    if (!envelope || envelope.revision !== expectedRevision)
      throw new Error('Canonical encrypted vault record is unavailable.');
    return decryptAndValidate(envelope);
  };

  const acknowledge = async (outbox: PrivateProVaultOutboxRecord, revision: number) => {
    const { recordType, recordId } = operationRecord(outbox.operation);
    await deps.db.transaction('rw', [deps.db.outbox, deps.db.records, deps.db.revisions], async () => {
      await deps.db.outbox.delete([deps.uid, outbox.operationId]);
      if (outbox.operation.kind === 'put') {
        await deps.db.records.put({
          uid: deps.uid,
          recordType,
          recordId,
          revision,
          envelope: structuredClone(outbox.operation.envelope),
        });
      } else {
        await deps.db.records.delete([deps.uid, recordType, recordId]);
      }
      await deps.db.revisions.put({ uid: deps.uid, recordType, recordId, revision });
    });
  };

  const replaceOutbox = async (previous: PrivateProVaultOutboxRecord, operation: PrivateProVaultOperation) => {
    await deps.db.transaction('rw', deps.db.outbox, async () => {
      await deps.db.outbox.delete([deps.uid, previous.operationId]);
      await deps.db.outbox.put({
        uid: deps.uid,
        operationId: operation.operationId,
        operation,
        createdAtMs: previous.createdAtMs,
        localSequence: previous.localSequence,
      });
    });
  };

  const resolveConflict = async (outbox: PrivateProVaultOutboxRecord, currentRevision: number) => {
    const { recordType, recordId } = operationRecord(outbox.operation);
    const serializer = serializerFor(recordType);
    const canonical = await fetchCanonical(recordType, recordId, currentRevision);
    await withSuppressedEvents(() => serializer.apply(recordId, canonical.value));

    if (outbox.operation.kind === 'delete') {
      if (serializer.conflictPolicy !== 'replace') {
        setStatus({ phase: 'conflict', ready: false, conflict: { recordType, recordId }, lastError: 'This encrypted record needs a conflict choice.' });
        return false;
      }
      await withSuppressedEvents(() => serializer.remove(recordId));
      const operation = await mutationOperation({ kind: 'delete', recordType, recordId, schemaVersion: serializer.schemaVersion }, currentRevision, createOperationId());
      await replaceOutbox(outbox, operation);
      return true;
    }

    const local = await decryptAndValidate(outbox.operation.envelope);
    if (serializer.conflictPolicy === 'replace') {
      await withSuppressedEvents(() => serializer.apply(recordId, local.value));
      const operation = await encryptPut({
        kind: 'put', recordType, recordId, schemaVersion: serializer.schemaVersion, value: local.value,
      }, currentRevision, createOperationId());
      await replaceOutbox(outbox, operation);
      return true;
    }

    if (serializer.conflictPolicy === 'conflict-copy' && serializer.createConflictCopy) {
      const copy = await serializer.createConflictCopy(local.value);
      const copyValue = await serializer.validate(copy.recordId, copy.value);
      await withSuppressedEvents(() => serializer.apply(copy.recordId, copyValue));
      await deps.db.outbox.delete([deps.uid, outbox.operationId]);
      const operationId = createOperationId();
      const operation = await encryptPut({
        kind: 'put', recordType, recordId: copy.recordId, schemaVersion: serializer.schemaVersion, value: copyValue,
      }, 0, operationId);
      await deps.db.outbox.put({
        uid: deps.uid,
        operationId,
        operation,
        createdAtMs: now(),
        localSequence: await allocateLocalSequence(),
      });
      return true;
    }

    setStatus({ phase: 'conflict', ready: false, conflict: { recordType, recordId }, lastError: 'This encrypted record needs a conflict choice.' });
    return false;
  };

  const drainOutbox = async () => {
    while (true) {
      const outbox = (await deps.db.outbox.where('uid').equals(deps.uid).toArray()).sort((left, right) =>
        (left.localSequence ?? left.createdAtMs) - (right.localSequence ?? right.createdAtMs));
      const next = outbox[0];
      if (!next) break;
      if (next.operation.kind === 'put' && next.operation.envelope.ciphertextBytes > PRIVATE_PRO_VAULT_FIRESTORE_MAX_CIPHERTEXT_BYTES) {
        setStatus({ phase: 'chunk-required', ready: false, lastError: 'This encrypted record requires chunked sync support.' });
        break;
      }
      try {
        const result = await deps.transport.write(next.operation);
        if (result.status === 'conflict') {
          if (!await resolveConflict(next, result.currentRevision)) break;
          continue;
        }
        const { recordType, recordId } = operationRecord(next.operation);
        const serializer = serializerFor(recordType);
        if (next.operation.kind === 'put') {
          const local = await decryptAndValidate(next.operation.envelope);
          await withSuppressedEvents(() => serializer.apply(recordId, local.value));
        } else {
          await withSuppressedEvents(() => serializer.remove(recordId));
        }
        await acknowledge(next, result.revision);
      } catch (error) {
        if (error instanceof PrivateProVaultChunkRequiredError) {
          setStatus({ phase: 'chunk-required', ready: false, lastError: safeErrorMessage(error) });
        } else {
          setStatus({ phase: 'reconnecting', ready: false, lastError: safeErrorMessage(error) });
        }
        break;
      }
    }
    await refreshPending();
  };

  const stageApplyAndPersist = async () => {
    if (!deps.transport.isOnline()) throw new TypeError('Network unavailable.');
    const index = await deps.transport.getIndex();
    await assertIndexCurrent(index);
    const stage = await downloadStage(index);
    await replaceRuntime(stage.records);
    try {
      await persistCurrent(index, stage.envelopes);
    } catch (error) {
      throw error;
    }
  };

  const reconcile = async (throwOnFailure: boolean) => {
    setStatus({ phase: 'hydrating', ready: false, lastError: null, conflict: null });
    try {
      await stageApplyAndPersist();
      await drainOutbox();
      const state = deps.store.getState();
      if (state.phase !== 'conflict' && state.phase !== 'chunk-required' && state.phase !== 'reconnecting')
        setStatus({ phase: 'ready', ready: true, lastError: null, conflict: null });
    } catch (error) {
      const phase = error instanceof PrivateProVaultRollbackError
        ? 'rollback-blocked' as const
        : error instanceof TypeError
          ? 'reconnecting' as const
          : 'error' as const;
      setStatus({ phase, ready: false, lastError: safeErrorMessage(error) });
      if (throwOnFailure) throw error;
    }
  };

  const onMutation = (mutation: PrivateProPortableMutation) => {
    if (suppressLocalEvents || stopped) return;
    void queue(async () => {
      const revision = await deps.db.revisions.get([deps.uid, mutation.recordType, mutation.recordId]);
      const operationId = createOperationId();
      const operation = await mutationOperation(mutation, revision?.revision ?? 0, operationId);
      await deps.db.outbox.put({
        uid: deps.uid,
        operationId,
        operation,
        createdAtMs: now(),
        localSequence: await allocateLocalSequence(),
      });
      await refreshPending();
      if (!deps.store.getState().ready || !deps.transport.isOnline()) {
        setStatus({ phase: 'reconnecting', ready: false, lastError: 'Reconnect to update your encrypted vault.' });
        return;
      }
      await drainOutbox();
      if (deps.store.getState().phase === 'ready') setStatus({ ready: true });
    }).catch(error => setStatus({ phase: 'error', ready: false, lastError: safeErrorMessage(error) }));
  };

  return {
    async hydrateBeforeOpen() {
      await queue(() => reconcile(true));
    },

    async start() {
      if (!started) {
        started = true;
        stopped = false;
        unsubscribeSerializers = deps.serializers.map(serializer => serializer.subscribe(onMutation));
        unsubscribeConnectivity = deps.transport.subscribeConnectivity(online => {
          if (!online) {
            setStatus({ phase: 'reconnecting', ready: false, lastError: 'Reconnect to update your encrypted vault.' });
            return;
          }
          void queue(() => reconcile(false));
        });
      }
      if (deps.store.getState().phase !== 'ready') await queue(() => reconcile(false));
    },

    stop() {
      stopped = true;
      started = false;
      unsubscribeConnectivity?.();
      unsubscribeConnectivity = undefined;
      for (const unsubscribe of unsubscribeSerializers) unsubscribe();
      unsubscribeSerializers = [];
    },

    async whenCurrent() {
      while (true) {
        const current = work;
        await current;
        if (current === work) return;
      }
    },

    async logoutAndClear() {
      this.stop();
      await deps.db.transaction('rw', [
        deps.db.deviceKeys,
        deps.db.wrappedKeys,
        deps.db.records,
        deps.db.outbox,
        deps.db.revisions,
        deps.db.migration,
        deps.db.quarantine,
      ], async () => {
        await Promise.all([
          deps.db.deviceKeys.delete(deps.uid),
          deps.db.wrappedKeys.delete(deps.uid),
          deps.db.records.where('uid').equals(deps.uid).delete(),
          deps.db.outbox.where('uid').equals(deps.uid).delete(),
          deps.db.revisions.where('uid').equals(deps.uid).delete(),
          deps.db.migration.where('uid').equals(deps.uid).delete(),
          deps.db.quarantine.where('uid').equals(deps.uid).delete(),
        ]);
      });
      await withSuppressedEvents(async () => {
        for (const serializer of deps.serializers) {
          for (const record of await serializer.snapshot()) await serializer.remove(record.recordId);
        }
      });
      setStatus({ phase: 'locked', ready: false, pendingOperations: 0, lastError: null, conflict: null });
    },
  };
}
