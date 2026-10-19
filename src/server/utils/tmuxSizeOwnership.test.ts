// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { claimTmuxSize } from './tmuxSizeOwnership.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { buildTmuxAttachArgs } from './tmuxClientCapabilities.js';

describe('tmux display size ownership', () => {
  it('transfers ownership between displays without touching an external terminal', async () => {
    const flags = new Map([['/dev/pts/1', true], ['/dev/pts/2', true], ['/dev/pts/3', false]]);
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'list-clients') return '11 /dev/pts/1\n22 /dev/pts/2\n33 /dev/pts/3\n';
      for (let i = 0; i < args.length; i += 6) flags.set(args[i + 2], args[i + 4] === 'ignore-size');
      return '';
    });
    const displays = new Set([11, 22]);
    await claimTmuxSize(run, 'shared', 11, displays);
    expect([...flags.values()]).toEqual([false, true, false]);
    await claimTmuxSize(run, 'shared', 22, displays);
    expect([...flags.values()]).toEqual([true, false, false]);
    expect(run.mock.calls[3][0]).toEqual([
      'refresh-client', '-t', '/dev/pts/1', '-f', 'ignore-size', ';',
      'refresh-client', '-t', '/dev/pts/2', '-f', '!ignore-size',
    ]);
  });

  it('does not transfer ownership when the selected display detached', async () => {
    const run = vi.fn(async () => '11 /dev/pts/1\n');
    await claimTmuxSize(run, 'shared', 22, new Set([11, 22]));
    expect(run).toHaveBeenCalledTimes(1);
    await claimTmuxSize(run, 'shared', undefined, new Set([11]));
    expect(run).toHaveBeenCalledTimes(1);
  });
});

it('keeps a real tmux window stable across idle client replies and transfers on interaction', async () => {
  const exec = promisify(execFile);
  const socket = `termdock-size-test-${randomUUID()}`;
  const run = async (args: string[]) => (await exec('tmux', ['-L', socket, ...args])).stdout;
  const pty = createRequire(import.meta.url)('node-pty') as typeof import('node-pty');
  const displays: import('node-pty').IPty[] = [];
  try {
    await run(['-f', '/dev/null', 'new-session', '-d', '-s', 'shared', '-x', '100', '-y', '30']);
    await run(['set-window-option', '-t', 'shared', 'window-size', 'latest']);
    await run(['set-option', '-t', 'shared', 'status', 'off']);
    for (const [cols, rows] of [[100, 30], [50, 20]]) {
      const args = buildTmuxAttachArgs('shared', true);
      const display = pty.spawn('tmux', ['-L', socket, ...args], {
        cols, rows, name: 'xterm-256color', env: { ...process.env, TMUX: '' },
      });
      display.onData(() => {});
      displays.push(display);
    }
    await vi.waitFor(async () => {
      const clients = await run(['list-clients', '-t', 'shared', '-F', '#{client_pid}']);
      expect(clients.trim().split('\n').length).toBe(2);
    });
    const pids = new Set(displays.map(display => display.pid));
    for (const [index, expected] of [[0, '100x30'], [1, '50x20'], [0, '100x30']] as const) {
      await claimTmuxSize(run, 'shared', displays[index].pid, pids);
      // Focus reports from both clients must never elect another size owner.
      for (let i = 0; i < 6; i++) {
        displays[1 - index].write('\x1b[I');
        await new Promise(resolve => setTimeout(resolve, 25));
        expect((await run(['display-message', '-p', '-t', 'shared', '#{window_width}x#{window_height}'])).trim()).toBe(expected);
      }
    }
  } finally {
    for (const display of displays) { try { display.kill(); } catch {} }
    await run(['kill-server']).catch(() => {});
  }
}, 15000);
