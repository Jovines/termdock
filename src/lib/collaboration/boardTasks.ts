import type { CollaborationTaskView } from '../terminal/api';
import { collaborationTaskNeedsAttention, collaborationTaskStage } from './taskState';

/** Execution details stay attached to the user's goal, with orphaned work retained. */
export function collaborationBoardTasks(tasks: CollaborationTaskView[], showSteps = false, query = '') {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const parent = (task: CollaborationTaskView) => byId.get(task.parentTaskId ?? task.workflow?.rootTaskId ?? '');
  const rootOf = (task: CollaborationTaskView) => {
    const path: CollaborationTaskView[] = [];
    let current = task;
    while (true) {
      const cycle = path.findIndex(entry => entry.id === current.id);
      if (cycle !== -1) return path.slice(cycle).sort((a, b) => a.id.localeCompare(b.id))[0];
      path.push(current);
      const next = parent(current);
      if (!next || next.status === 'closed' && current.status !== 'closed') return current;
      current = next;
    }
  };
  const rootById = new Map(tasks.map(task => [task.id, rootOf(task).id]));
  return tasks.filter(task => showSteps || !!query.trim() || rootById.get(task.id) === task.id).map(task => {
    const children = showSteps || query.trim() ? [] : tasks.filter(child => child.id !== task.id && rootById.get(child.id) === task.id && child.status !== 'closed');
    const attention = task.status === 'open' && !collaborationTaskNeedsAttention(task)
      ? children.find(child => child.decisions.some(decision => decision.status === 'pending'))
        ?? children.find(child => collaborationTaskNeedsAttention(child) || child.workflow?.paused)
      : undefined;
    const attentionCount = children.filter(child => collaborationTaskNeedsAttention(child) || child.workflow?.paused).length;
    return { task, children, attention, attentionCount };
  });
}

export function collaborationBoardStatus(task: CollaborationTaskView, children: CollaborationTaskView[] = []) {
  const stage = collaborationTaskStage(task);
  const labels: Record<string, string> = {
    '已验收': '已完成 · 你已验收', '独立评审通过': '执行交付已评审',
    '需要你回答': '请回答成员的问题', '需要你确认方案': '请确认方案', '等待你验收': '请查看结果并验收',
    '成员报告受阻': '需要补充条件', '成员报告失败': '成员报告执行失败',
    '成员确认接手': '已接手 · 等待后续报告', '成员报告进行中': '成员报告：进行中',
    '等待独立评审': '结果已提交 · 等待评审', '评审通过 · 等待接续': '交付已评审 · 等待接续',
    '已要求跟进 · 等待新结果': '已提出跟进 · 等待新结果',
  };
  if (task.status === 'open' && children.length && !collaborationTaskNeedsAttention(task)
    && !task.artifacts.some(artifact => artifact.kind === 'result' && artifact.attemptId === task.activeAttemptId)) {
    if (children.every(child => child.status === 'accepted')) return '执行交付已评审 · 等待总结果';
    return '目标未完成 · 执行交付待齐';
  }
  return labels[stage] ?? stage;
}
