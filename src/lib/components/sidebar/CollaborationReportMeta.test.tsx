// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { CollaborationReportMeta } from './CollaborationReportMeta';
import type { CollaborationTaskAttempt } from '../../../server/agent/collaborationTaskTypes';
const reportAt = Date.parse('2026-10-09T14:30:00Z');
const recordAt = Date.parse('2026-10-09T14:37:00Z');
const attempt: CollaborationTaskAttempt = { id: 'active', assignee: { serviceId: 'fixture', sessionId: 'fixture' }, threadId: 'fixture', createdAt: 1, report: { status: 'blocked', content: '', createdAt: reportAt } };
afterEach(cleanup);
it('shows original explicit report metadata separately from comment or retry record updates', () => {
  const view = render(<CollaborationReportMeta task={{ activeAttemptId: 'active', attempts: [attempt], updatedAt: recordAt }} />);
  expect(screen.getByText(/最近明确报告：成员报告受阻/).querySelector('time')?.dateTime).toBe(new Date(reportAt).toISOString());
  expect(screen.getByText(/记录更新：/).querySelector('time')?.dateTime).toBe(new Date(recordAt).toISOString());
  view.rerender(<CollaborationReportMeta task={{ activeAttemptId: 'active', attempts: [{ ...attempt, report: { status: 'working', content: '恢复条件已提供', createdAt: recordAt + 120000 } }], updatedAt: recordAt + 120000 }} />);
  expect(screen.getByText(/最近明确报告：成员报告进行中/).querySelector('time')?.dateTime).toBe(new Date(recordAt + 120000).toISOString());
});
it('explains an absent current report and never displays an old attempt as current', () => {
  render(<CollaborationReportMeta task={{ activeAttemptId: 'new', attempts: [attempt], updatedAt: recordAt }} />);
  expect(screen.getByText('暂无明确报告')).toBeTruthy();
  expect(screen.queryByText(/成员报告受阻/)).toBeNull();
});
it('explains missing original timestamps without replacing them with record updates', () => {
  render(<CollaborationReportMeta task={{ activeAttemptId: 'active', attempts: [{ ...attempt, report: { ...attempt.report!, createdAt: NaN } }], updatedAt: recordAt }} />);
  expect(screen.getByText(/报告时间未提供/).querySelector('time')).toBeNull();
  expect(screen.getByText(/记录更新：/).querySelector('time')).toBeTruthy();
});
