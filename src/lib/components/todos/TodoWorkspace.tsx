import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, Circle, Inbox, PanelLeft, Pencil, Plus, Search, Sparkles, Trash2, X } from 'lucide-react';
import { getAgentLaunchers, getSessionInventory, getSettings, type AgentLauncherInfo } from '../../terminal/api';
import { collectTodos, createTodo, listTodos, removeTodoCollector, saveTodoCollector, saveTodoDefaults, startTodo, updateTodo, type TodoCollector, type TodoItem, type TodoLaunchConfig, type TodoRun, type TodoSnapshot } from '../../todos/api';
import { emptyTodoView, latestTodoRun, launchDraftId, matchesTodo, useTodoWorkspace, type TodoModal } from '../../todos/workspace';
import { useCollaborationNavigation } from '../../stores/useCollaborationNavigation';
import { savedConnection, SECURE_STATE_EVENT } from '../../federation/browserIntegration';
import { SECURE_READY_EVENT } from '../../federation/connectionRecovery';
import { startVisiblePolling } from '../sidebar/startVisiblePolling';
import { readNewSessionAgentPreference } from '../../hooks/useNewSessionAgentPreference';
import { getAgentLaunchCommand, hasAgentCommandSelection } from '../../terminal/launchCommands';
import { readTodoPreferences, rememberTodoChoice, todoDirectoryChoices, uniqueDirectories } from '../../todos/preferences';
import { CollectorEditor, IntegrationHelp, LaunchEditor, TodoDialog, TodoEditor, resolveTodoConfig, todoGhost as ghost, todoPrimary as primary, todoSecondary as secondary } from './TodoForms';
import { TodoRunCard, todoRunLabel } from './TodoRunCard';
import { TodoDetail } from './TodoDetail';
import { TodoMoreMenu, type TodoMenuItem } from './TodoMoreMenu';

