import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { TRPCClientError } from '@trpc/client';

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
});
