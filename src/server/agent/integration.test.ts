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
import { IntegrationSessions, permittedCwd, integrationLaunchCommand, type IntegrationSessionAdapter, type IntegrationSession } from './integrationSessions.js';
import { IntegrationRuntime } from './integrationServer.js';
import { assertNativeResumeAvailable, collectNativeResumeOwnerCandidates } from './nativeResumeOwner.js';
import { readIntegrationCredential, runIntegrationAdmin } from './integrationCli.js';
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
