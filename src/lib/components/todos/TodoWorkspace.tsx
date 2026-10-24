import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Inbox, PanelLeft, Pencil, Plus, Search, Settings2, Sparkles, Trash2, X } from 'lucide-react';
import { getAgentLaunchers, getSettings, type AgentLauncherInfo } from '../../terminal/api';
import { getSessionDirectorySnapshot, useSessionDirectory } from '../../stores/useSessionDirectory';
import { getSessionPresentation } from '../../terminal/display';
import { collectTodos, releaseTodoClaim, createTodo, listTodos, removeTodoCollector, saveTodoCollector, handoffTodos, updateTodo, type TodoCollector, type TodoItem, type TodoLaunchConfig, type TodoRun, type TodoSnapshot } from '../../todos/api';
import { emptyTodoView, latestTodoRun, matchesTodo, useTodoWorkspace, type TodoModal } from '../../todos/workspace';
import { useCollaborationNavigation } from '../../stores/useCollaborationNavigation';
import { savedConnection, SECURE_STATE_EVENT } from '../../federation/browserIntegration';
import { SECURE_READY_EVENT } from '../../federation/connectionRecovery';
import { startVisiblePolling } from '../sidebar/startVisiblePolling';
import { readNewSessionAgentPreference } from '../../hooks/useNewSessionAgentPreference';
import { getAgentLaunchCommand, hasAgentCommandSelection } from '../../terminal/launchCommands';
import { readTodoPreferences, rememberTodoChoice, todoDirectoryChoices, uniqueDirectories } from '../../todos/preferences';
import { CollectorEditor, IntegrationHelp, TodoDialog, TodoEditor, resolveTodoConfig, todoGhost as ghost, todoPrimary as primary, todoSecondary as secondary } from './TodoForms';
import { TodoRunCard, todoRunLabel } from './TodoRunCard';
import { TodoItemCard } from './TodoItemCard';
import { TodoHandoff, rememberTodoRecipient } from './TodoHandoff';
import { TodoMoreMenu, type TodoMenuItem } from './TodoMoreMenu';
import { chooseTodoRecipient } from './TodoSessionDropTarget';

