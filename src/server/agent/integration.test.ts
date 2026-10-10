// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { captureTmuxPaneText, writeCollaborationTmuxPane } from './collaborationTmuxDelivery.js';
import { randomUUID } from 'node:crypto';
import { clearPluginAgents, detectAgentFromCommand, inferResumeSessionId, registerPluginAgents } from './registry.js';
import type { LoadedPlugin } from './plugins.js';
import { selectTmuxForegroundProgram, type TmuxProcessRow } from '../utils/tmuxProgramDetection.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IntegrationStore, validatePolicy, type IntegrationPolicy, type IntegrationPrincipal } from './integrationStore.js';
import { IntegrationSessions, permittedCwd, integrationLaunchCommand, publicIntegrationSession, type IntegrationSessionAdapter, type IntegrationSession } from './integrationSessions.js';
import { IntegrationRuntime } from './integrationServer.js';
import { assertNativeResumeAvailable, collectNativeResumeOwnerCandidates } from './nativeResumeOwner.js';
import { readIntegrationCredential, runIntegrationAdmin, runIntegrationCollab } from './integrationCli.js';
import { CollaborationDeliveryWorker } from './collaborationDeliveryWorker.js';
import { CollaborationTaskStore } from './collaborationTaskStore.js';
import { CollaborationTaskService } from './collaborationTaskService.js';
import { CollaborationStore } from './collaborationStore.js';
import { parseCollaborationCommand } from './collaborationCli.js';
import { executeTaskCommand } from './collaborationTaskCli.js';
import type { CollaborationService } from './collaborationService.js';
import type { TaskOperation } from './collaborationTaskTypes.js';

