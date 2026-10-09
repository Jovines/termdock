import { expect, it } from 'vitest';
import { taskRetryFeedback } from './taskActionFeedback';
import type { CollaborationTaskView } from '../../server/agent/collaborationTaskTypes';
const reportedAt = Date.parse('2026-10-09T14:30:00Z');
const retriedAt = Date.parse('2026-10-09T14:37:00Z');
const before = { events: [], outbox: [], deliveries: [], activeAttemptId: 'active', attempts: [{ id: 'active', report: { status: 'blocked', content: '缺少条件', createdAt: reportedAt } }], workflow: { paused: true } } as unknown as CollaborationTaskView;
const retry = { id: 'retry', kind: 'retry', createdAt: retriedAt } as CollaborationTaskView['events'][number];
it('only acknowledges a saved retry with no outbox and keeps the paused and member prerequisite facts', () => {
  const after = { ...before, events: [retry] };
  const text = taskRetryFeedback(before, after);
  expect(text).toContain('重试请求已保存'); expect(text).toContain('没有待重试的投递记录'); expect(text).toContain('后续自动安排仍已暂停'); expect(text).toContain('成员原报告仍保留');
  expect(text).not.toContain('已写入终端');
  expect(after.attempts[0].report?.createdAt).toBe(reportedAt);
});
it('does not use an old receipt or an unrelated new receipt to claim this retry wrote to a terminal', () => {
  const pending = { ...before, outbox: [{ id: 'pending', attemptId: 'active' }] };
  for (const [id, deliveredAt] of [['pending', reportedAt], ['unrelated', retriedAt + 1000]] as const) {
    const receipt = { id, attemptId: 'active', kind: 'message', messageId: 'message', status: 'delivered', deliveredAt, error: null };
    expect(taskRetryFeedback(pending, { ...before, events: [retry], deliveries: [receipt] })).not.toContain('已写入终端');
  }
});
it('reports writing only for a matching pending record with a receipt after the current retry event', () => {
  const pending = { ...before, outbox: [{ id: 'pending', attemptId: 'active' }] };
  const receipt = { id: 'pending', attemptId: 'active', kind: 'message', messageId: 'message', status: 'delivered', deliveredAt: retriedAt + 1000, error: null };
  expect(taskRetryFeedback(pending, { ...before, events: [retry], deliveries: [receipt] })).toContain('匹配本次请求的投递已写入终端');
  expect(taskRetryFeedback(pending, { ...before, events: [retry], deliveries: [receipt] })).toContain('成员原报告仍保留');
});
it('does not claim a newly observed write from an idempotent response with no new retry event', () => {
  const pending = { ...before, events: [retry], outbox: [{ id: 'pending', attemptId: 'active' }] };
  const receipt = { id: 'pending', attemptId: 'active', kind: 'message', messageId: 'message', status: 'delivered', deliveredAt: retriedAt + 1000, error: null };
  expect(taskRetryFeedback(pending, { ...pending, outbox: [], deliveries: [receipt] })).not.toContain('已写入终端');
});
it('does not treat a previously delivered receipt with a future clock as a new retry write', () => {
  const receipt = { id: 'pending', attemptId: 'active', kind: 'message', messageId: 'message', status: 'delivered', deliveredAt: retriedAt + 60000, error: null };
  const pending = { ...before, outbox: [{ id: 'pending', attemptId: 'active' }], deliveries: [receipt] };
  expect(taskRetryFeedback(pending, { ...pending, events: [retry], outbox: [] })).not.toContain('已写入终端');
});
