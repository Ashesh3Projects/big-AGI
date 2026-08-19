import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createTRPCUntypedClient, httpLink, TRPCClientError } from '@trpc/client';

import {
  PrivateProVaultAmbiguousTransportError,
  isPrivateProVaultAmbiguousTRPCError,
} from './privatePro.vault.transport';


describe('private Pro vault transport errors', () => {
  test('classifies a realistic tRPC-wrapped fetch failure as ambiguous', () => {
    const cause = new TypeError('Failed to fetch');
    const error = TRPCClientError.from(cause);

    assert.equal(error.cause, cause);
    assert.equal(isPrivateProVaultAmbiguousTRPCError(error), true);
    assert.equal(new PrivateProVaultAmbiguousTransportError(error).cause, error);
  });

  test('does not classify server validation errors as ambiguous transport failures', () => {
    const error = new TRPCClientError('Vault backup merge contains too many records.');
    Object.defineProperty(error, 'data', {
      value: { code: 'BAD_REQUEST', httpStatus: 400, path: 'privateProVault.mergeBackup' },
    });

    assert.equal(error.data?.httpStatus, 400);
    assert.equal(isPrivateProVaultAmbiguousTRPCError(error), false);
  });

  async function httpLinkError(response: Response | Error, signal?: AbortSignal): Promise<TRPCClientError<any>> {
    const client = createTRPCUntypedClient({
      links: [httpLink({
        url: 'https://private-pro.invalid/trpc',
        fetch: async () => {
          if (response instanceof Error) throw response;
          return response;
        },
      })],
    });
    try {
      await client.mutation('privateProVault.confirmBackupRestoreVerified', {}, { signal });
      throw new Error('Expected tRPC mutation to reject.');
    } catch (error) {
      assert(error instanceof TRPCClientError);
      return error;
    }
  }

  for (const [name, body, status] of [
    ['empty success response', '', 200],
    ['truncated JSON response', '{"result":', 200],
    ['HTML gateway response', '<html>bad gateway</html>', 502],
  ] as const) {
    test(`classifies actual httpLink ${name} as ambiguous`, async () => {
      const error = await httpLinkError(new Response(body, { status, headers: { 'content-type': 'application/json' } }));
      assert.equal(error.data, undefined);
      assert.equal(isPrivateProVaultAmbiguousTRPCError(error), true);
    });
  }

  test('does not classify an actual structured tRPC server error as ambiguous', async () => {
    const error = await httpLinkError(new Response(JSON.stringify({ error: {
      message: 'invalid restore manifest',
      code: -32600,
      data: { code: 'BAD_REQUEST', httpStatus: 400, path: 'privateProVault.beginBackupRestore' },
    } }), { status: 400, headers: { 'content-type': 'application/json' } }));
    assert.equal(error.data?.code, 'BAD_REQUEST');
    assert.equal(isPrivateProVaultAmbiguousTRPCError(error), false);
  });

  test('does not classify an actual httpLink abort as ambiguous', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await httpLinkError(new Response('', { status: 200 }), controller.signal);
    assert.equal(isPrivateProVaultAmbiguousTRPCError(error), false);
  });
});
