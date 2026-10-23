import { ChevronDown, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { SESSION_ICONS, validSessionIcon, type SessionAppearances } from '../server/shared/sessionAppearance';
import { SessionIcon, sessionIconLabels } from '../lib/federation/SessionIcon';
export function ShareSessionAppearanceFields({ sessions, value, onChange }: {
  sessions: { sessionId: string; name: string }[]; value: SessionAppearances; onChange: (value: SessionAppearances) => void;
}) {
  const [editingIcon, setEditingIcon] = useState<string>();
  return <div className="space-y-3">{sessions.map(session => {
    const appearance = value[session.sessionId] || {}, icon = appearance.icon || 'message';
    const update = (next: typeof appearance) => onChange({ ...value, [session.sessionId]: next });
    return <div key={session.sessionId} className="rounded-xl border border-border bg-background/40 p-3">
      <div className="flex items-center gap-3">
        <button type="button" aria-label={`更改${session.name}的分享图标`} aria-expanded={editingIcon === session.sessionId} className="flex h-12 w-12 shrink-0 items-center justify-center gap-0.5 rounded-xl bg-surface-2 text-primary hover:bg-surface-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setEditingIcon(current => current === session.sessionId ? undefined : session.sessionId)}><SessionIcon icon={icon} size={23} /><ChevronDown size={11} /></button>
        <label className="min-w-0 flex-1"><span className="mb-1 block text-xs text-muted-foreground">分享显示名称</span><input aria-label={sessions.length === 1 ? '分享显示名称' : `${session.name}的分享显示名称`} maxLength={80} className="min-h-9 w-full min-w-0 border-b border-transparent bg-transparent text-base font-medium outline-none placeholder:text-muted-foreground focus:border-primary" placeholder={session.name} value={appearance.name ?? session.name} onChange={event => update({ ...appearance, name: event.target.value })} /></label>
        {(appearance.name !== undefined || appearance.icon !== undefined) && <button type="button" aria-label={`重置${session.name}的分享外观`} title="恢复会话默认名称与图标" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-2" onClick={() => onChange(Object.fromEntries(Object.entries(value).filter(([id]) => id !== session.sessionId)))}><RotateCcw size={14} /></button>}
      </div>
      {editingIcon === session.sessionId && <fieldset className="mt-3 space-y-3 border-t border-border pt-3"><legend className="sr-only">分享图标</legend><div className="grid grid-cols-8 gap-1">{SESSION_ICONS.map(option => <button key={option} type="button" title={sessionIconLabels[option]} aria-label={`使用${sessionIconLabels[option]}图标`} aria-pressed={icon === option} className={`flex min-h-11 items-center justify-center rounded-lg border ${icon === option ? 'border-primary bg-primary/10 text-primary' : 'border-transparent text-muted-foreground hover:bg-surface-2'}`} onClick={() => { update({ ...appearance, icon: option }); setEditingIcon(undefined); }}><SessionIcon icon={option} size={20} /></button>)}</div><label className="flex items-center gap-3 text-xs text-muted-foreground"><span>自定义 Emoji</span><input aria-label={`${session.name}的自定义Emoji`} className="min-h-11 w-24 rounded-lg border border-border bg-background px-3 text-center text-xl text-foreground outline-none focus:ring-2 focus:ring-ring" placeholder="例如 🚀" maxLength={32} value={SESSION_ICONS.includes(icon as typeof SESSION_ICONS[number]) ? '' : icon} onChange={event => update({ ...appearance, icon: event.target.value || undefined })} /></label>{appearance.icon && !validSessionIcon(appearance.icon) && <p role="alert" className="text-xs text-destructive">请输入一个 Emoji，或选择上方图标。</p>}</fieldset>}
    </div>;
  })}<p className="text-xs leading-5 text-muted-foreground">接收者看到的会话名称与图标，可单独设置。</p></div>;
}
