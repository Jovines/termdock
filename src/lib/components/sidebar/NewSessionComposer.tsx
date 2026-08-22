import { Check, Folder, LoaderCircle, RefreshCw, Terminal, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getDirectorySuggestions, type AgentLauncherInfo } from '../../terminal/api';
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
  onRefreshAgents,
  onSelectAgent,
  onClose,
  onOptionsChange,
}: {
  directories: string[];
  tmuxAvailable: boolean;
  options: { mode: 'shell' | 'tmux'; cwd?: string; command?: string };
  agents: AgentLauncherInfo[];
  selectedAgent: NewSessionAgentPreference;
  detecting: boolean;
  onRefreshAgents: () => void;
  onSelectAgent: (agent: NewSessionAgentPreference) => void;
  onClose: () => void;
  onOptionsChange: (options: { mode: 'shell' | 'tmux'; cwd?: string; command?: string }) => void;
}) {
  const { t } = useI18n();
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

  return (
    <section className="shrink-0 border-t border-border/15 bg-surface-2/35 px-3 py-3 animate-slide-down" aria-label={t('sidebar.newSession')}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Terminal size={13} />
          </span>
          <div className="min-w-0">
            <div className="text-[12px] font-semibold text-foreground">{t('sidebar.newSession')}</div>
            <div className="truncate text-[10.5px] text-muted-foreground">Agent · {t('sidebar.workingDirectory')}</div>
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
        <button
          type="button"
          onClick={() => {
            onSelectAgent(null);
            onOptionsChange({ ...options, command: undefined });
          }}
          className={`flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left transition ${selectedAgent === null ? 'bg-primary/15 text-primary ring-1 ring-primary/30' : 'bg-surface text-muted-foreground hover:bg-surface-elevated hover:text-foreground'}`}
        >
          <Terminal size={12} className="shrink-0" />
          <span className="truncate text-[11px] font-semibold">Terminal</span>
          {selectedAgent === null && <Check size={11} className="ml-auto shrink-0" />}
        </button>
        {agents.map((agent) => {
          const selected = selectedAgent?.slug === agent.slug;
          return (
            <button
              key={agent.slug}
              type="button"
              onClick={() => {
                onSelectAgent(agent);
                onOptionsChange({ ...options, command: agent.command });
              }}
              title={agent.command}
              className={`flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left transition ${selected ? 'bg-primary/15 text-primary ring-1 ring-primary/30' : 'bg-surface text-muted-foreground hover:bg-surface-elevated hover:text-foreground'}`}
            >
              <AgentBrandAvatar agent={agent} size={14} />
              <span className="truncate text-[11px] font-semibold">{agent.displayName}</span>
              {selected && <Check size={11} className="ml-auto shrink-0" />}
            </button>
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
    </section>
  );
}
