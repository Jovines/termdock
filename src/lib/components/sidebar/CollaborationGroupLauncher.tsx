import { useState } from 'react';
import { LayoutDashboard, MessageCircle, Pencil, Plus, Search } from 'lucide-react';
import { collaborationMemberLabel } from '../../collaboration/display';
import type { CollaborationGroup, OrchestrationSession } from '../../terminal/api';

export function CollaborationGroupLauncher({ groups, sessions, busy, onOpen, onSettings, onCreate }: {
  groups: CollaborationGroup[];
  sessions: OrchestrationSession[];
  busy: boolean;
  onOpen: (id: string, view: 'tasks' | 'messages') => void;
  onSettings: (id: string, trigger: HTMLButtonElement) => void;
  onCreate: () => void;
}) {
  const [query, setQuery] = useState('');
  const rows = groups.filter(group => !query.trim() || `${group.name} ${group.sessionIds.map(id => sessions.find(session => session.sessionId === id)?.name ?? '').join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <section aria-label="协作组列表" className="space-y-3">
    <div className="flex items-start justify-between gap-3">
      <p className="text-xs leading-6 text-muted-foreground">成员消息用于日常交流；看板用于目标、交付与验收。</p>
      <button type="button" disabled={busy} className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-40" onClick={onCreate}><Plus size={14} />新建协作组</button>
    </div>
    {(groups.length > 5 || query) && <label className="relative block"><span className="sr-only">搜索协作组</span><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索组名或成员" className="min-h-11 w-full rounded-lg border border-border/20 bg-surface-2 py-2 pl-9 pr-3 text-xs text-foreground outline-none focus:border-primary/60" /></label>}
    <div className="divide-y divide-border/15 rounded-xl border border-border/15">
      {rows.map(group => {
        const members = group.sessionIds.flatMap(id => { const member = sessions.find(session => session.sessionId === id); return member ? [member] : []; });
        return <article key={group.id} aria-label={group.name} className="p-3 sm:flex sm:items-center sm:gap-3">
          <div className="min-w-0 flex-1"><h3 className="break-words text-sm font-medium leading-6 text-foreground">{group.name}</h3><p className="mt-1 break-words text-[11px] leading-5 text-muted-foreground">{group.sessionIds.length ? `${group.sessionIds.length} 位成员${members.length ? ` · ${members.slice(0, 2).map(member => collaborationMemberLabel(member, members)).join('、')}${members.length > 2 ? '等' : ''}` : ''}` : '尚未添加成员，可以稍后配置'}</p></div>
          <div className="mt-2 flex shrink-0 items-center gap-1 sm:mt-0">
            <button type="button" aria-label={`成员消息：${group.name}`} disabled={busy} className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-surface-2 px-3 text-xs text-foreground hover:bg-surface-elevated disabled:opacity-40" onClick={() => onOpen(group.id, 'messages')}><MessageCircle size={14} />成员消息</button>
            <button type="button" aria-label={`看板：${group.name}`} disabled={busy} className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 text-xs text-muted-foreground hover:bg-surface-2 disabled:opacity-40" onClick={() => onOpen(group.id, 'tasks')}><LayoutDashboard size={14} />看板</button>
            <button type="button" aria-label={`设置：${group.name}`} title="组设置" disabled={busy} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-2 disabled:opacity-40" onClick={event => onSettings(group.id, event.currentTarget)}><Pencil size={14} /></button>
          </div>
        </article>;
      })}
      {!rows.length && <p className="px-3 py-6 text-xs text-muted-foreground">没有匹配的协作组，试试其他名称。</p>}
    </div>
  </section>;
}
