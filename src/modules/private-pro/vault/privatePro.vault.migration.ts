import { decryptVaultRecord, deriveVaultSubkey, encryptVaultRecord, hmacVaultIdentifier } from './privatePro.vault.crypto';
import type { PrivateProVaultDB, PrivateProVaultMigrationRecord } from './privatePro.vault.db';
import type { PrivateProVaultSerializer } from './privatePro.vault.serializers';
import type { PrivateProVaultEnvelope, PrivateProVaultOperation, PrivateProVaultRecordType } from './privatePro.vault.types';
import type { PrivateProLegacyMigrationTransport } from '../sync/privatePro.sync.engine';
import type { SyncConversation, SyncPersona } from '../sync/privatePro.sync.schemas';


export const PRIVATE_PRO_VAULT_MIGRATION_PHASES = [
  'inventory',
  'encrypt-local',
  'upload',
  'verify-cloud',
  'commit',
  'cleanup-local',
  'cleanup-cloud',
  'complete',
] as const;

export type PrivateProVaultMigrationPhase = typeof PRIVATE_PRO_VAULT_MIGRATION_PHASES[number];
export type PrivateProVaultMigrationSource = 'local' | 'cloud';

export interface PrivateProVaultMigrationLegacyItem {
  source: PrivateProVaultMigrationSource;
  sourceId: string;
  sourceVersion: string;
  recordType: PrivateProVaultRecordType;
  recordId: string;
  schemaVersion: number;
  value: unknown;
  assetIds?: string[];
}

export interface PrivateProVaultMigrationAssetDescriptor {
  assetId: string;
  plaintextBytes: number;
  contentSha256: string;
  manifestSha256: string;
}

export interface PrivateProVaultEncryptedExportBinding {
  migrationId: string;
  inventoryDigest: string;
}

export interface PrivateProVaultEncryptedExportConfirmation extends PrivateProVaultEncryptedExportBinding {
  exportDigest: string;
}

export interface PrivateProVaultMigrationProgress {
  phase: PrivateProVaultMigrationPhase;
  revision: number;
  completedItems: number;
  totalItems: number;
  error: string | null;
}

export interface PrivateProVaultMigrationInventoryPort {
  listLocal(signal: AbortSignal): Promise<PrivateProVaultMigrationLegacyItem[]>;
  listCloud(signal: AbortSignal): Promise<PrivateProVaultMigrationLegacyItem[]>;
  currentVersion(item: PrivateProVaultMigrationLegacyItem, signal: AbortSignal): Promise<string | null>;
}

export interface PrivateProVaultMigrationRecordPort {
  upload(operation: PrivateProVaultOperation, signal: AbortSignal): Promise<{
    status: 'committed' | 'unchanged';
    revision: number;
  } | {
    status: 'conflict';
    currentRevision: number;
  }>;
  download(recordIds: readonly string[], signal: AbortSignal): Promise<PrivateProVaultEnvelope[]>;
}

export interface PrivateProVaultMigrationAssetPort {
  describe(assetIds: readonly string[], signal: AbortSignal): Promise<PrivateProVaultMigrationAssetDescriptor[]>;
  prepareForUpload(assetIds: readonly string[], signal: AbortSignal): Promise<void>;
  verifyCloud(assets: readonly PrivateProVaultMigrationAssetDescriptor[], signal: AbortSignal): Promise<void>;
  deleteLocal?(asset: PrivateProVaultMigrationAssetDescriptor, signal: AbortSignal): Promise<void>;
}

export interface PrivateProVaultMigrationServerPort {
  commit(input: {
    operationId: string;
    migrationId: string;
    basePhase: PrivateProVaultMigrationPhase | null;
    phase: PrivateProVaultMigrationPhase;
  }, signal: AbortSignal): Promise<{
    status: 'committed' | 'unchanged';
    phase: PrivateProVaultMigrationPhase;
  } | {
    status: 'conflict';
    currentPhase: PrivateProVaultMigrationPhase | null;
  }>;
}

export interface PrivateProVaultMigrationCleanupPort {
  local(item: PrivateProVaultMigrationLegacyItem, operationId: string, signal: AbortSignal): Promise<void>;
  cloud(item: PrivateProVaultMigrationLegacyItem, operationId: string, signal: AbortSignal): Promise<void>;
}

export interface PrivateProVaultMigrationDependencies {
  uid: string;
  migrationId: string;
  keyVersion: number;
  masterKey: CryptoKey;
  db: PrivateProVaultDB;
  serializers: readonly PrivateProVaultSerializer<unknown>[];
  inventory: PrivateProVaultMigrationInventoryPort;
  records: PrivateProVaultMigrationRecordPort;
  assets: PrivateProVaultMigrationAssetPort;
  server: PrivateProVaultMigrationServerPort;
  exportGate?: {
    getConfirmation(binding: PrivateProVaultEncryptedExportBinding): Promise<PrivateProVaultEncryptedExportConfirmation | null>;
  };
  cleanup: PrivateProVaultMigrationCleanupPort;
  collectAssetIds(recordType: PrivateProVaultRecordType, value: unknown): readonly string[];
  createOperationId(purpose: string): string;
  afterEffect?(point: 'upload' | 'verify-cloud' | 'commit' | 'cleanup-local' | 'cleanup-cloud' | 'complete'): Promise<void>;
  now?: () => number;
}

