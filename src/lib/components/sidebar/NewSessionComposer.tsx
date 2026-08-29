import { Check, Folder, History, LoaderCircle, Pin, RefreshCw, RotateCcw, Terminal, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getDirectorySuggestions, type AgentLauncherInfo, type AgentResumeHistoryEntry } from '../../terminal/api';
import { getCwdLeafName } from '../../terminal/display';
import { useI18n } from '../../i18n';
import type { NewSessionAgentPreference } from '../../hooks/useNewSessionAgentPreference';
import { AgentBrandAvatar } from '../AgentIndicators';

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
  const [directorySuggestions, setDirectorySuggestions] = useState<string[]>([]);
  const [directorySuggestionsOpen, setDirectorySuggestionsOpen] = useState(false);
  const [highlightedDirectoryIndex, setHighlightedDirectoryIndex] = useState(0);

  const uniqueDirectories = useMemo(() => [...new Set(directories.filter(Boolean))].slice(0, 5), [directories]);
  useEffect(() => {
    if (!directorySuggestionsOpen) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void getDirectorySuggestions(options.cwd ?? '', controller.signal).then((remote) => {
        const query = (options.cwd ?? '').trim().toLowerCase();
        const recent = uniqueDirectories.filter((directory) => !query || directory.toLowerCase().includes(query));
        setDirectorySuggestions([...new Set([...recent, ...remote])].slice(0, 10));
        setHighlightedDirectoryIndex(0);
      }).catch((error) => {
        if ((error as Error).name !== 'AbortError') setDirectorySuggestions([]);
      });
    }, 140);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [options.cwd, directorySuggestionsOpen, uniqueDirectories]);

  const chooseDirectory = (directory: string) => {
    onOptionsChange({ ...options, cwd: directory });
    setDirectorySuggestionsOpen(false);
  };

  const formatClosedAt = (timestamp: number) => new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));

  return (
    <section className="relative z-20 max-h-[min(72svh,42rem)] shrink-0 overflow-y-auto overscroll-contain border-t border-border/25 bg-surface-elevated px-3 py-3 shadow-[0_-18px_42px_var(--app-shadow-soft)] animate-slide-down" aria-label={t('sidebar.newSession')}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Terminal size={13} />
          </span>
          <div className="min-w-0">
            <div className="text-[12px] font-semibold text-foreground">{t('sidebar.newSession')}</div>
            <div className="truncate text-[10.5px] text-muted-foreground">{t('sidebar.newSessionHint')}</div>
          </div>
        </div>
        <button type="button" onClick={onClose} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground" aria-label={t('common.close')}>
          <X size={13} />
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-surface-2 p-1">
        {(['shell', 'tmux'] as const).map((item) => (
          <button
            key={item}
            type="button"
            disabled={item === 'tmux' && !tmuxAvailable}
            onClick={() => onOptionsChange({ ...options, mode: item })}
            className={`rounded-md px-2 py-1.5 text-[11px] font-medium transition ${options.mode === item ? 'bg-surface-elevated text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {item === 'shell' ? 'Shell' : 'Tmux'}
          </button>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Agent</span>
        <button type="button" onClick={onRefreshAgents} disabled={detecting} className="inline-flex items-center gap-1 text-[10px] text-muted-foreground transition hover:text-foreground disabled:opacity-50" title={t('sidebar.detectAgents')}>
          <RefreshCw size={10} className={detecting ? 'animate-spin' : ''} />
          {t('sidebar.detectAgents')}
        </button>
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-1">
        {[null, ...agents].map((agent) => {
          const isTerminal = agent === null;
          const selected = isTerminal ? selectedAgent === null : selectedAgent?.slug === agent.slug;
          const name = isTerminal ? 'Terminal' : agent.displayName;
          return (
            <div
              key={agent?.slug ?? 'terminal'}
              className={`flex min-w-0 overflow-hidden rounded-lg border transition ${selected ? 'border-primary bg-primary/15 text-primary' : 'border-border bg-surface text-muted-foreground hover:bg-surface-elevated hover:text-foreground'}`}
            >
              <button
                type="button"
                onClick={() => onLaunchAgent(agent)}
                title={t('sidebar.launchSessionWith', { name })}
                aria-label={t('sidebar.launchSessionWith', { name })}
                className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left"
              >
                {isTerminal ? <Terminal size={12} className="shrink-0" /> : <AgentBrandAvatar agent={agent} size={14} />}
                <span className="truncate text-[11px] font-semibold">{name}</span>
              </button>
              <button
                type="button"
                onClick={() => onSelectAgent(agent)}
                title={selected ? t('sidebar.currentNewSessionDefault', { name }) : t('sidebar.setNewSessionDefault', { name })}
                aria-label={selected ? t('sidebar.currentNewSessionDefault', { name }) : t('sidebar.setNewSessionDefault', { name })}
                aria-pressed={selected}
                className={`relative inline-flex w-8 shrink-0 items-center justify-center transition ${selected ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
              >
                <span aria-hidden="true" className="pointer-events-none absolute inset-y-2 left-0 w-px bg-border opacity-30" />
                {selected ? <Check size={11} /> : <Pin size={10} />}
              </button>
            </div>
          );
        })}
        {detecting && agents.length === 0 && (
          <div className="flex items-center gap-2 px-2.5 py-2 text-[10.5px] text-muted-foreground">
            <LoaderCircle size={11} className="animate-spin" />
            Agent…
          </div>
        )}
      </div>

      <label className="mt-3 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{t('sidebar.workingDirectory')}</label>
      <div className="relative mt-1.5">
        <Folder size={12} className="pointer-events-none absolute left-2.5 top-2.5 text-muted-foreground" />
        <input
          value={options.cwd ?? ''}
          onFocus={() => setDirectorySuggestionsOpen(true)}
          onBlur={() => window.setTimeout(() => setDirectorySuggestionsOpen(false), 120)}
          onChange={(event) => { onOptionsChange({ ...options, cwd: event.target.value }); setDirectorySuggestionsOpen(true); }}
          onKeyDown={(event) => {
            if (!directorySuggestionsOpen || directorySuggestions.length === 0) return;
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setHighlightedDirectoryIndex((index) => (index + 1) % directorySuggestions.length);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setHighlightedDirectoryIndex((index) => (index - 1 + directorySuggestions.length) % directorySuggestions.length);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              chooseDirectory(directorySuggestions[highlightedDirectoryIndex]!);
            } else if (event.key === 'Escape') {
              setDirectorySuggestionsOpen(false);
            }
          }}
          placeholder={t('sidebar.directoryPlaceholder')}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={directorySuggestionsOpen && directorySuggestions.length > 0}
          aria-controls="new-session-directory-suggestions"
          className="h-8 w-full rounded-lg border border-border/15 bg-surface pl-8 pr-2 font-mono text-[11px] text-foreground outline-none transition focus:border-primary/50"
        />
        {directorySuggestionsOpen && directorySuggestions.length > 0 && (
          <div id="new-session-directory-suggestions" role="listbox" className="absolute left-0 right-0 top-[calc(100%+4px)] z-30 max-h-44 overflow-y-auto rounded-lg border border-border/15 bg-surface p-1 shadow-xl shadow-[0_18px_48px_var(--app-shadow-soft)] animate-fade-in">
            {directorySuggestions.map((directory, index) => (
              <button
                key={directory}
                type="button"
                role="option"
                aria-selected={index === highlightedDirectoryIndex}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHighlightedDirectoryIndex(index)}
                onClick={() => chooseDirectory(directory)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${index === highlightedDirectoryIndex ? 'bg-surface-elevated text-foreground' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}
              >
                <Folder size={11} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate font-mono text-[10.5px]">{directory}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {uniqueDirectories.length > 0 && (
        <div className="mt-1.5 flex gap-1 overflow-x-auto pb-0.5">
          {uniqueDirectories.map((directory) => (
            <button key={directory} type="button" onClick={() => chooseDirectory(directory)} title={directory} className="shrink-0 rounded-md bg-surface-2 px-2 py-1 text-[10px] text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground">
              {getCwdLeafName(directory) || directory}
            </button>
          ))}
        </div>
      )}

      {(resumeHistory.length > 0 || resumeHistoryError) && (
        <div className="mt-3 border-t border-border/15 pt-3">
          <div className="flex items-center justify-between gap-2 px-0.5">
            <span className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              <History size={11} />
              {t('sidebar.resumeHistory')}
            </span>
            {resumeHistory.length > 0 && (
              <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
                {resumeHistoryLoading && <LoaderCircle size={10} className="animate-spin" />}
                {t('sidebar.resumeHistoryCount', { n: resumeHistory.length })}
              </span>
            )}
          </div>
          {resumeHistory.length > 0 && (
            <div className="mt-1.5 divide-y divide-border/10 overflow-hidden rounded-lg border border-border/15 bg-surface">
              {resumeHistory.slice(0, 6).map((entry) => {
                const pending = resumeHistoryPendingId === entry.id;
                return (
                  <div key={entry.id} className="group flex min-w-0 items-stretch transition hover:bg-surface-2">
                    <button
                      type="button"
                      disabled={resumeHistoryPendingId !== null}
                      onClick={() => onResumeHistory(entry)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left disabled:cursor-wait disabled:opacity-60"
                      aria-label={t('sidebar.resumeHistoryAction', { title: entry.title })}
                    >
                      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        {pending ? <LoaderCircle size={13} className="animate-spin" /> : <AgentBrandAvatar agent={entry.agent} size={14} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11px] font-semibold text-foreground">{entry.title}</span>
                        <span className="block truncate text-[9.5px] text-muted-foreground">
                          {entry.agent.displayName} · {formatClosedAt(entry.closedAt)}
                        </span>
                      </span>
                      <RotateCcw size={12} className="shrink-0 text-muted-foreground transition group-hover:text-primary" />
                    </button>
                    <button
                      type="button"
                      disabled={resumeHistoryPendingId !== null}
                      onClick={() => onRemoveResumeHistory(entry.id)}
                      className="relative inline-flex w-9 shrink-0 items-center justify-center text-muted-foreground transition hover:text-destructive disabled:opacity-40"
                      aria-label={t('sidebar.resumeHistoryRemove', { title: entry.title })}
                    >
                      <span aria-hidden="true" className="pointer-events-none absolute inset-y-2 left-0 w-px bg-border opacity-30" />
                      <Trash2 size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {resumeHistoryError && (
            <div role="alert" className="mt-1.5 px-1 text-[10px] text-destructive">{resumeHistoryError}</div>
          )}
        </div>
      )}
    </section>
  );
}
