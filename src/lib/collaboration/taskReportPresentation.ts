import type { CollaborationTaskView, TaskReportStatus } from '../../server/agent/collaborationTaskTypes';
export const taskReportLabels: Record<string, string> = { ack: '成员确认接手', working: '成员报告进行中', blocked: '成员报告受阻', complete: '成员提交结果', failed: '成员报告失败' };

export interface TaskReportPresentation {
  status: TaskReportStatus;
  label: string;
  createdAt: number | null;
  summary: string;
  content: string;
}

/** Only the current attempt's explicit report can supply report status and time. */
export function taskReportPresentation(task: Pick<CollaborationTaskView, 'activeAttemptId' | 'attempts'>): TaskReportPresentation | null {
  const report = task.attempts.find(attempt => attempt.id === task.activeAttemptId)?.report;
  if (!report) return null;
  const content = typeof report.content === 'string' ? report.content : '';
  const suppliedSummary = report.summary;
  const firstParagraph = content.split(/\n\s*\n/).map(text => text.split('\n').filter(line => !/^#{1,6}\s/.test(line)).join('\n').trim()).find(Boolean);
  const summary = typeof suppliedSummary === 'string' && suppliedSummary.trim() ? suppliedSummary.trim() : firstParagraph;
  const validTime = Number.isFinite(report.createdAt) && report.createdAt > 0 && Number.isFinite(new Date(report.createdAt).getTime());
  return { status: report.status, label: taskReportLabels[report.status] ?? '成员明确报告',
    createdAt: validTime ? report.createdAt : null, content,
    summary: summary ? summary.slice(0, 512) : '报告摘要未提供，请查看详情中的原始报告' };
}
