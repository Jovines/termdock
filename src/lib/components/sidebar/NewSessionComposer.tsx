import { ArrowRight, Bot, Folder, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getAgentLaunchers, getDirectorySuggestions } from '../../terminal/api';
import { getCwdLeafName } from '../../terminal/display';
import { useI18n } from '../../i18n';

const STORAGE_KEY = 'termdock:new-session-presets:v1';

interface LaunchPreset { id: string; name: string; command: string }

function readPresets(): LaunchPreset[] | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((item): item is LaunchPreset =>
      typeof item?.id === 'string' && typeof item?.name === 'string' && typeof item?.command === 'string');
  } catch { return null; }
}

function persistPresets(presets: LaunchPreset[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

export function NewSessionComposer({
  directories,
  initialDirectory,
  tmuxAvailable,
  defaultMode,
  onClose,
  onCreate,
}: {
  directories: string[];
  initialDirectory?: string;
  tmuxAvailable: boolean;
  defaultMode: 'shell' | 'tmux';
  onClose: () => void;
  onCreate: (options: { mode: 'shell' | 'tmux'; cwd?: string; command?: string }) => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'shell' | 'tmux'>(defaultMode);
  const [cwd, setCwd] = useState(initialDirectory || '');
  const [command, setCommand] = useState('');
  const [presets, setPresets] = useState<LaunchPreset[]>(() => readPresets() ?? []);
  const [detecting, setDetecting] = useState(false);
  const [directorySuggestions, setDirectorySuggestions] = useState<string[]>([]);
  const [directorySuggestionsOpen, setDirectorySuggestionsOpen] = useState(false);
  const [highlightedDirectoryIndex, setHighlightedDirectoryIndex] = useState(0);

  const detect = async (merge: boolean) => {
    setDetecting(true);
    try {
      const agents = await getAgentLaunchers();
      const detected = agents.map((agent) => ({ id: `agent:${agent.slug}`, name: agent.displayName, command: agent.command }));
      const next = merge
        ? [...presets.filter((preset) => !detected.some((item) => item.id === preset.id)), ...detected]
        : detected;
      setPresets(next);
      persistPresets(next);
    } finally { setDetecting(false); }
  };

  useEffect(() => {
    if (readPresets() === null) void detect(false);
    // Preset initialization must run once. Removed recommendations stay removed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const uniqueDirectories = useMemo(() => [...new Set(directories.filter(Boolean))].slice(0, 6), [directories]);
  useEffect(() => {
    if (!directorySuggestionsOpen) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void getDirectorySuggestions(cwd, controller.signal).then((remote) => {
        const query = cwd.trim().toLowerCase();
        const recent = uniqueDirectories.filter((directory) =>
          !query || directory.toLowerCase().includes(query));
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
  }, [cwd, directorySuggestionsOpen, uniqueDirectories]);

  const chooseDirectory = (directory: string) => {
    setCwd(directory);
    setDirectorySuggestionsOpen(false);
  };
  const addCustomPreset = () => {
    const trimmed = command.trim();
    if (!trimmed) return;
    const next = [...presets, { id: `custom:${Date.now()}`, name: trimmed.split(/\s+/)[0] || trimmed, command: trimmed }];
    setPresets(next);
    persistPresets(next);
  };
  const removePreset = (id: string) => {
    const next = presets.filter((preset) => preset.id !== id);
    setPresets(next);
    persistPresets(next);
  };

  return (
    <section className="shrink-0 border-t border-border/15 bg-surface-2/35 px-3 py-3 animate-fade-in" aria-label={t('sidebar.newSessionAdvanced')}>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[12px] font-semibold text-foreground">{t('sidebar.newSession')}</div>
          <div className="mt-0.5 text-[10.5px] text-muted-foreground">{t('sidebar.newSessionHint')}</div>
        </div>
        <button type="button" onClick={onClose} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-elevated hover:text-foreground" aria-label={t('common.close')}><X size={13} /></button>
      </div>

      <div className="mt-3 flex gap-1 rounded-lg bg-surface-2 p-1">
        {(['shell', 'tmux'] as const).map((item) => (
          <button key={item} type="button" disabled={item === 'tmux' && !tmuxAvailable} onClick={() => setMode(item)} className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-medium transition ${mode === item ? 'bg-surface-elevated text-foreground' : 'text-muted-foreground hover:text-foreground'} disabled:opacity-40`}>{item === 'shell' ? 'Shell' : 'Tmux'}</button>
        ))}
      </div>

      <label className="mt-3 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{t('sidebar.workingDirectory')}</label>
      <div className="relative mt-1">
        <Folder size={12} className="pointer-events-none absolute left-2.5 top-2.5 text-muted-foreground" />
        <input
          value={cwd}
          onFocus={() => setDirectorySuggestionsOpen(true)}
          onBlur={() => window.setTimeout(() => setDirectorySuggestionsOpen(false), 120)}
          onChange={(event) => { setCwd(event.target.value); setDirectorySuggestionsOpen(true); }}
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
          className="h-8 w-full rounded-lg border border-border/15 bg-surface pl-8 pr-2 font-mono text-[11px] text-foreground outline-none focus:border-primary/50"
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
      {uniqueDirectories.length > 0 && <div className="mt-1.5 flex gap-1 overflow-x-auto pb-0.5">{uniqueDirectories.map((directory) => <button key={directory} type="button" onClick={() => setCwd(directory)} title={directory} className="shrink-0 rounded-md bg-surface-2 px-2 py-1 text-[10px] text-muted-foreground hover:bg-surface-elevated hover:text-foreground">{getCwdLeafName(directory) || directory}</button>)}</div>}

      <div className="mt-3 flex items-center justify-between gap-2">
        <label className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{t('sidebar.startCommand')}</label>
        <span className="flex items-center gap-2">
          {presets.length > 0 && <button type="button" onClick={() => { setPresets([]); persistPresets([]); }} className="text-[10px] text-muted-foreground hover:text-destructive">{t('common.clear')}</button>}
          <button type="button" onClick={() => void detect(true)} disabled={detecting} className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"><RefreshCw size={10} className={detecting ? 'animate-spin' : ''} />{t('sidebar.detectAgents')}</button>
        </span>
      </div>
      {presets.length > 0 && <div className="mt-1.5 space-y-1">{presets.map((preset) => <div key={preset.id} className="group flex items-center rounded-md bg-surface text-muted-foreground ring-1 ring-border/10 transition hover:bg-primary/10 hover:text-primary"><button type="button" onClick={() => onCreate({ mode, cwd: cwd.trim() || undefined, command: preset.command })} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"><Bot size={12} /><span className="truncate text-[11px] font-semibold">{preset.name}</span><code className="ml-auto truncate text-[9.5px] opacity-60">{preset.command}</code><ArrowRight size={11} className="shrink-0 opacity-50 transition group-hover:translate-x-0.5 group-hover:opacity-100" /></button><button type="button" onClick={() => removePreset(preset.id)} className="mr-1 inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground opacity-60 hover:bg-destructive/15 hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100" aria-label={t('common.delete')}><Trash2 size={11} /></button></div>)}</div>}
      <div className="mt-3 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{t('sidebar.customCommand')}</div>
      <div className="mt-1.5 flex gap-1">
        <input value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && command.trim()) onCreate({ mode, cwd: cwd.trim() || undefined, command: command.trim() }); }} placeholder={t('sidebar.commandPlaceholder')} className="h-8 min-w-0 flex-1 rounded-lg border border-border/15 bg-surface px-2 font-mono text-[11px] text-foreground outline-none focus:border-primary/50" />
        <button type="button" onClick={addCustomPreset} disabled={!command.trim()} title={t('sidebar.savePreset')} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground disabled:opacity-40"><Plus size={12} /></button>
      </div>
      {command.trim() && <button type="button" onClick={() => onCreate({ mode, cwd: cwd.trim() || undefined, command: command.trim() })} className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[12px] font-semibold text-primary-foreground transition hover:bg-primary/90 active:scale-[0.99]"><ArrowRight size={13} />{t('sidebar.createAndRun')}</button>}
    </section>
  );
}
