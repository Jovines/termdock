import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { CollaborationStore } from './collaborationStore.js';
import { CollaborationRoutingStore } from './collaborationRouting.js';
import { resolveCollaborationSessionId } from './sessionBindingRecovery.js';

it.each([
  { mode: 'stale backend', args: ['status'], explicit: false, invalid: false },
  { mode: 'detached status', args: ['--session', 'original-peer', 'status'], explicit: true, invalid: false },
  { mode: 'detached rebind', args: ['rebind', '--session', 'original-peer', '--pane', '%173'], explicit: true, invalid: false },
  { mode: 'unknown explicit identity', args: ['status', '--session', 'missing-peer'], explicit: false, invalid: true },
])('resolves collaboration identity: $mode', async ({ args, explicit, invalid }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-cli-upgrade-'));
  const stateDirectory = path.join(directory, '.termdock');
  fs.mkdirSync(stateDirectory);
  const groupsFile = path.join(stateDirectory, 'collaboration-groups.json');
  const legacy = JSON.stringify({ version: 1, groups: [{ id: 'original-group', name: 'Original team', sessionIds: ['original-peer', 'other'], createdAt: 1, updatedAt: 1 }], messages: [] });
  fs.writeFileSync(groupsFile, legacy);
  const store = new CollaborationStore(groupsFile);
  const routing = new CollaborationRoutingStore(path.join(stateDirectory, 'collaboration-routing.json'));
  routing.bind({ sessionId: 'original-peer', backendSessionId: 'replacement-backend', mode: 'tmux', tmuxSessionName: 'original-tmux', agentSlug: null, nativeSessionId: null, pane: null });
  const records = [{ sessionId: 'original-peer', backendSessionId: null, tmuxSessionName: null }];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const context = req.method === 'POST' ? JSON.parse(body) : Object.fromEntries(new URL(req.url!, 'http://localhost').searchParams);
    const id = resolveCollaborationSessionId(context, records, routing);
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = id ? 200 : 404;
    res.end(JSON.stringify(id ? { groups: store.groupsForSession(id), source: { sessionId: id } } : { code: 'SESSION_NOT_FOUND' }));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(path.join(stateDirectory, 'server.json'), JSON.stringify({ pid: process.pid, host: '127.0.0.1', scheme: 'http', port: (server.address() as { port: number }).port, localApiToken: 'isolated-test-token' }));
    const preload = path.join(directory, 'preload.mjs');
    fs.writeFileSync(preload, "import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.homedir = () => process.env.TERMDOCK_COLLAB_TEST_DIRECTORY; syncBuiltinESMExports();");
    const tmux = path.join(directory, 'tmux-fixture');
    fs.writeFileSync(tmux, '#!/usr/bin/env node\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["display-message", "-p", "-t", "%7", "#S"])) process.exit(1);\nconsole.log("original-tmux");\n', { mode: 0o700 });
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', preload, '--import', 'tsx', fileURLToPath(new URL('../cli.ts', import.meta.url)), 'collab', ...args], {
        env: { ...process.env, TERMDOCK_COLLAB_TEST_DIRECTORY: directory, TERMDOCK_COLLAB_SESSION_ID: '', TERMDOCK_BACKEND_SESSION_ID: explicit ? '' : 'obsolete-backend', TMUX: explicit ? '' : 'isolated', TMUX_PANE: explicit ? '' : '%7', TMUX_BIN: tmux },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = ''; let stderr = '';
      const timer = setTimeout(() => child.kill(), 10_000);
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    if (invalid) {
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ code: 'SESSION_NOT_FOUND' });
      return;
    }
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ groups: [{ id: 'original-group' }], source: { sessionId: 'original-peer' } });
    expect(fs.readFileSync(groupsFile, 'utf8')).toBe(legacy);
    expect(resolveCollaborationSessionId({ backendSessionId: 'obsolete-backend' }, records, routing)).toBeNull();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);

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
    const timeout = await run(['send', 'peer', 'task', '--wait-until', 'delivered', '--timeout', '100ms']);
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
