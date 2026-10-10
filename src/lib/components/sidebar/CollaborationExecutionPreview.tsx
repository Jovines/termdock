import { ChevronRight, Circle, CircleCheck } from 'lucide-react';
import { collaborationBoardStatus } from '../../collaboration/boardTasks';
import { collaborationTaskNeedsAttention } from '../../collaboration/taskState';
import type { CollaborationTaskView } from '../../terminal/api';

/** A recorded execution checklist, not an estimate of Agent activity or progress. */
export function CollaborationExecutionPreview({ task, children, onSelect }: {
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
    const stage = record ? collaborationBoardStatus(record) : accepted ? child.completionMode === 'reviewed' ? '执行交付已评审' : '已验收' : '等待报告';
    const Icon = accepted ? CircleCheck : Circle;
    return <button type="button" key={child.id} className="flex min-h-11 w-full items-start gap-2 rounded-lg px-1 py-2 text-left hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" onClick={() => onSelect(child.id)}>
      <Icon size={14} className={`mt-0.5 shrink-0 ${accepted || attention ? 'text-primary' : 'text-muted-foreground'}`} />
      <span className="min-w-0 flex-1"><span title={child.title} className="block line-clamp-2 break-words text-xs leading-5 text-foreground">{child.title}</span><span className={`block text-[11px] leading-5 ${attention ? 'text-primary' : 'text-muted-foreground'}`}>{stage}</span></span>
      <ChevronRight size={12} className="mt-1 shrink-0 text-muted-foreground" />
    </button>;
  };
  return <section aria-label="执行事项" className="mx-4 border-t border-border/15 py-2">
    <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground"><span>执行事项</span><span>{done}/{items.length} 项已完成</span></div>
    {ordered.slice(0, 3).map(renderItem)}
    {ordered.length > 3 && <details><summary className="min-h-11 cursor-pointer py-3 text-[11px] text-muted-foreground">展开其余 {ordered.length - 3} 项</summary>{ordered.slice(3).map(renderItem)}</details>}
  </section>;
}