export interface PrivateProVaultMigration {
  getProgress(): PrivateProVaultMigrationProgress;
  subscribe(listener: (progress: PrivateProVaultMigrationProgress) => void): () => void;
  run(): Promise<void>;
  getEncryptedExportBinding(): Promise<PrivateProVaultEncryptedExportBinding>;
  registerEncryptedExport(confirmation: PrivateProVaultEncryptedExportConfirmation): Promise<void>;
  confirmEncryptedExport(confirmation: PrivateProVaultEncryptedExportConfirmation): Promise<void>;
  stop(): void;
  stopAndWait(): Promise<void>;
}

export interface PrivateProVaultMigrationLifecycle {
  start(): Promise<void>;
  retry(): Promise<void>;
  stop(): void;
  stopAndWait(): Promise<void>;
}

export function createPrivateProVaultLegacyCloudInventoryPort(input: {
  transport: PrivateProLegacyMigrationTransport;
  serializers: readonly PrivateProVaultSerializer<unknown>[];
  recordId(recordType: 'chat' | 'persona', logicalId: string): Promise<string>;
}): Pick<PrivateProVaultMigrationInventoryPort, 'listCloud' | 'currentVersion'> & {
  cleanupCloud(item: PrivateProVaultMigrationLegacyItem, operationId: string, signal: AbortSignal): Promise<void>;
} {
  const serializers = new Map(input.serializers.map(serializer => [serializer.recordType, serializer]));
  const sourceItems = new Map<string, Awaited<ReturnType<PrivateProLegacyMigrationTransport['listForMigration']>>[number]>();
  const serializerFor = (recordType: 'chat' | 'persona') => {
    const serializer = serializers.get(recordType);
    if (!serializer) throw new Error('Legacy migration serializer is unavailable.');
    return serializer;
  };
  const valueFor = (item: Awaited<ReturnType<PrivateProLegacyMigrationTransport['listForMigration']>>[number]) => {
    if (item.entity.entityType === 'chat') return item.entity.payload as SyncConversation;
    return item.entity.payload as SyncPersona;
  };
  const logicalId = (value: SyncConversation | SyncPersona) => 'conversation' in value ? value.conversation.id : value.persona.id;
  return {
    async listCloud(signal) {
      const items = await input.transport.listForMigration(signal);
      return Promise.all(items.map(async item => {
        const value = valueFor(item);
        const serializer = serializerFor(item.entity.entityType);
        const recordId = await input.recordId(item.entity.entityType, logicalId(value));
        const sourceId = `${item.entity.entityType}:${item.entity.entityId}`;
        sourceItems.set(sourceId, structuredClone(item));
        return {
          source: 'cloud' as const,
          sourceId,
          sourceVersion: item.sourceVersion,
          recordType: item.entity.entityType,
          recordId,
          schemaVersion: serializer.schemaVersion,
          value,
          assetIds: [...(item.entity.assetIds ?? [])],
        };
      }));
    },
    currentVersion: (item, signal) => input.transport.currentVersion(item.recordType as 'chat' | 'persona', item.sourceId.slice(item.sourceId.indexOf(':') + 1), signal),
    async cleanupCloud(item, operationId, signal) {
      const source = sourceItems.get(item.sourceId);
      if (!source) throw new Error('Legacy migration cleanup is not authorized for this frozen item.');
      await input.transport.cleanupMigrationItem(source, operationId, signal);
    },
  };
}

export function createPrivateProVaultLocalMigrationPort(input: {
  serializers: readonly PrivateProVaultSerializer<unknown>[];
  collectAssetIds(recordType: PrivateProVaultRecordType, value: unknown): readonly string[];
}): Pick<PrivateProVaultMigrationInventoryPort, 'listLocal' | 'currentVersion'> & {
  cleanupLocal(item: PrivateProVaultMigrationLegacyItem, signal: AbortSignal): Promise<void>;
} {
  const serializers = new Map(input.serializers.map(serializer => [serializer.recordType, serializer]));
  const version = async (value: unknown) => {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', textEncoder.encode(canonicalJson(value))));
    return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
  };
  const serializerFor = (recordType: PrivateProVaultRecordType) => {
    const serializer = serializers.get(recordType);
    if (!serializer) throw new Error('Local migration serializer is unavailable.');
    return serializer;
  };

  return {
    async listLocal(signal) {
      const items: PrivateProVaultMigrationLegacyItem[] = [];
      for (const serializer of input.serializers) {
        for (const record of await serializer.snapshot()) {
          assertNotAborted(signal);
          const value = await serializer.validate(record.recordId, record.value);
          items.push({
            source: 'local',
            sourceId: `${serializer.recordType}:${record.recordId}`,
            sourceVersion: await version(value),
            recordType: serializer.recordType,
            recordId: record.recordId,
            schemaVersion: serializer.schemaVersion,
            value,
            assetIds: [...new Set(input.collectAssetIds(serializer.recordType, value))],
          });
        }
      }
      return items;
    },
    async currentVersion(item, signal) {
      assertNotAborted(signal);
      const record = (await serializerFor(item.recordType).snapshot()).find(candidate => candidate.recordId === item.recordId);
      return record ? version(await serializerFor(item.recordType).validate(record.recordId, record.value)) : null;
    },
    async cleanupLocal(item, signal) {
      assertNotAborted(signal);
      await serializerFor(item.recordType).remove(item.recordId);
    },
  };
}