let dir: string;
const resources: Array<() => unknown | Promise<unknown>> = [];
const serviceId = `12D3KooW${'a'.repeat(40)}`, worker = { serviceId, sessionId: 'worker' };
beforeEach(() => { dir = fs.mkdtempSync(path.join(tmpdir(), 'td-int-')); });
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close(); fs.rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });
function policy(groupId = 'group'): IntegrationPolicy {
  return { id: 'bridge', groupId, permissions: ['task.read', 'task.create', 'task.assign', 'task.comment', 'task.revise', 'task.answer', 'events.read', 'session.create', 'session.read', 'session.restore'],
    launchProfiles: [{ id: 'agent', agentSlug: 'fixture', executable: '/bin/sh', argv: ['-m', 'model', '-C', '{cwd}'], cwdRoots: [dir], resumeArgv: ['resume', '{sessionId}', '{launchArgs}'] }] };
}
function principal(): IntegrationPrincipal { return { ...policy(), tokenHash: 'unused', revoked: false }; }
function adapter() {
  let observed = { exists: false, running: false, shell: false, agentSlug: null as string | null, nativeId: null as string | null };
  const listeners = new Set<() => void>();
  const api: IntegrationSessionAdapter = { create: vi.fn(async () => {}), restore: vi.fn(async () => {}), inspect: vi.fn(async () => observed), subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; } };
  return { api, set(value: Partial<typeof observed>) { observed = { ...observed, ...value }; for (const fn of listeners) fn(); } };
}
it('authenticates a separate scoped identity, stores only credential hashes, and revokes existing grants', () => {
  const store = new IntegrationStore(path.join(dir, 'events.json'));
  const issued = store.provision(policy()), p = store.authenticate('bridge', issued.token);
  expect(fs.readFileSync(path.join(dir, 'events.json'), 'utf8')).not.toContain(issued.token);
  expect(() => store.authorize(p, 'task.read', 'other-group')).toThrow();
  expect(() => store.authenticate('bridge', 'wrong')).toThrow();
  store.revoke('bridge'); expect(() => store.authorize(p, 'task.read')).toThrow();
  expect(() => new IntegrationStore(path.join(dir, 'events.json')).authenticate('bridge', issued.token)).toThrow();
});
it('replays unacknowledged events with stable ids after restart; deduplication and retention gaps are explicit', () => {
  const file = path.join(dir, 'events.json'); let store = new IntegrationStore(file, 2);
  const issued = store.provision(policy()), p = store.authenticate('bridge', issued.token);
  store.page(p, 'inbox');
  const fact = (index: number) => ({ sourceKey: `fact:${index}`, sourceVersion: '1', event: { group_id: 'group', kind: 'task.report', created_at: index, payload: {} } });
  store.append([fact(1)]); const first = store.page(p, 'inbox').events[0];
  store = new IntegrationStore(file, 2); store.append([fact(1)]);
  expect(store.page(p, 'inbox').events).toEqual([first]);
  store.ack(p, 'inbox', first.cursor); expect(store.page(p, 'inbox').events).toEqual([]);
  store.append([fact(2), fact(3), fact(4)]);
  expect(() => store.page(p, 'inbox')).toThrow(/retained history/);
  expect(store.page(p, 'reconciled').events.map(e => e.sequence)).toEqual([3, 4]);
});
it('rejects unsafe profiles, symlink escapes and readable credential files', () => {
  expect(() => validatePolicy({ ...policy(), launchProfiles: [null as never] })).toThrow();
  const bad = policy(); bad.launchProfiles[0].resumeArgv = ['resume', '--last', '{sessionId}', '{launchArgs}'];
  expect(() => validatePolicy(bad)).toThrow(/--last/);
  fs.symlinkSync(tmpdir(), path.join(dir, 'outside'));
  expect(() => permittedCwd(policy().launchProfiles[0], path.join(dir, 'outside'))).toThrow();
  const file = path.join(dir, 'credential'); fs.writeFileSync(file, JSON.stringify({ id: 'bridge', token: 'private', protocol: 1 }), { mode: 0o644 });
  expect(() => readIntegrationCredential(file, 'bridge')).toThrow(/private/);
  fs.chmodSync(file, 0o600); expect(readIntegrationCredential(file, 'bridge').token).toBe('private');
  fs.symlinkSync(file, path.join(dir, 'link')); expect(() => readIntegrationCredential(path.join(dir, 'link'), 'bridge')).toThrow();
});
it('creates once, captures exact native binding, restores the original configuration and refuses identity changes', async () => {
  const fake = adapter(), file = path.join(dir, 'sessions.json'), p = principal();
  let sessions = new IntegrationSessions(file, fake.api); resources.push(() => sessions.close());
  const input = { profile: 'agent', cwd: dir, idempotencyKey: 'run-1' };
  const [created, retry] = await Promise.all([sessions.create(p, input), sessions.create(p, input)]);
  expect(created.session_id).toBe(retry.session_id); expect(fake.api.create).toHaveBeenCalledTimes(1);
  await expect(sessions.create(p, { ...input, cwd: '/tmp' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  fake.set({ exists: true, running: true, agentSlug: 'fixture', nativeId: null });
  expect((await sessions.get(p, created.session_id)).state).toBe('binding_pending');
  fake.set({ nativeId: 'real-native-uuid' });
  expect((await sessions.get(p, created.session_id)).agent_native_session_id).toBe('real-native-uuid');
  sessions.close(); sessions = new IntegrationSessions(file, fake.api);
  fake.set({ running: false, shell: true, nativeId: null });
  await sessions.get(p, created.session_id);
  p.launchProfiles[0].argv = ['changed-model'];
  await sessions.restore(p, created.session_id, 'restore-1');
  const launched = (fake.api.restore as ReturnType<typeof vi.fn>).mock.calls[0][0] as IntegrationSession;
  expect(launched.profile.argv).toEqual(['-m', 'model', '-C', '{cwd}']); expect(launched.agent_native_session_id).toBe('real-native-uuid');
  await expect(sessions.restore(p, created.session_id, 'restore-2')).rejects.toMatchObject({ code: 'SESSION_OPERATION_IN_PROGRESS' });
  fake.set({ running: true, shell: false, nativeId: 'different-native' });
  expect(await sessions.get(p, created.session_id)).toMatchObject({ state: 'failed', error_code: 'NATIVE_SESSION_ID_MISMATCH' });
  await expect(sessions.restore(p, created.session_id, 'restore-3')).rejects.toMatchObject({ code: 'SESSION_IDENTITY_MISMATCH' });
});
it('keeps startup failure durable and makes retries observe the failed intent without launching again', async () => {
  const fake = adapter(); (fake.api.create as ReturnType<typeof vi.fn>).mockRejectedValue(Object.assign(new Error('secret wrapper output'), { code: 'COLLAB_AGENT_UNAVAILABLE' }));
  const file = path.join(dir, 'sessions.json'), p = principal(), input = { profile: 'agent', cwd: dir, idempotencyKey: 'run' };
  const sessions = new IntegrationSessions(file, fake.api); resources.push(() => sessions.close());
  const result = await sessions.create(p, input); expect(result).toMatchObject({ state: 'failed', error_code: 'COLLAB_AGENT_UNAVAILABLE' });
  const restarted = new IntegrationSessions(file, fake.api); resources.push(() => restarted.close());
  expect((await restarted.create(p, input)).session_id).toBe(result.session_id); expect(fake.api.create).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(file, 'utf8')).not.toContain('secret wrapper output');
});
it('persists private restore evidence across restart without leaking it in public sessions, and clears it on a new launch', async () => {
  const fake = adapter(), file = path.join(dir, 'diagnostic-sessions.json'), p = principal();
  fake.set({ exists: true, running: true, agentSlug: 'fixture', nativeId: 'original-native' });
  let sessions = new IntegrationSessions(file, fake.api); resources.push(() => sessions.close());
  const created = await sessions.create(p, { profile: 'agent', cwd: dir, idempotencyKey: 'initial' });
  fake.set({ running: false, shell: true, nativeId: null });
  fake.api.restore = vi.fn(async () => assertNativeResumeAvailable({ slug: 'fixture', nativeSessionId: 'original-native' }, 'own',
    [{ backendSessionId: 'outside-backend', sessionId: 'outside-td', tmuxSessionName: 'outside-tmux', cachedSlug: 'fixture', cachedNativeId: 'other-native' }],
    async () => [{ confirmed: true, agentSlug: 'fixture', nativeId: null, paneId: '%115', panePid: 115, argumentsObserved: true }]));
  const failed = await sessions.restore(p, created.session_id, 'blocked');
  expect(failed).toMatchObject({ state: 'failed', error_code: 'NATIVE_SESSION_OWNER_UNCONFIRMED' });
  const stored = sessions.restoreDiagnostics(created.session_id);
  expect(stored.diagnostics).toMatchObject({ operation_id: failed.operation_id, code: failed.error_code,
    candidates: [{ session_id: 'outside-td', pane_id: '%115', reason: 'NATIVE_SESSION_ID_MISSING' }] });
  expect(publicIntegrationSession(failed)).toHaveProperty('restore_diagnostics_available', true);
  expect(JSON.stringify(publicIntegrationSession(failed))).not.toContain('outside-td');
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  const probes = (fake.api.inspect as ReturnType<typeof vi.fn>).mock.calls.length;
  sessions.restoreDiagnostics(created.session_id);
  expect((fake.api.inspect as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(probes);
  sessions.close(); sessions = new IntegrationSessions(file, fake.api);
  expect(sessions.restoreDiagnostics(created.session_id)).toEqual(stored);
  await sessions.restore(p, created.session_id, 'blocked'); expect(fake.api.restore).toHaveBeenCalledTimes(1);
  fake.api.restore = vi.fn(async () => { fake.set({ running: true, shell: false, nativeId: 'original-native' }); });
  const restored = await sessions.restore(p, created.session_id, 'new-real-restore');
  expect(restored).toMatchObject({ state: 'ready', session_id: created.session_id, agent_native_session_id: 'original-native' });
  expect(sessions.restoreDiagnostics(created.session_id).diagnostics).toBeNull();
  expect(publicIntegrationSession(restored)).not.toHaveProperty('restore_diagnostics_available');
});
it('preserves acceptance, result and original attempt for consultation; only the original assignee can respond', () => {
  vi.useFakeTimers(); vi.setSystemTime(100000);
  const file = path.join(dir, 'tasks.json'); let store = new CollaborationTaskStore(file);
  const origin = { integrationId: 'bridge', source: 'external', externalActor: { id: 'external-user' } };
  const created = store.create(serviceId, { groupId: 'group', title: 'Report', spec: 'Deliver', assignee: worker, idempotencyKey: 'run' }, null, origin);
  const apply = (input: Omit<TaskOperation, 'idempotencyKey'>, actor: typeof worker | null = null) => store.apply(created.id, { ...input, idempotencyKey: randomUUID() }, actor);
  vi.advanceTimersByTime(1);
  const done = apply({ kind: 'report', attemptId: created.activeAttemptId!, status: 'complete', content: 'Result' }, worker), artifact = done.artifacts[0];
  const accepted = apply({ kind: 'accept', expectedRevision: done.revision, artifactId: artifact.id });
  const op: TaskOperation = { kind: 'comment', content: 'Explain this result', idempotencyKey: 'followup' };
  const comment = store.apply(created.id, op, null, origin), event = comment.events.at(-1)!;
  store = new CollaborationTaskStore(file);
  expect(store.apply(created.id, op, null, origin).revision).toBe(comment.revision);
  expect(event).toMatchObject({ source: 'integration', origin, attemptId: created.activeAttemptId });
  expect(store.pending(created.id).at(-1)).toMatchObject({ replyToEventId: event.id, target: worker, attemptId: created.activeAttemptId });
  expect(() => apply({ kind: 'respond', attemptId: created.activeAttemptId!, replyToEventId: event.id, content: 'Wrong author' }, { ...worker, sessionId: 'other' })).toThrow();
  const responded = apply({ kind: 'respond', attemptId: created.activeAttemptId!, replyToEventId: event.id, content: 'Explanation' }, worker);
  expect(responded.events.at(-1)).toMatchObject({ kind: 'respond', replyToEventId: event.id });
  expect(responded.status).toBe('accepted'); expect(responded.artifacts).toEqual(accepted.artifacts); expect(responded.attempts).toEqual(accepted.attempts);
  expect(responded.acceptedArtifactId).toBe(artifact.id);
  expect(() => store.apply(created.id, { kind: 'accept', artifactId: artifact.id, expectedRevision: responded.revision, idempotencyKey: 'fake-accept' }, null, origin)).toThrow(/用户/);
  vi.advanceTimersByTime(1);
  const revised = store.apply(created.id, { kind: 'revise', content: 'New scope', expectedRevision: responded.revision, idempotencyKey: 'revise' }, null, origin);
  expect(revised.status).toBe('open'); expect(revised.activeAttemptId).toBe(created.activeAttemptId); expect(revised.acceptedArtifactId).toBeUndefined();
  expect(() => apply({ kind: 'accept', expectedRevision: revised.revision, artifactId: artifact.id })).toThrow(/新结果/);
  vi.advanceTimersByTime(1);
  const redone = apply({ kind: 'report', attemptId: created.activeAttemptId!, status: 'complete', content: 'New result' }, worker);
  expect(redone.artifacts.at(-1)?.id).not.toBe(artifact.id); expect(redone.events.at(-1)?.artifactId).toBe(redone.artifacts.at(-1)?.id);
});
it('retains the old --integration switch and exposes independent principal / correlated response CLI arguments', async () => {
  expect(parseCollaborationCommand(['task', 'create', '--integration', '--group', 'g', '--title', 't', '--content', 'c']).options.integration).toBe(true);
  const command = parseCollaborationCommand(['--session', 'worker', 'task', 'respond', 'task-id', '--attempt', 'attempt-id', '--to-event', 'event-id', '--content', 'reply']);
  const request = vi.fn(async () => ({})); await executeTaskCommand(command, request, { write: () => {}, request: async () => ({ statusCode: 200, body: '{}' }) });
  expect(request).toHaveBeenCalledWith('POST', '/tasks/task-id', { input: expect.objectContaining({ kind: 'respond', attemptId: 'attempt-id', replyToEventId: 'event-id' }) });
  expect(() => parseCollaborationCommand(['--principal', 'bridge', '--session', 'worker', 'capabilities'])).toThrow();
  expect(() => parseCollaborationCommand(['--principal', '', 'capabilities'])).toThrow();
  expect(() => parseCollaborationCommand(['--principal', 'bridge', 'session', 'restore', 's', '--idempotency-key', 'k', '--launch-profile', 'other'])).toThrow();
});

async function runtimeFixture(sessionAdapter?: IntegrationSessionAdapter) {
  const messages = new CollaborationStore(path.join(dir, 'groups.json')), group = messages.save({ name: 'Local fixture', sessionIds: ['worker'] });
  const taskStore = new CollaborationTaskStore(path.join(dir, 'tasks.json'));
  const peers = { descriptor: () => ({ serviceId }), taskMember: (sessionId: string) => ({ serviceId, sessionId }), taskSession: (m: typeof worker) => m.sessionId } as unknown as CollaborationService;
  const tasks = new CollaborationTaskService(taskStore, messages, peers, () => {});
  const options = { directory: dir, socketPath: path.join(dir, 'api.sock'), adminToken: 'local-admin', messages, taskStore, tasks, peers, sessions: sessionAdapter ?? adapter().api };
  const runtime = new IntegrationRuntime(options); await runtime.listen(); resources.push(() => runtime.close());
  const issued = runtime.store.provision(policy(group.id));
  const headers = { 'x-termdock-integration-protocol': '1', 'x-termdock-integration-id': 'bridge', authorization: `Bearer ${issued.token}`, 'Content-Type': 'application/json' };
  const request = (method: string, route: string, body?: unknown, requestHeaders: Record<string, string> = headers) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({ socketPath: options.socketPath, method, path: route, headers: requestHeaders }, res => {
      let raw = ''; res.on('data', chunk => { raw += chunk; }); res.once('end', () => resolve({ status: res.statusCode!, body: JSON.parse(raw) }));
    }); req.once('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const stream = () => {
    const events: any[] = [], waiters: Array<() => void> = [];
    const req = http.get({ socketPath: options.socketPath, path: '/events?consumer=inbox', headers }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', chunk => { raw += chunk; for (;;) { const end = raw.indexOf('\n'); if (end < 0) break; events.push(JSON.parse(raw.slice(0, end))); raw = raw.slice(end + 1); for (const wake of waiters.splice(0)) wake(); } });
    }); req.on('error', () => {}); resources.push(() => { req.destroy(); });
    return { req, events, async next() { if (!events.length) await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('No pushed event')), 3000); waiters.push(() => { clearTimeout(timer); resolve(); }); }); return events.shift(); } };
  };
  return { runtime, messages, group, taskStore, request, stream, options, issued };
}
it('requires an explicit configure grant, preserves identity credentials, and pushes a durable background-purpose migration', async () => {
  const f = await runtimeFixture();
  const created = await f.request('POST', '/tasks', { input: { title: 'Existing', spec: 'Already executed', idempotencyKey: 'create', assigneeSessionId: 'worker' } });
  const task = created.body.task;
  f.taskStore.apply(task.id, { kind: 'report', status: 'complete', attemptId: task.activeAttemptId, content: 'Original result', idempotencyKey: 'complete' }, worker);
  const original = f.taskStore.get(task.id)!, outbox = f.taskStore.pending(task.id);
  const body = { input: { kind: 'configure', purpose: 'automation', expectedRevision: original.revision, idempotencyKey: 'migrate' } };
  expect(await f.request('POST', `/tasks/${task.id}`, body)).toMatchObject({ status: 403, body: { code: 'INTEGRATION_PERMISSION_DENIED' } });
  expect(f.taskStore.get(task.id)).toEqual(original);
  const updated = policy(f.group.id); updated.permissions.push('task.configure');
  f.runtime.store.update(updated);
  expect(f.runtime.store.authenticate('bridge', f.issued.token).permissions).toContain('task.configure');
  const stream = f.stream();
  const result = await f.request('POST', `/tasks/${task.id}`, body);
  expect(result).toMatchObject({ status: 200, body: { task: { id: task.id, purpose: 'automation', activeAttemptId: task.activeAttemptId,
    status: 'open', execution: { status: 'complete', artifactId: original.artifacts[0].id } } } });
  expect(f.taskStore.pending(task.id)).toEqual(outbox);
  expect(result.body.task.attempts).toEqual(original.attempts); expect(result.body.task.artifacts).toEqual(original.artifacts);
  let event: any;
  for (let i = 0; i < 20; i++) { event = await stream.next(); if (event.kind === 'task.configured') break; }
  expect(event).toMatchObject({ type: 'event', task_id: task.id, kind: 'task.configured', payload: { event: { purpose: 'automation', source: 'integration' } } });
  expect(event.event_id).toBe(result.body.event_id);
  const replay = new IntegrationStore(path.join(dir, 'integrations.json'));
  const p = replay.authenticate('bridge', f.issued.token);
  expect(replay.page(p, 'inbox').events.some(e => e.event_id === event.event_id)).toBe(true);
  expect(await f.request('POST', '/events/ack', { consumer: 'inbox', cursor: event.cursor })).toMatchObject({ status: 200 });
  expect(await f.request('POST', `/tasks/${task.id}`, body)).toMatchObject({ status: 200, body: { event_id: result.body.event_id } });
  expect(f.taskStore.get(task.id)?.events.filter(e => e.kind === 'configured')).toHaveLength(1);
  expect(new CollaborationTaskStore(path.join(dir, 'tasks.json')).get(task.id)?.purpose).toBe('automation');
});
it('creates scoped background records, returns current execution in summaries and rejects cross-group migrations or forged acceptance', async () => {
  const f = await runtimeFixture();
  expect((await f.request('GET', '/capabilities')).body).toMatchObject({ background_task_records: true, task_purpose_configuration: true, explicit_execution_state: true, external_validation: false });
  const input = { title: 'Background', spec: 'Run', purpose: 'automation', idempotencyKey: 'background', assigneeSessionId: 'worker' };
  const created = await f.request('POST', '/tasks', { input });
  expect(created.body.task).toMatchObject({ purpose: 'automation', execution: { status: 'awaiting_report', artifactId: null } });
  expect((await f.request('POST', '/tasks', { input })).body.task.id).toBe(created.body.task.id);
  const task = created.body.task;
  f.taskStore.apply(task.id, { kind: 'report', status: 'complete', attemptId: task.activeAttemptId, content: 'Evidence', idempotencyKey: 'finish' }, worker);
  const listed = await f.request('GET', '/tasks?purpose=automation');
  expect(listed.body.tasks[0]).toMatchObject({ purpose: 'automation', execution: { status: 'complete' }, status: 'open' });
  expect((await f.request('GET', '/tasks?purpose=interactive')).body.tasks).toEqual([]);
  expect(await f.request('GET', '/tasks?purpose=invalid')).toMatchObject({ status: 400, body: { code: 'INVALID_TASK_PURPOSE' } });
  expect(await f.request('POST', '/tasks', { input: { ...input, purpose: 'all', idempotencyKey: 'invalid' } })).toMatchObject({ status: 400 });
  expect(await f.request('POST', `/tasks/${task.id}`, { input: { kind: 'accept', idempotencyKey: 'fake' } })).toMatchObject({ status: 403 });
  const other = f.taskStore.create(serviceId, { groupId: 'outside', title: 'Other', spec: 'Other', idempotencyKey: 'outside' }, null);
  expect(await f.request('POST', `/tasks/${other.id}`, { input: { kind: 'configure', purpose: 'automation', expectedRevision: 1, idempotencyKey: 'outside-configure' } })).toMatchObject({ status: 404 });
});
it('restricts cross-terminal restore diagnostics to the real administrator socket, excluding principal responses and events', async () => {
  const fake = adapter(); fake.set({ exists: true, running: true, agentSlug: 'fixture', nativeId: 'native' });
  fake.api.restore = async () => assertNativeResumeAvailable({ slug: 'fixture', nativeSessionId: 'native' }, 'own',
    [{ backendSessionId: 'outside-backend', sessionId: 'outside-td', cachedSlug: 'fixture', cachedNativeId: null }],
    async () => [{ confirmed: true, agentSlug: 'fixture', nativeId: null, paneId: '%115', panePid: 115 }]);
  const f = await runtimeFixture(fake.api);
  const created = await f.request('POST', '/sessions', { group_id: f.group.id, launch_profile: 'agent', cwd: dir, idempotency_key: 'initial' });
  const id = created.body.session.session_id;
  fake.set({ running: false, shell: true, nativeId: null });
  const failed = await f.request('POST', `/sessions/${id}/restore`, { idempotency_key: 'blocked' });
  expect(failed.body.session).toMatchObject({ error_code: 'NATIVE_SESSION_OWNER_UNCONFIRMED', restore_diagnostics_available: true });
  expect(JSON.stringify(failed.body)).not.toContain('outside-td');
  expect(await f.request('GET', `/admin/sessions/${id}/restore-diagnostics`)).toMatchObject({ status: 401 });
  const headers = { 'x-termdock-integration-protocol': '1', 'x-termdock-local-token': 'local-admin' };
  const probes = (fake.api.inspect as ReturnType<typeof vi.fn>).mock.calls.length;
  expect(await f.request('GET', `/admin/sessions/${id}/restore-diagnostics`, undefined, headers)).toMatchObject({ status: 200,
    body: { session_id: id, diagnostics: { candidates: [{ session_id: 'outside-td', pane_id: '%115', reason: 'NATIVE_SESSION_ID_MISSING' }] } } });
  expect((fake.api.inspect as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(probes);
  expect(await f.request('GET', '/admin/sessions/missing/restore-diagnostics', undefined, headers)).toMatchObject({ status: 404 });
  expect(await f.request('GET', '/capabilities')).toMatchObject({ body: { session_restore_diagnostics: true } });
  expect(JSON.stringify((await f.request('GET', `/sessions/${id}`)).body)).not.toContain('outside-td');
  expect(fs.readFileSync(path.join(dir, 'integrations.json'), 'utf8')).not.toContain('outside-td');
});
it('pushes from durable task changes through an actual socket; read is not ACK, reconnect replays, revocation closes', async () => {
  const f = await runtimeFixture(), subscription = f.stream();
  const response = await f.request('POST', '/tasks', { input: { groupId: f.group.id, title: 'Bridge task', spec: 'Read only', idempotencyKey: 'run' }, origin: { source: 'fixture', externalActor: { id: 'user' } } });
  expect(response.status).toBe(200);
  const event = await subscription.next(); expect(event).toMatchObject({ type: 'event', kind: 'task.created', event_id: response.body.task.events[0].id, source: 'integration', external_actor: { id: 'user' } });
  subscription.req.destroy(); const reconnect = f.stream(); expect((await reconnect.next()).event_id).toBe(event.event_id);
  expect(await f.request('POST', '/events/ack', { cursor: event.cursor, consumer: 'inbox' })).toMatchObject({ status: 200, body: { ack_semantics: 'durable_received' } });
  f.runtime.store.revoke('bridge'); expect(await reconnect.next()).toMatchObject({ type: 'error', code: 'INTEGRATION_REVOKED', retryable: false });
  expect(await f.request('GET', '/capabilities')).toMatchObject({ status: 403, body: { code: 'INTEGRATION_REVOKED' } });
});
it('denies scope violations, principal impersonation, user acceptance and unsent ACKs on the real endpoint', async () => {
  const f = await runtimeFixture();
  expect(await f.request('GET', '/capabilities', undefined, { ...{ 'Content-Type': 'application/json' }, 'x-termdock-integration-protocol': '999' } as any)).toMatchObject({ status: 409 });
  expect(await f.request('GET', '/admin/principals')).toMatchObject({ status: 401 });
  expect(await f.request('POST', '/tasks', { input: { groupId: 'other', title: 'No', spec: 'No', idempotencyKey: 'x' } })).toMatchObject({ status: 403 });
  const created = await f.request('POST', '/tasks', { input: { title: 'Task', spec: 'Run', idempotencyKey: 'x', assigneeSessionId: 'worker' } });
  expect(created.status).toBe(200);
  for (const kind of ['accept', 'report', 'respond', 'approve-plan', 'close']) expect(await f.request('POST', `/tasks/${created.body.task.id}`, { input: { kind, idempotencyKey: kind } })).toMatchObject({ status: 403 });
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'integrations.json'), 'utf8'));
  expect(() => f.runtime.store.authenticate('bridge', persisted.principals[0].tokenHash)).toThrow();
  const p = f.runtime.store.authenticate('bridge', f.issued.token);
  const event = f.runtime.store.page(p, 'not-subscribed').events[0];
  expect(await f.request('POST', '/events/ack', { consumer: 'not-subscribed', cursor: event.cursor })).toMatchObject({ status: 409, body: { code: 'EVENT_ACK_NOT_SENT' } });
});

