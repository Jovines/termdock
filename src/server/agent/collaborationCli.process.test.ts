import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('preserves real process timeout codes and drains large piped inbox JSON', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-cli-process-'));
  const server = http.createServer((req, res) => {
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url?.includes('/inbox')
      ? { messages: [{ id: 'large', content: 'evidence'.repeat(40_000) }], next_cursor: 'cursor', has_more: false }
      : { message_id: 'queued-message', thread_id: 'thread', status: 'pending' }));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    fs.mkdirSync(path.join(directory, '.termdock'));
    fs.writeFileSync(path.join(directory, '.termdock/server.json'), JSON.stringify({ pid: process.pid, host: '127.0.0.1', scheme: 'http', port: (server.address() as { port: number }).port, localApiToken: 'isolated-test-token' }));
    const preload = path.join(directory, 'preload.mjs');
    fs.writeFileSync(preload, "import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.homedir = () => process.env.TERMDOCK_COLLAB_TEST_DIRECTORY; syncBuiltinESMExports();");
    const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', preload, '--import', 'tsx', fileURLToPath(new URL('../cli.ts', import.meta.url)), 'collab', ...args], {
        env: { ...process.env, TERMDOCK_COLLAB_TEST_DIRECTORY: directory, TERMDOCK_BACKEND_SESSION_ID: 'generic', TMUX: '' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = ''; let stderr = '';
      const timer = setTimeout(() => child.kill(), 15_000);
      child.stdout.on('data', (value) => { stdout += value; }); child.stderr.on('data', (value) => { stderr += value; });
      child.on('error', reject); child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    const timeout = await run(['send', 'peer', 'task', '--wait-until', 'read', '--timeout', '100ms']);
    expect(timeout.stderr).toBe('');
    expect(timeout.code).toBe(2);
    expect(JSON.parse(timeout.stdout)).toMatchObject({ message_id: 'queued-message', code: 'WAIT_TIMEOUT' });
    const inbox = await run(['inbox']);
    expect(inbox.stderr).toBe(''); expect(inbox.code).toBe(0);
    expect(JSON.parse(inbox.stdout).messages[0].content.length).toBe(320_000);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
