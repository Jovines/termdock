import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { executeTodoCommand, parseTodoCommand } from './cli.js';
import { TodoStore } from './store.js';
import { TodoRunner, todoRoutes, type TodoRuntime } from './routes.js';

let directory: string, store: TodoStore, runtime: TodoRuntime, server: Server, origin: string;
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-collector-cli-'));
  store = new TodoStore(path.join(directory, 'todos.json'));
  runtime = { validate: vi.fn(async config => {
    if (config.agentSlug !== 'fixture') throw new Error('Agent 不可用');
    if (!fs.statSync(config.cwd).isDirectory()) throw new Error('工作目录不可用');
    return config;
  }), launch: vi.fn(async () => {}) };
  const app = express(); app.use(express.json());
  app.get('/api/terminal/agent-launchers', (_req, res) => res.json({ agents: [{ slug: 'fixture', command: 'fixture --collect' }] }));
  app.use('/api/terminal/operations/todos', todoRoutes(store, new TodoRunner(store, runtime), runtime));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.on('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); });
function io() {
  return { request: vi.fn(async (method: 'GET' | 'POST', endpoint: string, body?: unknown) => {
    const response = await fetch(origin + endpoint, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { statusCode: response.status, body: await response.text() };
  }), stdin: vi.fn(), write: vi.fn() };
}
it('persists file-based channel requirements and daily scheduling, then exposes the same direction to the UI snapshot', async () => {
  const requirements = '从讨论中的渠道收集待办。附原始链接与上下文，使用稳定标识去重，只收集不执行。';
  const file = path.join(directory, 'requirements.txt'); fs.writeFileSync(file, requirements);
  const output = io();
  expect(await executeTodoCommand(parseTodoCommand(['collector', 'create', '--name', '社区渠道', '--agent', 'fixture', '--cwd', directory, '--file', file, '--at', '09:00', '--weekdays', '1,2,3,4,5']), output)).toBe(0);
  const collector = JSON.parse(output.write.mock.calls[0][0]).collector;
  expect(collector).toMatchObject({ name: '社区渠道', enabled: true, config: { agentSlug: 'fixture', command: 'fixture --collect', cwd: directory, prompt: requirements }, schedule: { kind: 'daily', time: '09:00', weekdays: [1, 2, 3, 4, 5] } });
  expect(collector.nextRunAt).toBeGreaterThan(Date.now());
  expect(await executeTodoCommand(parseTodoCommand(['collector', 'list']), output)).toBe(0);
  expect(JSON.parse(output.write.mock.calls[1][0]).collectors).toEqual([collector]);
  const snapshot = await (await fetch(origin + '/api/terminal/operations/todos')).json();
  expect(snapshot.collectors).toEqual([collector]); expect(snapshot.runs).toEqual([]);
  expect(new TodoStore(path.join(directory, 'todos.json')).snapshot().collectors).toEqual([collector]);
  expect(runtime.launch).not.toHaveBeenCalled();
});
it('keeps invalid directory and missing file failures from saving or launching a collector', async () => {
  const output = io();
  const args = ['collector', 'create', '--name', '无效方向', '--agent', 'fixture', '--command', 'fixture', '--cwd', path.join(directory, 'missing')];
  expect(await executeTodoCommand(parseTodoCommand([...args, '--prompt', '仅收集']), output)).toBe(1);
  expect(output.request).toHaveBeenCalledTimes(1);
  expect(await executeTodoCommand(parseTodoCommand([...args, '--file', path.join(directory, 'missing.txt')]), output)).toBe(1);
  expect(output.request).toHaveBeenCalledTimes(1);
  expect(store.snapshot().collectors).toEqual([]); expect(runtime.launch).not.toHaveBeenCalled();
});