it('requires administration for a policy update and exposes the configured condition with the original credential', async () => {
  const f = await runtimeFixture();
  const adminHeaders = { 'Content-Type': 'application/json', 'x-termdock-integration-protocol': '1', 'x-termdock-local-token': 'local-admin' };
  const updated = policy(f.group.id);
  updated.launchProfiles[0].startupInput = { allOf: ['MODEL READY', '❯'], noneOf: ['model: loading'], stableMs: 1000, timeoutMs: 120000 };
  expect(await f.request('POST', '/admin/principals/bridge/policy', updated)).toMatchObject({ status: 401 });
  expect(await f.request('GET', '/admin/capabilities', undefined, adminHeaders)).toMatchObject({ status: 200, body: { startup_input_conditions: true, integration_policy_update: true } });
  expect(await f.request('POST', '/admin/principals/bridge/policy', updated, adminHeaders)).toMatchObject({ status: 200, body: { ok: true, id: 'bridge' } });
  expect(await f.request('GET', '/capabilities')).toMatchObject({ status: 200, body: { principal: { group_id: f.group.id, launch_profiles: [{ id: 'agent', startup_input_condition: true }] } } });
  expect(f.runtime.store.authenticate('bridge', f.issued.token).launchProfiles[0].startupInput).toEqual(updated.launchProfiles[0].startupInput);
  const other = f.messages.save({ name: 'Another local group', sessionIds: ['worker'] });
  expect(await f.request('POST', '/admin/principals/bridge/policy', { ...updated, groupId: other.id }, adminHeaders)).toMatchObject({ status: 409, body: { code: 'INTEGRATION_GROUP_IMMUTABLE' } });
  expect(await f.request('POST', '/admin/principals/bridge/policy', { ...updated, id: 'other' }, adminHeaders)).toMatchObject({ status: 400, body: { code: 'INVALID_INTEGRATION_POLICY' } });
});

