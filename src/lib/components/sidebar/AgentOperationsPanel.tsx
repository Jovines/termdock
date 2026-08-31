import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, CalendarClock, Check, ChevronDown, Clock3, ExternalLink, FolderOpen, Link2, Pause, Pencil, Play, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
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
  setAgentAutomationEnabled,
  type AgentAutomation,
  type AgentLauncherInfo,
  type AutomationSchedule,
  type AutomationRun,
  type CollaborationGroup,
  type CollaborationMessage,
  type CollaborationMessageKind,
  type OrchestrationSession,
  type SessionSearchResult,
} from '../../terminal/api';
import { DirectoryPickerDialog } from './DirectoryPickerDialog';

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
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setError(null);
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
      if (!options.silent) setError(nextError instanceof Error ? nextError.message : '加载失败');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh({ silent: true }), 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
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
        {notice && <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg bg-primary/10 px-3 py-2 text-[11px] text-primary"><Check size={13} />{notice}</div>}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {tab === 'automation' && <AutomationTab automations={automations} runs={automationRuns} agents={agents} sessions={sessions} activeSessionId={activeSessionId} busy={busy} setBusy={setBusy} setError={setError} setNotice={setNotice} refresh={refresh} onClose={onClose} />}
          {tab === 'collaboration' && <CollaborationTab groups={groups} sessions={sessions} activeSessionId={activeSessionId} busy={busy} setBusy={setBusy} setError={setError} setNotice={setNotice} refresh={refresh} />}
          {tab === 'search' && <SearchTab onClose={onClose} onNewSession={onNewSession} setError={setError} />}
        </div>
      </section>
    </>,
    document.body,
  );
}

