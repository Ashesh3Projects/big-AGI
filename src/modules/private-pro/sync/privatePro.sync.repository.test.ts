import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  completePrivateProLegacyCleanupReceipt,
  createPrivateProLegacyCleanupReceipt,
  resumePrivateProLegacyMigrationCleanup,
  type PrivateProLegacyCleanupPort,
  type PrivateProLegacyCleanupReceipt,
} from './privatePro.sync.repository';


class MemoryCleanupPort implements PrivateProLegacyCleanupPort {
  canonical = { revision: 3, contentHash: 'a'.repeat(64), revisionPath: 'users/uid/chats/chat/revisions/3-op', chunkIds: ['a', 'b', 'c'] };
  receipt: PrivateProLegacyCleanupReceipt | null = null;
  chunks = new Set(['a', 'b', 'c']);
  revisionExists = true;
  completedTombstone: { uid: string; operationId: string; status: 'complete'; expiresAtMs: number } | null = null;
  failAfterCanonical = false;
  failAfterChunk: string | null = null;
  private canonicalFaultThrown = false;
  private chunkFaults = new Set<string>();

  async prepare(input: Parameters<PrivateProLegacyCleanupPort['prepare']>[0]) {
    if (this.completedTombstone?.operationId === input.operationId)
      return { status: 'complete' as const, tombstone: structuredClone(this.completedTombstone) };
    if (this.receipt) return { status: 'ready' as const, receipt: structuredClone(this.receipt) };
    if (!this.canonical) {
      if (!input.frozenRevisionPath || !input.frozenChunkIds) return { status: 'conflict' as const };
      this.receipt = {
        uid: input.uid, operationId: input.operationId, entityType: input.entityType, entityId: input.entityId,
        sourceVersion: input.sourceVersion, revisionPath: input.frozenRevisionPath, chunkIds: [...input.frozenChunkIds],
        chunkCursor: 0, status: 'children', expiresAtMs: input.expiresAtMs,
      };
      return { status: 'ready' as const, receipt: structuredClone(this.receipt) };
    }
    if (`${this.canonical.revision}:${this.canonical.contentHash}` !== input.sourceVersion) return { status: 'conflict' as const };
    this.receipt = {
      uid: input.uid, operationId: input.operationId, entityType: input.entityType, entityId: input.entityId,
      sourceVersion: input.sourceVersion, revisionPath: this.canonical.revisionPath, chunkIds: [...this.canonical.chunkIds], chunkCursor: 0,
      status: 'children', expiresAtMs: input.expiresAtMs,
    };
    this.canonical = null as never;
    if (this.failAfterCanonical && !this.canonicalFaultThrown) {
      this.canonicalFaultThrown = true;
      throw new Error('injected after canonical delete');
    }
    return { status: 'ready' as const, receipt: structuredClone(this.receipt) };
  }

  async deleteChunk(input: Parameters<PrivateProLegacyCleanupPort['deleteChunk']>[0]) {
    this.chunks.delete(input.chunkId);
    this.receipt!.chunkCursor = input.expectedCursor + 1;
    if (this.failAfterChunk === input.chunkId && !this.chunkFaults.has(input.chunkId)) {
      this.chunkFaults.add(input.chunkId);
      throw new Error(`injected after chunk ${input.chunkId}`);
    }
    return structuredClone(this.receipt!);
  }

  async listUnexpectedChunks() { return [...this.chunks].filter(chunk => !this.receipt!.chunkIds.includes(chunk)); }

  async finalize(input: Parameters<PrivateProLegacyCleanupPort['finalize']>[0]) {
    this.revisionExists = false;
    this.completedTombstone = {
      uid: input.receipt.uid,
      operationId: input.receipt.operationId,
      status: 'complete',
      expiresAtMs: input.receipt.expiresAtMs,
    };
    this.receipt = null;
    return structuredClone(this.completedTombstone);
  }
}

