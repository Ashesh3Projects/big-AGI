import Dexie, { type EntityTable, type Table } from 'dexie';

import { PRIVATE_PRO_SYNC_WINDOW_MS } from '../config/privatePro.config';
import { privateProRecordKey } from './privatePro.sync.codec';
import type { PrivateProSyncRecordType } from './privatePro.sync.schemas';
import type { PrivateProSyncPreparedRecord } from './privatePro.sync.serializers';
import type { DBlobDBAsset } from '~/modules/dblobs/dblobs.types';
import type { PrivateProAssetManifest } from '../assets/privatePro.assets.schemas';


export const PRIVATE_PRO_SYNC_DB_VERSION = 2;

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
  retryAttempt: number;
  leaseUntilMs: number | null;
  leaseToken: string | null;
  leaseFence: number | null;
  leasedGeneration: number | null;
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
  ownerToken: string;
}

export interface PrivateProAssetUploadLease {
  uid: string;
  assetId: string;
  expiresAtMs: number;
  fence: number;
  ownerToken: string;
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
  asset?: DBlobDBAsset;
  manifest?: PrivateProAssetManifest;
  contentGeneration: number;
  publishedContentGeneration?: number;
  publishedManifestHash?: string;
  uploadStatus: 'pending' | 'ready' | 'remote';
  hydrationStatus: 'pending' | 'ready' | 'missing' | 'error';
  updatedAtMs: number;
}

export interface PrivateProSyncMetaState {
  uid: string;
  key: string;
  value: unknown;
}