function AutomationTab({ automations, runs, agents, sessions, activeSessionId, busy, setBusy, setError, setNotice, refresh, onClose }: {
  automations: AgentAutomation[]; runs: AutomationRun[]; agents: AgentLauncherInfo[]; sessions: OrchestrationSession[]; activeSessionId: string | null; busy: string | null;
  setBusy: (value: string | null) => void; setError: (value: string | null) => void; setNotice: (value: string | null) => void; refresh: () => Promise<void>; onClose: () => void;
}) {
  const [editing, setEditing] = useState<AgentAutomation | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const runAction = async (key: string, action: () => Promise<unknown>, successMessage: string) => {
    setBusy(key); setError(null); setNotice(null);
    try { await action(); await refresh(); setNotice(successMessage); } catch (error) { setError(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(null); }
  };
  return <div className="space-y-4">
    <div className="flex items-start justify-between gap-4">
      <div>
        <h3 className="text-[13px] font-medium text-foreground">自动任务</h3>
        <p className="mt-1 max-w-xl text-[11px] leading-relaxed text-muted-foreground">按计划把任务交给 Agent。每次运行都有独立会话和结果入口。</p>
      </div>
      {!showForm && automations.length > 0 && <button className={`${buttonClass} shrink-0 bg-primary text-primary-foreground`} onClick={() => { setEditing(null); setShowForm(true); setNotice(null); }}><Plus size={13} />新建任务</button>}
    </div>
    {showForm && <AutomationForm agents={agents} sessions={sessions} activeSessionId={activeSessionId} initial={editing} onCancel={() => { setEditing(null); setShowForm(false); }} onSaved={async (name) => { setEditing(null); setShowForm(false); await refresh(); setNotice(editing ? `“${name}”已更新` : `“${name}”已创建，将按计划自动运行`); }} setError={setError} />}
    {automations.length === 0 && !showForm && <div className="border-y border-border/15 py-8 text-center">
      <CalendarClock size={24} className="mx-auto text-primary" />
      <p className="mt-3 text-[13px] font-medium text-foreground">把重复工作交给 Agent</p>
      <p className="mx-auto mt-1 max-w-sm text-[11px] leading-relaxed text-muted-foreground">选择运行会话、写清任务内容，再设定时间。创建后可以先手动运行一次确认效果。</p>
      <button className={`${buttonClass} mt-4 bg-primary text-primary-foreground`} onClick={() => setShowForm(true)}><Plus size={13} />创建第一个任务</button>
    </div>}
    <div className="space-y-2">
      {automations.map((automation) => {
        const latestRun = runs.find((run) => run.automationId === automation.id);
        const agent = agents.find((candidate) => candidate.command === automation.command);
        return (
        <article key={automation.id} className="rounded-xl border border-border/15 bg-surface-2/40 p-3 transition hover:border-border/30">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-[13px] font-medium text-foreground">{automation.name}</span>
                <span className={`rounded-full px-2 py-0.5 text-[9px] ${automation.enabled ? 'bg-primary/10 text-primary' : 'bg-surface-elevated text-muted-foreground'}`}>{automation.enabled ? '已启用' : '已停用'}</span>
                {automation.lastRunStatus && <span className={`text-[10px] ${runStatusClass(automation.lastRunStatus)}`}>{runStatusLabel(automation.lastRunStatus)}</span>}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
                <span className="inline-flex items-center gap-1"><Clock3 size={11} />{scheduleLabel(automation)}</span>
                <span>{automation.enabled && automation.nextRunAt ? `下次 ${formatDateTime(automation.nextRunAt)}` : '不会自动运行'}</span>
              </div>
              <p className="mt-1 truncate text-[10px] text-muted-foreground">{automation.targetSessionId ? `发送到 ${sessions.find((session) => session.sessionId === automation.targetSessionId)?.name ?? '指定会话'}` : `新建 ${agent?.displayName ?? 'Agent'} 会话 · ${automation.cwd}`}</p>
              <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-foreground/80">{automation.prompt}</p>
              {automation.lastRunAt && <p className="mt-2 text-[10px] text-muted-foreground">上次 {formatDateTime(automation.lastRunAt)}{automation.lastRunMessage ? ` · ${automation.lastRunMessage}` : ''}</p>}
            </div>
            <button aria-label={`编辑 ${automation.name}`} title="编辑" className="rounded-lg p-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground" onClick={() => { setEditing(automation); setShowForm(true); setNotice(null); }}><Pencil size={13} /></button>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-border/10 pt-3">
            {confirmDeleteId === automation.id ? <>
              <span className="mr-auto text-[10px] text-destructive">删除后不会再自动运行</span>
              <button className={`${buttonClass} bg-surface-elevated text-foreground`} onClick={() => setConfirmDeleteId(null)}>取消</button>
              <button disabled={busy !== null} className={`${buttonClass} bg-destructive text-destructive-foreground`} onClick={() => void runAction(`delete:${automation.id}`, () => removeAgentAutomation(automation.id), `“${automation.name}”已删除`).then(() => setConfirmDeleteId(null))}>{busy === `delete:${automation.id}` ? <RefreshCw size={13} className="animate-spin" /> : <Trash2 size={13} />}确认删除</button>
            </> : <>
              <button className={`${buttonClass} mr-auto px-2 text-destructive hover:bg-destructive/10`} onClick={() => setConfirmDeleteId(automation.id)}><Trash2 size={13} />删除</button>
              <button
                disabled={busy !== null}
                className={`${buttonClass} ${automation.enabled ? 'bg-surface-elevated text-foreground' : 'bg-primary/15 text-primary'}`}
                onClick={() => void runAction(
                  `toggle:${automation.id}`,
                  () => setAgentAutomationEnabled(automation.id, !automation.enabled),
                  automation.enabled ? `“${automation.name}”已暂停，不会自动运行` : `“${automation.name}”已恢复，将按原计划运行`,
                )}
              >
                {busy === `toggle:${automation.id}` ? <RefreshCw size={13} className="animate-spin" /> : automation.enabled ? <Pause size={13} /> : <Play size={13} />}
                {automation.enabled ? '暂停' : '恢复'}
              </button>
              {latestRun?.frontendSessionId && <button className={`${buttonClass} bg-surface-elevated text-foreground`} onClick={() => { window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: latestRun.frontendSessionId })); onClose(); }}><ExternalLink size={13} />打开上次会话</button>}
              <button disabled={busy !== null} className={`${buttonClass} bg-primary/15 text-primary`} onClick={() => void runAction(`run:${automation.id}`, () => runAgentAutomation(automation.id), `“${automation.name}”已投递，可打开会话查看进度`)}>{busy === `run:${automation.id}` ? <RefreshCw size={13} className="animate-spin" /> : <Play size={13} />}立即运行</button>
            </>}
          </div>
        </article>
        );
      })}
    </div>
  </div>;
}

