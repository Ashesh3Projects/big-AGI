import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_UPSTREAM_URL = 'https://github.com/enricoros/big-AGI.git';
const CHECKPOINT_TRAILER = 'Upstream-Main-Integrated';
const REPORT_PATH = '.nightly-pro-integration-report.json';
const PATCH_PATH = '.nightly-pro-integration.patch';
const MANIFEST_PATH = '.nightly-pro-integration-manifest.json';
const WORKSPACE_COMMITS_PATH = '.nightly-upstream-commits.txt';
const WORKSPACE_FILES_PATH = '.nightly-upstream-files.txt';
const PROTECTED_PATHS = new Set([
  '.github/workflows/nightly-pro-integration.yml',
  'tools/automation/nightly-pro-integration.ts',
  'tools/automation/nightly-pro-integration.test.ts',
  'tools/automation/sync-upstream-main.sh',
]);
const MAX_PATCH_BYTES = 50 * 1024 * 1024;

type IntegrationReport = {
  extraFiles: Array<{ path: string; reason: string }>;
  status: 'changes_applied' | 'no_changes_required';
  reviewedCommits: string[];
  reviewedFiles: string[];
  summary: string;
};

type IntegrationManifest = {
  automationSourceSha: string;
  expectedProHead: string;
  previousUpstreamHead: string;
  upstreamHead: string;
  reportSha256: string;
  patchSha256: string;
  proChangedFiles: number;
};

