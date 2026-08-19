import Dexie, { type EntityTable, type Table } from 'dexie';

import { PRIVATE_PRO_SYNC_WINDOW_MS } from '../config/privatePro.config';
import type { PrivateProSyncRecordType } from './privatePro.sync.schemas';
import type { PrivateProSyncPreparedRecord } from './privatePro.sync.serializers';


export const PRIVATE_PRO_SYNC_DB_VERSION = 1;

export interface PrivateProSyncRecordIdentity {
  recordType: PrivateProSyncRecordType;
  logicalId: string;
  recordKey: string;
  projectionKey: string;
  schemaVersion: number;
}

export interface PrivateProLocalRecordState extends PrivateProSyncRecordIdentity {
  uid: string;
  payload: string;
  contentHash: string | null;
  referencedAssetIds: readonly string[];
  generation: number;
  baseRevision: number;
  deleted: boolean;
  updatedAtMs: number;
}

export interface PrivateProOutboxState extends PrivateProSyncRecordIdentity {
  uid: string;
  kind: 'put' | 'delete';
  payload: string;
  contentHash: string | null;
  referencedAssetIds: readonly string[];
  mutationId: string;
  generation: number;
  baseRevision: number;
  dueAtMs: number;
  leaseUntilMs: number | null;
  blocked: boolean;
  errorCode: string | null;
}

export interface PrivateProRemoteBaseState {
  revision: number;
  mutationId: string;
  deleted: boolean;
}

interface PrivateProRemoteBaseRecord extends PrivateProRemoteBaseState {
  uid: string;
  recordKey: string;
}

export interface PrivateProCoordinatorLease {
  uid: string;
  name: string;
  expiresAtMs: number;
  fence: number;
}

export interface PrivateProSyncQuarantineState {
  id?: number;
  uid: string;
  recordKey: string;
  reasonCode: string;
  createdAtMs: number;
}

export interface PrivateProSyncAssetState {
  uid: string;
  assetId: string;
  updatedAtMs: number;
}

export interface PrivateProSyncMetaState {
  uid: string;
  key: string;
  value: unknown;
}


function cloneOutbox(state: PrivateProOutboxState): PrivateProOutboxState {
  return { ...state, referencedAssetIds: [...state.referencedAssetIds] };
}

function cloneLocalRecord(state: PrivateProLocalRecordState): PrivateProLocalRecordState {
  return { ...state, referencedAssetIds: [...state.referencedAssetIds] };
}

function asIdentity(record: PrivateProSyncPreparedRecord): PrivateProSyncRecordIdentity {
  return {
    recordType: record.recordType,
    logicalId: record.logicalId,
    recordKey: record.recordKey,
    projectionKey: record.projectionKey,
    schemaVersion: record.schemaVersion,
  };
}


export class PrivateProSyncDB extends Dexie {
  localRecords!: Table<PrivateProLocalRecordState, [string, string]>;
  outbox!: Table<PrivateProOutboxState, [string, string]>;
  remoteBases!: Table<PrivateProRemoteBaseRecord, [string, string]>;
  quarantine!: EntityTable<PrivateProSyncQuarantineState, 'id'>;
  assets!: Table<PrivateProSyncAssetState, [string, string]>;
  leases!: Table<PrivateProCoordinatorLease, [string, string]>;
  meta!: Table<PrivateProSyncMetaState, [string, string]>;

  constructor(name = 'private-pro-workspace-v1') {
    super(name);
    this.version(PRIVATE_PRO_SYNC_DB_VERSION).stores({
      localRecords: '[uid+recordKey], uid, recordType, projectionKey, generation, contentHash',
      outbox: '[uid+recordKey], uid, dueAtMs, leaseUntilMs, blocked',
      remoteBases: '[uid+recordKey], uid, revision, mutationId, deleted',
      quarantine: '++id, uid, recordKey, createdAtMs',
      assets: '[uid+assetId], uid, assetId, updatedAtMs',
      leases: '[uid+name], uid, expiresAtMs, fence',
      meta: '[uid+key], uid',
    });
  }

  async getLocalRecord(uid: string, recordKey: string): Promise<PrivateProLocalRecordState | null> {
    const state = await this.localRecords.get([uid, recordKey]);
    return state ? cloneLocalRecord(state) : null;
  }

  async listLocalRecords(uid: string): Promise<PrivateProLocalRecordState[]> {
    return (await this.localRecords.where('uid').equals(uid).toArray()).map(cloneLocalRecord);
  }

  async getOutbox(uid: string, recordKey: string): Promise<PrivateProOutboxState | null> {
    const state = await this.outbox.get([uid, recordKey]);
    return state ? cloneOutbox(state) : null;
  }

  async getRemoteBase(uid: string, recordKey: string): Promise<PrivateProRemoteBaseState | null> {
    const state = await this.remoteBases.get([uid, recordKey]);
    return state ? { revision: state.revision, mutationId: state.mutationId, deleted: state.deleted } : null;
  }

