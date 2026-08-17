import assert from 'node:assert/strict';
import { test } from 'node:test';
import packageJson from '../../package.json' with { type: 'json' };

test('uses the approved patched private Pro dependency floors', () => {
  assert.match(packageJson.dependencies.next, /^~15\.(?:5\.(?:2[3-9]|[3-9]\d)|[6-9]\.)/);
  assert.match(packageJson.dependencies.nanoid, /^(?:\^|~)?(?:5\.1\.1[6-9]|5\.[2-9]|6\.)/);
  assert.match(packageJson.dependencies['puppeteer-core'], /^(?:\^|~)?25\./);
  assert.equal(packageJson.engines.node, '^26.0.0 || ^24.0.0 || ^22.12.0');
});
