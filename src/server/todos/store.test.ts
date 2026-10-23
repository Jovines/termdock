import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TodoStore } from './store.js';
import { TodoRunner, todoPrompt, type TodoRuntime } from './routes.js';
import type { TodoLaunchConfig } from './types.js';
let directory: string, file: string, store: TodoStore;
const config: TodoLaunchConfig = { agentSlug: 'fixture', command: 'fixture', cwd: '/tmp', prompt: '按用户要求处理' };
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-todos-')); file = path.join(directory, 'todos.json'); store = new TodoStore(file); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); });
it('deduplicates injection durably by source/external ID, rejects mismatched request replay and unsafe links', () => {
  const a = store.create({ title: '检查项目依赖', source: '项目巡检', externalId: 'deps', idempotencyKey: 'one' });
  expect(store.create({ title: '改动标题', source: '项目巡检', externalId: 'deps' }).id).toBe(a.id);
  expect(new TodoStore(file).create({ title: '检查项目依赖', source: '项目巡检', externalId: 'deps', idempotencyKey: 'one' }).id).toBe(a.id);
  expect(() => store.create({ title: '不同内容', idempotencyKey: 'one' })).toThrow('内容不一致');
  expect(store.create({ title: '另一个方向', source: '技术动态', externalId: 'deps' }).id).not.toBe(a.id);
  expect(() => store.create({ title: '危险链接', sourceUrl: 'javascript:alert(1)' })).toThrow('链接');
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});
it('protects edits with revisions and keeps completion independent of explicit Agent reports', () => {
  const todo = store.create({ title: '修复输入' });
  const first = store.begin('execute', todo.id, config, 'first').run;
  store.mark(first.id, { status: 'delivered', sessionId: 'session-one' });
  const second = store.begin('execute', todo.id, config, 'second').run;
  store.report(first.id, 'complete', '旧一轮的结果');
  expect(store.run(second.id).status).toBe('launching');
  expect(store.get(todo.id).status).toBe('open');
  store.report(second.id, 'blocked', '缺少必要信息');
  store.mark(second.id, { status: 'delivered' });
  expect(store.run(second.id)).toMatchObject({ status: 'blocked', result: '缺少必要信息' });
  const completed = store.update(todo.id, { revision: todo.revision, status: 'completed' });
  expect(() => store.update(todo.id, { revision: todo.revision, title: '覆盖' })).toThrow('已更新');
  expect(() => store.begin('execute', todo.id, config, 'third')).toThrow('重新打开');
  expect(store.get(todo.id)).toEqual(completed);
});
it('reserves a launch before side effects, replays its key once, and records failures with a recoverable terminal', async () => {
  const todo = store.create({ title: '真实启动边界' });
  let release!: () => void;
  const runtime: TodoRuntime = { validate: vi.fn(async c => c), launch: vi.fn(async (_run, _prompt, session) => { session('created-terminal'); await new Promise<void>(r => { release = r; }); throw new Error('Agent 未启动'); }) };
  const runner = new TodoRunner(store, runtime);
  const [first, second] = await Promise.all([runner.start('execute', todo.id, config, 'same'), runner.start('execute', todo.id, config, 'same')]);
  expect(first.id).toBe(second.id); expect(runtime.launch).toHaveBeenCalledOnce();
  expect(store.run(first.id)).toMatchObject({ status: 'launching', sessionId: 'created-terminal' });
  await expect(runner.start('execute', todo.id, config, 'different')).rejects.toThrow('正在启动');
  release(); await vi.waitFor(() => expect(store.run(first.id).status).toBe('failed'));
  expect(store.run(first.id).error).toBe('Agent 未启动');
  expect(store.get(todo.id).status).toBe('open');
});
it('does not blindly replay an unconfirmed launch after restart and preserves its session link', () => {
  const todo = store.create({ title: '断电恢复' }); const run = store.begin('execute', todo.id, config, 'launch').run;
  store.mark(run.id, { sessionId: 'surviving' }); store = new TodoStore(file);
  expect(store.run(run.id)).toMatchObject({ status: 'failed', sessionId: 'surviving' });
  expect(store.begin('execute', todo.id, config, 'launch')).toMatchObject({ fresh: false, run: { id: run.id, status: 'failed' } });
});
it('runs multiple scheduled directions independently, advances schedules and injects actionable CLI guidance', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-23T00:00:00Z'));
  const a = store.saveCollector({ name: '项目巡检', config, schedule: { kind: 'interval', everyMinutes: 1 } });
  const b = store.saveCollector({ name: '技术动态', config, schedule: { kind: 'interval', everyMinutes: 1 } });
  store.saveCollector({ name: '停用方向', config, schedule: { kind: 'interval', everyMinutes: 1 }, enabled: false });
  vi.advanceTimersByTime(60_001);
  const runtime: TodoRuntime = { validate: async c => c, launch: vi.fn(async () => {}) }; const runner = new TodoRunner(store, runtime);
  await runner.tick(); await runner.tick();
  expect(runtime.launch).toHaveBeenCalledTimes(2);
  expect(store.snapshot().runs.map(r => r.collectorId)).toEqual([a.id, b.id]);
  expect(store.due()).toHaveLength(0);
  const prompt = todoPrompt(store, store.snapshot().runs[0]);
  expect(prompt).toContain(`--collector ${a.id}`); expect(prompt).toContain('td todo add'); expect(prompt).toContain('本轮不执行');
  const injected = store.create({ title: '巡检结果', collectorId: a.id, externalId: 'stable' });
  expect(injected.source).toBe('项目巡检');
});
it('fails closed on corrupt persistent data without overwriting it', () => {
  fs.writeFileSync(file, '{broken'); expect(() => new TodoStore(file)).toThrow(); expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
});
it('records scheduled validation failures for the user and does not spin on the same due time', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  store.saveCollector({ name: '已移除的 Agent', config, schedule: { kind: 'interval', everyMinutes: 1 } });
  vi.advanceTimersByTime(60_001);
  const runner = new TodoRunner(store, { validate: async () => { throw new Error('Agent 不可用'); }, launch: vi.fn() });
  await runner.tick(); await runner.tick();
  expect(store.snapshot().runs).toHaveLength(1);
  expect(store.snapshot().runs[0]).toMatchObject({ status: 'failed', error: 'Agent 不可用' });
});
it('allows an already-launched collector to finish injection after its direction is removed', () => {
  const c = store.saveCollector({ name: '临时方向', config });
  store.begin('collect', c.id, config, 'start');
  store.removeCollector(c.id, store.collector(c.id).revision);
  expect(store.create({ title: '迟到的收集结果', collectorId: c.id }).source).toBe('临时方向');
});
