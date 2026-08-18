import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import packageJson from '../../package.json' with { type: 'json' };

type DependencyManifest = typeof packageJson & {
  dependencies: Record<string, string>;
  overrides?: Record<string, unknown>;
};

const dependencyManifest = packageJson as DependencyManifest;
const packageLock = JSON.parse(
  readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'),
) as { packages: Record<string, { dev?: boolean; version?: string }> };

test('uses the approved patched private Pro dependency floors', () => {
  assert.match(packageJson.dependencies.next, /^~15\.(?:5\.(?:2[3-9]|[3-9]\d)|[6-9]\.)/);
  assert.match(packageJson.dependencies.nanoid, /^(?:\^|~)?(?:5\.1\.1[6-9]|5\.[2-9]|6\.)/);
  assert.match(packageJson.dependencies.mammoth, /^(?:\^|~)?1\.12\.(?:[1-9]|[1-9]\d+)$/);
  assert.match(packageJson.dependencies.cheerio, /^(?:\^|~)?1\.(?:[2-9]|[1-9]\d+)\./);
  assert.match(packageJson.dependencies['puppeteer-core'], /^(?:\^|~)?25\.(?:[8-9]|[1-9]\d+)\./);
  assert.match(packageJson.dependencies['proxy-agent'], /^(?:\^|~)?8\.(?:0\.[2-9]|[1-9]\d*\.)/);
  assert.match(packageJson.dependencies.sharp, /^(?:\^|~)?0\.35\.(?:[3-9]|[1-9]\d+)$/);
  assert.equal(packageJson.engines.node, '^26.0.0 || ^24.0.0 || ^22.12.0');
});

test('pins audited transitive dependencies to compatible patched releases', () => {
  assert.deepEqual(dependencyManifest.overrides, {
    '@next/bundle-analyzer': {
      'webpack-bundle-analyzer': {
        ws: '7.5.11',
      },
    },
    mammoth: {
      '@xmldom/xmldom': '0.8.14',
      underscore: '1.13.8',
    },
    cheerio: {
      undici: '7.29.0',
    },
    dompurify: '3.4.13',
    'ip-address': '10.5.0',
    next: {
      postcss: '8.5.26',
    },
    postcss: {
      nanoid: '3.3.18',
    },
    sharp: '$sharp',
    'yaml@1': '1.10.3',
  });
});

test('keeps the Next bundle analyzer out of production installs', () => {
  assert.equal(dependencyManifest.dependencies['@next/bundle-analyzer'], undefined);
  assert.equal(packageJson.devDependencies['@next/bundle-analyzer'], '~15.5.23');
});

test('locks production dependency paths to audited patched versions', () => {
  const packages = packageLock.packages;

  assert.equal(packages['node_modules/@xmldom/xmldom']?.version, '0.8.14');
  assert.equal(packages['node_modules/underscore']?.version, '1.13.8');
  assert.equal(packages['node_modules/undici']?.version, '7.29.0');
  assert.equal(packages['node_modules/dompurify']?.version, '3.4.13');
  assert.equal(packages['node_modules/ip-address']?.version, '10.5.0');
  assert.equal(packages['node_modules/postcss']?.version, '8.5.26');
  assert.equal(packages['node_modules/postcss/node_modules/nanoid']?.version, '3.3.18');
  assert.equal(packages['node_modules/sharp']?.version, '0.35.3');
  assert.equal(packages['node_modules/next/node_modules/sharp'], undefined);
  assert.equal(packages['node_modules/proxy-agent']?.version, '8.0.2');
  assert.equal(packages['node_modules/proxy-agent']?.dev, undefined);
  assert.equal(packages['node_modules/webpack-bundle-analyzer/node_modules/ws']?.version, '7.5.11');
  assert.equal(packages['node_modules/yaml']?.version, '1.10.3');
});
