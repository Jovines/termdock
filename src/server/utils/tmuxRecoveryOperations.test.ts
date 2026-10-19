import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { configuredTmuxRecoveryConcurrency, TmuxRecoveryOperationError, TmuxRecoveryOperationStore } from './tmuxRecoveryOperations.js';

const directories: string[] = [];
async function makeStore(concurrency = 2) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'termdock-tmux-recovery-'));
  directories.push(directory);
  const store = new TmuxRecoveryOperationStore(path.join(directory, 'ops.json'), concurrency);
  await store.load();
  return { store, file: path.join(directory, 'ops.json') };
}
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });

it('persists acceptance before work and enforces the global concurrency cap', async () => {
  const { store, file } = await makeStore(2);
  let active = 0, maxActive = 0;
  const gates: Array<() => void> = [];
  store.setRunner(async () => {
    active += 1; maxActive = Math.max(maxActive, active);
    await new Promise<void>(resolve => gates.push(resolve));
    active -= 1;
  });
  const operation = await store.create({ incidentId: 'incident', sessionIds: ['a', 'b', 'c', 'd'], scope: { kind: 'sessions', sessionIds: ['a', 'b', 'c', 'd'] }, idempotencyKey: 'restore-1' });
  expect(JSON.parse(await fs.readFile(file, 'utf8')).operations[0].items).toHaveLength(4);
  await vi.waitFor(() => expect(maxActive).toBe(2));
  expect(store.get(operation.id)).toMatchObject({ total: 4, running: 2, queued: 2 });
  while (store.get(operation.id)?.state !== 'succeeded') {
    const gate = gates.shift();
    if (gate) gate();
    await vi.waitFor(() => expect(store.stats().activeLaunches).toBeLessThanOrEqual(2));
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  expect(maxActive).toBe(2);
  expect(store.get(operation.id)).toMatchObject({ succeeded: 4, failed: 0, queued: 0, running: 0 });
  await store.flush();
});

it('replays same idempotency input and rejects key reuse or overlapping sessions', async () => {
  const { store } = await makeStore();
  let release!: () => void;
  store.setRunner(async () => new Promise<void>(resolve => { release = resolve; }));
  const input = { incidentId: 'incident', sessionIds: ['a'], scope: { kind: 'incident' as const }, idempotencyKey: 'same' };
  const first = await store.create(input);
  expect((await store.create(input)).id).toBe(first.id);
  await expect(store.create({ ...input, sessionIds: ['b'] })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(store.create({ ...input, idempotencyKey: 'other' })).rejects.toMatchObject({ code: 'RECOVERY_SESSION_IN_PROGRESS', operationId: first.id });
  await vi.waitFor(() => expect(typeof release).toBe('function'));
  release();
  await store.flush();
});

it('pause prevents queued work and resume continues the same operation', async () => {
  const { store } = await makeStore(1);
  const started: string[] = [];
  let finish!: () => void;
  store.setRunner(async (_operationId, sessionId) => {
    started.push(sessionId);
    if (sessionId === 'a') await new Promise<void>(resolve => { finish = resolve; });
  });
  const operation = await store.create({ incidentId: 'i', sessionIds: ['a', 'b'], scope: { kind: 'incident' }, idempotencyKey: 'pause' });
  await vi.waitFor(() => expect(started).toEqual(['a']));
  await store.pause(operation.id);
  finish();
  await vi.waitFor(() => expect(store.get(operation.id)).toMatchObject({ state: 'paused', running: 0, queued: 1 }));
  expect(started).toEqual(['a']);
  await store.resume(operation.id);
  await vi.waitFor(() => expect(store.get(operation.id)).toMatchObject({ state: 'succeeded', succeeded: 2 }));
  expect(started).toEqual(['a', 'b']);
});

it('recovers interrupted running items into reconciliation queue and keeps history durable', async () => {
  const { store, file } = await makeStore(1);
  let release!: () => void;
  store.setRunner(async () => new Promise<void>(resolve => { release = resolve; }));
  const operation = await store.create({ incidentId: 'i', sessionIds: ['a'], scope: { kind: 'principal', id: 'p' }, idempotencyKey: 'restart' });
  await vi.waitFor(() => expect(store.get(operation.id)?.running).toBe(1));
  await store.flush();
  const restarted = new TmuxRecoveryOperationStore(file, 1);
  await restarted.load();
  expect(restarted.get(operation.id)).toMatchObject({ state: 'queued', queued: 1, items: [{ phase: 'restart_reconciliation', errorCode: 'RECOVERY_WORKER_RESTARTED' }] });
  release();
});

it('reports item failure code and bounds configured concurrency', async () => {
  const { store } = await makeStore();
  store.setRunner(async () => { throw Object.assign(new Error('target changed'), { code: 'TERMINAL_INPUT_TARGET_CHANGED' }); });
  const operation = await store.create({ incidentId: 'i', sessionIds: ['a'], scope: { kind: 'sessions', sessionIds: ['a'] }, idempotencyKey: 'fail' });
  await vi.waitFor(() => expect(store.get(operation.id)).toMatchObject({ state: 'partial_failure', failed: 1, items: [{ errorCode: 'TERMINAL_INPUT_TARGET_CHANGED', phase: 'target_changed' }] }));
  expect(configuredTmuxRecoveryConcurrency(undefined)).toBe(3);
  expect(configuredTmuxRecoveryConcurrency('4')).toBe(4);
  expect(() => configuredTmuxRecoveryConcurrency('0')).toThrow();
  expect(() => new TmuxRecoveryOperationStore('/tmp/no', 17)).toThrow();
  expect(new TmuxRecoveryOperationError('TEST', 'x').code).toBe('TEST');
});

it('parks launches in resource_wait until admission recovers', async () => {
  const { store } = await makeStore(1);
  let admitted = false;
  store.setAdmission(async () => ({ admitted, reason: admitted ? undefined : 'MEMORY_BUDGET_LOW', memAvailableBytes: 128 }));
  store.setRunner(async () => ({ actualRssBytes: 1024 }));
  const operation = await store.create({ incidentId: 'i', sessionIds: ['a'], scope: { kind: 'incident' }, idempotencyKey: 'memory-wait' });
  await vi.waitFor(() => expect(store.get(operation.id)).toMatchObject({ state: 'resource_wait', resource_wait: 1,
    items: [{ state: 'resource_wait', resourceWaitReason: 'MEMORY_BUDGET_LOW', memAvailableBytes: 128 }] }));
  expect(store.stats().activeLaunches).toBe(0);
  admitted = true;
  store.notifyResourcesChanged();
  await vi.waitFor(() => expect(store.get(operation.id)).toMatchObject({ state: 'succeeded', succeeded: 1, items: [{ actualRssBytes: 1024 }] }));
});

it('finishes instead of leaving a paused operation stuck when its last running item completes', async () => {
  const { store } = await makeStore(1);
  let finish!: () => void;
  store.setRunner(async () => new Promise<void>(resolve => { finish = resolve; }));
  const operation = await store.create({ incidentId: 'i', sessionIds: ['a'], scope: { kind: 'incident' }, idempotencyKey: 'pause-final' });
  await vi.waitFor(() => expect(typeof finish).toBe('function'));
  await store.pause(operation.id);
  finish();
  await vi.waitFor(() => expect(store.get(operation.id)).toMatchObject({ state: 'succeeded', paused: false, succeeded: 1 }));
});
