import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('./supervisionHandoff.ts', import.meta.url));
const stub = fileURLToPath(new URL('./__fixtures__/supervisedServerStub.mjs', import.meta.url));
async function until<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for handoff');
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  await exit;
}

async function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-handoff-'));
  const old = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(old, 'spawn');
  const portFile = path.join(directory, 'port');
  // Match the existing supervisor process harness: isolated per-child home,
  // never read or write the production supervisor state.
  const child = spawn(process.execPath, ['--import', 'tsx', script, JSON.stringify({
    parentPid: old.pid,
    config: {
      childEntry: stub, childArgs: ['--port-file', portFile],
      healthUrl: 'http://127.0.0.1:1/health',
      timing: { healthIntervalMs: 60_000, backoffBaseMs: 20 },
    },
  })], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, HOME: directory } });
  let error = '';
  child.stderr?.on('data', data => { error += data; });
  const ready = await once(child, 'message');
  expect(ready[0], error).toEqual({ type: 'handoff-ready' });
  const statePath = path.join(directory, '.termdock/supervisor.json');
  const readState = () => {
    try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return undefined; }
  };
  return { directory, old, child, portFile, readState };
}

describe('supervision handoff with real processes', () => {
  it('does not replace the service when the request is never committed', async () => {
    const h = await setup();
    try {
      expect(fs.existsSync(h.portFile)).toBe(false);
      const exited = once(h.child, 'exit');
      h.child.disconnect();
      await exited;
      expect(h.old.exitCode).toBeNull();
      expect(fs.existsSync(h.portFile)).toBe(false);
    } finally {
      await stop(h.child); await stop(h.old);
      fs.rmSync(h.directory, { recursive: true, force: true });
    }
  });

  it('waits for the old process to exit, then supervises and recovers from SIGKILL', async () => {
    const h = await setup();
    try {
      h.child.send({ type: 'handoff-commit' });
      h.child.disconnect();
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(fs.existsSync(h.portFile)).toBe(false);
      await stop(h.old);
      const first = await until(() => { const s = h.readState(); return s?.phase === 'running' ? s : undefined; });
      expect(first.pid).toBe(h.child.pid);
      process.kill(first.serverPid, 'SIGKILL');
      const recovered = await until(() => { const s = h.readState(); return s?.phase === 'running' && s.serverPid !== first.serverPid ? s : undefined; });
      expect(recovered.restarts).toBe(1);
    } finally {
      await stop(h.child); await stop(h.old);
      fs.rmSync(h.directory, { recursive: true, force: true });
    }
  });
});
