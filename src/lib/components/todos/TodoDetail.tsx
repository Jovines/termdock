import { ArrowUpRight, Check, Send, Terminal } from 'lucide-react';
import type { TodoItem, TodoRun } from '../../todos/api';
import { todoGhost, todoPrimary } from './TodoForms';
import { TodoMoreMenu, type TodoMenuItem } from './TodoMoreMenu';

export function TodoDetail({ todo, runs, busy, wide, menu, onLaunch, onOpen, onStatus, sessionName }: {
  todo: TodoItem; runs: TodoRun[]; busy: boolean; wide: boolean; menu: TodoMenuItem[];
  onLaunch: () => void; onOpen: (run: TodoRun) => void; onStatus: (status: TodoItem['status']) => void;
  sessionName?: string;
}) {
  const latest = runs.at(-1), linked = !!latest?.sessionId && latest.status !== 'failed';
  return <section aria-label="待办详情" className="flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-8 pt-6 sm:px-8">
      <div className="flex items-start gap-3"><h2 className="min-w-0 flex-1 break-words text-xl font-semibold leading-8">{todo.title}</h2>{wide && <TodoMoreMenu label="待办操作" items={menu} disabled={busy} />}</div>
      <p className="mt-2 text-xs leading-6 text-muted-foreground">{todo.source}{latest?.status === 'launching' ? ' · 正在发送' : linked ? ` · 已交给 ${sessionName || '会话'}` : ''}</p>
      {todo.description && <p className="termdock-native-select mt-5 whitespace-pre-wrap break-words text-[15px] leading-8">{todo.description}</p>}
      {latest?.handoff?.note && <div className="mt-6 text-sm leading-7"><p className="text-xs text-muted-foreground">发送时的补充</p><p className="mt-1 whitespace-pre-wrap break-words">{latest.handoff.note}</p></div>}
      {latest?.error && <p role="alert" className="mt-5 break-words text-sm leading-7 text-destructive">{latest.error}</p>}
      {todo.sourceUrl && <a className="mt-4 inline-flex min-h-11 items-center gap-1 text-sm text-primary" href={todo.sourceUrl} target="_blank" rel="noreferrer">查看来源<ArrowUpRight size={14} /></a>}
      {runs.some(run => run.result) && <details className="mt-8 border-t border-border/30 pt-3 text-sm text-muted-foreground"><summary className="min-h-11 cursor-pointer py-2.5">此前的处理记录</summary>{runs.filter(run => run.result).slice().reverse().map(run => <p key={run.id} className="mt-3 whitespace-pre-wrap break-words leading-7">{run.result}</p>)}</details>}
    </div>
    <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border/30 bg-[var(--chrome-bg)] px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))] sm:px-8">
      {todo.status === 'open' ? <>
        <button type="button" className={`${todoPrimary} flex-1 sm:flex-none`} disabled={busy || latest?.status === 'launching'} onClick={() => linked ? onOpen(latest!) : onLaunch()}>{linked ? <Terminal size={16} /> : <Send size={16} />}{linked ? '去会话' : latest?.status === 'launching' ? '正在发送…' : '交给会话'}</button>
        {linked && <button type="button" className={todoGhost} disabled={busy} onClick={onLaunch}>再次交给</button>}
        <button type="button" className={todoGhost} disabled={busy} onClick={() => onStatus('completed')}><Check size={16} />完成</button>
      </> : <button type="button" className={todoPrimary} disabled={busy} onClick={() => onStatus('open')}>重新打开</button>}
    </footer>
  </section>;
}