const INPUT = {
  uid: 'uid-owner', operationId: 'migration-cleanup-op', entityType: 'chat' as const, entityId: 'chat-1', sourceVersion: `3:${'a'.repeat(64)}`,
  frozenRevisionPath: 'users/uid-owner/chats/chat-1/revisions/3-op', frozenChunkIds: ['a', 'b', 'c'], expiresAtMs: 86_401_000,
};

describe('private Pro legacy cleanup receipt', () => {
  test('production receipt state helpers recover a frozen orphan and minimize completion metadata', () => {
    const receipt = createPrivateProLegacyCleanupReceipt(INPUT, INPUT.frozenRevisionPath, INPUT.frozenChunkIds);
    const complete = completePrivateProLegacyCleanupReceipt({ ...receipt, chunkCursor: receipt.chunkIds.length });

    assert.deepEqual(complete, {
      uid: 'uid-owner', operationId: 'migration-cleanup-op', status: 'complete', expiresAtMs: 86_401_000,
    });
    const serialized = JSON.stringify(complete);
    for (const forbidden of ['chat-1', '3-op', 'a'.repeat(64), 'chunkIds', 'revisionPath', 'sourceVersion'])
      assert.equal(serialized.includes(forbidden), false, forbidden);
  });

  test('resumes exact revision cleanup after a crash following canonical deletion', async () => {
    const port = new MemoryCleanupPort();
    port.failAfterCanonical = true;

    await assert.rejects(resumePrivateProLegacyMigrationCleanup(port, INPUT), /canonical delete/);
    assert.equal(port.canonical, null);
    assert.equal(port.receipt?.status, 'children');

    assert.equal(await resumePrivateProLegacyMigrationCleanup(port, INPUT), 'deleted');
    assert.deepEqual([...port.chunks], []);
    assert.equal(port.revisionExists, false);
    assert.equal(port.receipt, null);
    assert.deepEqual(port.completedTombstone, {
      uid: 'uid-owner', operationId: 'migration-cleanup-op', status: 'complete', expiresAtMs: 86_401_000,
    });
  });

  test('resumes from the persisted cursor after a crash following a chunk deletion', async () => {
    const port = new MemoryCleanupPort();
    port.failAfterChunk = 'b';

    await assert.rejects(resumePrivateProLegacyMigrationCleanup(port, INPUT), /chunk b/);
    assert.equal(port.receipt?.chunkCursor, 2);
    assert.deepEqual([...port.chunks], ['c']);

    assert.equal(await resumePrivateProLegacyMigrationCleanup(port, INPUT), 'deleted');
    assert.deepEqual([...port.chunks], []);
  });

  test('blocks unexpected post-inventory children instead of deleting them', async () => {
    const port = new MemoryCleanupPort();
    port.chunks.add('new-child');

    assert.equal(await resumePrivateProLegacyMigrationCleanup(port, INPUT), 'conflict');
    assert.equal(port.chunks.has('new-child'), true);
    assert.equal(port.revisionExists, true);
  });

  test('recreates an active receipt from frozen revision identity when canonical and receipt are absent', async () => {
    const port = new MemoryCleanupPort();
    port.canonical = null as never;

    assert.equal(await resumePrivateProLegacyMigrationCleanup(port, INPUT), 'deleted');
    assert.deepEqual([...port.chunks], []);
    assert.equal(port.revisionExists, false);
  });

  test('replays a minimal completion tombstone without retaining entity metadata', async () => {
    const port = new MemoryCleanupPort();
    assert.equal(await resumePrivateProLegacyMigrationCleanup(port, INPUT), 'deleted');

    assert.equal(await resumePrivateProLegacyMigrationCleanup(port, INPUT), 'deleted');
    const serialized = JSON.stringify(port.completedTombstone);
    for (const forbidden of ['chat-1', '3-op', 'a'.repeat(64), 'chunkIds', 'revisionPath', 'sourceVersion'])
      assert.equal(serialized.includes(forbidden), false, forbidden);
  });
});
