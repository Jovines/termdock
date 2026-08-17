import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { GitApplyError, buildGitApplyArgs, runGitApply, validateHunkPatch } from './hunkApply.js';

const GIT_ENV = {
  ...process.env,
  // Isolate from the developer's global/system git config (init.defaultBranch,
  // aliases, hooks) so tests behave the same everywhere.
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

const APPLY_TIMEOUT_MS = 10_000;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
}

function initRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hunk-apply-test-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  const lines = Array.from({ length: 30 }, (_, i) => `line-${i + 1}`);
  fs.writeFileSync(path.join(root, 'file.txt'), `${lines.join('\n')}\n`);
  git(root, ['add', 'file.txt']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

// Two well-separated edits so `git diff` yields exactly two hunks.
function makeTwoHunkChange(root: string): void {
  const file = path.join(root, 'file.txt');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines[2] = 'change-one';
  lines[25] = 'change-two';
  fs.writeFileSync(file, lines.join('\n'));
}

// Same extraction the client performs: file header + one hunk's lines.
function extractHunkPatch(diffText: string, hunkIndex: number): string {
  const lines = diffText.split('\n');
  const hunkStarts = lines
    .map((line, index) => (line.startsWith('@@ ') ? index : -1))
    .filter((index) => index >= 0);
  if (hunkIndex >= hunkStarts.length) throw new Error(`hunk ${hunkIndex} not found`);
  const headerEnd = hunkStarts[0];
  const start = hunkStarts[hunkIndex];
  const end = hunkIndex + 1 < hunkStarts.length ? hunkStarts[hunkIndex + 1] : lines.length;
  return [...lines.slice(0, headerEnd), ...lines.slice(start, end)].join('\n');
}

function worktreeDiff(root: string): string {
  return git(root, ['diff', '--', 'file.txt']);
}

function stagedDiff(root: string): string {
  return git(root, ['diff', '--cached', '--', 'file.txt']);
}

describe('buildGitApplyArgs', () => {
  it('maps modes to git apply flags', () => {
    expect(buildGitApplyArgs('stage')).toEqual(['apply', '--cached']);
    expect(buildGitApplyArgs('revert-worktree')).toEqual(['apply', '-R']);
    expect(buildGitApplyArgs('revert-staged')).toEqual(['apply', '-R', '--cached']);
  });
});

describe('validateHunkPatch', () => {
  const patch = [
    'diff --git a/file.txt b/file.txt',
    'index 0000000..1111111 100644',
    '--- a/file.txt',
    '+++ b/file.txt',
    '@@ -1,3 +1,3 @@',
    ' line-1',
    '-line-2',
    '+change-one',
    ' line-3',
    '',
  ].join('\n');

  it('accepts a patch confined to the requested pathspec', () => {
    expect(validateHunkPatch(patch, 'file.txt')).toEqual({ ok: true });
  });

  it('rejects patches touching other files', () => {
    expect(validateHunkPatch(patch, 'other.txt').ok).toBe(false);
  });

  it('rejects empty patches and patches without hunks', () => {
    expect(validateHunkPatch('', 'file.txt').ok).toBe(false);
    const noHunk = patch.split('@@ ')[0];
    const result = validateHunkPatch(noHunk, 'file.txt');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('no hunks');
  });

  it('rejects patches missing file headers', () => {
    const result = validateHunkPatch('@@ -1 +1 @@\n-a\n+b\n', 'file.txt');
    expect(result.ok).toBe(false);
  });

  it('accepts new-file patches (/dev/null old side)', () => {
    const newFile = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+hello',
      '',
    ].join('\n');
    expect(validateHunkPatch(newFile, 'new.txt')).toEqual({ ok: true });
  });

  it('rejects rename patches whose header escapes the pathspec', () => {
    const rename = patch.replace('+++ b/file.txt', '+++ b/evil.txt');
    expect(validateHunkPatch(rename, 'file.txt').ok).toBe(false);
  });

  it('handles git C-style quoted paths', () => {
    const quoted = patch
      .replace('--- a/file.txt', '--- "a/weird\\tname.txt"')
      .replace('+++ b/file.txt', '+++ "b/weird\\tname.txt"');
    expect(validateHunkPatch(quoted, 'weird\tname.txt')).toEqual({ ok: true });
    expect(validateHunkPatch(quoted, 'file.txt').ok).toBe(false);
  });
});

describe('runGitApply', () => {
  let root: string;

  beforeEach(() => {
    root = initRepo();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('stages a single hunk into the index', async () => {
    makeTwoHunkChange(root);
    const patch = extractHunkPatch(worktreeDiff(root), 0);
    expect(validateHunkPatch(patch, 'file.txt')).toEqual({ ok: true });

    await runGitApply(root, 'stage', patch, APPLY_TIMEOUT_MS);

    const staged = stagedDiff(root);
    expect(staged).toContain('change-one');
    expect(staged).not.toContain('change-two');
    // The other hunk is still worktree-only.
    const unstaged = worktreeDiff(root);
    expect(unstaged).toContain('change-two');
    expect(git(root, ['status', '--porcelain', '--', 'file.txt'])).toMatch(/^MM /);
  });

  it('reverts a single hunk in the worktree', async () => {
    makeTwoHunkChange(root);
    const patch = extractHunkPatch(worktreeDiff(root), 0);

    await runGitApply(root, 'revert-worktree', patch, APPLY_TIMEOUT_MS);

    const content = fs.readFileSync(path.join(root, 'file.txt'), 'utf8');
    expect(content).not.toContain('change-one');
    expect(content).toContain('change-two');
    const remaining = worktreeDiff(root);
    expect(remaining).toContain('change-two');
    expect(remaining).not.toContain('change-one');
  });

  it('reverts a staged hunk in the index only', async () => {
    makeTwoHunkChange(root);
    const patch = extractHunkPatch(worktreeDiff(root), 0);
    git(root, ['add', 'file.txt']);

    await runGitApply(root, 'revert-staged', patch, APPLY_TIMEOUT_MS);

    const staged = stagedDiff(root);
    expect(staged).toContain('change-two');
    expect(staged).not.toContain('change-one');
    // The worktree still carries both edits, so hunk one reappears as unstaged.
    const unstaged = worktreeDiff(root);
    expect(unstaged).toContain('change-one');
    expect(unstaged).not.toContain('change-two');
  });

  it('fails with the git stderr when the patch is stale', async () => {
    makeTwoHunkChange(root);
    const patch = extractHunkPatch(worktreeDiff(root), 0);
    // Drift the index: `git apply --cached` matches context against the
    // index, so stage a conflicting edit around the hunk's context lines.
    const file = path.join(root, 'file.txt');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines[1] = 'drifted-context';
    lines[3] = 'drifted-context-too';
    fs.writeFileSync(file, lines.join('\n'));
    git(root, ['add', 'file.txt']);

    await expect(runGitApply(root, 'stage', patch, APPLY_TIMEOUT_MS)).rejects.toBeInstanceOf(GitApplyError);
    await expect(runGitApply(root, 'stage', patch, APPLY_TIMEOUT_MS)).rejects.toThrow(/does not match|failed/i);
  });
});
