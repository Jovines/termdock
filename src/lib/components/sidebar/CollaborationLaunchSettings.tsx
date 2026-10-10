import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { saveCollaborationGroup, type AgentLauncherInfo, type CollaborationGroup, type CollaborationLaunchProfile } from '../../terminal/api';

const field = 'min-h-11 w-full rounded-lg border border-border/20 bg-surface px-3 py-2 text-xs text-foreground outline-none focus:border-primary';
const action = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-xs disabled:opacity-40';
type Draft = { profiles: CollaborationLaunchProfile[]; defaultId: string; group: CollaborationGroup };
const snapshot = (group: CollaborationGroup): Draft => ({ profiles: group.launchProfiles ?? [], defaultId: group.defaultLaunchProfileId ?? '', group });
const drafts = new Map<string, Draft>();
const dirty = (d: Draft) => JSON.stringify(d.profiles) !== JSON.stringify(d.group.launchProfiles ?? []) || d.defaultId !== (d.group.defaultLaunchProfileId ?? '');

export function CollaborationLaunchChoice({ group, value, onChange, disabled }: { group: CollaborationGroup; value: string; onChange: (id: string) => void; disabled: boolean }) {
  if (!group.launchProfiles?.length && !value) return null;
  const selected = group.launchProfiles?.find(p => p.id === value);
  return <div className="mt-3 space-y-1"><label className="block space-y-1 text-xs text-muted-foreground">启动方案<select aria-label="启动方案" className={field} value={value} disabled={disabled} onChange={e => onChange(e.target.value)}><option value="">Agent 默认命令</option>{group.launchProfiles?.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>{selected && <p className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">{selected.notes || '未填写使用备注'}<code className="block break-all">{selected.command}</code></p>}{value && !selected && <p role="alert" className="text-xs text-destructive">原方案已删除，请重新选择。</p>}</div>;
}

export function CollaborationLaunchSettings({ group, agents, busy, setBusy, refresh }: {
  group: CollaborationGroup; agents: AgentLauncherInfo[]; busy: string | null;
  setBusy: (value: string | null) => void; refresh: () => Promise<void>;
}) {
  const key = `${window.location.origin}:${group.id}`;
  const [draft, setDraft] = useState(() => drafts.get(key) ?? snapshot(group));
  const current = useRef(draft); current.current = draft;
  const [selected, setSelected] = useState(draft.profiles[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState('');
  const change = (next: Draft, clearNotice = true) => { current.current = next; setDraft(next); if (dirty(next)) drafts.set(key, next); else drafts.delete(key); if (clearNotice) setNotice(''); };
  useEffect(() => { if (!dirty(current.current) && group.updatedAt >= current.current.group.updatedAt) change(snapshot(group), false); }, [group.updatedAt]);
  const profile = draft.profiles.find(p => p.id === selected);
  const edit = (patch: Partial<CollaborationLaunchProfile>) => change({ ...draft, profiles: draft.profiles.map(p => p.id === selected ? { ...p, ...patch } : p) });
  const valid = draft.profiles.every(p => p.name.trim() && p.agentSlug && p.command.trim() && !/[\x00-\x1f\x7f]/.test(p.command));
  const add = () => {
    const agent = agents[0];
    const next = { id: `profile-${crypto.randomUUID()}`, name: '', agentSlug: agent?.slug ?? '', command: agent?.command ?? '', notes: '' };
    change({ ...draft, profiles: [...draft.profiles, next] }); setSelected(next.id);
  };
  const save = async () => {
    if (busy || !valid || !dirty(draft)) return;
    setBusy('launch-profiles'); setError(null); setNotice('');
    try {
      const { group: saved } = await saveCollaborationGroup({ id: group.id, name: draft.group.name, sessionIds: draft.group.sessionIds,
        expectedUpdatedAt: draft.group.updatedAt, launchProfiles: draft.profiles, defaultLaunchProfileId: draft.defaultId || null });
      change(snapshot(saved)); setNotice('启动方案已保存。新会话使用所选方案，正在运行的成员保持原配置。'); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); }
    finally { setBusy(null); }
  };
  return <details className="mt-3 border-t border-border/15 pt-2"><summary className="min-h-11 cursor-pointer py-3 text-xs font-medium text-foreground">Agent 启动方案 · {draft.profiles.length} 个{dirty(draft) ? ' · 未保存' : ''}</summary>
    <section aria-label="Agent 启动方案" className="space-y-3">
      <p className="text-xs leading-5 text-muted-foreground">保存不同模型和参数的启动命令，填写适用场景，让协调者按备注选择。保存配置不会启动 Agent。</p>
      <fieldset disabled={!!busy} className="space-y-3">
        <label className="block space-y-1 text-xs text-muted-foreground">默认启动方案<select aria-label="默认启动方案" className={field} value={draft.defaultId} onChange={e => change({ ...draft, defaultId: e.target.value })}><option value="">使用 Agent 默认命令</option>{draft.profiles.map(p => <option key={p.id} value={p.id}>{p.name || '未命名方案'}</option>)}</select></label>
        <div className="flex items-center gap-2"><label className="min-w-0 flex-1 text-xs text-muted-foreground">编辑方案<select aria-label="编辑方案" className={`${field} mt-1`} value={selected} onChange={e => setSelected(e.target.value)}><option value="">选择方案</option>{draft.profiles.map(p => <option key={p.id} value={p.id}>{p.name || '未命名方案'}</option>)}</select></label><button type="button" className={`${action} self-end bg-surface text-foreground`} disabled={draft.profiles.length >= 20} onClick={add}><Plus size={14} />新增方案</button></div>
        {profile ? <div className="space-y-3 rounded-lg border border-border/20 p-3">
          <label className="block space-y-1 text-xs text-muted-foreground">方案名称<input className={field} value={profile.name} maxLength={100} onChange={e => edit({ name: e.target.value })} placeholder="例如：快速排查、深度实现" /></label>
          <label className="block space-y-1 text-xs text-muted-foreground">Agent 类型<select aria-label="Agent 类型" className={field} value={profile.agentSlug} onChange={e => edit({ agentSlug: e.target.value, command: agents.find(a => a.slug === e.target.value)?.command ?? '' })}>{!agents.some(a => a.slug === profile.agentSlug) && <option value={profile.agentSlug}>{profile.agentSlug || '选择 Agent'}（当前不可用）</option>}{agents.map(a => <option key={a.slug} value={a.slug}>{a.displayName}</option>)}</select></label>
          <label className="block space-y-1 text-xs text-muted-foreground">启动命令<input className={`${field} font-mono`} value={profile.command} maxLength={4096} onChange={e => edit({ command: e.target.value })} placeholder="填写完整命令，包括模型和启动参数" /></label>
          <label className="block space-y-1 text-xs text-muted-foreground">使用备注<textarea aria-label="使用备注" className={`${field} min-h-24 resize-y`} value={profile.notes} maxLength={2000} onChange={e => edit({ notes: e.target.value })} placeholder="适合哪些任务、何时不要使用；协调者会读取这些备注。" /></label>
          <details className="text-[11px] text-muted-foreground"><summary className="min-h-11 cursor-pointer py-3">CLI 方案标识</summary><code className="break-all">{profile.id}</code></details>
          <button type="button" className={`${action} text-destructive hover:bg-destructive/10`} onClick={() => { const profiles = draft.profiles.filter(p => p.id !== selected); change({ ...draft, profiles, defaultId: draft.defaultId === selected ? '' : draft.defaultId }); setSelected(profiles[0]?.id ?? ''); }}><Trash2 size={14} />移除方案（保存后生效）</button>
        </div> : <p className="text-xs text-muted-foreground">尚未选择方案。新增后可填写模型、参数和备注。</p>}
      </fieldset>
      {error && <p role="alert" className="text-xs leading-5 text-destructive">{error}。草稿已保留；重新载入会放弃草稿。</p>}
      {notice && <p role="status" className="text-xs leading-5 text-primary">{notice}</p>}
      <div className="flex flex-wrap justify-between gap-2"><button type="button" className={`${action} bg-surface text-muted-foreground`} disabled={!!busy} onClick={() => { change(snapshot(group)); setSelected(group.launchProfiles?.[0]?.id ?? ''); setError(null); }}>重新载入（放弃方案草稿）</button><button type="button" disabled={!!busy || !valid || !dirty(draft)} className={`${action} bg-primary text-primary-foreground`} onClick={() => void save()}>{busy === 'launch-profiles' ? '保存中…' : '保存启动方案'}</button></div>
    </section>
  </details>;
}
