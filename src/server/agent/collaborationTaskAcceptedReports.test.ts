import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollaborationTaskStore } from './collaborationTaskStore.js';
import { CollaborationTaskService } from './collaborationTaskService.js';
import { CollaborationStore } from './collaborationStore.js';
import { parseCollaborationCommand } from './collaborationCli.js';
import { executeTaskCommand } from './collaborationTaskCli.js';
import type { CollaborationService } from './collaborationService.js';
import type { TaskMember, TaskOperation } from './collaborationTaskTypes.js';

const owner = `12D3KooW${'a'.repeat(40)}`;
const lead = { serviceId: owner, sessionId: 'lead' };
const first = { serviceId: owner, sessionId: 'first' };
const current = { serviceId: owner, sessionId: 'current' };
let directory: string, store: CollaborationTaskStore;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'td-accepted-report-'));
  store = new CollaborationTaskStore(join(directory, 'tasks.json'));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const apply = (id: string, input: Omit<TaskOperation, 'idempotencyKey'>, actor: TaskMember | null) =>
  store.apply(id, { ...input, idempotencyKey: randomUUID() }, actor);

it.each(['store', 'service-cli'] as const)('keeps accepted current results when a historical attempt completes through %s', async entry => {
  const messages = new CollaborationStore(join(directory, 'groups.json'));
  const group = messages.save({ name: 'data fixture', sessionIds: [lead.sessionId, first.sessionId, current.sessionId] });
  const peers = {
    descriptor: () => ({ serviceId: owner }),
    taskSession: (actor: TaskMember) => actor.sessionId,
    taskMember: (sessionId: string) => ({ serviceId: owner, sessionId }),
  } as unknown as CollaborationService;
  const deliver = vi.fn(), prepare = vi.fn();
  const service = new CollaborationTaskService(store, messages, peers, deliver, prepare);
  const report = async (taskId: string, attemptId: string, actor: TaskMember, content: string) => {
    if (entry === 'store') return apply(taskId, { kind: 'report', attemptId, status: 'complete', content }, actor);
    await executeTaskCommand(parseCollaborationCommand(['task', 'report', taskId, '--attempt', attemptId, '--status', 'complete', '--content', content]),
      async (_method, _path, body) => ({ task: await service.apply(taskId, (body as { input: TaskOperation }).input, actor) }),
      { request: vi.fn(), write: vi.fn() });
    return store.get(taskId)!;
  };
  const task = store.create(owner, { idempotencyKey: randomUUID(), groupId: group.id, title: 'ordinary task', spec: 'data only', assignee: first, coordinator: lead }, null);
  expect(task.workflow).toBeUndefined();
  const firstAttempt = task.activeAttemptId!;
  const reassigned = apply(task.id, { kind: 'assign', assignee: current, expectedRevision: task.revision }, lead);
  const currentAttempt = reassigned.activeAttemptId!;
  const completed = await report(task.id, currentAttempt, current, 'current result');
  const result = completed.artifacts.at(-1)!;
  const accepted = apply(task.id, { kind: 'accept', artifactId: result.id, expectedRevision: completed.revision }, null);
  expect(accepted.status).toBe('accepted');

  const historical = await report(task.id, firstAttempt, first, 'late historical result');
  expect(historical.status).toBe('accepted');
  expect(historical.acceptedArtifactId).toBe(result.id);
  expect(historical.completionMode).toBe(accepted.completionMode);
  expect(historical.activeAttemptId).toBe(currentAttempt);
  expect(historical.artifacts.find(artifact => artifact.id === result.id)).toEqual(result);
  expect(historical.attempts.find(attempt => attempt.id === currentAttempt)?.report).toEqual(accepted.attempts.find(attempt => attempt.id === currentAttempt)?.report);
  expect(historical.attempts.find(attempt => attempt.id === firstAttempt)?.report).toMatchObject({ status: 'complete', content: 'late historical result' });
  expect(historical.events.at(-1)).toMatchObject({ kind: 'report', attemptId: firstAttempt, reportStatus: 'complete' });
  expect(historical.artifacts.at(-1)).toMatchObject({ kind: 'result', attemptId: firstAttempt, content: 'late historical result' });
  expect(historical.artifacts).toHaveLength(accepted.artifacts.length + 1);
  expect(store.pending(task.id).some(item => item.content.includes('历史分派') && item.content.includes('late historical result'))).toBe(true);
  // The preserved acceptance also survives loading the persisted store again.
  const reloaded = new CollaborationTaskStore(join(directory, 'tasks.json'));
  expect(reloaded.get(task.id)).toMatchObject({ status: 'accepted', acceptedArtifactId: result.id, activeAttemptId: currentAttempt });

  const replacement = await report(task.id, currentAttempt, current, 'new current result');
  expect(replacement.status).toBe('open');
  expect(replacement.acceptedArtifactId).toBeUndefined();
  expect(replacement.completionMode).toBeUndefined();
  expect(replacement.activeAttemptId).toBe(currentAttempt);
  expect(replacement.artifacts.at(-1)).toMatchObject({ kind: 'result', attemptId: currentAttempt, content: 'new current result' });
  expect(replacement.artifacts.at(-1)?.id).not.toBe(result.id);
  expect(replacement.artifacts.find(artifact => artifact.id === result.id)).toEqual(result);
  if (entry === 'store') expect(deliver).not.toHaveBeenCalled();
  else expect(deliver).toHaveBeenCalledWith(lead.sessionId);
  expect(prepare).not.toHaveBeenCalled();
});

it('still rejects superseded workflow reports before recording a result', () => {
  const root = store.create(owner, { idempotencyKey: randomUUID(), groupId: 'fixture', title: 'managed goal', spec: 'data only', managed: true, isolated: false, coordinator: lead, reviewers: [first, current] }, null);
  const child = store.create(owner, { idempotencyKey: randomUUID(), groupId: root.groupId, parentTaskId: root.id, title: 'step', spec: 'data only', assignee: first, workType: 'read-only' }, lead);
  store.activateScheduled(child.id, child.revision, first);
  const active = store.get(child.id)!;
  const firstAttempt = active.activeAttemptId!;
  const reassigned = apply(child.id, { kind: 'assign', assignee: current, expectedRevision: active.revision }, lead);
  expect(reassigned.activeAttemptId).not.toBe(firstAttempt);
  expect(() => apply(child.id, { kind: 'report', attemptId: firstAttempt, status: 'complete', content: 'superseded result' }, first))
    .toThrow(expect.objectContaining({ code: 'ATTEMPT_SUPERSEDED' }));
  expect(store.get(child.id)).toEqual(reassigned);
});
