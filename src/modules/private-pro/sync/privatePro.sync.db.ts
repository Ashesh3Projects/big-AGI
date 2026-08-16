import Dexie, { type EntityTable, type Table } from 'dexie';

import type { PrivateProEntityType } from './privatePro.sync.repository';


export type PrivateProOperationKind = 'upsert' | 'delete';

export interface PrivateProVaultBindingRecord {
  key: 'vault';
  uid: string;
  boundAtMs: number;
}

export interface PrivateProOutboxOperation {
  id?: number;
  dedupeKey: string;
  uid: string;
  entityType: PrivateProEntityType;
  entityId: string;
  kind: PrivateProOperationKind;
  baseRevision: number;
  contentHash: string;
  payload: unknown;
  deviceId: string;
  createdAtMs: number;
  availableAtMs: number;
  leaseUntilMs: number;
  attempts: number;
  blocked?: boolean;
  lastError?: string;
}

export interface PrivateProEntityState {
  uid: string;
  entityKey: string;
  entityType: PrivateProEntityType;
  entityId: string;
  remoteRevision: number;
  localHash: string;
  remoteHash: string | null;
  updatedAtMs: number;
}

export interface PrivateProMigrationItem {
  uid: string;
  entityKey: string;
  entityType: PrivateProEntityType;
  entityId: string;
  status: 'pending' | 'complete' | 'blocked';
  updatedAtMs: number;
  error?: string;
}

export interface PrivateProQuarantineRecord {
  id?: number;
  uid: string;
  entityKey: string;
  reason: string;
  payload: unknown;
  createdAtMs: number;
}

export type PrivateProBindResult =
  | { status: 'bound'; uid: string }
  | { status: 'already-bound'; uid: string }
  | { status: 'binding-conflict'; uid: string };


export class PrivateProSyncDB extends Dexie {
  bindings!: EntityTable<PrivateProVaultBindingRecord, 'key'>;
  outbox!: EntityTable<PrivateProOutboxOperation, 'id'>;
  entities!: Table<PrivateProEntityState, [string, string]>;
  migrations!: Table<PrivateProMigrationItem, [string, string]>;
  quarantine!: EntityTable<PrivateProQuarantineRecord, 'id'>;

  constructor(name = 'private-pro-sync-v1') {
    super(name);
    this.version(1).stores({
      bindings: '&key, uid',
      outbox: '++id, &dedupeKey, [uid+availableAtMs], leaseUntilMs',
      entities: '[uid+entityKey], uid, entityType, entityId, remoteRevision, localHash',
      migrations: '[uid+entityKey], uid, status, updatedAtMs',
      quarantine: '++id, uid, entityKey, createdAtMs',
    });
  }

  async bindVault(uid: string, nowMs = Date.now()): Promise<PrivateProBindResult> {
    return this.transaction('rw', this.bindings, async () => {
      const existing = await this.bindings.get('vault');
      if (!existing) {
        await this.bindings.add({ key: 'vault', uid, boundAtMs: nowMs });
        return { status: 'bound', uid };
      }
      return existing.uid === uid
        ? { status: 'already-bound', uid }
        : { status: 'binding-conflict', uid: existing.uid };
    });
  }

  async resetVaultBinding(): Promise<void> {
    await this.transaction('rw', [this.bindings, this.outbox, this.entities, this.migrations, this.quarantine], async () => {
      await Promise.all([
        this.bindings.clear(),
        this.outbox.clear(),
        this.entities.clear(),
        this.migrations.clear(),
        this.quarantine.clear(),
      ]);
    });
  }

  async enqueueOperation(input: Omit<PrivateProOutboxOperation, 'id' | 'dedupeKey' | 'availableAtMs' | 'leaseUntilMs' | 'attempts'>): Promise<number> {
    const dedupeKey = [input.uid, input.entityType, input.entityId, input.kind, input.contentHash].join(':');
    return this.transaction('rw', this.outbox, async () => {
      const existing = await this.outbox.where('dedupeKey').equals(dedupeKey).first();
      if (existing?.id !== undefined) return existing.id;
      const id = await this.outbox.add({
        ...structuredClone(input),
        dedupeKey,
        availableAtMs: input.createdAtMs,
        leaseUntilMs: 0,
        attempts: 0,
      });
      if (id === undefined) throw new Error('Failed to allocate a private sync operation ID.');
      return id;
    });
  }