function run(command: string, args: string[], options: { capture?: boolean; env?: NodeJS.ProcessEnv } = {}): string {
  if (options.capture) {
    return execFileSync(command, args, {
      encoding: 'utf8',
      env: options.env,
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim();
  }
  execFileSync(command, args, { env: options.env, stdio: 'inherit' });
  return '';
}

function git(args: string[], capture = false): string {
  return run('git', args, { capture });
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function appendGithubEnv(values: Record<string, string>): void {
  const githubEnv = env('GITHUB_ENV');
  for (const [name, value] of Object.entries(values)) {
    if (value.includes('\n') || value.includes('\r')) throw new Error(`${name} must be single-line`);
    appendFileSync(githubEnv, `${name}=${value}\n`, 'utf8');
  }
}

function appendGithubOutput(values: Record<string, string>): void {
  const githubOutput = env('GITHUB_OUTPUT');
  for (const [name, value] of Object.entries(values)) {
    if (value.includes('\n') || value.includes('\r')) throw new Error(`${name} must be single-line`);
    appendFileSync(githubOutput, `${name}=${value}\n`, 'utf8');
  }
}

function appendSummary(markdown: string): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, markdown, 'utf8');
}

function assertSha(value: string, label: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${label} is not a full git SHA: ${value}`);
  return value;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function trustedPath(name: string): string {
  return resolve(env('RUNNER_TEMP'), name);
}

const trustedCommitsPath = () => trustedPath('nightly-upstream-commits.txt');
const trustedFilesPath = () => trustedPath('nightly-upstream-files.txt');
const minimalStatePath = () => trustedPath('nightly-minimal-state.txt');
const minimalPatchHashPath = () => trustedPath('nightly-minimal-patch.sha256');
const conflictPromptPath = () => trustedPath('nightly-copilot-conflict-prompt.txt');
const reportPromptPath = () => trustedPath('nightly-copilot-report-prompt.txt');

function listOutput(command: string, args: string[]): string[] {
  const output = run(command, args, { capture: true });
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

function resolveBin(name: string): string {
  return resolve('node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
}

function readCheckpoint(expectedProHead: string): string {
  const trailer = git(['log', '--first-parent', '--format=%(trailers:key=Upstream-Main-Integrated,valueonly)', expectedProHead], true)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (trailer) return assertSha(trailer, CHECKPOINT_TRAILER);
  return assertSha(git(['merge-base', expectedProHead, 'refs/remotes/upstream/main'], true), 'merge base');
}

function prepare(): void {
  if (git(['status', '--porcelain'], true)) throw new Error('The pro checkout must start clean');
  if (git(['branch', '--show-current'], true) !== 'pro') throw new Error('The coordinator must run on pro');

  const upstreamUrl = process.env.UPSTREAM_URL || DEFAULT_UPSTREAM_URL;
  const existingUpstream = spawnSync('git', ['remote', 'get-url', 'upstream'], { encoding: 'utf8' });
  if (existingUpstream.status === 0) git(['remote', 'set-url', 'upstream', upstreamUrl]);
  else git(['remote', 'add', 'upstream', upstreamUrl]);

  git(['fetch', '--no-tags', '--prune', 'upstream', '+refs/heads/main:refs/remotes/upstream/main']);
  git(['fetch', '--no-tags', '--prune', 'origin', '+refs/heads/pro:refs/remotes/origin/pro']);

  const expectedProHead = assertSha(git(['rev-parse', 'refs/remotes/origin/pro'], true), 'origin/pro');
  const localHead = assertSha(git(['rev-parse', 'HEAD'], true), 'HEAD');
  if (localHead !== expectedProHead) throw new Error(`Local pro ${localHead} is not origin/pro ${expectedProHead}`);

  const upstreamHead = assertSha(git(['rev-parse', 'refs/remotes/upstream/main'], true), 'upstream/main');
  const previousUpstreamHead = readCheckpoint(expectedProHead);
  git(['merge-base', '--is-ancestor', previousUpstreamHead, upstreamHead]);

  const upstreamCommits = listOutput('git', ['rev-list', '--reverse', `${previousUpstreamHead}..${upstreamHead}`]);
  const upstreamFiles = listOutput('git', ['diff', '--name-only', `${previousUpstreamHead}..${upstreamHead}`]);
  const serializedCommits = `${upstreamCommits.join('\n')}\n`;
  const serializedFiles = `${upstreamFiles.join('\n')}\n`;
  writeFileSync(WORKSPACE_COMMITS_PATH, serializedCommits, 'utf8');
  writeFileSync(WORKSPACE_FILES_PATH, serializedFiles, 'utf8');
  writeFileSync(trustedCommitsPath(), serializedCommits, 'utf8');
  writeFileSync(trustedFilesPath(), serializedFiles, 'utf8');

  const conflictPrompt =
    `Resolve only the currently unmerged files from the paused trusted git cherry-pick --no-commit. ` +
    `Preserve the upstream change as-is and preserve Pro customizations. Use the smallest conflict-only edit, then git add each resolved path. ` +
    `Do not create or modify tests unless the conflicted upstream path itself is a test. Do not add features, refactor, rename, reformat, or improve unrelated code. ` +
    `Do not touch files that are not currently unmerged. Do not run git cherry-pick, commit, push, merge, rebase, reset, checkout, switch, clean, restore, fetch, pull, init, clone, or change remotes. ` +
    `Do not write the final report. This is unattended. Do not ask questions.`;
  writeFileSync(conflictPromptPath(), conflictPrompt, 'utf8');

  const reportPrompt =
    `Review the completed minimal upstream integration from ${previousUpstreamHead}..${upstreamHead}. Do not edit source files, tests, or git state. ` +
    `Do not run tests, builds, linters, installs, package managers, generators, or subagents. Trusted verification runs separately. ` +
    `Read every commit in .nightly-upstream-commits.txt, every upstream path in .nightly-upstream-files.txt, and the current git diff. ` +
    `Write ${REPORT_PATH} as strict JSON with exactly these fields: extraFiles (an array of {path, reason}), status (changes_applied or no_changes_required), ` +
    `reviewedCommits (every SHA from .nightly-upstream-commits.txt in order), reviewedFiles (every path from .nightly-upstream-files.txt in order), ` +
    `and summary (a non-empty concise explanation). Use no markdown fences. Every changed path outside the upstream file list needs one exact extraFiles justification. ` +
    `This is unattended. Do not ask questions.`;
  writeFileSync(reportPromptPath(), reportPrompt, 'utf8');

  appendGithubEnv({
    EXPECTED_PRO_HEAD: expectedProHead,
    PREVIOUS_UPSTREAM_HEAD: previousUpstreamHead,
    UPSTREAM_HEAD: upstreamHead,
  });
  appendGithubOutput({ has_upstream_changes: upstreamCommits.length > 0 ? 'true' : 'false' });
  appendSummary(
    `## Nightly Pro integration\n\n- Previous upstream checkpoint: \`${previousUpstreamHead}\`\n` +
      `- Current upstream main: \`${upstreamHead}\`\n- Upstream commits: ${upstreamCommits.length}\n- Upstream files: ${upstreamFiles.length}\n`,
  );
}

