import type { CollaborationTaskView } from '../../server/agent/collaborationTaskTypes';

import { taskReportLabels, taskReportPresentation } from './taskReportPresentation';
export { taskReportLabels } from './taskReportPresentation';

/** Member prerequisites and service exceptions are separate recorded facts. */
export function collaborationTaskBlockers(task: CollaborationTaskView) {
  if (task.status !== 'open') return [];
  const report = taskReportPresentation(task);
  const member = report && ['blocked', 'failed'].includes(report.status)
    ? { source: 'member' as const, label: report.label, content: report.content,
      summary: report.summary, createdAt: report.createdAt } : null;
  const copiedReport = member && (task.automationIssueSource === 'member-report'
    || !task.summaryOnly && !!report?.content && task.automationIssue === report.content.slice(0, 1000));
  const unknownSource = member && !report?.content && !task.automationIssueSource;
  const system = task.automationIssue && !copiedReport ? { source: unknownSource ? 'unknown' as const : 'system' as const,
    label: unknownSource ? '服务记录（来源待核对）' : task.automationIssue.startsWith('消息投递') ? '投递需要处理' : !task.activeAttemptId ? '执行准备受阻' : '自动安排受阻',
    content: task.automationIssue, summary: task.automationIssue } : null;
  return [member, system].filter((blocker): blocker is NonNullable<typeof blocker> => !!blocker);
}
export function collaborationTaskBlocker(task: CollaborationTaskView) {
  return collaborationTaskBlockers(task)[0] ?? null;
}
export function collaborationTaskStage(task: CollaborationTaskView): string {
  if (task.status === 'accepted') return task.completionMode === 'reviewed' ? '独立评审通过' : '已验收';
  if (task.status === 'closed') return '已关闭';
  if (task.decisions.some(q => q.status === 'pending')) return '需要你回答';
  const blocker = collaborationTaskBlocker(task);
  if (blocker) return blocker.label;
  if (task.workflow?.paused) return '自动安排已暂停';
  const attempt = task.attempts.find(a => a.id === task.activeAttemptId);
  const plan = task.artifacts.filter(a => a.kind === 'plan' && a.attemptId === task.activeAttemptId).at(-1);
  if (plan && plan.id !== task.approvedPlanArtifactId) return '需要你确认方案';
  const result = task.artifacts.filter(a => a.kind === 'result' && a.attemptId === task.activeAttemptId).at(-1);
  const revised = result && task.events.some(e => e.kind === 'revise' && e.attemptId === task.activeAttemptId && e.createdAt >= result.createdAt);
  if (result && !revised) {
    const review = task.artifacts.filter(a => a.kind === 'review' && a.reviewsArtifactId === result.id).at(-1);
    if (task.workflow && review?.verdict !== 'pass') return review?.verdict === 'changes' ? '评审要求修改' : '等待独立评审';
    return task.workflow?.kind === 'step' ? '评审通过 · 等待接续' : '等待你验收';
  }
  if (revised) return task.events.some(e => e.kind === 'revise' && e.source === 'user' && e.attemptId === task.activeAttemptId && e.createdAt >= result!.createdAt) ? '已要求跟进 · 等待新结果' : '已要求修改 · 等待新结果';
  if (!attempt) return task.scheduledAssignee ? task.dependsOn.length ? '依赖完成后自动分派' : task.workflow?.isolated === false ? '等待分派' : '准备独立执行目录' : task.dependsOn.length ? '等待依赖与分派' : '待分派';
  if (attempt.report) return taskReportLabels[attempt.report.status];
  if (['failed', 'expired'].includes(attempt.deliveryStatus ?? '')) return '投递未成功';
  if (task.deliveries.some(d => d.attemptId === task.activeAttemptId && d.error)) return '投递需要关注';
  return attempt.deliveryStatus === 'delivered' ? '已写入终端 · 等待回复' : '等待投递';
}
export function collaborationTaskNeedsAttention(task: CollaborationTaskView): boolean {
  return task.status === 'open' && ['需要你回答', '需要你确认方案', '等待你验收', '执行准备受阻', '自动安排受阻', '成员报告受阻', '成员报告失败', '投递未成功', '投递需要关注', '投递需要处理'].includes(collaborationTaskStage(task));
}