const blankConfig: TodoLaunchConfig = { agentSlug: '', command: '', cwd: '', prompt: '' };
export default function TodoWorkspace({ onOpenSidebar, leftSidebarVisible, activeSessionId }: { onOpenSidebar: () => void; leftSidebarVisible: boolean; activeSessionId?: string | null }) {
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
    const [agents, settings, inventory] = await Promise.allSettled([getAgentLaunchers(), getSettings(), getSessionInventory()]);
    if (!mounted.current || savedConnection()?.targetPeerId !== service) return;
    const previous = useTodoWorkspace.getState().options[workspace];
    const sessions = inventory.status === 'fulfilled' ? inventory.value.clientSessions.slice().sort((a, b) => b.lastActivity - a.lastActivity) : [];
    const next = { agents: agents.status === 'fulfilled' ? agents.value : previous?.agents ?? [], preferred: settings.status === 'fulfilled' ? settings.value.newSessionAgentSlug : previous?.preferred ?? readNewSessionAgentPreference()?.slug ?? null,
      cwd: sessions.find(s => s.sessionId === activeSessionId)?.cwd ?? previous?.cwd ?? sessions[0]?.cwd ?? '', directories: uniqueDirectories(sessions.map(s => s.cwd).concat(previous?.directories ?? [])) };
    setOptions(next); useTodoWorkspace.getState().cacheOptions(workspace, next); setAgentsLoading(false);
    if (agents.status === 'rejected') setError('Agent 列表加载失败，请点击执行设置重试。');
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
  const select = (todo: TodoItem) => patch({ selectedId: todo.id, mobileDetail: true });
  const openSession = (run: TodoRun) => void act(async () => {
    const inventory = await getSessionInventory(); if (!current()) return;
    if (!inventory.clientSessions.some(s => s.sessionId === run.sessionId)) throw new Error('这个终端已关闭。结果仍保留；需要继续时，请在待办详情里重新发起。');
    patch({ modal: null }); window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: run.sessionId }));
  });
  const configForTodo = (id: string, base: TodoLaunchConfig) => {
    const collectorId = data?.todos.find(todo => todo.id === id)?.collectorId;
    const collector = data?.collectors.find(collector => collector.id === collectorId);
    return collector ? { ...base, cwd: collector.config.cwd } : base;
  };
  const launch = async (ids: string[], config: TodoLaunchConfig, remember: boolean, useSourceDirectory = false, retryConfigs?: Record<string, TodoLaunchConfig>) => {
    if (remember) { await saveTodoDefaults(config); if (!current()) return; }
    const configs = ids.map(id => retryConfigs?.[id] ?? (useSourceDirectory ? configForTodo(id, config) : config));
    const results = await Promise.allSettled(ids.map((id, index) => startTodo(id, configs[index], key(['execute', id, configs[index]]))));
    if (!current()) return;
    const succeeded: string[] = [], failed: string[] = [];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') { succeeded.push(ids[i]); finish(['execute', ids[i], configs[i]]); }
      else failed.push(`${data?.todos.find(t => t.id === ids[i])?.title ?? '待办'}：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    });
    if (succeeded.length) { if (remember) rememberTodoChoice(workspace, config); clearDraft(launchDraftId(ids)); patch({ tab: 'todos', filter: 'open', selecting: false, checked: [], selectedId: succeeded[0], mobileDetail: ids.length === 1, modal: null }); setNotice(succeeded.length === 1 ? '已发起处理' : `已发起 ${succeeded.length} 项处理`); }
    if (failed.length) { const retryIds = ids.filter(id => !succeeded.includes(id)); useTodoWorkspace.getState().draft(workspace, launchDraftId(retryIds), { config: configs[ids.indexOf(retryIds[0])], remember: false }); patch({ modal: { kind: 'launch', ids: retryIds, configs: Object.fromEntries(retryIds.map(id => [id, configs[ids.indexOf(id)]])) } }); throw new Error(failed.join('；')); }
  };
  const requestLaunch = (ids: string[], configure = false) => {
    if (!data) return;
    if (!configure && reusableConfig && options.agents.some(agent => agent.slug === reusableConfig.agentSlug)) void act(() => launch(ids, reusableConfig, !data.defaults.agentSlug, true));
    else show({ kind: 'launch', ids, ...(!configure && ids.length > 1 ? { configs: Object.fromEntries(ids.map(id => [id, configForTodo(id, config)])) } : {}) });
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
  const selected = data?.todos.find(todo => todo.id === view.selectedId);
  const selectedRun = selected && data ? latestTodoRun(data, selected.id) : undefined;
  const visible = data?.todos.filter(todo => matchesTodo(data, todo, view.filter)
    && (!view.source || todo.source === view.source)
    && `${todo.title} ${todo.description} ${todo.source}`.toLowerCase().includes(view.query.toLowerCase())) ?? [];
  const canBatch = (todo: TodoItem) => {
    const run = data && latestTodoRun(data, todo.id);
    return todo.status === 'open' && (!run || run.status === 'failed');
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
  const reusableConfig = data?.defaults.agentSlug ? data.defaults : lastChoice ? config : undefined;
  const collectionConfig = inheritedChoice ? { ...blankConfig, ...inheritedChoice } : config;
  const directories = todoDirectoryChoices(options.cwd, options.directories ?? [], data, workspace);
  const modalConfigs = modal?.kind === 'launch' && modal.configs ? Object.fromEntries(Object.entries(modal.configs)
    .map(([id, value]) => [id, resolveTodoConfig(value, options.agents, config.agentSlug, config.cwd)])) : undefined;
  const modalConfig = modal?.kind === 'launch' ? modalConfigs?.[modal.ids[0]] ?? (modal.ids.length === 1 ? configForTodo(modal.ids[0], config) : config) : config;
  const service = savedConnection()?.serviceName || '当前服务';
  const collector = modal?.kind === 'collector' ? data?.collectors.find(item => item.id === modal.id) : undefined;
  const edit = modal?.kind === 'edit' ? modal.todo : undefined;
  const modalTitle = modal?.kind === 'edit' ? edit ? '编辑待办' : '新增待办' : modal?.kind === 'launch'
    ? modal.ids.length > 1 ? `处理 ${modal.ids.length} 条待办` : '交给 Agent 处理' : modal?.kind === 'collector'
    ? collector ? '编辑收集方向' : '添加收集方向' : modal?.kind === 'defaults' ? '执行设置' : '外部接入';
  const detailOnly = view.tab === 'todos' && !wide && view.mobileDetail && !!selected;
  const toolsVisible = view.toolsOpen || view.filter !== 'open' || !!view.query || !!view.source;
  const listVisible = view.tab === 'todos' && !detailOnly;
  const backToList = () => patch({ tab: 'todos', mobileDetail: false, selecting: false, checked: [] });
  const configureSelected = () => {
    if (!selected) return;
    if (selectedRun) useTodoWorkspace.getState().draft(workspace, launchDraftId([selected.id]), { config: selectedRun.config, remember: false });
    requestLaunch([selected.id], true);
  };
  const selectedActions: TodoMenuItem[] = selected ? [
    { label: '编辑待办', action: () => show({ kind: 'edit', todo: selected }) },
    ...(selectedRun?.sessionId ? [{ label: '打开终端', action: () => openSession(selectedRun) }] : []),
    ...(selected.status === 'open' ? [
      { label: selectedRun ? '重新发起' : '处理配置', action: configureSelected, disabled: selectedRun?.status === 'launching' },
      ...(selectedRun?.status !== 'complete' ? [{ label: '标记完成', action: () => status(selected, 'completed') }] : []),
      { label: '忽略这条待办', action: () => status(selected, 'ignored'), danger: true },
    ] : []),
  ] : [];
  const workspaceActions: TodoMenuItem[] = [
    { label: '搜索和筛选', action: () => {
      patch({ toolsOpen: true });
      window.setTimeout(() => { if (current()) root.current?.querySelector<HTMLInputElement>('[aria-label="搜索待办"]')?.focus(); }, 0);
    } },
    { label: '多选待办', action: () => patch({ selecting: true, mobileDetail: false, checked: [] }), disabled: !visible.some(canBatch) },
    { label: '已完成', action: () => patch({ filter: 'completed', mobileDetail: false, checked: [] }) },
    { label: '已忽略', action: () => patch({ filter: 'ignored', mobileDetail: false, checked: [] }) },
    { label: '收集方向', action: () => patch({ tab: 'collectors', mobileDetail: false }) },
    { label: '执行设置', action: () => { void loadOptions(); show({ kind: 'defaults' }); } },
    { label: '外部接入', action: () => show({ kind: 'integration' }) },
  ];
  const requestCollection = () => {
    if (!data) return;
    if (enabledCollectors.length) void act(() => collect(enabledCollectors));
    else if (data.collectors.length) patch({ tab: 'collectors', mobileDetail: false });
    else show({ kind: 'collector' });
  };
  const collectionPending = data?.collectors.filter(item => {
    const run = data.runs.filter(run => run.collectorId === item.id).at(-1);
    return run && (run.status === 'launching' || run.status === 'delivered');
  }).length ?? 0;
  return <section ref={root} aria-label="待办工作区" className="absolute inset-0 flex min-h-0 min-w-0 flex-col bg-[var(--chrome-bg)] text-foreground">
    <header data-termdock-window-header="true" className="relative z-20 flex min-h-16 shrink-0 items-center gap-1 border-b border-border/30 px-3 sm:gap-2 sm:px-5">
      {detailOnly ? <>
        <button type="button" className={ghost} aria-label="返回清单" onClick={backToList}><ArrowLeft size={18} /><span>待办</span></button>
        <h1 className="sr-only">待办详情</h1><div className="flex-1" />
        <TodoMoreMenu label="待办操作" items={selectedActions} disabled={busy} />
      </> : view.tab === 'collectors' ? <>
        <button type="button" className={ghost} aria-label="返回清单" onClick={backToList}><ArrowLeft size={18} /></button>
        <h1 className="min-w-0 flex-1 text-base font-semibold">收集方向</h1>
        <button type="button" className={ghost} aria-label="添加方向" title="添加方向" disabled={!data} onClick={() => show({ kind: 'collector' })}><Plus size={20} /><span className="hidden sm:inline">添加方向</span></button>
      </> : view.selecting ? <>
        <button type="button" className={ghost} onClick={() => patch({ selecting: false, checked: [] })}>取消</button>
        <h1 className="min-w-0 flex-1 text-sm">已选 {checked.length} 项</h1>
        <button type="button" className={primary} disabled={busy || !checked.length} onClick={() => requestLaunch(checked.map(todo => todo.id))}>批量处理</button>
      </> : <>
        {!leftSidebarVisible && <button type="button" className={`${ghost} hidden sm:inline-flex`} aria-label="打开会话侧栏" onClick={onOpenSidebar}><PanelLeft size={18} /></button>}
        <button type="button" className={`${ghost} px-2`} aria-label="返回终端" title="返回终端" onClick={() => useCollaborationNavigation.getState().terminal()}><ArrowLeft size={18} /></button>
        <h1 className="min-w-0 flex-1 text-base font-semibold">待办{data && <span className="ml-2 text-xs font-normal tabular-nums text-muted-foreground">{data.todos.filter(todo => todo.status === 'open').length}</span>}</h1>
        <button type="button" className={`${ghost} px-2 text-primary`} aria-label="收集待办" disabled={!data || busy} onClick={requestCollection}><Sparkles size={16} /><span>收集</span></button>
        <button type="button" className={`${ghost} px-2`} aria-label="新增待办" title="新增待办" disabled={!data} onClick={() => show({ kind: 'edit' })}><Plus size={21} /></button>
        <TodoMoreMenu label="待办菜单" items={workspaceActions} disabled={!data || busy} />
      </>}
    </header>
    {(loadError || error && !modal) && <div role="alert" className="flex shrink-0 items-start gap-3 border-b border-border/30 px-5 py-3 text-sm text-destructive"><span className="min-w-0 flex-1 break-words">{error || loadError}</span>{loadError && <button type="button" className="shrink-0 underline" onClick={() => void refresh(true)}>重试</button>}<button type="button" aria-label="关闭提示" onClick={() => { setError(''); setLoadError(''); }}>×</button></div>}
    {notice && <div role="status" className="fixed bottom-[max(1.5rem,env(safe-area-inset-bottom,0px))] left-1/2 z-toast flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-4 rounded-xl border border-border bg-surface-elevated px-4 py-3 text-sm shadow-lg"><span className="min-w-0 break-words">{notice}</span>{undo && <button type="button" className="min-h-9 shrink-0 text-primary" onClick={() => void act(async () => { await updateTodo(undo.todo, { status: undo.previous }); if (current()) setNotice('已撤销'); })}>撤销</button>}</div>}
    {!data ? <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{loadError ? '加载失败，请重试' : '正在加载待办…'}</div> : view.tab === 'collectors' ? <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><p className="text-sm leading-6 text-muted-foreground">配置一次，之后从清单一键收集。</p>{enabledCollectors.length > 1 && <button type="button" className={secondary} disabled={busy} onClick={() => void act(() => collect(enabledCollectors))}>全部收集</button>}</div>
      {!data.collectors.length ? <Empty title="让 Agent 帮你发现下一件事" text="添加一个收集方向，写下关注的内容和筛选要求。" /> : <div className={`grid items-start gap-4 ${wide ? 'grid-cols-2' : ''}`}>{data.collectors.map(item => <CollectorCard key={item.id} collector={item} runs={data.runs.filter(run => run.collectorId === item.id)} busy={busy} onRun={() => void act(() => collect([item]))} onEdit={() => show({ kind: 'collector', id: item.id })} onOpen={openSession} onRemove={() => void act(async () => { await removeTodoCollector(item); })} />)}</div>}
    </div> : <div className="flex min-h-0 flex-1">
      <div className={`${wide ? 'flex w-[42%] shrink-0 border-r border-border/30' : listVisible ? 'flex flex-1' : 'hidden'} min-h-0 min-w-0 flex-col`}>
        {toolsVisible && <div aria-label="搜索和筛选" className="shrink-0 space-y-2 border-b border-border/30 px-4 py-3">
          <div className="flex items-center gap-2"><div className="relative min-w-0 flex-1"><Search size={15} className="pointer-events-none absolute left-3 top-3.5 text-muted-foreground" /><input autoFocus={view.toolsOpen} aria-label="搜索待办" className="min-h-11 w-full min-w-0 rounded-lg bg-surface-2 py-2 pl-9 pr-3 text-base outline-none focus:ring-1 focus:ring-primary sm:text-sm" placeholder="搜索待办" value={view.query} onChange={event => patch({ query: event.target.value })} /></div><button type="button" className={ghost} aria-label="清除筛选" onClick={() => patch({ query: '', source: '', filter: 'open', toolsOpen: false, checked: [] })}><X size={17} /></button></div>
          <div className="flex gap-2"><select aria-label="待办状态" className="min-h-11 min-w-0 flex-1 rounded-lg bg-surface-2 px-3 text-base sm:text-sm" value={view.filter} onChange={event => patch({ filter: event.target.value as typeof view.filter, checked: [] })}><option value="open">未完成</option><option value="review">待确认</option><option value="completed">已完成</option><option value="ignored">已忽略</option></select>
            <select aria-label="按来源筛选" className="min-h-11 min-w-0 flex-1 rounded-lg bg-surface-2 px-3 text-base sm:text-sm" value={view.source} onChange={event => patch({ source: event.target.value, checked: [] })}><option value="">全部来源</option>{[...new Set(data.todos.map(todo => todo.source))].map(source => <option key={source}>{source}</option>)}</select></div>
        </div>}
        {!!collectionPending && <button type="button" className="flex min-h-11 shrink-0 items-center justify-between gap-3 px-5 text-left text-xs text-muted-foreground hover:bg-surface" onClick={() => patch({ tab: 'collectors' })}><span>已发起 {collectionPending} 个收集任务</span><span className="text-primary">查看</span></button>}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-6 pt-2 sm:px-4">
          {!visible.length ? <Empty title={view.query || view.source ? '没有匹配的待办' : view.filter === 'completed' ? '还没有已完成的待办' : view.filter === 'review' ? '暂时没有待确认的结果' : view.filter === 'ignored' ? '没有已忽略的待办' : data.todos.length ? '清单已清空' : '还没有待办'} text={view.query || view.source ? '换个关键词，或清除筛选。' : view.filter === 'open' ? '点 + 记下一件事，或让 Agent 帮你收集。' : '清除筛选可回到当前待办。'} /> : visible.map(todo => {
            const run = latestTodoRun(data, todo.id);
            const inTerminal = run?.sessionId && ['launching', 'delivered', 'blocked'].includes(run.status);
            const rowAction = inTerminal ? '查看执行' : run?.status === 'complete' ? '查看结果' : run?.status === 'failed' ? '查看问题' : '处理';
            const rowLabel = run ? run.status === 'complete' ? '待确认' : run.status === 'delivered' ? '已发送到终端' : run.status === 'launching' ? '准备终端' : run.status === 'blocked' ? '需要协助' : '处理失败' : '';
            return <article key={todo.id} className={`flex items-start gap-1 border-b border-border/30 px-1 py-4 ${view.selectedId === todo.id && wide ? 'bg-surface' : 'hover:bg-surface'}`}>
              {view.selecting ? <label className="flex min-h-11 w-10 shrink-0 items-center justify-center"><input type="checkbox" aria-label={`选择 ${todo.title}`} checked={canBatch(todo) && view.checked.includes(todo.id)} disabled={!canBatch(todo)} onChange={event => patch({ checked: event.target.checked ? [...view.checked, todo.id] : view.checked.filter(id => id !== todo.id) })} className="h-4 w-4 accent-[var(--primary)]" /></label> : <button type="button" className="flex min-h-11 w-10 shrink-0 items-center justify-center text-muted-foreground hover:text-primary" disabled={busy || todo.status === 'ignored'} aria-label={`${todo.status === 'completed' ? '重新打开' : '完成'} ${todo.title}`} onClick={() => status(todo, todo.status === 'completed' ? 'open' : 'completed')}>{todo.status === 'completed' ? <CheckCircle2 size={19} className="text-primary" /> : <Circle size={19} />}</button>}
              <button type="button" className="min-w-0 flex-1 py-2 text-left" onClick={() => select(todo)}><span className={`block break-words text-[15px] font-medium leading-6 ${todo.status === 'completed' ? 'text-muted-foreground line-through' : ''}`}>{todo.title}</span><span className={`mt-1.5 block truncate text-xs leading-5 ${run?.status === 'complete' && todo.status === 'open' ? 'text-primary' : 'text-muted-foreground'}`}>{todo.status === 'open' && rowLabel ? rowLabel : todo.status === 'completed' ? '已完成' : todo.status === 'ignored' ? '已忽略' : todo.source}{todo.status === 'open' && rowLabel && todo.source !== '手动添加' ? ` · ${todo.source}` : ''}</span></button>
              {todo.status === 'open' && !view.selecting && <button type="button" className="mt-1 inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-medium text-primary hover:bg-surface-2 disabled:opacity-40" disabled={busy || run?.status === 'launching' && !run.sessionId} aria-label={`${inTerminal ? '打开终端' : run?.status === 'complete' ? '查看结果' : run?.status === 'failed' ? '查看问题' : '处理'} ${todo.title}`} onClick={() => inTerminal ? openSession(run!) : run ? select(todo) : requestLaunch([todo.id])}><span>{rowAction}</span></button>}
            </article>;
          })}
        </div>
      </div>
      {(wide || detailOnly) && <div className="flex min-h-0 min-w-0 flex-1 flex-col">{selected ? <TodoDetail key={selected.id} todo={selected} runs={data.runs.filter(run => run.todoId === selected.id)} config={selectedRun?.config ?? configForTodo(selected.id, config)} agentName={options.agents.find(agent => agent.slug === (selectedRun?.config.agentSlug ?? config.agentSlug))?.displayName ?? selectedRun?.config.agentSlug ?? config.agentSlug} busy={busy} wide={wide} menu={selectedActions} onLaunch={() => requestLaunch([selected.id])} onConfigure={configureSelected} onOpen={openSession} onStatus={next => status(selected, next)} /> : <Empty title="从清单开始" text="选择一条待办，查看内容或处理结果。" />}</div>}
    </div>}
    {modal && <TodoDialog title={modalTitle} busy={busy} error={error} onClose={() => show(null)}>
      {modal.kind === 'edit' && <TodoEditor workspace={workspace} todo={edit} busy={busy} onCancel={() => show(null)} onSave={(input, start) => void act(async () => {
        const result = edit ? await updateTodo(edit, input) : await createTodo({ ...input, idempotencyKey: key(['create', input]) });
        if (!current()) return; finish(['create', input]); clearDraft(`todo:${edit?.id ?? 'new'}`);
        const ready = start && reusableConfig && options.agents.some(agent => agent.slug === reusableConfig.agentSlug);
        patch({ tab: 'todos', filter: 'open', source: '', query: '', selectedId: result.todo.id, mobileDetail: true, modal: start && !ready ? { kind: 'launch', ids: [result.todo.id] } : null });
        if (ready) await launch([result.todo.id], reusableConfig!, !data?.defaults.agentSlug);
        else setNotice(start ? '待办已保存，选择 Agent 后开始处理。' : '待办已保存。');
      })} />}
      {(modal.kind === 'launch' || modal.kind === 'defaults') && <LaunchEditor workspace={workspace} draftId={modal.kind === 'defaults' ? 'defaults' : launchDraftId(modal.ids)} config={modalConfig} agents={options.agents} loading={agentsLoading} service={service} directories={uniqueDirectories([modalConfig.cwd, ...directories])} currentCwd={options.cwd} multipleDirectories={modalConfigs && new Set(Object.values(modalConfigs).map(value => value.cwd)).size > 1} busy={busy} settings={modal.kind === 'defaults'} onCancel={() => show(null)} onSave={(config, remember) => void act(async () => {
        if (modal.kind === 'defaults') { await saveTodoDefaults(config); if (current()) { rememberTodoChoice(workspace, config); clearDraft('defaults'); patch({ modal: null }); setNotice('执行配置已保存，下次点击「处理」即可直接启动。'); } }
        else await launch(modal.ids, config, remember, false, modalConfigs && JSON.stringify(config) === JSON.stringify(modalConfigs[modal.ids[0]]) ? modalConfigs : undefined);
      })} />}
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
    <div className="flex items-center gap-2"><h2 className="min-w-0 flex-1 break-words text-base font-semibold">{c.name}</h2><button type="button" className={ghost} aria-label={`编辑 ${c.name}`} disabled={busy} onClick={onEdit}><Pencil size={16} /></button><button type="button" className={ghost} aria-label={`移除 ${c.name}`} disabled={busy} onClick={() => setRemoving(true)}><Trash2 size={16} /></button></div>
    <p className="mt-1 text-xs leading-6 text-muted-foreground">{c.config.agentSlug} · {!c.enabled ? '已停用' : !c.schedule ? '手动运行' : c.schedule.kind === 'interval' ? `每 ${c.schedule.everyMinutes} 分钟` : `每天 ${c.schedule.time}`}</p>
    <p className="my-3 line-clamp-3 whitespace-pre-wrap text-sm leading-7 text-muted-foreground">{c.config.prompt}</p>
    {removing ? <div className="rounded-lg bg-surface-2 p-3"><p className="text-sm leading-6">移除此方向？已有待办、终端和结果会保留。</p><div className="mt-2 flex justify-end gap-2"><button type="button" className={ghost} onClick={() => setRemoving(false)}>取消</button><button type="button" className={`${secondary} text-destructive`} disabled={busy} onClick={onRemove}>确认移除</button></div></div> : <div className="flex flex-wrap gap-2"><button type="button" className={primary} disabled={busy || latest?.status === 'launching'} onClick={onRun}><Sparkles size={16} />{latest ? '再次收集' : '开始收集'}</button></div>}
    {latest && <>
      <div className="mt-4 flex items-center gap-2 text-xs leading-6 text-muted-foreground"><span className="flex-1">{latest.status === 'complete' ? '已收到收集结果' : todoRunLabel[latest.status]}</span>{latest.sessionId && latest.status !== 'complete' && <button type="button" className={ghost} disabled={busy} onClick={() => onOpen(latest)}>打开终端</button>}</div>
      <details className="mt-2 text-sm text-muted-foreground"><summary className="min-h-11 cursor-pointer py-2.5">收集记录 · {runs.length} 次</summary><div className="space-y-3 pt-2">{runs.slice().reverse().map(run => <TodoRunCard key={run.id} run={run} onOpen={() => onOpen(run)} busy={busy} />)}</div></details>
    </>}
  </article>;
}
