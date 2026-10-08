import { useEffect, useState } from 'react';
import { ArrowUp, ChevronRight, File, Folder, X } from 'lucide-react';
import { useI18n } from '../../i18n';
import { listDirectory, type FileEntry } from '../../terminal/api';
import { LoadingSpinner } from '../ui/Loading';

interface Props {
  rootPath: string;
  paths: string[];
  disabled: boolean;
  onChange: (paths: string[]) => void;
}

export function GitIgnoreExceptionPicker({ rootPath, paths, disabled, onChange }: Props) {
  const { t } = useI18n();
  // Browse using paths relative to the configured root, including when it is a symlink.
  const [directory, setDirectory] = useState('');
  const [revision, setRevision] = useState(0);
  const [listing, setListing] = useState<{ directory: string; entries: FileEntry[]; truncated: boolean } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [limitReached, setLimitReached] = useState(false);
  const browsePath = `${rootPath.replace(/[\\/]+$/, '')}/${directory}`;

  useEffect(() => {
    const controller = new AbortController();
    setListing(null);
    setLoadFailed(false);
    // Omit gitIgnoreRoot so ignored entries remain available for selection.
    void listDirectory(browsePath, controller.signal, true, 'pick_git_ignore_exception')
      .then((result) => {
        if (!controller.signal.aborted) setListing({ directory, entries: result.entries, truncated: !!result.truncated });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadFailed(true);
      });
    return () => controller.abort();
  }, [browsePath, directory, revision]);

  const navigate = (next: string) => {
    setListing(null);
    setLoadFailed(false);
    setDirectory(next);
  };
  const ready = listing?.directory === directory;
  const changePaths = (next: string[]) => {
    if (next.length > 200) {
      setLimitReached(true);
      return;
    }
    setLimitReached(false);
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-lg border border-border/30 bg-surface-2">
        <div className="flex items-center gap-2 border-b border-border/20 p-2">
          <button type="button" disabled={disabled || !directory} onClick={() => navigate(directory.slice(0, Math.max(0, directory.lastIndexOf('/'))))} aria-label={t('rightSidebar.parentFolder')} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-elevated hover:text-foreground disabled:opacity-30"><ArrowUp size={14} /></button>
          <button type="button" disabled={disabled || !directory} onClick={() => navigate('')} aria-label={t('rightSidebar.backToProjectRoot')} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-elevated hover:text-foreground disabled:opacity-30"><Folder size={14} /></button>
          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={browsePath}>{directory || './'}</span>
        </div>
        <div className="h-56 overflow-y-auto overscroll-contain p-1" role="group" aria-label={t('rightSidebar.gitIgnoreExceptionsPaths')} aria-busy={!ready && !loadFailed}>
          {loadFailed ? (
            <div className="flex flex-col items-center gap-2 p-4 text-center text-xs">
              <p role="alert" className="text-destructive">{t('rightSidebar.gitIgnoreExceptionsLoadFailed')}</p>
              <button type="button" disabled={disabled} onClick={() => { setLoadFailed(false); setRevision((value) => value + 1); }} className="rounded-md px-3 py-2 text-primary hover:bg-surface-elevated disabled:opacity-40">{t('common.retry')}</button>
            </div>
          ) : !ready ? (
            <div className="flex h-full items-center justify-center"><LoadingSpinner size={18} /></div>
          ) : listing.entries.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted-foreground">{t('rightSidebar.gitIgnoreExceptionsEmptyDirectory')}</p>
          ) : listing.entries.map((entry) => {
            const relative = directory ? `${directory}/${entry.name}` : entry.name;
            const path = relative + (entry.type === 'directory' ? '/' : '');
            const selected = paths.includes(path) || paths.includes(relative);
            const inherited = paths.some((parent) => parent.endsWith('/') && relative.startsWith(parent));
            const Icon = entry.type === 'directory' ? Folder : File;
            return (
              <div key={entry.name} className="flex items-center gap-1 rounded-md hover:bg-surface-elevated">
                <label className="flex min-h-10 min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 text-xs">
                  <input type="checkbox" checked={selected || inherited} disabled={disabled || inherited} onChange={() => changePaths(selected ? paths.filter((item) => item !== path && item !== relative) : [...paths, path])} className="h-4 w-4 shrink-0 accent-[var(--primary)] disabled:opacity-40" />
                  <Icon size={14} className="shrink-0 text-muted-foreground" />
                  <span className="truncate" title={entry.name}>{entry.name}</span>
                </label>
                {entry.type === 'directory' && <button type="button" disabled={disabled} onClick={() => navigate(relative)} aria-label={t('rightSidebar.gitIgnoreExceptionsOpenDirectory', { name: entry.name })} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface hover:text-foreground disabled:opacity-40"><ChevronRight size={15} /></button>}
              </div>
            );
          })}
          {ready && listing.truncated && <p className="px-2 py-3 text-xs text-muted-foreground">{t('rightSidebar.gitIgnoreExceptionsTruncated')}</p>}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium">{t('rightSidebar.gitIgnoreExceptionsSelected', { count: paths.length })}</span>
        <button type="button" disabled={disabled || paths.length === 0} onClick={() => changePaths([])} className="rounded-md px-2 py-1 text-muted-foreground hover:bg-surface-2 hover:text-foreground disabled:opacity-40">{t('rightSidebar.gitIgnoreExceptionsClear')}</button>
      </div>
      {paths.length > 0 && <ul className="max-h-24 overflow-y-auto overscroll-contain">
        {paths.map((path) => (
          <li key={path} className="flex items-center gap-2 rounded-md pl-2 text-xs hover:bg-surface-2">
            <span className="min-w-0 flex-1 truncate font-mono" title={path}>{path}</span>
            <button type="button" disabled={disabled} onClick={() => changePaths(paths.filter((item) => item !== path))} aria-label={t('rightSidebar.gitIgnoreExceptionsRemove', { path })} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-elevated hover:text-foreground disabled:opacity-40"><X size={13} /></button>
          </li>
        ))}
      </ul>}
      {limitReached && <p role="alert" className="text-xs text-destructive">{t('rightSidebar.gitIgnoreExceptionsInvalid')}</p>}
    </div>
  );
}
