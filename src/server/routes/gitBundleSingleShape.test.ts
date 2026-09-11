import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

vi.mock('../utils/authProtection.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/authProtection.js')>(),
  isAuthEnabled: () => false,
  isSessionValid: () => true,
}));

import router from './filesystem.js';

async function call(cwd: string, includeNested: boolean): Promise<any> {
  const app = express();
  app.use('/api/fs', router);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const res = await fetch(`http://127.0.0.1:${port}/api/fs/git-bundle?cwd=${encodeURIComponent(cwd)}&includeNested=${includeNested}&refresh=true`);
  const body = await res.json();
  await new Promise<void>((r) => server.close(() => r()));
  return body;
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-single-shape-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\n');
  git('add', '.');
  git('commit', '-m', 'init');
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'new\n');
  return dir;
}

describe('single-repo git bundle repository shape', () => {
  it('carries the per-repo untrackedDeferred flag the client reads', async () => {
    const dir = makeRepo();
    const single = await call(dir, false);
    const repository = single.repositories?.[0];
    expect(repository).toBeTruthy();
    // The client re-fetches untracked files only when the flag appears on the
    // repository; an absent key means "nothing was deferred" and the untracked
    // half of the change list never arrives.
    expect(repository).toHaveProperty('untrackedDeferred');
    expect(repository.untrackedDeferred).toBe(false);
    expect(single.untrackedDeferred).toBe(false);
    expect(repository.files.map((f: any) => f.path).sort()).toEqual(['tracked.txt', 'untracked.txt']);
  }, 60_000);

  it('matches the nested payload field-for-field on a workspace with no nested repos', async () => {
    const dir = makeRepo();
    const single = await call(dir, false);
    const nested = await call(dir, true);
    const singleRepo = single.repositories[0];
    const nestedRepo = nested.repositories[0];
    expect(Object.keys(singleRepo).sort()).toEqual(Object.keys(nestedRepo).sort());
    expect(single.files.map((f: any) => f.path).sort()).toEqual(nested.files.map((f: any) => f.path).sort());
    expect(singleRepo.files.map((f: any) => f.path).sort()).toEqual(nestedRepo.files.map((f: any) => f.path).sort());
  }, 60_000);
});
