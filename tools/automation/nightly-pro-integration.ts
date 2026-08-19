import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_UPSTREAM_URL = 'https://github.com/enricoros/big-AGI.git';
const CHECKPOINT_TRAILER = 'Upstream-Main-Integrated';
const REPORT_PATH = '.nightly-pro-integration-report.json';
const PATCH_PATH = '.nightly-pro-integration.patch';
const MANIFEST_PATH = '.nightly-pro-integration-manifest.json';
const PROTECTED_PATHS = new Set([
  '.gitmodules',
  'AGENTS.md',
  'CLAUDE.md',
  'tools/automation/nightly-pro-integration.ts',
  'tools/automation/nightly-pro-integration.test.ts',
  'tools/automation/sync-upstream-main.sh',
]);
const PROTECTED_PREFIXES = ['.github/', 'tools/automation/'];
const MAX_PATCH_BYTES = 50 * 1024 * 1024;

type IntegrationReport = {
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
  writeFileSync('.nightly-upstream-commits.txt', `${upstreamCommits.join('\n')}\n`, 'utf8');
  writeFileSync('.nightly-upstream-files.txt', `${upstreamFiles.join('\n')}\n`, 'utf8');

  const prompt =
    `Autonomously integrate upstream main commits ${previousUpstreamHead}..${upstreamHead} into the current customized pro working tree. ` +
    `Read CLAUDE.md first. Review every commit in .nightly-upstream-commits.txt and every path in .nightly-upstream-files.txt. ` +
    `Use only read-only git commands such as git status, log, show, diff, grep, rev-list, ls-files, and blame. ` +
    `Do not run merge, rebase, cherry-pick, checkout, switch, reset, commit, push, clean, restore, fetch, pull, add, rm, or mv through git. ` +
    `Semantically port every applicable upstream behavior while preserving all pro customizations, especially Private Pro security, encrypted vault, local persistence, analytics gates, recovery, backup restore, and cloud boundaries. ` +
    `Add or update tests for behavior you change. Do not weaken checks or modify the automation files. ` +
    `Write ${REPORT_PATH} as strict JSON with exactly these fields: status (changes_applied or no_changes_required), ` +
    `reviewedCommits (every SHA from .nightly-upstream-commits.txt in order), reviewedFiles (every path from .nightly-upstream-files.txt in order), ` +
    `and summary (a non-empty concise explanation). Use no markdown fences. ` +
    `If status is no_changes_required, explain why every upstream change was already present or inapplicable. ` +
    `This is unattended. Do not ask questions.`;
  writeFileSync('.nightly-copilot-prompt.txt', prompt, 'utf8');

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

function parseReport(): IntegrationReport {
  if (!existsSync(REPORT_PATH)) throw new Error(`Copilot did not create ${REPORT_PATH}`);
  const raw = JSON.parse(readFileSync(REPORT_PATH, 'utf8')) as Partial<IntegrationReport>;
  const keys = Object.keys(raw).sort();
  if (keys.join(',') !== 'reviewedCommits,reviewedFiles,status,summary') throw new Error('Copilot report has unexpected fields');
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

function changedPaths(): string[] {
  const tracked = listOutput('git', ['diff', '--name-only']);
  const staged = listOutput('git', ['diff', '--cached', '--name-only']);
  const untracked = listOutput('git', ['ls-files', '--others', '--exclude-standard']);
  return [...new Set([...tracked, ...staged, ...untracked])].filter((path) => !path.startsWith('.nightly-')).sort();
}

function isProtectedPath(path: string): boolean {
  return PROTECTED_PATHS.has(path) || PROTECTED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function listNonBuildIgnoredFiles(): string[] {
  const output = run('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], { capture: true });
  return output.split('\0').filter((path) => path && !path.startsWith('node_modules/') && !path.startsWith('.next/'));
}

function stageIntegrationChanges(): void {
  git(['add', '-A', '--', '.', ':(exclude).nightly-*']);
}

function verifyAndPackage(): void {
  const report = parseReport();
  const expectedCommits = readFileSync('.nightly-upstream-commits.txt', 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const expectedFiles = readFileSync('.nightly-upstream-files.txt', 'utf8').trim().split(/\r?\n/).filter(Boolean);
  if (JSON.stringify(report.reviewedCommits) !== JSON.stringify(expectedCommits)) throw new Error('Copilot did not review every upstream commit');
  if (JSON.stringify(report.reviewedFiles) !== JSON.stringify(expectedFiles)) throw new Error('Copilot did not review every upstream file');

  const proChangedFiles = changedPaths();
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

  const statusBeforeInstall = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], true);
  run('npm', ['ci']);
  if (git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], true) !== statusBeforeInstall) {
    throw new Error('git status changed during npm ci');
  }
  run(resolveBin('tsc'), ['--noEmit', '--pretty']);
  run(resolveBin('tsc'), ['--noEmit', '--pretty', '-p', 'tools/tsconfig.json']);
  run(resolveBin('eslint'), ['.']);
  run(resolveBin('tsx'), ['--test', 'tools/private-pro/**/*.test.ts']);
  run(resolveBin('tsx'), ['--test', 'src/**/*.test.ts'], { env: { ...process.env, NODE_ENV: 'development' } });
  run(resolveBin('next'), ['build']);

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
  const unexpectedStatus = git(['status', '--porcelain', '--untracked-files=all'], true)
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => !line.includes(' .nightly-pro-integration-') && !line.includes(' .trusted-automation/'));
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
  else if (command === 'verify-package') verifyAndPackage();
  else if (command === 'publish') publish();
  else throw new Error('Usage: nightly-pro-integration.ts <prepare|verify-package|publish>');
}

const isEntrypoint = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isEntrypoint) main();
