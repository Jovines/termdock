import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TodoStore } from './store.js';
import { TodoRunner, todoRoutes, type TodoRuntime } from './routes.js';
import { createTodoWebhookRouter } from './webhook.js';
import { executeTodoCommand, parseTodoCommand } from './cli.js';
let directory: string, store: TodoStore, runner: TodoRunner, runtime: TodoRuntime, server: Server, origin: string;
const config = { agentSlug: 'fixture', command: 'fixture', cwd: '/tmp', prompt: '收集可执行事项' };
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-source-')); store = new TodoStore(path.join(directory, 'todos.json'));
  runtime = { validate: vi.fn(async c => c), launch: vi.fn(async (run, _prompt, created) => { created('new-' + run.id); }),
    target: vi.fn(async () => ({ name: '已有 Agent', config, mode: 'tmux' as const })), deliver: vi.fn(async () => {}),
    claimTarget: vi.fn(async input => ({ sessionId: input.sessionId ?? 'current-agent', name: '领取 Agent', config })) };
  runner = new TodoRunner(store, runtime);
  const app = express(); app.use('/hooks/todo', createTodoWebhookRouter(store, runner)); app.use(express.json());
  app.use('/api/terminal/operations/todos', todoRoutes(store, runner, runtime));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.on('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { vi.useRealTimers(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); });
async function post(suffix: string, body: unknown) {
  const response = await fetch(origin + '/api/terminal/operations/todos' + suffix, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
it('keeps collection manual by default and only dispatches new todos after explicit source configuration', async () => {
  const c = (await post('/collectors', { name: '代码', config })).data.collector;
  const old = (await post('', { title: '旧事项', collectorId: c.id })).data.todo;
  expect(runtime.launch).not.toHaveBeenCalled();
  await post('/collectors', { ...c, processing: { mode: 'new', config: { ...config, prompt: '' }, note: '先分析再修改' } });
  const created = await post('', { title: '新事项', collectorId: c.id, externalId: 'stable' });
  await vi.waitFor(() => expect(runtime.launch).toHaveBeenCalledOnce());
  expect(runtime.launch).toHaveBeenCalledWith(expect.objectContaining({ todoId: created.data.todo.id }), expect.stringContaining('先分析再修改'), expect.any(Function), undefined);
  await post('', { title: '重复注入', collectorId: c.id, externalId: 'stable' }); await runner.dispatchAutomatic();
  expect(runtime.launch).toHaveBeenCalledOnce(); expect(store.get(old.id).autoProcessing).toBeUndefined();
  const run = store.snapshot().runs[0]; expect(store.get(created.data.todo.id).autoProcessing).toMatchObject({ state: 'dispatched', runId: run.id });
  expect(store.get(created.data.todo.id).status).toBe('open');
});
it('dispatches to the configured existing session, and preserves a visible failure without opening a fallback Agent', async () => {
  const c = (await post('/collectors', { name: '资讯', config, processing: { mode: 'existing', sessionId: 'chosen', note: '只调研' } })).data.collector;
  await post('', { title: '已有会话处理', collectorId: c.id });
  await vi.waitFor(() => expect(runtime.deliver).toHaveBeenCalledOnce());
  expect(runtime.deliver).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'chosen' }), expect.stringContaining('只调研'), undefined);
  vi.mocked(runtime.target!).mockRejectedValueOnce(new Error('会话已关闭'));
  const failed = (await post('', { title: '不可发送', collectorId: c.id })).data.todo;
  await vi.waitFor(() => expect(store.get(failed.id).autoProcessing).toMatchObject({ state: 'failed', error: '会话已关闭' }));
  await runner.dispatchAutomatic(); expect(runtime.launch).not.toHaveBeenCalled(); expect(runtime.deliver).toHaveBeenCalledOnce();
});
it('atomically claims only an explicitly selected source and never sends a second prompt to its claiming Agent', async () => {
  const a = store.create({ title: '指定来源', source: '代码' }), b = store.create({ title: '其他来源', source: '资讯' });
  expect((await post('/claim', { sessionId: 'agent', requestId: 'unspecified' })).status).toBe(400);
  const results = await Promise.all(['one', 'two'].map(id => post('/claim', { source: '代码', sessionId: id, requestId: id })));
  expect(results.map(r => r.data.todo).filter(Boolean)).toHaveLength(1);
  const winner = results.find(r => r.data.todo)!;
  expect(winner.data.todo.id).toBe(a.id); expect(store.get(b.id).claim).toBeUndefined();
  expect(runtime.deliver).not.toHaveBeenCalled(); expect(runtime.launch).not.toHaveBeenCalled();
  expect(winner.data.run.handoff.sessionName).toBe('领取 Agent');
  expect((await post('/' + a.id + '/renew', { claimId: 'stale', minutes: 60 })).status).toBe(409);
  expect((await post('/' + a.id + '/renew', { claimId: winner.data.todo.claim.id, minutes: 60 })).data.todo.claim.expiresAt).toBeGreaterThan(winner.data.todo.claim.expiresAt);
  const current = store.get(a.id);
  expect((await post('/' + a.id + '/release', { revision: current.revision, claimId: 'stale' })).status).toBe(409);
  expect((await post('/' + a.id + '/release', { revision: current.revision, claimId: current.claim!.id })).status).toBe(200);
  expect((await post('/claim', { source: '代码', sessionId: 'other', requestId: 'retry' })).data.todo.id).toBe(a.id);
});
it('expires leases, fences stale retries and renewals, and persists a claim across service restart', async () => {
  const todo = store.create({ title: '领取持久化', source: '项目' });
  const input = { source: '项目', sessionId: 'agent', sessionName: 'Agent', config, leaseMinutes: 1, requestId: 'claim' };
  const first = store.claim(input); expect(store.claim(input).run!.id).toBe(first.run!.id);
  expect(new TodoStore(path.join(directory, 'todos.json')).get(todo.id).claim!.id).toBe(first.todo!.claim!.id);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
  expect(() => store.claim(input)).toThrow('原领取已结束或过期');
  const second = store.claim({ ...input, sessionId: 'other', requestId: 'second' }); expect(second.todo!.claim!.id).not.toBe(first.todo!.claim!.id);
  expect(() => store.renewClaim(todo.id, first.todo!.claim!.id, 1)).toThrow();
  expect(() => store.releaseClaim(todo.id, second.todo!.revision, first.todo!.claim!.id)).toThrow();
  vi.restoreAllMocks();
});
it('accepts authenticated JSON notifications with idempotency while denying disabled sources and wrong credentials', async () => {
  const c = (await post('/collectors', { name: '通知', config, webhook: { enabled: true } })).data.collector;
  async function notify(secret: string, event = 'event-1', body: unknown = { issue: 7 }) {
    const response = await fetch(origin + '/hooks/todo/' + c.id, { method: 'POST', headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json', 'Idempotency-Key': event }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  expect(c.webhook.secret.length).toBeGreaterThan(40);
  expect((await notify('wrong')).status).toBe(401); expect(runtime.launch).not.toHaveBeenCalled();
  const first = await notify(c.webhook.secret); expect(first.status).toBe(202);
  const duplicate = await notify(c.webhook.secret); expect(duplicate.data.runId).toBe(first.data.runId); expect(runtime.launch).toHaveBeenCalledOnce();
  expect(store.run(first.data.runId).config.command).toBe('fixture');
  expect(store.run(first.data.runId).config.prompt).toContain('"issue":7');
  expect((await notify(c.webhook.secret, 'event-1', { issue: 9 })).status).toBe(409);
  const latest = store.collector(c.id); store.saveCollector({ ...latest, enabled: false });
  expect((await notify(c.webhook.secret, 'event-2')).status).toBe(410); expect(runtime.launch).toHaveBeenCalledOnce();
});
it('lets CLI configure the same source, preserving fields and revisions, then claim and release its todos', async () => {
  const io = { request: async (method: 'GET' | 'POST', endpoint: string, body?: unknown) => {
    const response = await fetch(origin + endpoint, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { statusCode: response.status, body: await response.text() };
  }, stdin: vi.fn(), write: vi.fn() };
  io.stdin.mockResolvedValue(JSON.stringify({ name: 'CLI来源', config, session: { mode: 'reuse', beforePrompt: '/clear', idleMinutes: 10 }, webhook: { enabled: true } }));
  expect(await executeTodoCommand(parseTodoCommand(['collector', 'save', '--stdin']), io)).toBe(0);
  const c = JSON.parse(io.write.mock.calls.at(-1)![0]).collector;
  io.stdin.mockResolvedValue(JSON.stringify({ id: c.id, processing: { mode: 'existing', sessionId: 'chosen', note: '先调查' } }));
  expect(await executeTodoCommand(parseTodoCommand(['collector', 'save', '--stdin']), io)).toBe(0);
  expect(store.collector(c.id)).toMatchObject({ name: 'CLI来源', webhook: { enabled: true, secret: c.webhook.secret }, processing: { mode: 'existing', sessionId: 'chosen' }, session: { beforePrompt: '/clear' } });
  store.create({ title: '其他人工来源', source: '手动渠道' });
  expect(await executeTodoCommand(parseTodoCommand(['claim', '--source', '手动渠道', '--session', 'chosen']), io)).toBe(0);
  const claimed = JSON.parse(io.write.mock.calls.at(-1)![0]); expect(claimed.todo.source).toBe('手动渠道');
  expect(await executeTodoCommand(parseTodoCommand(['release', claimed.todo.id, '--claim', claimed.todo.claim.id]), io)).toBe(0);
  expect(store.get(claimed.todo.id).claim).toBeNull();
});
