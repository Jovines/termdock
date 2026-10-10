// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IntegrationSessions, type IntegrationSession, type IntegrationSessionAdapter } from './integrationSessions.js';
import type { IntegrationPrincipal } from './integrationStore.js';
import { assertMessageRuntime, releaseSessionRuntime, SessionLifecycleCoordinator, type SessionLifecycleDescriptor } from './sessionLifecycle.js';
import { CollaborationStore } from './collaborationStore.js';
import { parseCollaborationCommand, COLLAB_HELP } from './collaborationCli.js';
import { INTEGRATION_HELP } from './integrationCli.js';

let dir: string;
const closers: Array<() => void> = [];
beforeEach(() => { dir = fs.mkdtempSync(path.join(tmpdir(), 'td-lifecycle-')); });
afterEach(() => { vi.restoreAllMocks(); for (const close of closers.splice(0)) close(); fs.rmSync(dir, { recursive: true, force: true }); });
async function fixture() {
  const executable = path.join(dir, 'wrapper'); fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const p: IntegrationPrincipal = { id: 'bridge', groupId: 'group', tokenHash: 'unused', revoked: false,
    permissions: ['session.create', 'session.read', 'session.restore', 'session.release'],
    launchProfiles: [{ id: 'agent', agentSlug: 'fixture', executable, argv: ['-m', 'original'], resumeArgv: ['resume', '{sessionId}', '{launchArgs}'], cwdRoots: [dir] }] };
  const facts = { exists: true, running: true, shell: false, agentSlug: 'fixture' as string | null, nativeId: 'native-uuid' as string | null };
  let pending = 0, semantics = 'exact-resume-v1';
  const api: IntegrationSessionAdapter = {
    subscribe: () => () => {}, inspect: async () => ({ ...facts }), runtimePresent: async () => facts.exists,
    resumeConfiguration: async () => ({ semantics }), pendingMessages: () => pending,
    create: vi.fn(async (_record, prepared) => { prepared({ paneId: '%1', panePid: 101, serverPid: 100, sessionId: '$1', agentSlug: 'fixture', nativeSessionId: null }); }),
    restore: vi.fn(async (record, prepared) => {
      prepared({ paneId: '%2', panePid: 201, serverPid: 200, sessionId: '$2', agentSlug: 'fixture', nativeSessionId: record.agent_native_session_id });
      Object.assign(facts, { exists: true, running: true, shell: false, agentSlug: 'fixture', nativeId: record.agent_native_session_id });
    }),
    release: vi.fn(async (_record, reconcile) => {
      if (reconcile && facts.exists) throw Object.assign(new Error(), { code: 'OPERATION_OUTCOME_UNCONFIRMED' });
      Object.assign(facts, { exists: false, running: false, shell: false, agentSlug: null, nativeId: null });
    }),
  };
  const file = path.join(dir, 'sessions.json');
  const sessions = new IntegrationSessions(file, api); closers.push(() => sessions.close());
  const created = await sessions.create(p, { profile: 'agent', cwd: dir, idempotencyKey: 'create' });
  const exit = () => Object.assign(facts, { running: false, shell: true, agentSlug: null, nativeId: null });
  return { file, p, api, sessions, created, facts, executable, exit, pending: (value: number) => { pending = value; }, semantics: (value: string) => { semantics = value; } };
}

