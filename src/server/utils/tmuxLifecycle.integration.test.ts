import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const supported = process.platform !== 'win32';

async function tmux(socket: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('tmux', ['-L', socket, ...args], { timeout: 5_000 });
  return stdout;
}

async function waitForClient(socket: string, sessionName: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const clients = await tmux(socket, ['list-clients', '-t', sessionName, '-F', '#{client_pid}']);
      if (clients.trim()) return;
    } catch { /* attach is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`tmux client did not attach to ${sessionName}`);
}

describe.skipIf(!supported)('tmux lifecycle stress', () => {
  it('keeps unrelated sessions alive across repeated focus and teardown cycles', async () => {
    const socket = `termdock-stress-${process.pid}-${Date.now()}`;
    try {
      await tmux(socket, ['new-session', '-d', '-s', 'survivor-a']);
      await tmux(socket, ['new-session', '-d', '-s', 'survivor-b']);
      await tmux(socket, ['set-option', '-g', 'focus-events', 'off']);
      const serverPid = (await tmux(socket, ['display-message', '-p', '#{pid}'])).trim();

      for (let index = 0; index < 12; index += 1) {
        const target = `churn-${index}`;
        await tmux(socket, ['new-session', '-d', '-s', target]);
        const client = spawn('script', [
          '-qefc', `tmux -L ${socket} attach-session -t ${target}`, '/dev/null',
        ], { stdio: ['pipe', 'ignore', 'ignore'] });
        await waitForClient(socket, target);
        client.stdin.write('\u001b[I\u001b[O');
        await tmux(socket, ['set-option', '-g', 'focus-events', 'off']);
        await tmux(socket, ['detach-client', '-s', target]);
        await tmux(socket, ['kill-session', '-t', target]);
        client.stdin.end();

        expect((await tmux(socket, ['display-message', '-p', '#{pid}'])).trim()).toBe(serverPid);
        const survivors = (await tmux(socket, ['list-sessions', '-F', '#{session_name}'])).trim().split('\n').sort();
        expect(survivors).toEqual(['survivor-a', 'survivor-b']);
      }
    } finally {
      await tmux(socket, ['kill-server']).catch(() => undefined);
    }
  }, 15_000);
});
