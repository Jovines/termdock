// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IntegrationSessions, publicIntegrationSession, type IntegrationSessionAdapter } from './integrationSessions.js';
import { closeSessionRuntime, processStartIdentity, type SessionCloseTarget } from './sessionManagement.js';
import type { IntegrationPrincipal } from './integrationStore.js';
let dir: string;
const instances: IntegrationSessions[] = [];
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-management-')); });
afterEach(() => { instances.splice(0).forEach(s => s.close()); fs.rmSync(dir, { recursive: true, force: true }); });
async function fixture(native = 'native-original') {
  const file = path.join(dir, 'sessions.json');
  const p: IntegrationPrincipal = { id: 'owner', groupId: 'local', permissions: [], tokenHash: 'unused', revoked: false,
    launchProfiles: [{ id: 'agent', agentSlug: 'fixture', executable: '/bin/sh', argv: [], resumeArgv: ['resume', '{sessionId}'], cwdRoots: [dir] }] };
  const binding = { serverPid: 11, sessionId: '$12', paneId: '%13', panePid: 14, agentSlug: 'fixture', nativeSessionId: native || null };
  const target: SessionCloseTarget = { binding, tmux_server_start_id: 'linux:11', kind: native ? 'agent' : 'shell', process_pid: 15, process_start_id: 'linux:16', native_id: native || null };
  let exists = true, pending = 0;
  const api: IntegrationSessionAdapter = {
    create: vi.fn(async (_r, prepared) => { prepared(binding); if (!native) throw new Error('cold failed'); }), restore: vi.fn(async () => {}), retryCold: vi.fn(async () => {}), messageHistory: () => false,
    inspect: vi.fn(async () => ({ exists, running: !!native && exists, shell: !native && exists, agentSlug: native ? 'fixture' : null, nativeId: native || null })),
    release: vi.fn(async () => { exists = false; }), runtimePresent: vi.fn(async () => exists), pendingMessages: () => pending, subscribe: () => () => {},
    rename: vi.fn(async () => {}), prepareClose: vi.fn(async () => exists ? target : null),
    closeRuntime: vi.fn(async (_r, reconcile) => { if (reconcile && exists) throw Object.assign(new Error('still alive'), { code: 'OPERATION_OUTCOME_UNCONFIRMED' }); exists = false; }),
    resumeConfiguration: async () => ({ version: 1 }),
  };
  const sessions = new IntegrationSessions(file, api); instances.push(sessions);
  const created = await sessions.create(p, { profile: 'agent', cwd: dir, idempotencyKey: 'create' });
  return { sessions, file, p, api, created, target, setExists: (v: boolean) => { exists = v; }, setPending: (v: number) => { pending = v; },
    restart() { sessions.close(); const s = new IntegrationSessions(file, api); instances.push(s); return s; } };
}
it('renames durably, preserves launch identity/configuration and deduplicates across restart', async () => {
  const f = await fixture(), id = f.created.session_id;
  const result = await f.sessions.rename(f.p, id, 1, '  Fast\nmodel  ', 'rename');
  expect(result).toMatchObject({ name: 'Fast model', generation: 2, operation_id: f.created.operation_id, agent_native_session_id: 'native-original', rename_pending: false });
  expect(result.profile).toEqual(f.created.profile); expect(result.cwd).toBe(f.created.cwd);
  expect(await f.restart().rename(f.p, id, 1, 'Fast model', 'rename')).toEqual(result);
  expect(f.api.rename).toHaveBeenCalledTimes(1); expect(f.api.create).toHaveBeenCalledTimes(1); expect(f.api.restore).not.toHaveBeenCalled();
  await expect(f.sessions.rename(f.p, id, 1, 'Slow', 'rename')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});
it('reconciles a failed name synchronization without launching or incrementing again', async () => {
  const f = await fixture(); vi.mocked(f.api.rename!).mockRejectedValueOnce(new Error('sync down'));
  const result = await f.sessions.rename(f.p, f.created.session_id, 1, 'Fast', 'rename');
  expect(result).toMatchObject({ name: 'Fast', rename_pending: true, generation: 2 });
  expect(await f.restart().get(f.p, result.session_id)).toMatchObject({ name: 'Fast', rename_pending: false, generation: 2 });
  expect(f.api.restore).not.toHaveBeenCalled();
});
it('a failed durable rename intent performs no display side effect', async () => {
  const f = await fixture(); const spy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk full'); });
  await expect(f.sessions.rename(f.p, f.created.session_id, 1, 'Fast', 'rename')).rejects.toThrow('disk full'); spy.mockRestore();
  expect(f.api.rename).not.toHaveBeenCalled(); expect(await f.sessions.get(f.p, f.created.session_id)).toMatchObject({ generation: 1 });
});
it.each(['rename', 'close'] as const)('rejects foreign principal and group ownership for %s', async operation => {
  const f = await fixture();
  for (const p of [{ ...f.p, id: 'other' }, { ...f.p, groupId: 'other' }]) {
    await expect(operation === 'rename' ? f.sessions.rename(p, f.created.session_id, 1, 'Other', 'key') : f.sessions.closeSession(p, f.created.session_id, 1, 'key')).rejects.toMatchObject({ code: 'INTEGRATION_SESSION_NOT_FOUND' });
  }
  expect(f.api.prepareClose).not.toHaveBeenCalled(); expect(f.api.rename).not.toHaveBeenCalled();
});
it.each(['rename', 'close'] as const)('rejects a stale/invalid generation before %s effects', async operation => {
  const f = await fixture();
  for (const generation of [0, 2, NaN]) await expect(operation === 'rename' ? f.sessions.rename(f.p, f.created.session_id, generation, 'Fast', `r${generation}`) : f.sessions.closeSession(f.p, f.created.session_id, generation, `c${generation}`)).rejects.toMatchObject({ code: generation === 2 ? 'SESSION_GENERATION_MISMATCH' : 'INVALID_SESSION_GENERATION' });
  expect(f.api.prepareClose).not.toHaveBeenCalled(); expect(f.api.rename).not.toHaveBeenCalled();
});
it('close persists intent before effects, preserves audit, and replays the same result', async () => {
  const f = await fixture(), perform = f.api.closeRuntime!;
  f.api.closeRuntime = vi.fn(async (r, reconcile) => {
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).sessions[0]).toMatchObject({ state: 'closing', generation: 2, close_intent: { target: f.target } });
    expect(() => f.sessions.assertRuntimeMessage(r.session_id)).toThrow(); await perform(r, reconcile);
  });
  const result = await f.sessions.closeSession(f.p, f.created.session_id, 1, 'close');
  expect(result).toMatchObject({ state: 'closed', runtime_present: false, terminal_binding: null, generation: 2, cwd: dir, agent_native_session_id: 'native-original' });
  expect(result.operation_id).not.toBe(f.created.operation_id); expect(result.launch_diagnostics).toEqual(f.created.launch_diagnostics);
  expect(publicIntegrationSession(result)).toMatchObject({ close_pending: false }); expect(publicIntegrationSession(result)).not.toHaveProperty('close_intent');
  const restarted = f.restart(); expect(await restarted.closeSession(f.p, result.session_id, 1, 'close')).toEqual(result);
  expect(f.api.closeRuntime).toHaveBeenCalledTimes(1); expect(f.api.create).toHaveBeenCalledTimes(1);
});
it('closes an unbound failed cold shell without native restore or retry', async () => {
  const f = await fixture(''); expect(f.created.state).toBe('failed');
  expect(await f.sessions.closeSession(f.p, f.created.session_id, 1, 'close')).toMatchObject({ state: 'closed', agent_native_session_id: null });
});
it('does not mutate management state for diagnostics and discards observations after a concurrent generation change', async () => {
  const f = await fixture();
  const report = { checked_at: 1, terminal_registration_present: false, binding_present: true, runtime_present: true,
    target_confirmed: true, pending_messages: 0, code: null, target: f.target };
  f.api.closeDiagnostics = vi.fn(async () => structuredClone(report));
  const before = fs.readFileSync(f.file);
  expect(await f.sessions.closeDiagnostics(f.created.session_id)).toMatchObject({ generation: 1, close_diagnostics: report });
  expect(fs.readFileSync(f.file)).toEqual(before); expect(f.api.closeRuntime).not.toHaveBeenCalled();
  let finish!: (v: typeof report) => void;
  f.api.closeDiagnostics = () => new Promise(resolve => { finish = resolve; });
  const observing = f.sessions.closeDiagnostics(f.created.session_id);
  await f.sessions.rename(f.p, f.created.session_id, 1, 'Changed while observing', 'rename-concurrent');
  finish(report);
  expect(await observing).toMatchObject({ generation: 1, close_diagnostics: { target_confirmed: false, target: null, code: 'SESSION_CLOSE_TARGET_CHANGED' } });
  expect((await f.sessions.get(f.p, f.created.session_id)).generation).toBe(2);
});
it('close rejects pending messages and unsafe preflight before committing intent', async () => {
  const f = await fixture(); f.setPending(1);
  await expect(f.sessions.closeSession(f.p, f.created.session_id, 1, 'close')).rejects.toMatchObject({ code: 'SESSION_PENDING_MESSAGES' });
  f.setPending(0); vi.mocked(f.api.prepareClose!).mockRejectedValueOnce(Object.assign(new Error('mismatch'), { code: 'SESSION_IDENTITY_MISMATCH' }));
  await expect(f.sessions.closeSession(f.p, f.created.session_id, 1, 'close')).rejects.toMatchObject({ code: 'SESSION_IDENTITY_MISMATCH' });
  expect(await f.sessions.get(f.p, f.created.session_id)).toMatchObject({ state: 'ready', generation: 1 }); expect(f.api.closeRuntime).not.toHaveBeenCalled();
});
it('failed close intent persistence cannot terminate runtime', async () => {
  const f = await fixture(); const spy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk full'); });
  await expect(f.sessions.closeSession(f.p, f.created.session_id, 1, 'close')).rejects.toThrow('disk full'); spy.mockRestore();
  expect(f.api.closeRuntime).not.toHaveBeenCalled(); expect(await f.sessions.get(f.p, f.created.session_id)).toMatchObject({ state: 'ready', generation: 1 });
});
it('closed refuses send, native restore, cold retry and release but allows audit rename', async () => {
  const f = await fixture(); const r = await f.sessions.closeSession(f.p, f.created.session_id, 1, 'close');
  expect(() => f.sessions.assertRuntimeMessage(r.session_id)).toThrow(expect.objectContaining({ code: 'SESSION_CLOSED' }));
  for (const action of [() => f.sessions.restore(f.p, r.session_id, 'restore'), () => f.sessions.retryCold(f.p, r.session_id, 2, 'retry'), () => f.sessions.release(f.p, r.session_id, 2, 'release')]) await expect(action()).rejects.toMatchObject({ code: 'SESSION_CLOSED' });
  expect(await f.sessions.rename(f.p, r.session_id, 2, 'Archived', 'rename')).toMatchObject({ state: 'closed', name: 'Archived', generation: 3 });
});
it('concurrent identical close joins; a different mutation is rejected', async () => {
  const f = await fixture(); let release!: () => void; const original = f.api.prepareClose!;
  f.api.prepareClose = async r => { await new Promise<void>(resolve => { release = resolve; }); return original(r); };
  const a = f.sessions.closeSession(f.p, f.created.session_id, 1, 'same');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect(() => f.sessions.assertRuntimeMessage(f.created.session_id)).toThrow(expect.objectContaining({ code: 'SESSION_OPERATION_IN_PROGRESS' }));
  expect(await f.sessions.deliveryReadiness(f.created.session_id)).toMatchObject({ allowed: false, reason: 'SESSION_OPERATION_IN_PROGRESS' });
  const b = f.sessions.closeSession(f.p, f.created.session_id, 1, 'same');
  await expect(f.sessions.closeSession(f.p, f.created.session_id, 1, 'different')).rejects.toMatchObject({ code: 'SESSION_OPERATION_IN_PROGRESS' });
  release(); expect(await a).toEqual(await b); expect(f.api.closeRuntime).toHaveBeenCalledTimes(1);
});
it('ambiguous close never kills on restart and reconciles only confirmed absence', async () => {
  const f = await fixture(); vi.mocked(f.api.closeRuntime!).mockRejectedValueOnce(new Error('lost receipt'));
  const failed = await f.sessions.closeSession(f.p, f.created.session_id, 1, 'close');
  expect(failed).toMatchObject({ state: 'failed', operation_uncertain: true, generation: 2 }); expect(publicIntegrationSession(failed).close_pending).toBe(true);
  const restarted = f.restart(); expect(await restarted.get(f.p, failed.session_id)).toMatchObject({ state: 'failed', operation_uncertain: true });
  expect(f.api.closeRuntime).toHaveBeenLastCalledWith(expect.anything(), true);
  await expect(restarted.restore(f.p, failed.session_id, 'restore')).rejects.toMatchObject({ code: 'OPERATION_OUTCOME_UNCONFIRMED' });
  f.setExists(false); expect(await restarted.get(f.p, failed.session_id)).toMatchObject({ state: 'closed', terminal_binding: null, runtime_present: false, generation: 2 });
});
it('same close key keeps the original interrupted destruction snapshot after restart', async () => {
  const f = await fixture(); const perform = f.api.closeRuntime!;
  f.api.closeRuntime = async (r, reconcile) => { await perform(r, reconcile); throw new Error('interrupted after destroy'); };
  const failed = await f.sessions.closeSession(f.p, f.created.session_id, 1, 'close');
  f.api.closeRuntime = perform;
  const restarted = f.restart(); expect(await restarted.get(f.p, failed.session_id)).toMatchObject({ state: 'closed' });
  // A committed failure result remains the original idempotent operation snapshot.
  expect(await restarted.closeSession(f.p, failed.session_id, 1, 'close')).toEqual(failed);
  expect(perform).toHaveBeenCalledTimes(2); expect(perform).toHaveBeenLastCalledWith(expect.anything(), true);
});
it('released metadata can be renamed without creating runtime and restore uses persistent name', async () => {
  const f = await fixture(); const doc = JSON.parse(fs.readFileSync(f.file, 'utf8')); doc.sessions[0].state = 'released'; doc.sessions[0].runtime_present = false; doc.sessions[0].terminal_binding = null; fs.writeFileSync(f.file, JSON.stringify(doc)); f.setExists(false);
  const restarted = f.restart(); const r = await restarted.rename(f.p, f.created.session_id, 1, 'Persistent', 'name');
  expect(r).toMatchObject({ name: 'Persistent', state: 'released', generation: 2 }); expect(f.api.restore).not.toHaveBeenCalled();
  await restarted.restore(f.p, r.session_id, 'restore'); expect(f.api.restore).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Persistent' }), expect.anything(), expect.anything());
});
it('closed never becomes ready when an unexpected runtime appears', async () => {
  const f = await fixture(); const closed = await f.sessions.closeSession(f.p, f.created.session_id, 1, 'close'); f.setExists(true);
  expect(await f.sessions.get(f.p, closed.session_id)).toMatchObject({ state: 'closed', operation_uncertain: true, runtime_present: null });
  expect(() => f.sessions.assertRuntimeMessage(closed.session_id)).toThrow(expect.objectContaining({ code: 'SESSION_CLOSED' })); expect(f.api.closeRuntime).toHaveBeenCalledTimes(1);
});
it('generic close checks process/binding changes and queued work inside the barrier', async () => {
  const f = await fixture(); let exists = true;
  const api = { barrier: async (fn: () => Promise<void>) => fn(), exists: async () => exists, pendingMessages: () => 0,
    observe: async () => ({ ...f.target, process_start_id: 'replacement' }), destroy: vi.fn(async () => { exists = false; }), forgetRuntime: vi.fn(async () => {}) };
  await expect(closeSessionRuntime(api, f.target, false)).rejects.toMatchObject({ code: 'SESSION_CLOSE_TARGET_CHANGED' }); expect(api.destroy).not.toHaveBeenCalled();
  api.observe = async () => f.target; api.pendingMessages = () => 1;
  await expect(closeSessionRuntime(api, f.target, false)).rejects.toMatchObject({ code: 'SESSION_PENDING_MESSAGES' });
  api.pendingMessages = () => 0; await expect(closeSessionRuntime(api, f.target, true)).rejects.toMatchObject({ code: 'OPERATION_OUTCOME_UNCONFIRMED' }); expect(api.destroy).not.toHaveBeenCalled();
  await closeSessionRuntime(api, f.target, false); expect(api.destroy).toHaveBeenCalledTimes(1); expect(api.forgetRuntime).toHaveBeenCalledTimes(1);
});
it.skipIf(process.platform !== 'linux')('reads current Linux start identity and refuses to invent identity for an absent PID', async () => {
  expect(await processStartIdentity(process.pid)).toMatch(/^linux:\d+$/); expect(await processStartIdentity(2147483647)).toBeNull();
});

