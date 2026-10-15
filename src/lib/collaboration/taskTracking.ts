import type { CollaborationTaskView } from '../terminal/api';
import { collaborationTaskNeedsAttention, collaborationTaskStage } from './taskState';
import { taskReportPresentation } from './taskReportPresentation';

/** A projection of saved work and explicit updates, never a guess at Agent activity. */
export function collaborationGoalTracking(task: CollaborationTaskView, children: CollaborationTaskView[] = []) {
  const items = (children.length ? children : task.children ?? []).filter(child => child.status !== 'closed');
  const done = items.filter(child => child.status === 'accepted').length;
  const stage = collaborationTaskStage(task);
  const revision = task.events.filter(e => e.kind === 'revise' && e.attemptId === task.activeAttemptId).at(-1);
  const result = task.artifacts.filter(a => a.kind === 'result' && a.attemptId === task.activeAttemptId).at(-1);
  const pendingRevision = !!revision && (!result || revision.createdAt >= result.createdAt);
  const report = taskReportPresentation(task);
  const rawReport = task.attempts.find(a => a.id === task.activeAttemptId)?.report;
  const explicitReport = (value: typeof rawReport) => value?.summarySource === 'explicit' || value?.summarySource !== 'excerpt' && !!value?.summary?.trim();
  const coordination = task.events.filter(e => e.kind === 'coordinate' && e.attemptId === task.activeAttemptId && (!revision || e.sequence > revision.sequence)).at(-1);
  const updates = [
    ...(report?.createdAt && (!revision || report.createdAt > revision.createdAt) ? [{ summary: report.summary, createdAt: report.createdAt, source: '成员报告', explicit: explicitReport(rawReport), taskId: task.id, title: task.title }] : []),
    ...(coordination ? [{ summary: coordination.summary || coordination.content, createdAt: coordination.createdAt, source: '协调说明', explicit: !!coordination.summary?.trim(), taskId: task.id, title: task.title }] : []),
    // Do not present a previous round's child report as a response to a new request.
    ...(!pendingRevision ? children.filter(child => child.status !== 'closed').flatMap(child => {
      const r = taskReportPresentation(child);
      return r?.createdAt ? [{ summary: r.summary, createdAt: r.createdAt, source: '执行报告', explicit: explicitReport(child.attempts.find(a => a.id === child.activeAttemptId)?.report), taskId: child.id, title: child.title }] : [];
    }) : []),
  ].filter(update => update.summary.trim() && Number.isFinite(update.createdAt) && Number.isFinite(new Date(update.createdAt).getTime())).sort((a, b) => b.createdAt - a.createdAt);
  let label = stage;
  let next = '分派和报告会保存在这里；终端输出不能代替明确的任务报告。';
  if (task.workflow?.kind === 'goal') {
    if (task.status === 'accepted') { label = '已完成 · 你已验收'; next = '结果与执行记录已保留；追加要求可以继续跟进。'; }
    else if (task.status === 'closed') next = '此目标已关闭，已有报告仍保留。';
    else if (collaborationTaskNeedsAttention(task) || task.workflow.paused || result) {
      next = stage === '等待你验收' ? '总结果已交付；查看结论后验收，或提出继续跟进。'
        : stage === '等待独立评审' ? '总结果已提交，独立评审通过后交给你验收。'
        : stage === '需要你回答' ? '回答当前问题后，成员可以继续原来的工作。'
        : stage === '需要你确认方案' ? '确认这项必要决定后再继续；普通拆分不需要逐项批准。'
        : pendingRevision ? '沿用原目标推进追加要求；上一版结果不代表本轮完成。'
        : task.workflow.paused ? '自动安排已暂停，恢复后才能继续安排后续工作。'
        : '查看记录的阻塞原因，补充条件或重试；已有交付保留。';
    } else if (pendingRevision) {
      label = '已提出跟进 · 等待新报告';
      next = '沿用原目标推进追加要求；旧报告保留为历史，等待本轮明确更新。';
    } else if (items.length) {
      label = done === items.length ? '执行交付已评审 · 等待总结果' : '工作已拆分 · 执行与评审';
      next = done === items.length ? '执行事项已交付评审，下一步由协调者汇总总结果，再交给你验收。'
        : `已记录 ${items.length} 项工作，${done} 项交付已评审，${items.length - done} 项尚待交付或评审。`;
    } else if (report) {
      label = report.status === 'ack' ? '协调者已接手 · 等待拆分记录' : stage;
      next = '尚未记录执行事项；协调者需说明工作划分、交付内容和下一步。';
    } else next = stage === '已写入终端 · 等待回复' ? '目标已写入协调者终端，等待明确接手和拆分说明。' : '目标已保存，等待分派、投递和协调者明确回复。';
  }
  return { label, next, latest: updates[0] ?? null, total: items.length, done };
}

export function collaborationDependencyText(task: CollaborationTaskView, tasks: CollaborationTaskView[]) {
  const pending = task.dependsOn.filter(id => tasks.find(t => t.id === id)?.status !== 'accepted');
  if (!pending.length) return task.dependsOn.length ? '依赖交付已评审，可以接续' : '';
  return `等待依赖：${pending.map(id => tasks.find(t => t.id === id)?.title ?? '记录尚未同步').join('、')}`;
}

export function collaborationUpdatePreview(update: NonNullable<ReturnType<typeof collaborationGoalTracking>['latest']>) {
  return update.explicit ? update.summary : update.source === '协调说明'
    ? '协调者已更新工作安排。此记录未提供简短摘要，详情保留原始说明。'
    : `「${update.title}」有新的明确报告。此记录未提供简短摘要，详情保留原文。`;
}