function cloneOutbox(state: PrivateProOutboxState): PrivateProOutboxState {
  return { ...state, retryAttempt: state.retryAttempt ?? 0, referencedAssetIds: [...state.referencedAssetIds] };
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

function clearOutboxLease(state: PrivateProOutboxState): void {
  state.leaseUntilMs = null;
  state.leaseToken = null;
  state.leaseFence = null;
  state.leasedGeneration = null;
}


export class PrivateProSyncDB extends Dexie {
  localRecords!: Table<PrivateProLocalRecordState, [string, string]>;
  outbox!: Table<PrivateProOutboxState, [string, string]>;
  remoteBases!: Table<PrivateProRemoteBaseRecord, [string, string]>;
  quarantine!: EntityTable<PrivateProSyncQuarantineState, 'id'>;
  assets!: Table<PrivateProSyncAssetState, [string, string]>;
  leases!: Table<PrivateProCoordinatorLease, [string, string]>;
  assetUploadLeases!: Table<PrivateProAssetUploadLease, [string, string]>;
  meta!: Table<PrivateProSyncMetaState, [string, string]>;

  constructor(name = 'private-pro-workspace-v1') {
    super(name);
    const storesV1 = {
      localRecords: '[uid+recordKey], uid, recordType, projectionKey, generation, contentHash',
      outbox: '[uid+recordKey], uid, dueAtMs, leaseUntilMs, blocked',
      remoteBases: '[uid+recordKey], uid, revision, mutationId, deleted',
      quarantine: '++id, uid, recordKey, createdAtMs',
      assets: '[uid+assetId], uid, assetId, updatedAtMs',
      leases: '[uid+name], uid, expiresAtMs, fence',
      meta: '[uid+key], uid',
    };
    this.version(1).stores(storesV1);
    this.version(PRIVATE_PRO_SYNC_DB_VERSION).stores({
      ...storesV1,
      assetUploadLeases: '[uid+assetId], uid, expiresAtMs, fence',
    });
  }

  async getLocalRecord(uid: string, recordKey: string): Promise<PrivateProLocalRecordState | null> {
    const state = await this.localRecords.get([uid, recordKey]);
    return state ? cloneLocalRecord(state) : null;
  }

  async listLocalRecords(uid: string): Promise<PrivateProLocalRecordState[]> {
    return (await this.localRecords.where('uid').equals(uid).toArray()).map(cloneLocalRecord);
  }

  async listProjectionRecords(uid: string, projectionKey: string): Promise<PrivateProLocalRecordState[]> {
    return (await this.localRecords.where('uid').equals(uid).filter(record => record.projectionKey === projectionKey && !record.deleted).toArray())
      .map(cloneLocalRecord);
  }

  async pendingCount(uid: string): Promise<number> {
    return this.outbox.where('uid').equals(uid).count();
  }

  async quarantineRemote(uid: string, recordKey: string, reasonCode: string, nowMs: number): Promise<void> {
    await this.quarantine.add({ uid, recordKey, reasonCode, createdAtMs: nowMs });
  }

  async observeRemoteBase(uid: string, recordKey: string, remoteBase: PrivateProRemoteBaseState): Promise<PrivateProRemoteBaseState> {
    return this.transaction('rw', this.remoteBases, () => this.storeEffectiveRemoteBase(uid, recordKey, remoteBase));
  }

  async setEffectiveRemoteBase(uid: string, recordKey: string, remoteBase: PrivateProRemoteBaseState): Promise<PrivateProRemoteBaseState> {
    return this.transaction('rw', [this.localRecords, this.outbox, this.remoteBases], async () => {
      const effective = await this.storeEffectiveRemoteBase(uid, recordKey, remoteBase);
      const [local, pending] = await Promise.all([
        this.localRecords.get([uid, recordKey]),
        this.outbox.get([uid, recordKey]),
      ]);
      if (local && local.baseRevision < effective.revision) {
        local.baseRevision = effective.revision;
        await this.localRecords.put(local);
      }
      if (pending && pending.baseRevision < effective.revision) {
        pending.baseRevision = effective.revision;
        await this.outbox.put(pending);
      }
      return effective;
    });
  }

  async commitRemoteRecord(uid: string, record: PrivateProSyncPreparedRecord, remoteBase: PrivateProRemoteBaseState, nowMs: number): Promise<PrivateProRemoteBaseState> {
    return this.transaction('rw', [this.localRecords, this.outbox, this.remoteBases], async () => {
      const effective = await this.storeEffectiveRemoteBase(uid, record.recordKey, remoteBase);
      if (effective.revision !== remoteBase.revision || effective.deleted) return effective;
      const [local, pending] = await Promise.all([
        this.localRecords.get([uid, record.recordKey]),
        this.outbox.get([uid, record.recordKey]),
      ]);
      if (pending) {
        if (local && local.baseRevision < effective.revision) {
          local.baseRevision = effective.revision;
          await this.localRecords.put(local);
        }
        if (pending.baseRevision < effective.revision) {
          pending.baseRevision = effective.revision;
          await this.outbox.put(pending);
        }
        return effective;
      }
      await this.localRecords.put({
        uid,
        ...asIdentity(record),
        payload: record.payload,
        contentHash: record.contentHash,
        referencedAssetIds: [...record.referencedAssetIds],
        generation: local?.generation ?? 0,
        baseRevision: effective.revision,
        deleted: false,
        updatedAtMs: nowMs,
      });
      return effective;
    });
  }

  async commitRemoteTombstone(uid: string, identity: PrivateProSyncRecordIdentity, remoteBase: PrivateProRemoteBaseState, nowMs: number): Promise<PrivateProRemoteBaseState> {
    return this.transaction('rw', [this.localRecords, this.outbox, this.remoteBases], async () => {
      const effective = await this.storeEffectiveRemoteBase(uid, identity.recordKey, remoteBase);
      if (effective.revision !== remoteBase.revision || !effective.deleted) return effective;
      const [local, pending] = await Promise.all([
        this.localRecords.get([uid, identity.recordKey]),
        this.outbox.get([uid, identity.recordKey]),
      ]);
      if (pending) {
        if (pending.baseRevision >= effective.revision) {
          if (local && local.baseRevision < effective.revision) {
            local.baseRevision = effective.revision;
            await this.localRecords.put(local);
          }
        } else {
          await this.localRecords.put({
            uid,
            ...identity,
            payload: '',
            contentHash: null,
            referencedAssetIds: [],
            generation: local?.generation ?? 0,
            baseRevision: effective.revision,
            deleted: true,
            updatedAtMs: nowMs,
          });
        }
        return effective;
      }
      await this.localRecords.put({
        uid,
        ...identity,
        payload: '',
        contentHash: null,
        referencedAssetIds: [],
        generation: local?.generation ?? 0,
        baseRevision: effective.revision,
        deleted: true,
        updatedAtMs: nowMs,
      });
      return effective;
    });
  }

  async getOutbox(uid: string, recordKey: string): Promise<PrivateProOutboxState | null> {
    const state = await this.outbox.get([uid, recordKey]);
    return state ? cloneOutbox(state) : null;
  }

  async getRemoteBase(uid: string, recordKey: string): Promise<PrivateProRemoteBaseState | null> {
    const state = await this.remoteBases.get([uid, recordKey]);
    return state ? { revision: state.revision, mutationId: state.mutationId, deleted: state.deleted } : null;
  }

  async nextDueAt(uid: string): Promise<number | null> {
    const due = (await this.outbox.where('uid').equals(uid).toArray())
      .filter(entry => !entry.blocked)
      .reduce<number | null>((earliest, entry) => {
        const schedulableAt = entry.leaseUntilMs === null ? entry.dueAtMs : Math.max(entry.dueAtMs, entry.leaseUntilMs);
        return earliest === null ? schedulableAt : Math.min(earliest, schedulableAt);
      }, null);
    return due;
  }

  async expedite(uid: string, nowMs: number): Promise<void> {
    await this.transaction('rw', this.outbox, async () => {
      const pending = await this.outbox.where('uid').equals(uid).toArray();
      await Promise.all(pending.filter(entry => !entry.blocked).map(entry => {
        entry.dueAtMs = Math.min(entry.dueAtMs, nowMs);
        return this.outbox.put(entry);
      }));
    });
  }

  async recordLocalPut(uid: string, record: PrivateProSyncPreparedRecord, nowMs: number): Promise<PrivateProOutboxState> {
    return this.transaction('rw', [this.localRecords, this.outbox, this.remoteBases, this.meta], async () => {
      const [previousLocal, previousOutbox, remoteBase] = await Promise.all([
        this.localRecords.get([uid, record.recordKey]),
        this.outbox.get([uid, record.recordKey]),
        this.remoteBases.get([uid, record.recordKey]),
      ]);
      const generation = await this.nextGeneration(uid, record.recordKey);
      const baseRevision = remoteBase?.revision ?? previousLocal?.baseRevision ?? 0;
      const startsPostLeaseGeneration = previousOutbox?.leasedGeneration !== null
        && previousOutbox?.leasedGeneration !== undefined
        && previousOutbox.generation === previousOutbox.leasedGeneration;
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
        dueAtMs: startsPostLeaseGeneration ? nowMs + PRIVATE_PRO_SYNC_WINDOW_MS : previousOutbox?.dueAtMs ?? nowMs + PRIVATE_PRO_SYNC_WINDOW_MS,
        retryAttempt: 0,
        leaseUntilMs: previousOutbox?.leaseUntilMs ?? null,
        leaseToken: previousOutbox?.leaseToken ?? null,
        leaseFence: previousOutbox?.leaseFence ?? null,
        leasedGeneration: previousOutbox?.leasedGeneration ?? null,
        blocked: false,
        errorCode: null,
      };
      await Promise.all([this.localRecords.put(localRecord), this.outbox.put(outbox)]);
      return cloneOutbox(outbox);
    });
  }

  async recordLocalDelete(uid: string, identity: PrivateProSyncRecordIdentity, nowMs: number): Promise<PrivateProOutboxState> {
    return this.transaction('rw', [this.localRecords, this.outbox, this.remoteBases, this.meta], async () => {
      const [previousLocal, previousOutbox, remoteBase] = await Promise.all([
        this.localRecords.get([uid, identity.recordKey]),
        this.outbox.get([uid, identity.recordKey]),
        this.remoteBases.get([uid, identity.recordKey]),
      ]);
      const generation = await this.nextGeneration(uid, identity.recordKey);
      const baseRevision = remoteBase?.revision ?? previousLocal?.baseRevision ?? 0;
      const startsPostLeaseGeneration = previousOutbox?.leasedGeneration !== null
        && previousOutbox?.leasedGeneration !== undefined
        && previousOutbox.generation === previousOutbox.leasedGeneration;
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
        dueAtMs: startsPostLeaseGeneration ? nowMs + PRIVATE_PRO_SYNC_WINDOW_MS : previousOutbox?.dueAtMs ?? nowMs + PRIVATE_PRO_SYNC_WINDOW_MS,
        retryAttempt: 0,
        leaseUntilMs: previousOutbox?.leaseUntilMs ?? null,
        leaseToken: previousOutbox?.leaseToken ?? null,
        leaseFence: previousOutbox?.leaseFence ?? null,
        leasedGeneration: previousOutbox?.leasedGeneration ?? null,
        blocked: false,
        errorCode: null,
      };
      await Promise.all([this.localRecords.put(localRecord), this.outbox.put(outbox)]);
      return cloneOutbox(outbox);
    });
  }

  async leaseDue(uid: string, nowMs: number, leaseMs: number, coordinatorFence: number): Promise<PrivateProOutboxState | null> {
    return this.transaction('rw', this.outbox, async () => {
      const due = (await this.outbox.where('uid').equals(uid).toArray())
        .filter(entry => !entry.blocked && entry.dueAtMs <= nowMs && (entry.leaseUntilMs === null || entry.leaseUntilMs <= nowMs))
        .sort((left, right) => Number(right.recordType === 'asset') - Number(left.recordType === 'asset') || left.dueAtMs - right.dueAtMs || left.recordKey.localeCompare(right.recordKey))[0];
      if (!due) return null;
      due.leaseUntilMs = nowMs + leaseMs;
      due.leaseToken = crypto.randomUUID();
      due.leaseFence = coordinatorFence;
      due.leasedGeneration = due.generation;
      await this.outbox.put(due);
      return cloneOutbox(due);
    });
  }

  async referencedAssetsReady(uid: string, assetIds: readonly string[]): Promise<boolean> {
    if (!assetIds.length) return true;
    return (await Promise.all([...new Set(assetIds)].map(async assetId => {
      const recordKey = privateProRecordKey('asset', assetId);
      const [asset, local, pending, base] = await Promise.all([
        this.assets.get([uid, assetId]), this.localRecords.get([uid, recordKey]), this.outbox.get([uid, recordKey]), this.remoteBases.get([uid, recordKey]),
      ]);
      return !!asset?.manifest && asset.publishedContentGeneration === asset.contentGeneration && !!asset.publishedManifestHash &&
        !pending && !!local && !local.deleted && local.contentHash === asset.publishedManifestHash && local.baseRevision > 0 &&
        !!base && !base.deleted && base.revision === local.baseRevision;
    }))).every(Boolean);
  }

  async deferLease(uid: string, recordKey: string, generation: number, leaseToken: string, leaseFence: number, dueAtMs: number): Promise<void> {
    await this.transaction('rw', this.outbox, async () => {
      const pending = await this.outbox.get([uid, recordKey]);
      if (!this.matchesOutboxLease(pending, generation, leaseToken, leaseFence)) return;
      pending.dueAtMs = Math.max(pending.dueAtMs, dueAtMs);
      clearOutboxLease(pending);
      await this.outbox.put(pending);
    });
  }

  async retry(uid: string, recordKey: string, generation: number, leaseToken: string, leaseFence: number, nowMs: number, delayMs: number, errorCode: string): Promise<void> {
    await this.transaction('rw', this.outbox, async () => {
      const pending = await this.outbox.get([uid, recordKey]);
      if (!this.matchesOutboxLease(pending, generation, leaseToken, leaseFence)) return;
      if (pending.generation !== generation) {
        clearOutboxLease(pending);
        await this.outbox.put(pending);
        return;
      }
      pending.dueAtMs = nowMs + delayMs;
      pending.retryAttempt = (pending.retryAttempt ?? 0) + 1;
      clearOutboxLease(pending);
      pending.errorCode = errorCode;
      await this.outbox.put(pending);
    });
  }

  async releaseLease(uid: string, recordKey: string, generation: number, leaseToken: string, leaseFence: number): Promise<void> {
    await this.transaction('rw', this.outbox, async () => {
      const pending = await this.outbox.get([uid, recordKey]);
      if (!this.matchesOutboxLease(pending, generation, leaseToken, leaseFence)) return;
      clearOutboxLease(pending);
      await this.outbox.put(pending);
    });
  }

  async block(uid: string, recordKey: string, generation: number, leaseToken: string, leaseFence: number, errorCode: string): Promise<boolean> {
    return this.transaction('rw', this.outbox, async () => {
      const pending = await this.outbox.get([uid, recordKey]);
      if (!this.matchesOutboxLease(pending, generation, leaseToken, leaseFence)) return false;
      if (pending.generation !== generation) {
        clearOutboxLease(pending);
        await this.outbox.put(pending);
        return false;
      }
      clearOutboxLease(pending);
      pending.blocked = true;
      pending.errorCode = errorCode;
      await this.outbox.put(pending);
      return true;
    });
  }

  async quarantineLeased(uid: string, recordKey: string, generation: number, leaseToken: string, leaseFence: number, reasonCode: string, nowMs: number): Promise<boolean> {
    return this.transaction('rw', [this.outbox, this.quarantine], async () => {
      const pending = await this.outbox.get([uid, recordKey]);
      if (!this.matchesOutboxLease(pending, generation, leaseToken, leaseFence)) return false;
      if (pending.generation !== generation) {
        clearOutboxLease(pending);
        await this.outbox.put(pending);
        return false;
      }
      clearOutboxLease(pending);
      pending.blocked = true;
      pending.errorCode = reasonCode;
      await Promise.all([
        this.outbox.put(pending),
        this.quarantine.add({ uid, recordKey, reasonCode, createdAtMs: nowMs }),
      ]);
      return true;
    });
  }

  async rebase(uid: string, recordKey: string, generation: number, leaseToken: string, leaseFence: number, remoteBase: PrivateProRemoteBaseState, nowMs: number, delayMs = 0): Promise<void> {
    await this.transaction('rw', [this.localRecords, this.outbox, this.remoteBases], async () => {
      const [local, pending] = await Promise.all([
        this.localRecords.get([uid, recordKey]),
        this.outbox.get([uid, recordKey]),
      ]);
      if (!this.matchesOutboxLease(pending, generation, leaseToken, leaseFence)) return;
      if (pending.generation !== generation) {
        clearOutboxLease(pending);
        await this.outbox.put(pending);
        return;
      }
      const effectiveBase = await this.storeEffectiveRemoteBase(uid, recordKey, remoteBase);
      if (local && local.generation >= generation) {
        local.baseRevision = effectiveBase.revision;
        await this.localRecords.put(local);
      }
      pending.baseRevision = effectiveBase.revision;
      pending.dueAtMs = nowMs + delayMs;
      pending.retryAttempt = (pending.retryAttempt ?? 0) + 1;
      clearOutboxLease(pending);
      pending.errorCode = null;
      await this.outbox.put(pending);
    });
  }

  async acknowledge(uid: string, recordKey: string, sentGeneration: number, leaseToken: string, leaseFence: number, remoteBase: PrivateProRemoteBaseState, sentAtMs: number): Promise<void> {
    await this.transaction('rw', [this.localRecords, this.outbox, this.remoteBases], async () => {
      const [local, pending] = await Promise.all([
        this.localRecords.get([uid, recordKey]),
        this.outbox.get([uid, recordKey]),
      ]);
      if (!this.matchesOutboxLease(pending, sentGeneration, leaseToken, leaseFence)) return;
      const effectiveBase = await this.storeEffectiveRemoteBase(uid, recordKey, remoteBase);
      if (local && local.generation >= sentGeneration) {
        local.baseRevision = effectiveBase.revision;
        await this.localRecords.put(local);
      }
      if (pending.generation === sentGeneration) {
        await this.outbox.delete([uid, recordKey]);
        return;
      }
      pending.baseRevision = effectiveBase.revision;
      if (pending.dueAtMs <= sentAtMs) pending.dueAtMs = sentAtMs + PRIVATE_PRO_SYNC_WINDOW_MS;
      clearOutboxLease(pending);
      pending.errorCode = null;
      await this.outbox.put(pending);
    });
  }

  async discardAcrossTombstone(uid: string, recordKey: string, remoteBase: PrivateProRemoteBaseState): Promise<void> {
    await this.transaction('rw', [this.localRecords, this.outbox, this.remoteBases], async () => {
      const effectiveBase = await this.storeEffectiveRemoteBase(uid, recordKey, remoteBase);
      const pending = await this.outbox.get([uid, recordKey]);
      if (!effectiveBase.deleted || !pending || pending.kind !== 'put' || pending.baseRevision >= effectiveBase.revision) return;
      await Promise.all([
        this.localRecords.delete([uid, recordKey]),
        this.outbox.delete([uid, recordKey]),
      ]);
    });
  }

  async discardLeasedAcrossTombstone(uid: string, recordKey: string, generation: number, leaseToken: string, leaseFence: number, remoteBase: PrivateProRemoteBaseState): Promise<void> {
    await this.transaction('rw', [this.localRecords, this.outbox, this.remoteBases], async () => {
      const pending = await this.outbox.get([uid, recordKey]);
      if (!this.matchesOutboxLease(pending, generation, leaseToken, leaseFence)) return;
      if (pending.generation !== generation) {
        clearOutboxLease(pending);
        await this.outbox.put(pending);
        return;
      }
      if (!remoteBase.deleted || pending.kind !== 'put' || pending.baseRevision >= remoteBase.revision) {
        clearOutboxLease(pending);
        await this.outbox.put(pending);
        return;
      }
      await this.storeEffectiveRemoteBase(uid, recordKey, remoteBase);
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
        ownerToken: crypto.randomUUID(),
      };
      await this.leases.put(lease);
      return { ...lease };
    });
  }

  async renewCoordinatorLease(uid: string, name: string, fence: number, ownerToken: string, nowMs: number, leaseMs: number): Promise<PrivateProCoordinatorLease | null> {
    return this.transaction('rw', this.leases, async () => {
      const lease = await this.leases.get([uid, name]);
      if (!lease || lease.fence !== fence || lease.ownerToken !== ownerToken || lease.expiresAtMs <= nowMs) return null;
      lease.expiresAtMs = nowMs + leaseMs;
      await this.leases.put(lease);
      return { ...lease };
    });
  }

  async releaseCoordinatorLease(uid: string, name: string, fence: number, ownerToken: string): Promise<void> {
    await this.transaction('rw', this.leases, async () => {
      const lease = await this.leases.get([uid, name]);
      if (!lease || lease.fence !== fence || lease.ownerToken !== ownerToken) return;
      lease.expiresAtMs = 0;
      lease.ownerToken = crypto.randomUUID();
      await this.leases.put(lease);
    });
  }

  async acquireAssetUploadLease(uid: string, assetId: string, nowMs: number, leaseMs: number): Promise<PrivateProAssetUploadLease | null> {
    return this.transaction('rw', this.assetUploadLeases, async () => {
      const previous = await this.assetUploadLeases.get([uid, assetId]);
      if (previous && previous.expiresAtMs > nowMs) return null;
      const lease: PrivateProAssetUploadLease = {
        uid,
        assetId,
        expiresAtMs: nowMs + leaseMs,
        fence: (previous?.fence ?? 0) + 1,
        ownerToken: crypto.randomUUID(),
      };
      await this.assetUploadLeases.put(lease);
      return { ...lease };
    });
  }

  async renewAssetUploadLease(uid: string, assetId: string, fence: number, ownerToken: string, nowMs: number, leaseMs: number): Promise<PrivateProAssetUploadLease | null> {
    return this.transaction('rw', this.assetUploadLeases, async () => {
      const lease = await this.assetUploadLeases.get([uid, assetId]);
      if (!lease || lease.fence !== fence || lease.ownerToken !== ownerToken || lease.expiresAtMs <= nowMs) return null;
      lease.expiresAtMs = nowMs + leaseMs;
      await this.assetUploadLeases.put(lease);
      return { ...lease };
    });
  }

  async releaseAssetUploadLease(uid: string, assetId: string, fence: number, ownerToken: string): Promise<void> {
    await this.transaction('rw', this.assetUploadLeases, async () => {
      const lease = await this.assetUploadLeases.get([uid, assetId]);
      if (!lease || lease.fence !== fence || lease.ownerToken !== ownerToken) return;
      lease.expiresAtMs = 0;
      lease.ownerToken = crypto.randomUUID();
      await this.assetUploadLeases.put(lease);
    });
  }

  async clearUid(uid: string): Promise<void> {
    await this.transaction('rw', [this.localRecords, this.outbox, this.remoteBases, this.quarantine, this.assets, this.leases, this.assetUploadLeases, this.meta], async () => {
      await Promise.all([
        this.localRecords.where('uid').equals(uid).delete(),
        this.outbox.where('uid').equals(uid).delete(),
        this.remoteBases.where('uid').equals(uid).delete(),
        this.quarantine.where('uid').equals(uid).delete(),
        this.assets.where('uid').equals(uid).delete(),
        this.meta.where('uid').equals(uid).delete(),
      ]);
      const leases = await this.leases.where('uid').equals(uid).toArray();
      const assetUploadLeases = await this.assetUploadLeases.where('uid').equals(uid).toArray();
      await Promise.all([
        ...leases.map(lease => this.leases.put({ ...lease, expiresAtMs: 0, ownerToken: crypto.randomUUID() })),
        ...assetUploadLeases.map(lease => this.assetUploadLeases.put({ ...lease, expiresAtMs: 0, ownerToken: crypto.randomUUID() })),
      ]);
    });
  }

  private matchesOutboxLease(pending: PrivateProOutboxState | undefined, generation: number, leaseToken: string, leaseFence: number): pending is PrivateProOutboxState {
    return !!pending
      && pending.leasedGeneration === generation
      && pending.leaseToken === leaseToken
      && pending.leaseFence === leaseFence;
  }

  private async nextGeneration(uid: string, recordKey: string): Promise<number> {
    const key = `generation:${recordKey}`;
    const previous = await this.meta.get([uid, key]);
    const generation = typeof previous?.value === 'number' ? previous.value + 1 : 1;
    await this.meta.put({ uid, key, value: generation });
    return generation;
  }

  private async storeEffectiveRemoteBase(uid: string, recordKey: string, remoteBase: PrivateProRemoteBaseState): Promise<PrivateProRemoteBaseState> {
    const current = await this.remoteBases.get([uid, recordKey]);
    if (current && current.revision > remoteBase.revision)
      return { revision: current.revision, mutationId: current.mutationId, deleted: current.deleted };
    if (current && current.revision === remoteBase.revision) {
      if (current.mutationId !== remoteBase.mutationId || current.deleted !== remoteBase.deleted)
        throw new Error('Conflicting Private Pro sync remote base identity at the same revision.');
      return { revision: current.revision, mutationId: current.mutationId, deleted: current.deleted };
    }
    await this.remoteBases.put({ uid, recordKey, ...remoteBase });
    return { ...remoteBase };
  }
}

export const privateProSyncDB = new PrivateProSyncDB();
