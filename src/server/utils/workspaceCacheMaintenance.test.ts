// @vitest-environment node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneWorkspaceCaches } from './workspaceCacheMaintenance.js';

const exec = promisify(execFile), DAY = 24 * 60 * 60_000;
let home: string, workspace: string, profile: string, stateDirectory: string;
const children: ChildProcess[] = [];
const git = async (cwd: string, args: string[]) => exec('git', ['-C', cwd, ...args]);
describe.skipIf(process.platform !== 'linux')('managed Cargo cache cleanup', () => {
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'td-work-cache-')); stateDirectory = path.join(home, '.termdock');
    const repo = path.join(home, 'repo'); await fs.mkdir(repo);
    await git(repo, ['init']); await git(repo, ['config', 'user.email', 'test@example.local']); await git(repo, ['config', 'user.name', 'Test']);
    await fs.writeFile(path.join(repo, 'Cargo.toml'), '[package]\nname="fixture"\nversion="0.1.0"\n');
    await fs.writeFile(path.join(repo, '.gitignore'), 'target/\nnode_modules/\ndist/\n');
    await fs.writeFile(path.join(repo, 'source.txt'), 'original source');
    await git(repo, ['add', 'Cargo.toml', '.gitignore', 'source.txt']); await git(repo, ['commit', '-m', 'base']);
    const name = `${'a'.repeat(32)}-${'b'.repeat(8)}`;
    workspace = path.join(stateDirectory, 'task-workspaces', 'c'.repeat(32), name); await fs.mkdir(path.dirname(workspace), { recursive: true });
    await git(repo, ['worktree', 'add', '-b', `termdock/task/${name}`, workspace]);
    profile = path.join(workspace, 'target', 'debug'); await fs.mkdir(path.join(profile, 'deps'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'target', 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n# Cargo cache\n');
    await fs.writeFile(path.join(profile, '.cargo-lock'), '');
    await fs.writeFile(path.join(profile, 'deps', 'libfixture-0123456789abcdef.rmeta'), 'compiled metadata');
  });
  afterEach(async () => {
    for (const child of children.splice(0)) { const closed = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill(); await closed; }
    await fs.rm(home, { recursive: true, force: true });
  });
  const options = () => ({ stateDirectory, now: Date.now() + 8 * DAY });

  it('reclaims only old compiler intermediates while preserving source edits, unknown files and final binaries', async () => {
    await fs.writeFile(path.join(workspace, 'source.txt'), 'user edits');
    await fs.writeFile(path.join(workspace, 'notes.txt'), 'untracked user notes');
    await fs.writeFile(path.join(workspace, 'target', 'notes.txt'), 'keep even inside target');
    await fs.writeFile(path.join(profile, 'my-app'), 'final built application');
    const result = await pruneWorkspaceCaches(options());
    expect(result).toContainEqual(expect.objectContaining({ path: path.join(profile, 'deps'), action: 'removed' }));
    await expect(fs.stat(path.join(profile, 'deps'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(workspace, 'source.txt'), 'utf8')).toBe('user edits');
    expect(await fs.readFile(path.join(workspace, 'notes.txt'), 'utf8')).toBe('untracked user notes');
    expect(await fs.readFile(path.join(workspace, 'target', 'notes.txt'), 'utf8')).toBe('keep even inside target');
    expect(await fs.readFile(path.join(profile, 'my-app'), 'utf8')).toBe('final built application');
  });

  it('preserves unknown files, tracked files, symlinks, untagged caches and recent caches', async () => {
    const directory = path.join(profile, 'deps');
    await fs.writeFile(path.join(directory, 'notes.txt'), 'keep');
    expect((await pruneWorkspaceCaches(options())).some(item => item.action === 'removed')).toBe(false);
    await fs.unlink(path.join(directory, 'notes.txt'));
    const file = path.join(directory, 'libfixture-0123456789abcdef.rmeta');
    await git(workspace, ['add', '-f', path.relative(workspace, file)]);
    expect((await pruneWorkspaceCaches(options())).some(item => item.action === 'removed')).toBe(false);
    await git(workspace, ['reset', '--', path.relative(workspace, file)]);
    const outside = path.join(home, 'outside'); await fs.writeFile(outside, 'keep');
    await fs.symlink(outside, path.join(directory, 'liblinked-0123456789abcdef.rmeta'));
    expect((await pruneWorkspaceCaches(options())).some(item => item.action === 'removed')).toBe(false);
    expect(await fs.readFile(outside, 'utf8')).toBe('keep');
    await fs.unlink(path.join(directory, 'liblinked-0123456789abcdef.rmeta'));
    await fs.unlink(path.join(workspace, 'target', 'CACHEDIR.TAG'));
    expect((await pruneWorkspaceCaches(options())).some(item => item.action === 'removed')).toBe(false);
    await fs.writeFile(path.join(workspace, 'target', 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55');
    expect((await pruneWorkspaceCaches({ stateDirectory })).some(item => item.action === 'removed')).toBe(false);
  });

  it('skips a worktree in use by a real process', async () => {
    const child = spawn(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"], { cwd: workspace }); children.push(child);
    await new Promise<void>(resolve => child.stdout!.once('data', () => resolve()));
    const result = await pruneWorkspaceCaches(options());
    expect(result).toContainEqual(expect.objectContaining({ reason: 'workspace-in-use', action: 'retained' }));
    expect((await fs.stat(path.join(profile, 'deps'))).isDirectory()).toBe(true);
  });

  it('keeps recently read units inside a mixed cache while reclaiming only cold units', async () => {
    const old = path.join(profile, 'deps', 'libfixture-0123456789abcdef.rmeta');
    const recent = path.join(profile, 'deps', 'librecent-fedcba9876543210.rmeta');
    await fs.writeFile(recent, 'recently read metadata');
    const before = new Date(Date.now() - 10 * DAY);
    await fs.utimes(old, before, before);
    // An old mtime alone cannot turn a recently read dependency into garbage.
    await fs.utimes(recent, new Date(), before);
    const result = await pruneWorkspaceCaches({ stateDirectory });
    expect(result).toContainEqual(expect.objectContaining({ path: path.join(profile, 'deps'), action: 'removed', entriesRemoved: 1, entriesRetained: 1 }));
    await expect(fs.stat(old)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(recent, 'utf8')).toBe('recently read metadata');
  });

  it('honors Cargo locks and supports a preview without deleting any cache', async () => {
    const child = spawn('flock', ['-F', '-n', path.join(profile, '.cargo-lock'), process.execPath, '-e', "process.stdout.write('locked'); setInterval(() => {}, 1000)"]); children.push(child);
    await new Promise<void>(resolve => child.stdout!.once('data', () => resolve()));
    const locked = await pruneWorkspaceCaches(options());
    expect(locked).toContainEqual(expect.objectContaining({ reason: 'cargo-locked-or-check-unavailable', action: 'retained' }));
    const closed = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill(); await closed; children.splice(children.indexOf(child), 1);
    const preview = await pruneWorkspaceCaches({ ...options(), dryRun: true });
    expect(preview).toContainEqual(expect.objectContaining({ path: path.join(profile, 'deps'), action: 'would-remove' }));
    expect((await fs.stat(path.join(profile, 'deps'))).isDirectory()).toBe(true);
  });
});
