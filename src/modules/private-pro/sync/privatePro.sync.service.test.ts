import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { PrivateProIdentity } from '../auth/privatePro.auth.types';
import type {
  PrivateProChatManifest,
  PrivateProChatUpload,
  PrivateProSyncRepository,
  PrivateProTombstone,
} from './privatePro.sync.repository';
import { createPrivateProSyncService } from './privatePro.sync.service';
import type { SyncChunk } from './privatePro.sync.schemas';


const IDENTITY: PrivateProIdentity = {
  uid: 'uid-owner',
  email: 'owner@example.com',
  emailVerified: true,
  privatePro: true,
  privateProEpoch: 1,
  issuedAt: 100,
  expiresAt: 200,
};

const CHUNK: SyncChunk = {
  id: '000000',
  index: 0,
  byteLength: 3,
  hash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  payloadBase64: 'YWJj',
};

class MemorySyncRepository implements PrivateProSyncRepository {
  chats = new Map<string, PrivateProChatManifest>();
  uploads = new Map<string, PrivateProChatUpload>();
  uploadChunks = new Map<string, Map<string, SyncChunk>>();
  tombstones = new Map<string, PrivateProTombstone>();
  personas = new Map<string, { revision: number; contentHash: string; payload: unknown; deviceId: string }>();
  seenUids = new Set<string>();

  private key(uid: string, id: string) {
    this.seenUids.add(uid);
    return `${uid}:${id}`;
  }

  async getChat(uid: string, chatId: string) {
    return this.chats.get(this.key(uid, chatId)) ?? null;
  }

  async getUpload(uid: string, operationId: string) {
    return this.uploads.get(this.key(uid, operationId)) ?? null;
  }

  async putUpload(uid: string, upload: PrivateProChatUpload) {
    this.uploads.set(this.key(uid, upload.operationId), structuredClone(upload));
  }

  async putUploadChunk(uid: string, operationId: string, chunk: SyncChunk) {
    const key = this.key(uid, operationId);
    const chunks = this.uploadChunks.get(key) ?? new Map<string, SyncChunk>();
    chunks.set(chunk.id, structuredClone(chunk));
    this.uploadChunks.set(key, chunks);
  }

  async getUploadChunks(uid: string, operationId: string) {
    return [...(this.uploadChunks.get(this.key(uid, operationId))?.values() ?? [])];
  }

  async commitChat(uid: string, upload: PrivateProChatUpload, chunks: SyncChunk[]) {
    const current = await this.getChat(uid, upload.chatId);
    const tombstone = await this.getTombstone(uid, 'chat', upload.chatId);
    const effectiveRevision = Math.max(current?.revision ?? 0, tombstone?.revision ?? 0);
    if (effectiveRevision !== upload.baseRevision)
      return { status: 'conflict' as const, currentRevision: effectiveRevision, currentHash: current?.contentHash ?? null };

    const manifest: PrivateProChatManifest = {
      chatId: upload.chatId,
      revision: upload.targetRevision,
      operationId: upload.operationId,
      contentHash: upload.contentHash,
      chunkIds: chunks.map(chunk => chunk.id),
      byteLength: chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
      deviceId: upload.deviceId,
      updatedAtMs: 5000,
    };
    this.chats.set(this.key(uid, upload.chatId), manifest);
    this.uploads.set(this.key(uid, upload.operationId), { ...upload, committedRevision: manifest.revision });
    this.tombstones.delete(this.key(uid, `chat:${upload.chatId}`));
    return { status: 'committed' as const, revision: manifest.revision };
  }

  async getTombstone(uid: string, entityType: 'chat' | 'persona', entityId: string) {
    return this.tombstones.get(this.key(uid, `${entityType}:${entityId}`)) ?? null;
  }

  async deleteEntity(uid: string, entityType: 'chat' | 'persona', entityId: string, baseRevision: number, deviceId: string, operationId: string) {
    const chat = entityType === 'chat' ? await this.getChat(uid, entityId) : null;
    const persona = entityType === 'persona' ? this.personas.get(this.key(uid, entityId)) : null;
    const tombstone = await this.getTombstone(uid, entityType, entityId);
    if (tombstone?.operationId === operationId)
      return { status: 'deleted' as const, revision: tombstone.revision };
    const effectiveRevision = Math.max(chat?.revision ?? persona?.revision ?? 0, tombstone?.revision ?? 0);
    if (effectiveRevision !== baseRevision)
      return { status: 'conflict' as const, currentRevision: effectiveRevision, currentHash: chat?.contentHash ?? persona?.contentHash ?? null };
    const revision = baseRevision + 1;
    this.tombstones.set(this.key(uid, `${entityType}:${entityId}`), { entityType, entityId, revision, deviceId, operationId, deletedAtMs: 5000 });
    if (entityType === 'chat') this.chats.delete(this.key(uid, entityId));
    else this.personas.delete(this.key(uid, entityId));
    return { status: 'deleted' as const, revision };
  }

