import { ArrowUpRight, Check, Play, RefreshCw, Settings2, Terminal } from 'lucide-react';
import type { TodoItem, TodoLaunchConfig, TodoRun } from '../../todos/api';
import { directoryName } from '../../todos/preferences';
import { todoGhost, todoPrimary } from './TodoForms';
import { TodoMoreMenu, type TodoMenuItem } from './TodoMoreMenu';
import { TodoRunCard, todoTime } from './TodoRunCard';

export function TodoDetail({ todo, runs, config, agentName, busy, wide, menu, onLaunch, onConfigure, onOpen, onStatus }: {
  todo: TodoItem; runs: TodoRun[]; config: TodoLaunchConfig; agentName: string; busy: boolean; wide: boolean; menu: TodoMenuItem[];
  onLaunch: () => void; onConfigure: () => void; onOpen: (run: TodoRun) => void; onStatus: (status: TodoItem['status']) => void;
}) {
  const latest = runs.at(-1), report = latest?.result;
  const complete = latest?.status === 'complete', waiting = latest?.status === 'launching' || latest?.status === 'delivered';
  const label = todo.status !== 'open' ? '重新打开' : complete ? '确认完成' : latest?.sessionId && (waiting || latest.status === 'blocked') ? '查看执行' : latest?.status === 'launching' ? '正在准备终端…' : latest ? '重新处理' : '交给 Agent';
  const act = () => {
    if (todo.status !== 'open') onStatus('open');
    else if (complete) onStatus('completed');
    else if (latest?.sessionId && (waiting || latest.status === 'blocked')) onOpen(latest);
    else if (latest) onConfigure();
    else onLaunch();
  };
  return <section aria-label="待办详情" className="flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-8 pt-6 sm:px-8">
      <div className="flex items-start gap-3"><h2 className="min-w-0 flex-1 break-words text-xl font-semibold leading-8">{todo.title}</h2>{wide && <TodoMoreMenu label="待办操作" items={menu} disabled={busy} />}</div>
      {!report && todo.source && todo.source !== '手动添加' && <p className="mt-2 text-xs leading-6 text-muted-foreground">{todo.source}</p>}
      {latest && <p className="mt-3 flex flex-wrap gap-x-3 text-xs leading-6 text-muted-foreground">
        <span className={complete ? 'text-primary' : latest.status === 'failed' || latest.status === 'blocked' ? 'text-destructive' : ''}>{complete ? todo.status === 'open' ? '待你确认' : todo.status === 'ignored' ? '已忽略' : '已完成' : latest.status === 'launching' ? '正在准备终端' : latest.status === 'delivered' ? '任务已发送，可查看终端输出' : latest.status === 'blocked' ? 'Agent 报告需要协助' : '这次处理未能完成'}</span>
        {report && <span>{agentName} · {todoTime(latest.updatedAt)}</span>}
      </p>}
      {report ? <>
        <div className="termdock-native-select mt-5 whitespace-pre-wrap break-words text-[15px] leading-8 text-foreground">{report}</div>
        {todo.description && <details className="mt-8 border-t border-border/30 pt-3 text-sm text-muted-foreground"><summary className="min-h-11 cursor-pointer py-2.5">原始待办</summary><p className="termdock-native-select mt-2 whitespace-pre-wrap break-words leading-7">{todo.description}</p></details>}
      </> : <>
        {todo.description && <p className="termdock-native-select mt-5 whitespace-pre-wrap break-words text-[15px] leading-8">{todo.description}</p>}
        {latest?.status === 'delivered' && <p className="mt-5 text-sm leading-7 text-muted-foreground">结果会回到这条待办。需要登录或授权时，打开终端继续。</p>}
      </>}
      {latest?.error && <p role="alert" className="mt-5 whitespace-pre-wrap break-words text-sm leading-7 text-destructive">{latest.error}</p>}
      {todo.sourceUrl && <a className="mt-4 inline-flex min-h-11 items-center gap-1 text-sm text-primary" href={todo.sourceUrl} target="_blank" rel="noreferrer">查看来源<ArrowUpRight size={14} /></a>}
      <details className="mt-8 border-t border-border/30 pt-3 text-sm text-muted-foreground"><summary className="min-h-11 cursor-pointer py-2.5">任务信息{runs.length > 1 ? `与 ${runs.length - 1} 次历史记录` : ''}</summary>
        <dl className="space-y-3 py-3 text-xs leading-6"><div><dt>来源</dt><dd>{todo.source}</dd></div><div><dt>创建时间</dt><dd>{todoTime(todo.createdAt)}</dd></div><div><dt>处理配置</dt><dd className="break-all">{agentName} · {config.cwd || '服务默认目录'}</dd></div></dl>
        {latest?.sessionId && <button type="button" className={todoGhost} disabled={busy} onClick={() => onOpen(latest)}><Terminal size={15} />打开终端</button>}
        {runs.length > 1 && <div className="space-y-3 pt-3">{runs.slice(0, -1).reverse().map(run => <TodoRunCard key={run.id} run={run} busy={busy} onOpen={() => onOpen(run)} />)}</div>}
      </details>
    </div>
    <footer className="shrink-0 border-t border-border/30 bg-[var(--chrome-bg)] px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))] sm:px-8">
      {todo.status === 'open' && !latest && <button type="button" className="mb-2 flex min-h-9 max-w-full items-center gap-2 text-xs text-muted-foreground hover:text-foreground" title={config.cwd || '服务默认目录'} onClick={onConfigure} disabled={busy}><Settings2 size={13} /><span className="truncate">{agentName} · {directoryName(config.cwd) || '服务默认目录'}</span></button>}
      <button type="button" className={`${todoPrimary} w-full sm:w-auto sm:min-w-40`} disabled={busy || todo.status === 'open' && latest?.status === 'launching' && !latest.sessionId} onClick={act}>
        {todo.status !== 'open' ? <RefreshCw size={16} /> : complete ? <Check size={16} /> : latest?.sessionId && waiting ? <Terminal size={16} /> : <Play size={16} />}{label}
      </button>
    </footer>
  </section>;
}
