import { collaborationUpdatedLabel } from '../../collaboration/taskTime';
import { collaborationResultPresentation } from '../../collaboration/resultPresentation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowUpRight, Circle, CircleCheck, MessageCircle, MoreHorizontal, Play, Search, SlidersHorizontal, X } from 'lucide-react';
import { collaborationTaskNeedsAttention, collaborationTaskStage } from '../../collaboration/taskState';
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
    try { return JSON.parse(localStorage.getItem(`${storage}:board`) ?? 'null') as { lane?: TaskLane; scope?: string; query?: string; closed?: boolean } | null; }
    catch { return null; }
  });
  const [lane, setLane] = useState<TaskLane>(() => lanes.some(l => l.id === initial?.lane) ? initial!.lane! : tasks.some(t => collaborationTaskLane(t) === 'attention') ? 'attention' : tasks.some(t => collaborationTaskLane(t) === 'running') ? 'running' : tasks.some(t => collaborationTaskLane(t) === 'backlog') ? 'backlog' : 'done');
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
    try { localStorage.setItem(`${storage}:board`, JSON.stringify({ lane, scope, query, closed })); } catch { /* Current navigation remains usable in private mode. */ }
  }, [storage, lane, scope, query, closed]);
  const selectedLane = selectedId ? tasks.find(t => t.id === selectedId) : undefined;
  const selectedStage = selectedLane ? collaborationTaskLane(selectedLane) : undefined;
  useEffect(() => { if (selectedStage) selectLane(selectedStage, false); }, [selectedId, selectedStage]);
  const roots = tasks.filter(t => t.workflow?.kind === 'goal');
  const scoped = tasks.filter(t => (closed || t.status !== 'closed')
    && (scope === 'all' || t.id === scope || t.parentTaskId === scope)
    && (!query.trim() || `${t.title} ${t.spec} ${t.attempts.map(a => name(t, a.assignee)).join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  const filterCount = Number(scope !== 'all') + Number(closed);
  const compactButton = 'inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary';
  const searchField = <div className={`relative flex min-w-0 items-center ${desktop ? 'flex-1 max-w-[240px]' : 'w-full'}`}><span className="sr-only">搜索任务</span><Search aria-hidden="true" size={15} className="pointer-events-none absolute left-3 text-muted-foreground" /><input ref={searchInput} aria-label="搜索任务" type="search" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!query) { setSearchOpen(false); requestAnimationFrame(() => (desktop ? searchButton : toolsButton).current?.focus()); } else setQuery(''); } }} placeholder="搜索任务或负责人" className="min-h-11 w-full rounded-lg border border-border/20 bg-transparent pl-9 pr-9 text-xs outline-none focus:border-primary" /><button type="button" aria-label="关闭搜索" className="absolute right-0 flex min-h-11 w-9 items-center justify-center text-muted-foreground" onClick={() => { setQuery(''); setSearchOpen(false); requestAnimationFrame(() => (desktop ? searchButton : toolsButton).current?.focus()); }}><X size={14} /></button></div>;
  const filterPanel = <div aria-label="任务筛选" className="absolute right-0 top-full z-30 mt-1 w-64 space-y-3 rounded-xl border border-border/30 bg-surface p-3 shadow-xl">
          <label className="block space-y-1 text-xs text-muted-foreground"><span>目标范围</span><select aria-label="按目标查看" value={scope} onChange={e => setScope(e.target.value)} className="min-h-11 w-full rounded-lg border border-border/20 bg-surface-2 px-3 text-xs text-foreground"><option value="all">所有目标</option>{roots.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label>
          <label className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={closed} onChange={e => setClosed(e.target.checked)} />含已关闭</label>
          {filterCount > 0 && <button type="button" className="min-h-11 w-full rounded-lg text-xs text-primary hover:bg-surface-2" onClick={() => { setScope('all'); setClosed(false); }}>清除筛选</button>}
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
          <button ref={toolsButton} type="button" aria-label="更多看板操作" aria-expanded={toolsOpen} className={`${compactButton} ${filterCount || query.trim() ? 'text-primary' : ''}`} onClick={() => { setToolsOpen(v => !v); setFiltersOpen(false); }}><MoreHorizontal size={18} />{filterCount > 0 && <span className="text-[10px]">{filterCount}</span>}</button>
          {toolsOpen && <div aria-label="看板更多操作" className="absolute right-0 top-full z-30 mt-1 flex w-48 flex-col rounded-xl border border-border/30 bg-surface p-1 shadow-xl" onClick={() => setToolsOpen(false)}>
            <button ref={searchButton} type="button" aria-label="搜索任务" className={`${compactButton} justify-start px-3`} onClick={() => setSearchOpen(true)}><Search size={16} />搜索任务</button>
            <button ref={filtersButton} type="button" aria-label={filterCount ? `筛选任务，${filterCount} 项已启用` : '筛选任务'} className={`${compactButton} justify-start px-3`} onClick={() => setFiltersOpen(true)}><SlidersHorizontal size={15} />筛选任务{filterCount > 0 && <span className="ml-auto">{filterCount}</span>}</button>
            {settings && <div className="border-t border-border/15 pt-1 [&>button]:w-full [&>button]:justify-start">{settings}</div>}
          </div>}
        </div>
        {searchOpen && searchField}
        {filtersOpen && filterPanel}
      </>}
    </div>
    <nav hidden={desktop} aria-label="看板阶段" className={`${desktop ? "hidden" : "grid"} shrink-0 grid-cols-4 gap-1`}>{lanes.map(l => <button key={l.id} type="button" aria-pressed={lane === l.id} className={`min-h-11 rounded-lg px-1 text-xs ${lane === l.id ? 'bg-surface-2 text-foreground' : 'text-muted-foreground'}`} onClick={() => selectLane(l.id)}>{l.label}<span className="ml-1 tabular-nums">{scoped.filter(t => collaborationTaskLane(t) === l.id).length}</span></button>)}</nav>
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
      {desktop && <div aria-label="看板列标题" className="sticky top-0 z-10 grid min-w-[1000px] grid-cols-4 gap-4 border-b border-border/15 bg-[var(--chrome-bg)] pb-2">{lanes.map(l => { const Icon = l.icon; return <h4 key={l.id} className={`flex items-center gap-2 px-3 py-2 text-[13px] font-medium ${l.id === 'attention' ? 'text-primary' : 'text-muted-foreground'}`}><Icon size={15} />{l.label}<span className="ml-auto tabular-nums text-xs">{scoped.filter(t => collaborationTaskLane(t) === l.id).length}</span></h4>; })}</div>}
      <div className={desktop ? "grid min-h-full min-w-[1000px] grid-cols-4 items-start gap-4 pt-2" : "flex h-full"}>
        {lanes.map(l => {
          const records = scoped.filter(t => collaborationTaskLane(t) === l.id).sort((a, b) => b.updatedAt - a.updatedAt);
          return <section key={l.id} aria-label={`${l.label}任务`} aria-hidden={!desktop && lane !== l.id ? true : undefined} ref={node => { if (node) node.inert = !desktop && lane !== l.id; }} style={desktop ? undefined : { width: '100%' }} className={desktop ? "min-w-0 px-1" : "h-full min-w-0 shrink-0 snap-start snap-always overflow-y-auto overscroll-y-contain px-1 pb-3 pt-2"}>
            <div className="space-y-2">{records.map(task => {
              const attempt = task.attempts.find(a => a.id === task.activeAttemptId);
              const question = task.decisions.find(d => d.status === 'pending');
              const stage = collaborationTaskStage(task);
              const issue = task.status === 'open' ? task.automationIssue : undefined;
              const attention = l.id === 'attention';
              const actionLabel = question ? '回答问题' : issue ? '查看原因与处理' : stage === '等待你验收' ? '查看结果并验收' : stage === '需要你确认方案' ? '查看并确认方案' : '查看任务并处理';
              const result = task.artifacts.filter(a => a.kind === 'result' && a.attemptId === task.activeAttemptId).at(-1);
              const followup = task.events.filter(e => e.kind === 'revise' && e.source === 'user' && e.attemptId === task.activeAttemptId && (!result || e.createdAt >= result.createdAt)).at(-1);
              const preview = question?.question || issue || followup?.content || (result?.summary || (attempt?.report?.content ? collaborationResultPresentation(attempt.report.content).summary : ''));
              const parent = tasks.find(t => t.id === task.parentTaskId);
              const done = task.children?.filter(t => t.status === 'accepted').length ?? 0;
              const total = task.children?.filter(t => t.status !== 'closed').length ?? 0;
              return <button type="button" key={task.id} data-task-id={task.id} aria-pressed={selectedId === task.id} className={`block w-full rounded-xl border bg-surface p-4 text-left shadow-sm transition hover:border-primary/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${selectedId === task.id ? 'border-primary/60' : issue ? 'border-destructive/35' : 'border-border/20'}`} onClick={() => onSelect(task.id)}>
                {parent && <span className="mb-2 block truncate text-[10px] text-muted-foreground">{parent.title}</span>}
                <span className="block break-words text-sm font-medium leading-6 text-foreground">{task.title}</span>
                <span className={`mt-3 flex items-center gap-1.5 text-xs ${issue ? 'text-destructive' : attention ? 'text-primary' : 'text-muted-foreground'}`}>{issue && <AlertTriangle size={13} className="shrink-0" />}{stage}</span>
                {preview && <span className="mt-2 line-clamp-3 break-words text-xs leading-5 text-foreground/80">{preview}</span>}
                {attention && <span className={`mt-4 flex min-h-9 items-center justify-between rounded-lg px-2.5 text-xs font-medium ${issue ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'}`}>{actionLabel}<ArrowUpRight size={14} /></span>}
                {total > 0 && <span className="mt-3 block text-[11px] text-muted-foreground">{done}/{total} 子任务已验收</span>}
                <span className="mt-4 flex items-center justify-between gap-2 border-t border-border/10 pt-3 text-[11px] text-muted-foreground"><span className="truncate">{attempt ? name(task, attempt.assignee) : task.scheduledAssignee ? name(task, task.scheduledAssignee) : '未分派'}</span><time dateTime={new Date(task.updatedAt).toISOString()} title={`更新于 ${new Date(task.updatedAt).toLocaleString()}`} className="shrink-0">{collaborationUpdatedLabel(task.updatedAt, now)}</time></span>
              </button>;
            })}{!records.length && <p className="px-2 py-3 text-xs leading-6 text-muted-foreground/70">{query || scope !== 'all' ? '没有匹配的任务' : tasks.length ? '暂无任务' : l.hint}</p>}</div>
          </section>;
        })}
      </div>
    </div>
  </div>;
}
