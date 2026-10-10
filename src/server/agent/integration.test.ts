// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IntegrationStore, validatePolicy, type IntegrationPolicy, type IntegrationPrincipal } from './integrationStore.js';
import { IntegrationSessions, permittedCwd, integrationLaunchCommand, type IntegrationSessionAdapter, type IntegrationSession } from './integrationSessions.js';
import { IntegrationRuntime } from './integrationServer.js';
import { readIntegrationCredential } from './integrationCli.js';
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

async function runtimeFixture() {
  const messages = new CollaborationStore(path.join(dir, 'groups.json')), group = messages.save({ name: 'Local fixture', sessionIds: ['worker'] });
  const taskStore = new CollaborationTaskStore(path.join(dir, 'tasks.json'));
  const peers = { descriptor: () => ({ serviceId }), taskMember: (sessionId: string) => ({ serviceId, sessionId }), taskSession: (m: typeof worker) => m.sessionId } as unknown as CollaborationService;
  const tasks = new CollaborationTaskService(taskStore, messages, peers, () => {});
  const options = { directory: dir, socketPath: path.join(dir, 'api.sock'), adminToken: 'local-admin', messages, taskStore, tasks, peers, sessions: adapter().api };
  const runtime = new IntegrationRuntime(options); await runtime.listen(); resources.push(() => runtime.close());
  const issued = runtime.store.provision(policy(group.id));
  const headers = { 'x-termdock-integration-protocol': '1', 'x-termdock-integration-id': 'bridge', authorization: `Bearer ${issued.token}`, 'Content-Type': 'application/json' };
  const request = (method: string, route: string, body?: unknown, requestHeaders = headers) => new Promise<{ status: number; body: any }>((resolve, reject) => {
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