  async recordLocalPut(uid: string, record: PrivateProSyncPreparedRecord, nowMs: number): Promise<PrivateProOutboxState> {
    return this.transaction('rw', [this.localRecords, this.outbox, this.remoteBases], async () => {
      const [previousLocal, previousOutbox, remoteBase] = await Promise.all([
        this.localRecords.get([uid, record.recordKey]),
        this.outbox.get([uid, record.recordKey]),
        this.remoteBases.get([uid, record.recordKey]),
      ]);
      const generation = (previousLocal?.generation ?? 0) + 1;
      const baseRevision = remoteBase?.revision ?? previousLocal?.baseRevision ?? 0;
      const localRecord: PrivateProLocalRecordState = {
        uid,
        ...asIdentity(record),
        payload: record.payload,
        contentHash: record.contentHash,
        referencedAssetIds: [...record.referencedAssetIds],
        generation,
        baseRevision,
        deleted: false,
        updatedAtMs: nowMs,
      };
      const outbox: PrivateProOutboxState = {
        uid,
        ...asIdentity(record),
        kind: 'put',
        payload: record.payload,
        contentHash: record.contentHash,
        referencedAssetIds: [...record.referencedAssetIds],
        mutationId: crypto.randomUUID(),
        generation,
        baseRevision,
        dueAtMs: previousOutbox?.dueAtMs ?? nowMs + PRIVATE_PRO_SYNC_WINDOW_MS,
        leaseUntilMs: previousOutbox?.leaseUntilMs ?? null,
        blocked: false,
        errorCode: null,
      };
      await Promise.all([this.localRecords.put(localRecord), this.outbox.put(outbox)]);
      return cloneOutbox(outbox);
    });
  }

  async recordLocalDelete(uid: string, identity: PrivateProSyncRecordIdentity, nowMs: number): Promise<PrivateProOutboxState> {
    return this.transaction('rw', [this.localRecords, this.outbox, this.remoteBases], async () => {
      const [previousLocal, previousOutbox, remoteBase] = await Promise.all([
        this.localRecords.get([uid, identity.recordKey]),
        this.outbox.get([uid, identity.recordKey]),
        this.remoteBases.get([uid, identity.recordKey]),
      ]);
      const generation = (previousLocal?.generation ?? 0) + 1;
      const baseRevision = remoteBase?.revision ?? previousLocal?.baseRevision ?? 0;
      const localRecord: PrivateProLocalRecordState = {
        uid,
        ...identity,
        payload: '',
        contentHash: null,
        referencedAssetIds: [],
        generation,
        baseRevision,
        deleted: true,
        updatedAtMs: nowMs,
      };
      const outbox: PrivateProOutboxState = {
        uid,
        ...identity,
        kind: 'delete',
        payload: '',
        contentHash: null,
        referencedAssetIds: [],
        mutationId: crypto.randomUUID(),
        generation,
        baseRevision,
        dueAtMs: previousOutbox?.dueAtMs ?? nowMs + PRIVATE_PRO_SYNC_WINDOW_MS,
        leaseUntilMs: previousOutbox?.leaseUntilMs ?? null,
        blocked: false,
        errorCode: null,
      };
      await Promise.all([this.localRecords.put(localRecord), this.outbox.put(outbox)]);
      return cloneOutbox(outbox);
    });
  }

  async leaseDue(uid: string, nowMs: number, leaseMs: number): Promise<PrivateProOutboxState | null> {
    return this.transaction('rw', this.outbox, async () => {
      const due = (await this.outbox.where('uid').equals(uid).toArray())
        .filter(entry => !entry.blocked && entry.dueAtMs <= nowMs && (entry.leaseUntilMs === null || entry.leaseUntilMs <= nowMs))
        .sort((left, right) => left.dueAtMs - right.dueAtMs || left.recordKey.localeCompare(right.recordKey))[0];
      if (!due) return null;
      due.leaseUntilMs = nowMs + leaseMs;
      await this.outbox.put(due);
      return cloneOutbox(due);
    });
  }

  async retry(uid: string, recordKey: string, generation: number, nowMs: number, delayMs: number, errorCode: string): Promise<void> {
    await this.transaction('rw', this.outbox, async () => {
      const pending = await this.outbox.get([uid, recordKey]);
      if (!pending || pending.generation !== generation) return;
      pending.dueAtMs = nowMs + delayMs;
      pending.leaseUntilMs = null;
      pending.errorCode = errorCode;
      await this.outbox.put(pending);
    });
  }

