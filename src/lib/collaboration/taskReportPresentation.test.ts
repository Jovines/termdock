import { describe, expect, it } from 'vitest';
import { taskReportPresentation } from './taskReportPresentation';
import type { CollaborationTaskAttempt } from '../../server/agent/collaborationTaskTypes';
const blockedAt = Date.parse('2026-10-09T14:30:00Z');
const attempt: CollaborationTaskAttempt = { id: 'active', assignee: { serviceId: 'fixture', sessionId: 'fixture' }, createdAt: 1, threadId: 'fixture', report: { status: 'blocked', content: '# 原始报告\n\n缺少测试条件。\n\n后续说明。', createdAt: blockedAt } };
describe('current explicit task report presentation', () => {
  it('keeps the report time when comments or retry change the task record time', () => {
    const task = { activeAttemptId: 'active', attempts: [attempt], updatedAt: Date.parse('2026-10-09T14:37:00Z'), automationIssue: '独立系统投递错误' };
    expect(taskReportPresentation(task)).toMatchObject({ status: 'blocked', createdAt: blockedAt, summary: '缺少测试条件。', content: attempt.report!.content });
    const retried = { ...task, updatedAt: Date.parse('2026-10-09T14:38:00Z') };
    expect(taskReportPresentation(retried)).toMatchObject({ status: 'blocked', createdAt: blockedAt });
  });
  it('changes report status and time only when a newer explicit report replaces it', () => {
    const workingAt = Date.parse('2026-10-09T14:39:00Z');
    const working = { ...attempt, report: { status: 'working' as const, content: '条件已经补齐。', createdAt: workingAt } };
    expect(taskReportPresentation({ activeAttemptId: 'active', attempts: [working] })).toMatchObject({ status: 'working', label: '成员报告进行中', createdAt: workingAt });
  });
  it('does not select old attempts or infer a report from terminal output or other updates', () => {
    expect(taskReportPresentation({ activeAttemptId: 'new', attempts: [attempt, { ...attempt, id: 'new', report: undefined }] })).toBeNull();
    expect(taskReportPresentation({ activeAttemptId: null, attempts: [attempt] })).toBeNull();
  });
  it('keeps summary-only report status and time while explaining missing original text', () => {
    const empty = { ...attempt, report: { ...attempt.report!, content: '' } };
    expect(taskReportPresentation({ activeAttemptId: 'active', attempts: [empty] })).toMatchObject({ status: 'blocked', createdAt: blockedAt, summary: '报告摘要未提供，请查看详情中的原始报告', content: '' });
    const summary = { ...empty, report: { ...empty.report, summary: '服务提供的原报告摘要' } };
    expect(taskReportPresentation({ activeAttemptId: 'active', attempts: [summary] })?.summary).toBe('服务提供的原报告摘要');
  });
  it('extracts a bounded summary below a heading without changing original content', () => {
    const content = `# 报告\n${'条件说明'.repeat(300)}`;
    const long = { ...attempt, report: { ...attempt.report!, content } };
    const result = taskReportPresentation({ activeAttemptId: 'active', attempts: [long] });
    expect(result?.summary.length).toBe(512);
    expect(result?.summary.startsWith('条件说明')).toBe(true);
    expect(result?.content).toBe(content);
  });
  it.each([NaN, 0, -1, Infinity, 9e15, undefined])('does not substitute another timestamp for invalid report time %s', createdAt => {
    const invalid = { ...attempt, report: { ...attempt.report!, createdAt: createdAt as number } };
    expect(taskReportPresentation({ activeAttemptId: 'active', attempts: [invalid] })?.createdAt).toBeNull();
  });
});