  async leaseNextOperation(uid: string, nowMs: number, leaseMs: number): Promise<PrivateProOutboxOperation | null> {
    return this.transaction('rw', this.outbox, async () => {
      const candidates = await this.outbox.where('[uid+availableAtMs]').between(
        [uid, Dexie.minKey],
        [uid, nowMs],
        true,
        true,
      ).sortBy('availableAtMs');
      const candidate = candidates.find(operation => !operation.blocked && operation.leaseUntilMs <= nowMs);
      if (!candidate?.id) return null;
      const leaseUntilMs = nowMs + leaseMs;
      await this.outbox.update(candidate.id, { leaseUntilMs });
      return { ...candidate, leaseUntilMs };
    });
  }

  async retryOperation(id: number, error: string, nowMs: number, delayMs: number): Promise<void> {
    await this.transaction('rw', this.outbox, async () => {
      const operation = await this.outbox.get(id);
      if (!operation) return;
      await this.outbox.update(id, {
        attempts: operation.attempts + 1,
        availableAtMs: nowMs + delayMs,
        leaseUntilMs: 0,
        lastError: error,
      });
    });
  }

  async blockOperation(id: number, error: string): Promise<void> {
    await this.transaction('rw', this.outbox, async () => {
      const operation = await this.outbox.get(id);
      if (!operation) return;
      await this.outbox.update(id, {
        attempts: operation.attempts + 1,
        blocked: true,
        leaseUntilMs: 0,
        lastError: error,
      });
    });
  }

  async ackOperation(id: number, entity: PrivateProEntityState): Promise<void> {
    await this.transaction('rw', [this.outbox, this.entities], async () => {
      await this.entities.put(structuredClone(entity));
      await this.outbox.delete(id);
    });
  }

  getOutboxOperation(id: number): Promise<PrivateProOutboxOperation | undefined> {
    return this.outbox.get(id);
  }

  outboxCount(uid: string): Promise<number> {
    return this.outbox.where('uid').equals(uid).count();
  }

  async makeOperationsDue(uid: string, nowMs: number): Promise<void> {
    await this.outbox.where('uid').equals(uid).modify({ availableAtMs: nowMs, leaseUntilMs: 0, blocked: false });
  }

  async discardOperation(id: number): Promise<void> {
    await this.outbox.delete(id);
  }

  async discardOperationsForEntity(
    uid: string,
    entityType: PrivateProEntityType,
    entityId: string,
    preserve?: Pick<PrivateProOutboxOperation, 'kind' | 'contentHash'>,
  ): Promise<void> {
    const operations = await this.outbox.where('uid').equals(uid).filter(operation =>
      operation.entityType === entityType &&
      operation.entityId === entityId &&
      (!preserve || operation.kind !== preserve.kind || operation.contentHash !== preserve.contentHash)
    ).primaryKeys();
    await this.outbox.bulkDelete(operations);
  }

  getEntityState(uid: string, entityKey: string): Promise<PrivateProEntityState | undefined> {
    return this.entities.get([uid, entityKey]);
  }

  listEntityStates(uid: string): Promise<PrivateProEntityState[]> {
    return this.entities.where('uid').equals(uid).toArray();
  }

  async putEntityState(entity: PrivateProEntityState): Promise<void> {
    await this.entities.put(structuredClone(entity));
  }

  async recordMigrationItem(item: Omit<PrivateProMigrationItem, 'entityKey'>): Promise<void> {
    await this.migrations.put({ ...structuredClone(item), entityKey: `${item.entityType}:${item.entityId}` });
  }

  getMigrationItem(uid: string, entityKey: string): Promise<PrivateProMigrationItem | undefined> {
    return this.migrations.get([uid, entityKey]);
  }

  async quarantineRemoteRecord(record: Omit<PrivateProQuarantineRecord, 'id'>): Promise<number> {
    const id = await this.quarantine.add(structuredClone(record));
    if (id === undefined) throw new Error('Failed to allocate a quarantine record ID.');
    return id;
  }

  listQuarantine(uid: string): Promise<PrivateProQuarantineRecord[]> {
    return this.quarantine.where('uid').equals(uid).toArray();
  }
}

export const privateProSyncDB = new PrivateProSyncDB();