it('reconciles a source commit missed during service shutdown and replays the same event across journal restart', async () => {
  const f = await runtimeFixture(); await f.runtime.close();
  const task = f.taskStore.create(serviceId, { groupId: f.group.id, title: 'Offline commit', spec: 'Recover journal', idempotencyKey: 'offline' }, null);
  let restarted = new IntegrationRuntime(f.options); await restarted.listen();
  resources.push(() => restarted.close());
  const event = await f.stream().next(); expect(event).toMatchObject({ event_id: task.events[0].id, kind: 'task.created' });
  await restarted.close(); restarted = new IntegrationRuntime(f.options); await restarted.listen();
  expect((await f.stream().next()).event_id).toBe(event.event_id);
});

it('passes the exact native UUID, model flags and quoted paths through a real shell without executing argument contents', () => {
  const wrapper = path.join(dir, 'wrapper'), output = path.join(dir, 'argv.json');
  fs.writeFileSync(wrapper, '#!/usr/bin/env node\nrequire("fs").writeFileSync(process.env.TD_TEST_ARGV, JSON.stringify(process.argv.slice(2)));\n', { mode: 0o700 });
  const record = { profile: { ...policy().launchProfiles[0], executable: wrapper, argv: ['-m', "model'variant", '-c', '$(touch INTEGRATION_INJECTION)', '-C', '{cwd}'] }, cwd: path.join(dir, "quote' space"), agent_native_session_id: 'native-uuid' } as IntegrationSession;
  fs.mkdirSync(record.cwd);
  execFileSync('/bin/sh', ['-c', integrationLaunchCommand(record, true)], { cwd: dir, env: { ...process.env, TD_TEST_ARGV: output } });
  expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toEqual(['resume', 'native-uuid', '-m', "model'variant", '-c', '$(touch INTEGRATION_INJECTION)', '-C', record.cwd]);
  expect(fs.existsSync(path.join(dir, 'INTEGRATION_INJECTION'))).toBe(false);
  expect(() => permittedCwd(policy().launchProfiles[0], path.join(dir, '\ncommand'))).toThrow();
});

it('expires pending native binding even when the Agent is running and resumes timeout observation after restart', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const fake = adapter(), file = path.join(dir, 'sessions.json'), p = principal();
  let sessions = new IntegrationSessions(file, fake.api, 50); resources.push(() => sessions.close());
  const created = await sessions.create(p, { profile: 'agent', cwd: dir, idempotencyKey: 'timeout' });
  fake.set({ exists: true, running: true, agentSlug: 'fixture', nativeId: null });
  expect((await sessions.get(p, created.session_id)).state).toBe('binding_pending');
  sessions.close(); sessions = new IntegrationSessions(file, fake.api, 50);
  await vi.advanceTimersByTimeAsync(56);
  expect((await sessions.get(p, created.session_id))).toMatchObject({ state: 'failed', error_code: 'SESSION_BINDING_TIMEOUT' });
});
it('serializes simultaneous restore validation before any launch, including requests with different keys', async () => {
  const fake = adapter(), p = principal(), sessions = new IntegrationSessions(path.join(dir, 'sessions.json'), fake.api); resources.push(() => sessions.close());
  const created = await sessions.create(p, { profile: 'agent', cwd: dir, idempotencyKey: 'create' });
  fake.set({ exists: true, running: true, agentSlug: 'fixture', nativeId: 'native' }); await sessions.get(p, created.session_id);
  fake.set({ running: false, shell: true, nativeId: null }); await sessions.get(p, created.session_id);
  const restoring = sessions.restore(p, created.session_id, 'restore-a');
  await expect(sessions.restore(p, created.session_id, 'restore-b')).rejects.toMatchObject({ code: 'SESSION_OPERATION_IN_PROGRESS' });
  await restoring; expect(fake.api.restore).toHaveBeenCalledTimes(1);
});

it('returns the original comment receipt after later events and an uncertain idempotent retry', async () => {
  const f = await runtimeFixture();
  const created = await f.request('POST', '/tasks', { input: { title: 'Task', spec: 'Run', idempotencyKey: 'create', assigneeSessionId: 'worker' } });
  const route = `/tasks/${created.body.task.id}`, body = { input: { kind: 'comment', content: 'Question one', idempotencyKey: 'comment-one' } };
  const first = await f.request('POST', route, body);
  await f.request('POST', route, { input: { kind: 'comment', content: 'Question two', idempotencyKey: 'comment-two' } });
  const retry = await f.request('POST', route, body);
  expect(retry.body.event_id).toBe(first.body.event_id); expect(retry.body.delivery_id).toBe(first.body.delivery_id);
  expect(retry.body.attempt_id).toBe(first.body.attempt_id);
  const reload = new CollaborationTaskStore(path.join(dir, 'tasks.json'));
  expect(reload.integrationRequestEvent('bridge', 'comment-one', created.body.task.id)?.id).toBe(first.body.event_id);
});

