import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';


async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async entry => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory())
      return sourceFiles(fullPath);
    return /\.tsx?$/.test(entry.name) ? [fullPath] : [];
  }));
  return files.flat();
}

test('production src files do not import tools or test helpers', async () => {
  const srcRoot = path.resolve(import.meta.dirname, '../../src');
  const violations: string[] = [];

  for (const file of await sourceFiles(srcRoot)) {
    if (/\.test\.tsx?$/.test(file))
      continue;
    const source = await readFile(file, 'utf8');
    if (/\b(?:from|import)\s*\(?\s*['"][^'"]*(?:test-helpers|(?:^|\/)tools(?:\/|$))/.test(source))
      violations.push(path.relative(srcRoot, file));
  }

  assert.deepEqual(violations, []);
});

test('the production src tree contains no test-helper modules', async () => {
  const srcRoot = path.resolve(import.meta.dirname, '../../src');
  const testHelpers = (await sourceFiles(srcRoot))
    .filter(file => /(?:^|[.\/-])test-helpers(?:[.\/-]|$)/.test(file))
    .map(file => path.relative(srcRoot, file));

  assert.deepEqual(testHelpers, []);
});

test('default npm test runs the private Pro tools suite before src tests', async () => {
  const packageJson = JSON.parse(await readFile(path.resolve(import.meta.dirname, '../../package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };

  assert.equal(
    packageJson.scripts?.['test:private-pro-tools'],
    'cross-env NODE_ENV=development tsx --test "tools/private-pro/**/*.test.ts"',
  );
  assert.equal(
    packageJson.scripts?.test,
    'npm run test:private-pro-tools && cross-env NODE_ENV=development tsx --test "src/**/*.test.ts"',
  );
});
