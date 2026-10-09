import type { CollaborationTaskView } from '../../server/agent/collaborationTaskTypes';

/** A retry acknowledgement is not a new execution attempt or a member reply. */
export function taskRetryFeedback(before: CollaborationTaskView, after: CollaborationTaskView): string {
  const retry = after.events.filter(event => event.kind === 'retry' && !before.events.some(previous => previous.id === event.id)).at(-1);
  const alreadyWrittenIds = new Set(before.deliveries.filter(receipt => receipt.status === 'delivered').map(receipt => receipt.id));
  const knownIds = new Set(before.outbox.filter(delivery => !alreadyWrittenIds.has(delivery.id)).map(delivery => delivery.id));
  const written = retry && after.deliveries.some(receipt => knownIds.has(receipt.id) && receipt.status === 'delivered'
    && receipt.deliveredAt !== null && receipt.deliveredAt >= retry.createdAt);
  let feedback = written ? '重试请求已保存，匹配本次请求的投递已写入终端。' : '重试请求已保存，服务将重新检查现有投递与协调条件。';
  if (!after.outbox.length && !written) feedback += ' 当前没有待重试的投递记录。';
  if (after.workflow?.paused) feedback += ' 后续自动安排仍已暂停。';
  const report = after.attempts.find(attempt => attempt.id === after.activeAttemptId)?.report;
  if (report && ['blocked', 'failed'].includes(report.status)) feedback += ' 成员原报告仍保留；请补齐条件并通知成员，收到新的明确回复后更新报告。';
  return feedback;
}
