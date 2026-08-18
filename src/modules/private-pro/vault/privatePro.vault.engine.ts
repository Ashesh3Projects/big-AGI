import { PRIVATE_PRO_VAULT_FIRESTORE_MAX_CIPHERTEXT_BYTES } from './privatePro.vault.repository';
import { decryptVaultRecord, deriveVaultSubkey, encryptVaultRecord, type PrivateProVaultContext } from './privatePro.vault.crypto';
import {
  type PrivateProVaultDB,
  type PrivateProVaultEncryptedRecord,
  type PrivateProVaultOutboxRecord,
  type PrivateProVaultRevisionRecord,
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
import { privateProVaultSession } from './privatePro.vault.session';


const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

interface StagedRecord {
  serializer: PrivateProVaultSerializer<unknown>;
  recordId: string;
  value: unknown;
  envelope: PrivateProVaultEnvelope;
}

interface DurableSnapshot {
  records: PrivateProVaultEncryptedRecord[];
  revisions: PrivateProVaultRevisionRecord[];
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
  clearSession?: () => Promise<void>;
  beforeAcknowledgeCommit?: () => Promise<void>;
  assets?: {
    referencedAssetIds(recordType: PrivateProVaultRecordType, value: unknown): readonly string[];
    prepareForUpload(assetIds: readonly string[], signal: AbortSignal): Promise<void>;
    prepareForHydrate(assetIds: readonly string[], signal: AbortSignal): Promise<void>;
    clearHydratedAssets(): Promise<void>;
  };
  persistCurrent?: (
    index: readonly PrivateProVaultIndexEntry[],
    envelopes: readonly PrivateProVaultEnvelope[],
    persist: () => Promise<void>,
  ) => Promise<void>;
}

export interface PrivateProVaultEngine {
  hydrateBeforeOpen(): Promise<void>;
  start(): Promise<void>;
  stop(): void;
  stopAndWait(): Promise<void>;
  whenCurrent(): Promise<void>;
  logoutAndClear(): Promise<void>;
}

export class PrivateProVaultRollbackError extends Error {
  constructor() {
    super('Remote encrypted vault index regression detected.');
    this.name = 'PrivateProVaultRollbackError';
  }
}

class PrivateProVaultRunCancelledError extends Error {
  constructor() {
    super('Encrypted vault run was cancelled.');
    this.name = 'PrivateProVaultRunCancelledError';
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
  let runEpoch = 0;
  let runAbortController: AbortController | null = null;
  let stopping = Promise.resolve();
  let stoppingActive = false;

  const assertCurrent = (epoch: number) => {
    if (epoch !== runEpoch) throw new PrivateProVaultRunCancelledError();
  };

  const beginRun = () => {
    runAbortController?.abort();
    runAbortController = new AbortController();
    return runAbortController.signal;
  };

  const currentSignal = (epoch: number) => {
    assertCurrent(epoch);
    if (!runAbortController) throw new PrivateProVaultRunCancelledError();
    return runAbortController.signal;
  };

  const setStatus = (epoch: number, state: Partial<Omit<PrivateProVaultState, 'setState'>>) => {
    assertCurrent(epoch);
    deps.store.getState().setState(state);
  };

  const waitCurrent = async <T>(epoch: number, promise: Promise<T>): Promise<T> => {
    const value = await promise;
    assertCurrent(epoch);
    return value;
  };

  const pendingCount = async () => deps.db.outbox.where('uid').equals(deps.uid).count();

  const refreshPending = async (epoch: number) => setStatus(epoch, { pendingOperations: await waitCurrent(epoch, pendingCount()) });

  const ensureOutboxSequences = async (epoch: number) => {
    const maximum = await waitCurrent(epoch, deps.db.backfillOutboxLocalSequences(deps.uid));
    nextLocalSequence = Math.max(nextLocalSequence ?? 1, maximum + 1);
  };

  const allocateLocalSequence = async (epoch: number) => {
    await ensureOutboxSequences(epoch);
    const sequence = nextLocalSequence ?? 1;
    nextLocalSequence = sequence + 1;
    return sequence;
  };

  const queue = (task: (epoch: number) => Promise<void>, epoch = runEpoch) => {
    const run = () => {
      assertCurrent(epoch);
      return task(epoch);
    };
    const next = work.then(run, run);
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

  const decryptAndValidate = async (epoch: number, envelope: PrivateProVaultEnvelope): Promise<StagedRecord> => {
    const serializer = serializerFor(envelope.recordType);
    if (envelope.schemaVersion !== serializer.schemaVersion)
      throw new Error('Encrypted vault record schema is unsupported.');
    const key = await waitCurrent(epoch, recordCipherKey(envelope.recordType, envelope.recordId, 'decrypt'));
    const plaintext = await waitCurrent(epoch, decryptVaultRecord(key, envelope, deps.vaultContext));
    const value = JSON.parse(textDecoder.decode(plaintext)) as unknown;
    return {
      serializer,
      recordId: envelope.recordId,
      value: await waitCurrent(epoch, serializer.validate(envelope.recordId, value)),
      envelope,
    };
  };

  const encryptPut = async (epoch: number, mutation: Extract<PrivateProPortableMutation, { kind: 'put' }>, baseRevision: number, operationId: string) => {
    const serializer = serializerFor(mutation.recordType);
    const value = await waitCurrent(epoch, serializer.validate(mutation.recordId, mutation.value));
    const key = await waitCurrent(epoch, recordCipherKey(mutation.recordType, mutation.recordId, 'encrypt'));
    const envelope = await waitCurrent(epoch, encryptVaultRecord(key, {
      ...deps.vaultContext,
      formatVersion: 1,
      recordType: mutation.recordType,
      recordId: mutation.recordId,
      schemaVersion: mutation.schemaVersion,
      keyVersion: deps.keyVersion,
      revision: baseRevision + 1,
    }, textEncoder.encode(JSON.stringify(value))));
    return {
      formatVersion: 1,
      operationId,
      kind: 'put',
      baseRevision,
      envelope,
    } satisfies PrivateProVaultOperation;
  };

  const mutationOperation = async (epoch: number, mutation: PrivateProPortableMutation, baseRevision: number, operationId: string): Promise<PrivateProVaultOperation> => {
    if (mutation.kind === 'put') return encryptPut(epoch, mutation, baseRevision, operationId);
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

  const captureRuntime = async (epoch: number) => new Map(await waitCurrent(epoch, Promise.all(deps.serializers.map(async serializer => [
    serializer.recordType,
    await serializer.snapshot(),
  ] as const))));

  const captureDurable = async (epoch: number): Promise<DurableSnapshot> => ({
    records: await waitCurrent(epoch, deps.db.records.where('uid').equals(deps.uid).toArray()),
    revisions: await waitCurrent(epoch, deps.db.revisions.where('uid').equals(deps.uid).toArray()),
  });

  const restoreRuntime = async (before: ReadonlyMap<PrivateProVaultRecordType, Array<{ recordId: string; value: unknown }>>) => {
    await withSuppressedEvents(async () => {
      for (const serializer of [...deps.serializers].reverse()) {
        for (const current of await serializer.snapshot()) await serializer.remove(current.recordId);
        for (const record of before.get(serializer.recordType) ?? []) await serializer.apply(record.recordId, record.value);
      }
    });
  };

  const restoreDurable = async (before: DurableSnapshot) => {
    await deps.db.transaction('rw', [deps.db.records, deps.db.revisions], async () => {
      await deps.db.records.where('uid').equals(deps.uid).delete();
      await deps.db.revisions.where('uid').equals(deps.uid).delete();
      if (before.records.length) await deps.db.records.bulkPut(before.records.map(record => structuredClone(record)));
      if (before.revisions.length) await deps.db.revisions.bulkPut(before.revisions.map(record => structuredClone(record)));
    });
  };

  const replaceRuntime = async (epoch: number, records: readonly StagedRecord[], before: ReadonlyMap<PrivateProVaultRecordType, Array<{ recordId: string; value: unknown }>>) => {
    try {
      if (deps.assets) {
        const assetIds = [...new Set(records.flatMap(record => deps.assets!.referencedAssetIds(record.serializer.recordType, record.value)))];
        if (assetIds.length) await waitCurrent(epoch, deps.assets.prepareForHydrate(assetIds, currentSignal(epoch)));
      }
      await withSuppressedEvents(async () => {
        for (const serializer of deps.serializers) {
          for (const current of await waitCurrent(epoch, serializer.snapshot()))
            await waitCurrent(epoch, serializer.remove(current.recordId));
          for (const record of records) {
            if (record.serializer === serializer)
              await waitCurrent(epoch, serializer.apply(record.recordId, record.value));
          }
        }
      });
    } catch (error) {
      await restoreRuntime(before);
      throw error;
    }
  };

  const assertIndexCurrent = async (epoch: number, index: readonly PrivateProVaultIndexEntry[]) => {
    const remoteByKey = new Map(index.map(entry => [recordKey(entry.recordType, entry.opaqueRecordId), entry]));
    const localRevisions = await waitCurrent(epoch, deps.db.revisions.where('uid').equals(deps.uid).toArray());
    for (const local of localRevisions) {
      const remote = remoteByKey.get(recordKey(local.recordType, local.recordId));
      if (!remote || remote.revision < local.revision) throw new PrivateProVaultRollbackError();
    }
  };

  const downloadStage = async (epoch: number, index: readonly PrivateProVaultIndexEntry[]) => {
    const cached = new Map((await waitCurrent(epoch, deps.db.listEncryptedRecords(deps.uid))).map(envelope => [
      recordKey(envelope.recordType, envelope.recordId),
      envelope,
    ]));
    const needed = index.filter(isRecordEntry).filter(entry => {
      const envelope = cached.get(recordKey(entry.recordType, entry.opaqueRecordId));
      return !envelope || envelope.revision !== entry.revision;
    });
    const downloaded = await waitCurrent(epoch, deps.transport.getRecords(needed.map(entry => entry.opaqueRecordId)));
    const downloadedByKey = new Map(downloaded.map(envelope => [recordKey(envelope.recordType, envelope.recordId), envelope]));
    const envelopes = index.filter(isRecordEntry).map(entry => {
      const key = recordKey(entry.recordType, entry.opaqueRecordId);
      const envelope = downloadedByKey.get(key) ?? cached.get(key);
      if (!envelope || envelope.revision !== entry.revision || envelope.keyVersion !== entry.keyVersion)
        throw new Error('Encrypted vault index and record payload disagree.');
      return envelope;
    });
    return {
      records: await waitCurrent(epoch, Promise.all(envelopes.map(envelope => decryptAndValidate(epoch, envelope)))),
      envelopes,
    };
  };

  const persistCurrent = async (epoch: number, index: readonly PrivateProVaultIndexEntry[], envelopes: readonly PrivateProVaultEnvelope[]) => {
    const persist = () => deps.db.transaction('rw', [deps.db.records, deps.db.revisions], async () => {
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
    await waitCurrent(epoch, deps.persistCurrent ? deps.persistCurrent(index, envelopes, persist) : persist());
  };

  const fetchCanonical = async (epoch: number, recordType: PrivateProVaultRecordType, recordId: string, expectedRevision: number) => {
    const envelopes = await waitCurrent(epoch, deps.transport.getRecords([recordId]));
    const envelope = envelopes.find(candidate => candidate.recordType === recordType && candidate.recordId === recordId);
    if (!envelope || envelope.revision !== expectedRevision)
      throw new Error('Canonical encrypted vault record is unavailable.');
    return decryptAndValidate(epoch, envelope);
  };

  const acknowledge = async (epoch: number, outbox: PrivateProVaultOutboxRecord, revision: number) => {
    const { recordType, recordId } = operationRecord(outbox.operation);
    await waitCurrent(epoch, deps.db.transaction('rw', [deps.db.outbox, deps.db.records, deps.db.revisions], async () => {
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
      await deps.beforeAcknowledgeCommit?.();
    }));
  };

  const replaceOutbox = async (epoch: number, previous: PrivateProVaultOutboxRecord, operation: PrivateProVaultOperation) => {
    await waitCurrent(epoch, deps.db.transaction('rw', deps.db.outbox, async () => {
      await deps.db.outbox.delete([deps.uid, previous.operationId]);
      await deps.db.outbox.put({
        uid: deps.uid,
        operationId: operation.operationId,
        operation,
        createdAtMs: previous.createdAtMs,
        localSequence: previous.localSequence,
      });
    }));
  };

  const resolveConflict = async (epoch: number, outbox: PrivateProVaultOutboxRecord, currentRevision: number) => {
    const { recordType, recordId } = operationRecord(outbox.operation);
    const serializer = serializerFor(recordType);
    const canonical = await fetchCanonical(epoch, recordType, recordId, currentRevision);
    await waitCurrent(epoch, withSuppressedEvents(() => serializer.apply(recordId, canonical.value)));

    if (outbox.operation.kind === 'delete') {
      if (serializer.conflictPolicy !== 'replace') {
        setStatus(epoch, { phase: 'conflict', ready: false, conflict: { recordType, recordId }, lastError: 'This encrypted record needs a conflict choice.' });
        return false;
      }
      await waitCurrent(epoch, withSuppressedEvents(() => serializer.remove(recordId)));
      const operation = await mutationOperation(epoch, { kind: 'delete', recordType, recordId, schemaVersion: serializer.schemaVersion }, currentRevision, createOperationId());
      await replaceOutbox(epoch, outbox, operation);
      return true;
    }

    const local = await decryptAndValidate(epoch, outbox.operation.envelope);
    if (serializer.conflictPolicy === 'replace') {
      await waitCurrent(epoch, withSuppressedEvents(() => serializer.apply(recordId, local.value)));
      const operation = await encryptPut(epoch, {
        kind: 'put', recordType, recordId, schemaVersion: serializer.schemaVersion, value: local.value,
      }, currentRevision, createOperationId());
      await replaceOutbox(epoch, outbox, operation);
      return true;
    }

    if (serializer.conflictPolicy === 'conflict-copy' && serializer.createConflictCopy) {
      const copy = await waitCurrent(epoch, serializer.createConflictCopy(local.value));
      const copyValue = await waitCurrent(epoch, serializer.validate(copy.recordId, copy.value));
      await waitCurrent(epoch, withSuppressedEvents(() => serializer.apply(copy.recordId, copyValue)));
      await waitCurrent(epoch, deps.db.outbox.delete([deps.uid, outbox.operationId]));
      const operationId = createOperationId();
      const operation = await encryptPut(epoch, {
        kind: 'put', recordType, recordId: copy.recordId, schemaVersion: serializer.schemaVersion, value: copyValue,
      }, 0, operationId);
      await waitCurrent(epoch, deps.db.outbox.put({
        uid: deps.uid,
        operationId,
        operation,
        createdAtMs: now(),
        localSequence: await allocateLocalSequence(epoch),
      }));
      return true;
    }

    setStatus(epoch, { phase: 'conflict', ready: false, conflict: { recordType, recordId }, lastError: 'This encrypted record needs a conflict choice.' });
    return false;
  };

  const drainOutbox = async (epoch: number) => {
    await ensureOutboxSequences(epoch);
    while (true) {
      const outbox = (await waitCurrent(epoch, deps.db.outbox.where('uid').equals(deps.uid).toArray())).sort((left, right) =>
        left.localSequence! - right.localSequence! || (left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0));
      const next = outbox[0];
      if (!next) break;
      if (next.operation.kind === 'put' && next.operation.envelope.ciphertextBytes > PRIVATE_PRO_VAULT_FIRESTORE_MAX_CIPHERTEXT_BYTES) {
        setStatus(epoch, { phase: 'chunk-required', ready: false, lastError: 'This encrypted record requires chunked sync support.' });
        break;
      }
      try {
        if (next.operation.kind === 'put' && deps.assets) {
          const local = await decryptAndValidate(epoch, next.operation.envelope);
          const assetIds = [...new Set(deps.assets.referencedAssetIds(local.serializer.recordType, local.value))];
          if (assetIds.length) await waitCurrent(epoch, deps.assets.prepareForUpload(assetIds, currentSignal(epoch)));
        }
        const result = await waitCurrent(epoch, deps.transport.write(next.operation));
        if (result.status === 'conflict') {
          if (!await resolveConflict(epoch, next, result.currentRevision)) break;
          continue;
        }
        const { recordType, recordId } = operationRecord(next.operation);
        const serializer = serializerFor(recordType);
        if (next.operation.kind === 'put') {
          const local = await decryptAndValidate(epoch, next.operation.envelope);
          await waitCurrent(epoch, withSuppressedEvents(() => serializer.apply(recordId, local.value)));
        } else {
          await waitCurrent(epoch, withSuppressedEvents(() => serializer.remove(recordId)));
        }
        await acknowledge(epoch, next, result.revision);
      } catch (error) {
        if (error instanceof PrivateProVaultRunCancelledError) throw error;
        if (error instanceof PrivateProVaultChunkRequiredError) {
          setStatus(epoch, { phase: 'chunk-required', ready: false, lastError: safeErrorMessage(error) });
        } else {
          setStatus(epoch, { phase: 'reconnecting', ready: false, lastError: safeErrorMessage(error) });
        }
        break;
      }
    }
    await refreshPending(epoch);
  };

  const stageApplyAndPersist = async (epoch: number) => {
    if (!deps.transport.isOnline()) throw new TypeError('Network unavailable.');
    const index = await waitCurrent(epoch, deps.transport.getIndex());
    await assertIndexCurrent(epoch, index);
    const stage = await downloadStage(epoch, index);
    const before = await captureRuntime(epoch);
    const durableBefore = await captureDurable(epoch);
    await replaceRuntime(epoch, stage.records, before);
    try {
      await persistCurrent(epoch, index, stage.envelopes);
    } catch (error) {
      await restoreDurable(durableBefore);
      await restoreRuntime(before);
      throw error;
    }
  };

  const reconcile = async (epoch: number, throwOnFailure: boolean) => {
    setStatus(epoch, { phase: 'hydrating', ready: false, lastError: null, conflict: null });
    try {
      await stageApplyAndPersist(epoch);
      await drainOutbox(epoch);
      const state = deps.store.getState();
      if (state.phase !== 'conflict' && state.phase !== 'chunk-required' && state.phase !== 'reconnecting')
        setStatus(epoch, { phase: 'ready', ready: true, lastError: null, conflict: null });
    } catch (error) {
      if (error instanceof PrivateProVaultRunCancelledError) throw error;
      const phase = error instanceof PrivateProVaultRollbackError
        ? 'rollback-blocked' as const
        : error instanceof TypeError
          ? 'reconnecting' as const
          : 'error' as const;
      setStatus(epoch, { phase, ready: false, lastError: safeErrorMessage(error) });
      if (throwOnFailure) throw error;
    }
  };

  const onMutation = (mutation: PrivateProPortableMutation) => {
    if (suppressLocalEvents || stopped) return;
    const epoch = runEpoch;
    void queue(async currentEpoch => {
      const revision = await waitCurrent(currentEpoch, deps.db.revisions.get([deps.uid, mutation.recordType, mutation.recordId]));
      const operationId = createOperationId();
      const operation = await mutationOperation(currentEpoch, mutation, revision?.revision ?? 0, operationId);
      await waitCurrent(currentEpoch, deps.db.outbox.put({
        uid: deps.uid,
        operationId,
        operation,
        createdAtMs: now(),
        localSequence: await allocateLocalSequence(currentEpoch),
      }));
      await refreshPending(currentEpoch);
      if (!deps.store.getState().ready || !deps.transport.isOnline()) {
        setStatus(currentEpoch, { phase: 'reconnecting', ready: false, lastError: 'Reconnect to update your encrypted vault.' });
        return;
      }
      await drainOutbox(currentEpoch);
      if (deps.store.getState().phase === 'ready') setStatus(currentEpoch, { ready: true });
    }, epoch).catch(error => {
      if (!(error instanceof PrivateProVaultRunCancelledError) && epoch === runEpoch)
        setStatus(epoch, { phase: 'error', ready: false, lastError: safeErrorMessage(error) });
    });
  };

  const invalidateRun = () => {
    runAbortController?.abort();
    runAbortController = null;
    runEpoch++;
    stopped = true;
    started = false;
    unsubscribeConnectivity?.();
    unsubscribeConnectivity = undefined;
    for (const unsubscribe of unsubscribeSerializers) unsubscribe();
    unsubscribeSerializers = [];
  };

  const beginStop = () => {
    if (stoppingActive) return stopping;
    invalidateRun();
    stoppingActive = true;
    const barrier = (async () => {
      try {
        while (true) {
          const current = work;
          await current;
          if (current === work) return;
        }
      } finally {
        stoppingActive = false;
      }
    })();
    stopping = barrier.catch(() => {});
    return barrier;
  };

  return {
    async hydrateBeforeOpen() {
      await stopping;
      stopped = false;
      const epoch = ++runEpoch;
      beginRun();
      await queue(currentEpoch => reconcile(currentEpoch, true), epoch);
    },

    async start() {
      await stopping;
      if (!started) {
        started = true;
        stopped = false;
        const epoch = ++runEpoch;
        beginRun();
        unsubscribeSerializers = deps.serializers.map(serializer => serializer.subscribe(onMutation));
        unsubscribeConnectivity = deps.transport.subscribeConnectivity(online => {
          if (epoch !== runEpoch) return;
          if (!online) {
            setStatus(epoch, { phase: 'reconnecting', ready: false, lastError: 'Reconnect to update your encrypted vault.' });
            return;
          }
          void queue(currentEpoch => reconcile(currentEpoch, false), epoch).catch(() => {});
        });
      }
      if (deps.store.getState().phase !== 'ready') {
        const epoch = runEpoch;
        await queue(currentEpoch => reconcile(currentEpoch, false), epoch);
      }
    },

    stop() {
      void beginStop().catch(() => {});
    },

    stopAndWait() {
      return beginStop();
    },

    async whenCurrent() {
      while (true) {
        const current = work;
        await current;
        if (current === work) return;
      }
    },

    async logoutAndClear() {
      await this.stopAndWait();
      await deps.assets?.clearHydratedAssets();
      await (deps.clearSession ? deps.clearSession() : privateProVaultSession.logoutAndClear(deps.uid));
      await deps.db.transaction('rw', [
        deps.db.deviceKeys,
        deps.db.wrappedKeys,
        deps.db.records,
        deps.db.outbox,
        deps.db.revisions,
        deps.db.migration,
        deps.db.quarantine,
        deps.db.hydratedAssets,
      ], async () => {
        await Promise.all([
          deps.db.deviceKeys.delete(deps.uid),
          deps.db.wrappedKeys.delete(deps.uid),
          deps.db.records.where('uid').equals(deps.uid).delete(),
          deps.db.outbox.where('uid').equals(deps.uid).delete(),
          deps.db.revisions.where('uid').equals(deps.uid).delete(),
          deps.db.migration.where('uid').equals(deps.uid).delete(),
          deps.db.quarantine.where('uid').equals(deps.uid).delete(),
          deps.db.hydratedAssets.where('uid').equals(deps.uid).delete(),
        ]);
      });
      await withSuppressedEvents(async () => {
        for (const serializer of deps.serializers) {
          for (const record of await serializer.snapshot()) await serializer.remove(record.recordId);
        }
      });
      deps.store.getState().setState({ phase: 'locked', ready: false, pendingOperations: 0, lastError: null, conflict: null });
    },
  };
}
