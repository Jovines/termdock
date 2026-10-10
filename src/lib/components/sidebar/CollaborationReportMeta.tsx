import { taskReportPresentation } from '../../collaboration/taskReportPresentation';
import { collaborationUpdatedLabel } from '../../collaboration/taskTime';
import type { CollaborationTaskView } from '../../../server/agent/collaborationTaskTypes';

function timeLabel(timestamp: number) {
  return new Date(timestamp).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
export function CollaborationReportMeta({ task, now, compact = false }: { task: Pick<CollaborationTaskView, 'activeAttemptId' | 'attempts' | 'updatedAt'>; now?: number; compact?: boolean }) {
  const report = taskReportPresentation(task);
  const validRecordTime = Number.isFinite(task.updatedAt) && task.updatedAt > 0 && Number.isFinite(new Date(task.updatedAt).getTime());
  if (compact && !report) return null;
  return <span className="mt-1 block space-y-1 text-[11px] leading-5 text-muted-foreground">
    <span className="block break-words">{report ? <>最近明确报告：{report.label} · {report.createdAt === null ? '报告时间未提供' : <time dateTime={new Date(report.createdAt).toISOString()} title={new Date(report.createdAt).toLocaleString()}>{timeLabel(report.createdAt)}</time>}</> : '暂无明确报告'}</span>
    {!compact && <span className="block">{validRecordTime ? <>记录更新：<time dateTime={new Date(task.updatedAt).toISOString()} title={now === undefined ? new Date(task.updatedAt).toLocaleString() : collaborationUpdatedLabel(task.updatedAt, now)}>{timeLabel(task.updatedAt)}</time></> : '记录更新时间未提供'}</span>}
  </span>;
}
