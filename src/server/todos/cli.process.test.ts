import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import { expect, it, vi } from 'vitest';
import { TodoStore } from './store.js';
import { todoRoutes, TodoRunner, type TodoRuntime } from './routes.js';

it('injects and deduplicates through the actual CLI, local credential and HTTP routes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-todo-cli-'));
  const state = path.join(directory, '.termdock'); fs.mkdirSync(state);
  const store = new TodoStore(path.join(state, 'todos.json'));
  const runtime: TodoRuntime = { validate: async config => config, launch: vi.fn(async () => {}) };
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { if (req.header('X-Termdock-Local-Token') !== 'todo-cli-fixture') { res.sendStatus(401); return; } next(); });
  app.use('/api/terminal/operations/todos', todoRoutes(store, new TodoRunner(store, runtime), runtime));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.on('listening', resolve));
  const preload = path.join(directory, 'preload.mjs');
  fs.writeFileSync(preload, "import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.homedir = () => process.env.TD_TODO_TEST_DIRECTORY; syncBuiltinESMExports();");
  fs.writeFileSync(path.join(state, 'server.json'), JSON.stringify({ pid: process.pid, host: '127.0.0.1', scheme: 'http', port: (server.address() as { port: number }).port, localApiToken: 'todo-cli-fixture' }), { mode: 0o600 });
  const run = () => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', preload, '--import', 'tsx', path.resolve('src/server/cli.ts'), 'todo', 'add', '--title', '项目巡检待办', '--source', '外部工具', '--external-id', 'stable', '--stdin'], { env: { ...process.env, TD_TODO_TEST_DIRECTORY: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill(), 8000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); }); child.stdin.end('外部程序传入的背景与处理要求');
  });
  try {
    const first = await run(), second = await run();
    expect(first.code).toBe(0); expect(first.stderr).toBe(''); expect(second.code).toBe(0);
    const a = JSON.parse(first.stdout), b = JSON.parse(second.stdout);
    expect(a.todo.id).toBe(b.todo.id); expect(store.snapshot().todos).toHaveLength(1);
    expect(store.snapshot().todos[0]).toMatchObject({ source: '外部工具', description: '外部程序传入的背景与处理要求' });
    expect(runtime.launch).not.toHaveBeenCalled();
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); }
}, 20000);
