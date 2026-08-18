import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import packageJson from '../../package.json' with { type: 'json' };

type DependencyManifest = typeof packageJson & {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  overrides?: Record<string, unknown>;
};

const dependencyManifest = packageJson as DependencyManifest;
const packageLock = JSON.parse(
  readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'),
) as { packages: Record<string, { dev?: boolean; version?: string }> };

const EXPECTED_MODERATE_AUDIT = {
  '@google-cloud/firestore': ['google-gax'],
  '@google-cloud/storage': ['retry-request', 'teeny-request'],
  'firebase-admin': ['@google-cloud/firestore', '@google-cloud/storage'],
  gaxios: ['uuid'],
  'google-gax': ['retry-request', 'uuid'],
  'retry-request': ['teeny-request'],
  'teeny-request': ['uuid'],
  uuid: [1119441],
} as const;

const EXPECTED_UUID_ADVISORY = {
  source: 1119441,
  name: 'uuid',
  dependency: 'uuid',
  title: 'uuid: Missing buffer bounds check in v3/v5/v6 when buf is provided',
  severity: 'moderate',
  cwe: ['CWE-787', 'CWE-1285'],
  range: '<11.1.1',
} as const;

type AuditAdvisory = {
  source: number;
  name: string;
  dependency: string;
  title: string;
  severity: string;
  cwe: string[];
  range: string;
};

function inspectReviewedUuidAdvisory(value: unknown): typeof EXPECTED_UUID_ADVISORY | null {
  if (!value || typeof value !== 'object') return null;
  const advisory = value as Partial<AuditAdvisory>;
  const normalized = {
    source: advisory.source,
    name: advisory.name,
    dependency: advisory.dependency,
    title: advisory.title,
    severity: advisory.severity,
    cwe: advisory.cwe,
    range: advisory.range,
  };
  return assert.deepEqual(normalized, EXPECTED_UUID_ADVISORY) === undefined
    ? EXPECTED_UUID_ADVISORY
    : null;
}

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

test('keeps the statically imported bundle analyzer in production installs', () => {
  assert.equal(packageJson.dependencies['@next/bundle-analyzer'], '~15.5.23');
  assert.equal(dependencyManifest.devDependencies['@next/bundle-analyzer'], undefined);
});

test('loads Next config without dev-only PostHog tooling when upload is disabled', () => {
  const script = `
    const Module = require('node:module');
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === '@posthog/nextjs-config') throw new Error('dev-only PostHog config was loaded');
      return originalLoad.call(this, request, parent, isMain);
    };
    process.env.POSTHOG_API_KEY = 'runtime-must-not-upload';
    process.env.POSTHOG_ENV_ID = 'runtime-must-not-upload';
    delete process.env.ANALYZE_BUNDLE;
    const loadConfig = require('next/dist/server/config').default;
    const { PHASE_PRODUCTION_SERVER } = require('next/constants');
    loadConfig(PHASE_PRODUCTION_SERVER, process.cwd(), { silent: true })
      .then(config => {
        if (typeof config.webpack !== 'function') throw new Error('Next config did not load');
      })
      .catch(error => {
        console.error(error);
        process.exitCode = 1;
      });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production' },
  });

  assert.equal(result.status, 0, result.stderr);
});

test('resolves the PostHog wrapper to a production build config object', () => {
  const script = `
    process.env.POSTHOG_API_KEY = 'dummy-token';
    process.env.POSTHOG_ENV_ID = 'dummy-env';
    delete process.env.ANALYZE_BUNDLE;
    const loadConfig = require('next/dist/server/config').default;
    const { PHASE_PRODUCTION_BUILD } = require('next/constants');
    loadConfig(PHASE_PRODUCTION_BUILD, process.cwd(), { silent: true })
      .then(config => {
        if (typeof config.webpack !== 'function') throw new Error('PostHog webpack config was not resolved');
        if (!config.reactStrictMode) throw new Error('base Next config was not preserved');
        const webpackConfig = config.webpack({
          resolve: { alias: {} },
          experiments: {},
          plugins: [],
          output: { environment: {} },
          optimization: { splitChunks: { minSize: 1 } },
        }, {
          isServer: false,
          webpack: { NormalModuleReplacementPlugin: class {} },
        });
        if (webpackConfig.devtool !== 'hidden-source-map') throw new Error('PostHog source-map webpack config was not applied');
      })
      .catch(error => {
        console.error(error);
        process.exitCode = 1;
      });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production' },
  });

  assert.equal(result.status, 0, result.stderr);
});