function applyMinimal(): void {
  const commits = readFileSync(trustedCommitsPath(), 'utf8').trim().split(/\r?\n/).filter(Boolean);
  if (!commits.length) throw new Error('No upstream commits to apply');

  for (let index = 0; index < commits.length; index += 1) {
    const commit = commits[index];
    const result = spawnSync('git', ['cherry-pick', '--no-commit', commit], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status === 0) continue;

    const unmerged = listOutput('git', ['diff', '--name-only', '--diff-filter=U']);
    if (!unmerged.length) throw new Error(`git cherry-pick failed without unmerged paths (${result.status})`);
    writeFileSync(minimalStatePath(), `conflict:${index}\n`, 'utf8');
    return;
  }

  const patch = git(['diff', '--cached', '--binary', '--full-index'], true);
  writeFileSync(minimalPatchHashPath(), `${sha256Text(patch)}\n`, 'utf8');
  writeFileSync(minimalStatePath(), 'complete\n', 'utf8');
}

function parseReport(): IntegrationReport {
  if (!existsSync(REPORT_PATH)) throw new Error(`Copilot did not create ${REPORT_PATH}`);
  const raw = JSON.parse(readFileSync(REPORT_PATH, 'utf8')) as Partial<IntegrationReport>;
  const keys = Object.keys(raw).sort();
  if (keys.join(',') !== 'extraFiles,reviewedCommits,reviewedFiles,status,summary') throw new Error('Copilot report has unexpected fields');
  if (!Array.isArray(raw.extraFiles)) throw new Error('Invalid extraFiles');
  for (const item of raw.extraFiles) {
    if (!item || typeof item.path !== 'string' || typeof item.reason !== 'string' || !item.reason.trim()) throw new Error('Invalid extraFiles item');
    if (item.reason.includes('\n') || item.reason.includes('\r') || item.reason.length > 300)
      throw new Error('extraFiles reasons must be bounded single lines');
  }
  if (raw.status !== 'changes_applied' && raw.status !== 'no_changes_required') throw new Error('Invalid report status');
  if (!Array.isArray(raw.reviewedCommits) || !raw.reviewedCommits.every((value) => typeof value === 'string')) {
    throw new Error('Invalid reviewedCommits');
  }
  if (!Array.isArray(raw.reviewedFiles) || !raw.reviewedFiles.every((value) => typeof value === 'string')) {
    throw new Error('Invalid reviewedFiles');
  }
  if (typeof raw.summary !== 'string' || !raw.summary.trim()) throw new Error('Invalid report summary');
  if (raw.summary.includes('\n') || raw.summary.includes('\r') || raw.summary.length > 500 || raw.summary.includes(CHECKPOINT_TRAILER)) {
    throw new Error('Report summary must be one bounded line without checkpoint trailers');
  }
  return raw as IntegrationReport;
}

