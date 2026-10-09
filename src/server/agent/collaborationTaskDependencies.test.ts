import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CollaborationTask } from './collaborationTaskTypes.js';
const state = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async original => {
  const real = await original<typeof import('node:os')>();
  return { ...real, default: { ...real, homedir: () => state.home }, homedir: () => state.home };
});
const exec = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await exec('git', ['-C', cwd, ...args])).stdout.trim();
const id = () => randomBytes(16).toString('hex');
let dir: string, repo: string, base: string;
let prepare: typeof import('./collaborationTaskWorkspace.js').prepareTaskWorkspace;
const task = (): CollaborationTask => ({ id: id(), events: [{ kind: 'scheduled', id: id() }],
  workflow: { rootTaskId: id(), workType: 'code', isolated: true } } as CollaborationTask);
const report = (): CollaborationTask => ({ id: id(), title: '动线审查', status: 'accepted', acceptedArtifactId: 'report',
  artifacts: [{ id: 'report', kind: 'result', content: '已评审的发现与修改建议' }],
  workflow: { workType: 'read-only', isolated: false } } as CollaborationTask);
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'td-dependencies-')); state.home = dir;
  vi.resetModules(); ({ prepareTaskWorkspace: prepare } = await import('./collaborationTaskWorkspace.js'));
  repo = path.join(dir, 'repo'); await fs.mkdir(repo);
  await git(repo, ['init', '-b', 'main']); await git(repo, ['config', 'user.email', 'test@example.local']); await git(repo, ['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(repo, 'file'), 'base'); await git(repo, ['add', 'file']); await git(repo, ['commit', '-m', 'base']);
  base = await git(repo, ['rev-parse', 'HEAD']);
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); vi.resetModules(); });

it('prepares a code task after an accepted report without requiring or importing a report commit', async () => {
  const importer = vi.fn(); const workspace = await prepare(task(), repo, [report()], importer);
  expect(await git(workspace.cwd, ['rev-parse', 'HEAD'])).toBe(base); expect(importer).not.toHaveBeenCalled();
});
it('combines report context and real code dependencies while preserving the original dirty checkout', async () => {
  await git(repo, ['checkout', '-b', 'reviewed-code']); await fs.writeFile(path.join(repo, 'implementation'), 'reviewed code');
  await git(repo, ['add', 'implementation']); await git(repo, ['commit', '-m', 'code']); const commit = await git(repo, ['rev-parse', 'HEAD']);
  await git(repo, ['checkout', 'main']); await fs.writeFile(path.join(repo, 'file'), 'user edits'); await fs.writeFile(path.join(repo, 'untracked'), 'user file');
  const before = await git(repo, ['status', '--porcelain']);
  const code = { ...report(), title: '实施', workflow: { workType: 'code', isolated: true },
    artifacts: [{ id: 'report', kind: 'result', evidence: { commit } }] } as CollaborationTask;
  const workspace = await prepare(task(), repo, [report(), code]);
  expect(await fs.readFile(path.join(workspace.cwd, 'implementation'), 'utf8')).toBe('reviewed code');
  expect(await fs.readFile(path.join(workspace.cwd, 'file'), 'utf8')).toBe('base');
  expect(await git(repo, ['status', '--porcelain'])).toBe(before); expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(base);
});
it.each(['pending', 'missing-result', 'missing-code-commit'])('rejects %s before creating any worktree', async reason => {
  const dependency = report();
  if (reason === 'pending') dependency.status = 'open';
  if (reason === 'missing-result') dependency.artifacts = [];
  if (reason === 'missing-code-commit') dependency.workflow!.workType = 'code';
  await expect(prepare(task(), repo, [dependency])).rejects.toThrow(reason === 'missing-code-commit' ? '代码交付' : '尚未交付并验收');
  await expect(fs.stat(path.join(dir, '.termdock', 'task-workspaces'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('supports legacy report-only dependencies but does not relax legacy isolated code validation', async () => {
  const legacy = report(); delete legacy.workflow;
  expect((await prepare(task(), repo, [legacy])).base).toBe(base);
  legacy.workflow = { isolated: true } as CollaborationTask['workflow'];
  await expect(prepare(task(), repo, [legacy])).rejects.toThrow('代码交付');
});
