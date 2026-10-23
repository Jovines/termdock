// @vitest-environment node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { parseTmuxLayout, readTmuxLayout, readTmuxLayouts } from './tmuxLayoutReader.js';

const row = (overrides: Record<number, string> = {}) => Object.assign([
  '10', '$1', 'sample', '@1', 'window', '0', '1', '%1', '0', '1', '80', '24', '0', '0', 'sh', '100', '/dev/pts/1', 'title', '0', '/work with spaces',
], overrides).join('\x1f');
it('gets server, active window, copy mode, and all panes in one exact-name read-only query', async () => {
  const run = vi.fn(async (_args: string[]) => row({ 18: '1' }));
  expect(await readTmuxLayout(run, 'sample')).toMatchObject({ serverPid: 10, sessionId: '$1', activeWindowId: '@1', activePaneId: '%1', inCopyMode: true,
    windows: [{ name: 'window', panes: [{ id: '%1', currentPath: '/work with spaces' }] }] });
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]![0]).toEqual(['list-panes', '-s', '-t', '=sample:', '-F', expect.any(String)]);
});
it.each([
  '', 'invalid', row({ 0: '' }), row({ 2: 'another' }), row({ 9: '0' }), row({ 15: '0' }),
  row() + '\n' + row(), row() + '\n' + row({ 0: '20', 7: '%2' }), row() + '\n' + row({ 1: '$2', 7: '%2' }),
])('rejects missing, conflicting, or ambiguous layout identities', stdout => {
  expect(() => parseTmuxLayout(stdout, 'sample')).toThrow();
});

const exec = promisify(execFile);
it.skipIf(process.platform === 'win32')('matches real split/window state without adding clients, resizing, input or changing processes', async () => {
  const socket = `td-layout-${process.pid}-${Date.now()}`;
  const run = async (args: string[]) => (await exec('tmux', ['-L', socket, ...args], { timeout: 5000 })).stdout;
  try {
    await run(['new-session', '-d', '-s', 'sample', '-x', '93', '-y', '31', '/bin/sleep', '120']);
    await run(['new-session', '-d', '-s', 'sample-more', '/bin/sleep', '120']);
    await run(['rename-window', '-t', '=sample:', '窗口 ; spaces']);
    await run(['split-window', '-h', '-t', '=sample:', '/bin/sleep', '120']);
    await run(['new-window', '-t', '=sample:', '-n', 'second', '/bin/sleep', '120']);
    const before = await run(['list-panes', '-s', '-t', '=sample:', '-F', '#{pane_id}|#{pane_pid}|#{pane_width}|#{pane_height}|#{pane_current_command}']);
    const clients = await run(['list-clients', '-F', '#{client_pid}']);
    let queries = 0;
    const layout = await readTmuxLayout(async args => { queries++; return run(args); }, 'sample');
    expect(queries).toBe(1); expect(layout.windows).toHaveLength(2);
    expect(layout.windows.map(window => window.panes.length)).toEqual([2, 1]);
    expect(layout.windows[0]!.name).toBe('窗口 ; spaces');
    expect(layout.activeWindowId).toBe(layout.windows[1]!.id);
    expect(layout.activePaneId).toBe(layout.windows[1]!.panes[0]!.id);
    expect(layout.serverPid).toBe(Number((await run(['display-message', '-p', '#{pid}'])).trim()));
    const all = await readTmuxLayouts(run);
    expect([...all.keys()].sort()).toEqual(['sample', 'sample-more']);
    expect(all.get('sample')).toEqual(layout);
    await run(['copy-mode', '-t', layout.activePaneId]);
    expect((await readTmuxLayout(run, 'sample')).inCopyMode).toBe(true);
    expect(await run(['list-clients', '-F', '#{client_pid}'])).toBe(clients);
    expect(await run(['list-panes', '-s', '-t', '=sample:', '-F', '#{pane_id}|#{pane_pid}|#{pane_width}|#{pane_height}|#{pane_current_command}'])).toBe(before);
    await expect(readTmuxLayout(run, 'sam')).rejects.toThrow();
    await run(['kill-session', '-t', '=sample']);
    await expect(readTmuxLayout(run, 'sample')).rejects.toThrow();
  } finally { await run(['kill-server']).catch(() => {}); }
}, 10000);