function finishMinimal(): void {
  if (git(['rev-parse', 'HEAD'], true) !== env('EXPECTED_PRO_HEAD')) throw new Error('Head changed during minimal integration');
  const unmerged = listOutput('git', ['diff', '--name-only', '--diff-filter=U']);
  if (unmerged.length) throw new Error(`Copilot left unresolved conflicts: ${unmerged.join(', ')}`);
  const state = readFileSync(minimalStatePath(), 'utf8').trim();
  const conflictMatch = /^conflict:(\d+)$/.exec(state);
  if (!conflictMatch) throw new Error(`Invalid minimal integration state: ${state}`);
  const commits = readFileSync(trustedCommitsPath(), 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const conflictIndex = Number(conflictMatch[1]);

  git(['cherry-pick', '--quit']);
  for (let index = conflictIndex + 1; index < commits.length; index += 1) {
    const commit = commits[index];
    const result = spawnSync('git', ['cherry-pick', '--no-commit', commit], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const laterUnmerged = listOutput('git', ['diff', '--name-only', '--diff-filter=U']);
      if (!laterUnmerged.length) throw new Error(`A later upstream commit failed without unmerged paths: ${commit}`);
      writeFileSync(minimalStatePath(), `conflict:${index}\n`, 'utf8');
      return;
    }
  }
  const patch = git(['diff', '--cached', '--binary', '--full-index'], true);
  writeFileSync(minimalPatchHashPath(), `${sha256Text(patch)}\n`, 'utf8');
  writeFileSync(minimalStatePath(), 'complete\n', 'utf8');
}

function changedPaths(): string[] {
  const tracked = listOutput('git', ['diff', '--name-only']);
  const staged = listOutput('git', ['diff', '--cached', '--name-only']);
  const untracked = listOutput('git', ['ls-files', '--others', '--exclude-standard']);
  return [...new Set([...tracked, ...staged, ...untracked])].filter((path) => !path.startsWith('.nightly-')).sort();
}

function untrackedIntegrationPaths(): string[] {
  return listOutput('git', ['ls-files', '--others', '--exclude-standard']).filter((path) => !path.startsWith('.nightly-'));
}

function isProtectedPath(path: string): boolean {
  return PROTECTED_PATHS.has(path);
}

function listNonBuildIgnoredFiles(): string[] {
  const output = run('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', '.', ':(exclude)node_modules/*', ':(exclude).next/*'], {
    capture: true,
  });
  return output.split('\0').filter(Boolean);
}

function stageIntegrationChanges(): void {
  git(['add', '-A', '--', '.', ':(exclude).nightly-*']);
}