it('returns the actual grant and refuses create/assignment escalation for a read-only principal', async () => {
  const f = await runtimeFixture();
  const issued = f.runtime.store.provision({ ...policy(f.group.id), id: 'readonly', permissions: ['task.read', 'events.read'], launchProfiles: [] });
  const headers = { 'x-termdock-integration-protocol': '1', 'x-termdock-integration-id': 'readonly', authorization: `Bearer ${issued.token}`, 'Content-Type': 'application/json' };
  expect(await f.request('GET', '/capabilities', undefined, headers)).toMatchObject({ status: 200, body: { principal: { id: 'readonly', group_id: f.group.id, permissions: ['task.read', 'events.read'], launch_profiles: [] } } });
  expect(await f.request('POST', '/tasks', { input: { title: 'No', spec: 'No', idempotencyKey: 'no' } }, headers)).toMatchObject({ status: 403, body: { code: 'INTEGRATION_PERMISSION_DENIED' } });
  expect(await f.request('POST', '/sessions', { launch_profile: 'agent', cwd: dir, idempotency_key: 'no' }, headers)).toMatchObject({ status: 403 });
  const outside = f.messages.save({ name: 'Private other group', sessionIds: ['worker'] });
  const task = f.taskStore.create(serviceId, { groupId: outside.id, title: 'Hidden', spec: 'Private', idempotencyKey: 'private' }, null);
  expect(await f.request('GET', `/tasks/${task.id}`)).toMatchObject({ status: 404 });
});

it('holds the first write through a loading viewport and delivers once without waiting for a native UUID', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100000);
  const fake = adapter(), p = principal();
  p.launchProfiles[0].startupInput = { allOf: ['model: GPT-5.5 (MAX)', '❯'], noneOf: ['model: loading'], stableMs: 500, timeoutMs: 10000 };
  let viewport = 'model: loading\n❯ Ask the Agent';
  fake.api.capture = vi.fn(async () => viewport);
  fake.set({ exists: true, running: true, agentSlug: 'fixture', nativeId: null });
  const file = path.join(dir, 'startup-sessions.json');
  const sessions = new IntegrationSessions(file, fake.api); resources.push(() => sessions.close());
  const created = await sessions.create(p, { profile: 'agent', cwd: dir, idempotencyKey: 'first' });
  const messages = new CollaborationStore(path.join(dir, 'startup-messages.json'));
  const group = messages.save({ name: 'Startup', sessionIds: ['sender', created.session_id] });
  const message = messages.send({ groupId: group.id, fromSessionId: 'sender', toSessionIds: [created.session_id], kind: 'message', content: 'First task body' })[0];
  const write = vi.fn(async () => {});
  const delivery = new CollaborationDeliveryWorker({ store: messages, peers: () => [], isLocal: () => true, onError: () => {},
    resolve: async id => { const gate = await sessions.deliveryReadiness(id); return gate?.allowed ? { state: 'ready', write } : { state: 'recovering', reason: gate?.reason ?? 'missing guard' }; } });
  resources.push(() => delivery.stop());
  await delivery.run(created.session_id);
  expect(messages.receipt(message.id)).toMatchObject({ status: 'pending', attempt_count: 0, last_error: 'SESSION_STARTUP_INPUT_PENDING' });
  expect(write).not.toHaveBeenCalled();
  viewport = 'model:     GPT-5.5 (MAX) xhigh\n❯ Implement something';
  await vi.advanceTimersByTimeAsync(2000);
  expect(await sessions.deliveryReadiness(created.session_id)).toMatchObject({ allowed: false });
  await vi.advanceTimersByTimeAsync(500);
  await delivery.run(created.session_id);
  expect(messages.receipt(message.id)).toMatchObject({ status: 'delivered', attempt_count: 1 });
  expect(write).toHaveBeenCalledTimes(1);
  expect(await sessions.get(p, created.session_id)).toMatchObject({ state: 'binding_pending', agent_native_session_id: null, startup_input: { state: 'observed' } });
  viewport = 'Agent is processing and has no input prompt';
  await delivery.run(created.session_id);
  expect(await sessions.deliveryReadiness(created.session_id)).toMatchObject({ allowed: true });
  expect(write).toHaveBeenCalledTimes(1);
});
it('persists input timeout, resets partial matches on restart and rechecks the original conditions on exact restore', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100000);
  const fake = adapter(), p = principal(), file = path.join(dir, 'startup-timeout.json');
  p.launchProfiles[0].startupInput = { allOf: ['MODEL READY', '❯'], stableMs: 500, timeoutMs: 1000 };
  let viewport = 'loading'; fake.api.capture = vi.fn(async () => viewport);
  fake.set({ exists: true, running: true, agentSlug: 'fixture', nativeId: 'native' });
  let sessions = new IntegrationSessions(file, fake.api); resources.push(() => sessions.close());
  const created = await sessions.create(p, { profile: 'agent', cwd: dir, idempotencyKey: 'timeout' });
  expect(created.state).toBe('ready'); // Binding is independent of the input condition.
  await vi.advanceTimersByTimeAsync(1006);
  expect(await sessions.deliveryReadiness(created.session_id)).toEqual({ allowed: false, reason: 'SESSION_STARTUP_INPUT_TIMEOUT' });
  viewport = 'MODEL READY\n❯';
  expect((await sessions.get(p, created.session_id)).startup_input?.matched_since).toBe(101006);
  sessions.close(); sessions = new IntegrationSessions(file, fake.api); resources.push(() => sessions.close());
  await vi.advanceTimersByTimeAsync(600);
  expect(await sessions.deliveryReadiness(created.session_id)).toMatchObject({ allowed: false });
  await vi.advanceTimersByTimeAsync(500);
  expect(await sessions.deliveryReadiness(created.session_id)).toMatchObject({ allowed: true });
  fake.set({ running: false, shell: true, nativeId: null });
  p.launchProfiles[0].startupInput = { allOf: ['CHANGED CONDITION'] };
  await sessions.restore(p, created.session_id, 'restore');
  const restored = (fake.api.restore as ReturnType<typeof vi.fn>).mock.calls[0][0] as IntegrationSession;
  expect(restored.profile.startupInput?.allOf).toEqual(['MODEL READY', '❯']);
  expect(restored.startup_input?.state).toBe('pending');
  expect(await sessions.deliveryReadiness(created.session_id)).toMatchObject({ allowed: false });
  fake.set({ running: true, shell: false, nativeId: 'other-native' });
  expect(await sessions.deliveryReadiness(created.session_id)).toEqual({ allowed: false, reason: 'NATIVE_SESSION_ID_MISMATCH' });
});
it('fails closed on missing capture and validates literal startup conditions', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100000);
  const fake = adapter(), p = principal();
  const bad = policy(); bad.launchProfiles[0].startupInput = { allOf: [] };
  expect(() => validatePolicy(bad)).toThrow(/startupInput/);
  bad.launchProfiles[0].startupInput = { allOf: ['READY'], stableMs: 0 };
  expect(() => validatePolicy(bad)).toThrow(/startupInput/);
  p.launchProfiles[0].startupInput = { allOf: ['READY'], timeoutMs: 1000 };
  fake.set({ exists: true, running: true, agentSlug: 'fixture', nativeId: null });
  const sessions = new IntegrationSessions(path.join(dir, 'capture-missing.json'), fake.api); resources.push(() => sessions.close());
  const created = await sessions.create(p, { profile: 'agent', cwd: dir, idempotencyKey: 'missing' });
  expect(await sessions.deliveryReadiness('ordinary-session')).toBeNull();
  await vi.advanceTimersByTimeAsync(1001);
  expect(await sessions.deliveryReadiness(created.session_id)).toEqual({ allowed: false, reason: 'SESSION_STARTUP_INPUT_TIMEOUT' });
});
it('refuses to provision startup conditions against an older running service before creating a credential file', async () => {
  const server = http.createServer((_req, res) => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 'NOT_FOUND', error: 'Older integration endpoint' })); });
  // The CLI derives its private socket from the selected service port.
  const port = 60000 + Math.floor(Math.random() * 5000);
  const socket = (await import('./integrationServer.js')).integrationSocketPath(port);
  await new Promise<void>(resolve => server.listen(socket, resolve)); resources.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const p = policy(); p.launchProfiles[0].startupInput = { allOf: ['READY'] };
  const policyFile = path.join(dir, 'policy.json'), credentialFile = path.join(dir, 'credential-new.json');
  fs.writeFileSync(policyFile, JSON.stringify(p));
  const output: string[] = [];
  expect(await runIntegrationAdmin(['create', '--file', policyFile, '--credential-file', credentialFile], port, 'admin', line => output.push(line))).toBe(1);
  expect(fs.existsSync(credentialFile)).toBe(false);
  expect(output.join('')).toContain('NOT_FOUND');
});
it('preflights administrator diagnostic capability and reads without posting or attaching a terminal', async () => {
  let supported = false; const requests: string[] = [];
  const report = { session_id: 'target', operation_id: 'last-operation', diagnostics: { candidates: [{ pane_id: '%115', reason: 'NATIVE_SESSION_ID_MISSING' }] } };
  const server = http.createServer((req, res) => {
    expect(req.method).toBe('GET'); expect(req.headers['x-termdock-local-token']).toBe('private-admin'); requests.push(req.url!);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/admin/capabilities' ? { session_restore_diagnostics: supported } : report));
  });
  const port = 60000 + Math.floor(Math.random() * 5000), socket = (await import('./integrationServer.js')).integrationSocketPath(port);
  await new Promise<void>(resolve => server.listen(socket, resolve)); resources.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const output: string[] = [];
  expect(await runIntegrationAdmin(['diagnostics', 'target'], port, 'private-admin', line => output.push(line))).toBe(1);
  expect(JSON.parse(output.pop()!)).toMatchObject({ code: 'SESSION_RESTORE_DIAGNOSTICS_UNSUPPORTED' });
  expect(requests).toEqual(['/admin/capabilities']);
  supported = true;
  expect(await runIntegrationAdmin(['diagnostics', 'target'], port, 'private-admin', line => output.push(line))).toBe(0);
  expect(JSON.parse(output.pop()!)).toEqual(report);
  expect(requests).toEqual(['/admin/capabilities', '/admin/capabilities', '/admin/sessions/target/restore-diagnostics']);
});

