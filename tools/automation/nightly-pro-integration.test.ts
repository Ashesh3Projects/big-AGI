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
  assert.match(workflow, /--max-autopilot-continues 8/);
  assert.match(workflow, /--mode autopilot/);
  assert.doesNotMatch(workflow, /--plan/);
  assert.match(workflow, /--no-ask-user/);
  assert.match(workflow, /--no-remote/);
  assert.match(workflow, /--no-remote-export/);
  assert.match(workflow, /--disable-builtin-mcps/);
  assert.equal(workflow.match(/--yolo/g)?.length, 2);
  assert.doesNotMatch(workflow, /--disallow-temp-dir/);
  assert.match(workflow, /--secret-env-vars=/);
  assert.match(workflow, /env -i/);
  assert.match(workflow, /HOME="\$copilot_home"/);
  assert.match(workflow, /secrets\.COPILOT_GITHUB_TOKEN/);
  assert.doesNotMatch(workflow, /COPILOT_GITHUB_TOKEN:\s*\$\{\{ github\.token \}\}/);
  assert.doesNotMatch(workflow, /--allow-tool=/);
  assert.doesNotMatch(workflow, /--deny-tool=/);
  assert.equal(workflow.match(/trusted_coordinator_b64=/g)?.length, 2);
  assert.equal(workflow.match(/trusted_state_b64=/g)?.length, 2);
  assert.equal(workflow.match(/trusted_patch_hash_b64=/g)?.length, 1);
  assert.equal(workflow.match(/trusted_git_index_b64=/g)?.length, 3);
  assert.equal(workflow.match(/trusted_git_dir_identity=/g)?.length, 2);
  assert.equal(workflow.match(/trusted_git_head_b64=/g)?.length, 2);
  assert.equal(workflow.match(/trusted_git_head_identity=/g)?.length, 2);
  assert.equal(workflow.match(/restore_trusted_file trusted_git_head_b64 "\$GIT_HEAD_FILE"/g)?.length, 2);
  assert.equal(workflow.match(/restore_trusted_file\(\)/g)?.length, 2);
  assert.equal(workflow.match(/trusted_runner_temp_identity=/g)?.length, 2);
  assert.equal(workflow.match(/restore_trusted_file trusted_patch_hash_b64 nightly-minimal-patch\.sha256/g)?.length, 1);
  assert.equal(workflow.match(/restore_trusted_file trusted_git_index_b64 "\$trusted_git_index_file" "\$trusted_git_index_parent_identity"/g)?.length, 1);
  assert.doesNotMatch(workflow, /trusted_conflict_index_b64=/);
  assert.match(workflow, /GIT_INDEX_FILE="\$trusted_conflict_index_file"/);
  assert.match(workflow, /\/usr\/bin\/mv -Tf -- "\$temp" "\$target"/);
  assert.match(workflow, /test ! -L "\$target"/);
  assert.match(workflow, /Restored trusted file digest mismatch/);
  assert.match(workflow, /Git directory identity changed during Copilot execution/);
  assert.match(workflow, /Trusted target parent identity changed/);
  assert.match(workflow, /\/usr\/bin\/git status --porcelain=v1 -z --untracked-files=all/);
  assert.match(workflow, /workspace_status="\$\(\/usr\/bin\/git status --porcelain=v1 -z --untracked-files=all\)"/);
  assert.match(workflow, /Copilot modified the integration workspace during report generation/);
  assert.match(workflow, /trusted_node_bin="\$\(command -v node\)"/);
  assert.equal(workflow.match(/"\$trusted_node_bin" "\$RUNNER_TEMP\/nightly-pro-integration\.ts"/g)?.length, 1);
  assert.match(workflow, /TRUSTED_NODE_BIN: \$\{\{ steps\.node_bin\.outputs\.path \}\}/);
  assert.match(workflow, /run: \|\s+"\$TRUSTED_NODE_BIN" "\$RUNNER_TEMP\/nightly-pro-integration\.ts" verify-package/);
  assert.match(workflow, /restore_trusted_file trusted_coordinator_b64 nightly-pro-integration\.ts/);
  assert.match(workflow, /--no-custom-instructions/);
  assert.doesNotMatch(workflow, /--allow-tool='shell\(git:\*\)'/);
});

test('keeps Copilot to a minimal upstream port without invented tests or features', () => {
  const workflow = readRepoFile('.github/workflows/nightly-pro-integration.yml');
  const coordinator = readRepoFile('tools/automation/nightly-pro-integration.ts');

  assert.match(coordinator, /paused trusted git cherry-pick --no-commit/);
  assert.match(coordinator, /Do not create or modify tests unless the conflicted upstream path itself is a test/);
  assert.match(coordinator, /Do not add features, refactor, rename, reformat, or improve unrelated code/);
  assert.match(coordinator, /changed outside the upstream file set/);
  assert.doesNotMatch(coordinator, /Add or update tests for behavior you change/);
  assert.match(workflow, /include-hidden-files:\s*true/g);
  assert.match(coordinator, /Do not run git cherry-pick, commit, push/);
  assert.doesNotMatch(workflow, /shell\(git cherry-pick:\*\)/);
  assert.match(coordinator, /\['cherry-pick', '--quit'\]/);
  assert.match(workflow, /nightly-minimal-state\.txt/);
  assert.match(workflow, /nightly-copilot-conflict-prompt\.txt/);
  assert.match(workflow, /nightly-copilot-report-prompt\.txt/);
  assert.match(workflow, /finish-minimal/);
  assert.match(coordinator, /minimalPatchHashPath/);
  assert.match(coordinator, /RUNNER_TEMP/);
  assert.match(coordinator, /trustedPath/);
  assert.match(coordinator, /Minimal integration patch changed after trusted cherry-pick/);
  assert.match(coordinator, /Copilot created non-upstream untracked files/);
});

test('uses a deterministic checkpoint and a separate trusted publisher', () => {
  const workflow = readRepoFile('.github/workflows/nightly-pro-integration.yml');
  const coordinator = readRepoFile('tools/automation/nightly-pro-integration.ts');

  assert.match(workflow, /nightly-pro-integration\.ts" prepare/);
  assert.match(workflow, /nightly-pro-integration\.ts" verify-package/);
  assert.match(workflow, /nightly-pro-integration\.ts publish/);
  assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
  assert.match(workflow, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/);
  assert.match(workflow, /repository:\s*\$\{\{ github\.repository \}\}/);
  assert.match(workflow, /ref:\s*main/);
  assert.match(workflow, /RUNNER_TEMP\/nightly-pro-integration\.ts/);
  assert.match(workflow, /node "\$RUNNER_TEMP\/nightly-pro-integration\.ts" prepare/);
  assert.match(workflow, /"\$TRUSTED_NODE_BIN" "\$RUNNER_TEMP\/nightly-pro-integration\.ts" verify-package/);
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
