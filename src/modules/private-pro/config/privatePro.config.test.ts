import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  isPrivateProEmailAllowed,
  normalizePrivateProEmail,
  parsePrivateProPositiveInteger,
  parsePrivateProAllowlist,
} from './privatePro.config.server';


describe('private Pro allowlist', () => {
  test('normalizes case and surrounding whitespace', () => {
    assert.equal(normalizePrivateProEmail('  Friend@Example.COM '), 'friend@example.com');
  });

  test('drops empty and duplicate entries', () => {
    assert.deepEqual(
      [...parsePrivateProAllowlist('a@example.com, A@example.com, ,b@example.com')],
      ['a@example.com', 'b@example.com'],
    );
  });

  test('requires an exact email match', () => {
    const allowlist = parsePrivateProAllowlist('friend@example.com');

    assert.equal(isPrivateProEmailAllowed('friend@example.com', allowlist), true);
    assert.equal(isPrivateProEmailAllowed('other@example.com', allowlist), false);
  });

  test('parses only positive integer limits', () => {
    assert.equal(parsePrivateProPositiveInteger('30', 10, 'rate'), 30);
    assert.equal(parsePrivateProPositiveInteger(undefined, 10, 'rate'), 10);
    assert.throws(() => parsePrivateProPositiveInteger('0', 10, 'rate'), /positive integer/i);
  });
});
