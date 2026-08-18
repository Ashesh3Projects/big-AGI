import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';


describe('private Pro greenfield vault contract', () => {
  test('does not grant or implement a Firestore migration collection', () => {
    const rules = readFileSync('firestore.rules', 'utf8');
    const repository = readFileSync('src/modules/private-pro/vault/privatePro.vault.repository.firebase.ts', 'utf8');

    assert.doesNotMatch(rules, /match \/migrations\//);
    assert.doesNotMatch(repository, /\/migrations\//);
  });
});
