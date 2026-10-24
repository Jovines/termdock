import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectionSessionPolicy, TodoStore } from './store.js';
import { CollectionSessionLifecycle, type CollectionObservation, type CollectionSessionRuntime } from './sessionLifecycle.js';
let dir: string, store: TodoStore, runtime: CollectionSessionRuntime, lifecycle: CollectionSessionLifecycle, clock: number, fact: CollectionObservation | null;
const config = { agentSlug: 'codex', command: 'codex', cwd: '/tmp', prompt: '收集' };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-lifecycle-')); store = new TodoStore(path.join(dir, 'todos.json'));
  clock = 1_000_000; fact = { identity: 'runtime-1', ownershipIdentity: 'owner-1', lastOutputAt: clock, observedAt: clock };
  runtime = { observe: vi.fn(async () => fact && { ...fact, observedAt: clock }), reuse: vi.fn(async () => {}), close: vi.fn(async () => true) };
  lifecycle = new CollectionSessionLifecycle(store, runtime, () => clock);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
function owned(minutes = 10, mode: 'new' | 'reuse' = 'new') {
  const collector = store.saveCollector({ name: '巡检', config, session: { mode, targetSessionId: null, beforePrompt: '/clear', idleMinutes: minutes } });
  const run = store.begin('collect', collector.id, config, 'first').run;
  store.mark(run.id, { sessionId: 'terminal', status: 'delivered' }); return store.run(run.id);
}
it('uses ten minutes by default and validates timeout without silently truncating values', () => {
  expect(collectionSessionPolicy().idleMinutes).toBe(10);
  for (const idleMinutes of [-1, 1.5, NaN, '10', 43201]) expect(() => collectionSessionPolicy({ idleMinutes } as never)).toThrow();
  expect(collectionSessionPolicy({ idleMinutes: 0 }).idleMinutes).toBe(0);
});
it('waits ten minutes of observed silence, restarts on output, and preserves task/report history', async () => {
  const run = owned(); await lifecycle.recycle(); clock += 599_999; await lifecycle.recycle(); expect(runtime.close).not.toHaveBeenCalled();
  fact!.lastOutputAt = clock; clock += 2; await lifecycle.recycle(); expect(runtime.close).not.toHaveBeenCalled();
  clock += 600_000; await lifecycle.recycle(); expect(runtime.close).toHaveBeenCalledOnce();
  expect(store.run(run.id).collectionSession?.recycledAt).toBeGreaterThan(0); expect(store.collectionSessions().size).toBe(0);
  expect(store.run(run.id).status).toBe('delivered');
});
it('gives restarted or replaced runtimes a full observation period and never replays cleanup', async () => {
  const run = owned(); clock += 6_000_000; await lifecycle.recycle(); expect(runtime.close).not.toHaveBeenCalled();
  clock += 599_999; fact!.identity = 'replacement'; await lifecycle.recycle(); clock += 1; await lifecycle.recycle(); expect(runtime.close).not.toHaveBeenCalled();
  clock += 600_000; await lifecycle.recycle(); await lifecycle.recycle(); expect(runtime.close).toHaveBeenCalledOnce();
  store = new TodoStore(path.join(dir, 'todos.json')); expect(store.run(run.id).collectionSession?.recycledAt).toBeGreaterThan(0);
  lifecycle = new CollectionSessionLifecycle(store, runtime, () => clock); await lifecycle.recycle(); expect(runtime.close).toHaveBeenCalledOnce();
});
it('does not reclaim a user-selected target, disabled timeout, unknown output, or later handoff', async () => {
  const run = owned(0); await lifecycle.recycle(); clock += 900_000; await lifecycle.recycle(); expect(runtime.observe).not.toHaveBeenCalled();
  const user = store.saveCollector({ name: '自选', config, session: { mode: 'reuse', targetSessionId: 'normal', beforePrompt: '', idleMinutes: 1 } });
  const selected = store.begin('collect', user.id, config, 'user').run; store.mark(selected.id, { sessionId: 'normal', status: 'delivered' });
  expect(store.collectionSessions().has('normal')).toBe(false);
  const c = store.collector(run.collectorId!); store.saveCollector({ ...c, session: { ...c.session!, idleMinutes: 1 } });
  fact = null; await lifecycle.recycle(); clock += 900_000; await lifecycle.recycle(); expect(runtime.close).not.toHaveBeenCalled();
  fact = { identity: 'runtime', ownershipIdentity: 'owner-1', lastOutputAt: 0, observedAt: clock }; await lifecycle.recycle();
  const todo = store.create({ title: '用户工作' }); store.beginHandoff({ todoIds: [todo.id], note: '', sessionId: 'terminal', idempotencyKey: 'handoff' }, config, '普通会话');
  clock += 900_000; await lifecycle.recycle(); expect(runtime.close).not.toHaveBeenCalled();
});
it('reuses only compatible owned terminals after the prior report and records association before input', async () => {
  const first = owned(10, 'reuse'); store.report(first.id, 'complete', '完成收集');
  const run = store.begin('collect', first.collectorId!, config, 'second').run;
  const launch = vi.fn(async () => {});
  runtime.reuse = vi.fn(async (_run, id) => { expect(store.run(run.id).sessionId).toBe(id); });
  await lifecycle.collect(run, '第二轮提示词', id => { store.mark(run.id, { sessionId: id }); }, launch);
  expect(launch).not.toHaveBeenCalled(); expect(runtime.reuse).toHaveBeenCalledWith(run, 'terminal', '第二轮提示词', '/clear');
});
it('does not reset a still-unreported previous run or replay a failed reuse', async () => {
  const first = owned(10, 'reuse'), run = store.begin('collect', first.collectorId!, config, 'second').run;
  const launch = vi.fn(async () => {});
  await expect(lifecycle.collect(run, 'prompt', () => {}, launch)).rejects.toThrow('尚未报告结束'); expect(runtime.reuse).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
  store.report(first.id, 'complete', '完成'); runtime.reuse = vi.fn(async () => { throw new Error('reset failed'); });
  await expect(lifecycle.collect(run, 'prompt', () => {}, launch)).rejects.toThrow('reset failed'); expect(runtime.reuse).toHaveBeenCalledOnce(); expect(launch).not.toHaveBeenCalled();
});
it('serializes reuse against recycling and recreates a missing managed terminal only', async () => {
  const first = owned(1, 'reuse'); store.report(first.id, 'complete', '完成'); await lifecycle.recycle();
  const run = store.begin('collect', first.collectorId!, config, 'second').run;
  let release!: () => void;
  runtime.reuse = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const pending = lifecycle.collect(run, 'prompt', () => {}, async () => {});
  await vi.waitFor(() => expect(runtime.reuse).toHaveBeenCalledOnce()); clock += 900_000; await lifecycle.recycle(); expect(runtime.close).not.toHaveBeenCalled(); release(); await pending;
  fact = null; const launch = vi.fn(async () => {}); await lifecycle.collect(run, 'prompt', () => {}, launch); expect(launch).toHaveBeenCalledOnce();
});
it('rechecks output and runtime identity at the runtime boundary before closing', async () => {
  owned(1); await lifecycle.recycle(); runtime.close = vi.fn(async () => false); clock += 60_000; await lifecycle.recycle(); expect(store.collectionSessions().has('terminal')).toBe(true);
  expect(runtime.close).toHaveBeenCalledWith('terminal', expect.objectContaining({ identity: 'runtime-1', ownershipIdentity: 'owner-1', lastOutputAt: 1_000_000 }));
});

it('does not recycle or reset a differently owned tmux session after restart', async () => {
  const first = owned(1, 'reuse'); store.report(first.id, 'complete', '完成'); await lifecycle.recycle();
  lifecycle = new CollectionSessionLifecycle(new TodoStore(path.join(dir, 'todos.json')), runtime, () => clock);
  fact!.ownershipIdentity = 'different-owner'; clock += 900_000; await lifecycle.recycle(); clock += 900_000; await lifecycle.recycle();
  expect(runtime.close).not.toHaveBeenCalled();
  const next = store.begin('collect', first.collectorId!, config, 'replace').run;
  await expect(lifecycle.collect(next, 'prompt', () => {}, async () => {})).rejects.toThrow('原收集终端已被替换');
  expect(runtime.reuse).not.toHaveBeenCalled();
});
