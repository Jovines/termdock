import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ExternalLink, Plus, RefreshCw, Search } from 'lucide-react';
import { collaborationTaskStage as taskStage, collaborationTaskNeedsAttention as needsAttention, taskReportLabels as labels } from '../../collaboration/taskState';
import { useCollaborationTaskInbox } from '../../stores/useCollaborationTaskInbox';
import { collaborationMemberLabel } from '../../collaboration/display';
import { createCollaborationTask, getCollaborationTask, listCollaborationTasks, updateCollaborationTask,
  type CollaborationGroup, type CollaborationTaskView, type OrchestrationSession, type TaskMember, type TaskOperation } from '../../terminal/api';

const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-xs transition disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary';
const input = 'w-full min-h-11 rounded-lg border border-border/30 bg-surface-2 px-3 py-2 text-xs text-foreground outline-none focus:border-primary';
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
type Draft = { mode: 'goal' | 'task'; isolated: boolean; title: string; spec: string; constraints: string; acceptance: string; assignee: string; coordinator: string; parent: string; dependencies: string[] };
const emptyDraft: Draft = { mode: 'goal', isolated: true, title: '', spec: '', constraints: '', acceptance: '', assignee: '', coordinator: '', parent: '', dependencies: [] };
function savedDraft(key: string): Draft {
  const draft = { ...emptyDraft, ...saved(key, emptyDraft) };
  if (!draft || !Array.isArray(draft.dependencies) || draft.dependencies.some(id => typeof id !== 'string')
    || Object.keys(emptyDraft).some(key => !['dependencies', 'isolated'].includes(key) && typeof draft[key as keyof Draft] !== 'string')) return emptyDraft;
  return { ...draft, mode: draft.mode === 'task' ? 'task' : 'goal', isolated: draft.isolated !== false };
}