interface FrozenItem extends PrivateProVaultMigrationLegacyItem {
  opaqueItemId: string;
  cleanupOperationId?: string;
}

interface FrozenRecord {
  recordType: PrivateProVaultRecordType;
  recordId: string;
  schemaVersion: number;
  value: unknown;
  assetIds: string[];
  sourceItemIds: string[];
  envelope?: PrivateProVaultEnvelope;
  uploadOperationId?: string;
  uploadStatus?: 'pending' | 'complete';
  verified?: boolean;
}

interface FrozenAsset extends PrivateProVaultMigrationAssetDescriptor {
  sourceItemIds: string[];
  verified?: boolean;
  cleanupOperationId?: string;
}

interface MigrationState {
  formatVersion: 1;
  items: FrozenItem[];
  records: FrozenRecord[];
  assets: FrozenAsset[];
  inventoryDigest: string;
  localCleaned: string[];
  cloudCleaned: string[];
  localPending?: string;
  cloudPending?: string;
  localAssetsCleaned: string[];
  localAssetPending?: string;
  verified: boolean;
  exportConfirmation?: PrivateProVaultEncryptedExportConfirmation;
  pendingExportConfirmation?: PrivateProVaultEncryptedExportConfirmation;
  serverCommitted: boolean;
  commitStatus?: 'pending' | 'complete';
  completeStatus?: 'pending' | 'complete';
  commitOperationId?: string;
  completeOperationId?: string;
}