function AutomationForm({ agents, sessions, activeSessionId, initial, onCancel, onSaved, setError }: {
  agents: AgentLauncherInfo[]; sessions: OrchestrationSession[]; activeSessionId: string | null; initial: AgentAutomation | null; onCancel: () => void; onSaved: (name: string) => Promise<void>; setError: (value: string | null) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const activeSession = sessions.find((session) => session.sessionId === activeSessionId);
  const suggestedCwd = initial?.cwd ?? activeSession?.cwd ?? sessions[0]?.cwd ?? '';
  const [cwd, setCwd] = useState(suggestedCwd);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [selectedAgentSlug, setSelectedAgentSlug] = useState(() => agents.find((agent) => agent.command === initial?.command)?.slug ?? '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [targetSessionId, setTargetSessionId] = useState(initial?.targetSessionId ?? '');
  const [targetMode, setTargetMode] = useState<'new' | 'existing'>(initial?.targetSessionId ? 'existing' : 'new');
  const [kind, setKind] = useState<'interval' | 'daily'>(initial?.schedule.kind ?? 'interval');
  const [everyMinutes, setEveryMinutes] = useState(initial?.schedule.kind === 'interval' ? initial.schedule.everyMinutes : 60);
  const [time, setTime] = useState(initial?.schedule.kind === 'daily' ? initial.schedule.time : '09:00');
  const [weekdays, setWeekdays] = useState<number[]>(initial?.schedule.kind === 'daily' ? initial.schedule.weekdays : [1, 2, 3, 4, 5]);
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
      await saveAgentAutomation({ id: initial?.id, name, cwd, command: targetMode === 'new' ? command : '', prompt, targetSessionId: targetMode === 'existing' ? targetSessionId || null : null, enabled, schedule: kind === 'interval' ? { kind, everyMinutes } : { kind, time, weekdays } });
      await onSaved(name.trim());
    } catch (error) { setError(error instanceof Error ? error.message : '保存失败'); }
    finally { setSaving(false); }
  };
  const schedule = kind === 'interval' ? { kind, everyMinutes } as const : { kind, time, weekdays } as const;
  const [hours, minutes] = time.split(':');
  const setTimePart = (nextHours: string, nextMinutes: string) => setTime(`${nextHours}:${nextMinutes}`);
  const canSave = Boolean(name.trim() && prompt.trim() && (targetMode === 'existing' ? targetSessionId : command) && (kind === 'interval' ? everyMinutes >= 1 : weekdays.length > 0));
  return <div className="overflow-hidden rounded-xl border border-primary/25 bg-primary/5">
    <div className="flex items-center justify-between border-b border-primary/15 px-4 py-3"><div><p className="text-[13px] font-medium text-foreground">{initial ? '编辑自动任务' : '创建自动任务'}</p><p className="mt-0.5 text-[10px] text-muted-foreground">三步完成，保存后可立即试跑</p></div><button className="rounded-lg p-2 text-muted-foreground hover:bg-surface-2 hover:text-foreground" onClick={onCancel} aria-label="关闭任务表单"><X size={14} /></button></div>
    <div className="space-y-5 p-4">
      <fieldset className="space-y-3"><legend className="text-[11px] font-medium text-foreground"><span className="mr-2 text-primary">1</span>要做什么</legend>
        <label className="block space-y-1 text-[10px] text-muted-foreground">任务名称<input autoFocus className={inputClass} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：每日代码巡检" /></label>
        <label className="block space-y-1 text-[10px] text-muted-foreground">任务内容<textarea className={`${inputClass} min-h-24 resize-y`} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="说明目标、检查范围和期望产出，例如：检查当前分支的测试与待办，修复可安全处理的问题并总结结果。" /></label>
      </fieldset>
      <fieldset className="space-y-3 border-t border-border/10 pt-4"><legend className="text-[11px] font-medium text-foreground"><span className="mr-2 text-primary">2</span>在哪里运行</legend>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" aria-pressed={targetMode === 'new'} className={`${buttonClass} justify-start border px-3 text-left ${targetMode === 'new' ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border/15 bg-surface-2 text-muted-foreground'}`} onClick={() => setTargetMode('new')}>每次新建会话</button>
          <button type="button" aria-pressed={targetMode === 'existing'} disabled={sessions.length === 0} className={`${buttonClass} justify-start border px-3 text-left ${targetMode === 'existing' ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border/15 bg-surface-2 text-muted-foreground'}`} onClick={() => { setTargetMode('existing'); if (!targetSessionId) setTargetSessionId(activeSessionId ?? sessions[0]?.sessionId ?? ''); }}>发送到现有会话</button>
        </div>
        {targetMode === 'new' ? <><div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-[10px] text-muted-foreground">Agent / Plugin<select className={inputClass} value={selectedAgentSlug} onChange={(event) => setSelectedAgentSlug(event.target.value)}>{initial && !agents.some((agent) => agent.command === initial.command) && <option value="">原 Agent 当前不可用</option>}{agents.map((agent) => <option key={agent.slug} value={agent.slug}>{agent.displayName}{agent.isPlugin ? ' · Plugin' : ''}</option>)}</select></label><label className="space-y-1 text-[10px] text-muted-foreground">工作目录<div className="flex gap-2"><input className={inputClass} value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="默认使用当前目录" /><button type="button" aria-haspopup="dialog" className={`${buttonClass} shrink-0 bg-surface-2 text-foreground`} onClick={() => setDirectoryPickerOpen(true)}><FolderOpen size={13} />选择</button></div></label></div>
          {agents.length === 0 && <p className="text-[10px] text-destructive">没有检测到可启动的 Agent。请先在 Plugin 设置中安装或配置 Agent。</p>}</> : <label className="block space-y-1 text-[10px] text-muted-foreground">目标会话<select className={inputClass} value={targetSessionId} onChange={(event) => setTargetSessionId(event.target.value)}>{sessions.map((session) => <option key={session.sessionId} value={session.sessionId}>{session.name} · {session.status}</option>)}</select><span className="block leading-relaxed">运行时该会话需要在线，并且 Agent 处于可接收任务的状态。</span></label>}
      </fieldset>
      <fieldset className="space-y-3 border-t border-border/10 pt-4"><legend className="text-[11px] font-medium text-foreground"><span className="mr-2 text-primary">3</span>什么时候运行</legend>
        <div className="grid grid-cols-2 gap-2"><button type="button" aria-pressed={kind === 'interval'} className={`${buttonClass} border ${kind === 'interval' ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border/15 bg-surface-2 text-muted-foreground'}`} onClick={() => setKind('interval')}>固定间隔</button><button type="button" aria-pressed={kind === 'daily'} className={`${buttonClass} border ${kind === 'daily' ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border/15 bg-surface-2 text-muted-foreground'}`} onClick={() => setKind('daily')}>指定日期与时间</button></div>
        {kind === 'interval' ? <label className="block space-y-1 text-[10px] text-muted-foreground">每隔多少分钟<input className={inputClass} type="number" min={1} max={43200} value={everyMinutes} onChange={(event) => setEveryMinutes(Number(event.target.value))} /><span className="block">例如 60 = 每小时，1440 = 每天。始终按任务创建时间计算，之后编辑不会重置节奏。</span></label> : <div className="space-y-3"><div><span className="text-[10px] text-muted-foreground">运行时间</span><div className="mt-1 flex items-center rounded-xl border border-border/20 bg-surface-2 px-3 py-2.5 focus-within:border-primary/60"><Clock3 size={15} className="mr-3 shrink-0 text-primary" /><TimePartSelect label="小时" value={hours} options={24} onChange={(value) => setTimePart(value, minutes)} /><span aria-hidden="true" className="px-2 text-[18px] font-medium text-muted-foreground">:</span><TimePartSelect label="分钟" value={minutes} options={60} onChange={(value) => setTimePart(hours, value)} /><span className="ml-3 shrink-0 rounded-md bg-surface-elevated px-2 py-1 text-[9px] font-medium text-muted-foreground">24 小时制</span></div></div><div><span className="text-[10px] text-muted-foreground">运行日期</span><div className="mt-1 grid grid-cols-7 gap-1">{['日', '一', '二', '三', '四', '五', '六'].map((label, day) => { const selected = weekdays.includes(day); return <button key={day} type="button" aria-pressed={selected} aria-label={`星期${label}`} className={`rounded-lg py-2.5 text-[10px] transition ${selected ? 'bg-primary text-primary-foreground' : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated'}`} onClick={() => setWeekdays((current) => selected ? current.filter((value) => value !== day) : [...current, day].sort())}>{label}</button>; })}</div>{weekdays.length === 0 && <p className="mt-1 text-[10px] text-destructive">至少选择一天</p>}</div></div>}
      </fieldset>
    </div>
    <div className="flex flex-col gap-3 border-t border-primary/15 bg-surface/50 px-4 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1"><label className="flex items-center gap-2 text-[11px] text-foreground"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />保存后启用</label><p className="mt-1 truncate text-[10px] text-muted-foreground">{enabled && canSave ? `${initial ? '下次运行' : '首次运行'}：${formatDateTime(nextScheduledAt(schedule, Date.now(), initial?.createdAt))}` : enabled ? '填写完整后显示首次运行时间' : '任务会保存，但不会自动运行'}</p></div>
      <div className="flex justify-end gap-2"><button className={`${buttonClass} bg-surface-2 text-foreground`} onClick={onCancel}>取消</button><button disabled={saving || !canSave} className={`${buttonClass} bg-primary text-primary-foreground`} onClick={() => void submit()}>{saving ? '保存中…' : initial ? '保存修改' : '创建任务'}</button></div>
    </div>
    <DirectoryPickerDialog
      open={directoryPickerOpen}
      initialPath={cwd || suggestedCwd || '/'}
      title="选择工作目录"
      labels={{ hint: '进入文件夹，确认后才会更改工作目录。', cancel: '取消', confirm: '使用此目录', close: '关闭', parent: '上一级目录' }}
      onCancel={() => setDirectoryPickerOpen(false)}
      onConfirm={(path) => { setCwd(path); setDirectoryPickerOpen(false); }}
    />
  </div>;
}

