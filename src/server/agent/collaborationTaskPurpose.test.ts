// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollaborationTaskStore } from './collaborationTaskStore.js';
import { CollaborationTaskService } from './collaborationTaskService.js';
import { CollaborationStore } from './collaborationStore.js';
import { collaborationTaskRoutes } from './collaborationTaskRoutes.js';
import { taskExecution } from './collaborationTaskPurpose.js';
import { executeTaskCommand } from './collaborationTaskCli.js';
import { parseCollaborationCommand } from './collaborationCli.js';
import { collaborationTaskNeedsAttention, collaborationTaskStage } from '../../lib/collaboration/taskState';
import { collaborationBoardTasks } from '../../lib/collaboration/boardTasks';
import type { CollaborationService } from './collaborationService.js';
import type { CollaborationTask, TaskCreateInput, TaskOperation } from './collaborationTaskTypes.js';

let directory: string, file: string, store: CollaborationTaskStore;
const owner = `12D3KooW${'a'.repeat(40)}`, worker = { serviceId: owner, sessionId: 'worker' };
beforeEach(() => { directory = fs.mkdtempSync(path.join(tmpdir(), 'td-purpose-')); file = path.join(directory, 'tasks.json'); store = new CollaborationTaskStore(file); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); });
const create = (input: Partial<TaskCreateInput> = {}) => store.create(owner, { idempotencyKey: randomUUID(), groupId: 'group', title: 'Background report', spec: 'Gather evidence', assignee: worker, ...input }, null);
const apply = (task: CollaborationTask, input: Partial<TaskOperation> & { kind: TaskOperation['kind'] }, actor: typeof worker | null = null) => store.apply(task.id,
  { expectedRevision: store.get(task.id)!.revision, idempotencyKey: randomUUID(), ...input }, actor);
function service(groupId?: string) {
  const messages = new CollaborationStore(path.join(directory, 'messages.json'));
  const group = messages.save({ id: groupId, name: 'Fixture', sessionIds: ['worker'] });
  const peers = { descriptor: () => ({ serviceId: owner }), taskMember: () => worker, taskSession: () => worker.sessionId } as unknown as CollaborationService;
  return { service: new CollaborationTaskService(store, messages, peers, vi.fn()), group, messages, peers };
}

