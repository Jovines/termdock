import { ArrowUp, Check, FolderTree, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../i18n';
import { FileTree } from './FileTree';

function normalizeDirectory(path: string): string {
  return path.trim().replace(/\/+$/, '') || '/';
}

function parentDirectory(path: string): string {
  const normalized = normalizeDirectory(path);
  if (normalized === '/') return '/';
  const separator = normalized.lastIndexOf('/');
  return separator <= 0 ? '/' : normalized.slice(0, separator);
}

export function DirectoryPickerDialog({
  open,
  initialPath,
  title,
  labels,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  initialPath: string;
  title: string;
  labels?: Partial<{
    hint: string;
    cancel: string;
    confirm: string;
    close: string;
    parent: string;
  }>;
  onCancel: () => void;
  onConfirm: (path: string) => void;
}) {
  const { t } = useI18n();
  const copy = {
    hint: labels?.hint ?? t('sidebar.directoryPickerHint'),
    cancel: labels?.cancel ?? t('common.cancel'),
    confirm: labels?.confirm ?? t('sidebar.useThisFolder'),
    close: labels?.close ?? t('common.close'),
    parent: labels?.parent ?? t('rightSidebar.parentFolder'),
  };
  const [currentPath, setCurrentPath] = useState(() => normalizeDirectory(initialPath));

  useEffect(() => {
    if (open) setCurrentPath(normalizeDirectory(initialPath));
  }, [initialPath, open]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [onCancel, open]);

  if (!open) return null;

  return createPortal(
    <>
      <button
        type="button"
        className="fixed inset-0 z-modal-backdrop cursor-default bg-[var(--app-backdrop)] backdrop-blur-sm"
        onClick={onCancel}
        aria-label={copy.cancel}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="directory-picker-title"
        className="fixed bottom-[max(0.75rem,env(safe-area-inset-bottom,0px))] left-[max(0.75rem,env(safe-area-inset-left,0px))] right-[max(0.75rem,env(safe-area-inset-right,0px))] top-[max(0.75rem,env(safe-area-inset-top,0px))] z-modal-panel flex flex-col overflow-hidden rounded-2xl border border-border/15 bg-surface shadow-[0_28px_70px_var(--app-shadow-strong),0_14px_32px_var(--app-shadow-soft)] sm:bottom-auto sm:left-1/2 sm:right-auto sm:top-1/2 sm:h-[min(72svh,36rem)] sm:w-[min(36rem,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-border/15 px-4 py-3">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary"><FolderTree size={15} /></span>
          <div className="min-w-0 flex-1">
            <h2 id="directory-picker-title" className="text-[13px] font-semibold text-foreground">{title}</h2>
            <p className="mt-0.5 text-[10px] text-muted-foreground">{copy.hint}</p>
          </div>
          <button type="button" autoFocus onClick={onCancel} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-surface-2 hover:text-foreground" aria-label={copy.close}><X size={15} /></button>
        </header>

        <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border/15 px-3 py-1.5">
          <button type="button" disabled={currentPath === '/'} onClick={() => setCurrentPath(parentDirectory(currentPath))} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-surface-2 hover:text-foreground disabled:opacity-30" aria-label={copy.parent}><ArrowUp size={14} /></button>
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-foreground" title={currentPath}>{currentPath}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
          <FileTree rootPath={currentPath} directoriesOnly onFileSelect={() => undefined} onDirectoryRoot={setCurrentPath} selectedFilePath={initialPath || null} />
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border/15 bg-surface-elevated px-3 py-3">
          <button type="button" onClick={onCancel} className="min-h-10 rounded-lg bg-surface-2 px-4 text-[11px] font-medium text-foreground transition hover:bg-surface">{copy.cancel}</button>
          <button type="button" onClick={() => onConfirm(currentPath)} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-primary px-4 text-[11px] font-semibold text-primary-foreground transition hover:bg-primary/90"><Check size={13} />{copy.confirm}</button>
        </footer>
      </section>
    </>,
    document.body,
  );
}