class PrivateProVaultMigrationCancelledError extends Error {
  constructor() {
    super('Encrypted vault migration was cancelled.');
    this.name = 'PrivateProVaultMigrationCancelledError';
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const phaseIndex = new Map(PRIVATE_PRO_VAULT_MIGRATION_PHASES.map((phase, index) => [phase, index]));

function isPhase(value: string): value is PrivateProVaultMigrationPhase {
  return phaseIndex.has(value as PrivateProVaultMigrationPhase);
}

function nextPhase(phase: PrivateProVaultMigrationPhase): PrivateProVaultMigrationPhase | null {
  const index = phaseIndex.get(phase)!;
  return PRIVATE_PRO_VAULT_MIGRATION_PHASES[index + 1] ?? null;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(',')}}`;
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = Uint8Array.from(typeof value === 'string' ? textEncoder.encode(value) : value);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function itemKey(item: Pick<PrivateProVaultMigrationLegacyItem, 'source' | 'sourceId'>): string {
  return `${item.source}\u0000${item.sourceId}`;
}

function validateAssetDescriptor(asset: PrivateProVaultMigrationAssetDescriptor): void {
  if (!asset.assetId || !Number.isSafeInteger(asset.plaintextBytes) || asset.plaintextBytes < 0
    || !/^[a-f0-9]{64}$/.test(asset.contentSha256) || !/^[a-f0-9]{64}$/.test(asset.manifestSha256))
    throw new Error('Migration asset descriptor is invalid.');
}

const inventoryDigest = (items: readonly FrozenItem[], assets: readonly FrozenAsset[]) => sha256Hex(canonicalJson({
  items: [...items].sort((left, right) => itemKey(left).localeCompare(itemKey(right))).map(item => ({
    source: item.source,
    sourceId: item.sourceId,
    sourceVersion: item.sourceVersion,
    recordType: item.recordType,
    recordId: item.recordId,
    schemaVersion: item.schemaVersion,
    assetIds: [...(item.assetIds ?? [])].sort(),
  })),
  assets: [...assets].sort((left, right) => left.assetId.localeCompare(right.assetId)).map(asset => ({
    assetId: asset.assetId,
    plaintextBytes: asset.plaintextBytes,
    contentSha256: asset.contentSha256,
    manifestSha256: asset.manifestSha256,
    sourceItemIds: [...asset.sourceItemIds].sort(),
  })),
}));

function recordKey(recordType: PrivateProVaultRecordType, recordId: string): string {
  return `${recordType}\u0000${recordId}`;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new PrivateProVaultMigrationCancelledError();
}

function emptyState(): MigrationState {
  return {
    formatVersion: 1,
    items: [],
    records: [],
    assets: [],
    inventoryDigest: '',
    localCleaned: [],
    cloudCleaned: [],
    localAssetsCleaned: [],
    verified: false,
    serverCommitted: false,
  };
}

function safeErrorCode(error: unknown): string {
  if (error instanceof PrivateProVaultMigrationCancelledError) return 'cancelled';
  if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
  return 'migration-failed';
}

function assertState(value: unknown): MigrationState {
  if (!value || typeof value !== 'object') throw new Error('Encrypted migration journal is invalid.');
  const state = value as MigrationState;
  if (state.formatVersion !== 1 || !Array.isArray(state.items) || !Array.isArray(state.records) || !Array.isArray(state.assets))
    throw new Error('Encrypted migration journal is invalid.');
  return structuredClone(state);
}

export function createPrivateProVaultMigration(deps: PrivateProVaultMigrationDependencies): PrivateProVaultMigration {
  const now = deps.now ?? Date.now;
  const serializers = new Map(deps.serializers.map(serializer => [serializer.recordType, serializer]));
  const listeners = new Set<(progress: PrivateProVaultMigrationProgress) => void>();
  let progress: PrivateProVaultMigrationProgress = {
    phase: 'inventory', revision: 0, completedItems: 0, totalItems: 0, error: null,
  };
  let abortController: AbortController | null = null;
  let running: Promise<void> | null = null;
  let journalRecordIdPromise: Promise<string> | null = null;
  let runEpoch = 0;

  const assertRun = (epoch: number, signal: AbortSignal) => {
    if (epoch !== runEpoch || signal.aborted) throw new PrivateProVaultMigrationCancelledError();
  };

  const journalRecordId = () => journalRecordIdPromise ??= (async () => {
    const key = await deriveVaultSubkey(deps.masterKey, 'migration-identifiers', deps.migrationId, ['sign']);
    return hmacVaultIdentifier(key, 'migration-journal', deps.migrationId);
  })();

  const stateKey = async (usage: 'encrypt' | 'decrypt') => deriveVaultSubkey(
    deps.masterKey,
    'migration-journal',
    deps.migrationId,
    [usage],
  );

  const emit = (patch: Partial<PrivateProVaultMigrationProgress>, epoch?: number) => {
    if (epoch !== undefined && epoch !== runEpoch) return;
    progress = { ...progress, ...patch };
    for (const listener of listeners) listener({ ...progress });
  };

  const encryptState = async (state: MigrationState, revision: number) => encryptVaultRecord(
    await stateKey('encrypt'),
    {
      vaultId: deps.uid,
      formatVersion: 1,
      recordType: 'asset-manifest',
      recordId: await journalRecordId(),
      schemaVersion: 1,
      keyVersion: deps.keyVersion,
      revision,
    },
    textEncoder.encode(canonicalJson(state)),
  );

  const decryptState = async (record: PrivateProVaultMigrationRecord): Promise<MigrationState> => {
    if (!record.encryptedState) return emptyState();
    const plaintext = await decryptVaultRecord(await stateKey('decrypt'), record.encryptedState, { vaultId: deps.uid });
    try {
      return assertState(JSON.parse(textDecoder.decode(plaintext)) as unknown);
    } finally {
      plaintext.fill(0);
    }
  };

  const save = async (
    current: PrivateProVaultMigrationRecord | null,
    phase: PrivateProVaultMigrationPhase,
    state: MigrationState,
    operationIds: string[],
    encryptedError?: PrivateProVaultEnvelope,
  ): Promise<PrivateProVaultMigrationRecord> => {
    const expectedRevision = current?.revision ?? 0;
    const revision = expectedRevision + 1;
    const encryptedState = await encryptState(state, revision);
    const next: PrivateProVaultMigrationRecord = {
      uid: deps.uid,
      migrationId: deps.migrationId,
      phase,
      revision,
      totalItems: state.items.length,
      completedItems: state.localCleaned.length + state.cloudCleaned.length,
      operationIds: [...new Set(operationIds)],
      updatedAtMs: now(),
      encryptedState,
      ...(encryptedError ? { encryptedError } : {}),
    };
    await deps.db.transaction('rw', deps.db.migration, async () => {
      const stored = await deps.db.migration.get([deps.uid, deps.migrationId]);
      if ((stored?.revision ?? 0) !== expectedRevision)
        throw new Error('Encrypted migration journal changed on another run.');
      await deps.db.migration.put(next);
    });
    return next;
  };

  const load = async () => {
    const record = await deps.db.migration.get([deps.uid, deps.migrationId]) ?? null;
    if (!record) return { record: null, state: emptyState(), operationIds: [] as string[] };
    if (!isPhase(record.phase)) throw new Error('Encrypted migration journal phase is invalid.');
    return {
      record,
      state: await decryptState(record),
      operationIds: [...(record.operationIds ?? [])],
    };
  };

  const serializerFor = (recordType: PrivateProVaultRecordType) => {
    const serializer = serializers.get(recordType);
    if (!serializer) throw new Error('Encrypted migration serializer is unavailable.');
    return serializer;
  };

  const freezeInventory = async (signal: AbortSignal): Promise<MigrationState> => {
    const listed = [
      ...await deps.inventory.listLocal(signal),
      ...await deps.inventory.listCloud(signal),
    ];
    assertNotAborted(signal);
    const itemIdentifierKey = await deriveVaultSubkey(deps.masterKey, 'migration-identifiers', deps.migrationId, ['sign']);
    const items: FrozenItem[] = [];
    const records = new Map<string, FrozenRecord>();
    for (const item of listed) {
      assertNotAborted(signal);
      const serializer = serializerFor(item.recordType);
      if (item.schemaVersion !== serializer.schemaVersion)
        throw new Error('Legacy migration schema is unsupported.');
      const value = await serializer.validate(item.recordId, item.value);
      const key = recordKey(item.recordType, item.recordId);
      const opaqueItemId = await hmacVaultIdentifier(itemIdentifierKey, 'migration-item', `${item.source}\u0000${item.sourceId}\u0000${item.sourceVersion}`);
      const assetIds = [...new Set([...(item.assetIds ?? []), ...deps.collectAssetIds(item.recordType, value)])].sort();
      const existing = records.get(key);
      if (existing && canonicalJson(existing.value) !== canonicalJson(value))
        throw new Error('Legacy local and cloud records conflict before migration.');
      if (existing) {
        existing.sourceItemIds.push(opaqueItemId);
        existing.assetIds = [...new Set([...existing.assetIds, ...assetIds])].sort();
      } else {
        records.set(key, {
          recordType: item.recordType,
          recordId: item.recordId,
          schemaVersion: item.schemaVersion,
          value,
          assetIds,
          sourceItemIds: [opaqueItemId],
        });
      }
      items.push({ ...structuredClone(item), value, assetIds, opaqueItemId });
    }
    const assetIds = [...new Set([...records.values()].flatMap(record => record.assetIds))];
    const described = await deps.assets.describe(assetIds, signal);
    const descriptors = new Map(described.map(asset => {
      validateAssetDescriptor(asset);
      return [asset.assetId, asset] as const;
    }));
    if (descriptors.size !== assetIds.length || assetIds.some(assetId => !descriptors.has(assetId)))
      throw new Error('Migration asset inventory is incomplete.');
    const frozenAssets: FrozenAsset[] = assetIds.map(assetId => ({
      ...structuredClone(descriptors.get(assetId)!),
      sourceItemIds: items.filter(item => item.assetIds?.includes(assetId)).map(item => item.opaqueItemId),
    }));
    const state = { ...emptyState(), items, records: [...records.values()], assets: frozenAssets };
    state.inventoryDigest = await inventoryDigest(items, frozenAssets);
    return state;
  };

  const assertInventoryCurrent = async (state: MigrationState, signal: AbortSignal) => {
    const currentItems = [
      ...await deps.inventory.listLocal(signal),
      ...await deps.inventory.listCloud(signal),
    ];
    assertNotAborted(signal);
    const frozenByKey = new Map(state.items.map(item => [itemKey(item), item]));
    const currentByKey = new Map(currentItems.map(item => [itemKey(item), item]));
    if ([...currentByKey.keys()].some(key => !frozenByKey.has(key)) || [...frozenByKey].some(([key, item]) => {
      const current = currentByKey.get(key);
      const allowedMissing = item.source === 'local'
        ? state.localCleaned.includes(item.opaqueItemId) || state.localPending === item.opaqueItemId
        : state.cloudCleaned.includes(item.opaqueItemId) || state.cloudPending === item.opaqueItemId;
      return (!current && !allowedMissing) || (!!current && (current.sourceVersion !== item.sourceVersion || current.recordType !== item.recordType
        || current.recordId !== item.recordId || current.schemaVersion !== item.schemaVersion
        || canonicalJson([...(current.assetIds ?? [])].sort()) !== canonicalJson([...(item.assetIds ?? [])].sort())));
    })) throw new Error('Plaintext source inventory changed after migration inventory.');
    const currentAssets = await deps.assets.describe(state.assets.map(asset => asset.assetId), signal);
    const currentAssetById = new Map(currentAssets.map(asset => [asset.assetId, asset]));
    if (state.assets.some(asset => {
      const current = currentAssetById.get(asset.assetId);
      const allowedMissing = state.localAssetsCleaned.includes(asset.assetId) || state.localAssetPending === asset.assetId;
      return (!current && !allowedMissing) || (!!current && (current.plaintextBytes !== asset.plaintextBytes || current.contentSha256 !== asset.contentSha256
        || current.manifestSha256 !== asset.manifestSha256));
    })) throw new Error('Migration asset inventory changed after inventory.');
    if (await inventoryDigest(state.items, state.assets) !== state.inventoryDigest)
      throw new Error('Encrypted migration inventory digest is invalid.');
  };

  const encryptRecords = async (state: MigrationState, signal: AbortSignal) => {
    for (const record of state.records) {
      assertNotAborted(signal);
      if (record.envelope) continue;
      const key = await deriveVaultSubkey(deps.masterKey, 'record-encryption', `${record.recordType}:${record.recordId}`, ['encrypt']);
      record.envelope = await encryptVaultRecord(key, {
        vaultId: deps.uid,
        formatVersion: 1,
        recordType: record.recordType,
        recordId: record.recordId,
        schemaVersion: record.schemaVersion,
        keyVersion: deps.keyVersion,
        revision: 1,
      }, textEncoder.encode(JSON.stringify(record.value)));
      await deps.db.putEncryptedRecord(deps.uid, record.envelope);
    }
  };

  type Checkpoint = () => Promise<void>;
  const uploadRecords = async (state: MigrationState, operationIds: string[], signal: AbortSignal, checkpoint: Checkpoint) => {
    const allAssets = [...new Set(state.records.flatMap(record => record.assetIds))];
    await deps.assets.prepareForUpload(allAssets, signal);
    assertNotAborted(signal);
    for (const record of state.records) {
      assertNotAborted(signal);
      if (record.uploadStatus === 'complete') continue;
      if (!record.envelope) throw new Error('Encrypted migration record is missing.');
      record.uploadOperationId ??= deps.createOperationId(`upload-${record.recordId}`);
      if (!operationIds.includes(record.uploadOperationId)) operationIds.push(record.uploadOperationId);
      record.uploadStatus = 'pending';
      await checkpoint();
      const result = await deps.records.upload({
        formatVersion: 1,
        operationId: record.uploadOperationId,
        kind: 'put',
        baseRevision: 0,
        envelope: record.envelope,
      }, signal);
      if (result.status === 'conflict')
        throw new Error('Encrypted migration upload conflicts with existing cloud data.');
      if (result.revision !== 1) throw new Error('Encrypted migration upload returned an invalid revision.');
      await deps.afterEffect?.('upload');
      record.uploadStatus = 'complete';
      await checkpoint();
    }
  };

  const verifySourceVersions = async (state: MigrationState, signal: AbortSignal) => {
    for (const item of state.items) {
      assertNotAborted(signal);
      if (await deps.inventory.currentVersion(item, signal) !== item.sourceVersion)
        throw new Error('A plaintext source changed after inventory. Restart migration to include the edit.');
    }
  };

  const verifyCloud = async (state: MigrationState, signal: AbortSignal, checkpoint: Checkpoint) => {
    for (const record of state.records) {
      if (record.verified) continue;
      const envelopes = await deps.records.download([record.recordId], signal);
      const envelope = envelopes.find(candidate => candidate.recordType === record.recordType && candidate.recordId === record.recordId);
      if (!envelope || envelope.revision !== 1 || envelope.keyVersion !== deps.keyVersion)
        throw new Error('Encrypted migration cloud verification is incomplete.');
      const key = await deriveVaultSubkey(deps.masterKey, 'record-encryption', `${record.recordType}:${record.recordId}`, ['decrypt']);
      const plaintext = await decryptVaultRecord(key, envelope, { vaultId: deps.uid });
      try {
        const value = await serializerFor(record.recordType).validate(record.recordId, JSON.parse(textDecoder.decode(plaintext)) as unknown);
        if (canonicalJson(value) !== canonicalJson(record.value))
          throw new Error('Encrypted migration cloud state differs from the frozen portable state.');
      } finally {
        plaintext.fill(0);
      }
      await deps.afterEffect?.('verify-cloud');
      record.verified = true;
      await checkpoint();
    }
    for (const asset of state.assets) {
      if (asset.verified) continue;
      await deps.assets.verifyCloud([asset], signal);
      await deps.afterEffect?.('verify-cloud');
      asset.verified = true;
      await checkpoint();
    }
    await verifySourceVersions(state, signal);
    state.verified = true;
    await checkpoint();
  };

  const commitServer = async (state: MigrationState, operationIds: string[], signal: AbortSignal, checkpoint: Checkpoint) => {
    if (!state.verified) throw new Error('Encrypted migration must be verified before commit.');
    await verifySourceVersions(state, signal);
    await assertInventoryCurrent(state, signal);
    const binding = { migrationId: deps.migrationId, inventoryDigest: state.inventoryDigest };
    const externalConfirmation = await deps.exportGate?.getConfirmation(binding) ?? null;
    if (externalConfirmation) state.exportConfirmation = externalConfirmation;
    if (!state.exportConfirmation || state.exportConfirmation.migrationId !== binding.migrationId
      || state.exportConfirmation.inventoryDigest !== binding.inventoryDigest
      || !/^[a-f0-9]{64}$/.test(state.exportConfirmation.exportDigest))
      throw new Error('Create the encrypted export and explicitly confirm it before plaintext cleanup.');
    const operationId = state.commitOperationId ??= deps.createOperationId('commit');
    if (!operationIds.includes(operationId)) operationIds.push(operationId);
    state.commitStatus = 'pending';
    await checkpoint();
    const result = await deps.server.commit({
      operationId,
      migrationId: deps.migrationId,
      basePhase: null,
      phase: 'commit',
    }, signal);
    if (result.status === 'conflict' && result.currentPhase !== 'commit' && result.currentPhase !== 'complete')
      throw new Error('Encrypted migration server journal conflicts with this run.');
    await deps.afterEffect?.('commit');
    state.serverCommitted = true;
    state.commitStatus = 'complete';
    await checkpoint();
  };

  const cleanup = async (
    source: PrivateProVaultMigrationSource,
    state: MigrationState,
    signal: AbortSignal,
    operationIds: string[],
    checkpoint: Checkpoint,
  ) => {
    if (!state.verified || !state.exportConfirmation || !state.serverCommitted)
      throw new Error('Encrypted migration cleanup gates are incomplete.');
    await assertInventoryCurrent(state, signal);
    const cleaned = source === 'local' ? state.localCleaned : state.cloudCleaned;
    for (const item of state.items.filter(candidate => candidate.source === source)) {
      assertNotAborted(signal);
      if (cleaned.includes(item.opaqueItemId)) continue;
      const currentVersion = await deps.inventory.currentVersion(item, signal);
      const pending = source === 'local' ? state.localPending === item.opaqueItemId : state.cloudPending === item.opaqueItemId;
      if (currentVersion !== item.sourceVersion && !(pending && currentVersion === null))
        throw new Error('A plaintext source changed after inventory. Cleanup was blocked.');
      item.cleanupOperationId ??= deps.createOperationId(`cleanup-${source}-${item.opaqueItemId}`);
      if (!operationIds.includes(item.cleanupOperationId)) operationIds.push(item.cleanupOperationId);
      if (source === 'local') state.localPending = item.opaqueItemId;
      else state.cloudPending = item.opaqueItemId;
      await checkpoint();
      await deps.cleanup[source](item, item.cleanupOperationId, signal);
      await deps.afterEffect?.(source === 'local' ? 'cleanup-local' : 'cleanup-cloud');
      cleaned.push(item.opaqueItemId);
      if (source === 'local') state.localPending = undefined;
      else state.cloudPending = undefined;
      await checkpoint();
    }
    if (source === 'local' && deps.assets.deleteLocal) {
      const localItemIds = new Set(state.items.filter(item => item.source === 'local').map(item => item.opaqueItemId));
      for (const asset of state.assets.filter(candidate => candidate.sourceItemIds.some(itemId => localItemIds.has(itemId)))) {
        if (state.localAssetsCleaned.includes(asset.assetId)) continue;
        asset.cleanupOperationId ??= deps.createOperationId(`cleanup-local-asset-${asset.assetId}`);
        if (!operationIds.includes(asset.cleanupOperationId)) operationIds.push(asset.cleanupOperationId);
        state.localAssetPending = asset.assetId;
        await checkpoint();
        await deps.assets.deleteLocal(asset, signal);
        await deps.afterEffect?.('cleanup-local');
        state.localAssetsCleaned.push(asset.assetId);
        state.localAssetPending = undefined;
        await checkpoint();
      }
    }
  };

  const markComplete = async (state: MigrationState, operationIds: string[], signal: AbortSignal, checkpoint: Checkpoint) => {
    const operationId = state.completeOperationId ??= deps.createOperationId('complete');
    if (!operationIds.includes(operationId)) operationIds.push(operationId);
    state.completeStatus = 'pending';
    await checkpoint();
    const result = await deps.server.commit({
      operationId,
      migrationId: deps.migrationId,
      basePhase: 'commit',
      phase: 'complete',
    }, signal);
    if (result.status === 'conflict' && result.currentPhase !== 'complete')
      throw new Error('Encrypted migration completion conflicts with the server journal.');
    await deps.afterEffect?.('complete');
    state.serverCommitted = true;
    state.completeStatus = 'complete';
    await checkpoint();
  };

  const execute = async (epoch: number) => {
    abortController = new AbortController();
    const signal = abortController.signal;
    const restored = await load();
    if (restored.record?.phase === 'complete') {
      emit({ phase: 'complete', revision: restored.record!.revision ?? 0, completedItems: restored.state.items.length, totalItems: restored.state.items.length, error: null });
      return;
    }
    let record = restored.record ?? await save(null, 'inventory', restored.state, restored.operationIds);
    const loaded = { state: restored.state, operationIds: restored.operationIds };
    const checkpoint = async () => {
      assertRun(epoch, signal);
      record = await save(record, record.phase as PrivateProVaultMigrationPhase, loaded.state, loaded.operationIds);
      assertRun(epoch, signal);
    };
    while (true) {
      const phase = record.phase as PrivateProVaultMigrationPhase;
      emit({
        phase,
        revision: record.revision ?? 0,
        completedItems: record.completedItems ?? 0,
        totalItems: record.totalItems ?? loaded.state.items.length,
        error: null,
      }, epoch);
      assertRun(epoch, signal);
      try {
        switch (phase) {
          case 'inventory': loaded.state = await freezeInventory(signal); break;
          case 'encrypt-local': await encryptRecords(loaded.state, signal); break;
          case 'upload': await uploadRecords(loaded.state, loaded.operationIds, signal, checkpoint); break;
          case 'verify-cloud': await verifyCloud(loaded.state, signal, checkpoint); break;
          case 'commit': await commitServer(loaded.state, loaded.operationIds, signal, checkpoint); break;
          case 'cleanup-local': await cleanup('local', loaded.state, signal, loaded.operationIds, checkpoint); break;
          case 'cleanup-cloud':
            await cleanup('cloud', loaded.state, signal, loaded.operationIds, checkpoint);
            await markComplete(loaded.state, loaded.operationIds, signal, checkpoint);
            break;
          case 'complete':
            return;
        }
        assertRun(epoch, signal);
        const following = nextPhase(phase);
        if (!following) return;
        record = await save(record, following, loaded.state, loaded.operationIds);
      } catch (error) {
        if (error instanceof PrivateProVaultMigrationCancelledError || signal.aborted)
          throw new PrivateProVaultMigrationCancelledError();
        const revision = (record.revision ?? 0) + 1;
        const encryptedError = await encryptVaultRecord(await stateKey('encrypt'), {
          vaultId: deps.uid,
          formatVersion: 1,
          recordType: 'asset-manifest',
          recordId: await journalRecordId(),
          schemaVersion: 1,
          keyVersion: deps.keyVersion,
          revision,
        }, textEncoder.encode(canonicalJson({ formatVersion: 1, code: safeErrorCode(error), phase })));
        record = await save(record, phase, loaded.state, loaded.operationIds, encryptedError);
        emit({ revision: record.revision ?? 0, error: 'Encrypted vault migration needs attention.' }, epoch);
        throw error;
      }
    }
  };

  return {
    getProgress: () => ({ ...progress }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    run() {
      if (running) return running;
      const epoch = ++runEpoch;
      running = execute(epoch).finally(() => {
        running = null;
        abortController = null;
      });
      return running;
    },
    async getEncryptedExportBinding() {
      const loaded = await load();
      if (!loaded.record || !loaded.state.inventoryDigest) throw new Error('Encrypted migration inventory has not completed.');
      return { migrationId: deps.migrationId, inventoryDigest: loaded.state.inventoryDigest };
    },
    async registerEncryptedExport(confirmation) {
      if (running) throw new Error('Wait for the current migration attempt before registering the export.');
      const loaded = await load();
      if (!loaded.record || confirmation.migrationId !== deps.migrationId || confirmation.inventoryDigest !== loaded.state.inventoryDigest
        || !/^[a-f0-9]{64}$/.test(confirmation.exportDigest))
        throw new Error('Encrypted export binding or digest is invalid.');
      loaded.state.pendingExportConfirmation = structuredClone(confirmation);
      loaded.state.exportConfirmation = undefined;
      await save(loaded.record, loaded.record.phase as PrivateProVaultMigrationPhase, loaded.state, loaded.operationIds);
    },
    async confirmEncryptedExport(confirmation) {
      if (running) throw new Error('Wait for the current migration attempt before confirming the export.');
      const loaded = await load();
      if (!loaded.record) throw new Error('Encrypted migration inventory has not started.');
      if (confirmation.migrationId !== deps.migrationId || confirmation.inventoryDigest !== loaded.state.inventoryDigest
        || !/^[a-f0-9]{64}$/.test(confirmation.exportDigest)
        || canonicalJson(confirmation) !== canonicalJson(loaded.state.pendingExportConfirmation))
        throw new Error('Encrypted export confirmation binding or digest is invalid.');
      loaded.state.exportConfirmation = structuredClone(confirmation);
      loaded.state.pendingExportConfirmation = undefined;
      await save(loaded.record, loaded.record.phase as PrivateProVaultMigrationPhase, loaded.state, loaded.operationIds);
    },
    stop() {
      runEpoch++;
      abortController?.abort();
    },
    async stopAndWait() {
      runEpoch++;
      abortController?.abort();
      await running?.catch(() => undefined);
    },
  };
}

export function createPrivateProVaultMigrationLifecycle(deps: {
  migration: PrivateProVaultMigration;
  startEngine(): Promise<void>;
  onProgress(progress: PrivateProVaultMigrationProgress): void;
}): PrivateProVaultMigrationLifecycle {
  const unsubscribe = deps.migration.subscribe(progress => deps.onProgress(progress));
  let stopped = false;
  const start = async () => {
    if (stopped) throw new PrivateProVaultMigrationCancelledError();
    await deps.migration.run();
    if (stopped) throw new PrivateProVaultMigrationCancelledError();
    await deps.startEngine();
  };
  return {
    start,
    retry: start,
    stop() {
      stopped = true;
      unsubscribe();
      deps.migration.stop();
    },
    async stopAndWait() {
      stopped = true;
      unsubscribe();
      await deps.migration.stopAndWait();
    },
  };
}
