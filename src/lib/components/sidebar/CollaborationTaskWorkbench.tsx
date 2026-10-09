import { collaborationResultPresentation } from '../../collaboration/resultPresentation';
import { CollaborationInput } from './CollaborationInput';
import { CollaborationKanban } from './CollaborationKanban';
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowUpRight, Check, ChevronRight, Circle, CircleCheck, ExternalLink, MessageCircle, Plus, RefreshCw, Search, Send, X } from 'lucide-react';
import { collaborationTaskStage as taskStage, collaborationTaskNeedsAttention as needsAttention, taskReportLabels as labels } from '../../collaboration/taskState';
import { useCollaborationTaskInbox } from '../../stores/useCollaborationTaskInbox';
import { useCollaborationTaskWorkspace, taskWorkspaceDispatch, taskDetailDispatch, type CollaborationGoalDraft as Draft } from '../../stores/useCollaborationTaskWorkspace';
import { collaborationMemberLabel } from '../../collaboration/display';
import { isConnectionInterruption, SECURE_READY_EVENT, useConnectionRecovery } from '../../federation/connectionRecovery';
import { createCollaborationTask, getCollaborationTask, listCollaborationTasks, updateCollaborationTask,
  ensureCollaborationTeam, type AgentLauncherInfo, type CollaborationGroup, type CollaborationTaskView, type OrchestrationSession, type TaskMember, type TaskOperation } from '../../terminal/api';

const DirectoryPicker = lazy(() => import('./DirectoryPickerDialog').then(module => ({ default: module.DirectoryPickerDialog })));
const TaskContent = lazy(() => import('./CollaborationTaskContent'));

const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-[13px] transition disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary';
const input = 'w-full min-h-11 rounded-lg border border-border/30 bg-surface-2 px-3 py-2 text-sm text-foreground outline-none focus:border-primary';
const primary = `${button} bg-primary text-primary-foreground`;
const secondary = `${button} bg-surface-2 text-foreground hover:bg-surface-2/80`;
const eventLabels: Record<string, string> = { created: '创建任务', assigned: '分派', report: '成员报告', question: '提出问题', answer: '用户回答',
  'submit-plan': '提交方案', review: '提交评审', 'request-review': '请求独立评审', 'approve-plan': '用户确认方案', accepted: '用户验收', revise: '要求修改', comment: '补充说明', coordinator: '协调者变更', close: '关闭', reopen: '重新打开', scheduled: '等待自动分派', coordinate: '协调说明', 'child-update': '子任务更新', 'review-passed': '独立评审通过', 'review-blocked': '评审受阻', 'automation-blocked': '自动安排受阻', pause: '暂停安排', resume: '继续安排', retry: '继续协调' };
const memberKey = (m: TaskMember) => `${m.serviceId}:${m.sessionId}`;
const stamp = (time: number) => new Date(time).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function saved<T>(key: string, fallback: T): T {
  try { const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (value === null || fallback !== null && (typeof value !== typeof fallback || Array.isArray(value) !== Array.isArray(fallback))) return fallback;
    return value;
  } catch { return fallback; }
}
function persist(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Private mode still supports the current editing session. */ } }
const emptyDraft: Draft = { mode: 'goal', isolated: true, title: '', spec: '', constraints: '', acceptance: '', assignee: '', coordinator: '', parent: '', dependencies: [] };
function savedDraft(key: string): Draft {
  const draft = { ...emptyDraft, ...saved(key, emptyDraft) };
  if (!draft || !Array.isArray(draft.dependencies) || draft.dependencies.some(id => typeof id !== 'string')
    || Object.keys(emptyDraft).some(key => !['dependencies', 'isolated'].includes(key) && typeof draft[key as keyof Draft] !== 'string')) return emptyDraft;
  return { ...draft, mode: draft.mode === 'task' ? 'task' : 'goal', isolated: draft.isolated !== false };
}

