import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
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

test('removed encrypted Private Pro source and server surfaces stay absent', async () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const formerName = (...parts: string[]) => parts.join('');
  const removed = [
    `src/modules/private-pro/${formerName('va', 'ult')}`,
    'src/modules/private-pro/assets/privatePro.assets.router.ts',
    'src/modules/private-pro/assets/privatePro.assets.deployment.test.ts',
    `src/modules/private-pro/ui/${formerName('PrivatePro', 'Va', 'ult', 'Setup')}.tsx`,
    `src/modules/private-pro/ui/${formerName('PrivatePro', 'Va', 'ult', 'Unlock')}.tsx`,
    `src/modules/private-pro/ui/${formerName('PrivatePro', 'Va', 'ult', 'Status')}.tsx`,
    `src/modules/private-pro/ui/${formerName('PrivatePro', 'Va', 'ult', 'RecoveryRecommendation')}.tsx`,
    `src/modules/trade/${formerName('privatePro', 'Encrypted', 'Backup')}.ts`,
    `src/modules/trade/${formerName('privatePro', 'Encrypted', 'Backup')}.test.ts`,
    'app/api/private-pro/sweep-expired',
    `tools/private-pro/test-helpers/privatePro.${formerName('va', 'ult')}.password.test-helpers.ts`,
  ];
  const existing: string[] = [];
  for (const relativePath of removed) {
    try {
      await access(path.join(root, relativePath));
      existing.push(relativePath);
    } catch {}
  }

  assert.deepEqual(existing, []);
});

test('cloud router exposes auth and trade without removed private sync registrations', async () => {
  const source = await readFile(path.resolve(import.meta.dirname, '../../src/server/trpc/trpc.router-cloud.ts'), 'utf8');
  const removedRegistration = new RegExp(['privatePro', 'Va', 'ult'].join(''), 'i');

  assert.match(source, /privateProAuth:\s*privateProAuthRouter/);
  assert.doesNotMatch(source, removedRegistration);
});

test('direct Firebase workspace and asset browser modules stay present and Admin-free', async () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const browserModules = [
    'src/modules/private-pro/sync/privatePro.sync.firebase.ts',
    'src/modules/private-pro/assets/privatePro.assets.client.ts',
  ];

  for (const relativePath of browserModules) {
    const source = await readFile(path.join(root, relativePath), 'utf8');
    const removedImport = new RegExp(`private-pro/${['va', 'ult'].join('')}`);
    assert.match(source, /from ['"]firebase\/(?:firestore|storage)['"]/);
    assert.doesNotMatch(source, /firebase-admin|firebase\.admin/);
    assert.doesNotMatch(source, removedImport);
  }
});