test('private Pro production build never imports or applies the PostHog source-map wrapper', () => {
  const script = `
    const Module = require('node:module');
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === '@posthog/nextjs-config') throw new Error('Private Pro imported PostHog source-map tooling');
      return originalLoad.call(this, request, parent, isMain);
    };
    process.env.NEXT_PUBLIC_PRIVATE_PRO_ENABLED = 'true';
    process.env.PRIVATE_PRO_ALLOWED_EMAILS = 'friend@example.com';
    process.env.NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY = 'dummy-app-check-site-key';
    process.env.POSTHOG_API_KEY = 'dummy-token';
    process.env.POSTHOG_ENV_ID = 'dummy-env';
    delete process.env.ANALYZE_BUNDLE;
    const loadConfig = require('next/dist/server/config').default;
    const { PHASE_PRODUCTION_BUILD } = require('next/constants');
    loadConfig(PHASE_PRODUCTION_BUILD, process.cwd(), { silent: true })
      .then(config => {
        const webpackConfig = config.webpack({
          resolve: { alias: {} }, experiments: {}, plugins: [], output: { environment: {} },
          optimization: { splitChunks: { minSize: 1 } },
        }, { isServer: false, webpack: { NormalModuleReplacementPlugin: class {} } });
        if (webpackConfig.devtool === 'hidden-source-map') throw new Error('Private Pro applied PostHog source maps');
      })
      .catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production' },
  });

  assert.equal(result.status, 0, result.stderr);
});

test('fails closed when a PostHog source-map build omits dev dependencies', () => {
  for (const errorCode of ['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND']) {
    const script = `
      const Module = require('node:module');
      const originalLoad = Module._load;
      Module._load = function(request, parent, isMain) {
        if (request === '@posthog/nextjs-config') {
          const error = new Error('Cannot find module @posthog/nextjs-config');
          error.code = ${JSON.stringify(errorCode)};
          throw error;
        }
        return originalLoad.call(this, request, parent, isMain);
      };
      process.env.POSTHOG_API_KEY = 'dummy-token';
      process.env.POSTHOG_ENV_ID = 'dummy-env';
      const loadConfig = require('next/dist/server/config').default;
      const { PHASE_PRODUCTION_BUILD } = require('next/constants');
      loadConfig(PHASE_PRODUCTION_BUILD, process.cwd(), { silent: true })
        .then(() => {
          throw new Error('PostHog build unexpectedly loaded without its dev dependency');
        })
        .catch(error => {
          if (!String(error.message).includes('npm ci without --omit=dev')) throw error;
        });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production' },
    });

    assert.equal(result.status, 0, `${errorCode}: ${result.stderr}`);
  }
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

test('allows only the reviewed Firebase Admin moderate advisory chain', () => {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, 'npm_execpath is required to run the installed npm audit');
  const result = spawnSync(process.execPath, [npmCli, 'audit', '--omit=dev', '--json'], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, npm_config_audit: 'true' },
  });
  assert.equal(result.status, 1, result.stderr);
  const audit = JSON.parse(result.stdout);

  assert.deepEqual(audit.metadata.vulnerabilities, {
    info: 0,
    low: 0,
    moderate: 8,
    high: 0,
    critical: 0,
    total: 8,
  });
  assert.deepEqual(Object.fromEntries(Object.entries(audit.vulnerabilities).map(([name, value]) => [
    name,
    (value as { severity: string; via: Array<string | { source: number }> }).via.map(item => typeof item === 'string' ? item : item.source),
  ])), EXPECTED_MODERATE_AUDIT);
  const uuidNode = audit.vulnerabilities.uuid;
  assert.equal(packageLock.packages['node_modules/uuid']?.version, '9.0.1');
  assert.deepEqual(inspectReviewedUuidAdvisory(uuidNode.via[0]), EXPECTED_UUID_ADVISORY);
});

test('requires re-review when UUID advisory semantics change', () => {
  const baseline = { ...EXPECTED_UUID_ADVISORY, cwe: [...EXPECTED_UUID_ADVISORY.cwe] };
  for (const mutation of [
    { ...baseline, title: `${baseline.title} changed` },
    { ...baseline, range: '<12.0.0' },
    { ...baseline, cwe: ['CWE-787'] },
  ]) {
    assert.throws(() => inspectReviewedUuidAdvisory(mutation));
  }
});