export function CollaborationTaskWorkbench({ group, sessions, active, onOpenSession, onAttentionChange, onManageMembers, board = false, boardNavigation, boardSettings, paneKey, agents = [], defaultCwd, onTeamReady }: {
  agents?: AgentLauncherInfo[]; defaultCwd?: string; onTeamReady?: () => Promise<void>;
  paneKey?: string; board?: boolean; boardNavigation?: ReactNode; boardSettings?: ReactNode;
  onAttentionChange?: (count: number) => void; onManageMembers?: () => void;
  group: CollaborationGroup; sessions: OrchestrationSession[]; active: boolean; onOpenSession: (session: OrchestrationSession) => Promise<void>;
}) {
  const storage = `termdock:tasks:${location.origin}:${group.id}`;
  const [tasks, setTasks] = useState<CollaborationTaskView[]>([]);
  const [detail, setDetail] = useState<CollaborationTaskView | null>(null);
  const [initialWorkspace] = useState(() => useCollaborationTaskWorkspace.getState().ensure(storage, {
    draft: savedDraft(`${storage}:draft`), selectedId: saved(`${storage}:selected`, null), creating: false, mobileDetail: false,
  }));
  const { selectedId, mobileDetail, creating, draft } = useCollaborationTaskWorkspace(state => state.views[storage] ?? initialWorkspace);
  const setSelectedId = taskWorkspaceDispatch(storage, 'selectedId');
  const setMobileDetail = taskWorkspaceDispatch(storage, 'mobileDetail');
  const setCreating = taskWorkspaceDispatch(storage, 'creating');
  const setDraft = taskWorkspaceDispatch(storage, 'draft');
  const [wide, setWide] = useState(false);
  const [searching, setSearching] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const newTaskRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const node = sectionRef.current;
    if (!node) return;
    const observer = new ResizeObserver(entries => setWide(entries[0].contentRect.width >= (board ? 1100 : 760)));
    observer.observe(node);
    return () => observer.disconnect();
  }, [board]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const connection = useConnectionRecovery();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploads, setUploads] = useState(0);
  const uploadChange = (delta: number) => setUploads(count => Math.max(0, count + delta));
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const [filter, setFilter] = useState('open');
  const [query, setQuery] = useState('');
  const actionPending = useRef(false);
  const alive = useRef(true), requestKeys = useRef(new Map<string, string>()), polling = useRef(false);
  const rawMembers = group.sessionIds.flatMap(id => { const session = sessions.find(s => s.sessionId === id); return session ? [session] : []; });
  const members = rawMembers.map(session => ({ ...session, name: collaborationMemberLabel(session, rawMembers) }));
  const preferredLead = draft.coordinator || saved<string>(`${storage}:lead`, '');
  const lead = members.find(s => s.sessionId === preferredLead)?.sessionId || members.find(s => s.agent)?.sessionId || members[0]?.sessionId || '';
  const workers = members.filter(s => s.sessionId !== lead && s.agent).map(s => s.sessionId);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [preparingTeam, setPreparingTeam] = useState(false);
  const [agentSlug, setAgentSlug] = useState(() => saved<string>(`${storage}:agent`, agents[0]?.slug ?? ''));
  const [teamCwd, setTeamCwd] = useState(() => saved<string>(`${storage}:cwd`, members[0]?.cwd ?? defaultCwd ?? ''));
  useEffect(() => { if (!agentSlug && agents[0]) setAgentSlug(agents[0].slug); }, [agents, agentSlug]);
  const needsTeam = !members.find(s => s.sessionId === lead)?.agent || !workers.length;
  const goalReady = !!draft.spec.trim() && (needsTeam ? !group.federated && !!agents.find(agent => agent.slug === agentSlug) && !!teamCwd.trim() : true);
  const [provisioned, setProvisioned] = useState<{ coordinatorSessionId: string; reviewerSessionIds: string[] } | null>(null);

  const selectedSummary = tasks.find(t => t.id === selectedId) ?? null;
  const selected = detail?.id === selectedId ? detail : null;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { persist(`${storage}:draft`, draft); }, [storage, draft]);
  useEffect(() => { persist(`${storage}:selected`, selectedId); }, [storage, selectedId]);
  useEffect(() => {
    const choose = (event: Event) => { const target = (event as CustomEvent<{ groupId: string; taskId: string }>).detail;
      if (target?.groupId !== group.id) return;
      persist(`${storage}:open-task`, null);
      setSelectedId(target.taskId); setMobileDetail(true); setCreating(false); setFilter('all'); void refresh(); };
    window.addEventListener('open-collaboration-task', choose);
    const pending = saved<string | null>(`${storage}:open-task`, null);
    if (pending) { setSelectedId(pending); setMobileDetail(true); setFilter('all'); persist(`${storage}:open-task`, null); }
    return () => window.removeEventListener('open-collaboration-task', choose);
  }, [group.id]);
  useEffect(() => {
    if (!active || !selectedSummary || detail?.id === selectedSummary.id && detail.revision === selectedSummary.revision) return;
    let cancelled = false;
    void getCollaborationTask(selectedSummary.id).then(result => { if (!cancelled) { setDetail(result.task); setLoadError(null); } })
      .catch(e => { if (!cancelled) setLoadError(e instanceof Error ? e.message : '任务详情加载失败'); });
    return () => { cancelled = true; };
  }, [active, selectedSummary?.id, selectedSummary?.revision, detail?.id, detail?.revision, refreshVersion]);
  const refresh = async () => {
    if (polling.current) return;
    polling.current = true;
    try { const result = await listCollaborationTasks(group.id); if (alive.current) { setTasks(result.tasks); setLoaded(true); setLoadError(null); setRefreshVersion(version => version + 1); } }
    catch (e) { if (alive.current) setLoadError(e instanceof Error ? e.message : '任务加载失败'); }
    finally { polling.current = false; }
  };
  useEffect(() => {
    if (!active) return;
    void refresh();
    const tick = () => { if (!document.hidden && navigator.onLine !== false) void refresh(); };
    const timer = setInterval(tick, 2500);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener(SECURE_READY_EVENT, tick);
    window.addEventListener('pageshow', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); window.removeEventListener(SECURE_READY_EVENT, tick); window.removeEventListener('pageshow', tick); };
    // The parent keys this component by group, isolating drafts and late requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, group.id]);
  const keyFor = (payload: unknown) => {
    const fingerprint = JSON.stringify(payload);
    const previous = saved<{ fingerprint: string; key: string } | null>(`${storage}:request`, null);
    let key = requestKeys.current.get(fingerprint) ?? (previous?.fingerprint === fingerprint ? previous.key : undefined);
    if (!key) { key = crypto.randomUUID(); requestKeys.current.set(fingerprint, key); }
    persist(`${storage}:request`, { fingerprint, key });
    return key;
  };
  const finishRequest = (payload: unknown) => { requestKeys.current.delete(JSON.stringify(payload)); persist(`${storage}:request`, null); };
  const act = async (task: CollaborationTaskView, operation: Omit<TaskOperation, 'idempotencyKey'> & { assigneeSessionId?: string; coordinatorSessionId?: string | null }) => {
    if (busy || actionPending.current) return { ok: false, error: '已有操作正在提交，请稍候。' };
    actionPending.current = true;
    setBusy(true); setError(null); setNotice('');
    let payload = { ...operation, expectedRevision: task.revision };
    // Retrying an unconfirmed request must reuse its original revision and key,
    // even if polling has already observed the successful server write.
    if (['comment', 'revise'].includes(operation.kind)) {
      const previous = saved<{ fingerprint: string; key: string } | null>(`${storage}:request`, null);
      try {
        const [previousId, previousPayload] = JSON.parse(previous?.fingerprint ?? 'null');
        const { expectedRevision: _revision, ...previousOperation } = previousPayload;
        if (previousId === task.id && JSON.stringify(previousOperation) === JSON.stringify(operation)) payload = previousPayload;
      } catch { /* No outstanding matching operation. */ }
    }
    try {
      const result = await updateCollaborationTask(task.id, { ...payload, idempotencyKey: keyFor([task.id, payload]) });
      finishRequest([task.id, payload]);
      void useCollaborationTaskInbox.getState().refresh();
      if (alive.current) {
        setTasks(list => list.map(t => t.id === result.task.id ? result.task : t));
        setDetail(result.task);
        setNotice(['comment', 'revise'].includes(operation.kind) ? '' : operation.kind === 'answer' ? '回答已保存，服务端继续投递。' : operation.kind === 'accept' ? '已验收此版本结果。' : '记录已保存。');
      }
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : '操作失败';
      if (message.includes('任务已更新')) finishRequest([task.id, payload]);
      if (alive.current) { setError(['comment', 'revise'].includes(operation.kind) ? null : message); void refresh(); }
      return { ok: false, error: message };
    } finally { actionPending.current = false; if (alive.current) setBusy(false); }
  };
  const create = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy || uploads > 0 || (draft.mode === 'goal' ? !goalReady : !draft.title.trim() || !draft.spec.trim())) return;
    if (actionPending.current) return; actionPending.current = true;
    setBusy(true); setError(null);
    const managed = draft.mode === 'goal';
    const payload = { groupId: group.id, title: draft.title.trim() || draft.spec.trim().split('\n')[0].slice(0, 100), spec: draft.spec, constraints: draft.constraints, acceptance: draft.acceptance,
      assigneeSessionId: managed ? undefined : draft.assignee || undefined, coordinatorSessionId: managed ? lead : draft.coordinator || undefined,
      parentTaskId: managed ? undefined : draft.parent || undefined, dependsOn: managed ? [] : draft.dependencies,
      managed, isolated: draft.isolated, reviewerSessionIds: managed ? workers : undefined };
    try {
      if (managed && needsTeam) {
        setPreparingTeam(true);
        const team = provisioned ?? await ensureCollaborationTeam(group.id, { agentSlug, cwd: teamCwd.trim() });
        setPreparingTeam(false); setProvisioned(team); payload.coordinatorSessionId = team.coordinatorSessionId; payload.reviewerSessionIds = team.reviewerSessionIds;
        persist(`${storage}:agent`, agentSlug); persist(`${storage}:cwd`, teamCwd.trim());
      }
      const { task } = await createCollaborationTask({ ...payload, idempotencyKey: keyFor(payload) });
      finishRequest(payload);
      if (alive.current) { setTasks(list => [task, ...list.filter(t => t.id !== task.id)]); setSelectedId(task.id); setMobileDetail(true);
        setDetail(task);
        if (managed) persist(`${storage}:lead`, payload.coordinatorSessionId);
        setProvisioned(null); void onTeamReady?.();
        setDraft(emptyDraft); setCreating(false); setFilter('open'); setQuery(''); setNotice(managed ? '目标已提交，协调者收到后开始拆分与分派。后续评审和依赖由服务接续。' : '任务已保存。分派后由服务端持续投递。'); }
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '创建失败'); }
    finally { actionPending.current = false; if (alive.current) { setBusy(false); setPreparingTeam(false); } }
  };
  const name = (task: CollaborationTaskView, member: TaskMember | null) => {
    if (!member) return '用户';
    const sessionId = task.memberSessions[memberKey(member)];
    return members.find(s => s.sessionId === sessionId)?.name ?? sessions.find(s => s.sessionId === sessionId)?.name ?? '暂不可用的成员';
  };
  const matches = tasks.filter(t => (filter === 'all' ? true : filter === 'archive' ? t.status !== 'open' : t.status === 'open')
    && (filter === 'all' || filter === 'attention' || t.workflow?.kind !== 'step')
    && (filter !== 'attention' || needsAttention(t))
    && (!query.trim() || `${t.title} ${t.spec} ${t.attempts.map(a => name(t, a.assignee)).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase())));
  const attention = tasks.filter(needsAttention).length;
  useEffect(() => { onAttentionChange?.(attention); }, [attention, onAttentionChange]);
  const showDetail = !!selectedSummary && (board ? mobileDetail : wide || mobileDetail);
  const closeDraft = () => { setCreating(false); requestAnimationFrame(() => newTaskRef.current?.focus()); };
  const chooseTask = (id: string) => { useCollaborationTaskWorkspace.getState().updateDetail(`${storage}:${id}`, 'view', 'overview'); setSelectedId(id); setMobileDetail(true); setNotice(''); };
  const attentionTasks = tasks.filter(needsAttention).filter(t => !query.trim() || `${t.title} ${t.spec} ${t.attempts.map(a => name(t, a.assignee)).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()));
  const taskRow = (task: CollaborationTaskView, urgent = false) => {
    const current = task.attempts.find(a => a.id === task.activeAttemptId);
    const completed = task.children?.filter(c => c.status === 'accepted').length ?? 0;
    const total = task.children?.filter(c => c.status !== 'closed').length ?? 0;
    const preview = urgent ? task.decisions.find(q => q.status === 'pending')?.question : current?.report?.content;
    return <button type="button" key={task.id} aria-pressed={selectedId === task.id} className={`group flex min-h-11 w-full items-start gap-3 rounded-xl p-3 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${selectedId === task.id ? 'bg-surface-2' : 'hover:bg-surface-2/70'}`} onClick={() => chooseTask(task.id)}>
      <span className={`mt-0.5 shrink-0 ${urgent ? 'text-primary' : task.status === 'accepted' ? 'text-primary' : 'text-muted-foreground'}`}>{urgent ? <MessageCircle size={16} /> : task.status === 'accepted' ? <CircleCheck size={16} /> : <Circle size={16} />}</span>
      <span className="min-w-0 flex-1">
        <span className="block break-words text-sm font-medium leading-5 text-foreground">{task.title}</span>
        <span className={`mt-1 block text-xs leading-5 ${urgent ? 'text-primary' : 'text-muted-foreground'}`}>{taskStage(task)}</span>
        {preview && <span className="mt-1 block line-clamp-2 break-words text-xs leading-5 text-muted-foreground">{preview}</span>}
        {total > 0 && <span className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground"><span className="flex gap-1" aria-hidden="true">{(task.children ?? []).filter(c => c.status !== 'closed').slice(0, 8).map(child => <span key={child.id} className={`h-1.5 w-3 rounded-full ${child.status === 'accepted' ? 'bg-primary' : 'bg-border/30'}`} />)}</span>{completed}/{total} 子任务已验收</span>}
        <span className="mt-2 block truncate text-[11px] text-muted-foreground">{current ? name(task, current.assignee) : '尚未分派'} · {stamp(task.updatedAt)}</span>
      </span><ChevronRight size={14} className="mt-1 shrink-0 text-muted-foreground/60" />
    </button>;
  };
  const ancestors: CollaborationTaskView[] = [];
  const seen = new Set([selectedId]);
  let parentId = selectedSummary?.parentTaskId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = tasks.find(task => task.id === parentId);
    if (!parent) break;
    ancestors.unshift(parent);
    parentId = parent.parentTaskId;
  }
  const returnToBoard = () => {
    const card = Array.from(sectionRef.current?.querySelectorAll<HTMLButtonElement>('button[data-task-id]') ?? []).find(node => node.dataset.taskId === selectedId);
    setMobileDetail(false);
    requestAnimationFrame(() => { if (card && !card.closest('[hidden]')) card.focus(); else newTaskRef.current?.focus(); });
  };
  const composerVisible = creating || !board && loaded && tasks.length === 0;
  return <section ref={sectionRef} aria-label="协作任务" className={board ? "relative flex h-full min-h-0 min-w-0 flex-col gap-2" : "space-y-5"}>
    {board && (composerVisible || !loaded) && boardNavigation && <div className="flex shrink-0 items-center gap-2 border-b border-border/15 pb-2">{boardNavigation}<div className="ml-auto">{boardSettings}</div></div>}
    {(error || loadError && connection === 'ready' && !isConnectionInterruption(loadError)) && <div role="alert" className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"><span className="min-w-0 flex-1 break-words">{error || loadError}{!error && loaded ? ' · 显示最近保存的记录' : ''}</span><button type="button" className={button} onClick={() => error ? setError(null) : void refresh()}><RefreshCw size={14} />{error ? '关闭提示' : '重试'}</button></div>}
    {loadError && isConnectionInterruption(loadError) && !board && <p role="status" className="text-xs text-muted-foreground">正在恢复任务同步，现有记录和草稿已保留</p>}
    {notice && <p role="status" className="rounded-lg bg-primary/10 px-3 py-2 text-xs leading-5 text-primary">{notice}</p>}
    {composerVisible ? <form onSubmit={event => void create(event)} className={`mx-auto w-full max-w-xl space-y-4 ${board ? "overflow-auto px-1 py-5" : ""}`} onKeyDown={event => { if (event.key === 'Escape' && creating) { event.preventDefault(); event.stopPropagation(); if (!busy) closeDraft(); } }}>
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1"><h3 className="text-lg font-semibold text-foreground">{draft.mode === 'goal' ? '一起完成什么？' : '新建手动任务'}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{draft.mode === 'goal' ? '交给协调者拆分，你在这里看交付、回答问题。' : '选择负责人，保留分派和验收记录。'}</p></div>
        {(tasks.length > 0 || board) && <button type="button" aria-label="取消创建，保留草稿" className={`${button} shrink-0 px-2 text-muted-foreground hover:bg-surface-2`} disabled={busy} onClick={closeDraft}><X size={16} /></button>}
      </header>
      {draft.mode === 'task' && <Field label="任务标题"><input className={input} required maxLength={200} value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} placeholder="要完成什么？" /></Field>}
      <CollaborationInput paneKey={paneKey} inputKey={`${storage}:spec`} active={active && composerVisible} label={draft.mode === 'goal' ? '协作目标' : '目标与交付要求'} className={`${input} ${needsTeam && draft.mode === 'goal' ? 'min-h-24' : 'min-h-32'} resize-y text-sm leading-6`} autoFocus={creating} required disabled={busy} value={draft.spec} onUploadChange={uploadChange} onChange={value => setDraft(d => ({ ...d, spec: typeof value === 'function' ? value(d.spec) : value }))} placeholder="例如：完善附件预览体验，交付实现和评审结果，保留现有快捷键。" />
      {draft.mode === 'goal' && needsTeam ? <fieldset disabled={busy || !!provisioned} className="space-y-3"><legend className="mb-2 text-xs text-muted-foreground">首次开始时配置 Agent</legend>
        <Field label="Agent"><select aria-label="协作 Agent" className={input} value={agentSlug} onChange={e => setAgentSlug(e.target.value)}><option value="" disabled>选择已安装的 Agent</option>{agents.map(agent => <option key={agent.slug} value={agent.slug}>{agent.displayName}</option>)}</select></Field>
        <Field label="工作目录"><div className="flex gap-2"><input aria-label="工作目录" className={`${input} min-w-0 flex-1`} value={teamCwd} onChange={e => setTeamCwd(e.target.value)} placeholder="选择项目所在的目录" /><button type="button" className={secondary} onClick={() => setDirectoryPickerOpen(true)}>浏览目录</button></div>{directoryPickerOpen && <Suspense fallback={<p className="text-xs">正在打开目录…</p>}><DirectoryPicker open initialPath={teamCwd.trim() || defaultCwd || "/"} title="选择协作项目目录" onCancel={() => setDirectoryPickerOpen(false)} onConfirm={path => { setTeamCwd(path); setDirectoryPickerOpen(false); }} /></Suspense>}</Field>
        <p className="text-xs leading-5 text-muted-foreground">开始时配置协调者与执行/评审成员，后续目标复用。</p>
        {group.federated && <p role="alert" className="text-xs text-muted-foreground">跨服务组请从成员设置添加 Agent。{onManageMembers && <button type="button" className={secondary} onClick={onManageMembers}>管理成员</button>}</p>}
        {!agents.length && <p role="alert" className="text-xs text-muted-foreground">尚未检测到可启动的 Agent。安装后刷新，或从成员设置复用现有 Agent。{onManageMembers && <button type="button" className={secondary} onClick={onManageMembers}>管理成员</button>}</p>}
      </fieldset> : draft.mode === 'goal' ? <div className="flex items-center gap-3"><span className="shrink-0 text-xs text-muted-foreground">协调者</span><select aria-label="协调者" className={`${input} min-w-0 flex-1`} value={lead} onChange={e => setDraft(d => ({ ...d, coordinator: e.target.value }))}>{members.map(m => <option key={m.sessionId} value={m.sessionId} disabled={!m.agent}>{m.name}{!m.agent ? '（需要启动 Agent）' : ''}</option>)}</select></div> : <Field label="分派给"><select className={input} value={draft.assignee} onChange={e => setDraft(d => ({ ...d, assignee: e.target.value }))}><option value="">先保存，稍后分派</option>{members.map(m => <option key={m.sessionId} value={m.sessionId}>{m.name}</option>)}</select></Field>}
      <details className="border-y border-border/15"><summary className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-muted-foreground">验收标准与更多设置{(draft.acceptance || draft.constraints) && <span className="text-primary">已补充</span>}</summary><div className="space-y-3 pb-4">
        <Field label="验收标准（选填）"><textarea className={`${input} min-h-20 resize-y`} value={draft.acceptance} onChange={e => setDraft(d => ({ ...d, acceptance: e.target.value }))} placeholder="什么结果满足要求？" /></Field>
        <Field label="约束（选填）"><textarea className={`${input} min-h-20 resize-y`} value={draft.constraints} onChange={e => setDraft(d => ({ ...d, constraints: e.target.value }))} placeholder="必须保留什么？哪些操作需要先问你？" /></Field>
        {draft.mode === 'goal' ? <label className="flex min-h-11 items-start gap-2 text-xs leading-5 text-muted-foreground"><input type="checkbox" className="mt-1" checked={draft.isolated} onChange={e => setDraft(d => ({ ...d, isolated: e.target.checked }))} /><span>代码任务使用独立目录<br /><span className="text-[11px]">协调者自动区分查询与代码任务；查询复用成员会话，只有代码需要目录与集成。</span></span></label> : <><Field label="协调者"><select className={input} value={draft.coordinator} onChange={e => setDraft(d => ({ ...d, coordinator: e.target.value }))}><option value="">由用户协调</option>{members.map(m => <option key={m.sessionId} value={m.sessionId}>{m.name}</option>)}</select></Field><Field label="父任务"><select className={input} value={draft.parent} onChange={e => setDraft(d => ({ ...d, parent: e.target.value }))}><option value="">独立任务</option>{tasks.filter(t => !t.workflow).map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select></Field><fieldset className="space-y-1"><legend className="text-xs text-muted-foreground">需先验收的依赖任务</legend>{tasks.filter(t => t.status !== 'closed').map(t => <label key={t.id} className="flex min-h-11 items-center gap-2 text-xs text-foreground"><input type="checkbox" checked={draft.dependencies.includes(t.id)} onChange={e => setDraft(d => ({ ...d, dependencies: e.target.checked ? [...d.dependencies, t.id] : d.dependencies.filter(id => id !== t.id) }))} />{t.title}</label>)}</fieldset></>}
        <button type="button" className={`${button} text-muted-foreground hover:bg-surface-2`} onClick={() => setDraft(d => ({ ...d, mode: d.mode === 'goal' ? 'task' : 'goal' }))}>{draft.mode === 'goal' ? '改为手动分派任务' : '改为自动协作目标'}</button>
      </div></details>
      <button className={`${primary} w-full`} disabled={busy || uploads > 0 || (draft.mode === 'goal' ? !goalReady : !draft.title.trim() || !draft.spec.trim())}>{busy ? <RefreshCw size={14} className="animate-spin" /> : <Send size={14} />}{busy ? preparingTeam ? '正在准备成员…' : '提交中…' : draft.mode === 'goal' ? '开始协作' : draft.assignee ? '创建并分派' : '保存任务'}</button>
      <p className="text-center text-[11px] leading-5 text-muted-foreground">{draft.mode === 'goal' ? '拆分任务 → 执行与独立评审 → 你验收结果' : '草稿自动保存，分派后保留投递与回复记录。'}</p>
    </form> : board && loaded ? <>
      <h3 className="sr-only">任务看板</h3>
      <div className="flex min-h-0 min-w-0 flex-1 gap-5"><div hidden={showDetail} className={`${showDetail ? "hidden" : "flex"} min-h-0 min-w-0 flex-1`}><CollaborationKanban navigation={boardNavigation} settings={boardSettings} action={<button ref={newTaskRef} type="button" className={primary} disabled={busy} onClick={() => setCreating(true)}><Plus size={14} />新目标</button>} storage={storage} tasks={tasks} selectedId={showDetail ? selectedId : null} name={name} onSelect={chooseTask} /></div>
        {showDetail && <aside aria-label="任务详情" className="mx-auto flex min-h-0 min-w-0 w-full max-w-[1040px] flex-col"><nav aria-label="任务位置" className="mb-2 shrink-0"><ol className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <li className="shrink-0"><button type="button" aria-label="返回看板" title="查看此协作组的任务看板" className={`${button} px-2 hover:bg-surface-2`} onClick={returnToBoard}>看板</button></li>
          {ancestors.map(parent => <li key={parent.id} className="flex min-w-0 flex-1 items-center gap-1 sm:max-w-xs sm:flex-none"><ChevronRight aria-hidden="true" size={12} className="shrink-0" /><button type="button" aria-label={`查看${parent.workflow?.kind === 'goal' ? '目标' : '父任务'}：${parent.title}`} title={`查看${parent.workflow?.kind === 'goal' ? '目标' : '父任务'}：${parent.title}`} className={`${button} min-w-0 px-2 hover:bg-surface-2`} onClick={() => chooseTask(parent.id)}><span className="truncate">{parent.workflow?.kind === 'goal' ? '目标' : '父任务'}：{parent.title}</span></button></li>)}
          <li aria-current="page" className="flex shrink-0 items-center gap-1"><ChevronRight aria-hidden="true" size={12} /><span className="px-2">{selectedSummary?.parentTaskId ? '子任务详情' : selectedSummary?.workflow?.kind === 'goal' ? '目标详情' : '任务详情'}</span></li>
        </ol></nav><div className="min-h-0 flex-1">{selected ? <TaskDetail reader paneKey={paneKey} active={active} key={selected.id} task={selected} tasks={tasks} members={members} busy={busy} name={m => name(selected, m)} act={op => act(selected, op)} storage={storage} onSelectTask={chooseTask} onOpenSession={async m => {
          const session = sessions.find(s => s.sessionId === selected.memberSessions[memberKey(m)]);
          if (!session) { setError("成员会话暂不可用，任务历史已保留。"); return; }
          try { await onOpenSession(session); } catch (e) { setError(e instanceof Error ? e.message : "无法打开终端"); }
        }} /> : <p role="status" className="py-8 text-center text-xs text-muted-foreground">正在加载任务详情…</p>}</div></aside>}
      </div>
    </> : !loaded && !tasks.length ? <div role="status" className="space-y-3 py-8"><p className="text-center text-xs text-muted-foreground">{loadError ? '任务暂时无法加载，请重试。' : '正在加载目标…'}</p>{!loadError && [0, 1, 2].map(i => <div key={i} className="h-14 animate-pulse rounded-lg bg-surface-2" />)}</div> : <>
      {(!showDetail || wide) && <header className="flex items-center justify-between gap-2"><div><h3 className="text-base font-semibold text-foreground">协作目标</h3><p className="mt-1 text-[11px] text-muted-foreground">{tasks.filter(t => t.status === 'open' && t.workflow?.kind !== 'step').length} 个进行中 · {tasks.filter(t => t.status === 'accepted' && t.workflow?.kind !== 'step').length} 个已验收</p></div><button ref={newTaskRef} type="button" className={primary} disabled={busy} onClick={() => setCreating(true)}><Plus size={14} />新目标</button></header>}
      <div className={wide && showDetail ? 'grid items-start gap-6 grid-cols-[260px_minmax(0,1fr)]' : ''}>
        {(!showDetail || wide) && <div className="min-w-0 space-y-5">
          <div className="flex items-center gap-2"><select aria-label="任务筛选" className={`${input} min-w-0 flex-1 border-transparent bg-transparent`} value={filter} onChange={e => setFilter(e.target.value)}><option value="open">进行中的目标</option><option value="attention">需要你处理（{attention}）</option><option value="archive">已归档</option><option value="all">全部任务</option></select><button type="button" aria-label="搜索任务" aria-expanded={searching} className={`${button} shrink-0 px-3 text-muted-foreground hover:bg-surface-2`} onClick={() => { setSearching(v => !v); setQuery(''); }}><Search size={16} /></button></div>
          {searching && <input aria-label="搜索任务或负责人" autoFocus className={input} value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索目标、内容或负责人" />}
          {filter === 'open' && attentionTasks.length > 0 && <section aria-label="需要你处理" className="rounded-xl bg-surface-2/40 p-1"><h4 className="flex items-center justify-between px-3 pb-1 pt-3 text-xs font-medium text-primary">需要你处理<span className="rounded-md bg-primary/15 px-2 py-0.5">{attentionTasks.length}</span></h4>{attentionTasks.map(t => taskRow(t, true))}</section>}
          {(filter !== 'open' || matches.some(t => !needsAttention(t)) || matches.length === 0) && <section className="space-y-1"><h4 className="px-3 text-[11px] font-medium text-muted-foreground">{filter === 'attention' ? '需要你处理' : filter === 'archive' ? '已归档' : filter === 'all' ? '全部任务' : '当前目标'}</h4>{matches.filter(t => filter !== 'open' || !needsAttention(t)).map(t => taskRow(t, filter === 'attention'))}
            {!matches.length && <div className="px-3 py-6 text-center text-xs leading-5 text-muted-foreground">{query.trim() ? '没有匹配的任务。' : filter === 'attention' ? '目前没有需要你处理的任务。' : filter === 'archive' ? '还没有归档任务。' : '当前没有进行中的目标。'}{(filter !== 'all' || query) && <button type="button" className={`${button} mt-2 text-primary`} onClick={() => { setFilter('all'); setQuery(''); }}>查看全部任务</button>}</div>}
          </section>}
        </div>}
        {showDetail && <div className="min-w-0">
          {!wide && <button type="button" className={`${button} mb-4 -ml-2 text-muted-foreground hover:bg-surface-2`} onClick={() => setMobileDetail(false)}><ArrowLeft size={14} />全部目标</button>}
          {selected ? <TaskDetail paneKey={paneKey} active={active} key={selected.id} task={selected} tasks={tasks} members={members} busy={busy} name={m => name(selected, m)} act={op => act(selected, op)} storage={storage} onSelectTask={chooseTask} onOpenSession={async m => {
            const session = sessions.find(s => s.sessionId === selected.memberSessions[memberKey(m)]);
            if (!session) { setError('成员会话暂不可用，任务历史已保留。'); return; }
            try { await onOpenSession(session); } catch (e) { setError(e instanceof Error ? e.message : '无法打开终端'); }
          }} /> : <p role="status" className="py-8 text-center text-xs text-muted-foreground">正在加载任务详情…</p>}
        </div>}
      </div>
    </>}
  </section>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block space-y-1.5"><span className="text-xs text-muted-foreground">{label}</span>{children}</label>; }

function TaskDetail({ reader = false, active, paneKey, task, tasks, members, name, busy, act, storage, onOpenSession, onSelectTask }: {
  reader?: boolean; active: boolean; paneKey?: string; task: CollaborationTaskView; tasks: CollaborationTaskView[]; members: OrchestrationSession[]; name: (member: TaskMember | null) => string; busy: boolean;
  act: (input: Omit<TaskOperation, 'idempotencyKey'> & { assigneeSessionId?: string; coordinatorSessionId?: string | null }) => Promise<{ ok: boolean; error?: string }>;
  storage: string; onOpenSession: (member: TaskMember) => Promise<void>; onSelectTask: (id: string) => void;
}) {
  const [assignee, setAssignee] = useState(''), [reviewer, setReviewer] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [editingResult, setEditingResult] = useState(false);
  const [feedbackStatus, setFeedbackStatus] = useState<{ kind: 'comment' | 'revise'; state: 'pending' | 'saved' | 'error'; content: string; error?: string; resultId?: string } | null>(null);
  const feedbackPending = useRef(false);
  const feedbackAlive = useRef(true);
  useEffect(() => { feedbackAlive.current = true; return () => { feedbackAlive.current = false; }; }, []);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const feedbackNoticeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!reader && feedbackStatus && feedbackStatus.state !== 'pending' && active) requestAnimationFrame(() => feedbackNoticeRef.current?.scrollIntoView({ block: 'nearest' }));
  }, [feedbackStatus]);
  const readerRef = useRef<HTMLDivElement>(null);
  const [uploads, setUploads] = useState(0);
  const uploadChange = (delta: number) => setUploads(count => Math.max(0, count + delta));
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { titleRef.current?.focus(); }, []);
  const editKey = `${storage}:${task.id}`;
  const [initialEdit] = useState(() => useCollaborationTaskWorkspace.getState().ensureDetail(editKey, {
    feedback: saved(`${editKey}:feedback`, ''), answers: saved(`${editKey}:answers`, {}), view: 'overview',
  }));
  const { feedback, answers, view } = useCollaborationTaskWorkspace(state => state.details[editKey] ?? initialEdit);
  const setFeedback = taskDetailDispatch(editKey, 'feedback');
  const setAnswers = taskDetailDispatch(editKey, 'answers');
  const setView = taskDetailDispatch(editKey, 'view');
  useEffect(() => { if (readerRef.current) readerRef.current.scrollTop = 0; }, [view]);
  useEffect(() => persist(`${storage}:${task.id}:answers`, answers), [storage, task.id, answers]);
  useEffect(() => persist(`${storage}:${task.id}:feedback`, feedback), [storage, task.id, feedback]);
  const current = task.attempts.find(a => a.id === task.activeAttemptId), open = task.status === 'open';
  const latestResult = task.artifacts.filter(a => a.kind === 'result' && a.attemptId === task.activeAttemptId).at(-1);
  useEffect(() => { if (feedbackStatus?.state === 'saved' && latestResult?.id !== feedbackStatus.resultId) setFeedbackStatus(null); }, [latestResult?.id, feedbackStatus]);
  const latestPlan = task.artifacts.filter(a => a.kind === 'plan' && a.attemptId === task.activeAttemptId).at(-1);
  const revisionPending = latestResult && task.events.some(e => e.kind === 'revise' && e.attemptId === task.activeAttemptId && e.createdAt >= latestResult.createdAt);
  const questions = task.decisions.filter(q => q.status === 'pending' && q.attemptId === task.activeAttemptId);
  const dependencyPending = task.dependsOn.some(id => tasks.find(t => t.id === id)?.status !== 'accepted');
  const reviewPassed = !task.workflow || task.artifacts.filter(a => a.kind === 'review' && a.reviewsArtifactId === latestResult?.id).at(-1)?.verdict === 'pass';
  const children = task.children ?? [];
  const childrenPending = task.workflow?.kind === 'goal' && children.some(t => !['accepted', 'closed'].includes(t.status));
  const context = `任务：${task.title}\n任务 ID：${task.id}\n${task.spec}\n约束：${task.constraints || '未补充'}\n验收标准：${task.acceptance || '由用户决定'}\n${current ? `当前尝试：${current.id}\n负责人：${name(current.assignee)}\n` : ''}${task.artifacts.filter(a => a.attemptId === task.activeAttemptId).map(a => `${a.kind} · 版本 ${a.id} · ${stamp(a.createdAt)}\n${a.summary ? `结果摘要：${a.summary}\n` : ''}${a.content}`).join('\n\n')}\n${questions.map(q => `待回答：${q.question}`).join('\n')}`;
  const exportRecord = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(task, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `termdock-task-${task.id}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const latestCoordination = task.events.filter(e => e.kind === 'coordinate').at(-1);
  const visibleArtifacts = view === 'results' ? task.artifacts.slice().reverse() : task.artifacts.filter(a => a.id === latestResult?.id || a.id === latestPlan?.id && task.approvedPlanArtifactId !== a.id || a.kind === 'review' && a.reviewsArtifactId === latestResult?.id).sort((a, b) => (a.kind === 'result' ? -1 : 1) - (b.kind === 'result' ? -1 : 1) || b.createdAt - a.createdAt);
  const acceptedChildren = children.filter(c => c.status === 'accepted').length;
  const activeChildren = children.filter(c => c.status !== 'closed');
  const acceptBlocker = revisionPending ? '等待新结果通过评审后可验收。' : questions.length ? '回答当前问题后可验收。' : dependencyPending ? '依赖任务验收后可验收。' : !reviewPassed ? '独立评审通过后可验收。' : childrenPending ? '子任务完成并通过评审后可验收。' : null;
  const showFeedback = () => { setView('overview'); setEditingResult(true); requestAnimationFrame(() => { feedbackRef.current?.scrollIntoView({ block: 'nearest' }); feedbackRef.current?.querySelector('textarea')?.focus(); }); };
  const submitFeedback = async (kind: 'comment' | 'revise') => {
    if (busy || uploads || !feedback.trim() || feedbackPending.current) return;
    const submitted = feedback;
    feedbackPending.current = true;
    setFeedbackStatus({ kind, state: 'pending', content: submitted, resultId: latestResult?.id });
    const result = await act({ kind, content: submitted });
    feedbackPending.current = false;
    if (result.ok) {
      // An expanded view can edit the shared draft while this request is in flight.
      setFeedback(value => value === submitted ? '' : value);
      persist(`${editKey}:feedback`, useCollaborationTaskWorkspace.getState().details[editKey]?.feedback ?? '');
      if (!feedbackAlive.current) return;
      setFeedbackStatus({ kind, state: 'saved', content: submitted, resultId: latestResult?.id });
      if (reader && useCollaborationTaskWorkspace.getState().details[editKey]?.feedback === '') setEditingResult(false);
    } else if (feedbackAlive.current) setFeedbackStatus({ kind, state: 'error', content: submitted, error: result.error, resultId: latestResult?.id });
  };
  const content = (text: string) => <Suspense fallback={<p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">{text}</p>}><TaskContent content={text} /></Suspense>;
  const renderArtifact = (artifact: CollaborationTaskView['artifacts'][number]) => { const presentation = collaborationResultPresentation(artifact.content, artifact.summary); return <section key={artifact.id} className="space-y-3 rounded-xl border border-border/20 bg-surface-2/30 p-4">
    <header className="flex flex-wrap items-center gap-2"><h4 className="min-w-0 flex-1 text-sm font-semibold text-foreground">{artifact.kind === 'result' ? revisionPending && artifact.id === latestResult?.id ? '上一版结果' : '交付结果' : artifact.kind === 'plan' ? task.approvedPlanArtifactId === artifact.id ? '已确认的方案' : '方案' : '独立评审'}</h4>{artifact.verdict && <span className={`rounded-md px-2 py-1 text-[11px] ${artifact.verdict === 'pass' ? 'bg-primary/10 text-primary' : 'bg-surface-2 text-foreground'}`}>{artifact.verdict === 'pass' ? '通过' : artifact.verdict === 'changes' ? '需要修改' : '受阻'}</span>}{task.acceptedArtifactId === artifact.id && <span className="text-xs text-primary">{task.completionMode === 'reviewed' ? '评审通过' : '已验收'}</span>}{task.approvedPlanArtifactId === artifact.id && <span className="text-xs text-primary">方案已确认</span>}</header>
    <p className="text-[11px] text-muted-foreground">{name(artifact.actor)} · {stamp(artifact.createdAt)}{artifact.attemptId !== task.activeAttemptId && artifact.kind !== 'review' ? ' · 历史分派' : ''}</p>
    {artifact.kind === 'result' && presentation.condensed ? <><div aria-label="结果结论" className="text-base leading-7">{content(!presentation.explicit && !presentation.summary.includes('\n') ? presentation.summary.replace(/([。；])\s*(?=\S)/g, '$1\n\n') : presentation.summary)}</div>{presentation.limitations && <div className="border-l-2 border-border/40 pl-3"><h5 className="mb-1 text-xs font-medium text-muted-foreground">适用范围与限制</h5>{content(presentation.limitations)}</div>}<details><summary className="min-h-11 cursor-pointer py-3 text-xs text-muted-foreground">完整报告与原始证据</summary><div className="space-y-3 pb-3">{content(artifact.content)}</div></details></> : content(artifact.content)}
    {artifact.evidence !== undefined && <details className="text-xs text-muted-foreground"><summary className="min-h-11 cursor-pointer py-3">交付证据</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-3 text-[11px]">{JSON.stringify(artifact.evidence, null, 2)}</pre></details>}
    {open && artifact.attemptId === task.activeAttemptId && artifact.kind !== 'review' && (!reader || artifact.kind === 'plan' || !task.workflow) && <div className="space-y-2 border-t border-border/15 pt-3">
      {!reader && latestResult?.id === artifact.id && task.workflow?.kind !== 'step' && <><button type="button" className={`${primary} w-full`} disabled={busy || !!acceptBlocker} onClick={() => void act({ kind: 'accept', artifactId: artifact.id })}><Check size={14} />验收此结果</button>{acceptBlocker && <p className="text-xs leading-5 text-muted-foreground">{acceptBlocker}</p>}</>}
      {latestPlan?.id === artifact.id && task.approvedPlanArtifactId !== artifact.id && <button type="button" className={`${primary} w-full`} disabled={busy} onClick={() => void act({ kind: 'approve-plan', artifactId: artifact.id })}><Check size={14} />确认方案并继续</button>}
      {!task.workflow && <details><summary className="min-h-11 cursor-pointer py-3 text-xs text-muted-foreground">请其他成员评审此版本</summary><div className="space-y-2"><select aria-label="独立评审成员" className={input} value={reviewer} onChange={e => setReviewer(e.target.value)}><option value="">选择独立评审成员</option>{members.filter(m => m.sessionId !== task.memberSessions[memberKey(artifact.actor)]).map(m => <option key={m.sessionId} value={m.sessionId}>{m.name}</option>)}</select><button type="button" className={secondary} disabled={busy || !reviewer || reviewer === task.memberSessions[memberKey(artifact.actor)]} onClick={() => void act({ kind: 'request-review', artifactId: artifact.id, assigneeSessionId: reviewer })}>请求评审</button></div></details>}
    </div>}
  </section>; };
  return <article className={reader ? "flex h-full min-h-0 flex-col" : "space-y-5"}>
    <div ref={readerRef} data-task-reader-scroll className={reader ? "min-h-0 flex-1 space-y-4 overflow-auto pb-5 pr-1" : "contents"}>
    <header className="space-y-2">
      {!reader && task.parentTaskId && <button type="button" className={`${button} -ml-2 max-w-full text-muted-foreground hover:bg-surface-2`} onClick={() => onSelectTask(task.parentTaskId!)}><span className="truncate">所属任务：{tasks.find(t => t.id === task.parentTaskId)?.title ?? '查看父任务'}</span><ArrowUpRight size={13} className="shrink-0" /></button>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><h3 ref={titleRef} tabIndex={-1} className="break-words text-lg font-semibold leading-7 text-foreground outline-none">{task.title}</h3>
      <span className={`inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs ${needsAttention(task) ? 'bg-primary/10 text-primary' : 'bg-surface-2 text-muted-foreground'}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{taskStage(task)}</span></div>
      {!questions.length && !latestResult && task.spec.trim() !== task.title.trim() && <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">{task.spec}</p>}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground"><span>{task.workflow?.kind === 'goal' ? `协调者 · ${name(task.coordinator)}` : current ? `负责人 · ${name(current.assignee)}` : '尚未分派'}</span>{current && <button type="button" className={`${button} px-2 text-muted-foreground hover:bg-surface-2 hover:text-primary`} onClick={() => void onOpenSession(current.assignee)}><ExternalLink size={13} />打开终端</button>}</div>
      {task.replica && <p className="text-[11px] leading-5 text-muted-foreground">此记录由来源服务同步，回答与决定会送回来源服务。</p>}
    </header>
    <nav aria-label="任务详情" className="flex gap-4 border-b border-border/20">{([['overview', reader && latestResult ? '结果' : '概览'], ['results', reader ? '历史交付' : `交付${task.artifacts.length ? ` ${task.artifacts.length}` : ''}`], ['activity', '动态']] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={view === id} className={`min-h-11 border-b-2 px-1 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${view === id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`} onClick={() => setView(id)}>{label}</button>)}</nav>
    {view === 'overview' && <>
      {(() => { const followup = task.events.filter(e => e.kind === 'revise' && e.source === 'user' && e.attemptId === task.activeAttemptId).at(-1); if (!followup) return null; const receipt = task.deliveries.find(d => d.id === followup.deliveryId); const queued = task.outbox.find(d => d.id === followup.deliveryId); const updated = latestResult && latestResult.createdAt > followup.createdAt; return <section aria-label="最近跟进" className="space-y-1 rounded-lg bg-primary/10 px-3 py-2 text-xs leading-5"><p className="font-medium text-primary">{updated ? reviewPassed ? '新结果已通过独立评审' : '新结果已交付，等待独立评审' : '已要求继续跟进，等待新结果'}</p><p className="whitespace-pre-wrap break-words text-foreground">{followup.content}</p><p className="text-muted-foreground">{stamp(followup.createdAt)}{receipt?.status === 'delivered' ? ` · 已写入${followup.target ? name(followup.target) : '成员'}终端${receipt.deliveredAt ? ` · ${stamp(receipt.deliveredAt)}` : ''}` : ['failed', 'expired'].includes(receipt?.status ?? '') || receipt?.error || queued?.lastError ? ' · 投递未成功，服务端继续重试' : followup.deliveryId ? ' · 等待写入终端' : ' · 要求已保存'}</p></section>; })()}

      {questions.map(q => <form key={q.id} className="space-y-3 rounded-xl border border-border/30 bg-surface-2/40 p-4" onSubmit={e => { e.preventDefault(); if (!busy && !uploads && answers[q.id]?.trim()) void act({ kind: 'answer', decisionId: q.id, content: answers[q.id] }); }}><div className="flex items-center gap-2 text-xs font-medium text-primary"><MessageCircle size={14} />需要你的决定</div><p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">{q.question}</p>{!!q.options.length && <div className="flex flex-col gap-2">{q.options.map((option, index) => <button type="button" key={index} aria-pressed={answers[q.id] === option} disabled={busy} className={`${button} justify-start text-left ${answers[q.id] === option ? 'bg-primary/15 text-primary' : 'bg-surface-2 text-foreground'}`} onClick={() => setAnswers(a => ({ ...a, [q.id]: option }))}>{answers[q.id] === option ? <Check size={14} className="shrink-0" /> : <Circle size={14} className="shrink-0" />}<span className="break-words">{option}</span></button>)}</div>}<CollaborationInput paneKey={paneKey} inputKey={`${editKey}:answer:${q.id}`} active={active} label="你的回答" className={`${input} min-h-20 resize-y`} required disabled={busy} value={answers[q.id] ?? ''} onUploadChange={uploadChange} onChange={value => setAnswers(a => ({ ...a, [q.id]: typeof value === 'function' ? value(a[q.id] ?? '') : value }))} placeholder="选择建议，或写下你的决定…" /><button className={`${primary} w-full`} disabled={busy || uploads > 0 || !answers[q.id]?.trim()}><Send size={14} />回复并继续</button><p className="text-[11px] text-muted-foreground">{stamp(q.createdAt)} · 回答会保存在任务记录中</p></form>)}
      {task.automationIssue && open && <section role="alert" className="space-y-3 rounded-xl bg-destructive/10 p-4"><h4 className="text-sm font-medium text-destructive">需要处理一个异常</h4><p className="whitespace-pre-wrap break-words text-xs leading-5 text-foreground">{task.automationIssue}</p><button type="button" className={secondary} disabled={busy} onClick={() => void act({ kind: 'retry' })}><RefreshCw size={13} />重试并继续协调</button></section>}
      {task.workflow?.paused && open && <section className="space-y-2 rounded-xl bg-surface-2 p-3"><p className="text-xs leading-5 text-muted-foreground">后续安排已暂停，已投递的终端工作继续保留。</p><button type="button" className={secondary} disabled={busy} onClick={() => void act({ kind: 'resume' })}>继续安排</button></section>}
      {visibleArtifacts.map(artifact => artifact.kind === 'review' ? <details key={artifact.id} className="rounded-lg border border-border/20 px-3"><summary className="min-h-11 cursor-pointer py-3 text-xs text-muted-foreground">独立评审 · {artifact.verdict === 'pass' ? '通过' : artifact.verdict === 'changes' ? '要求修改' : '受阻'} · {name(artifact.actor)}</summary>{renderArtifact(artifact)}</details> : renderArtifact(artifact))}
      {latestCoordination && !latestResult && <section className="space-y-2"><h4 className="flex items-center gap-2 text-xs font-medium text-foreground">协调者更新<span className="ml-auto text-[11px] font-normal text-muted-foreground">{stamp(latestCoordination.createdAt)}</span></h4><div className="rounded-xl bg-surface-2/50 p-3">{content(latestCoordination.content)}</div></section>}
      {!latestCoordination && current?.report && !latestResult && <section className="space-y-2"><h4 className="text-xs font-medium text-foreground">最近报告<span className="ml-2 text-[11px] font-normal text-muted-foreground">{stamp(current.report.createdAt)}</span></h4>{content(current.report.content)}</section>}
      {!!children.length && <section className="space-y-3"><header className="flex items-center justify-between"><h4 className="text-xs font-medium text-foreground">子任务</h4><span className="text-[11px] text-muted-foreground">{acceptedChildren}/{activeChildren.length} 已验收</span></header><div className="divide-y divide-border/15">{children.map(child => { const summary = tasks.find(t => t.id === child.id); const pending = summary && needsAttention(summary); return <button type="button" key={child.id} className="flex min-h-11 w-full items-start gap-3 rounded-lg px-1 py-3 text-left transition hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" onClick={() => onSelectTask(child.id)}>{child.status === 'accepted' ? <CircleCheck size={16} className="mt-0.5 shrink-0 text-primary" /> : <Circle size={16} className="mt-0.5 shrink-0 text-muted-foreground" />}<span className="min-w-0 flex-1"><span className="block break-words text-sm leading-5 text-foreground">{child.title}</span><span className={`mt-1 block text-[11px] ${pending ? 'text-primary' : 'text-muted-foreground'}`}>{summary ? taskStage(summary) : child.status === 'accepted' ? child.completionMode === 'reviewed' ? '独立评审通过' : '已验收' : child.status === 'closed' ? '已关闭' : '等待报告'}</span></span><ChevronRight size={14} className="mt-1 shrink-0 text-muted-foreground" /></button>; })}</div></section>}
      {!!task.dependsOn.length && <section><h4 className="mb-2 text-xs font-medium text-foreground">依赖任务</h4>{task.dependsOn.map(id => <button type="button" key={id} className={`${button} w-full justify-start text-left text-muted-foreground hover:bg-surface-2`} onClick={() => onSelectTask(id)}><span className="min-w-0 flex-1 break-words">{tasks.find(t => t.id === id)?.title ?? id}</span><span className="shrink-0 text-[11px]">{tasks.find(t => t.id === id)?.status === 'accepted' ? '已验收' : '待验收'}</span></button>)}</section>}
      {open && !current && !task.scheduledAssignee && <section className="space-y-3 rounded-xl bg-surface-2/50 p-4"><Field label="分派给"><select className={input} value={assignee} onChange={e => setAssignee(e.target.value)}><option value="">选择负责人</option>{members.map(m => <option key={m.sessionId} value={m.sessionId}>{m.name}</option>)}</select></Field><button type="button" className={`${primary} w-full`} disabled={busy || !assignee || dependencyPending} onClick={() => void act({ kind: 'assign', assigneeSessionId: assignee })}>分派任务</button>{dependencyPending && <p className="text-xs text-muted-foreground">依赖任务验收后可分派。</p>}</section>}
      {!questions.length && !latestCoordination && !current?.report && !visibleArtifacts.length && !children.length && <div className="rounded-xl bg-surface-2/40 p-4"><h4 className="text-sm font-medium text-foreground">{open ? '等待第一条更新' : '任务记录已保留'}</h4><p className="mt-2 text-xs leading-5 text-muted-foreground">{open ? '成员明确回复后，报告、问题和交付会出现在这里。' : '可在动态中查看分派与决定。'}</p></div>}
    </>}
    {view === 'results' && <div className="space-y-4">{visibleArtifacts.length ? visibleArtifacts.map(renderArtifact) : <p className="py-8 text-center text-xs leading-5 text-muted-foreground">还没有交付。方案、结果和独立评审会保存在这里。</p>}</div>}
    {view === 'activity' && <section aria-label="任务动态"><ol className="space-y-5">{task.events.slice().reverse().map(event => <li key={event.id} className="relative border-l border-border/30 pl-4"><span className="absolute -left-1 top-1 h-2 w-2 rounded-full bg-border" /><p className="text-xs font-medium text-foreground">{eventLabels[event.kind] ?? event.kind}{event.reportStatus ? ` · ${labels[event.reportStatus]}` : ''}</p><p className="mt-1 text-[11px] text-muted-foreground">{event.source === 'system' ? '服务自动接续' : name(event.actor)} · {stamp(event.createdAt)}{event.attemptId && event.attemptId !== task.activeAttemptId ? ' · 历史分派' : ''}</p><div className="mt-2">{content(event.content)}</div>{event.target && <p className="mt-1 text-[11px] text-muted-foreground">接收人：{name(event.target)}</p>}</li>)}</ol>{!task.events.length && <p className="py-8 text-center text-xs text-muted-foreground">还没有动态记录。</p>}</section>}
    {open && view !== 'activity' && (!reader || !latestResult) && <section ref={feedbackRef} className="space-y-2 border-t border-border/20 pt-4"><CollaborationInput paneKey={paneKey} inputKey={`${editKey}:feedback`} active={active} label="补充说明或修改要求" className={`${input} min-h-20 resize-y text-sm leading-6`} disabled={busy} value={feedback} onUploadChange={uploadChange} onChange={setFeedback} placeholder="补充上下文，或写下需要修改的地方…" />
      <div className="flex flex-wrap items-center gap-2"><button type="button" className={secondary} disabled={busy || uploads > 0 || !feedback.trim()} onClick={() => void submitFeedback('comment')}>{feedbackStatus?.state === 'pending' && feedbackStatus.kind === 'comment' ? <RefreshCw size={13} className="animate-spin" /> : <Send size={13} />}{feedbackStatus?.state === 'pending' && feedbackStatus.kind === 'comment' ? '正在发送…' : '发送补充'}</button><button type="button" className={secondary} disabled={busy || uploads > 0 || !current || !feedback.trim()} onClick={() => void submitFeedback('revise')}>{feedbackStatus?.state === 'pending' && feedbackStatus.kind === 'revise' && <RefreshCw size={13} className="animate-spin" />}{feedbackStatus?.state === 'pending' && feedbackStatus.kind === 'revise' ? '正在提交…' : '要求修改'}</button></div>
      {feedbackStatus && <div ref={feedbackNoticeRef} role={feedbackStatus.state === 'error' ? 'alert' : 'status'} className={`rounded-lg px-3 py-2 text-xs leading-5 ${feedbackStatus.state === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'}`}>
        {feedbackStatus.state === 'pending' ? '正在保存，请稍候…' : feedbackStatus.state === 'error' ? `未确认保存：${feedbackStatus.error}。内容已保留，可重试。` : <><p>{feedbackStatus.kind === 'comment' ? '补充已保存，服务端将继续投递。' : '修改要求已保存，等待新结果后可验收。'}</p><p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-foreground/80">{feedbackStatus.content}</p><button type="button" className="mt-1 min-h-11 text-primary underline underline-offset-4" onClick={() => setView('activity')}>查看任务动态</button></>}
      </div>}
      {!feedbackStatus && <p className="text-[11px] leading-5 text-muted-foreground">发送补充会保留当前结果；需要更新结果时，请选择“要求修改”。</p>}
    </section>}
    <details className="border-t border-border/20"><summary className="min-h-11 cursor-pointer py-3 text-xs text-muted-foreground">任务管理与诊断</summary><div className="space-y-4 pb-4">
      {<details><summary className="min-h-11 cursor-pointer py-3 text-xs text-muted-foreground">完整目标与验收标准</summary>{content(task.spec)}{task.acceptance && content(task.acceptance)}{task.constraints && content(task.constraints)}</details>}
      {task.workflow && open && <div className="flex items-center justify-between gap-2"><p className="text-xs text-muted-foreground">后续执行与评审安排</p><button type="button" className={secondary} disabled={busy} onClick={() => void act({ kind: task.workflow!.paused ? 'resume' : 'pause' })}>{task.workflow.paused ? '继续安排' : '暂停安排'}</button></div>}
      {task.workspace && <details><summary className="min-h-11 cursor-pointer py-3 text-xs text-muted-foreground">交付目录与分支</summary><p className="select-text break-all text-xs text-foreground">{task.workspace.cwd}<br />{task.workspace.branch}</p><p className="mt-2 text-[11px] leading-5 text-muted-foreground">基于已提交代码创建；合并到原分支或发布需另行操作。</p></details>}
      {open && <>{current && task.workflow?.kind !== 'goal' && <div className="space-y-2"><select aria-label="任务负责人" className={input} value={assignee} onChange={e => setAssignee(e.target.value)}><option value="">选择负责人</option>{members.map(m => <option key={m.sessionId} value={m.sessionId}>{m.name}</option>)}</select><button type="button" className={secondary} disabled={busy || !assignee || dependencyPending} onClick={() => void act({ kind: 'assign', assigneeSessionId: assignee, content: feedback || undefined })}>开始新一轮分派</button><p className="text-[11px] leading-5 text-muted-foreground">{dependencyPending ? '依赖任务验收后可分派。' : '新分派保留旧记录，并结束旧问题的回答入口。'}</p></div>}<Field label="协调者"><select className={input} disabled={busy || task.workflow?.kind === 'step'} value={task.coordinator ? task.memberSessions[memberKey(task.coordinator)] ?? '' : ''} onChange={e => void act({ kind: 'coordinator', coordinatorSessionId: e.target.value || null })}>{!task.workflow && <option value="">由用户协调</option>}{members.map(m => <option key={m.sessionId} value={m.sessionId}>{m.name}</option>)}</select></Field><button type="button" className={`${button} text-muted-foreground hover:bg-surface-2`} disabled={busy} onClick={() => void act({ kind: 'close', content: feedback || undefined })}>关闭此任务</button><p className="text-[11px] leading-5 text-muted-foreground">关闭会保留历史和成员的终端工作。</p></>}
      {!open && <button type="button" className={secondary} disabled={busy} onClick={() => void act({ kind: 'reopen' })}>重新打开任务</button>}
      <details><summary className="min-h-11 cursor-pointer py-3 text-xs text-muted-foreground">投递凭证与执行尝试 · {task.attempts.length} 轮</summary><div className="space-y-3 text-xs leading-5 text-muted-foreground">{task.outbox.map(o => <p key={o.id} className="break-words">{o.lastError ? `等待重试：${o.lastError}` : '已保存 · 等待投递'}{o.messageId ? ` · 消息 ${o.messageId}` : ''}</p>)}{task.attempts.map(a => <div key={a.id}><p>{a.id === task.activeAttemptId ? '当前分派' : '历史分派'} · {name(a.assignee)} · {stamp(a.createdAt)}</p><p className="mt-1 break-all font-mono text-[11px]">尝试 ID：{a.id}</p><p className="mt-1">{a.deliveryStatus === 'delivered' ? `已写入终端 · ${a.deliveredAt ? stamp(a.deliveredAt) : ''}` : a.deliveryStatus === 'failed' || a.deliveryStatus === 'expired' ? '本次消息投递未成功' : '等待写入终端'}{a.report ? ` · ${labels[a.report.status]}（${stamp(a.report.createdAt)}）` : ''}</p></div>)}{task.deliveries.filter(d => d.kind !== 'task').map(d => <p key={d.id} className="break-all">后续消息 {d.messageId} · {d.status === 'delivered' ? '已写入终端' : '等待投递'}{d.deliveredAt ? ` · ${stamp(d.deliveredAt)}` : ''}</p>)}<p className="text-[11px]">投递凭证确认终端写入；报告保留成员原始陈述。</p></div></details>
      <p className="select-text break-all text-[11px] text-muted-foreground">任务：{task.id}<br />来源服务：{task.ownerServiceId}<br />版本：{task.revision}</p>
      <div className="flex flex-wrap gap-2"><button type="button" className={secondary} onClick={() => { void Promise.resolve().then(() => navigator.clipboard.writeText(context)).then(() => setCopyStatus('任务上下文已复制。')).catch(() => setCopyStatus('复制失败，可导出任务记录。')); }}>复制上下文</button><button type="button" className={secondary} onClick={exportRecord}>导出记录</button>{copyStatus && <span role="status" className="self-center text-[11px] text-muted-foreground">{copyStatus}</span>}</div>
    </div></details>
    </div>
    {reader && latestResult && task.status !== 'closed' && <footer role="region" aria-label="结果验收" className="shrink-0 space-y-2 border-t border-border/25 bg-[var(--chrome-bg)] py-3 [padding-bottom:max(0.75rem,env(safe-area-inset-bottom))]">
      {editingResult ? <div ref={feedbackRef} className="space-y-2">
        <CollaborationInput paneKey={paneKey} inputKey={`${editKey}:feedback`} active={active} label="跟进要求" className={`${input} min-h-20 max-h-32 resize-none text-sm leading-6`} disabled={busy} value={feedback} onUploadChange={uploadChange} onChange={setFeedback} placeholder="说明哪里不满意，或写下接下来要完成的事…" />
        <div className="flex items-center gap-2"><button type="button" className={secondary} disabled={busy || uploads > 0} onClick={() => setEditingResult(false)}>取消，保留草稿</button><button type="button" className={`${primary} ml-auto`} disabled={busy || uploads > 0 || !current || !feedback.trim()} onClick={() => void submitFeedback('revise')}>{feedbackStatus?.state === 'pending' ? <RefreshCw size={14} className="animate-spin" /> : <Send size={14} />}{feedbackStatus?.state === 'pending' ? '正在发送…' : '发送并继续跟进'}</button></div>
      </div> : <div className="flex items-center gap-2"><button type="button" className={`${secondary} flex-1 sm:flex-none`} disabled={busy} onClick={showFeedback}>{feedback.trim() ? '继续跟进 · 有草稿' : '继续跟进'}</button>{view !== 'overview' ? <button type="button" className={`${primary} ml-auto flex-1 sm:flex-none`} onClick={() => setView('overview')}>返回当前结果</button> : open && task.workflow?.kind !== 'step' ? <button type="button" className={`${primary} ml-auto flex-1 sm:flex-none`} disabled={busy || uploads > 0 || !!acceptBlocker || feedbackStatus?.state === 'saved' && feedbackStatus.kind === 'revise' && feedbackStatus.resultId === latestResult.id} onClick={() => void act({ kind: 'accept', artifactId: latestResult.id })}><Check size={14} />验收此结果</button> : <span className="ml-auto text-xs text-muted-foreground">{task.status === 'accepted' ? task.completionMode === 'reviewed' ? '已通过独立评审' : '已验收' : '由独立评审验收'}</span>}</div>}
      {feedbackStatus && <div role={feedbackStatus.state === 'error' ? 'alert' : 'status'} className={`text-xs leading-5 ${feedbackStatus.state === 'error' ? 'text-destructive' : 'text-primary'}`}>{feedbackStatus.state === 'pending' ? '正在保存跟进要求…' : feedbackStatus.state === 'error' ? `未确认保存：${feedbackStatus.error}。内容已保留，可重试。` : '跟进要求已保存，等待新结果。'}</div>}
      {!editingResult && open && acceptBlocker && feedbackStatus?.state !== 'saved' && <p className="text-xs leading-5 text-muted-foreground">{acceptBlocker}</p>}
    </footer>}

  </article>;
}
