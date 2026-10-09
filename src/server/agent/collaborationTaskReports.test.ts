import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollaborationTaskStore } from './collaborationTaskStore.js';
import { CollaborationTaskService } from './collaborationTaskService.js';
import { CollaborationStore } from './collaborationStore.js';
import type { CollaborationService } from './collaborationService.js';
import type { CollaborationTaskView } from './collaborationTaskTypes.js';
import { collaborationTaskBlockers } from '../../lib/collaboration/taskState';
import { taskReportPresentation } from '../../lib/collaboration/taskReportPresentation';
let directory: string, store: CollaborationTaskStore;
const owner = `12D3KooW${'a'.repeat(40)}`;
const member = { serviceId: owner, sessionId: 'fixture-member' };
const reportedAt = Date.parse('2026-10-09T14:30:00Z');
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(reportedAt); directory = mkdtempSync(join(tmpdir(), 'td-report-fixture-')); store = new CollaborationTaskStore(join(directory, 'tasks.json')); });
afterEach(() => { vi.useRealTimers(); rmSync(directory, { recursive: true, force: true }); });
function blocked(content = '# 原报告\n\n缺少授权条件。\n\n详细记录。', groupId = 'fixture') {
  const task = store.create(owner, { idempotencyKey: randomUUID(), groupId, title: '纯数据任务', spec: '无终端/投递器', managed: true, isolated: false, coordinator: member, reviewers: [{ ...member, sessionId: 'fixture-reviewer' }] }, null);
  for (const outbox of store.pending(task.id)) store.delivered(outbox.id, { messageId: 'fixture-receipt', status: 'delivered', deliveredAt: reportedAt - 1000, error: null });
  return store.apply(task.id, { kind: 'report', attemptId: task.activeAttemptId!, status: 'blocked', content, idempotencyKey: randomUUID() }, member);
}
function views(id: string) {
  const full = { ...store.get(id)!, memberSessions: {}, outbox: store.pending(id) } as CollaborationTaskView;
  const summary = { ...store.list(['fixture'], true).find(task => task.id === id)!, summaryOnly: true, memberSessions: {}, outbox: [] } as CollaborationTaskView;
  return { full, summary };
}
it('preserves a bounded original summary and exact report time without writing response metadata to history', () => {
  const content = `# 原报告\n\n${'缺少明确条件。'.repeat(180)}\n\n详细日志。`;
  const task = blocked(content); const { full, summary } = views(task.id);
  expect(summary.attempts[0].report).toMatchObject({ status: 'blocked', content: '', createdAt: reportedAt });
  expect(summary.attempts[0].report?.summary).toHaveLength(512);
  expect(summary.automationIssueSource).toBe('member-report');
  expect(collaborationTaskBlockers(summary)).toHaveLength(1);
  expect(collaborationTaskBlockers(summary)[0].summary).toBe(collaborationTaskBlockers(full)[0].summary);
  expect(store.get(task.id)?.attempts[0].report?.content).toBe(content);
  const persisted = readFileSync(join(directory, 'tasks.json'), 'utf8');
  expect(persisted).not.toContain('automationIssueSource');
  expect(store.get(task.id)?.attempts[0].report?.summary).toBeUndefined();
});
it('retains report source and summary through the real service list response without starting automation', () => {
  const messages = new CollaborationStore(join(directory, 'groups.json'));
  const group = messages.save({ name: '纯数据空组', sessionIds: [] });
  const task = blocked('# 原报告\n\n缺少授权条件。', group.id);
  const peers = { descriptor: () => ({ serviceId: owner }), taskSession: (actor: typeof member) => actor.sessionId } as unknown as CollaborationService;
  const deliver = vi.fn(), prepare = vi.fn();
  const service = new CollaborationTaskService(store, messages, peers, deliver, prepare);
  const summary = service.list(group.id, null)[0];
  expect(summary).toMatchObject({ id: task.id, summaryOnly: true, automationIssueSource: 'member-report' });
  expect(summary.attempts[0].report).toMatchObject({ content: '', summary: '缺少授权条件。', createdAt: reportedAt });
  expect(collaborationTaskBlockers(summary)).toHaveLength(1);
  store.automationFailed(task.id, '消息投递失败：成员连接未恢复');
  const dual = service.list(group.id, null)[0];
  expect(dual.automationIssueSource).toBe('system');
  expect(collaborationTaskBlockers(dual).map(blocker => blocker.source)).toEqual(['member', 'system']);
  expect(deliver).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
});
it('preserves member prerequisites and a distinct system delivery issue in full and summary views', () => {
  const task = blocked(); store.automationFailed(task.id, '消息投递失败：成员连接未恢复');
  const { full, summary } = views(task.id);
  expect(summary.automationIssueSource).toBe('system');
  expect(collaborationTaskBlockers(full).map(blocker => [blocker.source, blocker.summary])).toEqual(collaborationTaskBlockers(summary).map(blocker => [blocker.source, blocker.summary]));
  expect(collaborationTaskBlockers(summary).map(blocker => blocker.source)).toEqual(['member', 'system']);
});
it('keeps original report and attempt after retry or comment updates; a newer working report alone replaces current metadata', () => {
  const task = blocked(); const attemptId = task.activeAttemptId!;
  vi.setSystemTime(reportedAt + 7 * 60000);
  store.apply(task.id, { kind: 'retry', expectedRevision: store.get(task.id)!.revision, idempotencyKey: randomUUID() }, null);
  const afterRetry = views(task.id);
  expect(afterRetry.full.events.at(-1)).toMatchObject({ kind: 'retry', content: '请求重新检查现有投递与协调条件，成员原报告保留' });
  expect(taskReportPresentation(afterRetry.summary)).toMatchObject({ status: 'blocked', createdAt: reportedAt, summary: '缺少授权条件。' });
  expect(afterRetry.full.activeAttemptId).toBe(attemptId); expect(afterRetry.full.attempts).toHaveLength(1); expect(afterRetry.full.outbox).toHaveLength(0);
  store.apply(task.id, { kind: 'comment', expectedRevision: store.get(task.id)!.revision, content: '已补齐条件，请核对。', idempotencyKey: randomUUID() }, null);
  expect(taskReportPresentation(views(task.id).summary)?.createdAt).toBe(reportedAt);
  vi.setSystemTime(reportedAt + 9 * 60000);
  store.apply(task.id, { kind: 'report', attemptId, status: 'working', content: '已收到条件说明，继续本次检查。', idempotencyKey: randomUUID() }, member);
  expect(taskReportPresentation(views(task.id).summary)).toMatchObject({ status: 'working', createdAt: reportedAt + 9 * 60000 });
  expect(store.get(task.id)?.events.some(event => event.kind === 'report' && event.reportStatus === 'blocked')).toBe(true);
});
