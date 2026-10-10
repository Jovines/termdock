import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollaborationTaskStore } from './collaborationTaskStore.js';
import { CollaborationTaskService } from './collaborationTaskService.js';
import { CollaborationStore } from './collaborationStore.js';
import type { CollaborationService } from './collaborationService.js';
import type { TaskMember, TaskOperation } from './collaborationTaskTypes.js';

const owner = `12D3KooW${'a'.repeat(40)}`;
const lead = { serviceId: owner, sessionId: 'lead' }, worker = { serviceId: owner, sessionId: 'worker' };
let dir: string, store: CollaborationTaskStore;
const apply = (id: string, operation: Omit<TaskOperation, 'idempotencyKey'>, actor: TaskMember | null = null) =>
  store.apply(id, { ...operation, idempotencyKey: randomUUID() }, actor);

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'termdock-paused-decisions-')); store = new CollaborationTaskStore(join(dir, 'tasks.json')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

it.each(['root', 'step'] as const)('persists answers and approved plans but gates the real flush while the %s is paused', async pauseAt => {
  const messages = new CollaborationStore(join(dir, 'messages.json'));
  const group = messages.save({ name: 'isolated pause fixture', sessionIds: ['lead', 'worker'] });
  const root = store.create(owner, { groupId: group.id, idempotencyKey: randomUUID(), title: '目标', spec: '只读验证', managed: true, isolated: false, coordinator: lead, reviewers: [worker] }, null);
  const parent = store.create(owner, { groupId: group.id, idempotencyKey: randomUUID(), title: '父步骤', spec: '只读验证', parentTaskId: root.id, assignee: worker, workType: 'read-only' }, lead);
  store.activateScheduled(parent.id, parent.revision, worker);
  const child = store.create(owner, { groupId: group.id, idempotencyKey: randomUUID(), title: '子步骤', spec: '保留原始决定', parentTaskId: parent.id, assignee: worker, workType: 'read-only' }, lead);
  store.activateScheduled(child.id, child.revision, worker);
  const pausedId = pauseAt === 'root' ? root.id : child.id;
  apply(pausedId, { kind: 'pause', expectedRevision: store.get(pausedId)!.revision });
  apply(child.id, { kind: 'ask', attemptId: store.get(child.id)!.activeAttemptId!, content: '采用哪种布局？', options: ['保留终端'] }, worker);
  apply(child.id, { kind: 'submit-plan', attemptId: store.get(child.id)!.activeAttemptId!, content: '先保留终端，再验证布局。' }, worker);
  const question = store.get(child.id)!.decisions[0], plan = store.get(child.id)!.artifacts[0];
  apply(child.id, { kind: 'answer', decisionId: question.id, content: '保留终端' });
  apply(child.id, { kind: 'approve-plan', artifactId: plan.id, expectedRevision: store.get(child.id)!.revision });
  const before = store.get(child.id)!;
  expect(before.decisions[0]).toMatchObject({ status: 'answered', answer: '保留终端' });
  expect(before.approvedPlanArtifactId).toBe(plan.id);
  expect(store.get(pausedId)!.workflow?.paused).toBe(true);
  const queuedDecisions = store.pending(child.id).filter(outbox => outbox.kind === 'message');
  expect(queuedDecisions).toHaveLength(2);
  expect(queuedDecisions.map(outbox => outbox.content).join('\n')).toContain('用户回答：保留终端');
  expect(queuedDecisions.map(outbox => outbox.content).join('\n')).toContain('已由用户确认');
  const history = before.events;
  // Reload the real persistent Store before exercising the actual service flush.
  store = new CollaborationTaskStore(join(dir, 'tasks.json'));
  expect(store.get(child.id)!.events).toEqual(history);
  expect(store.get(pausedId)!.workflow?.paused).toBe(true);
  const pending = store.pending(child.id);
  const send = vi.spyOn(messages, 'send'), deliver = vi.fn(), prepare = vi.fn(), requestTasks = vi.fn();
  const peers = { descriptor: () => ({ serviceId: owner }), taskSession: (member: TaskMember) => member.sessionId, requestTasks } as unknown as CollaborationService;
  const service = new CollaborationTaskService(store, messages, peers, deliver, prepare);
  // No timer, supervisor, process preparation, network peer, or terminal writer is started.
  const flush = () => (service as unknown as { flush(): Promise<void> }).flush();
  await flush(); await flush();
  expect(store.pending(child.id)).toEqual(pending);
  expect(store.get(child.id)!.events).toEqual(history);
  expect(store.get(pausedId)!.workflow?.paused).toBe(true);
  const blockedContents = new Set(pending.map(outbox => outbox.content));
  expect(send.mock.calls.every(([input]) => !blockedContents.has(input.content))).toBe(true);
  if (pauseAt === 'root') { expect(send).not.toHaveBeenCalled(); expect(deliver).not.toHaveBeenCalled(); }
  expect(prepare).not.toHaveBeenCalled(); expect(requestTasks).not.toHaveBeenCalled();
  const callCount = send.mock.calls.length;
  apply(pausedId, { kind: 'resume', expectedRevision: store.get(pausedId)!.revision });
  await flush();
  const newlyQueued = send.mock.results.slice(callCount).flatMap(result => result.value);
  for (const outbox of queuedDecisions) {
    const message = newlyQueued.find(message => message.content === outbox.content);
    expect(message).toBeDefined();
    // A local queue entry is the only observed result: no terminal delivery is simulated.
    expect(messages.receipt(message.id)).toMatchObject({ status: 'pending', delivered_at: null, delivery: { stage: 'queued' } });
    expect(store.get(child.id)!.deliveries.find(receipt => receipt.id === outbox.id)).toMatchObject({ status: 'pending', deliveredAt: null });
  }
  expect(store.get(child.id)!.decisions[0]).toEqual(before.decisions[0]);
  expect(store.get(child.id)!.approvedPlanArtifactId).toBe(plan.id);
  expect(store.get(pausedId)!.workflow?.paused).toBe(false);
  expect(prepare).not.toHaveBeenCalled(); expect(requestTasks).not.toHaveBeenCalled();
});