function TimePartSelect({ label, value, options, onChange }: { label: string; value: string; options: number; onChange: (value: string) => void }) {
  return <label className="relative min-w-0 flex-1"><span className="sr-only">{label}</span><select aria-label={label} className="w-full appearance-none bg-transparent py-1 pl-1 pr-7 text-center text-[18px] font-semibold tabular-nums text-foreground outline-none" value={value} onChange={(event) => onChange(event.target.value)}>{Array.from({ length: options }, (_, index) => { const option = String(index).padStart(2, '0'); return <option key={option} value={option}>{option}</option>; })}</select><ChevronDown aria-hidden="true" size={13} className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground" /></label>;
}

function CollaborationTab({ groups, sessions, activeSessionId, busy, setBusy, setError, setNotice, refresh }: {
  groups: CollaborationGroup[]; sessions: OrchestrationSession[]; activeSessionId: string | null; busy: string | null;
  setBusy: (value: string | null) => void; setError: (value: string | null) => void; setNotice: (value: string | null) => void; refresh: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(activeSessionId ? [activeSessionId] : []));
  const [selectedGroupId, setSelectedGroupId] = useState<string | 'new' | null>(groups[0]?.id ?? null);
  const [sessionQuery, setSessionQuery] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [messages, setMessages] = useState<CollaborationMessage[]>([]);
  const [targetSessionId, setTargetSessionId] = useState('*');
  const [kind, setKind] = useState<CollaborationMessageKind>('message');
  const [content, setContent] = useState('');
  const selectedGroup = selectedGroupId === 'new'
    ? null
    : groups.find((group) => group.id === selectedGroupId) ?? groups[0] ?? null;
  const availableSessionIds = new Set(sessions.map((session) => session.sessionId));
  const selectedCount = [...selected].filter((id) => availableSessionIds.has(id)).length;
  const normalizedSessionQuery = sessionQuery.trim().toLocaleLowerCase();
  const filteredSessions = sessions.filter((session) => !normalizedSessionQuery || [session.name, session.cwd, friendlyCurrentTask(session.currentTask)]
    .some((value) => value.toLocaleLowerCase().includes(normalizedSessionQuery)));

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
    setBusy('create-group'); setError(null); setNotice(null);
    try {
      const validSessionIds = [...selected].filter((id) => availableSessionIds.has(id));
      const result = await saveCollaborationGroup({ name, sessionIds: validSessionIds });
      setName(''); setSessionQuery(''); setSelectedGroupId(result.group.id); await refresh();
      setNotice(`“${result.group.name}”已创建，${result.group.sessionIds.length} 个会话可以开始协作`);
    } catch (error) { setError(error instanceof Error ? error.message : '创建失败'); }
    finally { setBusy(null); }
  };
  const send = async () => {
    if (!selectedGroup) return;
    setBusy('send-message'); setError(null); setNotice(null);
    try {
      const result = await sendCollaborationMessage(selectedGroup.id, {
        fromSessionId: null,
        toSessionIds: targetSessionId === '*' ? undefined : [targetSessionId],
        kind,
        content,
      });
      setContent('');
      setMessages((await listCollaborationMessages(selectedGroup.id)).messages);
      setNotice(`消息已发送给 ${result.messages.length} 个会话`);
    } catch (error) { setError(error instanceof Error ? error.message : '发送失败'); }
    finally { setBusy(null); }
  };
  const remove = async () => {
    if (!selectedGroup) return;
    setBusy(`delete:${selectedGroup.id}`); setError(null); setNotice(null);
    const removedName = selectedGroup.name;
    try { await removeCollaborationGroup(selectedGroup.id); setSelectedGroupId(null); setConfirmDelete(false); await refresh(); setNotice(`“${removedName}”已删除`); }
    catch (error) { setError(error instanceof Error ? error.message : '删除失败'); }
    finally { setBusy(null); }
  };
  const activities = collapseCollaborationMessages(messages, sessions);

  return <div className="space-y-5">
    <div className="flex items-start justify-between gap-4">
      <div><h3 className="text-[13px] font-medium text-foreground">会话协作</h3><p className="mt-1 max-w-xl text-[11px] leading-relaxed text-muted-foreground">创建协作组后，一个 Agent 会话可以把任务直接交给另一个会话。比如“开发”写完代码后通知“测试”检查，测试结果再回复回来；你也可以给单个会话或全组发任务，所有交接和进展都记录在这里。</p></div>
      {selectedGroup && <button className={`${buttonClass} shrink-0 bg-primary text-primary-foreground`} onClick={() => { setSelectedGroupId('new'); setConfirmDelete(false); setNotice(null); }}><Plus size={13} />新建组</button>}
    </div>
    {groups.length > 0 && <div className="flex gap-2 overflow-x-auto border-b border-border/15 pb-3">
      {groups.map((group) => <button key={group.id} onClick={() => setSelectedGroupId(group.id)} className={`${buttonClass} shrink-0 ${selectedGroup?.id === group.id ? 'bg-primary/15 text-primary' : 'bg-surface-2 text-muted-foreground'}`}>{group.name}<span className="text-[9px] opacity-70">{group.sessionIds.length}</span></button>)}
    </div>}

    {!selectedGroup && <section className="border-y border-border/15 py-4">
      <div className="flex items-start justify-between gap-3"><div><h4 className="text-[12px] font-medium text-foreground">创建协作组</h4><p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">至少选择两个会话。离线成员会在重新上线后收到消息；已从列表移除的会话不会提交。</p></div><span className={`shrink-0 text-[10px] ${selectedCount >= 2 ? 'text-primary' : 'text-muted-foreground'}`}>已选 {selectedCount} 个</span></div>
      <label className="mt-4 block space-y-1 text-[10px] text-muted-foreground">协作组名称<input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：发布准备" /></label>
      {sessions.length > 5 && <label className="relative mt-3 block"><span className="sr-only">筛选会话</span><Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" /><input className={`${inputClass} pl-8`} value={sessionQuery} onChange={(event) => setSessionQuery(event.target.value)} placeholder="按名称、目录或当前任务筛选" /></label>}
      <div className="mt-3 max-h-64 divide-y divide-border/10 overflow-y-auto border-y border-border/10">
        {filteredSessions.map((session) => <label key={session.sessionId} className="flex cursor-pointer items-start gap-3 px-2 py-2.5 transition hover:bg-surface-2"><input className="mt-0.5" type="checkbox" checked={selected.has(session.sessionId)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(session.sessionId)) next.delete(session.sessionId); else next.add(session.sessionId); return next; })} /><span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className="truncate text-[12px] text-foreground">{session.name}</span><span className="shrink-0 text-[9px] text-muted-foreground">{humanSessionStatus(session.status)}</span></span><span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{friendlyCurrentTask(session.currentTask)} · {session.cwd}</span></span></label>)}
        {sessions.length === 0 && <p className="px-3 py-6 text-center text-[11px] text-muted-foreground">暂无可选会话，请先打开两个会话</p>}
        {sessions.length > 0 && filteredSessions.length === 0 && <p className="px-3 py-6 text-center text-[11px] text-muted-foreground">没有符合筛选条件的会话</p>}
      </div>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center"><p className={`min-w-0 flex-1 text-[10px] ${selectedCount < 2 ? 'text-muted-foreground' : 'text-primary'}`}>{selectedCount < 2 ? `还需选择 ${2 - selectedCount} 个会话` : '成员已满足要求，可以创建'}</p><div className="flex justify-end gap-2">{groups.length > 0 && <button className={`${buttonClass} bg-surface-2 text-foreground`} onClick={() => setSelectedGroupId(groups[0]?.id ?? null)}>取消</button>}<button disabled={busy !== null || !name.trim() || selectedCount < 2} className={`${buttonClass} bg-primary text-primary-foreground`} onClick={() => void createGroup()}>{busy === 'create-group' ? <RefreshCw size={13} className="animate-spin" /> : <Plus size={13} />}创建协作组</button></div></div>
    </section>}

    {selectedGroup && <>
      <section className="border-y border-border/15 py-4">
        <div className="flex items-start justify-between gap-3"><div><h4 className="text-[13px] font-medium text-foreground">{selectedGroup.name}</h4><p className="mt-1 text-[10px] text-muted-foreground">{selectedGroup.sessionIds.length} 个成员 · 离线成员会在重新上线后收到未读消息</p></div>{confirmDelete ? <div className="flex shrink-0 items-center gap-1"><button className={`${buttonClass} bg-surface-2 px-2 text-foreground`} onClick={() => setConfirmDelete(false)}>取消</button><button disabled={busy !== null} className={`${buttonClass} bg-destructive px-2 text-destructive-foreground`} onClick={() => void remove()}>{busy === `delete:${selectedGroup.id}` ? <RefreshCw size={13} className="animate-spin" /> : null}确认删除</button></div> : <button aria-label={`删除协作组 ${selectedGroup.name}`} title="删除协作组" disabled={busy !== null} className="rounded-lg p-2 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive" onClick={() => setConfirmDelete(true)}><Trash2 size={14} /></button>}</div>
        <div className="mt-3 grid divide-y divide-border/10 border-y border-border/10 sm:grid-cols-2 sm:divide-x sm:divide-y-0">{selectedGroup.sessionIds.map((id) => { const session = sessions.find((candidate) => candidate.sessionId === id); return <button key={id} disabled={!session} onClick={() => session && window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: id }))} className="min-w-0 px-3 py-2.5 text-left transition hover:bg-surface-2 disabled:cursor-default"><span className="flex items-center gap-2"><span className={`h-2 w-2 shrink-0 rounded-full ${session?.status === 'working' ? 'bg-primary' : session ? 'bg-[var(--success)]' : 'bg-muted-foreground'}`} /><span className="truncate text-[11px] text-foreground">{session?.name ?? id}</span><span className="ml-auto shrink-0 text-[9px] text-muted-foreground">{session ? humanSessionStatus(session.status) : '已离线'}</span></span><span className="mt-1 block truncate text-[9px] text-muted-foreground">{session ? friendlyCurrentTask(session.currentTask) : '重新上线后可继续接收消息'}</span></button>; })}</div>
      </section>

      <section><div className="mb-2 flex items-center justify-between"><h4 className="text-[11px] font-medium text-foreground">协作记录</h4><span className="text-[9px] text-muted-foreground">{activities.length} 条</span></div><div className="max-h-72 divide-y divide-border/10 overflow-y-auto border-y border-border/10">
        {activities.map((activity) => <div key={activity.key} className="px-2 py-3"><div className="flex items-center gap-2 text-[9px] text-muted-foreground"><span className="font-medium text-primary">{messageKindLabel(activity.kind)}</span><span>{activity.fromName}</span><span>→</span><span className="truncate">{activity.toNames.join('、')}</span><span className="ml-auto shrink-0">{new Date(activity.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div><p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-foreground">{activity.content}</p><p className="mt-1 text-[9px] text-muted-foreground">{activity.status === 'pending' ? '等待 Agent 上线' : activity.status === 'read' ? '已读取' : '已进入 Agent 队列'}</p></div>)}
        {activities.length === 0 && <Empty text="还没有消息。可以先发一个任务或问题。" />}
      </div></section>

      <section className="border-t border-primary/20 bg-primary/5 px-3 py-3"><h4 className="text-[11px] font-medium text-foreground">发送给成员</h4><div className="mt-2 grid gap-2 sm:grid-cols-2"><label className="space-y-1 text-[9px] text-muted-foreground">接收人<select className={inputClass} value={targetSessionId} onChange={(event) => setTargetSessionId(event.target.value)}><option value="*">全组成员</option>{selectedGroup.sessionIds.map((id) => <option key={id} value={id}>{sessions.find((session) => session.sessionId === id)?.name ?? `${id.slice(0, 8)}（离线）`}</option>)}</select></label><label className="space-y-1 text-[9px] text-muted-foreground">消息类型<select className={inputClass} value={kind} onChange={(event) => setKind(event.target.value as CollaborationMessageKind)}><option value="message">普通消息</option><option value="ask">需要回答的问题</option><option value="task">需要执行的任务</option><option value="handoff">工作交接</option><option value="done">完成通知</option></select></label></div>
        <label className="mt-2 block space-y-1 text-[9px] text-muted-foreground">内容<textarea className={`${inputClass} min-h-20 resize-y`} value={content} onChange={(event) => setContent(event.target.value)} placeholder="说明背景、期望产出，以及对方需要回复或完成什么…" /></label>
        <div className="mt-2 flex items-center justify-between gap-3"><p className="text-[9px] leading-relaxed text-muted-foreground">在线成员立即入队；离线成员上线后送达。</p><button disabled={busy !== null || !content.trim()} className={`${buttonClass} shrink-0 bg-primary text-primary-foreground`} onClick={() => void send()}>{busy === 'send-message' ? <RefreshCw size={13} className="animate-spin" /> : null}发送</button></div>
      </section>
    </>}
  </div>;
}

function humanSessionStatus(status: OrchestrationSession['status']): string {
  if (status === 'working') return '处理中';
  if (status === 'idle' || status === 'done') return '可接收';
  if (status === 'offline') return '已离线';
  return '在线';
}

function friendlyCurrentTask(currentTask: string | null | undefined): string {
  if (!currentTask) return '暂无任务摘要';
  try {
    const parsed = JSON.parse(currentTask) as { prompt?: unknown };
    if (typeof parsed.prompt === 'string') return cleanSessionSnippet(parsed.prompt) || '暂无任务摘要';
  } catch { /* Ordinary task text is not JSON. */ }
  return cleanSessionSnippet(currentTask) || '暂无任务摘要';
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
  const requestVersion = useRef(0);
  useEffect(() => {
    const trimmed = query.trim();
    const version = ++requestVersion.current;
    setResults([]);
    if (!trimmed) { setSearching(false); return; }
    setSearching(true);
    const timer = window.setTimeout(() => {
      void searchTerminalSessions(trimmed)
        .then((data) => { if (version === requestVersion.current) setResults(data.results); })
        .catch((error) => { if (version === requestVersion.current) setError(error instanceof Error ? error.message : '搜索失败'); })
        .finally(() => { if (version === requestVersion.current) setSearching(false); });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, setError]);
  const open = async (result: SessionSearchResult) => {
    if (result.live) { window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: result.sessionId })); onClose(); return; }
    if (!result.resumeHistoryId) return;
    try { const prepared = await prepareAgentResumeHistory(result.resumeHistoryId); onNewSession({ mode: 'shell', cwd: prepared.cwd, command: prepared.command }); onClose(); } catch (error) { setError(error instanceof Error ? error.message : '恢复失败'); }
  };
  return <div className="space-y-4">
    <div className="sticky -top-4 z-20 -mx-4 -mt-4 border-b border-border/15 bg-surface px-4 py-3">
      <div><h3 className="text-[13px] font-medium text-foreground">全文搜索</h3><p className="mt-1 text-[10px] text-muted-foreground">搜索会话标题、项目目录、任务内容和终端记录</p></div>
      <label className="relative mt-3 block"><span className="sr-only">搜索全部会话</span><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" /><input autoFocus className={`${inputClass} pl-9 pr-9`} value={query} onChange={(event) => { setError(null); setQuery(event.target.value); }} placeholder="输入你记得的关键词" />{searching ? <RefreshCw size={13} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground" /> : query && <button type="button" aria-label="清空搜索" className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground hover:bg-surface-2 hover:text-foreground" onClick={() => setQuery('')}><X size={13} /></button>}</label>
    </div>
    {!query.trim() && <div className="border-y border-border/15 py-10 text-center"><Search size={24} className="mx-auto text-primary" /><p className="mt-3 text-[13px] font-medium text-foreground">找回之前做过的事</p><p className="mx-auto mt-1 max-w-md text-[11px] leading-relaxed text-muted-foreground">可以输入任务名、报错片段或目录名，例如“自动任务”“web-terminal”“构建失败”。搜索索引只保存在本机。</p></div>}
    {query.trim() && !searching && results.length > 0 && <div className="flex items-center justify-between gap-3"><p className="text-[11px] text-foreground">显示 {results.length} 个会话</p><p className="text-[9px] text-muted-foreground">在线可打开 · 已关闭可恢复</p></div>}
    <div className="divide-y divide-border/10 border-y border-border/10">{results.map((result) => {
      const canOpen = result.live || Boolean(result.resumeHistoryId);
      const action = result.live ? '打开会话' : result.resumeHistoryId ? '恢复会话' : '仅供查阅';
      const content = <><div className="flex items-start gap-3"><div className="min-w-0 flex-1"><p className="truncate text-[12px] font-medium text-foreground">{result.title}</p><p className="mt-0.5 truncate text-[9px] text-muted-foreground">{result.cwd}</p></div><span className={`shrink-0 text-[10px] ${result.live ? 'text-[var(--success)]' : result.resumeHistoryId ? 'text-primary' : 'text-muted-foreground'}`}>{action}</span></div><p className="mt-2 line-clamp-3 text-[10px] leading-relaxed text-foreground/75">{searchResultSnippet(result) || '匹配内容来自标题、目录或终端控制信息'}</p><p className="mt-2 text-[9px] text-muted-foreground">{formatDateTime(result.updatedAt)} · {result.matchCount} 处匹配{!canOpen ? ' · 没有可恢复记录' : ''}</p></>;
      return canOpen
        ? <button key={result.sessionId} onClick={() => void open(result)} className="block w-full px-2 py-3 text-left transition hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none">{content}</button>
        : <article key={result.sessionId} className="px-2 py-3">{content}</article>;
    })}</div>
    {query.trim() && !searching && results.length === 0 && <div className="border-y border-border/15 py-8 text-center"><p className="text-[12px] text-foreground">没有找到“{query.trim()}”</p><p className="mt-1 text-[10px] text-muted-foreground">试试更短的关键词、目录名或报错中的一小段。</p><button className={`${buttonClass} mt-3 bg-surface-2 text-foreground`} onClick={() => setQuery('')}>清空后重试</button></div>}
  </div>;
}

export function cleanSessionSnippet(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, ' ')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, ' ')
    .replace(/\(B/g, ' ')
    .replace(/<[^>]{1,120}>/g, ' ')
    .replace(/[─━│┃┄┅┆┇┈┉┊┋┌┐└┘├┤┬┴┼╭╮╯╰═║╔╗╚╝╠╣╦╩╬]+/g, ' ')
    .replace(/([^\p{L}\p{N}\s])\1{3,}/gu, ' ')
    .replace(/([A-Za-z])\1{12,}/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
}

function searchResultSnippet(result: SessionSearchResult): string {
  let snippet = cleanSessionSnippet(result.snippet);
  for (const repeatedMetadata of [result.title, result.cwd, result.agentSlug]) {
    if (repeatedMetadata) snippet = snippet.split(repeatedMetadata).join(' ');
  }
  return cleanSessionSnippet(snippet);
}

function scheduleLabel(automation: AgentAutomation): string {
  if (automation.schedule.kind === 'interval') {
    if (automation.schedule.everyMinutes === 60) return '每小时';
    if (automation.schedule.everyMinutes === 1_440) return '每天';
    return `每 ${automation.schedule.everyMinutes} 分钟`;
  }
  const dayLabels = ['日', '一', '二', '三', '四', '五', '六'];
  const days = automation.schedule.weekdays.length === 7
    ? '每天'
    : automation.schedule.weekdays.map((day) => `周${dayLabels[day]}`).join('、');
  return `${days} ${automation.schedule.time}`;
}

function nextScheduledAt(schedule: AutomationSchedule, now = Date.now(), createdAt = now): number {
  if (schedule.kind === 'interval') {
    const intervalMs = schedule.everyMinutes * 60_000;
    const elapsed = Math.max(0, now - createdAt);
    return createdAt + (Math.floor(elapsed / intervalMs) + 1) * intervalMs;
  }
  const [hours, minutes] = schedule.time.split(':').map(Number);
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate.getTime() > now && schedule.weekdays.includes(candidate.getDay())) return candidate.getTime();
  }
  return now;
}

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(timestamp);
}

function runStatusLabel(status: AgentAutomation['lastRunStatus']): string {
  return status === 'running' ? '投递中' : status === 'success' ? '已投递' : status === 'failed' ? '投递失败' : '';
}

function runStatusClass(status: AgentAutomation['lastRunStatus']): string {
  return status === 'running' ? 'text-[var(--warning)]' : status === 'success' ? 'text-[var(--success)]' : status === 'failed' ? 'text-destructive' : 'text-muted-foreground';
}
function Empty({ text }: { text: string }) { return <div className="rounded-xl border border-dashed border-border/20 px-4 py-8 text-center text-[11px] text-muted-foreground">{text}</div>; }
