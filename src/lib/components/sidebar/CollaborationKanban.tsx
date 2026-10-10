import { collaborationBoardStatus, collaborationBoardTasks } from '../../collaboration/boardTasks';
import { CollaborationExecutionPreview } from './CollaborationExecutionPreview';
import { CollaborationReportMeta } from './CollaborationReportMeta';
import { collaborationResultPresentation } from '../../collaboration/resultPresentation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowUpRight, Circle, CircleCheck, MessageCircle, MoreHorizontal, Play, Search, SlidersHorizontal, X } from 'lucide-react';
import { collaborationTaskBlockers, collaborationTaskNeedsAttention, collaborationTaskStage } from '../../collaboration/taskState';
import type { CollaborationTaskView, TaskMember } from '../../terminal/api';

export type TaskLane = 'backlog' | 'running' | 'attention' | 'done';
export function collaborationTaskLane(task: CollaborationTaskView): TaskLane {
  if (task.status !== 'open') return 'done';
  if (collaborationTaskNeedsAttention(task) || task.workflow?.paused) return 'attention';
  return task.activeAttemptId ? 'running' : 'backlog';
}
const lanes = [
  { id: 'backlog', label: '待开始', icon: Circle, hint: '等待分派或依赖完成' },
  { id: 'running', label: '执行中', icon: Play, hint: '分派后的任务会出现在这里' },
  { id: 'attention', label: '需要你', icon: MessageCircle, hint: '问题、方案与验收都在这里' },
  { id: 'done', label: '已完成', icon: CircleCheck, hint: '验收后的结果会保留在这里' },
] as const;

