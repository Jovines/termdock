import { execFile } from 'child_process';
import { promisify } from 'util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildInteractiveColorEnvironment,
  buildTmuxColorEnvironmentCommands,
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
});
