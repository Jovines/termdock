// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRecentCommitHistory } from './recentCommitHistory.js';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'td-history-')); dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  const read = (query = '', skip = 0, limit = 30) => readRecentCommitHistory(async (args) => {
    try { return git(...args); } catch (error: any) { error.code = error.status; throw error; }
  }, { query, skip, limit });
  return { git, read };
}
it('classifies actual ancestry across divergence, search, pagination and sync', async () => {
  const { git, read } = repo();
  git('commit', '--allow-empty', '-m', 'shared');
  git('branch', 'remote'); git('branch', '--set-upstream-to=remote');
  git('commit', '--allow-empty', '-m', 'local-only');
  git('checkout', 'remote'); git('commit', '--allow-empty', '-m', 'remote-only'); git('checkout', 'main');
  const result = await read();
  for (const [message, status] of [['shared', 'synced'], ['local-only', 'ahead'], ['remote-only', 'behind']]) {
    const row = result.commits.find((line) => line.endsWith(message))!;
    expect(row).toBeTruthy(); expect(result.commitSyncStatus[row.split(' ')[0]]).toBe(status);
  }
  const searched = await read('remote-only');
  expect(Object.values(searched.commitSyncStatus)).toEqual(['behind']);
  const first = await read('', 0, 1); const second = await read('', 1, 1);
  expect(first.hasMore).toBe(true); expect(second.commits[0]).not.toBe(first.commits[0]);
  const hash = searched.commits[0].split(' ')[0];
  expect((await read(hash)).commits).toEqual(searched.commits);
  git('merge', 'remote', '--no-edit');
  expect(Object.values((await read('remote-only')).commitSyncStatus)).toEqual(['synced']);
  git('branch', '-f', 'remote', 'HEAD');
  expect(new Set(Object.values((await read()).commitSyncStatus))).toEqual(new Set(['synced']));
});
it('handles empty repositories, no upstream and detached HEAD without claiming sync', async () => {
  const { git, read } = repo();
  expect((await read()).commits).toEqual([]);
  git('commit', '--allow-empty', '-m', 'local');
  expect((await read()).commitSyncStatus).toEqual({});
  git('checkout', '--detach');
  expect((await read()).commitSyncStatus).toEqual({});
});
it('propagates failures instead of marking unknown commits synced', async () => {
  await expect(readRecentCommitHistory(async () => { throw new Error('timeout'); }, { skip: 0, limit: 30, query: '' })).rejects.toThrow('timeout');
});