export function CollaborationKanban({ tasks, selectedId, onSelect, name, storage, action, navigation, settings }: {
  navigation?: ReactNode; settings?: ReactNode; action?: ReactNode; storage: string; tasks: CollaborationTaskView[]; selectedId: string | null; onSelect: (id: string) => void;
  name: (task: CollaborationTaskView, member: TaskMember | null) => string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const laneScroll = useRef<HTMLDivElement>(null);
  const laneRef = useRef<TaskLane>('backlog');
  const previousWidth = useRef(0);
  const scrollingToLane = useRef<TaskLane | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      const width = entries[0].contentRect.width;
      setDesktop(width >= 760);
      if (width !== previousWidth.current && width < 760 && laneScroll.current) laneScroll.current.scrollLeft = lanes.findIndex(l => l.id === laneRef.current) * laneScroll.current.clientWidth;
      previousWidth.current = width;
    });
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  const [initial] = useState(() => {
    try { return JSON.parse(localStorage.getItem(`${storage}:board`) ?? 'null') as { lane?: TaskLane; scope?: string; query?: string; closed?: boolean; showSteps?: boolean } | null; }
    catch { return null; }
  });
  const [lane, setLane] = useState<TaskLane>(() => {
    if (lanes.some(l => l.id === initial?.lane)) return initial!.lane!;
    const rows = collaborationBoardTasks(tasks, initial?.showSteps === true, initial?.query ?? '');
    const phases = rows.map(row => row.attention ? 'attention' : collaborationTaskLane(row.task));
    return phases.includes('attention') ? 'attention' : phases.includes('running') ? 'running' : phases.includes('backlog') ? 'backlog' : 'done';
  });
  laneRef.current = lane;
  function selectLane(next: TaskLane, animate = true) {
    setLane(next);
    const rail = laneScroll.current;
    if (!rail || !rail.clientWidth) return;
    scrollingToLane.current = next;
    const left = lanes.findIndex(l => l.id === next) * rail.clientWidth;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (rail.scrollTo) rail.scrollTo({ left, behavior: animate && !reduced ? 'smooth' : 'auto' });
    else rail.scrollLeft = left;
  }
  useEffect(() => { if (!desktop) selectLane(laneRef.current, false); }, [desktop]);
  const [scope, setScope] = useState(typeof initial?.scope === 'string' ? initial.scope : 'all');
  const [query, setQuery] = useState(typeof initial?.query === 'string' ? initial.query : '');
  const [closed, setClosed] = useState(initial?.closed === true);
  const [showSteps, setShowSteps] = useState(initial?.showSteps === true);
  const [searchOpen, setSearchOpen] = useState(Boolean(initial?.query));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsHost = useRef<HTMLDivElement>(null), toolsButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!toolsOpen) return;
    toolsHost.current?.querySelector<HTMLButtonElement>('[aria-label="看板更多操作"] button')?.focus();
    const outside = (event: PointerEvent) => { if (!toolsHost.current?.contains(event.target as Node)) setToolsOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setToolsOpen(false); toolsButton.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [toolsOpen]);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const filtersHost = useRef<HTMLDivElement>(null);
  const filtersButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (searchOpen) searchInput.current?.focus(); }, [searchOpen]);
  useEffect(() => {
    if (!filtersOpen) return;
    filtersHost.current?.querySelector<HTMLSelectElement>('select')?.focus();
    const outside = (event: PointerEvent) => { if (!filtersHost.current?.contains(event.target as Node)) setFiltersOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setFiltersOpen(false); (desktop ? filtersButton : toolsButton).current?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [filtersOpen]);
  useEffect(() => {
    try { localStorage.setItem(`${storage}:board`, JSON.stringify({ lane, scope, query, closed, showSteps })); } catch { /* Current navigation remains usable in private mode. */ }
  }, [storage, lane, scope, query, closed, showSteps]);
  const roots = tasks.filter(t => t.workflow?.kind === 'goal');
  const boardRows = collaborationBoardTasks(tasks, showSteps, query);
  const rowById = new Map(boardRows.map(row => [row.task.id, row]));
  const boardLane = (task: CollaborationTaskView): TaskLane => rowById.get(task.id)?.attention ? 'attention' : collaborationTaskLane(task);
  const selectedRow = selectedId ? boardRows.find(row => row.task.id === selectedId || row.children.some(child => child.id === selectedId)) : undefined;
  const selectedStage = selectedRow ? boardLane(selectedRow.task) : undefined;
  useEffect(() => { if (selectedStage) selectLane(selectedStage, false); }, [selectedId, selectedStage]);
  const scoped = boardRows.map(row => row.task).filter(t => (closed || t.status !== 'closed')
    && (scope === 'all' || t.id === scope || rowById.get(t.id)?.rootId === scope)
    && (!query.trim() || `${t.title} ${t.spec} ${t.attempts.map(a => name(t, a.assignee)).join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  const filterCount = Number(scope !== 'all') + Number(closed) + Number(showSteps);
  const compactButton = 'inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary';
  const menuItem = 'flex min-h-11 w-full items-center justify-start gap-3 rounded-lg px-3 text-left text-sm font-medium text-foreground hover:bg-surface-2 active:bg-surface-elevated focus-visible:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary';
  const searchField = <div className={`relative flex min-w-0 items-center ${desktop ? 'flex-1 max-w-[240px]' : 'w-full'}`}><span className="sr-only">搜索任务</span><Search aria-hidden="true" size={15} className="pointer-events-none absolute left-3 text-muted-foreground" /><input ref={searchInput} aria-label="搜索任务" type="search" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!query) { setSearchOpen(false); requestAnimationFrame(() => (desktop ? searchButton : toolsButton).current?.focus()); } else setQuery(''); } }} placeholder="搜索任务或负责人" className="min-h-11 w-full rounded-lg border border-border/20 bg-transparent pl-9 pr-9 text-xs outline-none focus:border-primary" /><button type="button" aria-label="关闭搜索" className="absolute right-0 flex min-h-11 w-9 items-center justify-center text-muted-foreground" onClick={() => { setQuery(''); setSearchOpen(false); requestAnimationFrame(() => (desktop ? searchButton : toolsButton).current?.focus()); }}><X size={14} /></button></div>;
  const filterPanel = <div aria-label="任务筛选" className="absolute right-0 top-full z-30 mt-1 w-64 space-y-3 rounded-xl border border-border/30 bg-surface p-3 shadow-xl">
          <label className="block space-y-1 text-xs text-muted-foreground"><span>目标范围</span><select aria-label="按目标查看" value={scope} onChange={e => setScope(e.target.value)} className="min-h-11 w-full rounded-lg border border-border/20 bg-surface-2 px-3 text-xs text-foreground"><option value="all">所有目标</option>{roots.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label>
          <label className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={closed} onChange={e => setClosed(e.target.checked)} />含已关闭</label>
          <label className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={showSteps} onChange={e => setShowSteps(e.target.checked)} />显示执行子任务</label>
          {filterCount > 0 && <button type="button" className="min-h-11 w-full rounded-lg text-xs text-primary hover:bg-surface-2" onClick={() => { setScope('all'); setClosed(false); setShowSteps(false); }}>清除筛选</button>}
        </div>;
  return <div ref={host} className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
    <div ref={desktop ? undefined : filtersHost} aria-label="看板工具栏" className="relative z-20 flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/15 pb-2">
      {desktop ? <>

      {navigation && <div className={`flex min-w-0 items-center mr-auto`}>{navigation}</div>}
      {searchOpen ? searchField : <button ref={searchButton} type="button" aria-label="搜索任务" title="搜索任务" className={`${compactButton} ${navigation ? '' : 'ml-auto'}`} onClick={() => setSearchOpen(true)}><Search size={16} /></button>}
      <div ref={filtersHost} className={`relative shrink-0`}>
        <button ref={filtersButton} type="button" aria-label={filterCount ? `筛选任务，${filterCount} 项已启用` : '筛选任务'} aria-expanded={filtersOpen} className={`${compactButton} ${filterCount ? 'text-primary' : ''}`} onClick={() => setFiltersOpen(v => !v)}><SlidersHorizontal size={15} /><span>筛选</span>{filterCount > 0 && <span className="tabular-nums text-primary">{filterCount}</span>}</button>
        {filtersOpen && filterPanel}
      </div>
      {settings}
      {action && <div className="shrink-0">{action}</div>}
      </> : <>
        {navigation && <div className="mr-auto flex min-w-0 items-center">{navigation}</div>}
        {action && <div className="shrink-0">{action}</div>}
        <div ref={toolsHost} className="relative shrink-0">
          <button ref={toolsButton} type="button" aria-label="更多看板操作" aria-expanded={toolsOpen} className={`${compactButton} ${toolsOpen ? 'bg-surface-2 text-foreground' : filterCount || query.trim() ? 'text-primary' : ''}`} onClick={() => { setToolsOpen(v => !v); setFiltersOpen(false); }}><MoreHorizontal size={18} />{filterCount > 0 && <span className="text-[10px]">{filterCount}</span>}</button>
          {toolsOpen && <div role="group" aria-label="看板更多操作" className="absolute right-0 top-full z-30 mt-2 flex w-52 max-w-[calc(100vw-2rem)] flex-col gap-0.5 rounded-xl border border-border/40 bg-surface p-1.5 shadow-xl" onClick={() => setToolsOpen(false)}>
            <button ref={searchButton} type="button" aria-label="搜索任务" className={menuItem} onClick={() => setSearchOpen(true)}><Search size={18} className="shrink-0 text-muted-foreground" />搜索任务</button>
            <button ref={filtersButton} type="button" aria-label={filterCount ? `筛选任务，${filterCount} 项已启用` : '筛选任务'} className={menuItem} onClick={() => setFiltersOpen(true)}><SlidersHorizontal size={18} className="shrink-0 text-muted-foreground" />筛选任务{filterCount > 0 && <span className="ml-auto rounded bg-primary/10 px-1.5 text-xs tabular-nums text-primary">{filterCount}</span>}</button>
            {settings && <div className="mt-1 border-t border-border/30 pt-1 [&>button]:min-h-11 [&>button]:w-full [&>button]:justify-start [&>button]:gap-3 [&>button]:px-3 [&>button]:text-left [&>button]:text-sm [&>button]:text-foreground [&>button:hover]:bg-surface-2 [&>button:active]:bg-surface-elevated [&>button:focus-visible]:bg-surface-2 [&>button>svg]:h-[18px] [&>button>svg]:w-[18px] [&>button>svg]:shrink-0 [&>button>svg]:text-muted-foreground [&>button>span]:not-sr-only">{settings}</div>}
          </div>}
        </div>
        {searchOpen && searchField}
        {filtersOpen && filterPanel}
      </>}
    </div>
    <p className="px-1 text-[11px] leading-5 text-muted-foreground">{showSteps ? '包含执行子任务，可在筛选中切回目标视图。' : '每张卡片对应一个目标，待完成事项和最近交付直接显示在卡片中。'}</p>
    <nav hidden={desktop} aria-label="看板阶段" className={`${desktop ? "hidden" : "grid"} shrink-0 grid-cols-4 gap-1`}>{lanes.map(l => <button key={l.id} type="button" aria-pressed={lane === l.id} className={`min-h-11 rounded-lg px-1 text-xs ${lane === l.id ? 'bg-surface-2 text-foreground' : 'text-muted-foreground'}`} onClick={() => selectLane(l.id)}>{l.label}<span className="ml-1 tabular-nums">{scoped.filter(t => boardLane(t) === l.id).length}</span></button>)}</nav>
    <div ref={desktop ? undefined : laneScroll} data-kanban-scroll onPointerDown={() => { scrollingToLane.current = null; }} onWheel={() => { scrollingToLane.current = null; }} aria-label={desktop ? undefined : '可左右滑动的任务看板'} onScroll={desktop ? undefined : event => {
      if (event.target !== event.currentTarget || !event.currentTarget.clientWidth) return;
      const target = scrollingToLane.current;
      if (target) {
        const expected = lanes.findIndex(l => l.id === target) * event.currentTarget.clientWidth;
        if (Math.abs(event.currentTarget.scrollLeft - expected) > 2) return;
        scrollingToLane.current = null;
      }
      const index = Math.max(0, Math.min(lanes.length - 1, Math.round(event.currentTarget.scrollLeft / event.currentTarget.clientWidth)));
      setLane(lanes[index].id);
    }} className={desktop ? "min-h-0 flex-1 overflow-auto pb-3" : "min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"}>
      {desktop && <div aria-label="看板列标题" className="sticky top-0 z-10 grid min-w-[1000px] grid-cols-4 gap-4 border-b border-border/15 bg-[var(--chrome-bg)] pb-2">{lanes.map(l => { const Icon = l.icon; return <h4 key={l.id} className={`flex items-center gap-2 px-3 py-2 text-[13px] font-medium ${l.id === 'attention' ? 'text-primary' : 'text-muted-foreground'}`}><Icon size={15} />{l.label}<span className="ml-auto tabular-nums text-xs">{scoped.filter(t => boardLane(t) === l.id).length}</span></h4>; })}</div>}
      <div className={desktop ? "grid min-h-full min-w-[1000px] grid-cols-4 items-start gap-4 pt-2" : "flex h-full"}>
        {lanes.map(l => {
          const records = scoped.filter(t => boardLane(t) === l.id).sort((a, b) => b.updatedAt - a.updatedAt);
          return <section key={l.id} aria-label={`${l.label}任务`} aria-hidden={!desktop && lane !== l.id ? true : undefined} ref={node => { if (node) node.inert = !desktop && lane !== l.id; }} style={desktop ? undefined : { width: '100%' }} className={desktop ? "min-w-0 px-1" : "h-full min-w-0 shrink-0 snap-start snap-always overflow-y-auto overscroll-y-contain px-1 pb-3 pt-2"}>
            <div className="space-y-2">{records.map(task => {
              const row = rowById.get(task.id)!;
              const actionable = row.attention ?? task;
              const attempt = actionable.attempts.find(a => a.id === actionable.activeAttemptId);
              const question = actionable.decisions.find(d => d.status === 'pending');
              const stage = collaborationTaskStage(actionable);
              const displayStage = collaborationBoardStatus(actionable, row.children);
              const blockers = collaborationTaskBlockers(actionable);
              const blocker = blockers[0];
              const systemBlocker = blockers.find(entry => entry.source === 'system');
              const unknownRecord = blockers.find(entry => entry.source === 'unknown');
              const issue = systemBlocker?.content;
              const attention = l.id === 'attention';
              const actionLabel = question ? '回答问题' : unknownRecord ? '查看详情核对记录' : blocker?.source === 'member' && systemBlocker ? '查看条件与异常处理' : blocker?.source === 'member' ? '查看阻塞并补充条件' : issue ? '查看原因与处理' : stage === '等待你验收' ? '查看结果并验收' : stage === '需要你确认方案' ? '查看并确认方案' : '查看任务并处理';
              const result = actionable.artifacts.filter(a => a.kind === 'result' && a.attemptId === actionable.activeAttemptId).at(-1);
              const followup = actionable.events.filter(e => e.kind === 'revise' && e.source === 'user' && e.attemptId === actionable.activeAttemptId && (!result || e.createdAt >= result.createdAt)).at(-1);
              const preview = question ? question.question || '成员提出了一个问题，打开后可查看并回答。' : blocker?.summary || followup?.content || (result?.summary || (attempt?.report?.content ? collaborationResultPresentation(attempt.report.content).summary : attempt?.report?.summary || ''));
              const parent = tasks.find(t => t.id === task.parentTaskId);
              return <article key={task.id} aria-label={task.title} className={`overflow-hidden rounded-xl border bg-surface text-left shadow-sm ${selectedId === task.id ? 'border-primary/60' : issue ? 'border-destructive/35' : 'border-border/20'}`}>
              <button type="button" data-task-id={task.id} aria-pressed={selectedId === task.id} className="block w-full rounded-xl p-4 text-left transition hover:bg-surface-2/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" onClick={() => onSelect(actionable.id)}>
                {parent && <span className="mb-2 block truncate text-[10px] text-muted-foreground">{parent.title}</span>}
                <span title={task.title} className="block line-clamp-3 break-words text-sm font-medium leading-6 text-foreground">{task.title}</span>
                <span className={`mt-3 flex items-center gap-1.5 text-xs ${issue && blocker?.source !== 'member' ? 'text-destructive' : attention ? 'text-primary' : 'text-muted-foreground'}`}>{issue && blocker?.source !== 'member' && <AlertTriangle size={13} className="shrink-0" />}{displayStage}</span>
                {row.attention && <span className="mt-2 block truncate text-[11px] text-muted-foreground">来自执行任务：{row.attention.title}</span>}
                {row.attention && row.attentionCount > 1 && <span className="mt-1 block text-[11px] text-primary">共 {row.attentionCount} 项执行需要你处理</span>}
                {preview && <span className="mt-2 line-clamp-3 break-words text-xs leading-5 text-foreground/80">{preview}</span>}
                {systemBlocker && blocker?.source === 'member' && <span className="mt-2 block line-clamp-2 break-words text-xs leading-5 text-destructive">{systemBlocker.label}：{systemBlocker.summary}</span>}
                {unknownRecord && <span className="mt-2 block line-clamp-2 break-words text-xs leading-5 text-muted-foreground">{unknownRecord.label}：{unknownRecord.summary}</span>}
                {attention && <span className={`mt-4 flex min-h-9 items-center justify-between rounded-lg px-2.5 text-xs font-medium ${issue ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'}`}>{actionLabel}<ArrowUpRight size={14} /></span>}
                {!attention && (task.status === 'accepted' || task.artifacts.some(a => a.kind === 'result' && a.attemptId === task.activeAttemptId)) && <span className="mt-3 flex min-h-9 items-center justify-between text-xs font-medium text-primary">{followup ? "查看跟进" : "查看结果"}<ArrowUpRight size={14} /></span>}
              </button>
              <CollaborationExecutionPreview task={task} children={row.children} onSelect={onSelect} />
              <div className="mx-4 border-t border-border/10 py-3 text-[11px] text-muted-foreground"><span className="block truncate">{row.attention ? '待处理任务负责人：' : task.workflow?.kind === 'goal' ? '协调者：' : '负责人：'}{attempt ? name(actionable, attempt.assignee) : actionable.scheduledAssignee ? name(actionable, actionable.scheduledAssignee) : '未分派'}</span><CollaborationReportMeta task={actionable} now={now} compact /></div>
              </article>;
            })}{!records.length && <p className="px-2 py-3 text-xs leading-6 text-muted-foreground/70">{query || scope !== 'all' ? '没有匹配的任务' : tasks.length ? '暂无任务' : l.hint}</p>}</div>
          </section>;
        })}
      </div>
    </div>
  </div>;
}