it('a lost closed-state disk commit replays only reconciliation after restart', async () => {
  const f = await fixture(); let fail = true;
  const original = fs.renameSync;
  const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === f.file && fail && JSON.parse(fs.readFileSync(from, 'utf8')).sessions[0].state === 'closed') { fail = false; throw new Error('closed commit lost'); }
    return original(from, to);
  });
  await expect(f.sessions.closeSession(f.p, f.created.session_id, 1, 'close')).rejects.toThrow('closed commit lost'); spy.mockRestore();
  expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).sessions[0].state).toBe('closing');
  const restarted = f.restart(); const current = await restarted.get(f.p, f.created.session_id);
  expect(current).toMatchObject({ state: 'closed', runtime_present: false, generation: 2 });
  expect(await restarted.closeSession(f.p, f.created.session_id, 1, 'close')).toEqual(current);
  expect(f.api.closeRuntime).toHaveBeenCalledTimes(2); expect(f.api.closeRuntime).toHaveBeenLastCalledWith(expect.anything(), true);
});
it('shared ownership rejection precedes durable name changes', async () => {
  const f = await fixture(); f.api.prepareRename = vi.fn(async () => { throw Object.assign(new Error('shared scope'), { code: 'SESSION_SCOPE_CONFLICT' }); });
  await expect(f.sessions.rename(f.p, f.created.session_id, 1, 'Wrong', 'rename')).rejects.toMatchObject({ code: 'SESSION_SCOPE_CONFLICT' });
  expect(f.api.rename).not.toHaveBeenCalled(); expect(await f.sessions.get(f.p, f.created.session_id)).not.toHaveProperty('name');
});