  async putPersona(uid: string, request: { personaId: string; baseRevision: number; contentHash: string; payload: unknown; deviceId: string }) {
    const key = this.key(uid, request.personaId);
    const current = this.personas.get(key);
    const tombstone = await this.getTombstone(uid, 'persona', request.personaId);
    const effectiveRevision = Math.max(current?.revision ?? 0, tombstone?.revision ?? 0);
    if (current?.contentHash === request.contentHash)
      return { status: 'unchanged' as const, revision: current.revision };
    if (effectiveRevision !== request.baseRevision)
      return { status: 'conflict' as const, currentRevision: effectiveRevision, currentHash: current?.contentHash ?? null };
    const revision = request.baseRevision + 1;
    this.personas.set(key, { revision, contentHash: request.contentHash, payload: structuredClone(request.payload), deviceId: request.deviceId });
    this.tombstones.delete(this.key(uid, `persona:${request.personaId}`));
    return { status: 'committed' as const, revision };
  }

  async cleanupMigratedEntity(input: { uid: string; entityType: 'chat' | 'persona'; entityId: string; sourceVersion: string }) {
    const [revisionText, contentHash] = input.sourceVersion.split(':');
    const revision = Number(revisionText);
    const current = input.entityType === 'chat'
      ? this.chats.get(this.key(input.uid, input.entityId))
      : this.personas.get(this.key(input.uid, input.entityId));
    if (!current) return 'already-deleted' as const;
    if (current.revision !== revision || current.contentHash !== contentHash) return 'conflict' as const;
    if (input.entityType === 'chat') this.chats.delete(this.key(input.uid, input.entityId));
    else this.personas.delete(this.key(input.uid, input.entityId));
    return 'deleted' as const;
  }
}


function prepareRequest(operationId = 'op-1') {
  return {
    operationId,
    chatId: 'chat-1',
    baseRevision: 0,
    contentHash: CHUNK.hash,
    chunks: [{ id: CHUNK.id, index: CHUNK.index, byteLength: CHUNK.byteLength, hash: CHUNK.hash }],
    deviceId: 'device-1',
  };
}


