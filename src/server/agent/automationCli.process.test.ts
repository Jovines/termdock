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

it('creates a self automation through the real CLI with a stale backend and surviving tmux pane', async () => {
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
  let created: Record<string, unknown> | undefined;
  const server = http.createServer(async (req, res) => {
    expect(req.headers['x-termdock-local-token']).toBe('isolated-test-token');
    if (req.method === 'POST' && req.url === '/api/terminal/operations/automations') {
      let body = '';
      for await (const chunk of req) body += chunk;
      created = JSON.parse(body);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ automation: { ...created, id: 'created-task' } }));
      return;
    }
    const context = Object.fromEntries(new URL(req.url!, 'http://localhost').searchParams);
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
      const child = spawn(process.execPath, ['--import', preload, '--import', 'tsx', fileURLToPath(new URL('../cli.ts', import.meta.url)), 'automation', 'create', '--name', 'self review', '--every', '30', '--self', '--prompt', 'check team'], {
        env: { ...process.env, TERMDOCK_COLLAB_TEST_DIRECTORY: directory, TERMDOCK_BACKEND_SESSION_ID: 'obsolete-backend', TMUX: 'isolated', TMUX_PANE: '%7', TMUX_BIN: tmux },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = ''; let stderr = '';
      const timer = setTimeout(() => child.kill(), 10_000);
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ automation: { id: 'created-task', targetSessionId: 'original-peer' } });
    expect(created).toMatchObject({ name: 'self review', prompt: 'check team', enabled: true, schedule: { kind: 'interval', everyMinutes: 30 } });
    expect(fs.readFileSync(groupsFile, 'utf8')).toBe(legacy);
    expect(resolveCollaborationSessionId({ backendSessionId: 'obsolete-backend' }, records, routing)).toBeNull();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);