it('releases all runtime facts, keeps exact identity, and restores with a new pane and the same logical ID', async () => {
  const f = await fixture(); f.exit();
  const released = await f.sessions.release(f.p, f.created.session_id, 1, 'release');
  expect(released).toMatchObject({ state: 'released', generation: 2, runtime_present: false, terminal_binding: null, error_code: null, agent_native_session_id: 'native-uuid' });
  expect(() => f.sessions.assertRuntimeMessage(released.session_id)).toThrow(/explicitly restore/);
  expect(await f.sessions.deliveryReadiness(released.session_id)).toEqual({ allowed: false, reason: 'SESSION_RELEASED' });
  const restored = await f.sessions.restore(f.p, released.session_id, 'restore');
  expect(restored).toMatchObject({ state: 'ready', generation: 3, runtime_present: true, session_id: released.session_id, agent_native_session_id: 'native-uuid', terminal_binding: { paneId: '%2' } });
  expect(restored.profile).toEqual(f.created.profile);
  expect(await f.sessions.release(f.p, released.session_id, 1, 'release')).toEqual(released);
  expect(f.api.release).toHaveBeenCalledTimes(1);
  await expect(f.sessions.release(f.p, released.session_id, 2, 'stale-release')).rejects.toMatchObject({ code: 'SESSION_GENERATION_MISMATCH' });
  expect(f.api.release).toHaveBeenCalledTimes(1);
  expect(await f.sessions.get(f.p, released.session_id)).toMatchObject({ state: 'ready', generation: 3 });
});
it('refuses running Agents, pending messages, wrong owners and incompatible current authorization before side effects', async () => {
  const f = await fixture(), id = f.created.session_id;
  await expect(f.sessions.release(f.p, id, 1, 'running')).rejects.toMatchObject({ code: 'SESSION_STILL_RUNNING' });
  f.exit(); f.pending(1);
  await expect(f.sessions.release(f.p, id, 1, 'pending')).rejects.toMatchObject({ code: 'SESSION_PENDING_MESSAGES' });
  f.pending(0);
  await expect(f.sessions.release({ ...f.p, id: 'other' }, id, 1, 'wrong-owner')).rejects.toMatchObject({ code: 'INTEGRATION_SESSION_NOT_FOUND' });
  await f.sessions.release(f.p, id, 1, 'release');
  const denied = structuredClone(f.p); denied.launchProfiles[0].cwdRoots = ['/not-authorized'];
  await expect(f.sessions.restore(denied, id, 'denied')).rejects.toMatchObject({ code: 'SESSION_CWD_DENIED' });
  expect(f.api.restore).not.toHaveBeenCalled();
});
it('serializes same-key release and refuses different-key concurrent restore without touching the Agent', async () => {
  const f = await fixture(); f.exit();
  let finish!: () => void;
  const original = f.api.release!;
  f.api.release = vi.fn(async (record: IntegrationSession, reconcile: boolean) => { await new Promise<void>(resolve => { finish = resolve; }); await original(record, reconcile); });
  const a = f.sessions.release(f.p, f.created.session_id, 1, 'release');
  const b = f.sessions.release(f.p, f.created.session_id, 1, 'release');
  await expect(f.sessions.restore(f.p, f.created.session_id, 'restore-race')).rejects.toMatchObject({ code: 'SESSION_OPERATION_IN_PROGRESS' });
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(() => f.sessions.assertRuntimeMessage(f.created.session_id)).toThrow(/release is in progress/);
  finish(); expect(await a).toEqual(await b); expect(f.api.release).toHaveBeenCalledTimes(1);
  await expect(f.sessions.release(f.p, f.created.session_id, 2, 'release')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});
it('does not turn a failed detach into success; restart reconciles absence without killing a runtime', async () => {
  const f = await fixture(); f.exit();
  f.api.release = vi.fn(async () => { throw new Error('private failure details'); });
  const failed = await f.sessions.release(f.p, f.created.session_id, 1, 'failed');
  expect(failed).toMatchObject({ state: 'failed', operation_uncertain: true, runtime_present: null, error_code: 'SESSION_RELEASE_FAILED' });
  await expect(f.sessions.restore(f.p, failed.session_id, 'unsafe')).rejects.toMatchObject({ code: 'OPERATION_OUTCOME_UNCONFIRMED' });
  f.sessions.close();
  let reconciled = false;
  f.api.release = vi.fn(async (_record, reconcile) => {
    expect(reconcile).toBe(true);
    if (f.facts.exists) throw Object.assign(new Error(), { code: 'OPERATION_OUTCOME_UNCONFIRMED' });
    reconciled = true;
  });
  const restarted = new IntegrationSessions(f.file, f.api); closers.push(() => restarted.close());
  expect(await restarted.get(f.p, failed.session_id)).toMatchObject({ state: 'failed', operation_uncertain: true });
  expect(reconciled).toBe(false);
  Object.assign(f.facts, { exists: false });
  expect(await restarted.get(f.p, failed.session_id)).toMatchObject({ state: 'released', generation: 2, operation_uncertain: false, runtime_present: false, terminal_binding: null });
  expect(reconciled).toBe(true); expect(f.api.restore).not.toHaveBeenCalled();
});
it('detects an orphan reappearing after release rather than silently adopting it', async () => {
  const f = await fixture(); f.exit(); await f.sessions.release(f.p, f.created.session_id, 1, 'release');
  f.facts.exists = true;
  expect(await f.sessions.get(f.p, f.created.session_id)).toMatchObject({ state: 'failed', operation_uncertain: true, error_code: 'OPERATION_OUTCOME_UNCONFIRMED' });
  await expect(f.sessions.restore(f.p, f.created.session_id, 'restore')).rejects.toMatchObject({ code: 'OPERATION_OUTCOME_UNCONFIRMED' });
});
it('requires a durable release intent before destroying anything', async () => {
  const f = await fixture(); f.exit();
  const rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === f.file && JSON.parse(fs.readFileSync(from, 'utf8')).sessions[0].state === 'releasing') throw new Error('disk failure');
    return rename(from, to);
  });
  await expect(f.sessions.release(f.p, f.created.session_id, 1, 'release')).rejects.toThrow('disk failure');
  expect(f.api.release).not.toHaveBeenCalled(); expect(f.facts.exists).toBe(true);
  expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).sessions[0].generation).toBe(1);
});
it('reconciles a crash between real teardown and final persistence without a second teardown or launch', async () => {
  const f = await fixture(); f.exit();
  const rename = fs.renameSync;
  const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === f.file && JSON.parse(fs.readFileSync(from, 'utf8')).sessions[0].state === 'released') throw new Error('final persistence interrupted');
    return rename(from, to);
  });
  await expect(f.sessions.release(f.p, f.created.session_id, 1, 'release')).rejects.toThrow('interrupted');
  expect(f.api.release).toHaveBeenCalledTimes(1); expect(f.facts.exists).toBe(false);
  expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).sessions[0].state).toBe('releasing');
  spy.mockRestore(); f.sessions.close();
  const restarted = new IntegrationSessions(f.file, f.api); closers.push(() => restarted.close());
  expect(await restarted.get(f.p, f.created.session_id)).toMatchObject({ state: 'released', generation: 2, terminal_binding: null, runtime_present: false });
  expect((f.api.release as ReturnType<typeof vi.fn>).mock.calls[1][1]).toBe(true);
  expect(f.api.restore).not.toHaveBeenCalled();
  await restarted.restore(f.p, f.created.session_id, 'next-generation');
  await expect(restarted.release(f.p, f.created.session_id, 1, 'release')).rejects.toMatchObject({ code: 'OPERATION_OUTCOME_UNCONFIRMED' });
  expect(await restarted.get(f.p, f.created.session_id)).toMatchObject({ state: 'ready', generation: 3 });
});
it('does not let a stale released observation overwrite a concurrent successful restore', async () => {
  const f = await fixture(); f.exit(); await f.sessions.release(f.p, f.created.session_id, 1, 'release');
  let observed!: (present: boolean) => void;
  f.api.runtimePresent = vi.fn().mockImplementationOnce(() => new Promise<boolean>(resolve => { observed = resolve; })).mockImplementation(async () => f.facts.exists);
  const stale = f.sessions.get(f.p, f.created.session_id);
  const restored = await f.sessions.restore(f.p, f.created.session_id, 'restore');
  observed(false); await stale;
  expect(await f.sessions.get(f.p, f.created.session_id)).toMatchObject({ state: 'ready', generation: restored.generation, operation_id: restored.operation_id, runtime_present: true });
});
it('requires explicit legacy fingerprint confirmation and refuses changed wrapper content or plugin semantics', async () => {
  const f = await fixture(); f.exit(); f.sessions.close();
  const doc = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  delete doc.sessions[0].resume_configuration_fingerprint; delete doc.sessions[0].generation;
  fs.writeFileSync(f.file, JSON.stringify(doc));
  const legacy = new IntegrationSessions(f.file, f.api); closers.push(() => legacy.close());
  await expect(legacy.release(f.p, f.created.session_id, 1, 'release')).rejects.toMatchObject({ code: 'RESUME_CONFIGURATION_UNCONFIRMED' });
  const config = await legacy.resumeConfiguration(f.created.session_id);
  expect(config.recorded_fingerprint).toBeNull(); expect(config.confirmation_required).toBe(true);
  await expect(legacy.confirmResumeConfiguration(f.created.session_id, 1, '0'.repeat(64))).rejects.toMatchObject({ code: 'RESUME_CONFIGURATION_CHANGED' });
  expect(await legacy.confirmResumeConfiguration(f.created.session_id, 1, config.current_fingerprint)).toMatchObject({ generation: 2 });
  await legacy.release(f.p, f.created.session_id, 2, 'release-confirmed');
  fs.appendFileSync(f.executable, '# content changed\n');
  await expect(legacy.restore(f.p, f.created.session_id, 'changed-wrapper')).rejects.toMatchObject({ code: 'RESUME_CONFIGURATION_CHANGED' });
  const next = await legacy.resumeConfiguration(f.created.session_id);
  await legacy.confirmResumeConfiguration(f.created.session_id, 3, next.current_fingerprint);
  f.semantics('resume-v2');
  await expect(legacy.restore(f.p, f.created.session_id, 'changed-plugin')).rejects.toMatchObject({ code: 'RESUME_CONFIGURATION_CHANGED' });
  expect(f.api.restore).not.toHaveBeenCalled();
});
it('preserves old message IDs and replies across membership removal and reattachment, while guarding new sends', async () => {
  const f = await fixture(), messages = new CollaborationStore(path.join(dir, 'messages.json'));
  const group = messages.save({ name: 'Existing', sessionIds: [f.created.session_id] });
  messages.registerRuntimeGuard(id => f.sessions.assertRuntimeMessage(id));
  const original = messages.send({ groupId: group.id, fromSessionId: null, toSessionIds: [f.created.session_id], kind: 'message', content: 'first' })[0];
  messages.markDelivered([original.id]); f.exit(); await f.sessions.release(f.p, f.created.session_id, 1, 'release');
  messages.archiveSession(f.created.session_id);
  expect(messages.getGroup(group.id)).toMatchObject({ sessionIds: [] });
  expect(messages.getGroup(group.id)?.deleted).toBeFalsy();
  expect(messages.getMessage(original.id)?.content).toBe('first');
  expect(() => messages.send({ groupId: group.id, fromSessionId: null, toSessionIds: [f.created.session_id], kind: 'reply', content: 'must not queue', replyTo: original.id })).toThrow(/explicitly restore/);
  expect(messages.snapshotMessages()).toHaveLength(1);
  await f.sessions.restore(f.p, f.created.session_id, 'restore');
  messages.save({ id: group.id, name: group.name, sessionIds: [f.created.session_id] });
  const reply = messages.send({ groupId: group.id, fromSessionId: null, toSessionIds: [f.created.session_id], kind: 'reply', content: 'follow up', replyTo: original.id, threadId: original.threadId })[0];
  expect(reply).toMatchObject({ toSessionId: f.created.session_id, replyTo: original.id, threadId: original.threadId });
});
it('reserves native identity independently of logical IDs and keeps unresolved persisted operations blocking', async () => {
  const coordinator = new SessionLifecycleCoordinator();
  const descriptor: SessionLifecycleDescriptor = { session_id: 'one', operation_id: 'op', state: 'failed', agent_slug: 'fixture', agent_native_session_id: 'same' };
  const free = coordinator.reserveNative(descriptor, []);
  expect(() => coordinator.reserveNative({ ...descriptor, session_id: 'two' }, [])).toThrow(/unresolved operation/);
  free();
  expect(() => coordinator.reserveNative({ ...descriptor, session_id: 'two' }, [{ ...descriptor, state: 'restoring' }])).toThrow(/unresolved operation/);
  expect(() => coordinator.reserveNative({ ...descriptor, session_id: 'two' }, [{ ...descriptor, operation_uncertain: true }])).toThrow();
  expect(() => assertMessageRuntime({ ...descriptor, state: 'released' })).toThrow(/explicitly restore/);
});
it('makes the complete lifecycle discoverable offline and requires a valid generation', () => {
  expect(parseCollaborationCommand(['--principal', 'bridge', 'session', 'release', 's', '--generation', '3', '--idempotency-key', 'k'])).toMatchObject({ operation: 'release', options: { generation: '3' } });
  for (const value of ['', '0', '-1', '1.2', '9007199254740992']) expect(() => parseCollaborationCommand(['--principal', 'bridge', 'session', 'release', 's', '--generation', value, '--idempotency-key', 'k'])).toThrow();
  expect(COLLAB_HELP).toContain('session release'); expect(COLLAB_HELP).toContain('SESSION_RELEASED');
  expect(INTEGRATION_HELP).toContain('confirm-resume'); expect(INTEGRATION_HELP).toContain('unknown historical');
});