it('updates a policy without rotating credentials or moving the existing identity to another group', () => {
  const store = new IntegrationStore(path.join(dir, 'policy-update.json'));
  const issued = store.provision(policy());
  const updated = policy(); updated.launchProfiles[0].startupInput = { allOf: ['MODEL READY'] };
  store.update(updated);
  expect(store.authenticate(updated.id, issued.token).launchProfiles[0].startupInput?.allOf).toEqual(['MODEL READY']);
  expect(() => store.update({ ...updated, groupId: 'another' })).toThrow(/group/);
  store.revoke(updated.id);
  expect(() => store.update(updated)).toThrow(/reactivated/);
});
it('adds a startup guard to a legacy exact restore without changing its stored launch configuration', async () => {
  const fake = adapter(), p = principal();
  const sessions = new IntegrationSessions(path.join(dir, 'legacy-restore.json'), fake.api); resources.push(() => sessions.close());
  const created = await sessions.create(p, { profile: 'agent', cwd: dir, idempotencyKey: 'legacy' });
  fake.set({ exists: true, running: true, agentSlug: 'fixture', nativeId: 'original-native' });
  await sessions.get(p, created.session_id);
  fake.set({ running: false, shell: true, nativeId: null });
  p.launchProfiles[0].argv = ['changed-model'];
  p.launchProfiles[0].startupInput = { allOf: ['ORIGINAL MODEL READY'] };
  await sessions.restore(p, created.session_id, 'safe-restore');
  const record = (fake.api.restore as ReturnType<typeof vi.fn>).mock.calls[0][0] as IntegrationSession;
  expect(record.profile.argv).toEqual(created.profile.argv);
  expect(record.profile.startupInput).toBeUndefined();
  expect(record.startup_condition?.allOf).toEqual(['ORIGINAL MODEL READY']);
  expect(record.startup_input?.state).toBe('pending');
  expect(record.session_id).toBe(created.session_id);
  expect(record.agent_native_session_id).toBe('original-native');
});
it.skipIf(process.platform !== 'linux')('recovers the live plugin UUID after store restart and keeps exact-running restore a no-op in real tmux', async () => {
  const exec = promisify(execFile), socket = `td-native-${process.pid}-${randomUUID().slice(0, 8)}`;
  const run = async (args: string[]) => (await exec('tmux', ['-L', socket, ...args], { timeout: 5000 })).stdout;
  const executable = path.join(dir, 'fixture-agent'), nativeId = '01a12546-8000-72c0-b47b-5fcc4a0bf2a9';
  // A native fixture blocks on a FIFO while retaining the declared resume
  // argv. It exercises process identity without any Agent hook or rich state.
  fs.copyFileSync('/bin/cat', executable); fs.chmodSync(executable, 0o700);
  execFileSync('mkfifo', [path.join(dir, 'resume')]);
  fs.writeFileSync(path.join(dir, nativeId), '');
  registerPluginAgents([{ manifest: { slug: 'fixture-agent', displayName: 'Fixture', aliases: ['fixture-agent'], resume: { command: 'fixture-agent resume {sessionId}' } }, iconPath: null } as LoadedPlugin]);
  const p = principal(); p.launchProfiles[0].agentSlug = 'fixture-agent';
  let pane: NonNullable<IntegrationSession['terminal_binding']>;
  const api: IntegrationSessionAdapter = {
    create: async (_record, prepared) => {
      await run(['new-session', '-d', '-s', 'native']);
      const identity = (await run(['display-message', '-p', '-t', 'native', '#{pid}:#{session_id}:#{pane_id}:#{pane_pid}'])).trim().split(':');
      pane = { serverPid: Number(identity[0]), sessionId: identity[1], paneId: identity[2], panePid: Number(identity[3]), agentSlug: 'fixture-agent', nativeSessionId: null };
      prepared(pane);
      await run(['send-keys', '-t', pane.paneId, '-l', `cd '${dir}' && '${executable}' resume ${nativeId}`]);
      await run(['send-keys', '-t', pane.paneId, 'Enter']);
      for (let i = 0; i < 50; i++) { if ((await api.inspect(_record)).nativeId === nativeId) break; await new Promise(resolve => setTimeout(resolve, 20)); }
    }, restore: vi.fn(async () => {}), subscribe: () => () => {},
    inspect: async () => {
      const tty = (await run(['display-message', '-p', '-t', pane.paneId, '#{pane_tty}'])).trim().replace(/^\/dev\//, '');
      const stdout = (await exec('ps', ['-t', tty, '-o', 'pid=,ppid=,pgid=,tpgid=,stat=,comm=,args='])).stdout;
      const rows = stdout.trim().split('\n').map(line => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(.+)$/)!;
        return { pid: +match[1], ppid: +match[2], pgid: +match[3], tpgid: +match[4], stat: match[5], comm: match[6], args: match[7] } as TmuxProcessRow;
      });
      const program = selectTmuxForegroundProgram({ panePid: pane.panePid, rows, shellNames: new Set(['sh', 'bash', 'zsh']), genericProgramNames: new Set(['python3']), extractProgramLabel: () => 'fixture-agent' });
      const agent = detectAgentFromCommand(program?.rawArgs ?? '');
      return { exists: true, running: !!agent, shell: false, agentSlug: agent?.slug ?? null, nativeId: agent && program?.rawArgs ? inferResumeSessionId(agent, program.rawArgs.split(/\s+/)) : null };
    },
  };
  const file = path.join(dir, 'live-plugin-sessions.json');
  let sessions = new IntegrationSessions(file, api); resources.push(() => sessions.close());
  try {
    const created = await sessions.create(p, { profile: 'agent', cwd: dir, idempotencyKey: 'live-plugin' });
    for (let i = 0; i < 50; i++) { if ((await run(['display-message', '-p', '-t', pane!.paneId, '#{pane_current_command}'])).trim() === 'fixture-agent') break; await new Promise(resolve => setTimeout(resolve, 20)); }
    expect((await run(['display-message', '-p', '-t', pane!.paneId, '#{pane_current_command}'])).trim()).toBe('fixture-agent');
    expect(created).toMatchObject({ state: 'ready', agent_native_session_id: nativeId });
    const cachedOwner = { backendSessionId: 'fixture-backend', cachedSlug: 'fixture-agent', cachedNativeId: nativeId };
    const verifyOwner = (excluded: string) => assertNativeResumeAvailable({ slug: 'fixture-agent', nativeSessionId: nativeId }, excluded,
      [cachedOwner], async () => { const live = await api.inspect(created); return [{ confirmed: true, agentSlug: live.agentSlug, nativeId: live.nativeId }]; });
    await expect(verifyOwner('another-backend')).rejects.toMatchObject({ code: 'NATIVE_SESSION_ALREADY_RUNNING' });
    const detached = collectNativeResumeOwnerCandidates([{ sessionId: 'detached-td', backendSessionId: 'previous-server-backend',
      mode: 'tmux', tmuxSessionName: 'native', agentResume: { slug: 'fixture-agent', sessionId: 'old-native-C' } }], new Map());
    await expect(assertNativeResumeAvailable({ slug: 'fixture-agent', nativeSessionId: nativeId }, 'another-backend', detached,
      async () => { const live = await api.inspect(created); return [{ confirmed: true, agentSlug: live.agentSlug, nativeId: live.nativeId }]; }))
      .rejects.toMatchObject({ code: 'NATIVE_SESSION_ALREADY_RUNNING' });
    await verifyOwner('fixture-backend');
    sessions.close(); sessions = new IntegrationSessions(file, api, 1);
    await new Promise(resolve => setTimeout(resolve, 5));
    const reread = await sessions.get(p, created.session_id);
    expect(reread).toMatchObject({ state: 'ready', error_code: null, agent_native_session_id: nativeId });
    const restored = await sessions.restore(p, created.session_id, 'already-live');
    expect(restored.operation_id).toBe(created.operation_id);
    expect(restored.terminal_binding).toEqual(reread.terminal_binding);
    expect(api.restore).not.toHaveBeenCalled();
    await run(['send-keys', '-t', pane!.paneId, 'C-c']);
    for (let i = 0; i < 50; i++) { if (!(await api.inspect(restored)).running) break; await new Promise(resolve => setTimeout(resolve, 20)); }
    // The same cached binding must no longer claim ownership after real exit.
    await verifyOwner('another-backend');
    await run(['send-keys', '-t', pane!.paneId, '-l', `'${executable}' resume another-native`]);
    await run(['send-keys', '-t', pane!.paneId, 'Enter']);
    for (let i = 0; i < 50; i++) { if ((await api.inspect(restored)).nativeId === 'another-native') break; await new Promise(resolve => setTimeout(resolve, 20)); }
    await verifyOwner('another-backend');
    expect(await sessions.get(p, created.session_id)).toMatchObject({ state: 'failed', error_code: 'NATIVE_SESSION_ID_MISMATCH' });
    await expect(sessions.restore(p, created.session_id, 'wrong-live-id')).rejects.toMatchObject({ code: 'SESSION_IDENTITY_MISMATCH' });
    expect(api.restore).not.toHaveBeenCalled();
  } finally { sessions.close(); clearPluginAgents(); await run(['kill-server']).catch(() => {}); }
}, 15000);