it('migrates existing completed records atomically without acceptance, new attempts, delivery or loss of evidence', () => {
  let task = create();
  task = apply(task, { kind: 'report', attemptId: task.activeAttemptId!, status: 'complete', content: 'Completed evidence', evidence: { links: ['original'] } }, worker);
  const original = structuredClone(task), outbox = store.pending(task.id);
  const input: TaskOperation = { kind: 'configure', purpose: 'automation', expectedRevision: task.revision, idempotencyKey: 'migrate' };
  const configured = store.apply(task.id, input, null, { integrationId: 'bridge', source: 'integration' });
  expect(configured).toMatchObject({ id: original.id, activeAttemptId: original.activeAttemptId, attempts: original.attempts, artifacts: original.artifacts,
    status: 'open', purpose: 'automation', revision: original.revision + 1 });
  expect(configured.acceptedArtifactId).toBeUndefined();
  expect(configured.events.slice(0, -1)).toEqual(original.events);
  expect(configured.events.at(-1)).toMatchObject({ kind: 'configured', purpose: 'automation', source: 'integration' });
  expect(store.pending(task.id)).toEqual(outbox);
  expect(store.apply(task.id, input, null, { integrationId: 'bridge', source: 'integration' })).toEqual(configured);
  expect(() => apply(configured, { ...input, idempotencyKey: 'stale' })).toThrow(/已更新/);
  expect(() => apply(configured, { kind: 'configure', purpose: 'interactive' }, worker)).toThrow(/授权/);
  store = new CollaborationTaskStore(file);
  expect(store.get(task.id)).toEqual(configured);
  expect(taskExecution(store.get(task.id)!)).toMatchObject({ status: 'complete', artifactId: original.artifacts[0].id });
});
it('retains accepted and closed historical boundaries when only purpose changes', () => {
  let task = create(); task = apply(task, { kind: 'report', attemptId: task.activeAttemptId!, status: 'complete', content: 'Original' }, worker);
  task = apply(task, { kind: 'accept', artifactId: task.artifacts[0].id });
  const accepted = apply(task, { kind: 'configure', purpose: 'automation' });
  expect(accepted.status).toBe('accepted'); expect(accepted.acceptedArtifactId).toBe(task.acceptedArtifactId);
  const closed = apply(create(), { kind: 'close' });
  const configured = apply(closed, { kind: 'configure', purpose: 'interactive' });
  expect(configured.status).toBe('closed'); expect(configured.artifacts).toEqual(closed.artifacts);
});
it('keeps consultation completed, invalidates only explicit revisions, and ignores historical-attempt reports', () => {
  vi.useFakeTimers(); vi.setSystemTime(100000);
  let task = create({ purpose: 'automation' }), attemptId = task.activeAttemptId!;
  expect(taskExecution(task)).toMatchObject({ status: 'awaiting_report', artifactId: null });
  for (const pending of store.pending(task.id)) store.delivered(pending.id, { messageId: 'delivered', status: 'delivered', deliveredAt: Date.now(), error: null });
  expect(taskExecution(store.get(task.id)!)).toMatchObject({ status: 'awaiting_report' });
  task = apply(task, { kind: 'report', attemptId, status: 'complete', content: 'Result 1' }, worker);
  const execution = taskExecution(task);
  task = apply(task, { kind: 'comment', content: 'Pure question' });
  const comment = task.events.at(-1)!;
  task = apply(task, { kind: 'respond', attemptId, replyToEventId: comment.id, content: 'Associated response' }, worker);
  expect(taskExecution(task)).toEqual(execution); expect(task.artifacts).toHaveLength(1); expect(task.attempts).toHaveLength(1);
  task = apply(task, { kind: 'revise', content: 'New requirement' });
  expect(taskExecution(task)).toMatchObject({ status: 'awaiting_report', artifactId: null });
  task = apply(task, { kind: 'report', attemptId, status: 'complete', content: 'Result 2' }, worker);
  expect(taskExecution(task)).toMatchObject({ status: 'complete', artifactId: task.artifacts[1].id });
  task = apply(task, { kind: 'assign', assignee: worker });
  expect(taskExecution(task).status).toBe('awaiting_report');
  task = apply(task, { kind: 'report', attemptId, status: 'failed', content: 'Historical failure' }, worker);
  expect(taskExecution(task).status).toBe('awaiting_report');
});
it('keeps legacy tasks visible, exposes background facts in full and summary views, and excludes all background exceptions from user attention', async () => {
  const f = service();
  const interactive = create({ groupId: f.group.id });
  // Old persisted records have no purpose and stay interactive.
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')); delete doc.tasks[0].purpose; fs.writeFileSync(file, JSON.stringify(doc)); store = new CollaborationTaskStore(file);
  const tasks = new CollaborationTaskService(store, f.messages, f.peers, vi.fn());
  const background = create({ groupId: f.group.id, purpose: 'automation' });
  apply(background, { kind: 'report', attemptId: background.activeAttemptId!, status: 'failed', content: 'Expected failure probe' }, worker);
  const full = await tasks.get(background.id, null), summary = tasks.list(f.group.id, null, 'automation')[0];
  expect(summary.execution).toEqual(full.execution); expect(summary.execution?.status).toBe('failed');
  expect(summary.attempts[0].report?.content).toBe(''); expect(full.attempts[0].report?.content).toBe('Expected failure probe');
  expect(tasks.list(f.group.id, null, 'interactive').map(t => t.id)).toEqual([interactive.id]);
  expect(tasks.list(f.group.id, null)).toHaveLength(2);
  for (const status of ['complete', 'blocked', 'failed'] as const) {
    const view = { ...full, execution: { ...full.execution!, status } };
    expect(collaborationTaskNeedsAttention(view)).toBe(false);
    expect(collaborationBoardTasks([view], true, view.title)).toEqual([]);
  }
  expect(collaborationTaskStage({ ...full, execution: { ...full.execution!, status: 'complete' } })).toBe('执行已交付');
});
it('enforces standalone records and cannot hide a parent or dependency graph through configuration', () => {
  expect(() => create({ purpose: 'invalid' as never })).toThrow(/purpose/);
  expect(() => create({ purpose: 'automation', managed: true })).toThrow(/后台/);
  const background = create({ purpose: 'automation' });
  expect(() => create({ parentTaskId: background.id })).toThrow(/后台/);
  expect(() => create({ dependsOn: [background.id] })).toThrow(/后台/);
  const parent = create(); create({ parentTaskId: parent.id });
  expect(() => apply(parent, { kind: 'configure', purpose: 'automation' })).toThrow(/独立/);
  expect(() => apply(background, { kind: 'configure' })).toThrow(/purpose/);
  expect(() => apply(background, { kind: 'comment', content: 'Question', purpose: 'interactive' })).toThrow(/configure/);
});
it('filters background records at the real human API while agent list and direct get retain them', async () => {
  const f = service(); const background = create({ groupId: f.group.id, purpose: 'automation' }), interactive = create({ groupId: f.group.id });
  const app = express(); app.locals.collaborationTasks = f.service; app.locals.collaborationService = f.peers;
  app.use('/human', collaborationTaskRoutes({ agent: false, store: f.messages, resolveSession: () => 'worker' }));
  app.use('/agent', collaborationTaskRoutes({ agent: true, store: f.messages, resolveSession: () => 'worker' }));
  const server = await new Promise<import('node:http').Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  try {
    const human = await (await fetch(`${url}/human`)).json();
    expect(human.tasks?.map((t: CollaborationTask) => t.id)).toEqual([interactive.id]);
    expect((await (await fetch(`${url}/agent`)).json()).tasks).toHaveLength(2);
    expect((await (await fetch(`${url}/human/${background.id}`)).json()).task.id).toBe(background.id);
    expect((await (await fetch(`${url}/human?purpose=automation`)).json()).tasks[0].id).toBe(background.id);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
it('refuses unsupported services before mutating and sends exact revision/purpose on the supported CLI', async () => {
  const command = parseCollaborationCommand(['--principal', 'bridge', 'task', 'configure', 'original', '--purpose', 'automation', '--revision', '8', '--idempotency-key', 'migrate']);
  const io = { write: () => {}, request: async () => ({ statusCode: 200, body: '{}' }) };
  const old = vi.fn(async () => ({}));
  await expect(executeTaskCommand(command, old, io)).rejects.toMatchObject({ code: 'BACKGROUND_TASK_RECORDS_UNSUPPORTED' });
  expect(old.mock.calls).toHaveLength(1);
  const request = vi.fn(async () => ({ background_task_records: true, task_purpose_configuration: true, explicit_execution_state: true }));
  await executeTaskCommand(command, request, io);
  expect(request).toHaveBeenLastCalledWith('POST', '/tasks/original', { input: expect.objectContaining({ purpose: 'automation', kind: 'configure', expectedRevision: 8, idempotencyKey: 'migrate' }) });
});
