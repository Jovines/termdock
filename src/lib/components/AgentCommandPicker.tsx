import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { useKeyboardLayer } from '../hooks/useKeyboardLayer';
import { deleteAgentCommand, saveAgentCommand, selectAgentCommand, useAgentCommandPresets } from '../terminal/launchCommands';
import type { AgentLauncherInfo } from '../terminal/api';

const field = 'min-h-11 w-full min-w-0 rounded-lg border border-border/40 bg-surface-2 px-3 py-2 text-base text-foreground outline-none focus:border-primary sm:text-sm';
export function AgentCommandPicker({ agent, value, onChange }: { agent: Pick<AgentLauncherInfo, 'slug' | 'command'>; value: string; onChange: (command: string) => void }) {
  const { t } = useI18n(), id = useId(), dialogRef = useRef<HTMLElement>(null), selectRef = useRef<HTMLSelectElement>(null);
  const { presets, selectedId } = useAgentCommandPresets(agent.slug, agent.command);
  const matched = selectedId === null && value.trim() === agent.command.trim() ? undefined
    : presets.find(p => p.id === selectedId && p.command === value.trim()) ?? presets.find(p => p.command === value.trim());
  const [draft, setDraft] = useState<{ id?: string; name: string; command: string } | null>(null);
  const [error, setError] = useState(false);
  const close = () => { setDraft(null); setError(false); };
  useKeyboardLayer(dialogRef, !!draft, close, () => selectRef.current);
  const selection = matched?.id ?? (!value.trim() || value.trim() === agent.command.trim() ? '__default__' : '__current__');
  const choose = (next: string) => {
    setError(false);
    if (next === '__new__') { setDraft({ name: '', command: value || agent.command }); return; }
    const preset = presets.find(p => p.id === next);
    onChange(preset?.command ?? agent.command);
    try { selectAgentCommand(agent.slug, agent.command, preset?.id ?? null); } catch { setError(true); }
  };
  return <div className="min-w-0 space-y-1.5 text-sm">
    <div className="flex items-center justify-between gap-2">
      <label htmlFor={id} className="text-muted-foreground">{t('sidebar.commandPreset')}</label>
      <button type="button" className="min-h-9 shrink-0 px-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => { setError(false); setDraft({ id: matched?.id, name: matched?.name ?? '', command: value || agent.command }); }}>{t('sidebar.changeStartupCommand')}</button>
    </div>
    <select ref={selectRef} id={id} className={field} value={selection} onChange={e => choose(e.target.value)}>
      <option value="__default__">{t('sidebar.agentDefaultCommand')}</option>
      {presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      {selection === '__current__' && <option value="__current__">{t('sidebar.currentAgentCommand')}</option>}
      <option value="__new__">{t('sidebar.addAgentCommand')}</option>
    </select>
    {error && !draft && <p role="alert" className="text-xs text-destructive">{t('sidebar.saveStartupCommandFailed')}</p>}
    {draft && createPortal(<div data-sidebar-composer-popover="sidebar-launch-options">
      <button type="button" className="fixed inset-0 z-modal-backdrop bg-[var(--app-backdrop)] backdrop-blur-sm" onClick={close} aria-label={t('common.cancel')} />
      <section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}
        className="fixed bottom-[max(0.75rem,env(safe-area-inset-bottom,0px))] left-3 right-3 z-modal-panel flex max-h-[calc(100svh-2rem)] flex-col overflow-hidden rounded-2xl border border-border/30 bg-surface text-foreground shadow-xl sm:bottom-auto sm:left-1/2 sm:right-auto sm:top-1/2 sm:w-[28rem] sm:max-w-[calc(100vw-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2">
        <header className="shrink-0 border-b border-border/20 px-5 py-4"><h2 id={`${id}-title`} className="text-base font-semibold">{t('sidebar.customStartupCommand')}</h2></header>
        <form className="flex min-h-0 flex-col" onSubmit={e => {
          e.preventDefault(); e.stopPropagation();
          try { const saved = saveAgentCommand(agent.slug, agent.command, draft); onChange(saved.command); close(); } catch { setError(true); }
        }}>
          <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain px-5 py-4">
            <label className="block space-y-2 text-sm text-muted-foreground">{t('sidebar.commandPresetName')}<input className={field} maxLength={80} value={draft.name} placeholder={t('sidebar.commandPresetName')} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
            <label className="block space-y-2 text-sm text-muted-foreground">{t('sidebar.startupCommand')}<input required className={`${field} font-mono`} value={draft.command} placeholder={agent.command} autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false} onChange={e => { setDraft({ ...draft, command: e.target.value }); setError(false); }} /></label>
            <p className="text-xs leading-6 text-muted-foreground">{t('sidebar.sharedAgentCommandsHint')}</p>
            {error && <p role="alert" className="text-sm text-destructive">{t('sidebar.saveStartupCommandFailed')}</p>}
          </div>
          <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border/20 px-4 py-3">
            {draft.id && <button type="button" className="mr-auto min-h-11 px-2 text-xs text-muted-foreground hover:text-destructive" onClick={() => {
              try { deleteAgentCommand(agent.slug, agent.command, draft.id!); onChange(agent.command); close(); } catch { setError(true); }
            }}>{t('sidebar.deleteStartupCommand')}</button>}
            <button type="button" onClick={close} className="min-h-11 rounded-lg px-3 text-sm text-muted-foreground hover:bg-surface-2">{t('common.cancel')}</button>
            <button type="submit" disabled={!draft.command.trim()} className="min-h-11 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-40">{t('sidebar.saveStartupCommand')}</button>
          </footer>
        </form>
      </section>
    </div>, document.body)}
  </div>;
}