export function CollaborationTaskWorkbench({ group, sessions, active, onOpenSession, onAttentionChange }: {
  onAttentionChange?: (count: number) => void;
  group: CollaborationGroup; sessions: OrchestrationSession[]; active: boolean; onOpenSession: (session: OrchestrationSession) => Promise<void>;
}) {
  const storage = `termdock:tasks:${location.origin}:${group.id}`;
  const [tasks, setTasks] = useState<CollaborationTaskView[]>([]);
  const [detail, setDetail] = useState<CollaborationTaskView | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => saved(`${storage}:selected`, null));
  const [mobileDetail, setMobileDetail] = useState(false);
  const [wide, setWide] = useState(false);
  const [searching, setSearching] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const newTaskRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const node = sectionRef.current;
    if (!node) return;
    const observer = new ResizeObserver(entries => setWide(entries[0].contentRect.width >= 760));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const [filter, setFilter] = useState('open');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Draft>(() => savedDraft(`${storage}:draft`));
  const alive = useRef(true), requestKeys = useRef(new Map<string, string>()), polling = useRef(false);
  const rawMembers = group.sessionIds.flatMap(id => { const session = sessions.find(s => s.sessionId === id); return session ? [session] : []; });
  const members = rawMembers.map(session => ({ ...session, name: collaborationMemberLabel(session, rawMembers) }));
  const preferredLead = draft.coordinator || saved<string>(`${storage}:lead`, '');
  const lead = members.find(s => s.sessionId === preferredLead)?.sessionId || members.find(s => s.agent)?.sessionId || members[0]?.sessionId || '';
  const workers = members.filter(s => s.sessionId !== lead && s.agent).map(s => s.sessionId);
  const goalReady = !!draft.spec.trim() && !!members.find(s => s.sessionId === lead)?.agent && workers.length > 0;
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
    void getCollaborationTask(selectedSummary.id).then(result => { if (!cancelled) setDetail(result.task); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : '任务详情加载失败'); });
    return () => { cancelled = true; };
  }, [active, selectedSummary?.id, selectedSummary?.revision, detail?.id, detail?.revision]);
  const refresh = async () => {
    if (polling.current) return;
    polling.current = true;
    try { const result = await listCollaborationTasks(group.id); if (alive.current) { setTasks(result.tasks); setLoaded(true); setError(null); } }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '任务加载失败'); }
    finally { polling.current = false; }
  };
  useEffect(() => {
    if (!active) return;
    void refresh();
    const tick = () => { if (!document.hidden) void refresh(); };
    const timer = setInterval(tick, 2500);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
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
    if (busy) return;
    setBusy(true); setError(null); setNotice('');
    const payload = { ...operation, expectedRevision: task.revision };
    try {
      const result = await updateCollaborationTask(task.id, { ...payload, idempotencyKey: keyFor([task.id, payload]) });
      finishRequest([task.id, payload]);
      void useCollaborationTaskInbox.getState().refresh();
      if (alive.current) {
        setTasks(list => list.map(t => t.id === result.task.id ? result.task : t));
        setDetail(result.task);
        setNotice(operation.kind === 'answer' ? '回答已保存，服务端继续投递。' : operation.kind === 'accept' ? '已验收此版本结果。' : '记录已保存。');
      }
    } catch (e) { if (alive.current) { setError(e instanceof Error ? e.message : '操作失败'); void refresh(); } }
    finally { if (alive.current) setBusy(false); }
  };
  const create = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(null);
    const managed = draft.mode === 'goal';
    const payload = { groupId: group.id, title: draft.title.trim() || draft.spec.trim().split('\n')[0].slice(0, 100), spec: draft.spec, constraints: draft.constraints, acceptance: draft.acceptance,
      assigneeSessionId: managed ? undefined : draft.assignee || undefined, coordinatorSessionId: managed ? lead : draft.coordinator || undefined,
      parentTaskId: managed ? undefined : draft.parent || undefined, dependsOn: managed ? [] : draft.dependencies,
      managed, isolated: draft.isolated, reviewerSessionIds: managed ? workers : undefined };
    try {
      const { task } = await createCollaborationTask({ ...payload, idempotencyKey: keyFor(payload) });
      finishRequest(payload);
      if (alive.current) { setTasks(list => [task, ...list.filter(t => t.id !== task.id)]); setSelectedId(task.id); setMobileDetail(true);
        setDetail(task);
        if (managed) persist(`${storage}:lead`, lead);
        setDraft(emptyDraft); setCreating(false); setFilter('open'); setQuery(''); setNotice(managed ? '目标已提交，协调者收到后开始拆分与分派。后续评审和依赖由服务接续。' : '任务已保存。分派后由服务端持续投递。'); }
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '创建失败'); }
    finally { if (alive.current) setBusy(false); }
  };
  const name = (task: CollaborationTaskView, member: TaskMember | null) => {
    if (!member) return '用户';
    const sessionId = task.memberSessions[memberKey(member)];
    return members.find(s => s.sessionId === sessionId)?.name ?? sessions.find(s => s.sessionId === sessionId)?.name ?? member.sessionId;
  };
  const matches = tasks.filter(t => (filter === 'all' ? true : filter === 'archive' ? t.status !== 'open' : t.status === 'open')
    && (filter === 'all' || filter === 'attention' || t.workflow?.kind !== 'step')
    && (filter !== 'attention' || needsAttention(t))
    && (!query.trim() || `${t.title} ${t.spec} ${t.attempts.map(a => name(t, a.assignee)).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase())));
  const attention = tasks.filter(needsAttention).length;
  useEffect(() => { onAttentionChange?.(attention); }, [attention, onAttentionChange]);
  const showDetail = !!selectedSummary && (wide || mobileDetail);
  const closeDraft = () => { setCreating(false); requestAnimationFrame(() => newTaskRef.current?.focus()); };
  return <section ref={sectionRef} aria-label="协作任务" className="space-y-3">
    {error && <div role="alert" className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"><span className="min-w-0 flex-1 break-words">{error}{loaded ? ' · 显示最近保存的记录' : ''}</span><button type="button" className={button} onClick={() => void refresh()}><RefreshCw size={14} />刷新</button></div>}
    {notice && <p role="status" className="text-xs text-primary">{notice}</p>}
    {creating ? <form onSubmit={event => void create(event)} className="space-y-3" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) closeDraft(); } }}>
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 bg-surface py-1">
        <button type="button" className={`${button} text-muted-foreground hover:bg-surface-2`} disabled={busy} onClick={closeDraft}><ArrowLeft size={14} />返回</button>
        <h4 className="min-w-0 flex-1 text-sm font-medium text-foreground">{draft.mode === 'goal' ? '交给协作组' : '手动任务'}</h4>
        <button className={primary} disabled={busy || (draft.mode === 'goal' ? !goalReady : !draft.title.trim() || !draft.spec.trim())}>{busy ? '提交中…' : draft.mode === 'goal' ? '开始协作' : draft.assignee ? '创建并分派' : '保存任务'}</button>
      </div>
      <div className="flex gap-1">{(['goal', 'task'] as const).map(mode => <button type="button" key={mode} className={`${button} ${draft.mode === mode ? 'bg-primary/15 text-primary' : 'text-muted-foreground'}`} aria-pressed={draft.mode === mode} onClick={() => setDraft(d => ({ ...d, mode }))}>{mode === 'goal' ? '自动协作' : '手动分派'}</button>)}</div>
      {draft.mode === 'task' && <Field label="任务标题"><input className={input} required maxLength={200} value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} placeholder="要完成什么？" /></Field>}
      <Field label={draft.mode === 'goal' ? '希望协作组完成什么？' : '目标与交付要求'}><textarea className={`${input} min-h-24 resize-y`} autoFocus required value={draft.spec} onChange={e => setDraft(d => ({ ...d, spec: e.target.value }))} placeholder="说明当前问题、预期结果和需要交付的内容。" /></Field>
      {draft.mode === 'goal' ? <><Field label="协调者"><select className={input} value={lead} onChange={e => setDraft(d => ({ ...d, coordinator: e.target.value }))}>{members.map(s => <option key={s.sessionId} value={s.sessionId} disabled={!s.agent}>{s.name}{!s.agent ? "（需要启动 Agent）" : ""}</option>)}</select></Field><p className="text-xs leading-relaxed text-muted-foreground">协调者拆分和汇总，执行成员完成子任务，服务自动安排评审与返工。你回答必要问题并验收最终结果。</p>{!workers.length && <p role="alert" className="text-xs text-destructive">请先在“消息与成员”加入至少一位执行 Agent。</p>}</> : <Field label="分派给"><select className={input} value={draft.assignee} onChange={e => setDraft(d => ({ ...d, assignee: e.target.value }))}><option value="">先保存，稍后分派</option>{members.map(s => <option key={s.sessionId} value={s.sessionId}>{s.name}</option>)}</select></Field>}
      <Field label="验收标准（选填）"><textarea className={`${input} min-h-16 resize-y`} value={draft.acceptance} onChange={e => setDraft(d => ({ ...d, acceptance: e.target.value }))} placeholder="什么结果满足要求？" /></Field>
      <details><summary className="min-h-11 cursor-pointer py-3 text-xs text-muted-foreground">{draft.mode === "goal" ? "约束与执行目录" : "约束、协调者与任务依赖"}</summary><div className="space-y-3">
        <Field label="约束"><textarea className={input} value={draft.constraints} onChange={e => setDraft(d => ({ ...d, constraints: e.target.value }))} placeholder="必须保留什么？哪些操作需要先问用户？" /></Field>
        {draft.mode === 'goal' ? <label className="flex min-h-11 items-start gap-2 text-xs text-muted-foreground"><input type="checkbox" className="mt-0.5" checked={draft.isolated} onChange={e => setDraft(d => ({ ...d, isolated: e.target.checked }))} /><span>为代码子任务创建独立目录与 Agent 会话。以已提交代码为基线，不包含原目录未提交改动；依赖的已评审提交会自动集成。非代码任务可关闭。</span></label> : <Field label="协调者"><select className={input} value={draft.coordinator} onChange={e => setDraft(d => ({ ...d, coordinator: e.target.value }))}><option value="">由用户协调</option>{members.map(s => <option key={s.sessionId} value={s.sessionId}>{s.name}</option>)}</select></Field>}
        {draft.mode === 'task' && <><Field label="父任务"><select className={input} value={draft.parent} onChange={e => setDraft(d => ({ ...d, parent: e.target.value }))}><option value="">独立任务</option>{tasks.filter(t => !t.workflow).map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select></Field>
        <fieldset className="space-y-1"><legend className="text-xs text-muted-foreground">需先验收的依赖任务</legend>{tasks.length ? tasks.filter(t => t.status !== 'closed').map(t => <label key={t.id} className="flex min-h-11 items-center gap-2 text-xs text-foreground"><input type="checkbox" checked={draft.dependencies.includes(t.id)} onChange={e => setDraft(d => ({ ...d, dependencies: e.target.checked ? [...d.dependencies, t.id] : d.dependencies.filter(id => id !== t.id) }))} />{t.title}</label>) : <p className="py-3 text-xs text-muted-foreground">还没有其他任务</p>}</fieldset></>}
      </div></details>
      <p className="text-[11px] text-muted-foreground">草稿自动保存在当前设备。返回后可继续编辑。</p>
    </form> : !loaded && !tasks.length ? <p role="status" className="py-8 text-center text-xs text-muted-foreground">{error ? '任务暂时无法加载，请重试。' : '正在加载任务…'}</p> : !tasks.length ?
      <div className="space-y-3 rounded-lg border border-border/20 p-3">
        <h4 className="text-sm font-medium text-foreground">给协作组一个目标</h4>
        <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">协调者组织执行，服务接续评审和返工，最后把结果交给你验收。</p>
        <button ref={newTaskRef} type="button" className={primary} disabled={busy} onClick={() => setCreating(true)}><Plus size={14} />开始协作</button>
      </div> : <>
      {(!showDetail || wide) && <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{tasks.filter(t => t.status === 'open' && t.workflow?.kind !== 'step').length} 个进行中{attention > 0 ? ` · ${attention} 个待处理` : ''}</p>
        <button ref={newTaskRef} type="button" className={primary} disabled={busy} onClick={() => setCreating(true)}><Plus size={14} />新目标</button>
      </div>}
      <div className={wide && showDetail ? 'grid items-start gap-4 grid-cols-[260px_minmax(0,1fr)]' : ''}>
        {(!showDetail || wide) && <div className="min-w-0 space-y-2">
          <div className="flex items-center gap-1">
            <div className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto" aria-label="任务筛选">
              {[['open', '进行中'], ['attention', `待处理${attention ? ` ${attention}` : ''}`], ['archive', '归档'], ['all', '全部']].map(([id, label]) => <button key={id} type="button" aria-pressed={filter === id} className={`${button} shrink-0 px-2 ${filter === id ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-surface-2'}`} onClick={() => setFilter(id)}>{label}</button>)}
            </div>
            <button type="button" aria-label="搜索任务" aria-expanded={searching} className={`${button} shrink-0 px-2 text-muted-foreground hover:bg-surface-2`} onClick={() => { setSearching(v => !v); setQuery(''); }}><Search size={14} /></button>
          </div>
          {searching && <label className="relative block"><span className="sr-only">搜索任务或负责人</span><Search size={14} className="pointer-events-none absolute left-3 top-3.5 text-muted-foreground" /><input autoFocus className={`${input} pl-9`} value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索任务或负责人" /></label>}
          {!matches.length && <div className="px-3 py-6 text-center text-xs text-muted-foreground">{query.trim() ? '没有匹配的任务。' : filter === 'attention' ? '目前没有需要你处理的任务。' : filter === 'archive' ? '还没有归档任务。' : '当前没有进行中的任务。'}{(filter !== 'all' || query) && <button type="button" className={`${button} mt-2 text-primary`} onClick={() => { setFilter('all'); setQuery(''); }}>查看全部任务</button>}</div>}
          {matches.map(task => {
            const current = task.attempts.find(a => a.id === task.activeAttemptId);
            return <button type="button" key={task.id} aria-pressed={selectedId === task.id} className={`w-full rounded-lg border p-3 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${selectedId === task.id ? 'border-primary/50 bg-primary/5' : 'border-border/20 hover:bg-surface-2'}`} onClick={() => { setSelectedId(task.id); setMobileDetail(true); setNotice(''); }}>
              <span className="block break-words text-sm font-medium text-foreground">{task.title}</span>
              <span className={`mt-1.5 block text-xs ${needsAttention(task) ? 'text-primary' : 'text-muted-foreground'}`}>{taskStage(task)}</span>
              <span className="mt-2 block truncate text-[11px] text-muted-foreground">{current ? name(task, current.assignee) : '尚未分派'} · {stamp(task.updatedAt)}</span>
            </button>;
          })}
        </div>}
        {showDetail && <div className="min-w-0">
          {!wide && <button type="button" className={`${button} mb-2 text-primary`} onClick={() => setMobileDetail(false)}><ArrowLeft size={14} />返回任务</button>}
          {selected ? <TaskDetail key={selected.id} task={selected} tasks={tasks} members={members} busy={busy} name={m => name(selected, m)} act={op => act(selected, op)} storage={storage} onSelectTask={id => { setSelectedId(id); setMobileDetail(true); }} onOpenSession={async m => {
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

function TaskDetail({ task, tasks, members, name, busy, act, storage, onOpenSession, onSelectTask }: {
  task: CollaborationTaskView; tasks: CollaborationTaskView[]; members: OrchestrationSession[]; name: (member: TaskMember | null) => string; busy: boolean;
  act: (input: Omit<TaskOperation, 'idempotencyKey'> & { assigneeSessionId?: string; coordinatorSessionId?: string | null }) => Promise<void>;
  storage: string; onOpenSession: (member: TaskMember) => Promise<void>; onSelectTask: (id: string) => void;
}) {
  const [assignee, setAssignee] = useState(''), [reviewer, setReviewer] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { titleRef.current?.focus(); }, []);
  const [feedback, setFeedback] = useState<string>(() => saved(`${storage}:${task.id}:feedback`, ''));
  const [answers, setAnswers] = useState<Record<string, string>>(() => saved(`${storage}:${task.id}:answers`, {}));
  useEffect(() => persist(`${storage}:${task.id}:answers`, answers), [storage, task.id, answers]);
  useEffect(() => persist(`${storage}:${task.id}:feedback`, feedback), [storage, task.id, feedback]);
  const current = task.attempts.find(a => a.id === task.activeAttemptId), open = task.status === 'open';
  const latestResult = task.artifacts.filter(a => a.kind === 'result' && a.attemptId === task.activeAttemptId).at(-1);
  const latestPlan = task.artifacts.filter(a => a.kind === 'plan' && a.attemptId === task.activeAttemptId).at(-1);
  const revisionPending = latestResult && task.events.some(e => e.kind === 'revise' && e.attemptId === task.activeAttemptId && e.createdAt >= latestResult.createdAt);
  const questions = task.decisions.filter(q => q.status === 'pending' && q.attemptId === task.activeAttemptId);
  const dependencyPending = task.dependsOn.some(id => tasks.find(t => t.id === id)?.status !== 'accepted');
  const reviewPassed = !task.workflow || task.artifacts.filter(a => a.kind === 'review' && a.reviewsArtifactId === latestResult?.id).at(-1)?.verdict === 'pass';
  const children = task.children ?? [];
  const childrenPending = task.workflow?.kind === 'goal' && children.some(t => !['accepted', 'closed'].includes(t.status));
  const context = `任务：${task.title}\n任务 ID：${task.id}\n${task.spec}\n约束：${task.constraints || '未补充'}\n验收标准：${task.acceptance || '由用户决定'}\n${current ? `当前尝试：${current.id}\n负责人：${name(current.assignee)}\n` : ''}${task.artifacts.filter(a => a.attemptId === task.activeAttemptId).map(a => `${a.kind} · 版本 ${a.id} · ${stamp(a.createdAt)}\n${a.content}`).join('\n\n')}\n${questions.map(q => `待回答：${q.question}`).join('\n')}`;
  const exportRecord = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(task, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `termdock-task-${task.id}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <article className="space-y-4">
    {task.replica && <p className="text-[11px] text-muted-foreground">这是来源服务同步的任务记录；回答与决定会送回来源服务保存。</p>}

    <header><div className="flex flex-wrap items-start gap-2"><h3 ref={titleRef} tabIndex={-1} className="min-w-0 flex-1 break-words text-base font-medium text-foreground outline-none">{task.title}</h3><span className="shrink-0 rounded-md bg-surface-2 px-2 py-1 text-[11px] text-primary">{taskStage(task)}</span></div>
      <details className="mt-2"><summary className="cursor-pointer py-2 text-xs text-muted-foreground">目标与验收标准</summary>      <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">{task.spec}</p>
      {(task.constraints || task.acceptance) && <dl className="mt-3 space-y-2 text-xs">{task.constraints && <div><dt className="text-muted-foreground">约束</dt><dd className="mt-1 whitespace-pre-wrap break-words text-foreground">{task.constraints}</dd></div>}{task.acceptance && <div><dt className="text-muted-foreground">验收标准</dt><dd className="mt-1 whitespace-pre-wrap break-words text-foreground">{task.acceptance}</dd></div>}</dl>}
      </details>
      <p className="mt-3 text-[11px] text-muted-foreground">{current ? `负责人：${name(current.assignee)}` : '尚未分派'} · {task.coordinator ? `协调者：${name(task.coordinator)}` : '由你协调'}{current && <button type="button" className={`${button} ml-1 text-primary`} onClick={() => void onOpenSession(current.assignee)}><ExternalLink size={13} />终端</button>}</p>
      {!!task.dependsOn.length && <p className="text-xs text-muted-foreground">依赖：{task.dependsOn.map(id => `${tasks.find(t => t.id === id)?.title ?? id}（${tasks.find(t => t.id === id)?.status === 'accepted' ? '已验收' : '待验收'}）`).join('、')}</p>}
      {task.parentTaskId && <button type="button" className={`${button} mt-1 text-primary`} onClick={() => onSelectTask(task.parentTaskId!)}><ArrowLeft size={12} />{tasks.find(t => t.id === task.parentTaskId)?.title ?? '返回目标'}</button>}
    </header>

    {task.workflow && open && <section className="space-y-2 rounded-lg border border-border/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-medium text-foreground">{task.workflow.kind === 'goal' ? '协调与自动接续' : '自动执行与评审'}</span><button type="button" className={secondary} disabled={busy} onClick={() => void act({ kind: task.workflow!.paused ? 'resume' : 'pause' })}>{task.workflow.paused ? '继续安排' : '暂停安排'}</button></div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{task.workflow.paused ? '后续自动安排已暂停，已入队的终端工作继续保留。' : '明确交付后自动评审，修改要求自动交回，依赖通过后接续。最终结果由你验收。'}</p>
      {task.automationIssue && <div role="alert" className="space-y-2"><p className="whitespace-pre-wrap break-words text-xs text-destructive">{task.automationIssue}</p><button type="button" className={secondary} disabled={busy} onClick={() => void act({ kind: 'retry' })}>继续协调 / 重试投递</button></div>}
      {task.workflow.kind === 'goal' && task.events.filter(e => e.kind === 'coordinate').at(-1) && <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">{task.events.filter(e => e.kind === 'coordinate').at(-1)!.content}</p>}
      {task.workspace && <details><summary className="min-h-11 cursor-pointer py-3 text-xs text-muted-foreground">交付目录与分支</summary><p className="select-text break-all text-xs text-foreground">{task.workspace.cwd}<br />{task.workspace.branch}</p><p className="mt-2 text-[11px] text-muted-foreground">基于已提交代码创建，原目录未提交改动保持原样。合并到原分支或发布需另行操作。</p></details>}
    </section>}
    {!!children.length && <section className="space-y-1"><h4 className="text-xs font-medium text-foreground">子任务 · {children.filter(c => c.status === 'accepted').length}/{children.length} 已通过评审</h4>{children.map(child => {
      const summary = tasks.find(t => t.id === child.id);
      return <button type="button" key={child.id} className="flex min-h-11 w-full items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-left" onClick={() => onSelectTask(child.id)}><span className="min-w-0 flex-1 break-words text-xs text-foreground">{child.title}</span><span className="shrink-0 text-[11px] text-muted-foreground">{summary ? taskStage(summary) : child.status === 'accepted' ? '评审通过' : '等待报告'}</span></button>;
    })}</section>}

    {open && !current && !task.scheduledAssignee && <section className="space-y-2 rounded-lg border border-border/20 p-3">
      <Field label="分派给"><select className={input} value={assignee} onChange={e => setAssignee(e.target.value)}><option value="">选择负责人</option>{members.map(m => <option key={m.sessionId} value={m.sessionId}>{m.name}</option>)}</select></Field>
      <button type="button" className={primary} disabled={busy || !assignee || dependencyPending} onClick={() => void act({ kind: 'assign', assigneeSessionId: assignee })}>分派任务</button>
      {dependencyPending && <p className="text-[11px] text-muted-foreground">依赖任务验收后可分派。</p>}
    </section>}
    {questions.map(q => <form key={q.id} className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3" onSubmit={e => { e.preventDefault(); void act({ kind: 'answer', decisionId: q.id, content: answers[q.id] }).then(() => titleRef.current?.focus()); }}><p className="text-xs font-medium text-primary">需要你的回答 · {stamp(q.createdAt)}</p><p className="whitespace-pre-wrap break-words text-sm text-foreground">{q.question}</p>{!!q.options.length && <div className="flex flex-wrap gap-2">{q.options.map((option, index) => <button type="button" key={index} aria-pressed={answers[q.id] === option} disabled={busy} className={`${button} ${answers[q.id] === option ? 'bg-primary/15 text-primary' : 'bg-surface-2 text-foreground'}`} onClick={() => setAnswers(a => ({ ...a, [q.id]: option }))}>{option}</button>)}</div>}<Field label="你的回答"><textarea className={`${input} min-h-20 resize-y`} required value={answers[q.id] ?? ''} onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.value }))} placeholder="可选择上面的建议，也可补充自己的答案" /></Field><div className="flex justify-end"><button className={primary} disabled={busy || !answers[q.id]?.trim()}>保存并回复</button></div></form>)}
    {(current || task.outbox.length > 0) && <details className="rounded-lg bg-surface-2 px-3"><summary className="min-h-11 cursor-pointer py-3 text-xs text-muted-foreground">投递凭证与执行尝试 · {task.attempts.length} 轮</summary><div className="space-y-3 pb-3">{task.outbox.map(o => <p key={o.id} className="break-words text-xs text-muted-foreground">{o.lastError ? `等待重试：${o.lastError}` : '已保存 · 等待投递'}{o.messageId ? ` · 消息 ${o.messageId}` : ''}</p>)}{task.attempts.map(a => <div key={a.id} className="text-xs text-muted-foreground"><p>{a.id === task.activeAttemptId ? '当前分派' : '历史分派'} · {name(a.assignee)} · {stamp(a.createdAt)}</p><p className="mt-1 break-all font-mono">尝试 ID：{a.id}</p><p className="mt-1">{a.deliveryStatus === 'delivered' ? `已写入终端 · ${a.deliveredAt ? stamp(a.deliveredAt) : ''}` : a.deliveryStatus === 'failed' || a.deliveryStatus === 'expired' ? '本次消息投递未成功' : '等待写入终端'}{a.report ? ` · ${labels[a.report.status]}（${stamp(a.report.createdAt)}）` : ''}</p></div>)}{task.deliveries.filter(d => d.kind !== 'task').map(d => <p key={d.id} className="text-xs text-muted-foreground">后续消息 {d.messageId} · {d.status === 'delivered' ? '已写入终端' : '等待投递'}{d.deliveredAt ? ` · ${stamp(d.deliveredAt)}` : ''}</p>)}<p className="text-[11px] text-muted-foreground">投递凭证确认终端写入。报告保留成员的原始陈述，验收由你决定。</p></div></details>}
    {!!task.artifacts.length && <section className="space-y-3"><h4 className="text-xs font-medium text-foreground">方案、结果与独立评审</h4>{task.artifacts.slice().reverse().map(artifact => <details open={artifact.id === latestResult?.id || artifact.id === latestPlan?.id && task.approvedPlanArtifactId !== artifact.id || artifact.kind === 'review' && artifact.reviewsArtifactId === latestResult?.id ? true : undefined} key={artifact.id} className={`rounded-lg border p-3 ${task.acceptedArtifactId === artifact.id || task.approvedPlanArtifactId === artifact.id ? 'border-primary/35 bg-primary/5' : 'border-border/20'}`}><summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-2 text-[11px] text-muted-foreground"><span className="font-medium text-primary">{artifact.kind === 'result' ? '结果' : artifact.kind === 'plan' ? '方案' : '独立评审'}</span><span>{name(artifact.actor)}</span>{artifact.verdict && <span>{artifact.verdict === 'pass' ? '通过' : artifact.verdict === 'changes' ? '需要修改' : '受阻'}</span>}<span>{stamp(artifact.createdAt)}</span>{artifact.attemptId !== task.activeAttemptId && <span>历史分派</span>}{artifact.reviewsArtifactId && <span>评审版本 {artifact.reviewsArtifactId.slice(0, 8)}</span>}{task.acceptedArtifactId === artifact.id && <span>{task.completionMode === 'reviewed' ? '评审通过' : '已验收'}</span>}{task.approvedPlanArtifactId === artifact.id && <span>方案已确认</span>}</summary><p className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">{artifact.content}</p>{artifact.evidence !== undefined && <details className="mt-2 text-xs text-muted-foreground"><summary className="min-h-11 cursor-pointer py-3">查看证据</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(artifact.evidence, null, 2)}</pre></details>}
        {open && artifact.attemptId === task.activeAttemptId && artifact.kind !== 'review' && <div className="mt-3 flex flex-wrap items-center gap-2">{latestResult?.id === artifact.id && task.workflow?.kind !== 'step' && <button type="button" className={primary} disabled={busy || !!revisionPending || questions.length > 0 || dependencyPending || !reviewPassed || !!childrenPending} onClick={() => void act({ kind: 'accept', artifactId: artifact.id })}><Check size={14} />验收此结果</button>}{latestPlan?.id === artifact.id && task.approvedPlanArtifactId !== artifact.id && <button type="button" className={primary} disabled={busy} onClick={() => void act({ kind: 'approve-plan', artifactId: artifact.id })}><Check size={14} />确认此方案</button>}{!task.workflow && <><select aria-label="独立评审成员" className={`${input} min-w-0 sm:w-auto`} value={reviewer} onChange={e => setReviewer(e.target.value)}><option value="">选择独立评审成员</option>{members.filter(m => m.sessionId !== task.memberSessions[memberKey(artifact.actor)]).map(m => <option key={m.sessionId} value={m.sessionId}>{m.name}</option>)}</select><button type="button" className={secondary} disabled={busy || !reviewer || reviewer === task.memberSessions[memberKey(artifact.actor)]} onClick={() => void act({ kind: 'request-review', artifactId: artifact.id, assigneeSessionId: reviewer })}>请求评审此版本</button></>}</div>}
      </details>)}{revisionPending && <p className="text-xs text-muted-foreground">已提出修改要求，等待本轮新的结果再验收。</p>}</section>}
    {open && <section className="space-y-2 border-t border-border/20 pt-3"><Field label="补充说明或修改要求"><textarea className={`${input} min-h-20 resize-y`} value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="写下需要补充的上下文，或要求成员修改的内容" /></Field><div className="flex flex-wrap gap-2"><button type="button" className={secondary} disabled={busy || !feedback.trim()} onClick={() => void act({ kind: 'comment', content: feedback })}>发送补充</button><button type="button" className={secondary} disabled={busy || !current || !feedback.trim()} onClick={() => void act({ kind: 'revise', content: feedback })}>要求修改</button></div></section>}
    <details className="border-t border-border/20 pt-1"><summary className="min-h-11 cursor-pointer py-3 text-xs text-muted-foreground">分派、协调者与归档</summary><div className="space-y-3 pb-2">{open && <>{current && task.workflow?.kind !== 'goal' && <><div className="flex flex-col gap-2 sm:flex-row"><select aria-label="任务负责人" className={input} value={assignee} onChange={e => setAssignee(e.target.value)}><option value="">选择负责人</option>{members.map(m => <option key={m.sessionId} value={m.sessionId}>{m.name}</option>)}</select><button type="button" className={`${primary} shrink-0`} disabled={busy || !assignee || dependencyPending} onClick={() => void act({ kind: 'assign', assigneeSessionId: assignee, content: feedback || undefined })}>{current ? '开始新一轮分派' : '分派任务'}</button></div><p className="text-[11px] text-muted-foreground">{dependencyPending ? '依赖任务验收后可分派。' : '新分派保留旧记录，并结束旧问题的回答入口。'}</p></>}<Field label="协调者"><select className={input} disabled={busy || task.workflow?.kind === "step"} value={task.coordinator ? task.memberSessions[memberKey(task.coordinator)] ?? '' : ''} onChange={e => void act({ kind: 'coordinator', coordinatorSessionId: e.target.value || null })}>{!task.workflow && <option value="">由用户协调</option>}{members.map(m => <option key={m.sessionId} value={m.sessionId}>{m.name}</option>)}</select></Field><button type="button" className={`${button} text-muted-foreground hover:bg-surface-2`} disabled={busy} onClick={() => void act({ kind: 'close', content: feedback || undefined })}>关闭此任务</button><p className="text-[11px] text-muted-foreground">关闭会保留历史，也会保留成员的终端工作。</p></>}{!open && <button type="button" className={secondary} disabled={busy} onClick={() => void act({ kind: 'reopen' })}>重新打开任务</button>}<details className="text-[11px] text-muted-foreground"><summary className="min-h-11 cursor-pointer py-3">任务标识与来源</summary><p className="select-text break-all">任务：{task.id}<br />来源服务：{task.ownerServiceId}<br />版本：{task.revision}</p></details></div></details>
    <details><summary className="cursor-pointer py-2 text-xs text-muted-foreground">复制与导出</summary>    <div className="flex flex-wrap gap-2"><button type="button" className={`${button} text-muted-foreground hover:bg-surface-2`} onClick={() => { void Promise.resolve().then(() => navigator.clipboard.writeText(context)).then(() => setCopyStatus('任务上下文已复制。')).catch(() => setCopyStatus('复制失败，请使用导出记录保存任务上下文。')); }}>复制任务上下文</button><button type="button" className={`${button} text-muted-foreground hover:bg-surface-2`} onClick={exportRecord}>导出记录</button>{copyStatus && <span role="status" className="self-center text-[11px] text-muted-foreground">{copyStatus}</span>}</div>
    </details>
    <details className="border-t border-border/20 pt-1"><summary className="min-h-11 cursor-pointer py-3 text-xs font-medium text-foreground">完整时间线 · {task.events.length} 条</summary><ol className="space-y-3">{task.events.slice().reverse().map(event => <li key={event.id} className="border-l-2 border-border/25 pl-3"><p className="text-[11px] text-muted-foreground">{eventLabels[event.kind] ?? event.kind}{event.reportStatus ? ` · ${labels[event.reportStatus]}` : ''} · {event.source === "system" ? "服务自动接续" : name(event.actor)} · {stamp(event.createdAt)}{event.attemptId && event.attemptId !== task.activeAttemptId ? ' · 历史分派' : ''}</p><p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">{event.content}</p>{event.target && <p className="mt-1 text-[11px] text-muted-foreground">接收人：{name(event.target)}{event.artifactId ? ` · 版本 ${event.artifactId.slice(0, 8)}` : ''}</p>}</li>)}</ol></details>
  </article>;
}
