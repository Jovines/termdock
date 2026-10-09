import { expect, it } from 'vitest';
import type { CollaborationTaskView } from '../terminal/api';
import { collaborationTaskBlocker, collaborationTaskBlockers, collaborationTaskNeedsAttention, collaborationTaskStage } from './taskState';
const report = '# 授权阻挡记录\n\n登录失败后已停止；需要有效授权或服务身份问题确认。\n\n请求与采样详细日志。';
const task = (extra: Partial<CollaborationTaskView> = {}): CollaborationTaskView => ({ status: 'open', activeAttemptId: 'attempt',
  attempts: [{ id: 'attempt', report: { status: 'blocked', content: report } }], decisions: [], artifacts: [], events: [], automationIssue: report, ...extra } as CollaborationTaskView);
it('uses the explicit member report rather than calling it a service exception', () => {
  expect(collaborationTaskStage(task())).toBe('成员报告受阻'); expect(collaborationTaskNeedsAttention(task())).toBe(true);
  expect(collaborationTaskBlocker(task())).toMatchObject({ source: 'member', summary: '登录失败后已停止；需要有效授权或服务身份问题确认。', content: report });
});
it('recognizes older summary responses whose report body was omitted', () => {
  expect(collaborationTaskBlocker(task({ attempts: [{ id: 'attempt', report: { status: 'blocked', content: '' } }] } as Partial<CollaborationTaskView>))?.source).toBe('member');
});
it('keeps an unrelated service failure distinct and gives unassigned work its preparation state', () => {
  expect(collaborationTaskStage(task({ automationIssue: '准备目录失败' }))).toBe('成员报告受阻');
  expect(collaborationTaskBlockers(task({ automationIssue: '准备目录失败' })).map(blocker => blocker.source)).toEqual(['member', 'system']);
  expect(collaborationTaskStage(task({ activeAttemptId: null, automationIssue: '缺少代码交付' }))).toBe('执行准备受阻');
});
it('does not expose historical obstacles as active after closing or accepting a task', () => {
  expect(collaborationTaskBlocker(task({ status: 'closed' }))).toBeNull();
  expect(collaborationTaskStage(task({ status: 'accepted' }))).toBe('已验收');
});

it('keeps the source of a legacy summary-only record unknown until full detail provides evidence', () => {
  const summary = task({ summaryOnly: true, automationIssue: '消息投递失败：网络中断', attempts: [{ id: 'attempt', report: { status: 'blocked', content: '', createdAt: 1 } }] } as Partial<CollaborationTaskView>);
  const blockers = collaborationTaskBlockers(summary);
  expect(blockers.map(blocker => blocker.source)).toEqual(['member', 'unknown']);
  expect(blockers[0].summary).toContain('报告摘要未提供');
  expect(blockers[0].content).toBe('');
  expect(blockers[1].summary).toBe('消息投递失败：网络中断');
  expect(blockers[1].label).toBe('服务记录（来源待核对）');
});
it('uses the explicit summary source marker for a long copied member report', () => {
  const long = `${report}\n\n${'长原文'.repeat(600)}`;
  const full = task({ attempts: [{ id: 'attempt', report: { status: 'blocked', content: long, createdAt: 1 } }], automationIssue: long.slice(0, 1000) } as Partial<CollaborationTaskView>);
  const summary = { ...full, summaryOnly: true, automationIssueSource: 'member-report' as const,
    attempts: [{ ...full.attempts[0], report: { ...full.attempts[0].report!, content: '', summary: '登录失败后已停止；需要有效授权或服务身份问题确认。' } }] };
  expect(collaborationTaskBlockers(full).map(blocker => blocker.source)).toEqual(['member']);
  expect(collaborationTaskBlockers(summary).map(blocker => blocker.source)).toEqual(['member']);
  expect(collaborationTaskBlocker(summary)?.summary).toBe(collaborationTaskBlocker(full)?.summary);
});
