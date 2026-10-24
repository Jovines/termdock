import { Terminal } from 'lucide-react';
import type { TodoRun } from '../../todos/api';
import { todoSecondary } from './TodoForms';
export const todoTime = (time: number) => {
  const date = new Date(time), now = new Date(), today = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat('zh-CN', { ...(today ? {} : { month: 'short', day: 'numeric', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) }), hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
};
export const todoRunLabel: Record<TodoRun['status'], string> = { launching: '正在准备终端', delivered: '任务已发送到终端', complete: '已收到结果，待你确认', blocked: 'Agent 需要你协助', failed: '启动或处理失败' };
export function TodoRunCard({ run, onOpen, busy }: { run: TodoRun; onOpen: () => void; busy?: boolean }) {
  return <article className="rounded-xl border border-border/30 bg-surface p-4">
    <div className="flex flex-wrap items-center gap-2"><span className={`min-w-0 flex-1 text-sm font-medium ${run.status === 'complete' ? 'text-primary' : run.status === 'failed' || run.status === 'blocked' ? 'text-destructive' : ''}`}>{run.status === 'complete' ? '已收到结果报告' : todoRunLabel[run.status]}</span>{run.sessionId && !run.collectionSession?.recycledAt && <button type="button" className={todoSecondary} disabled={busy} onClick={onOpen}><Terminal size={15} />打开终端</button>}</div>
    <p className="mt-1 text-xs leading-6 text-muted-foreground">{run.config.agentSlug} · {todoTime(run.createdAt)}</p>
    {run.collectionSession?.recycledAt && <p className="mt-2 text-xs leading-6 text-muted-foreground">终端因持续无输出已回收 · {todoTime(run.collectionSession.recycledAt)}</p>}
    {run.status === 'delivered' && !run.collectionSession?.recycledAt && !run.result && <p className="mt-2 text-xs leading-6 text-muted-foreground">打开终端查看输出，或处理 Agent 的登录与授权。明确结果报告会显示在这里。</p>}
    {run.error && <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-destructive">{run.error}</p>}
    {run.result && <div className="termdock-native-select mt-3 whitespace-pre-wrap break-words border-t border-border/20 pt-3 text-sm leading-7">{run.result}</div>}
  </article>;
}
