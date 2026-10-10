import { CollaborationError } from './collaborationProtocol.js';
import type { CollaborationTask, TaskExecution, TaskPurpose } from './collaborationTaskTypes.js';

export function taskPurpose(value: unknown = 'interactive'): TaskPurpose {
  if (value !== 'interactive' && value !== 'automation') throw new CollaborationError('INVALID_TASK_PURPOSE', 'purpose must be interactive or automation');
  return value;
}
export function taskPurposeFilter(value: unknown = 'all'): TaskPurpose | 'all' {
  return value === 'all' ? value : taskPurpose(value);
}
/** Only ordered, explicit reports count. Revisions invalidate the previous round;
 * comments and responses leave it intact. Delivery never implies completion. */
export function taskExecution(task: CollaborationTask): TaskExecution {
  const report = task.events.filter(e => e.kind === 'report' && e.attemptId === task.activeAttemptId).at(-1);
  const revision = task.events.filter(e => e.kind === 'revise' && e.attemptId === task.activeAttemptId).at(-1);
  if (!task.activeAttemptId || !report?.reportStatus || revision && revision.sequence > report.sequence) {
    return { status: task.activeAttemptId ? 'awaiting_report' : 'unassigned', attemptId: task.activeAttemptId, reportEventId: null, artifactId: null, reportedAt: null };
  }
  return { status: report.reportStatus, attemptId: task.activeAttemptId, reportEventId: report.id,
    artifactId: report.reportStatus === 'complete' ? report.artifactId ?? null : null, reportedAt: report.createdAt };
}
