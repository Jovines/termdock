import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Clock3, ExternalLink, Link2, Play, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import {
  getAgentLaunchers,
  listAgentAutomations,
  listCollaborationGroups,
  listCollaborationMessages,
  prepareAgentResumeHistory,
  removeAgentAutomation,
  removeCollaborationGroup,
  runAgentAutomation,
  saveAgentAutomation,
  saveCollaborationGroup,
  searchTerminalSessions,
  sendCollaborationMessage,
  type AgentAutomation,
  type AgentLauncherInfo,
  type AutomationRun,
  type CollaborationGroup,
  type CollaborationMessage,
  type CollaborationMessageKind,
  type OrchestrationSession,
  type SessionSearchResult,
} from '../../terminal/api';

type Tab = 'automation' | 'collaboration' | 'search';

interface AgentOperationsPanelProps {
  activeSessionId: string | null;
  onClose: () => void;
  onNewSession: (opts: { mode: 'shell'; cwd?: string; command?: string }) => void;
}

const inputClass = 'w-full rounded-lg border border-border/20 bg-surface-2 px-3 py-2 text-[12px] text-foreground outline-none transition focus:border-primary/60';
const buttonClass = 'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40';

export function AgentOperationsPanel({ activeSessionId, onClose, onNewSession }: AgentOperationsPanelProps) {
  const [tab, setTab] = useState<Tab>('automation');
  const [automations, setAutomations] = useState<AgentAutomation[]>([]);
  const [automationRuns, setAutomationRuns] = useState<AutomationRun[]>([]);
  const [agents, setAgents] = useState<AgentLauncherInfo[]>([]);
  const [groups, setGroups] = useState<CollaborationGroup[]>([]);
  const [sessions, setSessions] = useState<OrchestrationSession[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [automationData, collaborationData, detectedAgents] = await Promise.all([
        listAgentAutomations(),
        listCollaborationGroups(),
        getAgentLaunchers(),
      ]);
      setAutomations(automationData.automations);
      setAutomationRuns(automationData.runs);
      setGroups(collaborationData.groups);
      setSessions(collaborationData.sessions);
      setAgents(detectedAgents);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '加载失败');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return createPortal(
    <>
      <button
        type="button"
        className="fixed inset-0 z-modal-backdrop bg-[var(--app-backdrop)] backdrop-blur-sm cursor-default"
        onClick={onClose}
        aria-label="关闭 Agent 工作台"
      />
      <section className="fixed left-[max(0.75rem,env(safe-area-inset-left,0px))] right-[max(0.75rem,env(safe-area-inset-right,0px))] top-[max(1.5rem,env(safe-area-inset-top,0px))] bottom-[max(1.5rem,env(safe-area-inset-bottom,0px))] z-modal-panel mx-auto flex max-w-3xl flex-col overflow-hidden rounded-2xl border border-border/15 bg-surface shadow-[0_28px_70px_var(--app-shadow-strong),0_14px_32px_var(--app-shadow-soft)] sm:top-[8%] sm:bottom-auto sm:max-h-[84vh]">
        <header className="flex items-center gap-2 border-b border-border/15 px-4 py-3">
          <Bot size={17} className="text-primary" />
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold text-foreground">Agent 工作台</h2>
            <p className="text-[10px] text-muted-foreground">自动任务、会话协作与全文恢复</p>
          </div>
          <button className="rounded-lg p-2 text-muted-foreground hover:bg-surface-2 hover:text-foreground" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </header>
        <nav className="flex gap-1 border-b border-border/15 px-3 py-2">
          {([
            ['automation', Clock3, '自动任务'],
            ['collaboration', Link2, '会话协作'],
            ['search', Search, '全文搜索'],
          ] as const).map(([id, Icon, label]) => (
            <button key={id} onClick={() => setTab(id)} className={`${buttonClass} ${tab === id ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}>
              <Icon size={14} />{label}
            </button>
          ))}
        </nav>
        {error && <div className="mx-4 mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-[11px] text-destructive">{error}</div>}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {tab === 'automation' && <AutomationTab automations={automations} runs={automationRuns} agents={agents} sessions={sessions} busy={busy} setBusy={setBusy} setError={setError} refresh={refresh} onClose={onClose} />}
          {tab === 'collaboration' && <CollaborationTab groups={groups} sessions={sessions} activeSessionId={activeSessionId} busy={busy} setBusy={setBusy} setError={setError} refresh={refresh} />}
          {tab === 'search' && <SearchTab onClose={onClose} onNewSession={onNewSession} setError={setError} />}
        </div>
      </section>
    </>,
    document.body,
  );
}

function AutomationTab({ automations, runs, agents, sessions, busy, setBusy, setError, refresh, onClose }: {
  automations: AgentAutomation[]; runs: AutomationRun[]; agents: AgentLauncherInfo[]; sessions: OrchestrationSession[]; busy: string | null;
  setBusy: (value: string | null) => void; setError: (value: string | null) => void; refresh: () => Promise<void>; onClose: () => void;
}) {
  const [editing, setEditing] = useState<AgentAutomation | null>(null);
  const [showForm, setShowForm] = useState(automations.length === 0);
  const runAction = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await action(); await refresh(); } catch (error) { setError(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(null); }
  };
  return <div className="space-y-4">
    <div className="flex items-center justify-between">
      <p className="text-[11px] leading-relaxed text-muted-foreground">运行后会创建或复用一个会话；Agent 的回复和文件改动都留在该会话中，可从任务卡片直接打开。</p>
      <button className={`${buttonClass} bg-primary text-primary-foreground`} onClick={() => { setEditing(null); setShowForm(true); }}><Plus size={13} />新建</button>
    </div>
    {showForm && <AutomationForm agents={agents} sessions={sessions} initial={editing} onCancel={() => { setEditing(null); setShowForm(false); }} onSaved={async () => { setEditing(null); setShowForm(false); await refresh(); }} setError={setError} />}
    <div className="space-y-2">
      {automations.map((automation) => {
        const latestResult = runs.find((run) => run.automationId === automation.id && run.frontendSessionId);
        const agent = agents.find((candidate) => candidate.command === automation.command);
        return (
        <article key={automation.id} className="rounded-xl border border-border/15 bg-surface p-3">
          <div className="flex items-start gap-3">
            <button className="min-w-0 flex-1 text-left" onClick={() => { setEditing(automation); setShowForm(true); }}>
              <div className="flex items-center gap-2"><span className="truncate text-[13px] font-medium text-foreground">{automation.name}</span><span className={`h-2 w-2 rounded-full ${automation.enabled ? 'bg-[var(--success)]' : 'bg-muted-foreground'}`} /></div>
              <p className="mt-1 truncate text-[10px] text-muted-foreground">{scheduleLabel(automation)} · {automation.targetSessionId ? '现有会话' : `${agent?.displayName ?? 'Agent'} · ${automation.cwd}`}</p>
              <p className="mt-1 text-[10px] text-muted-foreground">{automation.lastRunAt ? `上次：${new Date(automation.lastRunAt).toLocaleString()} · ${automation.lastRunMessage ?? automation.lastRunStatus}` : '尚未运行'}</p>
            </button>
            {latestResult?.frontendSessionId && <button title="打开最近一次运行会话" className={`${buttonClass} bg-surface-2 px-2.5 text-foreground`} onClick={() => { window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: latestResult.frontendSessionId })); onClose(); }}><ExternalLink size={13} /><span className="hidden sm:inline">结果</span></button>}
            <button disabled={busy !== null} title="立即运行" className={`${buttonClass} bg-primary/15 px-2.5 text-primary`} onClick={() => void runAction(`run:${automation.id}`, () => runAgentAutomation(automation.id))}>{busy === `run:${automation.id}` ? <RefreshCw size={13} className="animate-spin" /> : <Play size={13} />}</button>
            <button disabled={busy !== null} title="删除" className={`${buttonClass} bg-destructive/10 px-2.5 text-destructive`} onClick={() => void runAction(`delete:${automation.id}`, () => removeAgentAutomation(automation.id))}><Trash2 size={13} /></button>
          </div>
        </article>
        );
      })}
      {automations.length === 0 && !showForm && <Empty text="还没有自动任务" />}
    </div>
  </div>;
}

function AutomationForm({ agents, sessions, initial, onCancel, onSaved, setError }: {
  agents: AgentLauncherInfo[]; sessions: OrchestrationSession[]; initial: AgentAutomation | null; onCancel: () => void; onSaved: () => Promise<void>; setError: (value: string | null) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [cwd, setCwd] = useState(initial?.cwd ?? sessions[0]?.cwd ?? '');
  const [selectedAgentSlug, setSelectedAgentSlug] = useState(() => agents.find((agent) => agent.command === initial?.command)?.slug ?? '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [targetSessionId, setTargetSessionId] = useState(initial?.targetSessionId ?? '');
  const [kind, setKind] = useState<'interval' | 'daily'>(initial?.schedule.kind ?? 'interval');
  const [everyMinutes, setEveryMinutes] = useState(initial?.schedule.kind === 'interval' ? initial.schedule.everyMinutes : 60);
  const [time, setTime] = useState(initial?.schedule.kind === 'daily' ? initial.schedule.time : '09:00');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const selectedAgent = agents.find((agent) => agent.slug === selectedAgentSlug) ?? null;
  const command = selectedAgent?.command ?? initial?.command ?? '';
  useEffect(() => {
    if (!initial && !selectedAgentSlug && agents[0]) setSelectedAgentSlug(agents[0].slug);
  }, [agents, initial, selectedAgentSlug]);
  const submit = async () => {
    setSaving(true); setError(null);
    try {
      await saveAgentAutomation({ id: initial?.id, name, cwd, command, prompt, targetSessionId: targetSessionId || null, enabled, schedule: kind === 'interval' ? { kind, everyMinutes } : { kind, time, weekdays: [0, 1, 2, 3, 4, 5, 6] } });
      await onSaved();
    } catch (error) { setError(error instanceof Error ? error.message : '保存失败'); }
    finally { setSaving(false); }
  };
  return <div className="space-y-3 rounded-xl border border-primary/25 bg-primary/5 p-3">
    <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-[10px] text-muted-foreground">名称<input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} placeholder="每日代码巡检" /></label><label className="space-y-1 text-[10px] text-muted-foreground">目标<select className={inputClass} value={targetSessionId} onChange={(event) => setTargetSessionId(event.target.value)}><option value="">每次创建新会话</option>{sessions.map((session) => <option key={session.sessionId} value={session.sessionId}>{session.name} · {session.status}</option>)}</select></label></div>
    {!targetSessionId && <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-[10px] text-muted-foreground">Agent / Plugin<select className={inputClass} value={selectedAgentSlug} onChange={(event) => setSelectedAgentSlug(event.target.value)}>{initial && !agents.some((agent) => agent.command === initial.command) && <option value="">原 Agent 当前不可用</option>}{agents.map((agent) => <option key={agent.slug} value={agent.slug}>{agent.displayName}{agent.isPlugin ? ' · Plugin' : ''}</option>)}</select></label><label className="space-y-1 text-[10px] text-muted-foreground">工作目录<input className={inputClass} value={cwd} onChange={(event) => setCwd(event.target.value)} /></label></div>}
    {!targetSessionId && agents.length === 0 && <p className="text-[10px] text-destructive">没有检测到可启动的 Agent。请先在 Plugin 设置中安装或配置 Agent。</p>}
    <label className="block space-y-1 text-[10px] text-muted-foreground">任务内容<textarea className={`${inputClass} min-h-20 resize-y`} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="检查项目状态并处理待办…" /></label>
    <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-[10px] text-muted-foreground">计划<select className={inputClass} value={kind} onChange={(event) => setKind(event.target.value as 'interval' | 'daily')}><option value="interval">固定间隔</option><option value="daily">每天</option></select></label>{kind === 'interval' ? <label className="space-y-1 text-[10px] text-muted-foreground">间隔（分钟）<input className={inputClass} type="number" min={1} value={everyMinutes} onChange={(event) => setEveryMinutes(Number(event.target.value))} /></label> : <label className="space-y-1 text-[10px] text-muted-foreground">时间<input className={inputClass} type="time" value={time} onChange={(event) => setTime(event.target.value)} /></label>}</div>
    <div className="flex items-center justify-between"><label className="flex items-center gap-2 text-[11px] text-foreground"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />启用</label><div className="flex gap-2"><button className={`${buttonClass} bg-surface-2 text-foreground`} onClick={onCancel}>取消</button><button disabled={saving || !name.trim() || !prompt.trim() || (!targetSessionId && !command)} className={`${buttonClass} bg-primary text-primary-foreground`} onClick={() => void submit()}>{saving ? '保存中…' : '保存'}</button></div></div>
  </div>;
}

function CollaborationTab({ groups, sessions, activeSessionId, busy, setBusy, setError, refresh }: {
  groups: CollaborationGroup[]; sessions: OrchestrationSession[]; activeSessionId: string | null; busy: string | null;
  setBusy: (value: string | null) => void; setError: (value: string | null) => void; refresh: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(activeSessionId ? [activeSessionId] : []));
  const [selectedGroupId, setSelectedGroupId] = useState<string | 'new' | null>(groups[0]?.id ?? null);
  const [messages, setMessages] = useState<CollaborationMessage[]>([]);
  const [targetSessionId, setTargetSessionId] = useState('*');
  const [kind, setKind] = useState<CollaborationMessageKind>('message');
  const [content, setContent] = useState('');
  const selectedGroup = selectedGroupId === 'new'
    ? null
    : groups.find((group) => group.id === selectedGroupId) ?? groups[0] ?? null;

  useEffect(() => {
    if (!selectedGroupId && groups[0]) setSelectedGroupId(groups[0].id);
  }, [groups, selectedGroupId]);

  useEffect(() => {
    if (!selectedGroup) { setMessages([]); return; }
    let cancelled = false;
    const load = () => void listCollaborationMessages(selectedGroup.id)
      .then((data) => { if (!cancelled) setMessages(data.messages); })
      .catch((error) => { if (!cancelled) setError(error instanceof Error ? error.message : '消息加载失败'); });
    load();
    const timer = window.setInterval(load, 3_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [selectedGroup?.id, setError]);

  const createGroup = async () => {
    setBusy('create-group'); setError(null);
    try {
      const result = await saveCollaborationGroup({ name, sessionIds: [...selected] });
      setName(''); setSelectedGroupId(result.group.id); await refresh();
    } catch (error) { setError(error instanceof Error ? error.message : '创建失败'); }
    finally { setBusy(null); }
  };
  const send = async () => {
    if (!selectedGroup) return;
    setBusy('send-message'); setError(null);
    try {
      await sendCollaborationMessage(selectedGroup.id, {
        fromSessionId: null,
        toSessionIds: targetSessionId === '*' ? undefined : [targetSessionId],
        kind,
        content,
      });
      setContent('');
      setMessages((await listCollaborationMessages(selectedGroup.id)).messages);
    } catch (error) { setError(error instanceof Error ? error.message : '发送失败'); }
    finally { setBusy(null); }
  };
  const remove = async () => {
    if (!selectedGroup) return;
    setBusy(`delete:${selectedGroup.id}`); setError(null);
    try { await removeCollaborationGroup(selectedGroup.id); setSelectedGroupId(null); await refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : '删除失败'); }
    finally { setBusy(null); }
  };
  const activities = collapseCollaborationMessages(messages, sessions);

  return <div className="space-y-4">
    <div className="flex gap-2 overflow-x-auto pb-1">
      {groups.map((group) => <button key={group.id} onClick={() => setSelectedGroupId(group.id)} className={`${buttonClass} shrink-0 ${selectedGroup?.id === group.id ? 'bg-primary/15 text-primary' : 'bg-surface-2 text-muted-foreground'}`}>{group.name}<span className="text-[9px] opacity-70">{group.sessionIds.length}</span></button>)}
      <button className={`${buttonClass} shrink-0 bg-surface-2 text-foreground`} onClick={() => setSelectedGroupId('new')}><Plus size={13} />新建组</button>
    </div>

    {!selectedGroup && <div className="rounded-xl border border-border/15 bg-surface p-3">
      <p className="text-[11px] leading-relaxed text-muted-foreground">把相关 Session 放进一个组。之后它们可以通过持久化收件箱互相发消息、提问和交接任务。</p>
      <input className={`${inputClass} mt-3`} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：发布准备" />
      <div className="mt-2 max-h-52 space-y-1 overflow-y-auto">{sessions.map((session) => <label key={session.sessionId} className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-2 hover:bg-surface-2"><input className="mt-0.5" type="checkbox" checked={selected.has(session.sessionId)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(session.sessionId)) next.delete(session.sessionId); else next.add(session.sessionId); return next; })} /><span className="min-w-0"><span className="block truncate text-[12px] text-foreground">{session.name} · {session.capability}</span><span className="block truncate text-[10px] text-muted-foreground">{session.status} · {session.currentTask}</span></span></label>)}</div>
      <button disabled={busy !== null || !name.trim() || selected.size < 2} className={`${buttonClass} mt-3 bg-primary text-primary-foreground`} onClick={() => void createGroup()}><Plus size={13} />创建协作组</button>
    </div>}

    {selectedGroup && <>
      <div className="rounded-xl border border-border/15 bg-surface p-3">
        <div className="flex items-center justify-between gap-3"><div><h3 className="text-[13px] font-medium text-foreground">{selectedGroup.name}</h3><p className="mt-0.5 text-[10px] text-muted-foreground">消息会持久化；忙碌 Agent 稍后收到，空闲 Agent 立即收到。</p></div><button disabled={busy !== null} className={`${buttonClass} bg-destructive/10 px-2.5 text-destructive`} onClick={() => void remove()}><Trash2 size={13} /></button></div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">{selectedGroup.sessionIds.map((id) => { const session = sessions.find((candidate) => candidate.sessionId === id); return <button key={id} onClick={() => session && window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: id }))} className="min-w-0 rounded-lg bg-surface-2 px-3 py-2 text-left"><span className="flex items-center gap-2"><span className={`h-2 w-2 shrink-0 rounded-full ${session?.status === 'working' ? 'bg-primary' : session?.status === 'offline' ? 'bg-muted-foreground' : 'bg-[var(--success)]'}`} /><span className="truncate text-[11px] text-foreground">{session?.name ?? id}</span></span><span className="mt-1 block truncate text-[9px] text-muted-foreground">{session?.currentTask ?? '已离线'}</span></button>; })}</div>
      </div>

      <div className="max-h-72 space-y-2 overflow-y-auto rounded-xl border border-border/15 bg-surface p-3">
        {activities.map((activity) => <div key={activity.key} className="rounded-lg bg-surface-2 px-3 py-2"><div className="flex items-center gap-2 text-[9px] text-muted-foreground"><span className="font-medium text-primary">{messageKindLabel(activity.kind)}</span><span>{activity.fromName}</span><span>→</span><span className="truncate">{activity.toNames.join('、')}</span><span className="ml-auto shrink-0">{new Date(activity.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div><p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-foreground">{activity.content}</p><p className="mt-1 text-[9px] text-muted-foreground">{activity.status === 'pending' ? '等待 Agent 空闲' : activity.status === 'read' ? '已读取' : '已投递'}</p></div>)}
        {activities.length === 0 && <Empty text="还没有消息。可以先发一个任务或问题。" />}
      </div>

      <div className="rounded-xl border border-primary/20 bg-primary/5 p-3">
        <div className="grid gap-2 sm:grid-cols-2"><select className={inputClass} value={targetSessionId} onChange={(event) => setTargetSessionId(event.target.value)}><option value="*">发送给全组</option>{selectedGroup.sessionIds.map((id) => <option key={id} value={id}>{sessions.find((session) => session.sessionId === id)?.name ?? id}</option>)}</select><select className={inputClass} value={kind} onChange={(event) => setKind(event.target.value as CollaborationMessageKind)}><option value="message">消息</option><option value="ask">问题</option><option value="task">任务</option><option value="handoff">工作交接</option><option value="done">完成通知</option></select></div>
        <textarea className={`${inputClass} mt-2 min-h-20 resize-y`} value={content} onChange={(event) => setContent(event.target.value)} placeholder="说明任务、依赖、产出位置或需要对方回答的问题…" />
        <div className="mt-2 flex items-center justify-between gap-3"><p className="text-[9px] text-muted-foreground">Agent 也可以用 td collab 主动回复和交接。</p><button disabled={busy !== null || !content.trim()} className={`${buttonClass} bg-primary text-primary-foreground`} onClick={() => void send()}>{busy === 'send-message' ? <RefreshCw size={13} className="animate-spin" /> : null}发送</button></div>
      </div>
    </>}
  </div>;
}

function messageKindLabel(kind: CollaborationMessageKind): string {
  return ({ message: '消息', ask: '问题', reply: '回复', task: '任务', handoff: '交接', done: '完成' } as const)[kind];
}

function collapseCollaborationMessages(messages: CollaborationMessage[], sessions: OrchestrationSession[]) {
  const sessionsById = new Map(sessions.map((session) => [session.sessionId, session.name]));
  const grouped = new Map<string, {
    key: string; kind: CollaborationMessageKind; content: string; createdAt: number;
    fromName: string; toNames: string[]; status: CollaborationMessage['status'];
  }>();
  for (const message of messages) {
    const key = `${message.threadId}:${message.createdAt}:${message.fromSessionId ?? 'user'}:${message.kind}:${message.content}`;
    const existing = grouped.get(key);
    const recipient = sessionsById.get(message.toSessionId) ?? message.toSessionId.slice(0, 8);
    if (existing) {
      existing.toNames.push(recipient);
      const rank = { pending: 0, delivered: 1, read: 2 } as const;
      if (rank[message.status] < rank[existing.status]) existing.status = message.status;
      continue;
    }
    grouped.set(key, {
      key, kind: message.kind, content: message.content, createdAt: message.createdAt,
      fromName: message.fromSessionId ? sessionsById.get(message.fromSessionId) ?? message.fromSessionId.slice(0, 8) : '你',
      toNames: [recipient], status: message.status,
    });
  }
  return [...grouped.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function SearchTab({ onClose, onNewSession, setError }: { onClose: () => void; onNewSession: AgentOperationsPanelProps['onNewSession']; setError: (value: string | null) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SessionSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => { if (!query.trim()) { setResults([]); return; } const timer = setTimeout(() => { setSearching(true); void searchTerminalSessions(query).then((data) => setResults(data.results)).catch((error) => setError(error instanceof Error ? error.message : '搜索失败')).finally(() => setSearching(false)); }, 250); return () => clearTimeout(timer); }, [query, setError]);
  const open = async (result: SessionSearchResult) => {
    if (result.live) { window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: result.sessionId })); onClose(); return; }
    if (!result.resumeHistoryId) return;
    try { const prepared = await prepareAgentResumeHistory(result.resumeHistoryId); onNewSession({ mode: 'shell', cwd: prepared.cwd, command: prepared.command }); onClose(); } catch (error) { setError(error instanceof Error ? error.message : '恢复失败'); }
  };
  return <div className="space-y-3"><div className="relative"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" /><input autoFocus className={`${inputClass} pl-9`} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索历史输出、任务内容、目录或标题" />{searching && <RefreshCw size={13} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground" />}</div><p className="text-[10px] text-muted-foreground">索引保存在本机 ~/.termdock；在线结果直接打开，已关闭的 Agent 会话可恢复。</p><div className="space-y-2">{results.map((result) => <button key={result.sessionId} disabled={!result.live && !result.resumeHistoryId} onClick={() => void open(result)} className="block w-full rounded-xl border border-border/15 bg-surface p-3 text-left transition hover:bg-surface-2 disabled:opacity-50"><div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">{result.title}</span><span className={`text-[10px] ${result.live ? 'text-[var(--success)]' : result.resumeHistoryId ? 'text-primary' : 'text-muted-foreground'}`}>{result.live ? '打开' : result.resumeHistoryId ? '恢复' : '仅历史'}</span></div><p className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-muted-foreground">{result.snippet}</p><p className="mt-1 truncate text-[9px] text-muted-foreground">{result.cwd} · {result.matchCount} 处匹配</p></button>)}{query.trim() && !searching && results.length === 0 && <Empty text="没有找到匹配会话" />}</div></div>;
}

function scheduleLabel(automation: AgentAutomation): string { return automation.schedule.kind === 'interval' ? `每 ${automation.schedule.everyMinutes} 分钟` : `每天 ${automation.schedule.time}`; }
function Empty({ text }: { text: string }) { return <div className="rounded-xl border border-dashed border-border/20 px-4 py-8 text-center text-[11px] text-muted-foreground">{text}</div>; }
