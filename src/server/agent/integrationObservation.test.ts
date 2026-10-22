// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { IntegrationSessions, type IntegrationSessionAdapter } from './integrationSessions.js';
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
  return { sessions, principal, created, inspect, notify };
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