const blankConfig: TodoLaunchConfig = { agentSlug: '', command: '', cwd: '', prompt: '' };
export default function TodoWorkspace({ onOpenSidebar, leftSidebarVisible, activeSessionId }: { onOpenSidebar: () => void; leftSidebarVisible: boolean; activeSessionId?: string | null }) {
  const directory = useSessionDirectory();
  const [workspace] = useState(() => savedConnection()?.targetPeerId ?? location.origin);
  const view = useTodoWorkspace(state => state.views[workspace] ?? emptyTodoView);
  const patch = (update: Partial<typeof view>) => useTodoWorkspace.getState().patch(workspace, update);
  const [data, setData] = useState<TodoSnapshot | null>(() => useTodoWorkspace.getState().snapshots[workspace] ?? null);
  const [options, setOptions] = useState(() => useTodoWorkspace.getState().options[workspace] ?? { agents: [] as AgentLauncherInfo[], preferred: null as string | null, cwd: '', directories: [] as string[] });
  const [agentsLoading, setAgentsLoading] = useState(!useTodoWorkspace.getState().options[workspace]);
  const [loadError, setLoadError] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<{ todo: TodoItem; previous: TodoItem['status'] } | null>(null);
  const root = useRef<HTMLElement>(null), [width, setWidth] = useState(0);
  const wide = width >= 900, mounted = useRef(true), pending = useRef(false), fetching = useRef(false), version = useRef(0);
  const target = useRef(savedConnection()?.targetPeerId);
  const current = () => mounted.current && target.current === savedConnection()?.targetPeerId;
  const refresh = useCallback(async (force = false) => {
    if (fetching.current && !force) return;
    fetching.current = true; const request = ++version.current, service = savedConnection()?.targetPeerId;
    try {
      const result = await listTodos();
      if (mounted.current && request === version.current && service === savedConnection()?.targetPeerId) {
        setData(result); useTodoWorkspace.getState().cache(workspace, result); setLoadError('');
      }
    } catch (cause) { if (mounted.current && service === savedConnection()?.targetPeerId) setLoadError(cause instanceof Error ? cause.message : '待办加载失败'); }
    finally { if (request === version.current) fetching.current = false; }
  }, [workspace]);
  const loadOptions = useCallback(async () => {
    const service = savedConnection()?.targetPeerId;
    setAgentsLoading(true);
    const [agents, settings] = await Promise.allSettled([getAgentLaunchers(), getSettings()]);
    if (!mounted.current || savedConnection()?.targetPeerId !== service) return;
    const previous = useTodoWorkspace.getState().options[workspace];
    const sessions = getSessionDirectorySnapshot().slice().sort((a, b) => b.lastActivity - a.lastActivity);
    const next = { agents: agents.status === 'fulfilled' ? agents.value : previous?.agents ?? [], preferred: settings.status === 'fulfilled' ? settings.value.newSessionAgentSlug : previous?.preferred ?? readNewSessionAgentPreference()?.slug ?? null,
      cwd: sessions.find(s => s.sessionId === activeSessionId)?.cwd ?? previous?.cwd ?? sessions[0]?.cwd ?? '', directories: uniqueDirectories(sessions.map(s => s.cwd).concat(previous?.directories ?? [])) };
    setOptions(next); useTodoWorkspace.getState().cacheOptions(workspace, next); setAgentsLoading(false);
    if (agents.status === 'rejected') setError('会话选项加载失败，打开交接面板可重试。');
  }, [workspace, activeSessionId]);
  useEffect(() => {
    mounted.current = true;
    const node = root.current;
    const measure = () => setWidth(node?.clientWidth ?? 0);
    measure(); const observer = new ResizeObserver(measure); if (node) observer.observe(node);
    void loadOptions();
    const changed = () => { if (target.current !== savedConnection()?.targetPeerId) useCollaborationNavigation.getState().terminal(); };
    window.addEventListener(SECURE_STATE_EVENT, changed);
    window.addEventListener(SECURE_READY_EVENT, loadOptions);
    const stop = startVisiblePolling(() => { if (navigator.onLine !== false) void refresh(); }, 1200, [SECURE_READY_EVENT]);
    return () => { mounted.current = false; observer.disconnect(); stop(); window.removeEventListener(SECURE_STATE_EVENT, changed); window.removeEventListener(SECURE_READY_EVENT, loadOptions); };
  }, [refresh, loadOptions]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => { setNotice(''); setUndo(null); }, 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => () => {
    const state = useTodoWorkspace.getState();
    if (state.views[workspace]?.modal?.kind === 'recipient') state.patch(workspace, { modal: null });
  }, [workspace]);
  const key = (payload: unknown) => useTodoWorkspace.getState().requestKey(workspace, payload);
  const finish = (payload: unknown) => useTodoWorkspace.getState().finishRequest(workspace, payload);
  const clearDraft = (id: string) => useTodoWorkspace.getState().clearDraft(workspace, id);
  const modal = view.modal;
  const show = (modal: TodoModal) => { setError(''); patch({ modal }); };
  const act = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice(''); setUndo(null);
    try { await action(); if (current()) { await refresh(true); window.dispatchEvent(new Event('termdock:todos-changed')); } }
    catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : '操作失败，请重试'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const select = (todo: TodoItem) => patch({ selectedId: view.selectedId === todo.id ? null : todo.id, mobileDetail: false });
  const openSession = (run: TodoRun, todo?: TodoItem) => void act(async () => {
    if (!current()) return;
    if (!getSessionDirectorySnapshot().some(s => s.sessionId === run.sessionId)) {
      if (todo && todo.status !== 'open') throw new Error('原会话已关闭；如需再次处理，请先重新打开待办。');
      if (run.kind === 'execute' && run.todoId) { requestHandoff(run.handoff?.todoIds ?? [run.todoId]); setNotice('原会话已关闭，请重新选择会话。'); return; }
      throw new Error('收集会话已关闭，可以重新发起收集。');
    }
    patch({ modal: null }); window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: run.sessionId }));
  });
  const configForTodo = (id: string, base: TodoLaunchConfig) => {
    const collectorId = data?.todos.find(todo => todo.id === id)?.collectorId;
    const collector = data?.collectors.find(collector => collector.id === collectorId);
    return collector ? { ...base, cwd: collector.config.cwd } : base;
  };
  const requestHandoff = (ids: string[], sessionId?: string) => {
    void loadOptions();
    show(sessionId ? { kind: 'handoff', ids, sessionId } : { kind: 'recipient', ids });
    if (!sessionId && !leftSidebarVisible) onOpenSidebar();
    if (ids.length === 1) patch({ selecting: false, checked: [] });
  };
  const sendHandoff = async (ids: string[], value: { sessionId?: string; config?: TodoLaunchConfig; note: string }) => {
    const payload = ['handoff', ids, value];
    let run = (await handoffTodos({ todoIds: ids, ...value, idempotencyKey: key(payload) })).run;
    for (let attempt = 0; run.status === 'launching' && attempt < 180; attempt++) {
      if (!current()) return;
      await new Promise(resolve => window.setTimeout(resolve, 500));
      const snapshot = await listTodos(); if (!current()) return;
      run = snapshot.runs.find(item => item.id === run.id) ?? run;
    }
    if (!current()) return;
    if (run.status === 'failed') { finish(payload); throw new Error(run.error || '发送失败，请检查会话后重试'); }
    if (run.status === 'launching' || !run.sessionId) throw new Error('仍在确认发送，请稍后重试；同一次请求不会重复发送。');
    finish(payload); clearDraft(`handoff:${JSON.stringify(ids.slice().sort())}`);
    rememberTodoRecipient(workspace, run.sessionId);
    if (value.config) rememberTodoChoice(workspace, value.config);
    patch({ modal: null, selecting: false, checked: [] });
    window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: run.sessionId }));
  };
  const collect = async (collectors: TodoCollector[]) => {
    const results = await Promise.allSettled(collectors.map(c => collectTodos(c.id, key(['collect', c.id, c.config]))));
    if (!current()) return;
    let succeeded = 0; const failures: string[] = [];
    results.forEach((r, i) => { const c = collectors[i]; if (r.status === 'fulfilled') { succeeded++; finish(['collect', c.id, c.config]); } else failures.push(`${c.name}：${r.reason instanceof Error ? r.reason.message : String(r.reason)}`); });
    patch({ modal: null }); if (succeeded) setNotice(`已发起 ${succeeded} 个收集任务`);
    if (failures.length) throw new Error(failures.join('；'));
  };
  const status = (todo: TodoItem, next: TodoItem['status']) => void act(async () => {
    const result = await updateTodo(todo, { status: next });
    if (!current()) return;
    if (next !== 'open') {
      setUndo({ todo: result.todo, previous: todo.status });
      if (view.selectedId === todo.id) patch({ selectedId: null, mobileDetail: false });
    }
    setNotice(next === 'completed' ? '已完成' : next === 'ignored' ? '已忽略' : '已重新打开');
  });
  const sessionNameFor = (run: TodoRun) => directory.find(session => session.sessionId === run.sessionId)?.displayName
    ?? getSessionPresentation({ name: run.handoff?.sessionName || '', agent: { displayName: run.config.agentSlug || '会话' } }).displayName;
  const visible = data?.todos.filter(todo => matchesTodo(data, todo, view.filter)
    && (!view.source || todo.source === view.source)
    && `${todo.title} ${todo.description} ${todo.source}`.toLowerCase().includes(view.query.toLowerCase())) ?? [];
  const canBatch = (todo: TodoItem) => {
    const run = data && latestTodoRun(data, todo.id);
    return todo.status === 'open' && run?.status !== 'launching';
  };
  const checked = visible.filter(todo => view.checked.includes(todo.id) && canBatch(todo));
  const enabledCollectors = data?.collectors.filter(collector => collector.enabled) ?? [];
  const preferences = readTodoPreferences(workspace);
  const recentCollection = data?.collectors.slice().sort((a, b) => b.updatedAt - a.updatedAt)
    .find(collector => options.agents.some(agent => agent.slug === collector.config.agentSlug))?.config;
  const lastChoice = preferences.choice && options.agents.some(agent => agent.slug === preferences.choice?.agentSlug)
    ? preferences.choice : recentCollection ? { agentSlug: recentCollection.agentSlug, command: recentCollection.command, cwd: recentCollection.cwd } : undefined;
  const recentAgent = options.agents.find(agent => agent.slug === lastChoice?.agentSlug);
  const inheritedChoice = lastChoice && recentAgent && hasAgentCommandSelection(recentAgent.slug)
    ? { ...lastChoice, command: getAgentLaunchCommand(recentAgent.slug, recentAgent.command) } : lastChoice;
  const config = resolveTodoConfig(data?.defaults.agentSlug ? data.defaults : { ...blankConfig, ...inheritedChoice }, options.agents, options.preferred, options.cwd);
  const collectionConfig = inheritedChoice ? { ...blankConfig, ...inheritedChoice } : config;
  const directories = todoDirectoryChoices(options.cwd, options.directories ?? [], data, workspace);
  const service = savedConnection()?.serviceName || '当前服务';
  const collector = modal?.kind === 'collector' ? data?.collectors.find(item => item.id === modal.id) : undefined;
  const edit = modal?.kind === 'edit' ? modal.todo : undefined;
  const modalTitle = modal?.kind === 'edit' ? edit ? '编辑待办' : '新增待办' : modal?.kind === 'handoff'
    ? '交给会话' : modal?.kind === 'collector'
    ? collector ? '编辑收集方向' : '添加收集方向' : '外部接入';
  const toolsVisible = view.toolsOpen || view.filter !== 'all' || !!view.query || !!view.source;
  const backToList = () => patch({ tab: 'todos', mobileDetail: false, selecting: false, checked: [] });
  const columns = view.filter === 'all' ? ['open', 'completed'] as const : [view.filter === 'completed' ? 'completed' : view.filter === 'ignored' ? 'ignored' : 'open'] as const;
  const shownColumns = view.selecting ? ['open'] : !wide && view.filter === 'all' ? [view.column ?? 'open'] : columns;
  const columnLabel = (column: string) => column === 'completed' ? '已完成' : column === 'ignored' ? '已忽略' : '待完成';
  const renderHandoff = () => modal?.kind === 'handoff' && <TodoHandoff key={JSON.stringify([modal.ids, modal.sessionId])} initialSessionId={modal.sessionId} workspace={workspace} ids={modal.ids} config={configForTodo(modal.ids[0], collectionConfig)} agents={options.agents} sessions={directory} directories={directories} busy={busy} loading={agentsLoading} title={data?.todos.find(todo => todo.id === modal.ids[0])?.title ?? ''} onCancel={() => show(null)} onChangeRecipient={() => requestHandoff(modal.ids)} onSend={value => void act(() => sendHandoff(modal.ids, value))} />;
  const workspaceActions: TodoMenuItem[] = [
    { label: '搜索和筛选', action: () => {
      patch({ toolsOpen: true });
      window.setTimeout(() => { if (current()) root.current?.querySelector<HTMLInputElement>('[aria-label="搜索待办"]')?.focus(); }, 0);
    } },
    { label: '多选待办', action: () => patch({ selecting: true, column: 'open', mobileDetail: false, checked: [] }), disabled: !visible.some(canBatch) },
    { label: '已忽略', action: () => patch({ filter: 'ignored', mobileDetail: false, checked: [] }) },
    { label: '外部接入', action: () => show({ kind: 'integration' }) },
  ];
  const manageCollectors = () => patch({ tab: 'collectors', mobileDetail: false });
  const collectionPending = data?.collectors.filter(item => {
    const run = data.runs.filter(run => run.collectorId === item.id).at(-1);
    return run && (run.status === 'launching' || run.status === 'delivered');
  }).length ?? 0;
  return <section ref={root} aria-label="待办工作区" className="absolute inset-0 flex min-h-0 min-w-0 flex-col bg-[var(--chrome-bg)] text-foreground">
    <header data-termdock-window-header="true" className="relative z-20 flex min-h-16 shrink-0 items-center gap-1 border-b border-border/30 px-3 sm:gap-2 sm:px-5">
      {view.tab === 'collectors' ? <>
        <button type="button" className={ghost} aria-label="返回清单" onClick={backToList}><ArrowLeft size={18} /></button>
        <h1 className="min-w-0 flex-1 text-base font-semibold">收集方向</h1>
        <button type="button" className={ghost} aria-label="添加方向" title="添加方向" disabled={!data} onClick={() => show({ kind: 'collector' })}><Plus size={20} /><span className="hidden sm:inline">添加方向</span></button>
      </> : view.selecting ? <>
        <button type="button" className={ghost} onClick={() => patch({ selecting: false, checked: [] })}>取消</button>
        <h1 className="min-w-0 flex-1 text-sm">已选 {checked.length} 项</h1>
        <button type="button" className={primary} disabled={busy || !checked.length} onClick={() => requestHandoff(checked.map(todo => todo.id))}>交给会话</button>
      </> : <>
        {!leftSidebarVisible && <button type="button" className={`${ghost} hidden sm:inline-flex`} aria-label="打开会话侧栏" onClick={onOpenSidebar}><PanelLeft size={18} /></button>}
        <button type="button" className={`${ghost} px-2`} aria-label="返回终端" title="返回终端" onClick={() => useCollaborationNavigation.getState().terminal()}><ArrowLeft size={18} /></button>
        <h1 className="min-w-0 flex-1 text-base font-semibold">待办{data && <span className="ml-2 text-xs font-normal tabular-nums text-muted-foreground">{data.todos.filter(todo => todo.status === 'open').length}</span>}</h1>
        <button type="button" className={`${ghost} px-2`} aria-label="管理收集方向" title="管理收集方向" disabled={!data || busy} onClick={manageCollectors}><Settings2 size={16} /><span>管理</span></button>
        <button type="button" className={`${ghost} px-2`} aria-label="新增待办" title="新增待办" disabled={!data} onClick={() => show({ kind: 'edit' })}><Plus size={21} /></button>
        <TodoMoreMenu label="待办菜单" items={workspaceActions} disabled={!data || busy} />
      </>}
    </header>
    {(loadError || error && !modal) && <div role="alert" className="flex shrink-0 items-start gap-3 border-b border-border/30 px-5 py-3 text-sm text-destructive"><span className="min-w-0 flex-1 break-words">{error || loadError}</span>{loadError && <button type="button" className="shrink-0 underline" onClick={() => void refresh(true)}>重试</button>}<button type="button" aria-label="关闭提示" onClick={() => { setError(''); setLoadError(''); }}>×</button></div>}
    {notice && <div role="status" className="fixed bottom-[max(1.5rem,env(safe-area-inset-bottom,0px))] left-1/2 z-toast flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-4 rounded-xl border border-border bg-surface-elevated px-4 py-3 text-sm shadow-lg"><span className="min-w-0 break-words">{notice}</span>{undo && <button type="button" className="min-h-9 shrink-0 text-primary" onClick={() => void act(async () => { await updateTodo(undo.todo, { status: undo.previous }); if (current()) setNotice('已撤销'); })}>撤销</button>}</div>}
    {!data ? <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{loadError ? '加载失败，请重试' : '正在加载待办…'}</div> : view.tab === 'collectors' ? <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><p className="text-sm leading-6 text-muted-foreground">按方向发起收集、编辑或删除。</p>{enabledCollectors.length > 1 && <button type="button" className={secondary} disabled={busy} onClick={() => void act(() => collect(enabledCollectors))}>全部收集</button>}</div>
      {!data.collectors.length ? <Empty title="让 Agent 帮你发现下一件事" text="添加一个收集方向，写下关注的内容和筛选要求。" /> : <div className={`grid items-start gap-4 ${wide ? 'grid-cols-2' : ''}`}>{data.collectors.map(item => <CollectorCard key={item.id} collector={item} runs={data.runs.filter(run => run.collectorId === item.id)} busy={busy} onRun={() => void act(() => collect([item]))} onEdit={() => show({ kind: 'collector', id: item.id })} onOpen={openSession} onRemove={() => void act(async () => { await removeTodoCollector(item); })} />)}</div>}
    </div> : <div className="flex min-h-0 flex-1 flex-col">
      {toolsVisible && <div aria-label="搜索和筛选" className="shrink-0 space-y-2 border-b border-border/30 px-4 py-3">
        <div className="flex items-center gap-2"><div className="relative min-w-0 flex-1"><Search size={15} className="pointer-events-none absolute left-3 top-3.5 text-muted-foreground" /><input autoFocus={view.toolsOpen} aria-label="搜索待办" className="min-h-11 w-full min-w-0 rounded-lg bg-surface-2 py-2 pl-9 pr-3 text-base outline-none focus:ring-1 focus:ring-primary sm:text-sm" placeholder="搜索待办" value={view.query} onChange={event => patch({ query: event.target.value })} /></div><button type="button" className={ghost} aria-label="清除筛选" onClick={() => patch({ query: '', source: '', filter: 'all', toolsOpen: false, checked: [] })}><X size={17} /></button></div>
        <div className="flex gap-2"><select aria-label="待办状态" className="min-h-11 min-w-0 flex-1 rounded-lg bg-surface-2 px-3 text-base sm:text-sm" value={view.filter} onChange={event => patch({ filter: event.target.value as typeof view.filter, checked: [] })}><option value="all">全部待办</option><option value="open">待完成</option><option value="completed">已完成</option><option value="ignored">已忽略</option></select>
          <select aria-label="按来源筛选" className="min-h-11 min-w-0 flex-1 rounded-lg bg-surface-2 px-3 text-base sm:text-sm" value={view.source} onChange={event => patch({ source: event.target.value, checked: [] })}><option value="">全部来源</option>{[...new Set(data.todos.map(todo => todo.source))].map(source => <option key={source}>{source}</option>)}</select></div>
      </div>}
      {!!directory.filter(session => session.collectionRunId).length && <details className="shrink-0 border-b border-border/20 px-5 text-sm text-muted-foreground"><summary className="min-h-11 cursor-pointer py-3">收集会话 · {directory.filter(session => session.collectionRunId).length}</summary><div className="max-h-48 space-y-1 overflow-y-auto pb-3">{directory.filter(session => session.collectionRunId).map(session => <button key={session.sessionId} type="button" className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left hover:bg-surface-2" onClick={() => { window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: session.sessionId })); useCollaborationNavigation.getState().terminal(); }}><span className="min-w-0 flex-1 truncate">{session.displayName}<span className="ml-2 text-xs">{session.displaySubtitle}</span></span><span className="shrink-0 text-xs text-primary">打开终端</span></button>)}</div></details>}
      {!!collectionPending && <button type="button" className="flex min-h-11 shrink-0 items-center justify-between gap-3 px-5 text-left text-xs text-muted-foreground hover:bg-surface" onClick={manageCollectors}><span>已发起 {collectionPending} 个收集任务</span><span className="text-primary">查看</span></button>}
      {!wide && view.filter === 'all' && !view.selecting && <div role="tablist" aria-label="待办分类" className="flex shrink-0 gap-1 border-b border-border/30 px-4 pt-1">
        {(['open', 'completed'] as const).map(column => <button key={column} type="button" role="tab" aria-selected={(view.column ?? 'open') === column} className={`min-h-12 flex-1 border-b-2 px-3 text-sm ${ (view.column ?? 'open') === column ? 'border-primary text-primary' : 'border-transparent text-muted-foreground'}`} onClick={() => patch({ column })}>{columnLabel(column)} <span className="ml-1 text-xs tabular-nums">{visible.filter(todo => todo.status === column).length}</span></button>)}
      </div>}
      {!visible.length && (view.query || view.source) ? <Empty title="没有匹配的待办" text="换个关键词，或清除筛选。" /> : <div className={`grid min-h-0 flex-1 gap-4 px-4 pb-5 sm:px-5 ${shownColumns.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {shownColumns.map(column => {
          const todos = visible.filter(todo => todo.status === column);
          return <section key={column} aria-label={`${columnLabel(column)}列表`} className="flex min-h-0 min-w-0 flex-col">
            {(wide || view.filter !== 'all' || view.selecting) && <h2 className="flex min-h-14 shrink-0 items-center gap-2 text-sm font-medium">{columnLabel(column)}<span className="text-xs tabular-nums text-muted-foreground">{todos.length}</span></h2>}
            <div className={`min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pb-6 ${!wide && view.filter === 'all' && !view.selecting ? 'pt-4' : ''}`}>
              {!todos.length ? <Empty title={column === 'completed' ? '还没有已完成的待办' : column === 'ignored' ? '没有已忽略的待办' : data.todos.length ? '待完成已清空' : '还没有待办'} text={column === 'completed' ? '完成的事项会放在这里。' : column === 'ignored' ? '忽略的事项会保留，可重新打开。' : '点 + 记下一件事，或让 Agent 帮你收集。'} /> : todos.map(todo => {
                const runs = data.runs.filter(run => run.todoId === todo.id || run.handoff?.todoIds.includes(todo.id));
                const run = runs.at(-1);
                return <TodoItemCard key={todo.id} todo={todo} runs={runs} workspace={workspace} sessionName={run ? sessionNameFor(run) : undefined} busy={busy}
                  expanded={view.selectedId === todo.id} selecting={view.selecting} checked={view.checked.includes(todo.id)} canSelect={canBatch(todo)} handoff={modal?.kind === 'recipient' && modal.ids.includes(todo.id) ? <div role="group" aria-label={`选择接收会话 ${todo.title}`} className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 text-xs text-primary">正在选择会话…</span><button type="button" className={ghost} disabled={busy} onClick={() => chooseTodoRecipient(workspace, modal.ids, '__new__')}>新建会话</button><button type="button" className={ghost} disabled={busy} onClick={() => show(null)}>取消</button></div> : undefined}
                  onReleaseClaim={() => void act(async () => { await releaseTodoClaim(todo); })} onToggle={() => select(todo)} onCheck={checked => patch({ checked: checked ? [...view.checked, todo.id] : view.checked.filter(id => id !== todo.id) })}
                  onHandoff={() => requestHandoff([todo.id])} onOpen={run => openSession(run, todo)} onStatus={next => status(todo, next)} onEdit={() => show({ kind: 'edit', todo })} />;
              })}
            </div>
          </section>;
        })}
      </div>}
    </div>}
    {modal && modal.kind !== 'recipient' && <TodoDialog compact={modal.kind === 'handoff'} title={modalTitle} busy={busy} error={error} onClose={() => show(null)}>
      {modal.kind === 'edit' && <TodoEditor workspace={workspace} todo={edit} busy={busy} onCancel={() => show(null)} onSave={(input, start) => void act(async () => {
        const result = edit ? await updateTodo(edit, input) : await createTodo({ ...input, idempotencyKey: key(['create', input]) });
        if (!current()) return; finish(['create', input]); clearDraft(`todo:${edit?.id ?? 'new'}`);
        patch({ tab: 'todos', selecting: false, checked: [], filter: 'all', column: 'open', source: '', query: '', selectedId: result.todo.id, mobileDetail: false, modal: start ? { kind: 'recipient', ids: [result.todo.id] } : null });
        if (start && !leftSidebarVisible) onOpenSidebar();
        if (!start) setNotice('待办已保存。');
      })} />}
      {modal.kind === 'handoff' && renderHandoff()}
      {modal.kind === 'collector' && <CollectorEditor workspace={workspace} collector={collector} config={collectionConfig} agents={options.agents} loading={agentsLoading} service={service} directories={directories} currentCwd={options.cwd} busy={busy} onCancel={() => show(null)} onSave={(input, start) => void act(async () => {
        const result = await saveTodoCollector(input); if (!current()) return;
        rememberTodoChoice(workspace, input.config);
        clearDraft(`collector:${collector?.id ?? 'new'}`); patch({ tab: start && view.tab !== 'collectors' ? 'todos' : 'collectors', modal: null });
        if (start) await collect([result.collector]); else setNotice('收集方向已保存，可以随时开始。');
      })} />}
      {modal.kind === 'integration' && <IntegrationHelp />}
    </TodoDialog>}
  </section>;
}
function Empty({ title, text }: { title: string; text: string }) { return <div className="mx-auto flex max-w-sm flex-col items-center px-6 py-12 text-center"><Inbox size={30} strokeWidth={1.2} className="mb-4 text-muted-foreground/50" /><h2 className="text-base font-medium">{title}</h2><p className="mt-2 text-sm leading-7 text-muted-foreground">{text}</p></div>; }
function CollectorCard({ collector: c, runs, busy, onRun, onEdit, onRemove, onOpen }: { collector: TodoCollector; runs: TodoRun[]; busy: boolean; onRun: () => void; onEdit: () => void; onRemove: () => void; onOpen: (run: TodoRun) => void }) {
  const [removing, setRemoving] = useState(false), latest = runs.at(-1);
  return <article className="rounded-xl border border-border/30 bg-surface p-4 sm:p-5">
    <div className="flex items-center gap-2"><h2 className="min-w-0 flex-1 break-words text-base font-semibold">{c.name}</h2><button type="button" className={ghost} aria-label={`编辑 ${c.name}`} disabled={busy} onClick={onEdit}><Pencil size={16} /></button><button type="button" className={ghost} aria-label={`删除 ${c.name}`} title="删除收集方向" disabled={busy} onClick={() => setRemoving(true)}><Trash2 size={16} /></button></div>
    <p className="mt-1 text-xs leading-6 text-muted-foreground">{c.config.agentSlug} · {!c.enabled ? '已停用' : !c.schedule ? '手动运行' : c.schedule.kind === 'interval' ? `每 ${c.schedule.everyMinutes} 分钟` : `每天 ${c.schedule.time}`}</p>
    <p className="mt-1 text-xs leading-6 text-muted-foreground">{c.session?.mode === 'reuse' ? '复用会话' : '每次新建'} · {c.session?.targetSessionId ? '现有会话不自动回收' : (c.session?.idleMinutes ?? 10) ? `无输出 ${c.session?.idleMinutes ?? 10} 分钟后回收` : '不自动回收'}</p>
    <p className="mt-1 text-xs leading-6 text-muted-foreground">{c.processing?.mode === 'new' ? '新待办自动新建 Agent 处理' : c.processing?.mode === 'existing' ? '新待办自动发送到现有 Agent' : '仅收集，支持按来源领取'}{c.webhook?.enabled ? ' · Webhook' : ''}</p>
    <p className="my-3 line-clamp-3 whitespace-pre-wrap text-sm leading-7 text-muted-foreground">{c.config.prompt}</p>
    {removing ? <div className="rounded-lg bg-surface-2 p-3"><p className="text-sm leading-6">删除此收集方向？已有待办、终端和结果会保留。</p><div className="mt-2 flex justify-end gap-2"><button type="button" className={ghost} onClick={() => setRemoving(false)}>取消</button><button type="button" className={`${secondary} text-destructive`} disabled={busy} onClick={onRemove}>确认删除</button></div></div> : <div className="flex flex-wrap gap-2"><button type="button" className={primary} disabled={busy || latest?.status === 'launching'} onClick={onRun}><Sparkles size={16} />{latest ? '再次收集' : '开始收集'}</button></div>}
    {latest && <>
      <div className="mt-4 flex items-center gap-2 text-xs leading-6 text-muted-foreground"><span className="flex-1">{latest.collectionSession?.recycledAt ? '收集终端已回收' : latest.status === 'complete' ? '已收到收集结果' : todoRunLabel[latest.status]}</span>{latest.sessionId && !latest.collectionSession?.recycledAt && latest.status !== 'complete' && <button type="button" className={ghost} disabled={busy} onClick={() => onOpen(latest)}>打开终端</button>}</div>
      <details className="mt-2 text-sm text-muted-foreground"><summary className="min-h-11 cursor-pointer py-2.5">收集记录 · {runs.length} 次</summary><div className="space-y-3 pt-2">{runs.slice().reverse().map(run => <TodoRunCard key={run.id} run={run} onOpen={() => onOpen(run)} busy={busy} />)}</div></details>
    </>}
  </article>;
}
