// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { IntegrationSessions, type IntegrationSessionAdapter, type IntegrationSession } from './integrationSessions.js';
import type { IntegrationPrincipal } from './integrationStore.js';

const close: Array<() => void> = [];
afterEach(() => { for (const dispose of close.splice(0).reverse()) dispose(); vi.useRealTimers(); });
async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-observation-'));
  close.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  let notify!: () => void;
  const inspect = vi.fn(async () => ({ exists: true, running: true, shell: false, agentSlug: 'fixture', nativeId: 'native' }));
  const api: IntegrationSessionAdapter = { create: async () => {}, restore: async () => {}, inspect,
    subscribe(listener) { notify = listener; return () => {}; } };
  const principal: IntegrationPrincipal = { id: 'bridge', tokenHash: '', revoked: false, groupId: 'group',
    permissions: ['session.create', 'session.read'], launchProfiles: [{ id: 'fixture', agentSlug: 'fixture', executable: '/bin/sh',
      argv: [], cwdRoots: [directory], resumeArgv: ['resume', '{sessionId}', '{launchArgs}'] }] };
  const sessions = new IntegrationSessions(path.join(directory, 'sessions.json'), api);
  close.push(() => sessions.close());
  const created = await sessions.create(principal, { profile: 'fixture', cwd: directory, idempotencyKey: 'create' });
  inspect.mockClear();
  return { sessions, principal, created, inspect, notify, api, file: path.join(directory, 'sessions.json') };
}

it('coalesces output notifications but leaves explicit session get immediate', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  for (let i = 0; i < 100; i++) f.notify();
  await vi.advanceTimersByTimeAsync(249); expect(f.inspect).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(f.inspect).toHaveBeenCalledTimes(1);
  f.notify(); await f.sessions.get(f.principal, f.created.session_id);
  expect(f.inspect).toHaveBeenCalledTimes(2);
  f.sessions.close(); await vi.advanceTimersByTimeAsync(1000);
  expect(f.inspect).toHaveBeenCalledTimes(2);
});

it('yields between full observation rounds even with notifications during an in-flight observation', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  let finish!: () => void;
  f.inspect.mockImplementationOnce(async () => {
    await new Promise<void>(resolve => { finish = resolve; });
    return { exists: true, running: true, shell: false, agentSlug: 'fixture', nativeId: 'native' };
  });
  const observing = f.sessions.refreshAll();
  for (let i = 0; i < 100; i++) f.notify();
  finish(); await observing;
  expect(f.inspect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(249); expect(f.inspect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(f.inspect).toHaveBeenCalledTimes(2);
});

it('batches only already-zero dormant runtime observations and keeps explicit get fresh', async () => {
  const f = await fixture(); f.sessions.close();
  const doc = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  doc.sessions = Array.from({ length: 100 }, (_, index) => ({ ...f.created, session_id: `dormant-${index}`,
    state: index % 2 ? 'closed' : 'released', runtime_present: false, terminal_binding: null }));
  fs.writeFileSync(f.file, JSON.stringify(doc));
  const batch = vi.fn(async (records: readonly IntegrationSession[]) => new Map(records.map(record => [record.session_id, false])));
  const individual = vi.fn(async () => false);
  const sessions = new IntegrationSessions(f.file, { ...f.api, runtimePresent: individual, runtimePresenceBatch: batch }); close.push(() => sessions.close());
  await sessions.refreshAll();
  expect(batch).toHaveBeenCalledTimes(1); expect(batch.mock.calls[0]![0]).toHaveLength(100);
  expect(individual).not.toHaveBeenCalled();
  await sessions.get(f.principal, 'dormant-1'); expect(individual).toHaveBeenCalledTimes(1);
  batch.mockRejectedValueOnce(new Error('tmux query failed')); individual.mockClear();
  await sessions.refreshAll(); expect(individual).toHaveBeenCalledTimes(100);
});

it('rejects a stale batch after a record changes while the fresh presence query is pending', async () => {
  const f = await fixture(); f.sessions.close();
  const doc = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  doc.sessions = [{ ...f.created, state: 'closed', runtime_present: false, terminal_binding: null }];
  fs.writeFileSync(f.file, JSON.stringify(doc));
  let finish!: (value: Map<string, boolean>) => void;
  const batch = vi.fn(() => new Promise<Map<string, boolean>>(resolve => { finish = resolve; }));
  const individual = vi.fn(async () => false);
  const sessions = new IntegrationSessions(f.file, { ...f.api, runtimePresent: individual, runtimePresenceBatch: batch }); close.push(() => sessions.close());
  const observing = sessions.refreshAll();
  // Simulate a concurrent durable lifecycle update, preserving the actual
  // refresh code's CAS checks while testing its before/after-await boundary.
  const state = sessions as unknown as { doc: { sessions: IntegrationSession[] } };
  state.doc.sessions[0] = { ...state.doc.sessions[0]!, generation: 10 };
  finish(new Map([[f.created.session_id, true]])); await observing;
  expect(individual).toHaveBeenCalledTimes(1);
  expect((await sessions.get(f.principal, f.created.session_id)).state).toBe('closed');
});
