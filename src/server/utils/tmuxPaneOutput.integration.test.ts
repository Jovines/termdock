// @vitest-environment node
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn as spawnPty, type IPty } from 'node-pty';
import { expect, it, vi } from 'vitest';
import { TerminalOutputActivity } from './terminalOutputActivity.js';
import { TmuxPaneOutputObserver } from './tmuxPaneOutput.js';
const exec = promisify(execFile);
it.skipIf(process.platform === 'win32')('ignores attach/reconnect/resize repaint, observes real writes without any browser, and preserves the grid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'td-pane-output-'));
  const socket = join(root, 'tmux.sock');
  const run = async (args: string[]) => (await exec('tmux', ['-S', socket, ...args], { timeout: 5000 })).stdout;
  const script = join(root, 'quiet.mjs');
  let observer: TmuxPaneOutputObserver | undefined, display: IPty | undefined, child: ChildProcess | undefined;
  const transitions: boolean[] = [], raw = vi.fn();
  const activity = new TerminalOutputActivity(active => transitions.push(active));
  try {
    await writeFile(script, "process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write('OLD_BEFORE_ATTACH\\n'); process.stdin.on('data',()=>process.stdout.write('ACTUAL_NEW_OUTPUT\\n'));\n");
    await run(['-f', '/dev/null', 'new-session', '-d', '-s', 'quiet', '-x', '120', '-y', '40', `${process.execPath} ${script}`]);
    await run(['set-option', '-t', 'quiet', 'status', 'off']);
    await vi.waitFor(async () => expect(await run(['capture-pane', '-p', '-t', 'quiet:0'])).toContain('OLD_BEFORE_ATTACH'));
    const initialSize = (await run(['display-message', '-p', '-t', 'quiet:0', '#{pane_width}x#{pane_height}'])).trim();
    const start = () => {
      observer = new TmuxPaneOutputObserver('tmux', '=quiet', () => { raw(); activity.record(); }, () => {}, (_binary, args, options) => {
        child = spawn('tmux', ['-S', socket, ...args], options); return child;
      });
      observer.start();
    };
    const attached = () => vi.waitFor(async () => expect(await run(['list-clients', '-t', 'quiet', '-F', '#{client_pid} #{client_flags}'])).toContain(`${child!.pid} `));
    start(); await attached();
    expect((await run(['display-message', '-p', '-t', 'quiet:0', '#{pane_width}x#{pane_height}'])).trim()).toBe(initialSize);
    expect(await run(['list-clients', '-t', 'quiet', '-F', '#{client_flags}'])).toContain('ignore-size');
    const painted: string[] = [];
    const env = { ...process.env }; delete env.TMUX; delete env.TMUX_PANE;
    display = spawnPty('tmux', ['-S', socket, 'attach-session', '-f', 'ignore-size', '-t', '=quiet'], { name: 'xterm-256color', cols: 120, rows: 40, env });
    display.onData(data => painted.push(data));
    await vi.waitFor(() => expect(painted.join('')).toContain('OLD_BEFORE_ATTACH'));
    const before = painted.length; display.resize(100, 35);
    await vi.waitFor(() => expect(painted.length).toBeGreaterThan(before));
    display.resize(120, 40);
    await new Promise(resolve => setTimeout(resolve, 700));
    expect(raw).not.toHaveBeenCalled(); expect(transitions).toEqual([]);
    observer!.dispose(); start(); await attached();
    await new Promise(resolve => setTimeout(resolve, 200)); expect(raw).not.toHaveBeenCalled();
    // Actual pane output still reaches the backend with no browser/display attached.
    display.kill(); display = undefined;
    await run(['send-keys', '-t', 'quiet:0', '-l', 'a']); await vi.waitFor(() => expect(raw).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 200)); await run(['send-keys', '-t', 'quiet:0', '-l', 'b']);
    await vi.waitFor(() => expect(transitions).toEqual([true]), { timeout: 2000 });
    // Output from a hidden window belongs to this same terminal session too.
    await run(['new-window', '-d', '-t', 'quiet', '-n', 'hidden', `${process.execPath} ${script}`]);
    await vi.waitFor(async () => expect(await run(['capture-pane', '-p', '-t', 'quiet:hidden'])).toContain('OLD_BEFORE_ATTACH'));
    await new Promise(resolve => setTimeout(resolve, 100));
    const count = raw.mock.calls.length;
    await run(['send-keys', '-t', 'quiet:hidden', '-l', 'c']);
    await vi.waitFor(() => expect(raw.mock.calls.length).toBeGreaterThan(count));
    expect((await run(['display-message', '-p', '-t', 'quiet:0', '#{pane_width}x#{pane_height}'])).trim()).toBe(initialSize);
  } finally {
    activity.dispose(); observer?.dispose(); display?.kill();
    await run(['kill-server']).catch(() => {}); await rm(root, { recursive: true, force: true });
  }
}, 10_000);
