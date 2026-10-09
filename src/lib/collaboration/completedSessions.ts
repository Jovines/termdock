import type { CollaborationTaskView } from '../terminal/api';

/** Only sessions tied to isolated task workspaces; never infer ownership from names. */
export function completedTaskSessions(tasks: CollaborationTaskView[], groupId: string): Set<string> {
  const completed = new Set<string>(), protectedSessions = new Set<string>();
  for (const task of tasks.filter(task => task.groupId === groupId)) {
    const assignee = task.attempts.find(attempt => attempt.id === task.activeAttemptId)?.assignee;
    const sessionId = assignee && task.memberSessions[`${assignee.serviceId}:${assignee.sessionId}`];
    if (task.status === 'open') {
      if (sessionId) protectedSessions.add(sessionId);
      const scheduled = task.scheduledAssignee;
      if (scheduled) protectedSessions.add(task.memberSessions[`${scheduled.serviceId}:${scheduled.sessionId}`]);
    } else if (sessionId && task.workspace && task.workflow?.kind === 'step' && task.workflow.isolated) completed.add(sessionId);
    if (task.coordinator) protectedSessions.add(task.memberSessions[`${task.coordinator.serviceId}:${task.coordinator.sessionId}`]);
    task.workflow?.reviewers.forEach(member => protectedSessions.add(task.memberSessions[`${member.serviceId}:${member.sessionId}`]));
  }
  protectedSessions.forEach(id => completed.delete(id));
  return completed;
}
