import { ChevronDown, Folder, History, LoaderCircle, Plus, RefreshCw, RotateCcw, Terminal, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { AgentLauncherInfo, AgentResumeHistoryEntry, CcSwitchProviderInfo } from '../../terminal/api';
import { getCcSwitchProviders } from '../../terminal/api';
import { getCwdLeafName } from '../../terminal/display';
import { useI18n } from '../../i18n';
import type { NewSessionAgentPreference } from '../../hooks/useNewSessionAgentPreference';
import { ccSwitchAppForSlug } from '../../hooks/useCcSwitchProviderPreference';
import { AgentBrandAvatar } from '../AgentIndicators';
import { DirectoryPickerDialog } from './DirectoryPickerDialog';

const COMMANDS_STORAGE_KEY = 'termdock:new-session-commands:v1';
const SAVED_COMMAND_PREFIX = '__saved_command__:';

function getSavedCommands(commands: Record<string, string>): string[] {
  return [...new Set(Object.entries(commands)
    .filter(([key]) => key.startsWith(SAVED_COMMAND_PREFIX) || key === '__custom__' || key === '__terminal__')
    .map(([, command]) => command.trim()).filter(Boolean))];
}

function readLaunchCommands(): Record<string, string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(COMMANDS_STORAGE_KEY) || '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

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
  rememberedProviders,
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
  rememberedProviders: Record<string, string>;
  onRefreshAgents: () => void;
  onSelectAgent: (agent: NewSessionAgentPreference) => void;
  onLaunchAgent: (agent: NewSessionAgentPreference, command?: string, extras?: { providerId?: string }) => void;
  onResumeHistory: (entry: AgentResumeHistoryEntry) => void;
  onRemoveResumeHistory: (entryId: string) => void;
  onClose: () => void;
  onOptionsChange: (options: { mode: 'shell' | 'tmux'; cwd?: string; command?: string }) => void;
}) {
  const { t, locale } = useI18n();
  const [launchAgent, setLaunchAgent] = useState<NewSessionAgentPreference>(selectedAgent);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [customCommandSelected, setCustomCommandSelected] = useState(false);

  const [launchCommands, setLaunchCommands] = useState(readLaunchCommands);
  const [savedCommands, setSavedCommands] = useState(() => getSavedCommands(readLaunchCommands()));
  const [selectedSavedCommand, setSelectedSavedCommand] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const commandKey = customCommandSelected ? '__custom__' : launchAgent?.slug ?? '__terminal__';
  const defaultCommand = launchAgent?.command ?? '';
  const launchCommand = customCommandSelected
    ? launchCommands.__custom__ ?? launchCommands.__terminal__ ?? ''
    : launchAgent ? launchCommands[commandKey] ?? defaultCommand : '';

  const saveCommand = () => {
    const command = launchCommand.trim() || defaultCommand;
    if (customCommandSelected && !command) return;
    try {
      const next = { ...readLaunchCommands(), [commandKey]: command };
      if (customCommandSelected) {
        // Preserve legacy saved commands before replacing the custom draft.
        for (const saved of getSavedCommands(readLaunchCommands())) next[SAVED_COMMAND_PREFIX + saved] = saved;
        next[SAVED_COMMAND_PREFIX + command] = command;
      }
      localStorage.setItem(COMMANDS_STORAGE_KEY, JSON.stringify(next));
      setSavedCommands(getSavedCommands(next));
      if (customCommandSelected) setSelectedSavedCommand(command);
      setSaveStatus('saved');
    } catch {
      setSaveStatus('error');
    }
  };

  const deleteSavedCommand = () => {
    if (!selectedSavedCommand) return;
    try {
      const next = readLaunchCommands();
      for (const [key, value] of Object.entries(next)) {
        if ((key.startsWith(SAVED_COMMAND_PREFIX) || key === '__custom__' || key === '__terminal__')
          && value.trim() === selectedSavedCommand) delete next[key];
      }
      localStorage.setItem(COMMANDS_STORAGE_KEY, JSON.stringify(next));
      setSavedCommands(getSavedCommands(next));
      setLaunchCommands((current) => ({ ...current, __custom__: '' }));
      setSelectedSavedCommand(null);
      setSaveStatus('idle');
    } catch {
      setSaveStatus('error');
    }
  };

  const startSession = () => {
    const command = launchCommand.trim() || defaultCommand;
    if (customCommandSelected && !command) return;
    saveCommand();
    onLaunchAgent(launchAgent, command, { providerId: providerId || undefined });
  };

  const [providers, setProviders] = useState<CcSwitchProviderInfo[]>([]);
  const [providerId, setProviderId] = useState('');

  const ccSwitchApp = ccSwitchAppForSlug(launchAgent?.slug);

  // Load cc-switch providers whenever the picked agent supports per-instance
  // overrides; prefill the remembered pick when it still exists in cc-switch.
  useEffect(() => {
    if (!ccSwitchApp) {
      setProviders([]);
      setProviderId('');
      return;
    }
    let cancelled = false;
    void getCcSwitchProviders(ccSwitchApp).then((result) => {
      if (cancelled) return;
      setProviders(result.available ? result.providers : []);
      const remembered = rememberedProviders[ccSwitchApp];
      setProviderId(remembered && result.providers.some((provider) => provider.id === remembered) ? remembered : '');
    }).catch(() => {
      if (!cancelled) {
        setProviders([]);
        setProviderId('');
      }
    });
    return () => { cancelled = true; };
  }, [ccSwitchApp, rememberedProviders]);

  const uniqueDirectories = useMemo(() => [...new Set(directories.filter(Boolean))].slice(0, 5), [directories]);
  const selectedOption = customCommandSelected ? (selectedSavedCommand ? SAVED_COMMAND_PREFIX + selectedSavedCommand : '__custom__') : launchAgent?.slug ?? '__terminal__';
  const selectStartupOption = (slug: string) => {
    setSaveStatus('idle');
    const saved = slug.startsWith(SAVED_COMMAND_PREFIX) ? slug.slice(SAVED_COMMAND_PREFIX.length) : null;
    setSelectedSavedCommand(saved);
    setCustomCommandSelected(slug === '__custom__' || saved !== null);
    if (saved !== null || slug === '__custom__') setLaunchCommands((current) => ({ ...current, __custom__: saved ?? '' }));
    setLaunchAgent(agents.find((agent) => agent.slug === slug) ?? null);
  };
  const launchName = customCommandSelected ? selectedSavedCommand ?? t('sidebar.customStartupCommand') : launchAgent?.displayName ?? 'Terminal';
  const defaultName = selectedAgent?.displayName ?? 'Terminal';
  const launchIsDefault = !customCommandSelected && (launchAgent === null ? selectedAgent === null : selectedAgent?.slug === launchAgent.slug);

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
    <section className="relative z-20 flex max-h-[min(56svh,36rem)] shrink-0 flex-col overflow-hidden border-t border-border bg-[var(--chrome-bg)] animate-slide-down" aria-label={t('sidebar.newSessionComposerTitle')}>
      <div className="flex shrink-0 items-center justify-between gap-3 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground"><Terminal size={14} /></span>
          <div className="min-w-0">
            <div className="text-[12px] font-semibold text-foreground">{t('sidebar.newSessionComposerTitle')}</div>
          </div>
        </div>
        <button type="button" onClick={onClose} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-surface-2 hover:text-foreground" aria-label={t('common.close')}><X size={14} /></button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-1">
        <div className="flex min-h-11 items-center justify-between gap-3">
          <span className="shrink-0 text-[11px] text-muted-foreground">{t('sidebar.sessionMode')}</span>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface p-0.5">
            {(['shell', 'tmux'] as const).map((item) => (
              <button
                key={item}
                type="button"
                disabled={item === 'tmux' && !tmuxAvailable}
                onClick={() => onOptionsChange({ ...options, mode: item })}
                aria-pressed={options.mode === item}
                title={item === 'tmux' ? t(tmuxAvailable ? 'sidebar.tmuxKeepsRunning' : 'sidebar.newTmuxDisabled') : undefined}
                className={`min-h-9 rounded-md px-4 text-[11px] font-medium transition ${options.mode === item ? 'bg-surface-2 text-foreground' : 'text-muted-foreground hover:text-foreground'} disabled:cursor-not-allowed disabled:opacity-40`}
              >
                {item === 'shell' ? t('sidebar.newShell') : t('sidebar.newTmux')}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-1 flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">{t('sidebar.startupCommand')}</span>
          <button type="button" onClick={onRefreshAgents} disabled={detecting} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:opacity-50" title={t('sidebar.detectAgents')} aria-label={t('sidebar.detectAgents')}>
            <RefreshCw size={12} className={detecting ? 'animate-spin' : ''} />
          </button>
        </div>
        <div role="radiogroup" aria-label={t('sidebar.startupCommand')} className="flex flex-wrap gap-1">
          {agents.map((agent) => {
            const selected = !customCommandSelected && launchAgent?.slug === agent.slug;
            return (
              <button key={agent.slug} type="button" role="radio" aria-checked={selected} onClick={() => selectStartupOption(agent.slug)}
                className={`inline-flex min-h-7 items-center gap-1 rounded-md px-2 text-[10.5px] font-medium transition ${selected ? 'bg-surface-2 text-foreground ring-1 ring-inset ring-primary/50' : 'bg-surface text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}>
                <AgentBrandAvatar agent={agent} size={12} />
                <span className="max-w-[9rem] truncate">{agent.displayName}</span>
                {selectedAgent?.slug === agent.slug && <span className="ml-0.5 text-[9px] text-muted-foreground">{t('sidebar.defaultAgent')}</span>}
              </button>
            );
          })}
          {savedCommands.map((command) => {
            const selected = customCommandSelected && selectedSavedCommand === command;
            return (
              <button key={command} type="button" role="radio" aria-checked={selected} onClick={() => selectStartupOption(SAVED_COMMAND_PREFIX + command)} title={command}
                className={`inline-flex min-h-7 items-center gap-1 rounded-md px-2 transition ${selected ? 'bg-surface-2 text-foreground ring-1 ring-inset ring-primary/50' : 'bg-surface text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}>
                <History size={10} className="shrink-0" />
                <span className="max-w-[9rem] truncate font-mono text-[10px]">{command}</span>
              </button>
            );
          })}
          <button type="button" role="radio" aria-checked={selectedOption === '__terminal__'} onClick={() => selectStartupOption('__terminal__')}
            className={`inline-flex min-h-7 items-center gap-1 rounded-md px-2 text-[10.5px] font-medium transition ${selectedOption === '__terminal__' ? 'bg-surface-2 text-foreground ring-1 ring-inset ring-primary/50' : 'bg-surface text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}>
            <Terminal size={11} className="shrink-0" />
            <span>Terminal</span>
            {selectedAgent === null && <span className="ml-0.5 text-[9px] font-normal text-muted-foreground">{t('sidebar.defaultAgent')}</span>}
          </button>
          <button type="button" role="radio" aria-checked={selectedOption === '__custom__'} onClick={() => selectStartupOption('__custom__')}
            className={`inline-flex min-h-7 items-center gap-0.5 rounded-md px-2 text-[10.5px] font-medium transition ${selectedOption === '__custom__' ? 'bg-surface-2 text-foreground ring-1 ring-inset ring-primary/50' : 'bg-surface text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}>
            <Plus size={10} className="shrink-0" />
            <span>{t('sidebar.addStartupCommand')}</span>
          </button>
        </div>
        {!launchIsDefault && !customCommandSelected && (
          <div className="mt-1 flex min-h-8 items-center justify-between gap-2 px-0.5 text-[10px]">
            <span className="truncate text-muted-foreground">{t('sidebar.currentDefaultAgent', { name: defaultName })}</span>
            <button type="button" onClick={() => onSelectAgent(launchAgent)} className="relative z-10 shrink-0 rounded-md px-2 py-1.5 font-medium text-primary transition hover:bg-primary/10">{t('sidebar.makeDefault')}</button>
          </div>
        )}

        {ccSwitchApp && providers.length > 0 && (
          <>
            <div className="mt-2.5 flex items-center justify-between">
              <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{t('sidebar.provider')}</span>
              {providerId && <span className="text-[10px] text-muted-foreground">{t('sidebar.providerOverrideHint')}</span>}
            </div>
            <label className="relative mt-1 flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border border-border/30 bg-surface px-3 text-foreground transition hover:bg-surface-2 focus-within:border-primary/50">
              <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${providerId ? 'bg-primary' : 'bg-muted-foreground/40'}`} />
              <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold">
                {providers.find((provider) => provider.id === providerId)?.name ?? t('sidebar.providerFollowGlobal')}
              </span>
              <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
              <select
                aria-label={t('sidebar.provider')}
                value={providerId}
                onChange={(event) => setProviderId(event.target.value)}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              >
                <option value="">{t('sidebar.providerFollowGlobal')}</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.isCurrent ? `${provider.name} · ${t('sidebar.providerCurrent')}` : provider.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        {saveStatus === 'error' && <p role="alert" className="text-[10px] text-destructive">{t('sidebar.saveStartupCommandFailed')}</p>}
        {(launchAgent || customCommandSelected) && (
          <details key={selectedSavedCommand ?? commandKey} open={(customCommandSelected && !selectedSavedCommand) || undefined} className="group/command mt-0.5">
            <summary className="ml-auto flex min-h-8 w-fit cursor-pointer list-none items-center gap-1 rounded-md px-1 text-[10px] text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 [&::-webkit-details-marker]:hidden">
              {t(customCommandSelected && !selectedSavedCommand ? 'sidebar.customStartupCommand' : 'sidebar.changeStartupCommand')}
              <ChevronDown size={11} className="transition-transform group-open/command:rotate-180" />
            </summary>
            <div className="flex items-center justify-end gap-2">
              <label htmlFor="new-session-command" className="sr-only">{t('sidebar.startupCommand')}</label>
              {launchAgent && launchCommand !== defaultCommand && (
                <button type="button" onClick={() => { setLaunchCommands((current) => ({ ...current, [commandKey]: defaultCommand })); setSaveStatus('idle'); }} className="min-h-8 rounded-md px-2 text-[10px] text-primary transition hover:bg-primary/10">{t('sidebar.resetStartupCommand')}</button>
              )}
            </div>
            <input
              id="new-session-command"
              value={launchCommand}
              onChange={(event) => { setLaunchCommands((current) => ({ ...current, [commandKey]: event.target.value })); setSaveStatus('idle'); }}
              placeholder={defaultCommand || t('sidebar.startupCommandPlaceholder')}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="off"
              className="min-h-10 w-full rounded-lg border-0 bg-surface px-3 font-mono text-[16px] text-foreground outline-none ring-1 ring-inset ring-border transition focus:ring-primary/50 sm:text-[11px]"
            />
            <div className="mt-1 flex items-center justify-end gap-2" aria-live="polite">
              {customCommandSelected && selectedSavedCommand && (
                <button type="button" onClick={deleteSavedCommand} className="mr-auto inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-[10px] text-muted-foreground transition hover:text-destructive" aria-label={t('sidebar.deleteStartupCommand')}>
                  <Trash2 size={11} />{t('sidebar.deleteStartupCommand')}
                </button>
              )}
              <button
                type="button"
                onClick={saveCommand}
                disabled={saveStatus === 'saved' || (customCommandSelected && !launchCommand.trim())}
                className="min-h-8 rounded-md px-2 text-[10px] font-medium text-primary transition hover:bg-primary/10 disabled:cursor-default disabled:opacity-50"
              >
                {t(saveStatus === 'saved' ? 'sidebar.startupCommandSaved' : 'sidebar.saveStartupCommand')}
              </button>
            </div>
            <p className="mb-2 mt-1.5 px-0.5 text-[10px] leading-relaxed text-muted-foreground">{t(launchAgent ? 'sidebar.agentStartupCommandHint' : 'sidebar.terminalStartupCommandHint')}</p>

          </details>
        )}

        <label htmlFor="new-session-directory" className="mt-2 block text-[11px] text-muted-foreground">{t('sidebar.workingDirectory')}</label>
        <button
          id="new-session-directory"
          type="button"
          aria-haspopup="dialog"
          onClick={() => setDirectoryPickerOpen(true)}
          className="mt-1 flex min-h-11 w-full items-center gap-2 rounded-lg border border-transparent bg-surface px-2.5 font-mono text-[11px] text-foreground outline-none transition hover:bg-surface-2 focus-visible:border-primary"
        >
          <Folder size={12} className="shrink-0 text-muted-foreground" />
          <span className={`min-w-0 flex-1 truncate text-left ${options.cwd ? '' : 'text-muted-foreground'}`}>
            {options.cwd || t('sidebar.directoryPlaceholder')}
          </span>
        </button>

        {uniqueDirectories.length > 0 && (
          <div className="mt-1.5 flex gap-1 overflow-x-auto pb-0.5" aria-label={t('sidebar.recentDirectories')}>
            {uniqueDirectories.map((directory) => (
              <button key={directory} type="button" onClick={() => chooseDirectory(directory)} title={directory} className="min-h-8 shrink-0 rounded-md px-2 text-[10px] text-muted-foreground transition hover:bg-surface hover:text-foreground">{getCwdLeafName(directory) || directory}</button>
            ))}
          </div>
        )}

        {(resumeHistory.length > 0 || resumeHistoryError) && (
          <details className="mt-1">
            <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-md px-1 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground transition hover:text-foreground">
              <History size={11} /><span className="flex-1">{t('sidebar.resumeHistory')}</span>
              {resumeHistoryLoading && <LoaderCircle size={10} className="animate-spin" />}
              {resumeHistory.length > 0 && <span className="normal-case tracking-normal">{t('sidebar.resumeHistoryCount', { n: resumeHistory.length })}</span>}
              <ChevronDown size={11} />
            </summary>
            {resumeHistory.length > 0 && (
              <div className="mt-1 divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
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

      <div className="shrink-0 bg-[var(--chrome-bg)] px-3 pb-3 pt-2">
        <button type="button" onClick={startSession} disabled={customCommandSelected && !launchCommand.trim()} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 text-[12px] font-semibold text-primary-foreground transition hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40" aria-label={t('sidebar.launchSessionWith', { name: launchName })}>
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
