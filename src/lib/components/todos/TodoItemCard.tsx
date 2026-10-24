import { ArrowUpRight, CheckCircle2, ChevronDown, Circle, Pencil } from 'lucide-react';
import type { TodoItem, TodoRun } from '../../todos/api';
import { TodoMoreMenu, type TodoMenuItem } from './TodoMoreMenu';
import { startTodoDrag } from './TodoSessionDropTarget';
import type { ReactNode } from 'react';

export function TodoItemCard({ todo, runs, workspace, sessionName, busy, expanded, selecting, checked, canSelect, handoff, onToggle, onCheck, onHandoff, onOpen, onStatus, onEdit, onReleaseClaim }: {
  todo: TodoItem; runs: TodoRun[]; workspace: string; sessionName?: string; busy: boolean; expanded: boolean; selecting: boolean; checked: boolean; canSelect: boolean; handoff?: ReactNode;
  onReleaseClaim?: () => void; onToggle: () => void; onCheck: (checked: boolean) => void; onHandoff: () => void; onOpen: (run: TodoRun) => void; onStatus: (status: TodoItem['status']) => void; onEdit: () => void;
}) {
  const latest = runs.at(-1), linked = !!latest?.sessionId && latest.status !== 'failed';
  const history = runs.filter(run => run.result);
  const hasDetails = !!(todo.description || latest?.handoff?.note || history.length);
  const menu: TodoMenuItem[] = todo.status === 'open' ? [
    ...(todo.claim && onReleaseClaim ? [{ label: '释放领取', action: onReleaseClaim }] : []),
    ...(linked ? [{ label: '交给其他会话', action: onHandoff, disabled: latest?.status === 'launching' }] : []),
    { label: '忽略这条待办', action: () => onStatus('ignored'), danger: true },
  ] : [];
  return <article data-todo-id={todo.id} draggable={!busy && !selecting && canSelect && !handoff} onDragStart={event => startTodoDrag(event, workspace, [todo.id])}
    className={`min-w-0 rounded-xl border border-border/40 p-3 ${expanded ? 'bg-surface' : 'hover:bg-surface/50'}`}>
    <div className="flex items-start gap-1">
      {selecting ? <label className="flex min-h-11 w-10 shrink-0 items-center justify-center"><input type="checkbox" aria-label={`选择 ${todo.title}`} checked={canSelect && checked} disabled={!canSelect} onChange={event => onCheck(event.target.checked)} className="h-4 w-4 accent-[var(--primary)]" /></label>
        : <button type="button" className="flex min-h-11 w-10 shrink-0 items-center justify-center text-muted-foreground hover:text-primary" disabled={busy || !!handoff} aria-label={`${todo.status === 'open' ? '完成' : '重新打开'} ${todo.title}`} onClick={() => onStatus(todo.status === 'open' ? 'completed' : 'open')}>
          {todo.status === 'completed' ? <CheckCircle2 size={20} className="text-primary" /> : <Circle size={20} />}
        </button>}
      <div className="min-w-0 flex-1 py-2">
        {hasDetails ? <button type="button" aria-expanded={expanded} className="flex w-full items-start gap-1.5 text-left" onClick={onToggle}><span className={`min-w-0 flex-1 break-words text-[15px] font-medium leading-6 ${todo.status === 'completed' ? 'text-muted-foreground line-through' : ''}`}>{todo.title}</span><ChevronDown size={14} className={`mt-1.5 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} /></button>
          : <h3 className={`break-words text-[15px] font-medium leading-6 ${todo.status === 'completed' ? 'text-muted-foreground line-through' : ''}`}>{todo.title}</h3>}
        {todo.source !== '手动添加' && <p className="mt-1 truncate text-xs leading-5 text-muted-foreground">{todo.source}</p>}
      </div>
      {!selecting && <button type="button" aria-label={`编辑 ${todo.title}`} title="编辑待办" className="inline-flex min-h-11 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-2 hover:text-foreground" disabled={busy || !!handoff} onClick={onEdit}><Pencil size={15} /></button>}
      {!selecting && !!menu.length && <TodoMoreMenu label={`更多操作 ${todo.title}`} items={menu} disabled={busy || !!handoff} />}
    </div>
    {todo.description && <p className={`termdock-native-select ml-11 whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground ${expanded ? 'mt-1' : 'line-clamp-2'}`}>{todo.description}</p>}
    {todo.claim && <p className="ml-11 mt-1 text-xs leading-6 text-muted-foreground">{todo.claim.expiresAt > Date.now() ? '已领取' : '领取已过期'} · {sessionName || todo.claim.sessionName}</p>}
    {todo.autoProcessing?.state === 'failed' && <p role="alert" className="ml-11 mt-2 text-sm leading-6 text-destructive">自动交接失败：{todo.autoProcessing.error}。可以手动交给会话。</p>}
    {latest?.error && <p role="alert" className="ml-11 mt-2 break-words text-sm leading-6 text-destructive">{latest.error}</p>}
    {expanded && latest?.handoff?.note && <div className="ml-11 mt-3 text-sm leading-6"><p className="text-xs text-muted-foreground">发送时的补充</p><p className="mt-1 whitespace-pre-wrap break-words">{latest.handoff.note}</p></div>}
    {expanded && !!history.length && <details className="ml-11 mt-3 text-sm text-muted-foreground"><summary className="min-h-11 cursor-pointer py-2.5">此前的处理记录</summary>{history.slice().reverse().map(run => <p key={run.id} className="mt-2 whitespace-pre-wrap break-words leading-7">{run.result}</p>)}</details>}
    {handoff && <div className="mt-3 border-t border-border/30 pt-3">{handoff}</div>}
    {!handoff && !selecting && (todo.status === 'open' || linked || todo.sourceUrl) && <div className="ml-9 mt-1 flex flex-wrap items-center gap-x-2">
      {(todo.status === 'open' || linked) && <button type="button" className="inline-flex min-h-11 shrink-0 items-center rounded-lg px-2 text-xs font-medium text-primary hover:bg-surface-2 disabled:opacity-40" disabled={busy || latest?.status === 'launching'} aria-label={`${linked ? '去会话' : '交给会话'} ${todo.title}`} onClick={() => linked ? onOpen(latest!) : onHandoff()}>{latest?.status === 'launching' ? '发送中…' : linked ? '去会话' : '交给会话'}</button>}
      {linked && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={sessionName}>已交给 {sessionName || '会话'}</span>}
      {todo.sourceUrl && <a href={todo.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1 px-2 text-xs text-muted-foreground hover:text-primary">来源<ArrowUpRight size={13} /></a>}
    </div>}
  </article>;
}