it.skipIf(process.platform === 'win32')('reproduces boot-time input loss in a real tmux pane and protects the first task write', async () => {
  const exec = promisify(execFile), socket = `td-startup-${process.pid}-${randomUUID().slice(0, 8)}`;
  const run = async (args: string[]) => (await exec('tmux', ['-L', socket, ...args], { timeout: 5000 })).stdout;
  const stdin = (args: string[], input: string) => new Promise<string>((resolve, reject) => {
    const child = execFile('tmux', ['-L', socket, ...args], { timeout: 5000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin!.end(input);
  });
  const script = path.join(dir, 'boot-consumer.py'), output = path.join(dir, 'received.bin');
  fs.writeFileSync(script, `import os,sys,time,termios,tty\ntty.setraw(0)\nos.write(1,b'model: loading\\r\\n> input initializing')\ntime.sleep(1.0)\ntermios.tcflush(0,termios.TCIFLUSH)\nos.write(1,b'\\x1b[2J\\x1b[Hmodel: FIXTURE READY\\r\\n> task input')\nwith open(sys.argv[1],'wb',buffering=0) as target:\n while True:\n  data=os.read(0,4096)\n  if not data: break\n  target.write(data)\n`);
  const fake = adapter(), p = principal();
  p.launchProfiles[0].startupInput = { allOf: ['model: FIXTURE READY', '> task input'], noneOf: ['model: loading'], stableMs: 500 };
  let pane: NonNullable<IntegrationSession['terminal_binding']>;
  fake.api.create = async (_record, prepared) => {
    await run(['new-session', '-d', '-s', 'boot', `python3 '${script}' '${output}'`]);
    const identity = (await run(['display-message', '-p', '-t', 'boot', '#{pid}:#{session_id}:#{pane_id}:#{pane_pid}'])).trim().split(':');
    pane = { serverPid: Number(identity[0]), sessionId: identity[1], paneId: identity[2], panePid: Number(identity[3]), agentSlug: 'fixture', nativeSessionId: null };
    prepared(pane); fake.set({ exists: true, running: true, shell: false, agentSlug: 'fixture', nativeId: null });
  };
  fake.api.capture = async () => captureTmuxPaneText(run, pane);
  const sessions = new IntegrationSessions(path.join(dir, 'real-boot.json'), fake.api); resources.push(() => sessions.close());
  try {
    const created = await sessions.create(p, { profile: 'agent', cwd: dir, idempotencyKey: 'real-boot' });
    for (let i = 0; i < 30; i++) { if ((await fake.api.capture(created)).includes('model: loading')) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    expect(await fake.api.capture(created)).toContain('model: loading');
    // Demonstrate the actual fault: a direct write before initialization is flushed.
    await writeCollaborationTmuxPane(run, pane!, 'UNGATED-BOOT-INPUT', stdin);
    const messages = new CollaborationStore(path.join(dir, 'real-boot-messages.json'));
    const group = messages.save({ name: 'Boot', sessionIds: ['sender', created.session_id] });
    const message = messages.send({ groupId: group.id, fromSessionId: 'sender', toSessionIds: [created.session_id], kind: 'message', content: 'FIRST-TASK-BODY' })[0];
    const write = vi.fn(async () => writeCollaborationTmuxPane(run, pane, 'FIRST-TASK-BODY', stdin));
    const delivery = new CollaborationDeliveryWorker({ store: messages, peers: () => [], isLocal: () => true, onError: () => {},
      resolve: async id => { const gate = await sessions.deliveryReadiness(id); return gate?.allowed ? { state: 'ready', write } : { state: 'recovering', reason: gate?.reason ?? 'missing' }; } });
    resources.push(() => delivery.stop());
    await delivery.run(created.session_id);
    expect(messages.receipt(message.id)).toMatchObject({ status: 'pending', attempt_count: 0 });
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(await sessions.deliveryReadiness(created.session_id)).toMatchObject({ allowed: false });
    await new Promise(resolve => setTimeout(resolve, 1100));
    await delivery.run(created.session_id);
    expect(messages.receipt(message.id)).toMatchObject({ status: 'delivered', attempt_count: 1 });
    await new Promise(resolve => setTimeout(resolve, 50));
    const bytes = fs.readFileSync(output, 'utf8');
    expect(bytes).toContain('FIRST-TASK-BODY'); expect(bytes).not.toContain('UNGATED-BOOT-INPUT');
    expect(write).toHaveBeenCalledTimes(1);
    expect((await sessions.get(p, created.session_id)).agent_native_session_id).toBeNull();
  } finally { await run(['kill-server']).catch(() => {}); }
}, 15000);

it('sends scoped principal messages, stores correlated results without a task and replays replies until durable ACK', async () => {
  const f = await runtimeFixture();
  const updated = policy(f.group.id); updated.permissions.push('message.send', 'message.read'); f.runtime.store.update(updated);
  const body = { targetSessionId: 'worker', message: 'Execute once', idempotency_key: 'run', origin: { source: 'bridge', externalActor: { id: 'human' } } };
  const subscription = f.stream();
  const sent = await f.request('POST', '/send', body);
  expect(sent).toMatchObject({ status: 200, body: { status: 'pending', attempt_count: 0 } });
  const original = f.messages.getMessage(sent.body.message_id)!;
  expect(original).toMatchObject({ fromSessionId: null, toSessionId: 'worker', integrationOrigin: { integrationId: 'bridge', source: 'bridge' } });
  expect((await f.request('POST', '/send', body)).body.message_id).toBe(original.id);
  expect(await f.request('POST', '/send', { ...body, message: 'Changed' })).toMatchObject({ status: 409, body: { code: 'IDEMPOTENCY_CONFLICT' } });
  const reply = f.messages.storeIntegrationReply(original.id, 'worker', 'Explicit result', { idempotencyKey: 'result', responseKind: 'result' });
  expect(f.messages.storeIntegrationReply(original.id, 'worker', 'Explicit result', { idempotencyKey: 'result', responseKind: 'result' }).id).toBe(reply.id);
  expect(f.messages.receipt(reply.id)).toMatchObject({ status: 'stored', queued_at: null, delivered_at: null, delivery_semantics: 'durable_storage', delivery: { stage: 'stored' }, attempt_count: 0 });
  expect(f.messages.receipt(original.id)).toMatchObject({ status: 'pending', result_ids: [reply.id] });
  expect(f.messages.pendingRecipients()).toEqual(['worker']);
  expect(f.taskStore.snapshot()).toEqual([]);
  let event: any;
  for (let i = 0; i < 20; i++) { event = await subscription.next(); if (event.kind === 'message.reply') break; }
  expect(event).toMatchObject({ kind: 'message.reply', payload: { message_id: reply.id, reply_to: original.id, to_session_id: null, to_principal_id: 'bridge', response_kind: 'result', content: 'Explicit result' } });
  expect((await f.request('GET', `/message/${reply.id.slice(0, 4)}`)).body.message.id).toBe(reply.id);
  const first = await f.request('GET', '/message?limit=1');
  expect(first.body).toMatchObject({ next_after_id: original.id, has_more: true });
  expect((await f.request('GET', `/message?after-id=${first.body.next_after_id}`)).body.messages.map((m: any) => m.id)).toEqual([reply.id]);
  subscription.req.destroy();
  const replay = f.stream(); let repeated: any;
  for (let i = 0; i < 20; i++) { repeated = await replay.next(); if (repeated.event_id === event.event_id) break; }
  expect(repeated).toEqual(event);
  expect(await f.request('POST', '/events/ack', { consumer: 'inbox', cursor: event.cursor })).toMatchObject({ status: 200 });
  expect(new CollaborationStore(path.join(dir, 'groups.json')).getMessage(reply.id)).toMatchObject({ status: 'stored', toPrincipalId: 'bridge', content: 'Explicit result' });
  const followup = await f.request('POST', '/reply', { messageId: reply.id, content: 'Explain', idempotency_key: 'followup' });
  expect(f.messages.getMessage(followup.body.message_id)).toMatchObject({ kind: 'reply', threadId: original.threadId, replyTo: reply.id, toSessionId: 'worker', integrationOrigin: { integrationId: 'bridge' } });
  expect(f.taskStore.snapshot()).toEqual([]);
});
it('fails closed on principal scope, operation grants, forged task envelopes and reply ownership', async () => {
  const f = await runtimeFixture();
  const body = { targetSessionId: 'worker', message: 'Execute', idempotency_key: 'run' };
  expect(await f.request('POST', '/send', body)).toMatchObject({ status: 403, body: { code: 'INTEGRATION_PERMISSION_DENIED' } });
  const updated = policy(f.group.id); updated.permissions = ['message.send', 'message.read', 'events.read']; f.runtime.store.update(updated);
  expect(await f.request('POST', '/send', { ...body, group_id: 'other' })).toMatchObject({ status: 403 });
  expect(await f.request('POST', '/send', { ...body, toSessionIds: ['worker', 'outsider'] })).toMatchObject({ status: 404 });
  expect(f.messages.snapshotMessages()).toEqual([]);
  expect(await f.request('POST', '/send', { ...body, metadata: { termdockTask: { taskId: 'fake' } } })).toMatchObject({ status: 403 });
  expect(await f.request('POST', '/send', { ...body, kind: 'task' })).toMatchObject({ status: 403 });
  expect(await f.request('POST', '/send', { ...body, idempotency_key: undefined })).toMatchObject({ status: 400, body: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
  const message = (await f.request('POST', '/send', body)).body.message_id;
  expect(() => f.messages.storeIntegrationReply(message, 'outsider', 'Forged', { idempotencyKey: 'fake' })).toThrow();
  const other = f.messages.save({ name: 'Other', sessionIds: ['outside'] });
  const foreign = f.messages.send({ groupId: other.id, fromSessionId: null, toSessionIds: ['outside'], kind: 'message', content: 'Private' })[0];
  expect(await f.request('GET', `/message/${foreign.id}`)).toMatchObject({ status: 404 });
  const human = f.messages.send({ groupId: f.group.id, fromSessionId: null, toSessionIds: ['worker'], kind: 'message', content: 'Human' })[0];
  expect(await f.request('POST', '/reply', { messageId: human.id, content: 'Forged', idempotency_key: 'fake' })).toMatchObject({ status: 409, body: { code: 'NO_REPLY_TARGET' } });
  expect((await f.request('GET', '/message')).body.messages).toHaveLength(2);
  expect(await f.request('GET', '/tasks')).toMatchObject({ status: 403 });
  expect(await f.request('GET', '/message?after-id=missing')).toMatchObject({ status: 404, body: { code: 'MESSAGE_NOT_FOUND' } });
  const second = f.runtime.store.provision({ ...updated, id: 'second' });
  const headers = { 'x-termdock-integration-protocol': '1', 'x-termdock-integration-id': 'second', authorization: `Bearer ${second.token}`, 'Content-Type': 'application/json' };
  expect(await f.request('POST', '/reply', { messageId: message, content: 'Wrong identity', idempotency_key: 'wrong' }, headers)).toMatchObject({ status: 409, body: { code: 'NO_REPLY_TARGET' } });
  const separate = await f.request('POST', '/send', { ...body, origin: { integrationId: 'bridge' } }, headers);
  expect(separate.body.message_id).not.toBe(message);
  expect(f.messages.getMessage(separate.body.message_id)?.integrationOrigin?.integrationId).toBe('second');
  const removed = { ...updated, permissions: ['message.read'] as IntegrationPolicy['permissions'] }; f.runtime.store.update(removed);
  expect(await f.request('POST', '/send', body)).toMatchObject({ status: 403 });
});

it('keeps principal CLI help offline and preflights old services before sending, then executes the documented send route', async () => {
  const oldFile = process.env.TERMDOCK_INTEGRATION_CREDENTIAL_FILE;
  resources.push(() => { if (oldFile === undefined) delete process.env.TERMDOCK_INTEGRATION_CREDENTIAL_FILE; else process.env.TERMDOCK_INTEGRATION_CREDENTIAL_FILE = oldFile; });
  delete process.env.TERMDOCK_INTEGRATION_CREDENTIAL_FILE;
  const output: string[] = [], io = { write: (line: string) => output.push(line), stdin: async () => 'stdin prompt' };
  expect(await runIntegrationCollab(parseCollaborationCommand(['--principal', 'bridge', 'send', '--help']), 59999, io)).toBe(0);
  expect(output.join('')).toContain('message.send'); expect(output.join('')).toContain('response-kind result');
  expect(output.join('')).toContain('integration_message_send/reply/history');
  const file = path.join(dir, 'cli-credential.json'); fs.writeFileSync(file, JSON.stringify({ id: 'bridge', token: 'private-test-token', protocol: 1 }), { mode: 0o600 });
  process.env.TERMDOCK_INTEGRATION_CREDENTIAL_FILE = file;
  let supported = false; const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url!); expect(req.headers.authorization).toBe('Bearer private-test-token');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/capabilities') { res.end(JSON.stringify({ integration_protocol: 1, integration_message_send: supported })); return; }
    let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
      expect(JSON.parse(raw)).toMatchObject({ targetSessionId: 'worker', message: 'Run', idempotency_key: 'run', origin: { source: 'test' } });
      res.end(JSON.stringify({ ok: true, status: 'pending', message_id: 'original', thread_id: 'thread' }));
    });
  });
  const port = 60000 + Math.floor(Math.random() * 5000), socket = (await import('./integrationServer.js')).integrationSocketPath(port);
  await new Promise<void>(resolve => server.listen(socket, resolve)); resources.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const command = parseCollaborationCommand(['--principal', 'bridge', 'send', 'worker', 'Run', '--idempotency-key', 'run', '--source', 'test']);
  output.length = 0;
  expect(await runIntegrationCollab(command, port, io)).toBe(1);
  expect(JSON.parse(output.pop()!)).toMatchObject({ code: 'INTEGRATION_MESSAGING_UNSUPPORTED' });
  expect(requests).toEqual(['/capabilities']);
  supported = true;
  expect(await runIntegrationCollab(command, port, io)).toBe(0);
  expect(requests).toEqual(['/capabilities', '/capabilities', '/send']);
  expect(output.join('')).not.toContain('private-test-token');
});

