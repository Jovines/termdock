import { collaborationDependencyText } from '../../collaboration/taskTracking';
import { ChevronRight, Circle, CircleCheck } from 'lucide-react';
import { collaborationBoardStatus } from '../../collaboration/boardTasks';
import { collaborationTaskNeedsAttention } from '../../collaboration/taskState';
import type { CollaborationTaskView } from '../../terminal/api';

/** A recorded execution checklist, not an estimate of Agent activity or progress. */
export function CollaborationExecutionPreview({ task, children, onSelect, detail = false, tasks = children, name }: {
  detail?: boolean; tasks?: CollaborationTaskView[]; name?: (task: CollaborationTaskView, member: import('../../terminal/api').TaskMember | null) => string;
  task: CollaborationTaskView; children: CollaborationTaskView[]; onSelect: (id: string) => void;
}) {
  const records = new Map(children.map(child => [child.id, child]));
  const items = (children.length ? children : task.children ?? []).filter(child => child.status !== 'closed');
  if (!items.length) return null;
  const priority = (id: string, accepted: boolean) => {
    const record = records.get(id);
    return record && (collaborationTaskNeedsAttention(record) || record.workflow?.paused) ? 0 : accepted ? 2 : 1;
  };
  const ordered = [...items].sort((a, b) => priority(a.id, a.status === 'accepted') - priority(b.id, b.status === 'accepted')
    || (records.get(b.id)?.updatedAt ?? 0) - (records.get(a.id)?.updatedAt ?? 0));
  const done = items.filter(child => child.status === 'accepted').length;
  const renderItem = (child: typeof items[number]) => {
    const record = records.get(child.id);
    const accepted = child.status === 'accepted';
    const attention = record && (collaborationTaskNeedsAttention(record) || record.workflow?.paused);
    const dependency = record?.status === 'open' ? collaborationDependencyText(record, tasks) : '';
    const owner = record?.attempts.find(a => a.id === record.activeAttemptId)?.assignee ?? record?.scheduledAssignee ?? null;
    const stage = record ? collaborationBoardStatus(record) : accepted ? child.completionMode === 'reviewed' ? '执行交付已评审' : '已验收' : '等待报告';
    const Icon = accepted ? CircleCheck : Circle;
    return <button type="button" key={child.id} className="flex min-h-11 w-full items-start gap-2 rounded-lg px-1 py-2 text-left hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" onClick={() => onSelect(child.id)}>
      <Icon size={14} className={`mt-0.5 shrink-0 ${accepted || attention ? 'text-primary' : 'text-muted-foreground'}`} />
      <span className="min-w-0 flex-1"><span title={child.title} className="line-clamp-2 break-words text-xs leading-5 text-foreground">{child.title}</span><span className={`block text-[11px] leading-5 ${attention ? 'text-primary' : 'text-muted-foreground'}`}>{stage}</span>{detail && record?.parentTaskId && record.parentTaskId !== task.id && <span className="block text-[11px] leading-5 text-muted-foreground">所属事项：{tasks.find(t => t.id === record.parentTaskId)?.title ?? '父任务记录尚未同步'}</span>}{detail && record?.acceptance && <span className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">交付标准：{record.acceptance}</span>}{dependency && <span className="line-clamp-2 text-[11px] leading-5 text-muted-foreground">{dependency}</span>}{detail && name && <span className="block text-[11px] leading-5 text-muted-foreground">负责人：{owner ? name(record!, owner) : '尚未分派'}</span>}</span>
      <ChevronRight size={12} className="mt-1 shrink-0 text-muted-foreground" />
    </button>;
  };
  return <section aria-label="执行事项" className={detail ? "border-t border-border/15 py-2" : "mx-4 border-t border-border/15 py-2"}>
    {!detail && <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground"><span>执行事项</span><span>{done}/{items.length} 项已完成</span></div>}
    {(detail ? ordered.filter(item => done === items.length || item.status !== 'accepted') : ordered.slice(0, 3)).map(renderItem)}
    {detail && done > 0 && done < items.length && <details><summary className="min-h-11 cursor-pointer py-3 text-xs text-muted-foreground">查看 {done} 项已完成的执行交付</summary>{ordered.filter(item => item.status === 'accepted').map(renderItem)}</details>}
    {!detail && ordered.length > 3 && <details><summary className="min-h-11 cursor-pointer py-3 text-[11px] text-muted-foreground">展开其余 {ordered.length - 3} 项</summary>{ordered.slice(3).map(renderItem)}</details>}
  </section>;
}
