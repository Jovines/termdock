import { expect, it } from 'vitest';
import type { CollaborationTaskView } from '../terminal/api';
const boardTask = (id: string, overrides: Partial<CollaborationTaskView> = {}): CollaborationTaskView => ({ id, ownerServiceId: 'local', groupId: 'team', title: id, spec: '', constraints: '', acceptance: '', createdAt: 1, updatedAt: 2, revision: 1, coordinator: null, parentTaskId: null, dependsOn: [], status: 'open', activeAttemptId: null, attempts: [], events: [], decisions: [], artifacts: [], deliveries: [], outbox: [], memberSessions: {}, ...overrides });
import { collaborationDependencyText, collaborationGoalTracking } from './taskTracking';
const member = { serviceId: 'local', sessionId: 'lead' };
const goal = (patch = {}) => boardTask('goal', { workflow: { kind: 'goal', reviewers: [member], isolated: false, paused: false, maxRevisions: 3 }, activeAttemptId: 'a', attempts: [{ id: 'a', assignee: member, createdAt: 1, threadId: 'thread', deliveryStatus: 'delivered' }], ...patch });
it('distinguishes saved delivery, explicit acceptance of work and the absence of a recorded breakdown', () => {
  expect(collaborationGoalTracking(goal()).next).toContain('等待明确接手');
  const ack = goal({ attempts: [{ id: 'a', assignee: member, createdAt: 1, threadId: 'thread', report: { status: 'ack', content: '已接手', createdAt: 2 } }] });
  expect(collaborationGoalTracking(ack).label).toBe('协调者已接手 · 等待拆分记录');
  expect(collaborationGoalTracking(ack).total).toBe(0);
});
it('uses the latest explicit coordination or execution update instead of an old coordinator acknowledgment', () => {
  const root = goal({ events: [{ id: 'c', kind: 'coordinate', sequence: 2, attemptId: 'a', actor: member, createdAt: 5, content: '完整安排', summary: '正在集成，随后进行实机验收。' }] });
  const done = boardTask('done', { status: 'accepted', completionMode: 'reviewed' });
  const working = boardTask('working', { activeAttemptId: 'b', attempts: [{ id: 'b', assignee: member, threadId: 't', createdAt: 2, report: { status: 'working', createdAt: 6, content: '完整技术记录', summary: '终端接线已完成，正在核对快捷键。' } }] });
  const tracking = collaborationGoalTracking(root, [done, working]);
  expect(tracking).toMatchObject({ total: 2, done: 1, label: '工作已拆分 · 执行与评审', latest: { taskId: 'working', source: '执行报告', summary: '终端接线已完成，正在核对快捷键。', createdAt: 6 } });
  expect(tracking.next).toContain('1 项尚待交付或评审');
  expect(collaborationGoalTracking(root, [done]).label).toContain('等待总结果');
});
it('does not show previous-round reports as a new follow-up update or count closed work', () => {
  const revised = goal({ events: [{ id: 'v', kind: 'revise', source: 'user', sequence: 3, attemptId: 'a', actor: null, content: '继续检查', createdAt: 10 }, { id: 'c', kind: 'coordinate', sequence: 2, attemptId: 'a', actor: member, content: '旧安排', createdAt: 8 }] });
  const old = boardTask('old', { activeAttemptId: 'b', attempts: [{ id: 'b', assignee: member, threadId: 't', createdAt: 2, report: { status: 'working', createdAt: 6, content: '旧报告' } }] });
  expect(collaborationGoalTracking(revised, [old, boardTask('closed', { status: 'closed' })])).toMatchObject({ total: 1, latest: null });
});
it('explains dependency waits using deliverable names and retains unsynchronized prerequisites', () => {
  const step = boardTask('integration', { dependsOn: ['code', 'missing'] });
  const code = boardTask('code', { title: '完成终端接线' });
  expect(collaborationDependencyText(step, [code])).toBe('等待依赖：完成终端接线、记录尚未同步');
  expect(collaborationDependencyText({ ...step, dependsOn: ['code'] }, [{ ...code, status: 'accepted' }])).toContain('可以接续');
});
it('retains the distinction between a user-facing summary and a legacy excerpt', async () => {
  const { collaborationUpdatePreview } = await import('./taskTracking');
  const legacy = goal({ attempts: [{ id: 'a', assignee: member, createdAt: 1, threadId: 't', report: { status: 'working', content: '', summary: 'sha256/内部交接记录', summarySource: 'excerpt', createdAt: 2 } }] });
  const update = collaborationGoalTracking(legacy).latest!;
  expect(update.explicit).toBe(false);
  expect(collaborationUpdatePreview(update)).toContain('未提供简短摘要');
  expect(collaborationUpdatePreview(update)).not.toContain('sha256');
});