it('recovers integration replies committed while the event runtime is offline without generating duplicate tasks or events', async () => {
  const f = await runtimeFixture(); const p = policy(f.group.id); p.permissions.push('message.send', 'message.read'); f.runtime.store.update(p);
  const original = (await f.request('POST', '/send', { targetSessionId: 'worker', message: 'Run', idempotency_key: 'run' })).body.message_id;
  await f.runtime.close();
  const reply = f.messages.storeIntegrationReply(original, 'worker', 'Offline result', { responseKind: 'result', idempotencyKey: 'offline' });
  const source = new CollaborationStore(path.join(dir, 'groups.json'));
  let restarted = new IntegrationRuntime({ ...f.options, messages: source }); await restarted.listen(); resources.push(() => restarted.close());
  const p2 = restarted.store.authenticate('bridge', f.issued.token);
  const event = restarted.store.page(p2, 'replay').events.find(e => e.kind === 'message.reply')!;
  expect(event.payload).toMatchObject({ message_id: reply.id, reply_to: original });
  await restarted.close(); restarted = new IntegrationRuntime({ ...f.options, messages: source }); await restarted.listen();
  const recovered = restarted.store.page(p2, 'replay').events.filter(e => e.kind === 'message.reply');
  expect(recovered).toHaveLength(1); expect(recovered[0].event_id).toBe(event.event_id);
  expect(f.taskStore.snapshot()).toEqual([]);
});
