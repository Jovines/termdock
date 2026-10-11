// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IntegrationSessions, publicIntegrationSession, type IntegrationSessionAdapter } from './integrationSessions.js';
import type { IntegrationPrincipal } from './integrationStore.js';
import { TerminalInputTargetChangedError } from './terminalInput.js';
import { CollaborationStore } from './collaborationStore.js';
let dir: string;
const sessionsToClose: IntegrationSessions[] = [];
beforeEach(() => { dir = fs.mkdtempSync(path.join(tmpdir(), 'td-cold-retry-')); });
afterEach(() => { for (const s of sessionsToClose.splice(0)) s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
async function fixture() {
  const executable = path.join(dir, 'wrapper'); fs.writeFileSync(executable, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const p: IntegrationPrincipal = { id: 'bridge', groupId: 'group', revoked: false, tokenHash: 'unused', permissions: ['session.create', 'session.read', 'session.restore'],
    launchProfiles: [{ id: 'agent', agentSlug: 'fixture', executable, argv: ['--model', 'original'], resumeArgv: ['resume', '{sessionId}', '{launchArgs}'], cwdRoots: [dir] }] };
  const binding = { serverPid: 1, sessionId: '$1', paneId: '%1', panePid: 2, agentSlug: 'fixture', nativeSessionId: null };
  let observed = { exists: true, running: false, shell: true, agentSlug: null as string | null, nativeId: null as string | null };
  let history: boolean | null = false, pending = 0;
  const api: IntegrationSessionAdapter = {
    create: vi.fn(async (_r, prepared, progress) => { progress?.('runtime_prepare'); prepared(binding); progress?.('paste_attempted'); throw Object.assign(new Error('secret argv output'), { code: 'EIO' }); }),
    restore: vi.fn(async () => {}),
    retryCold: vi.fn(async (_r, prepared, progress) => { prepared(binding); progress('paste_attempted'); progress('paste_written'); progress('submit_attempted'); progress('submit_written');
      observed = { exists: true, running: true, shell: false, agentSlug: 'fixture', nativeId: 'new-native' }; }),
    inspect: vi.fn(async () => observed), subscribe: () => () => {}, resumeConfiguration: async () => ({ exact: 'v1' }),
    messageHistory: () => history, pendingMessages: () => pending,
  };
  const file = path.join(dir, 'sessions.json'), sessions = new IntegrationSessions(file, api); sessionsToClose.push(sessions);
  const created = await sessions.create(p, { profile: 'agent', cwd: dir, idempotencyKey: 'create' });
  return { api, p, file, sessions, created, executable,
    set(value: Partial<typeof observed>) { observed = { ...observed, ...value }; }, history(value: boolean | null) { history = value; }, pending(value: number) { pending = value; } };
}
it('persists bounded launch stages without error text; admin reads cause no probe and old evidence survives cold retry', async () => {
  const f = await fixture();
  expect(f.created).toMatchObject({ state: 'failed', error_code: 'EIO', generation: 1 });
  const before = (f.api.inspect as ReturnType<typeof vi.fn>).mock.calls.length;
  expect(f.sessions.launchDiagnostics(f.created.session_id).launch_diagnostics).toMatchObject({ phase: 'paste_attempted', paste: 'attempted', submit: 'not_attempted', reason_code: 'EIO' });
  expect(f.api.inspect).toHaveBeenCalledTimes(before);
  expect(JSON.stringify(publicIntegrationSession(f.created))).not.toContain('paste_attempted');
  expect(fs.readFileSync(f.file, 'utf8')).not.toContain('secret argv output');
  const retried = await f.sessions.retryCold(f.p, f.created.session_id, 1, 'retry');
  const ready = await f.sessions.get(f.p, f.created.session_id);
  expect(ready).toMatchObject({ session_id: f.created.session_id, generation: 2, state: 'ready', agent_native_session_id: 'new-native', cold_retry_pending: false });
  expect(ready.operation_id).not.toBe(f.created.operation_id);
  expect(f.sessions.launchDiagnostics(ready.session_id)).toMatchObject({ launch_diagnostics: { kind: 'cold_retry', paste: 'write_returned', submit: 'write_returned' }, launch_diagnostics_history: [{ operation_id: f.created.operation_id, reason_code: 'EIO' }] });
  expect(await f.sessions.retryCold(f.p, ready.session_id, 1, 'retry')).toEqual(retried);
  expect(f.api.retryCold).toHaveBeenCalledTimes(1);
  expect((await f.sessions.create(f.p, { profile: 'agent', cwd: dir, idempotencyKey: 'create' })).session_id).toBe(ready.session_id);
  expect(f.api.create).toHaveBeenCalledTimes(1);
  expect((f.api.retryCold as ReturnType<typeof vi.fn>).mock.calls[0][0].profile.argv).toEqual(['--model', 'original']);
});
it.each(['generation', 'history', 'unknown-history', 'pending', 'running', 'absent', 'not-shell', 'fingerprint', 'profile', 'cwd'] as const)('rejects unsafe %s before launching', async reason => {
  const f = await fixture(); let generation = 1;
  const expected = { generation: 'SESSION_GENERATION_MISMATCH', history: 'SESSION_MESSAGE_HISTORY_PRESENT', 'unknown-history': 'SESSION_MESSAGE_HISTORY_UNCONFIRMED', pending: 'SESSION_MESSAGE_HISTORY_PRESENT', running: 'SESSION_COLD_RETRY_NOT_FAILED', absent: 'SESSION_COLD_RETRY_RUNTIME_UNCONFIRMED', 'not-shell': 'SESSION_COLD_RETRY_RUNTIME_UNCONFIRMED', fingerprint: 'RESUME_CONFIGURATION_CHANGED', profile: 'LAUNCH_PROFILE_DENIED', cwd: 'SESSION_CWD_DENIED' }[reason];
  if (reason === 'generation') generation = 2;
  if (reason === 'history') f.history(true);
  if (reason === 'unknown-history') f.history(null);
  if (reason === 'pending') f.pending(1);
  if (reason === 'running') f.set({ running: true, shell: false, agentSlug: 'fixture' });
  if (reason === 'absent') f.set({ exists: false });
  if (reason === 'not-shell') f.set({ shell: false });
  if (reason === 'fingerprint') fs.appendFileSync(f.executable, '# changed\n');
  if (reason === 'profile') f.p.launchProfiles = [];
  if (reason === 'cwd') { const outside = path.join(dir, 'outside'); fs.mkdirSync(outside); f.p.launchProfiles[0].cwdRoots = [outside]; }
  await expect(f.sessions.retryCold(f.p, f.created.session_id, generation, 'retry')).rejects.toMatchObject({ code: expected });
  expect(f.api.retryCold).not.toHaveBeenCalled();
});
it('rejects native-bound sessions and ordinary restore cannot recover an unknown UUID', async () => {
  const f = await fixture();
  await expect(f.sessions.restore(f.p, f.created.session_id, 'restore')).rejects.toMatchObject({ code: 'NATIVE_SESSION_ID_MISSING' });
  f.set({ running: true, shell: false, agentSlug: 'fixture', nativeId: 'existing-native' });
  await expect(f.sessions.retryCold(f.p, f.created.session_id, 1, 'retry')).rejects.toMatchObject({ code: 'SESSION_COLD_RETRY_NATIVE_BOUND' });
  expect(f.api.retryCold).not.toHaveBeenCalled();
});
it('coalesces one key, excludes other lifecycle keys and prevents message admission during retry', async () => {
  const f = await fixture();
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  f.api.retryCold = vi.fn(async (_r, _prepared, progress) => {
    const persisted = JSON.parse(fs.readFileSync(f.file, 'utf8')).sessions[0];
    expect(persisted).toMatchObject({ generation: 2, cold_retry_pending: true, launch_submitted: true });
    enter(); await gate; progress('paste_attempted'); progress('paste_written');
  });
  const one = f.sessions.retryCold(f.p, f.created.session_id, 1, 'retry'); await entered;
  const duplicate = f.sessions.retryCold(f.p, f.created.session_id, 1, 'retry');
  expect(() => f.sessions.assertRuntimeMessage(f.created.session_id)).toThrow(/Cold retry/);
  await expect(f.sessions.retryCold(f.p, f.created.session_id, 1, 'other')).rejects.toMatchObject({ code: 'SESSION_OPERATION_IN_PROGRESS' });
  finish(); expect(await duplicate).toEqual(await one); expect(f.api.retryCold).toHaveBeenCalledTimes(1);
});
it('keeps attempted message admission latched across stale prepared callbacks and restart', async () => {
  const f = await fixture(); f.sessions.assertRuntimeMessage(f.created.session_id);
  const restarted = new IntegrationSessions(f.file, f.api); sessionsToClose.push(restarted);
  await expect(restarted.retryCold(f.p, f.created.session_id, 1, 'retry')).rejects.toMatchObject({ code: 'SESSION_MESSAGE_HISTORY_PRESENT' });
  expect(f.api.retryCold).not.toHaveBeenCalled();
});
it.each(['shell', 'absent', 'ready'] as const)('reconciles interrupted retry by actual %s evidence without automatic launch', async state => {
  const f = await fixture(); f.sessions.close();
  const doc = JSON.parse(fs.readFileSync(f.file, 'utf8')); doc.sessions[0].cold_retry_pending = true; doc.sessions[0].generation = 2; doc.sessions[0].state = 'starting';
  fs.writeFileSync(f.file, JSON.stringify(doc));
  if (state === 'absent') f.set({ exists: false });
  if (state === 'ready') f.set({ running: true, shell: false, agentSlug: 'fixture', nativeId: 'actual-native' });
  const restarted = new IntegrationSessions(f.file, f.api); sessionsToClose.push(restarted);
  const record = await restarted.get(f.p, f.created.session_id);
  expect(f.api.retryCold).not.toHaveBeenCalled();
  if (state === 'shell') expect(record).toMatchObject({ state: 'failed', error_code: 'SESSION_COLD_RETRY_INTERRUPTED', cold_retry_pending: false });
  if (state === 'ready') expect(record).toMatchObject({ state: 'ready', agent_native_session_id: 'actual-native', cold_retry_pending: false });
  if (state === 'absent') { expect(record).toMatchObject({ state: 'failed', error_code: 'SESSION_COLD_RETRY_RUNTIME_UNCONFIRMED', cold_retry_pending: true }); expect(() => restarted.assertRuntimeMessage(record.session_id)).toThrow(); }
});
it('records structured fencing evidence, not raw exception text', async () => {
  const f = await fixture();
  f.api.retryCold = vi.fn(async (_r, _p, progress) => { progress('queue_wait'); progress('queue_acquired'); throw new TerminalInputTargetChangedError({ expected_launch_id: 'old', current_launch_id: 'new', expected_backend_session_id: 'b1', current_backend_session_id: 'b2', backend_instance_matches: false }); });
  const failed = await f.sessions.retryCold(f.p, f.created.session_id, 1, 'retry');
  expect(failed).toMatchObject({ state: 'failed', error_code: 'TERMINAL_INPUT_TARGET_CHANGED' });
  expect(f.sessions.launchDiagnostics(failed.session_id).launch_diagnostics).toMatchObject({ phase: 'queue_acquired', paste: 'not_attempted', submit: 'not_attempted', target_change: { expected_launch_id: 'old', current_launch_id: 'new' } });
});
it('masks unclassified errors rather than saving private output', async () => {
  const f = await fixture(); f.api.retryCold = vi.fn(async () => { throw new Error('PRIVATE argv credential and stdout'); });
  const failed = await f.sessions.retryCold(f.p, f.created.session_id, 1, 'retry');
  expect(f.sessions.launchDiagnostics(failed.session_id).launch_diagnostics).toMatchObject({ error_code: 'SESSION_LAUNCH_FAILED', reason_code: 'UNCLASSIFIED_LAUNCH_ERROR' });
  expect(fs.readFileSync(f.file, 'utf8')).not.toContain('PRIVATE');
});
it('does not treat a pruned recipient history or an unreadable journal as no messages', () => {
  const file = path.join(dir, 'messages.json');
  fs.writeFileSync(file, JSON.stringify({ version: 2, groups: [], messages: [], prunedThrough: { old: 12 } }));
  const store = new CollaborationStore(file);
  expect(store.hasTerminalMessageHistory('old')).toBe(true); expect(store.hasTerminalMessageHistory('new')).toBeNull();
  fs.writeFileSync(file, JSON.stringify({ version: 2, groups: [], messages: [], prunedThrough: { old: 12 }, prunedSenders: { sender: true }, terminalHistoryComplete: true }));
  expect(new CollaborationStore(file).hasTerminalMessageHistory('sender')).toBe(true);
  expect(new CollaborationStore(file).hasTerminalMessageHistory('new')).toBe(false);
  fs.writeFileSync(file, 'broken'); expect(new CollaborationStore(file).hasTerminalMessageHistory('new')).toBeNull();
  fs.writeFileSync(file, JSON.stringify({ version: 1, groups: [], messages: [] })); expect(new CollaborationStore(file).hasTerminalMessageHistory('new')).toBeNull();
});
it('does not launch when the new generation intent cannot be committed', async () => {
  const f = await fixture();
  const rename = fs.renameSync;
  const failure = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
    if (destination === f.file && JSON.parse(fs.readFileSync(source, 'utf8')).sessions[0].generation === 2) throw new Error('commit failed');
    return rename(source, destination);
  });
  try { await expect(f.sessions.retryCold(f.p, f.created.session_id, 1, 'retry')).rejects.toThrow('commit failed'); }
  finally { failure.mockRestore(); }
  expect(f.api.retryCold).not.toHaveBeenCalled(); expect(f.sessions.snapshot()[0].generation).toBe(1);
  expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).sessions[0].generation).toBe(1);
});
it('a stale launch prepared callback cannot clear the durable admission latch', async () => {
  const f = await fixture(); let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  f.api.create = vi.fn(async (_r, prepared) => { enter(); await gate;
    prepared({ serverPid: 1, sessionId: '$2', paneId: '%2', panePid: 3, agentSlug: 'fixture', nativeSessionId: null }); throw new Error('failed'); });
  const creating = f.sessions.create(f.p, { profile: 'agent', cwd: dir, idempotencyKey: 'second' }); await entered;
  const id = f.sessions.snapshot().find(r => r.session_id !== f.created.session_id)!.session_id;
  f.sessions.assertRuntimeMessage(id); finish(); await creating;
  expect(f.sessions.snapshot().find(r => r.session_id === id)).toMatchObject({ message_history_seen: true });
  await expect(f.sessions.retryCold(f.p, id, 1, 'retry')).rejects.toMatchObject({ code: 'SESSION_MESSAGE_HISTORY_PRESENT' });
});
it('does not silently repair an unknown history by saving another group', () => {
  const file = path.join(dir, 'unknown-messages.json'); fs.writeFileSync(file, 'broken');
  const store = new CollaborationStore(file); store.save({ name: 'unrelated', sessionIds: ['other'] });
  expect(new CollaborationStore(file).hasTerminalMessageHistory('new')).toBeNull();
});
