import { ChevronDown, Folder, History, LoaderCircle, RefreshCw, RotateCcw, Terminal, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { AgentLauncherInfo, AgentResumeHistoryEntry } from '../../terminal/api';
import { getCwdLeafName } from '../../terminal/display';
import { useI18n } from '../../i18n';
import type { NewSessionAgentPreference } from '../../hooks/useNewSessionAgentPreference';
import { AgentBrandAvatar } from '../AgentIndicators';
import { DirectoryPickerDialog } from './DirectoryPickerDialog';

export function NewSessionComposer({
  directories,
  tmuxAvailable,
  options,
  agents,
  selectedAgent,
  detecting,
  resumeHistory,
  resumeHistoryLoading,
  resumeHistoryPendingId,
  resumeHistoryError,
  onRefreshAgents,
  onSelectAgent,
  onLaunchAgent,
  onResumeHistory,
  onRemoveResumeHistory,
  onClose,
  onOptionsChange,
}: {
  directories: string[];
  tmuxAvailable: boolean;
  options: { mode: 'shell' | 'tmux'; cwd?: string; command?: string };
  agents: AgentLauncherInfo[];
  selectedAgent: NewSessionAgentPreference;
  detecting: boolean;
  resumeHistory: AgentResumeHistoryEntry[];
  resumeHistoryLoading: boolean;
  resumeHistoryPendingId: string | null;
  resumeHistoryError: string | null;
  onRefreshAgents: () => void;
  onSelectAgent: (agent: NewSessionAgentPreference) => void;
  onLaunchAgent: (agent: NewSessionAgentPreference) => void;
  onResumeHistory: (entry: AgentResumeHistoryEntry) => void;
  onRemoveResumeHistory: (entryId: string) => void;
  onClose: () => void;
  onOptionsChange: (options: { mode: 'shell' | 'tmux'; cwd?: string; command?: string }) => void;
}) {
  const { t, locale } = useI18n();
  const [launchAgent, setLaunchAgent] = useState<NewSessionAgentPreference>(selectedAgent);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);

  const uniqueDirectories = useMemo(() => [...new Set(directories.filter(Boolean))].slice(0, 5), [directories]);
  const launchName = launchAgent?.displayName ?? 'Terminal';
  const defaultName = selectedAgent?.displayName ?? 'Terminal';
  const launchIsDefault = launchAgent === null ? selectedAgent === null : selectedAgent?.slug === launchAgent.slug;

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (directoryPickerOpen) return;
      onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [directoryPickerOpen, onClose]);

  const chooseDirectory = (directory: string) => {
    onOptionsChange({ ...options, cwd: directory });
    setDirectoryPickerOpen(false);
  };

  const formatClosedAt = (timestamp: number) => new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));

  return (
    <section className="relative z-20 flex max-h-[min(56svh,36rem)] shrink-0 flex-col overflow-hidden border-t border-border/25 bg-surface-elevated shadow-[0_-18px_42px_var(--app-shadow-soft)] animate-slide-down" aria-label={t('sidebar.newSessionComposerTitle')}>
      <div className="flex shrink-0 items-center justify-between gap-3 px-3 pb-2 pt-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary"><Terminal size={14} /></span>
          <div className="min-w-0">
            <div className="text-[12px] font-semibold text-foreground">{t('sidebar.newSessionComposerTitle')}</div>
            <div className="truncate text-[10.5px] text-muted-foreground">{t('sidebar.newSessionHint')}</div>
          </div>
        </div>
        <button type="button" onClick={onClose} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-surface-2 hover:text-foreground" aria-label={t('common.close')}><X size={14} /></button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{t('sidebar.sessionMode')}</span>
          {options.mode === 'tmux' && <span className="text-[10px] text-muted-foreground">{t('sidebar.tmuxKeepsRunning')}</span>}
        </div>
        <div className="mt-1.5 grid grid-cols-2 gap-1 rounded-lg bg-surface-2 p-1">
          {(['shell', 'tmux'] as const).map((item) => (
            <button
              key={item}
              type="button"
              disabled={item === 'tmux' && !tmuxAvailable}
              onClick={() => onOptionsChange({ ...options, mode: item })}
              aria-pressed={options.mode === item}
              title={item === 'tmux' && !tmuxAvailable ? t('sidebar.newTmuxDisabled') : undefined}
              className={`min-h-9 rounded-md px-2 py-1.5 text-[11px] font-medium transition ${options.mode === item ? 'bg-surface-elevated text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'} disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {item === 'shell' ? t('sidebar.newShell') : t('sidebar.newTmux')}
            </button>
          ))}
        </div>

        <div className="mt-3 flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Agent</span>
          <button type="button" onClick={onRefreshAgents} disabled={detecting} className="inline-flex min-h-8 items-center gap-1 px-1 text-[10px] text-muted-foreground transition hover:text-foreground disabled:opacity-50" title={t('sidebar.detectAgents')}>
            <RefreshCw size={10} className={detecting ? 'animate-spin' : ''} />{t('sidebar.detectAgents')}
          </button>
        </div>
        <label className="relative mt-1 flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border border-border/30 bg-surface px-3 text-foreground transition hover:bg-surface-2 focus-within:border-primary/50">
          {launchAgent ? <AgentBrandAvatar agent={launchAgent} size={16} /> : <Terminal size={14} className="shrink-0" />}
          <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold">{launchName}</span>
          {launchIsDefault && <span className="shrink-0 text-[9.5px] text-muted-foreground">{t('sidebar.defaultAgent')}</span>}
          {detecting ? <LoaderCircle size={12} className="shrink-0 animate-spin text-muted-foreground" /> : <ChevronDown size={13} className="shrink-0 text-muted-foreground" />}
          <select
            aria-label="Agent"
            value={launchAgent?.slug ?? '__terminal__'}
            onChange={(event) => {
              const slug = event.target.value;
              setLaunchAgent(slug === '__terminal__' ? null : agents.find((agent) => agent.slug === slug) ?? null);
            }}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          >
            <option value="__terminal__">Terminal</option>
            {agents.map((agent) => <option key={agent.slug} value={agent.slug}>{agent.displayName}</option>)}
          </select>
        </label>
        {!launchIsDefault && (
          <div className="mt-1 flex min-h-8 items-center justify-between gap-2 px-0.5 text-[10px]">
            <span className="truncate text-muted-foreground">{t('sidebar.currentDefaultAgent', { name: defaultName })}</span>
            <button type="button" onClick={() => onSelectAgent(launchAgent)} className="relative z-10 shrink-0 rounded-md px-2 py-1.5 font-medium text-primary transition hover:bg-primary/10">{t('sidebar.makeDefault')}</button>
          </div>
        )}

        <label htmlFor="new-session-directory" className="mt-2.5 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{t('sidebar.workingDirectory')}</label>
        <button
          id="new-session-directory"
          type="button"
          aria-haspopup="dialog"
          onClick={() => setDirectoryPickerOpen(true)}
          className="mt-1 flex h-9 w-full items-center gap-2 rounded-lg border border-border/25 bg-surface px-2.5 font-mono text-[11px] text-foreground outline-none transition hover:bg-surface-2 focus-visible:border-primary/50"
        >
          <Folder size={12} className="shrink-0 text-muted-foreground" />
          <span className={`min-w-0 flex-1 truncate text-left ${options.cwd ? '' : 'text-muted-foreground'}`}>
            {options.cwd || t('sidebar.directoryPlaceholder')}
          </span>
        </button>

        {uniqueDirectories.length > 0 && (
          <div className="mt-1.5 flex gap-1 overflow-x-auto pb-0.5" aria-label={t('sidebar.recentDirectories')}>
            {uniqueDirectories.map((directory) => (
              <button key={directory} type="button" onClick={() => chooseDirectory(directory)} title={directory} className="min-h-8 shrink-0 rounded-md bg-surface-2 px-2 text-[10px] text-muted-foreground transition hover:bg-surface hover:text-foreground">{getCwdLeafName(directory) || directory}</button>
            ))}
          </div>
        )}

        {(resumeHistory.length > 0 || resumeHistoryError) && (
          <details className="mt-3 border-t border-border/15 pt-2">
            <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-md px-1 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground transition hover:text-foreground">
              <History size={11} /><span className="flex-1">{t('sidebar.resumeHistory')}</span>
              {resumeHistoryLoading && <LoaderCircle size={10} className="animate-spin" />}
              {resumeHistory.length > 0 && <span className="normal-case tracking-normal">{t('sidebar.resumeHistoryCount', { n: resumeHistory.length })}</span>}
              <ChevronDown size={11} />
            </summary>
            {resumeHistory.length > 0 && (
              <div className="mt-1 divide-y divide-border/10 overflow-hidden rounded-lg border border-border/15 bg-surface">
                {resumeHistory.slice(0, 6).map((entry) => {
                  const pending = resumeHistoryPendingId === entry.id;
                  return (
                    <div key={entry.id} className="group flex min-w-0 items-stretch transition hover:bg-surface-2">
                      <button type="button" disabled={resumeHistoryPendingId !== null} onClick={() => onResumeHistory(entry)} className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left disabled:cursor-wait disabled:opacity-60" aria-label={t('sidebar.resumeHistoryAction', { title: entry.title })}>
                        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">{pending ? <LoaderCircle size={13} className="animate-spin" /> : <AgentBrandAvatar agent={entry.agent} size={14} />}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11px] font-semibold text-foreground">{entry.title}</span>
                          <span className="block truncate text-[9.5px] text-muted-foreground">{entry.agent.displayName} · {formatClosedAt(entry.closedAt)}</span>
                        </span>
                        <RotateCcw size={12} className="shrink-0 text-muted-foreground transition group-hover:text-primary" />
                      </button>
                      <button type="button" disabled={resumeHistoryPendingId !== null} onClick={() => onRemoveResumeHistory(entry.id)} className="relative inline-flex w-11 shrink-0 items-center justify-center text-muted-foreground transition hover:text-destructive disabled:opacity-40" aria-label={t('sidebar.resumeHistoryRemove', { title: entry.title })}>
                        <span aria-hidden="true" className="pointer-events-none absolute inset-y-2 left-0 w-px bg-border opacity-30" /><Trash2 size={12} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {resumeHistoryError && <div role="alert" className="mt-1.5 px-1 text-[10px] text-destructive">{resumeHistoryError}</div>}
          </details>
        )}
      </div>

      <div className="shrink-0 border-t border-border/15 bg-surface-elevated p-3">
        <button type="button" onClick={() => onLaunchAgent(launchAgent)} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 text-[12px] font-semibold text-primary-foreground shadow-md shadow-primary/20 transition hover:bg-primary/90 active:scale-[0.99]" aria-label={t('sidebar.launchSessionWith', { name: launchName })}>
          {launchAgent ? <AgentBrandAvatar agent={launchAgent} size={15} /> : <Terminal size={14} />}<span className="truncate">{t('sidebar.launchSessionWith', { name: launchName })}</span>
        </button>
      </div>
      <DirectoryPickerDialog
        open={directoryPickerOpen}
        initialPath={options.cwd?.trim() || uniqueDirectories[0] || '/'}
        title={t('sidebar.chooseDirectory')}
        onCancel={() => setDirectoryPickerOpen(false)}
        onConfirm={chooseDirectory}
      />
    </section>
  );
}
