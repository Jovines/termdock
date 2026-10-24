import { useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, FolderOpen, Play, X } from 'lucide-react';
import { useKeyboardLayer } from '../../hooks/useKeyboardLayer';
import type { AgentLauncherInfo } from '../../terminal/api';
import type { TodoCollector, TodoItem, TodoLaunchConfig } from '../../todos/api';
import { useSessionDirectory } from '../../stores/useSessionDirectory';
import { useTodoDraft } from '../../todos/workspace';
import { directoryName } from '../../todos/preferences';
import { DirectoryPickerDialog } from '../sidebar/DirectoryPickerDialog';
import { AgentCommandPicker } from '../AgentCommandPicker';
import { getAgentLaunchCommand } from '../../terminal/launchCommands';

export const todoButton = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40';
export const todoPrimary = `${todoButton} bg-primary text-primary-foreground hover:opacity-90`;
export const todoSecondary = `${todoButton} bg-surface-2 text-foreground hover:bg-surface-elevated`;
export const todoGhost = `${todoButton} text-muted-foreground hover:bg-surface-2 hover:text-foreground`;
const input = 'w-full min-h-11 min-w-0 rounded-lg border border-border/40 bg-surface-2 px-3 py-2.5 text-base text-foreground outline-none focus:border-primary sm:text-sm';
const label = 'block space-y-2 text-sm text-muted-foreground';
export function TodoDialog({ title, busy, error, onClose, children, compact = false }: { title: string; busy: boolean; error: string; onClose: () => void; children: ReactNode; compact?: boolean }) {
  const ref = useRef<HTMLElement>(null), titleId = useId();
  useKeyboardLayer(ref, true, () => { if (!busy) onClose(); });
  return createPortal(<>
    <button className="fixed inset-0 z-drawer-backdrop bg-[var(--app-backdrop)] backdrop-blur-sm" aria-label="关闭待办面板" disabled={busy} onClick={onClose} />
    <section ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy} tabIndex={-1}
      className={compact ? 'fixed bottom-[max(0.75rem,env(safe-area-inset-bottom,0px))] left-3 right-3 z-drawer-panel flex max-h-[calc(100svh-2rem)] min-w-0 flex-col overflow-hidden rounded-2xl border border-border/30 bg-surface text-foreground shadow-xl sm:bottom-auto sm:left-1/2 sm:right-auto sm:top-1/2 sm:w-[28rem] sm:max-w-[90vw] sm:-translate-x-1/2 sm:-translate-y-1/2' : 'fixed inset-y-0 right-0 z-drawer-panel flex w-full min-w-0 flex-col border-l border-border/30 bg-surface pt-[env(safe-area-inset-top,0px)] text-foreground shadow-xl sm:w-[32rem] sm:max-w-[90vw]'}>
      <header className="flex min-h-16 shrink-0 items-center gap-3 border-b border-border/20 px-5"><h2 id={titleId} className="flex-1 text-base font-semibold">{title}</h2><button type="button" className={todoGhost} aria-label="关闭" disabled={busy} onClick={onClose}><X size={18} /></button></header>
      {error && <p role="alert" className="shrink-0 border-b border-[color-mix(in_srgb,var(--destructive)_20%,transparent)] bg-[color-mix(in_srgb,var(--destructive)_10%,transparent)] px-5 py-3 text-sm leading-6 text-destructive">{error}</p>}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  </>, document.body);
}
function FormBody({ children }: { children: ReactNode }) { return <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-5 py-5">{children}</div>; }
function FormFooter({ children }: { children: ReactNode }) { return <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border/20 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom,0px))]">{children}</footer>; }
export function TodoEditor({ workspace, todo, busy, onSave, onCancel }: { workspace: string; todo?: TodoItem; busy: boolean; onSave: (input: { title: string; description: string }, start: boolean) => void; onCancel: () => void }) {
  const [draft, setDraft] = useTodoDraft(workspace, `todo:${todo?.id ?? 'new'}`, { title: todo?.title ?? '', description: todo?.description ?? '' });
  const submit = (start: boolean) => { if (!busy && draft.title.trim()) onSave({ ...draft, title: draft.title.trim() }, start); };
  return <form className="flex min-h-0 flex-1 flex-col" onSubmit={e => { e.preventDefault(); submit(!todo); }}>
    <FormBody><label className={label}>要做什么<input autoFocus required maxLength={200} className={input} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} placeholder="一句话描述这件事" /></label>
      <label className={label}>背景和处理要求<textarea className={`${input} min-h-44 resize-y`} maxLength={40000} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} placeholder="为什么要做、参考资料、希望得到什么结果…" /></label>
      {!todo && <p className="text-xs leading-6 text-muted-foreground">可以先存进清单，也可以选一个会话交出去。</p>}
    </FormBody>
