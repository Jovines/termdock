import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TodoStore } from './store.js';
import { TodoRunner, todoRoutes, type TodoRuntime } from './routes.js';
let directory: string, store: TodoStore, runner: TodoRunner, runtime: TodoRuntime, server: Server, base: string;
const config = { agentSlug: 'codex', command: 'codex', cwd: '/repo', prompt: '' };
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-handoff-')); store = new TodoStore(path.join(directory, 'todos.json'));
  runtime = { validate: vi.fn(async value => value), target: vi.fn(async id => { if (id !== 'existing') throw new Error('目标会话不可用'); return { config, name: '已有项目会话' }; }),
    deliver: vi.fn(async () => {}), launch: vi.fn(async (_run, _prompt, callback) => callback('new-session')) };
  runner = new TodoRunner(store, runtime);
  const app = express(); app.use(express.json()); app.use('/todos', todoRoutes(store, runner, runtime));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.on('listening', resolve)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}/todos`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); });
const post = async (body: unknown) => { const response = await fetch(base + '/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
it('sends a batch and optional instruction once to an existing session without a new launch or report protocol', async () => {
  const todos = ['检查输入法', '检查上传'].map(title => store.create({ title, description: title + '的背景', sourceUrl: 'https://example.com/reference' }));
  const input = { todoIds: todos.map(todo => todo.id), sessionId: 'existing', note: '先分析，不要改代码', idempotencyKey: 'batch-once' };
  const [one, two] = await Promise.all([post(input), post(input)]);
  expect(one.status).toBe(200); expect(two.body.run.id).toBe(one.body.run.id);
  await vi.waitFor(() => expect(store.run(one.body.run.id).status).toBe('delivered'));
  expect(runtime.launch).not.toHaveBeenCalled(); expect(runtime.deliver).toHaveBeenCalledOnce();
  const prompt = vi.mocked(runtime.deliver!).mock.calls[0][1];
  for (const text of ['检查输入法', '检查上传', '先分析，不要改代码', 'https://example.com/reference']) expect(prompt).toContain(text);
  expect(prompt).not.toContain('td todo report'); expect(todos.every(todo => store.get(todo.id).status === 'open')).toBe(true);
  expect((await post({ ...input, note: '不同要求' })).status).toBe(409);
  vi.mocked(runtime.target!).mockRejectedValue(new Error('会话已关闭'));
  expect((await post(input)).body.run.id).toBe(one.body.run.id);
});
it('creates one session for a batch and keeps the exact recipient and note for later navigation', async () => {
  const todo = store.create({ title: '单项' });
  const sent = await post({ todoIds: [todo.id], config, note: '', idempotencyKey: 'new-once' });
  await vi.waitFor(() => expect(store.run(sent.body.run.id).status).toBe('delivered'));
  expect(store.run(sent.body.run.id)).toMatchObject({ sessionId: 'new-session', handoff: { todoIds: [todo.id], note: '', targetSessionId: null } });
  expect(runtime.target).not.toHaveBeenCalled(); expect(runtime.launch).toHaveBeenCalledOnce();
});
it('rejects invalid targets and closed todos before any terminal input, retaining failed intents without automatic replay', async () => {
  const todo = store.create({ title: '事项' });
  const input = { todoIds: [todo.id], sessionId: 'missing', note: '', idempotencyKey: 'missing' };
  expect((await post(input)).status).toBe(400); expect(store.snapshot().runs).toHaveLength(0);
  vi.mocked(runtime.deliver!).mockRejectedValue(new Error('目标已切换'));
  const sent = await post({ ...input, sessionId: 'existing', idempotencyKey: 'failed' });
  await vi.waitFor(() => expect(store.run(sent.body.run.id).status).toBe('failed'));
  await post({ ...input, sessionId: 'existing', idempotencyKey: 'failed' }); expect(runtime.deliver).toHaveBeenCalledOnce();
  store.update(todo.id, { revision: 1, status: 'completed' });
  expect((await post({ ...input, sessionId: 'existing', idempotencyKey: 'closed' })).status).toBe(409);
  expect((await post({ ...input, note: 'x'.repeat(4001) })).status).toBe(400);
});
it('does not replay an uncertain send after restarting the store', async () => {
  const todo = store.create({ title: '恢复' });
  const input = { todoIds: [todo.id], sessionId: 'existing', note: '原要求', idempotencyKey: 'uncertain' };
  store.beginHandoff(input, config, '目标');
  const reopened = new TodoStore(path.join(directory, 'todos.json'));
  const retry = await new TodoRunner(reopened, runtime).handoff(input);
  expect(retry.status).toBe('failed'); expect(runtime.deliver).not.toHaveBeenCalled(); expect(runtime.launch).not.toHaveBeenCalled();
});