describe('private Pro revisioned sync service', () => {
  test('prepares and commits a complete new chat as revision one', async () => {
    const repository = new MemorySyncRepository();
    const service = createPrivateProSyncService(repository, () => 1000);

    assert.deepEqual(await service.prepareChat(IDENTITY, prepareRequest()), { status: 'prepared', targetRevision: 1 });
    await service.putChatChunk(IDENTITY, { operationId: 'op-1', chunk: CHUNK });
    assert.deepEqual(await service.commitChat(IDENTITY, { operationId: 'op-1' }), { status: 'committed', revision: 1 });
    assert.deepEqual(await service.commitChat(IDENTITY, { operationId: 'op-1' }), { status: 'committed', revision: 1 });
    assert.equal(repository.chats.get('uid-owner:chat-1')?.revision, 1);
  });

  test('repeating the same operation is idempotent', async () => {
    const repository = new MemorySyncRepository();
    const service = createPrivateProSyncService(repository, () => 1000);

    const first = await service.prepareChat(IDENTITY, prepareRequest());
    const second = await service.prepareChat(IDENTITY, prepareRequest());

    assert.deepEqual(first, { status: 'prepared', targetRevision: 1 });
    assert.deepEqual(second, first);
  });

  test('rejects a stale base revision without changing the canonical chat', async () => {
    const repository = new MemorySyncRepository();
    repository.chats.set('uid-owner:chat-1', {
      chatId: 'chat-1', revision: 2, operationId: 'other-op', contentHash: 'c'.repeat(64), chunkIds: [], byteLength: 0, deviceId: 'other', updatedAtMs: 100,
    });
    const service = createPrivateProSyncService(repository, () => 1000);

    const result = await service.prepareChat(IDENTITY, prepareRequest());

    assert.deepEqual(result, { status: 'conflict', currentRevision: 2, currentHash: 'c'.repeat(64) });
    assert.equal(repository.uploads.size, 0);
  });

  test('refuses commit until every declared chunk is present and valid', async () => {
    const repository = new MemorySyncRepository();
    const service = createPrivateProSyncService(repository, () => 1000);
    await service.prepareChat(IDENTITY, prepareRequest());

    await assert.rejects(service.commitChat(IDENTITY, { operationId: 'op-1' }), /missing sync chunk/i);
    await assert.rejects(
      service.putChatChunk(IDENTITY, { operationId: 'op-1', chunk: { ...CHUNK, hash: 'd'.repeat(64) } }),
      /does not match/i,
    );
    await assert.rejects(
      service.putChatChunk(IDENTITY, { operationId: 'op-1', chunk: { ...CHUNK, payloadBase64: 'YWJk' } }),
      /failed validation/i,
    );
  });

  test('refuses a chat whose assembled payload does not match the manifest hash', async () => {
    const repository = new MemorySyncRepository();
    const service = createPrivateProSyncService(repository, () => 1000);
    await service.prepareChat(IDENTITY, { ...prepareRequest(), contentHash: 'b'.repeat(64) });
    await service.putChatChunk(IDENTITY, { operationId: 'op-1', chunk: CHUNK });

    await assert.rejects(
      service.commitChat(IDENTITY, { operationId: 'op-1' }),
      /content hash/i,
    );
    assert.equal(repository.chats.size, 0);
  });

  test('a tombstone prevents a stale offline chat from being resurrected', async () => {
    const repository = new MemorySyncRepository();
    repository.tombstones.set('uid-owner:chat:chat-1', {
      entityType: 'chat', entityId: 'chat-1', revision: 3, deviceId: 'other', operationId: 'delete-other', deletedAtMs: 500,
    });
    const service = createPrivateProSyncService(repository, () => 1000);

    assert.deepEqual(
      await service.prepareChat(IDENTITY, prepareRequest()),
      { status: 'conflict', currentRevision: 3, currentHash: null },
    );
  });

  test('delete and persona operations use only the verified identity UID', async () => {
    const repository = new MemorySyncRepository();
    const service = createPrivateProSyncService(repository, () => 1000);

    assert.deepEqual(await service.putPersona(IDENTITY, {
      personaId: 'persona-1', baseRevision: 0, contentHash: 'e'.repeat(64), payload: { schemaVersion: 1 }, deviceId: 'device-1',
    }), { status: 'committed', revision: 1 });
    assert.deepEqual(await service.deletePersona(IDENTITY, {
      operationId: 'delete-persona-1', entityId: 'persona-1', baseRevision: 1, deviceId: 'device-1',
    }), { status: 'deleted', revision: 2 });
    assert.deepEqual(await service.deletePersona(IDENTITY, {
      operationId: 'delete-persona-1', entityId: 'persona-1', baseRevision: 1, deviceId: 'device-1',
    }), { status: 'deleted', revision: 2 });
    assert.deepEqual([...repository.seenUids], ['uid-owner']);
  });

  test('legacy cleanup deletes only the authenticated UID and exact frozen revision/hash', async () => {
    const repository = new MemorySyncRepository();
    repository.chats.set('uid-owner:chat-1', {
      chatId: 'chat-1', revision: 3, operationId: 'legacy', contentHash: 'a'.repeat(64), chunkIds: [], byteLength: 0, deviceId: 'legacy', updatedAtMs: 1,
    });
    const service = createPrivateProSyncService(repository, () => 1000);

    assert.equal(await service.cleanupMigratedEntity(IDENTITY, { entityType: 'chat', entityId: 'chat-1', sourceVersion: `2:${'a'.repeat(64)}` }), 'conflict');
    assert.equal(repository.chats.has('uid-owner:chat-1'), true);
    assert.equal(await service.cleanupMigratedEntity(IDENTITY, { entityType: 'chat', entityId: 'chat-1', sourceVersion: `3:${'a'.repeat(64)}` }), 'deleted');
    assert.equal(await service.cleanupMigratedEntity(IDENTITY, { entityType: 'chat', entityId: 'chat-1', sourceVersion: `3:${'a'.repeat(64)}` }), 'already-deleted');
  });
});