<FormFooter><button type="button" className={todoGhost} disabled={busy} onClick={onCancel}>取消</button>{!todo && <button type="button" className={todoSecondary} disabled={busy || !draft.title.trim()} onClick={() => submit(false)}>仅保存</button>}<button className={todoPrimary} disabled={busy || !draft.title.trim()}>{busy ? '正在保存…' : todo ? '保存修改' : '保存并交给会话'}</button></FormFooter>
  </form>;
}
export function resolveTodoConfig(config: TodoLaunchConfig, agents: AgentLauncherInfo[], preferred?: string | null, cwd?: string): TodoLaunchConfig {
  const agent = agents.find(a => a.slug === (config.agentSlug || preferred)) ?? (!config.agentSlug ? agents[0] : undefined);
  return { ...config, agentSlug: config.agentSlug || agent?.slug || '', command: config.command || (agent ? getAgentLaunchCommand(agent.slug, agent.command) : ''), cwd: config.cwd || cwd || '' };
}
function ConfigFields({ config, agents, loading, service, directories, currentCwd, onChange, collect = false }: { config: TodoLaunchConfig; agents: AgentLauncherInfo[]; loading: boolean; service: string; directories: string[]; currentCwd: string; onChange: (value: TodoLaunchConfig) => void; collect?: boolean }) {
  const [picker, setPicker] = useState(false), agentId = useId(), cwdId = useId();
  return <>
    <p className="text-xs text-muted-foreground">运行于 {service}</p>
    <div className={label}><label htmlFor={agentId}>Agent</label><select id={agentId} className={input} required disabled={loading} value={config.agentSlug} onChange={e => { const agent = agents.find(a => a.slug === e.target.value); onChange({ ...config, agentSlug: e.target.value, command: agent ? getAgentLaunchCommand(agent.slug, agent.command) : '' }); }}><option value="" disabled={agents.length > 0}>{loading ? '正在加载 Agent…' : '选择 Agent'}</option>{agents.map(a => <option key={a.slug} value={a.slug}>{a.displayName}</option>)}{config.agentSlug && !agents.some(a => a.slug === config.agentSlug) && <option value={config.agentSlug}>{config.agentSlug}（当前不可用）</option>}</select></div>
    {agents.find(a => a.slug === config.agentSlug) && <AgentCommandPicker key={config.agentSlug} agent={agents.find(a => a.slug === config.agentSlug)!} value={config.command} onChange={command => onChange({ ...config, command })} />}
    {!loading && agents.length === 0 && <p className="text-sm text-destructive">未找到可启动的 Agent，请检查该服务的 Agent 配置。</p>}
    <div className={label}><label htmlFor={cwdId}>工作目录</label><div className="flex gap-2"><input id={cwdId} className={input} value={config.cwd} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={e => onChange({ ...config, cwd: e.target.value })} placeholder="选择这件事所在的项目或目录" /><button type="button" className={todoSecondary} aria-label="选择工作目录" onClick={() => setPicker(true)}><FolderOpen size={17} /></button></div>
      {!!directories.length && <div className="flex gap-1.5 overflow-x-auto pb-1" aria-label="快捷选择工作目录">{directories.map(directory => {
        const name = directoryName(directory), duplicate = directories.some(other => other !== directory && directoryName(other) === name);
        const text = duplicate ? directory.split('/').filter(Boolean).slice(-2).join('/') : name;
        return <button key={directory} type="button" aria-label={`使用目录 ${directory}`} aria-pressed={config.cwd === directory} title={directory} className={`min-h-10 max-w-48 shrink-0 truncate rounded-lg border px-2.5 text-xs ${config.cwd === directory ? 'border-[rgb(var(--primary-rgb)/0.3)] bg-[rgb(var(--primary-rgb)/0.1)] text-primary' : 'border-transparent bg-surface-2 text-muted-foreground hover:text-foreground'}`} onClick={() => onChange({ ...config, cwd: directory })}>{directory === currentCwd ? `当前 · ${text}` : text}</button>;
      })}</div>}
    </div>
    <label className={label}>{collect ? '收集要求' : '处理要求'}<textarea required={collect} className={`${input} min-h-32 resize-y`} maxLength={20000} value={config.prompt} onChange={e => onChange({ ...config, prompt: e.target.value })} placeholder={collect ? '从哪里收集、筛选哪些事项、需要哪些背景与来源…' : '补充 Agent 应该遵守的要求，可留空'} /></label>
    <DirectoryPickerDialog open={picker} initialPath={config.cwd || '/'} title="选择工作目录" labels={{ hint: '选择 Agent 运行的目录', cancel: '取消', confirm: '使用此目录', close: '关闭', parent: '上级目录' }} onCancel={() => setPicker(false)} onConfirm={cwd => { onChange({ ...config, cwd }); setPicker(false); }} />
  </>;
}
export function LaunchEditor({ workspace, draftId, config, agents, loading, service, directories, currentCwd, multipleDirectories, busy, settings, onSave, onCancel }: { workspace: string; draftId: string; config: TodoLaunchConfig; agents: AgentLauncherInfo[]; loading: boolean; service: string; directories: string[]; currentCwd: string; multipleDirectories?: boolean; busy: boolean; settings?: boolean; onSave: (config: TodoLaunchConfig, remember: boolean) => void; onCancel: () => void }) {
  const [draft, setDraft] = useTodoDraft(workspace, draftId, { config, remember: true });
  const chosen = draft.config.agentSlug ? draft.config : { ...resolveTodoConfig(draft.config, agents, config.agentSlug, config.cwd), prompt: draft.config.prompt };
  const valid = !loading && agents.some(a => a.slug === chosen.agentSlug);
  return <form className="flex min-h-0 flex-1 flex-col" onSubmit={e => { e.preventDefault(); if (!busy && valid) onSave(chosen, draft.remember); }}>
    <FormBody><fieldset disabled={busy} className="min-w-0 space-y-5">{multipleDirectories && <p className="text-sm leading-6 text-muted-foreground">这些待办分别使用各自的项目目录。直接启动会保留各自配置；修改配置后将统一应用。</p>}<ConfigFields config={chosen} agents={agents} loading={loading} service={service} directories={directories} currentCwd={currentCwd} onChange={config => setDraft({ ...draft, config })} />
      {!settings && <label className="flex min-h-11 items-center gap-3 text-sm text-muted-foreground"><input type="checkbox" checked={draft.remember} onChange={e => setDraft({ ...draft, remember: e.target.checked })} className="h-4 w-4 accent-[var(--primary)]" />记住配置，下次直接处理</label>}
    </fieldset></FormBody>
    <FormFooter><button type="button" className={todoGhost} disabled={busy} onClick={onCancel}>取消</button><button className={todoPrimary} disabled={busy || !valid}>{settings ? <Check size={16} /> : <Play size={16} />}{busy ? '正在提交…' : settings ? '保存配置' : '启动 Agent'}</button></FormFooter>
  </form>;
}
const templates = [
  { name: '项目巡检', prompt: '检查工作目录中的项目，找出值得处理的问题。每条待办写清问题、依据和建议，避免重复。只收集待办，不修改项目。' },
  { name: '技术动态', prompt: '收集我关注方向的技术动态，筛选值得进一步调研或尝试的事项。每条待办附来源和后续建议，避免重复。' },
];
export function CollectorEditor({ workspace, collector, config, agents, loading, service, directories, currentCwd, busy, onSave, onCancel }: { workspace: string; collector?: TodoCollector; config: TodoLaunchConfig; agents: AgentLauncherInfo[]; loading: boolean; service: string; directories: string[]; currentCwd: string; busy: boolean; onSave: (input: Partial<TodoCollector> & { name: string; config: TodoLaunchConfig }, start: boolean) => void; onCancel: () => void }) {
  const sessions = useSessionDirectory();
  const [draft, setDraft] = useTodoDraft(workspace, `collector:${collector?.id ?? 'new'}`, { processing: collector?.processing ?? { mode: 'manual' as const, sessionId: null, config: null, note: '' }, webhook: collector?.webhook ?? { enabled: false, secret: '' }, session: collector?.session ?? { mode: 'new' as 'new' | 'reuse', targetSessionId: null as string | null, beforePrompt: '', idleMinutes: 10 }, name: collector?.name ?? '', config: collector?.config ?? { ...config, prompt: '' }, enabled: collector?.enabled ?? true, schedule: collector?.schedule?.kind ?? 'manual', minutes: collector?.schedule?.kind === 'interval' ? collector.schedule.everyMinutes : 60, daily: collector?.schedule?.kind === 'daily' ? collector.schedule.time : '09:00' });
  const chosen = draft.config.agentSlug ? draft.config : { ...resolveTodoConfig(draft.config, agents, config.agentSlug, config.cwd), prompt: draft.config.prompt };
  const processing = draft.processing;
  const processingReady = !processing || processing.mode === 'manual' || (processing.mode === 'existing' ? sessions.some(s => s.sessionId === processing.sessionId && s.agent) : agents.some(a => a.slug === (processing.config?.agentSlug || chosen.agentSlug)));
  const valid = draft.name.trim() && chosen.prompt.trim() && !loading && agents.some(a => a.slug === chosen.agentSlug) && processingReady;
  const submit = (start: boolean) => { if (busy || !valid) return; onSave({ id: collector?.id, revision: collector?.revision, name: draft.name.trim(), config: chosen, processing: draft.processing?.mode === 'new' ? { ...draft.processing, config: draft.processing.config ?? { ...chosen, prompt: '' } } : draft.processing, webhook: draft.webhook, session: draft.session ?? { mode: 'new', targetSessionId: null, beforePrompt: '', idleMinutes: 10 }, enabled: draft.enabled, schedule: draft.schedule === 'manual' ? null : draft.schedule === 'interval' ? { kind: 'interval', everyMinutes: draft.minutes } : { kind: 'daily', time: draft.daily, weekdays: collector?.schedule?.kind === 'daily' ? collector.schedule.weekdays : [0, 1, 2, 3, 4, 5, 6] } }, start); };
  return <form className="flex min-h-0 flex-1 flex-col" onSubmit={e => { e.preventDefault(); submit(true); }}>
    <FormBody><fieldset disabled={busy} className="min-w-0 space-y-5">
      {!collector && <div className="flex flex-wrap gap-2">{templates.map(t => <button key={t.name} type="button" className={todoSecondary} onClick={() => setDraft({ ...draft, name: t.name, config: { ...draft.config, prompt: t.prompt } })}>{t.name}</button>)}</div>}
      <label className={label}>收集方向<input required className={input} maxLength={200} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="例如：项目巡检、技术动态" /></label>
      <ConfigFields collect config={chosen} agents={agents} loading={loading} service={service} directories={directories} currentCwd={currentCwd} onChange={config => setDraft({ ...draft, config })} />
      <CollectorProcessingFields processing={draft.processing ?? { mode: 'manual', sessionId: null, config: null, note: '' }} config={chosen} agents={agents} sessions={sessions} onChange={processing => setDraft({ ...draft, processing })} />
      <CollectorWebhookFields collectorId={collector?.id} webhook={draft.webhook ?? { enabled: false, secret: '' }} onChange={webhook => setDraft({ ...draft, webhook })} />
      <CollectorSessionFields session={draft.session ?? { mode: 'new', targetSessionId: null, beforePrompt: '', idleMinutes: 10 }} sessions={sessions} onChange={session => setDraft({ ...draft, session })} />
      <details className="rounded-lg border border-border/20 px-3 text-sm text-muted-foreground"><summary className="cursor-pointer py-3">定时与启用 · {draft.schedule === 'manual' ? '手动运行' : draft.schedule === 'interval' ? `每 ${draft.minutes} 分钟` : `每天 ${draft.daily}`}</summary><div className="space-y-4 pb-3">
        <label className={label}>运行频率<select className={input} value={draft.schedule} onChange={e => setDraft({ ...draft, schedule: e.target.value as typeof draft.schedule })}><option value="manual">手动运行</option><option value="interval">按间隔运行</option><option value="daily">每天定时</option></select></label>
        {draft.schedule === 'interval' && <label className={label}>间隔（分钟）<input className={input} required type="number" min={1} max={43200} step={1} value={draft.minutes} onChange={e => setDraft({ ...draft, minutes: Number(e.target.value) })} /></label>}
        {draft.schedule === 'daily' && <label className={label}>时间（服务所在时区）<input className={input} required type="time" value={draft.daily} onChange={e => setDraft({ ...draft, daily: e.target.value })} /></label>}
        <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />启用此方向，参与全部收集和定时运行</label>
      </div></details>
    </fieldset></FormBody>
    <FormFooter><button type="button" className={todoGhost} disabled={busy} onClick={onCancel}>取消</button><button type="button" className={todoSecondary} disabled={busy || !valid} onClick={() => submit(false)}>仅保存</button><button className={todoPrimary} disabled={busy || !valid}><Play size={16} />{busy ? '正在保存…' : '保存并收集'}</button></FormFooter>
  </form>;
}
function CollectorProcessingFields({ processing, config, agents, sessions, onChange }: { processing: NonNullable<TodoCollector['processing']>; config: TodoLaunchConfig; agents: AgentLauncherInfo[]; sessions: ReturnType<typeof useSessionDirectory>; onChange: (value: NonNullable<TodoCollector['processing']>) => void }) {
  const launch = processing.config ?? { ...config, prompt: '' }, agent = agents.find(a => a.slug === launch.agentSlug);
  return <details className="rounded-lg border border-border/20 px-3 text-sm text-muted-foreground"><summary className="cursor-pointer py-3">收集后 · {processing.mode === 'manual' ? '仅入清单，手动交接或按来源领取' : processing.mode === 'new' ? '自动新建 Agent 处理' : '自动发送到现有 Agent'}</summary><div className="space-y-4 pb-3">
    <label className={label}>待办处理方式<select className={input} value={processing.mode} onChange={e => onChange({ ...processing, mode: e.target.value as typeof processing.mode, sessionId: null })}><option value="manual">仅入清单</option><option value="new">自动新建 Agent 处理</option><option value="existing">自动发送到现有 Agent</option></select></label>
    {processing.mode === 'manual' ? <p className="text-xs leading-6">可以手动交给会话，也可以让现有 Agent 通过 CLI 按来源领取。</p> : <>
      {processing.mode === 'existing' ? <label className={label}>自动处理会话<select required className={input} value={processing.sessionId ?? ''} onChange={e => onChange({ ...processing, sessionId: e.target.value || null })}><option value="">选择接收待办的 Agent</option>{sessions.filter(s => s.agent).map(s => <option key={s.sessionId} value={s.sessionId}>{s.displayName}{s.displaySubtitle ? ` · ${s.displaySubtitle}` : ''}</option>)}{processing.sessionId && !sessions.some(s => s.sessionId === processing.sessionId) && <option value={processing.sessionId}>原会话已关闭，请重新选择</option>}</select></label> : <>
        <label className={label}>处理 Agent<select required className={input} value={launch.agentSlug} onChange={e => { const a = agents.find(a => a.slug === e.target.value); onChange({ ...processing, config: { ...launch, agentSlug: e.target.value, command: a ? getAgentLaunchCommand(a.slug, a.command) : '' } }); }}>{agents.map(a => <option key={a.slug} value={a.slug}>{a.displayName}</option>)}</select></label>
        {agent && <AgentCommandPicker key={agent.slug} agent={agent} value={launch.command} onChange={command => onChange({ ...processing, config: { ...launch, command } })} />}
        <label className={label}>处理工作目录<input className={input} value={launch.cwd} onChange={e => onChange({ ...processing, config: { ...launch, cwd: e.target.value } })} /></label>
      </>}
      <label className={label}>自动处理要求（可选）<textarea className={`${input} min-h-24`} maxLength={4000} value={processing.note} onChange={e => onChange({ ...processing, note: e.target.value })} placeholder="例如：先调查并给出方案，暂不修改文件" /></label>
      <p className="text-xs leading-6">保存后，此来源新注入的待办会直接交给 Agent{processing.mode === 'new' ? '，每条待办创建一个会话' : ''}；已有待办保持原状。</p>
    </>}
  </div></details>;
}
function CollectorWebhookFields({ collectorId, webhook, onChange }: { collectorId?: string; webhook: NonNullable<TodoCollector['webhook']>; onChange: (value: NonNullable<TodoCollector['webhook']>) => void }) {
  const [copied, setCopied] = useState(false);
  const command = collectorId && webhook.secret ? `curl -X POST 'https://你的服务地址/hooks/todo/${collectorId}' -H 'Authorization: Bearer ${webhook.secret}' -H 'Content-Type: application/json' -H 'Idempotency-Key: <通知唯一标识>' -d '{"event":"updated"}'` : '';
  return <details className="rounded-lg border border-border/20 px-3 text-sm text-muted-foreground"><summary className="cursor-pointer py-3">外部通知 · {webhook.enabled ? 'Webhook 已启用' : '未启用'}</summary><div className="space-y-3 pb-3">
    <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={webhook.enabled} onChange={e => onChange({ ...webhook, enabled: e.target.checked })} />允许 Webhook 通知触发此来源的收集</label>
    {webhook.enabled && <>
      <p className="text-xs leading-6">通知发送 JSON，作为本轮收集的补充上下文。可与定时收集同时启用。停用此来源也会停止 Webhook 触发。</p>
      {command ? <><code className="block break-all rounded-lg bg-surface-2 p-3 text-xs">POST /hooks/todo/{collectorId}</code><button type="button" className={todoSecondary} onClick={() => { void navigator.clipboard.writeText(command).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? '已复制' : '复制调用示例（含凭据）'}</button><p className="text-xs leading-6">将示例中的服务地址换为该服务可访问的 HTTPS 地址。凭据仅能触发本来源，请只提供给对应的通知服务。</p></> : <p className="text-xs leading-6">保存后生成本来源专用的调用凭据；重新编辑可复制调用示例。</p>}
    </>}
  </div></details>;
}
function CollectorSessionFields({ session, sessions, onChange }: { session: NonNullable<TodoCollector['session']>; sessions: ReturnType<typeof useSessionDirectory>; onChange: (session: NonNullable<TodoCollector['session']>) => void }) {
  return <details className="rounded-lg border border-border/20 px-3 text-sm text-muted-foreground"><summary className="cursor-pointer py-3">会话与回收 · {session.mode === 'reuse' ? '复用' : '每次新建'} · {session.targetSessionId ? '现有会话不自动回收' : session.idleMinutes ? `无输出 ${session.idleMinutes} 分钟后回收` : '不自动回收'}</summary><div className="space-y-4 pb-3">
    <label className={label}>会话策略<select className={input} value={session.mode} onChange={e => onChange({ ...session, mode: e.target.value as 'new' | 'reuse', targetSessionId: null })}><option value="new">每次新建收集会话</option><option value="reuse">复用同一会话</option></select></label>
    {session.mode === 'reuse' && <>
      <label className={label}>复用会话<select className={input} value={session.targetSessionId ?? ''} onChange={e => onChange({ ...session, targetSessionId: e.target.value || null })}><option value="">自动创建并复用本方向的会话</option>{sessions.filter(s => s.agent && s.mode === 'tmux').map(s => <option key={s.sessionId} value={s.sessionId}>{s.displayName}{s.displaySubtitle ? ` · ${s.displaySubtitle}` : ''}</option>)}{session.targetSessionId && !sessions.some(s => s.sessionId === session.targetSessionId) && <option value={session.targetSessionId}>原会话已关闭，请重新选择</option>}</select></label>
      <label className={label}>复用前命令（可选）<input className={input} value={session.beforePrompt} maxLength={4000} onChange={e => onChange({ ...session, beforePrompt: e.target.value })} placeholder="例如 /clear；留空则直接发送收集要求" /></label>
    </>}
    {session.mode === 'reuse' && !session.targetSessionId && <p className="text-xs leading-6">上一轮报告结束后复用；会话被回收时，下次自动新建。</p>}
    {session.targetSessionId ? <p className="text-xs leading-6">你指定的现有会话不会自动关闭。</p> : <label className={label}>无输出多久后回收（分钟）<input className={input} type="number" aria-label="无输出多久后回收（分钟）" min={0} max={43200} step={1} required value={session.idleMinutes} onChange={e => onChange({ ...session, idleMinutes: Number(e.target.value) })} /><span className="block text-xs leading-6">默认 10 分钟，填 0 关闭。任何终端输出都会重新计时；静默思考也会计时。回收会关闭终端，保留待办和记录。</span></label>}
  </div></details>;
}
export function IntegrationHelp() {
  const [copied, setCopied] = useState(false);
  const command = 'td todo add --title "检查项目依赖" --description "核实升级影响" --source "项目巡检" --external-id "deps-review"';
  return <FormBody><p className="text-sm leading-7 text-muted-foreground">外部程序或 Agent 可以在服务所在机器，通过 CLI 写入待办。相同来源与外部标识会去重。</p><pre className="overflow-x-auto rounded-lg bg-surface-2 p-4 text-xs leading-6"><code>{command}</code></pre><button className={todoSecondary} onClick={() => { void navigator.clipboard.writeText(command).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? '已复制' : '复制命令'}</button><p className="text-xs leading-6 text-muted-foreground">完整用法：<code>td todo --help</code>。API：<code className="break-all">POST /api/terminal/operations/todos</code>，沿用当前服务的鉴权和加密连接。</p></FormBody>;
}