function verifyAndPackage(): void {
  const report = parseReport();
  const expectedCommits = readFileSync(trustedCommitsPath(), 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const expectedFiles = readFileSync(trustedFilesPath(), 'utf8').trim().split(/\r?\n/).filter(Boolean);
  if (readFileSync(WORKSPACE_COMMITS_PATH, 'utf8') !== readFileSync(trustedCommitsPath(), 'utf8'))
    throw new Error('Copilot modified the upstream commit inventory');
  if (readFileSync(WORKSPACE_FILES_PATH, 'utf8') !== readFileSync(trustedFilesPath(), 'utf8')) throw new Error('Copilot modified the upstream file inventory');
  if (JSON.stringify(report.reviewedCommits) !== JSON.stringify(expectedCommits)) throw new Error('Copilot did not review every upstream commit');
  if (JSON.stringify(report.reviewedFiles) !== JSON.stringify(expectedFiles)) throw new Error('Copilot did not review every upstream file');

  const proChangedFiles = changedPaths();
  const untrackedFiles = untrackedIntegrationPaths();
  if (untrackedFiles.length) throw new Error(`Copilot created non-upstream untracked files: ${untrackedFiles.join(', ')}`);
  const expectedFileSet = new Set(expectedFiles);
  const extraChangedFiles = proChangedFiles.filter((path) => !expectedFileSet.has(path));
  const reportedExtraFiles = report.extraFiles.map((item) => item.path).sort();
  if (new Set(reportedExtraFiles).size !== reportedExtraFiles.length || JSON.stringify(reportedExtraFiles) !== JSON.stringify(extraChangedFiles)) {
    throw new Error('Copilot report extraFiles must exactly match paths changed outside the upstream file set');
  }
  if (extraChangedFiles.length > 5) throw new Error('Minimal integration may not add more than five extra files');
  for (const path of extraChangedFiles) {
    if (/(?:^|\/)(?:__tests__\/|[^/]+\.(?:test|spec)\.[^/]+$)/.test(path)) throw new Error(`Copilot added its own test outside the upstream file set: ${path}`);
  }
  for (const path of proChangedFiles) {
    if (isProtectedPath(path)) throw new Error(`Copilot modified protected automation path: ${path}`);
  }
  const ignoredFiles = listNonBuildIgnoredFiles();
  if (ignoredFiles.length) {
    throw new Error('Copilot created ignored files that cannot be packaged safely');
  }
  if (report.status === 'changes_applied' && proChangedFiles.length === 0) throw new Error('Report claims changes but the Pro tree is unchanged');
  if (report.status === 'no_changes_required' && proChangedFiles.length !== 0) throw new Error('Report claims no changes but the Pro tree changed');

  if (git(['rev-parse', 'HEAD'], true) !== env('EXPECTED_PRO_HEAD')) throw new Error('Head changed during Copilot integration');
  const unmerged = listOutput('git', ['diff', '--name-only', '--diff-filter=U']);
  const cherryPickHead = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD']);
  if (unmerged.length || cherryPickHead.status === 0) throw new Error('Copilot left the cherry-pick unresolved');
  if (readFileSync(minimalStatePath(), 'utf8').trim() !== 'complete') throw new Error('Trusted minimal integration did not complete');
  if (git(['diff', '--name-only'], true)) throw new Error('Copilot edited files after trusted cherry-pick completion');
  const stagedPatchHash = sha256Text(git(['diff', '--cached', '--binary', '--full-index'], true));
  if (stagedPatchHash !== readFileSync(minimalPatchHashPath(), 'utf8').trim()) {
    throw new Error('Minimal integration patch changed after trusted cherry-pick');
  }

  const statusBeforeInstall = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], true);
  run('npm', ['ci']);
  if (git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], true) !== statusBeforeInstall) {
    throw new Error('git status changed during npm ci');
  }
  run(resolveBin('tsc'), ['--noEmit', '--pretty']);
  run(resolveBin('tsc'), ['--noEmit', '--pretty', '-p', 'tools/tsconfig.json']);
  run(resolveBin('eslint'), ['.']);
  const verificationBin = trustedPath('nightly-verification-bin');
  mkdirSync(verificationBin, { recursive: true });
  if (process.platform !== 'win32' && existsSync('/usr/bin/pwsh')) symlinkSync('/usr/bin/pwsh', resolve(verificationBin, 'powershell.exe'));
  run('npm', ['run', 'test:private-pro-tools'], { env: { ...process.env, PATH: `${verificationBin}:${process.env.PATH ?? ''}` } });
  run(resolveBin('tsx'), ['--test', 'src/**/*.test.ts'], { env: { ...process.env, NODE_ENV: 'development' } });
  run(resolveBin('next'), ['build'], { env: { ...process.env, NODE_ENV: 'production' } });
  git(['checkout', '--', 'next-env.d.ts']);

  if (JSON.stringify(changedPaths()) !== JSON.stringify(proChangedFiles)) {
    throw new Error('Verification commands changed the integration file set');
  }
  stageIntegrationChanges();
  git(['diff', '--cached', '--check']);
  for (const line of listOutput('git', ['diff', '--cached', '--raw', '--no-abbrev'])) {
    const match = /^:\d{6} (\d{6}) /.exec(line);
    if (!match || !['000000', '100644', '100755'].includes(match[1])) throw new Error(`Unsupported git mode in integration patch: ${line}`);
  }

  git(['diff', '--cached', '--binary', '--full-index', '--output', PATCH_PATH]);
  if (statSync(PATCH_PATH).size > MAX_PATCH_BYTES) throw new Error('Integration patch exceeds the 50 MiB safety bound');
  const manifest: IntegrationManifest = {
    automationSourceSha: assertSha(env('AUTOMATION_SOURCE_SHA'), 'AUTOMATION_SOURCE_SHA'),
    expectedProHead: assertSha(env('EXPECTED_PRO_HEAD'), 'EXPECTED_PRO_HEAD'),
    previousUpstreamHead: assertSha(env('PREVIOUS_UPSTREAM_HEAD'), 'PREVIOUS_UPSTREAM_HEAD'),
    upstreamHead: assertSha(env('UPSTREAM_HEAD'), 'UPSTREAM_HEAD'),
    reportSha256: sha256(REPORT_PATH),
    patchSha256: sha256(PATCH_PATH),
    proChangedFiles: proChangedFiles.length,
  };
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  appendSummary(`- Pro files changed: ${proChangedFiles.length}\n- Verification: passed\n`);
}

