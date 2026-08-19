import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const repoRoot = new URL('../../', import.meta.url);

function readRepoFile(path: string): string {
  return readFileSync(new URL(path, repoRoot), 'utf8');
}

test('schedules the unattended integration for midnight IST on the default branch', () => {
  const workflow = readRepoFile('.github/workflows/nightly-pro-integration.yml');

  assert.match(workflow, /cron:\s*'30 18 \* \* \*'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents:\s*write/);
  assert.doesNotMatch(workflow, /copilot-requests:\s*write/);
  assert.match(workflow, /ref:\s*main/);
  assert.match(workflow, /tools\/automation\/sync-upstream-main\.sh/);
  assert.match(workflow, /sync_main:/);
  assert.match(workflow, /integrate:/);
  assert.match(workflow, /publish:/);
  assert.match(workflow, /has_upstream_changes:/);
  assert.match(workflow, /steps\.prepare\.outputs\.has_upstream_changes/);
  assert.match(workflow, /needs\.integrate\.outputs\.has_upstream_changes == 'true'/);
  assert.match(workflow, /persist-credentials:\s*false/g);
});

test('runs the pinned Copilot CLI with the requested model and maximum effort', () => {
  const workflow = readRepoFile('.github/workflows/nightly-pro-integration.yml');

  assert.match(workflow, /npm install --global --ignore-scripts @github\/copilot@1\.0\.80/);
  assert.match(workflow, /--model gpt-5\.6-sol/);
  assert.match(workflow, /--effort max/);
  assert.match(workflow, /--no-ask-user/);
  assert.match(workflow, /--no-remote/);
  assert.match(workflow, /--no-remote-export/);
  assert.match(workflow, /--disable-builtin-mcps/);
  assert.match(workflow, /--disallow-temp-dir/);
  assert.match(workflow, /--secret-env-vars=/);
  assert.match(workflow, /env -i/);
  assert.match(workflow, /HOME="\$copilot_home"/);
  assert.match(workflow, /secrets\.COPILOT_GITHUB_TOKEN/);
  assert.doesNotMatch(workflow, /COPILOT_GITHUB_TOKEN:\s*\$\{\{ github\.token \}\}/);
  assert.match(workflow, /--deny-tool='shell\(git push\)'/);
  assert.match(workflow, /--deny-tool='shell\(git reset\)'/);
  assert.match(workflow, /--deny-tool='shell\(git checkout\)'/);
  assert.match(workflow, /--deny-tool='shell\(git switch\)'/);
  assert.match(workflow, /--deny-tool='shell\(git init\)'/);
  assert.match(workflow, /--deny-tool='shell\(git clone\)'/);
  assert.match(workflow, /--no-custom-instructions/);
  assert.doesNotMatch(workflow, /--allow-tool='shell\(git:\*\)'/);
});

test('uses a deterministic checkpoint and a separate trusted publisher', () => {
  const workflow = readRepoFile('.github/workflows/nightly-pro-integration.yml');
  const coordinator = readRepoFile('tools/automation/nightly-pro-integration.ts');

  assert.match(workflow, /tools\/automation\/nightly-pro-integration\.ts prepare/);
  assert.match(workflow, /tools\/automation\/nightly-pro-integration\.ts verify-package/);
  assert.match(workflow, /tools\/automation\/nightly-pro-integration\.ts publish/);
  assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
  assert.match(workflow, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/);
  assert.match(workflow, /repository:\s*\$\{\{ github\.repository \}\}/);
  assert.match(workflow, /ref:\s*main/);
  assert.match(coordinator, /\$\{CHECKPOINT_TRAILER\}: \$\{manifest\.upstreamHead\}/);
  assert.match(coordinator, /--force-with-lease=refs\/heads\/pro:\$\{manifest\.expectedProHead\}/);
  assert.match(coordinator, /run\(resolveBin\('tsc'\), \['--noEmit', '--pretty'\]\)/);
  assert.match(coordinator, /run\('npm', \['ci'\]\)/);
  assert.match(coordinator, /run\(resolveBin\('tsc'\), \['--noEmit', '--pretty', '-p', 'tools\/tsconfig\.json'\]\)/);
  assert.match(coordinator, /resolveBin\('eslint'\)/);
  assert.match(coordinator, /resolveBin\('tsx'\)/);
  assert.match(coordinator, /resolveBin\('next'\)/);
  assert.match(coordinator, /git\(\['diff', '--cached', '--check'\]\)/);
  assert.match(coordinator, /git\(\['add', '-A', '--', '\.', ':\(exclude\)\.nightly-\*'\]\)/);
});

test('requires a complete structured Copilot report before packaging', () => {
  const coordinator = readRepoFile('tools/automation/nightly-pro-integration.ts');

  assert.match(coordinator, /nightly-pro-integration-report\.json/);
  assert.match(coordinator, /no_changes_required/);
  assert.match(coordinator, /changes_applied/);
  assert.match(coordinator, /reviewedCommits/);
  assert.match(coordinator, /reviewedFiles/);
  assert.match(coordinator, /PROTECTED_PATHS/);
  assert.match(coordinator, /PROTECTED_PREFIXES/);
  assert.match(coordinator, /Head changed during Copilot integration/);
  assert.match(coordinator, /summary\.includes\('\\n'\)/);
  assert.match(coordinator, /Unsupported git mode/);
  assert.match(coordinator, /nightly-pro-integration\.patch/);
  assert.match(coordinator, /AUTOMATION_SOURCE_SHA/);
});

