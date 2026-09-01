import { execFile } from 'child_process';
import { promisify } from 'util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildInteractiveColorEnvironment,
  buildTmuxColorEnvironmentCommands,
  ensureTmuxColorCapabilities,
  TERMDOCK_TRUECOLOR_FEATURE_SLOT,
} from './terminalColorEnvironment.js';

const execFileAsync = promisify(execFile);
const sockets: string[] = [];

async function tmux(socket: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { stdout } = await execFileAsync('tmux', ['-L', socket, ...args], {
    env,
    timeout: 5000,
    maxBuffer: 256 * 1024,
  });
  return stdout;
}

afterEach(async () => {
  await Promise.all(sockets.splice(0).map((socket) =>
    tmux(socket, ['kill-server'], buildInteractiveColorEnvironment(process.env)).catch(() => undefined)));
});

describe('tmux interactive color environment', () => {
  it('removes a poisoned shared-server NO_COLOR before spawning a pane', async () => {
    const socket = `termdock-color-${process.pid}-${Date.now()}`;
    sockets.push(socket);
    await tmux(socket, ['new-session', '-d', '-s', 'seed'], { ...process.env, NO_COLOR: '1' });
    await expect(tmux(socket, ['show-environment', '-g', 'NO_COLOR']))
      .resolves.toContain('NO_COLOR=1');

    const cleanEnv = buildInteractiveColorEnvironment({ ...process.env, NO_COLOR: '1' });
    for (const args of buildTmuxColorEnvironmentCommands()) {
      await tmux(socket, args, cleanEnv);
    }
    await tmux(socket, [
      'new-session', '-d', '-s', 'target',
      "sh -c 'if printenv NO_COLOR >/dev/null; then echo polluted; else echo clean; fi; sleep 2'",
    ], cleanEnv);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const output = await tmux(socket, ['capture-pane', '-p', '-t', 'target'], cleanEnv);
    expect(output).toContain('clean');
    expect(output).not.toContain('polluted');
  });

  it('applies the Termdock truecolor contract idempotently', async () => {
    const socket = `termdock-rgb-${process.pid}-${Date.now()}`;
    sockets.push(socket);
    await tmux(socket, [
      '-f', '/dev/null',
      'new-session', '-d', '-s', 'target',
      '-e', 'TERM=tmux-256color',
    ]);

    const run = async (args: string[]) => { await tmux(socket, args); };
    await ensureTmuxColorCapabilities(run, 'target', 'tmux-256color');
    await ensureTmuxColorCapabilities(run, 'target', 'tmux-256color');

    await expect(tmux(socket, ['show-options', '-sv', TERMDOCK_TRUECOLOR_FEATURE_SLOT]))
      .resolves.toBe('xterm-256color:RGB\n');
    await expect(tmux(socket, ['show-options', '-v', '-t', 'target', 'default-terminal']))
      .resolves.toBe('tmux-256color\n');
    await expect(tmux(socket, ['show-environment', '-t', 'target', 'TERM']))
      .resolves.toContain('TERM=tmux-256color');
  });
});