it('verifies ownership again inside the delivery barrier and never kills during restart reconciliation', async () => {
  let present = true, running = false, pending = 0;
  const destroy = vi.fn(async () => { present = false; });
  const forget = vi.fn(async () => {});
  const api = { barrier: async (action: () => Promise<void>) => action(), exists: async () => present,
    pendingMessages: () => pending, verifyOwnership: vi.fn(async () => {}),
    inspect: async () => ({ exists: true, running, shell: !running, agentSlug: null, nativeId: null }), destroy, forgetRuntime: forget };
  await expect(releaseSessionRuntime(api, true)).rejects.toMatchObject({ code: 'OPERATION_OUTCOME_UNCONFIRMED' });
  running = true;
  await expect(releaseSessionRuntime(api, false)).rejects.toMatchObject({ code: 'SESSION_STILL_RUNNING' });
  running = false; pending = 1;
  await expect(releaseSessionRuntime(api, false)).rejects.toMatchObject({ code: 'SESSION_PENDING_MESSAGES' });
  expect(destroy).not.toHaveBeenCalled(); expect(forget).not.toHaveBeenCalled();
  pending = 0;
  await releaseSessionRuntime(api, false); expect(destroy).toHaveBeenCalledTimes(1); expect(forget).toHaveBeenCalledTimes(1);
  await releaseSessionRuntime(api, true); expect(destroy).toHaveBeenCalledTimes(1); expect(forget).toHaveBeenCalledTimes(2);
});
