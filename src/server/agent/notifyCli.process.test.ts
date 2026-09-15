import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('runs the actual CLI with detected and explicit identity and preserves failure receipts', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-notify-cli-'));
  fs.mkdirSync(path.join(directory, '.termdock'));
  const requests: Array<{ url: string; token: string; body: unknown }> = [];
  let status = 200;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url!, token: String(req.headers['x-termdock-local-token']), body: JSON.parse(body) });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: status === 200, code: status === 409 ? 'NO_CONNECTED_CLIENT' : undefined }));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(path.join(directory, '.termdock/server.json'), JSON.stringify({ pid: process.pid, host: '127.0.0.1', scheme: 'http', port: (server.address() as { port: number }).port, localApiToken: 'test-token' }));
    const preload = path.join(directory, 'preload.mjs');
    fs.writeFileSync(preload, "import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.homedir = () => process.env.TERMDOCK_NOTIFY_TEST_DIRECTORY; syncBuiltinESMExports();");
    const run = (args: string[]) => new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', preload, '--import', 'tsx', fileURLToPath(new URL('../cli.ts', import.meta.url)), 'notify', ...args], {
        env: { ...process.env, TERMDOCK_NOTIFY_TEST_DIRECTORY: directory, TERMDOCK_BACKEND_SESSION_ID: 'backend', TERMDOCK_COLLAB_SESSION_ID: '', TMUX_PANE: '' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = ''; const timer = setTimeout(() => child.kill(), 10000);
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve({ code, stdout }); });
    });
    expect((await run(['测试通过'])).code).toBe(0);
    expect(requests[0]).toEqual({ url: '/api/terminal/operations/notify', token: 'test-token', body: { backendSessionId: 'backend', message: '测试通过' } });
    status = 409;
    const offline = await run(['等待确认', '--session', 'explicit', '--title', '进展']);
    expect(offline.code).toBe(1);
    expect(JSON.parse(offline.stdout)).toMatchObject({ ok: false, code: 'NO_CONNECTED_CLIENT' });
    expect(requests[1].body).toEqual({ sessionId: 'explicit', message: '等待确认', title: '进展' });
    fs.unlinkSync(path.join(directory, '.termdock/server.json'));
    const help = await run(['--help']);
    expect(help.code).toBe(0); expect(help.stdout).toContain('Usage: td notify');
    expect(requests).toHaveLength(2);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