  async rebase(uid: string, recordKey: string, generation: number, remoteBase: PrivateProRemoteBaseState, nowMs: number): Promise<void> {
    await this.transaction('rw', [this.localRecords, this.outbox, this.remoteBases], async () => {
      await this.putRemoteBase(uid, recordKey, remoteBase);
      const [local, pending] = await Promise.all([
        this.localRecords.get([uid, recordKey]),
        this.outbox.get([uid, recordKey]),
      ]);
      if (local && local.generation === generation) {
        local.baseRevision = remoteBase.revision;
        await this.localRecords.put(local);
      }
      if (!pending || pending.generation !== generation) return;
      pending.baseRevision = remoteBase.revision;
      pending.dueAtMs = nowMs;
      pending.leaseUntilMs = null;
      pending.errorCode = null;
      await this.outbox.put(pending);
    });
  }

  async acknowledge(uid: string, recordKey: string, sentGeneration: number, remoteBase: PrivateProRemoteBaseState, sentAtMs: number): Promise<void> {
    await this.transaction('rw', [this.localRecords, this.outbox, this.remoteBases], async () => {
      await this.putRemoteBase(uid, recordKey, remoteBase);
      const [local, pending] = await Promise.all([
        this.localRecords.get([uid, recordKey]),
        this.outbox.get([uid, recordKey]),
      ]);
      if (local && local.generation >= sentGeneration) {
        local.baseRevision = remoteBase.revision;
        await this.localRecords.put(local);
      }
      if (!pending || pending.generation < sentGeneration) return;
      if (pending.generation === sentGeneration) {
        await this.outbox.delete([uid, recordKey]);
        return;
      }
      pending.baseRevision = remoteBase.revision;
      pending.dueAtMs = Math.max(pending.dueAtMs, sentAtMs + PRIVATE_PRO_SYNC_WINDOW_MS);
      pending.leaseUntilMs = null;
      pending.errorCode = null;
      await this.outbox.put(pending);
    });
  }

  async discardAcrossTombstone(uid: string, recordKey: string, remoteBase: PrivateProRemoteBaseState): Promise<void> {
    await this.transaction('rw', [this.localRecords, this.outbox, this.remoteBases], async () => {
      await this.putRemoteBase(uid, recordKey, remoteBase);
      const pending = await this.outbox.get([uid, recordKey]);
      if (!remoteBase.deleted || !pending || pending.kind !== 'put' || pending.baseRevision >= remoteBase.revision) return;
      await Promise.all([
        this.localRecords.delete([uid, recordKey]),
        this.outbox.delete([uid, recordKey]),
      ]);
    });
  }

  async acquireCoordinatorLease(uid: string, name: string, nowMs: number, leaseMs: number): Promise<PrivateProCoordinatorLease | null> {
    return this.transaction('rw', this.leases, async () => {
      const previous = await this.leases.get([uid, name]);
      if (previous && previous.expiresAtMs > nowMs) return null;
      const lease: PrivateProCoordinatorLease = {
        uid,
        name,
        expiresAtMs: nowMs + leaseMs,
        fence: (previous?.fence ?? 0) + 1,
      };
      await this.leases.put(lease);
      return { ...lease };
    });
  }

  async renewCoordinatorLease(uid: string, name: string, fence: number, nowMs: number, leaseMs: number): Promise<PrivateProCoordinatorLease | null> {
    return this.transaction('rw', this.leases, async () => {
      const lease = await this.leases.get([uid, name]);
      if (!lease || lease.fence !== fence || lease.expiresAtMs <= nowMs) return null;
      lease.expiresAtMs = nowMs + leaseMs;
      await this.leases.put(lease);
      return { ...lease };
    });
  }

  async releaseCoordinatorLease(uid: string, name: string, fence: number): Promise<void> {
    await this.transaction('rw', this.leases, async () => {
      const lease = await this.leases.get([uid, name]);
      if (!lease || lease.fence !== fence) return;
      lease.expiresAtMs = 0;
      await this.leases.put(lease);
    });
  }

  async clearUid(uid: string): Promise<void> {
    await this.transaction('rw', [this.localRecords, this.outbox, this.remoteBases, this.quarantine, this.assets, this.leases, this.meta], async () => {
      await Promise.all([
        this.localRecords.where('uid').equals(uid).delete(),
        this.outbox.where('uid').equals(uid).delete(),
        this.remoteBases.where('uid').equals(uid).delete(),
        this.quarantine.where('uid').equals(uid).delete(),
        this.assets.where('uid').equals(uid).delete(),
        this.leases.where('uid').equals(uid).delete(),
        this.meta.where('uid').equals(uid).delete(),
      ]);
    });
  }

  private async putRemoteBase(uid: string, recordKey: string, remoteBase: PrivateProRemoteBaseState): Promise<void> {
    const current = await this.remoteBases.get([uid, recordKey]);
    if (current && current.revision > remoteBase.revision) return;
    await this.remoteBases.put({ uid, recordKey, ...remoteBase });
  }
}

export const privateProSyncDB = new PrivateProSyncDB();