test('runs package verification from a clean reinstall and blocks generated drift', () => {
  const coordinator = readRepoFile('tools/automation/nightly-pro-integration.ts');

  assert.match(coordinator, /run\('npm', \['ci'\]\)/);
  assert.match(coordinator, /git status changed during npm ci/);
  assert.match(coordinator, /Verification commands changed the integration file set/);
});

test('finds the latest integration checkpoint through later Pro commits', () => {
  const coordinator = readRepoFile('tools/automation/nightly-pro-integration.ts');

  assert.match(coordinator, /'log', '--first-parent', '--format=%\(trailers:key=Upstream-Main-Integrated,valueonly\)', expectedProHead/);
  assert.doesNotMatch(coordinator, /'--format=%\(trailers:key=Upstream-Main-Integrated,valueonly\)', '-1'/);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createBareRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '--bare');
}

function configureAuthor(cwd: string): void {
  git(cwd, 'config', 'user.name', 'Test Author');
  git(cwd, 'config', 'user.email', 'test@example.com');
}

test('rebuilds fork main on upstream while preserving only the automation overlay', () => {
  const root = mkdtempSync(join(tmpdir(), 'nightly-main-sync-'));
  const upstreamBare = join(root, 'upstream.git');
  const originBare = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const runner = join(root, 'runner');
  createBareRepo(upstreamBare);
  createBareRepo(originBare);

  mkdirSync(seed);
  git(seed, 'init', '-b', 'main');
  configureAuthor(seed);
  writeFileSync(join(seed, 'file.txt'), 'one\n');
  git(seed, 'add', 'file.txt');
  git(seed, 'commit', '-m', 'initial');
  git(seed, 'remote', 'add', 'upstream', upstreamBare);
  git(seed, 'remote', 'add', 'origin', originBare);
  git(seed, 'push', 'upstream', 'main');
  git(seed, 'push', 'origin', 'main');

  const baseHead = git(seed, 'rev-parse', 'HEAD');
  const overlayPaths = [
    '.github/workflows/nightly-pro-integration.yml',
    'tools/automation/nightly-pro-integration.ts',
    'tools/automation/nightly-pro-integration.test.ts',
    'tools/automation/sync-upstream-main.sh',
  ];
  for (const path of overlayPaths) {
    const fullPath = join(seed, path);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, `overlay:${path}\n`);
  }
  git(seed, 'add', '.github', 'tools');
  git(seed, 'commit', '-m', 'Automation: preserve nightly Pro integration', '-m', `Upstream-Main-Synced: ${baseHead}`);
  git(seed, 'push', 'origin', 'main');

  git(seed, 'checkout', '-b', 'upstream-main', baseHead);
  writeFileSync(join(seed, 'file.txt'), 'two\n');
  git(seed, 'commit', '-am', 'upstream update');
  git(seed, 'push', 'upstream', 'HEAD:main');

  git(root, 'clone', '--branch', 'main', originBare, runner);
  configureAuthor(runner);
  const script = new URL('sync-upstream-main.sh', import.meta.url);
  const result = spawnSync('bash', [script.pathname.replace(/^\/(.:)/, '$1')], {
    cwd: runner,
    encoding: 'utf8',
    env: { ...process.env, UPSTREAM_URL: upstreamBare, ORIGIN_URL: originBare },
  });
  assert.equal(result.status, 0, result.stderr);
  const syncedMain = git(originBare, 'rev-parse', 'refs/heads/main');
  const upstreamMain = git(upstreamBare, 'rev-parse', 'refs/heads/main');
  assert.equal(git(originBare, 'rev-parse', `${syncedMain}^`), upstreamMain);
  assert.match(git(originBare, 'show', '-s', '--format=%B', syncedMain), new RegExp(`Upstream-Main-Synced: ${upstreamMain}`));
  for (const path of overlayPaths) {
    assert.equal(git(originBare, 'show', `${syncedMain}:${path}`), `overlay:${path}`);
  }

  git(runner, 'fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  git(runner, 'reset', '--hard', 'refs/remotes/origin/main');
  writeFileSync(join(runner, 'fork.txt'), 'fork only\n');
  git(runner, 'add', 'fork.txt');
  git(runner, 'commit', '-m', 'fork only');
  git(runner, 'push', '--force-with-lease', 'origin', 'HEAD:main');
  const refused = spawnSync('bash', [script.pathname.replace(/^\/(.:)/, '$1')], {
    cwd: runner,
    encoding: 'utf8',
    env: { ...process.env, UPSTREAM_URL: upstreamBare, ORIGIN_URL: originBare },
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /non-automation/);
});