function readManifest(): IntegrationManifest {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as IntegrationManifest;
  assertSha(manifest.automationSourceSha, 'manifest automationSourceSha');
  assertSha(manifest.expectedProHead, 'manifest expectedProHead');
  assertSha(manifest.previousUpstreamHead, 'manifest previousUpstreamHead');
  assertSha(manifest.upstreamHead, 'manifest upstreamHead');
  if (!/^[0-9a-f]{64}$/.test(manifest.reportSha256) || !/^[0-9a-f]{64}$/.test(manifest.patchSha256)) {
    throw new Error('Manifest digest is invalid');
  }
  if (!Number.isInteger(manifest.proChangedFiles) || manifest.proChangedFiles < 0) throw new Error('Manifest file count is invalid');
  return manifest;
}

function publish(): void {
  const manifest = readManifest();
  if (assertSha(env('AUTOMATION_SOURCE_SHA'), 'AUTOMATION_SOURCE_SHA') !== manifest.automationSourceSha) {
    throw new Error('Trusted automation source does not match the integration manifest');
  }
  if (sha256(REPORT_PATH) !== manifest.reportSha256 || sha256(PATCH_PATH) !== manifest.patchSha256) {
    throw new Error('Integration artifact digest mismatch');
  }
  if (git(['rev-parse', 'HEAD'], true) !== manifest.expectedProHead) throw new Error('Pro moved before publish checkout');
  const allowedPublishArtifacts = new Set([PATCH_PATH, REPORT_PATH, MANIFEST_PATH]);
  const unexpectedStatus = git(['status', '--porcelain', '--untracked-files=all'], true)
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => !allowedPublishArtifacts.has(line.replace(/^\?\?\s+/, '')) && !line.slice(3).startsWith('.trusted-automation/'));
  if (unexpectedStatus.length) throw new Error(`Trusted publish checkout is dirty: ${unexpectedStatus.join(', ')}`);

  const report = parseReport();
  if (manifest.proChangedFiles > 0) {
    git(['apply', '--index', '--binary', '--whitespace=error-all', PATCH_PATH]);
  }
  if (listOutput('git', ['diff', '--cached', '--name-only']).some(isProtectedPath)) {
    throw new Error('Packaged patch modifies protected automation paths');
  }

  const subject = manifest.proChangedFiles > 0 ? 'Pro: integrate upstream main updates' : 'Pro: record upstream main checkpoint';
  const body =
    `${report.summary.trim()}\n\nIntegrated upstream main range ${manifest.previousUpstreamHead}..${manifest.upstreamHead}.\n\n` +
    `${CHECKPOINT_TRAILER}: ${manifest.upstreamHead}`;
  git(['commit', '--allow-empty', '-m', subject, '-m', body]);
  git(['push', `--force-with-lease=refs/heads/pro:${manifest.expectedProHead}`, 'origin', 'HEAD:refs/heads/pro']);
  appendSummary(`- Published Pro commit: \`${git(['rev-parse', 'HEAD'], true)}\`\n`);
}

function main(): void {
  const command = process.argv[2];
  if (command === 'prepare') prepare();
  else if (command === 'apply-minimal') applyMinimal();
  else if (command === 'finish-minimal') finishMinimal();
  else if (command === 'verify-package') verifyAndPackage();
  else if (command === 'publish') publish();
  else throw new Error('Usage: nightly-pro-integration.ts <prepare|apply-minimal|finish-minimal|verify-package|publish>');
}

const isEntrypoint = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isEntrypoint) main();
