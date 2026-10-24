import { useState } from 'react';
import { FolderOpen, Send } from 'lucide-react';
import type { AgentLauncherInfo } from '../../terminal/api';
import type { SessionOption } from '../../stores/useSessionDirectory';
import type { TodoLaunchConfig } from '../../todos/api';
import { useTodoDraft } from '../../todos/workspace';
import { directoryName } from '../../todos/preferences';
import { getAgentLaunchCommand } from '../../terminal/launchCommands';
import { AgentCommandPicker } from '../AgentCommandPicker';
import { DirectoryPickerDialog } from '../sidebar/DirectoryPickerDialog';
import { todoGhost, todoPrimary, todoSecondary } from './TodoForms';

const field = 'min-h-11 w-full min-w-0 rounded-lg border border-border/40 bg-surface-2 px-3 py-2.5 text-base text-foreground outline-none focus:border-primary sm:text-sm';
const lastKey = (workspace: string) => `termdock:todo-recipient:v1:${workspace}`;
export function rememberTodoRecipient(workspace: string, sessionId: string) { try { localStorage.setItem(lastKey(workspace), sessionId); } catch { /* In-memory drafts still work. */ } }
export function TodoHandoff({ workspace, ids, config, agents, sessions, initialSessionId, directories, busy, loading, title, onSend, onCancel, onChangeRecipient }: {
  workspace: string; ids: string[]; config: TodoLaunchConfig; agents: AgentLauncherInfo[]; sessions: SessionOption[];
  initialSessionId: string; directories: string[]; busy: boolean; loading: boolean; title: string;
  onSend: (value: { sessionId?: string; config?: TodoLaunchConfig; note: string }) => void; onCancel: () => void; onChangeRecipient: () => void;
}) {
  const [draft, setDraft] = useTodoDraft(workspace, `handoff:${JSON.stringify(ids.slice().sort())}`, { target: initialSessionId, note: '', config: { ...config, prompt: '' } });
  const [picker, setPicker] = useState(false);
  const target = initialSessionId;
  const recipient = sessions.find(session => session.sessionId === target && session.agent?.slug);
  const isNew = target === '__new__', agent = agents.find(agent => agent.slug === draft.config.agentSlug);
  const valid = isNew ? !loading && !!agent : !!recipient;
  return <form aria-label="交给会话" className="flex min-h-0 flex-1 flex-col" onSubmit={e => { e.preventDefault(); if (!busy && valid) onSend({ note: draft.note, ...(isNew ? { config: draft.config } : { sessionId: target }) }); }}>
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-5 py-5"><p className="truncate text-sm text-muted-foreground" title={title}>{ids.length > 1 ? `${ids.length} 条待办，一起发送` : title}</p>
      <fieldset disabled={busy} className="min-w-0 space-y-5">
        <div className="space-y-2">
          <div className="flex min-h-11 items-center gap-3"><span className="text-sm text-muted-foreground">交给谁</span><span className="min-w-0 flex-1 truncate text-sm font-medium">{isNew ? '新建会话' : recipient?.displayName || '原会话已不可用，请重新选择'}</span><button type="button" className={todoGhost} onClick={onChangeRecipient}>更换</button></div>
        </div>
        {isNew && <details className="rounded-lg border border-border/20 px-3 text-sm text-muted-foreground"><summary className="min-h-11 cursor-pointer py-3">{agent?.displayName || '选择 Agent'} · {directoryName(draft.config.cwd) || '服务默认目录'} · 更改</summary><div className="space-y-4 pb-3">
          <label className="block space-y-2">Agent<select className={field} value={draft.config.agentSlug} onChange={e => { const chosen = agents.find(agent => agent.slug === e.target.value); setDraft({ ...draft, config: { ...draft.config, agentSlug: e.target.value, command: chosen ? getAgentLaunchCommand(chosen.slug, chosen.command) : '' } }); }}><option value="" disabled>选择 Agent</option>{agents.map(agent => <option key={agent.slug} value={agent.slug}>{agent.displayName}</option>)}</select></label>
          {agent && <AgentCommandPicker key={agent.slug} agent={agent} value={draft.config.command} onChange={command => setDraft({ ...draft, config: { ...draft.config, command } })} />}
          <label className="block space-y-2">工作目录<div className="flex gap-2"><input className={field} value={draft.config.cwd} placeholder="服务默认目录" onChange={e => setDraft({ ...draft, config: { ...draft.config, cwd: e.target.value } })} /><button type="button" className={todoSecondary} aria-label="选择工作目录" onClick={() => setPicker(true)}><FolderOpen size={16} /></button></div></label>
          {!!directories.length && <div className="flex gap-2 overflow-x-auto">{directories.map(cwd => <button type="button" key={cwd} className="min-h-10 shrink-0 rounded-md bg-surface-2 px-2 text-xs" title={cwd} onClick={() => setDraft({ ...draft, config: { ...draft.config, cwd } })}>{directoryName(cwd)}</button>)}</div>}
        </div></details>}
        <label className="block space-y-2 text-sm text-muted-foreground">补充一句话<span className="ml-2 text-xs">选填</span><textarea className={`${field} min-h-28 resize-y`} maxLength={4000} value={draft.note} onChange={e => setDraft({ ...draft, target, note: e.target.value })} placeholder="例如：先分析不要改代码，和之前那个问题一起处理…" /></label>
      </fieldset>
    </div>
    <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border/20 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom,0px))]"><button type="button" className={todoGhost} disabled={busy} onClick={onCancel}>取消</button><button className={todoPrimary} disabled={busy || !valid}><Send size={16} />{busy ? '正在发送…' : '发送并进入会话'}</button></footer>
    <DirectoryPickerDialog open={picker} title="选择工作目录" initialPath={draft.config.cwd || '/'} onCancel={() => setPicker(false)} onConfirm={cwd => { setDraft({ ...draft, config: { ...draft.config, cwd } }); setPicker(false); }} />
  </form>;
}
