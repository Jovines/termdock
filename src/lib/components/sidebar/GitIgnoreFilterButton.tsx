import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Filter, X } from 'lucide-react';
import { LoadingSpinner } from '../ui/Loading';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { useI18n } from '../../i18n';
import { GitIgnoreExceptionPicker } from './GitIgnoreExceptionPicker';

interface Props {
  rootPath: string | null;
  disabled: boolean;
  pressed: boolean;
  saving: boolean;
  onToggle: () => void;
}

export function GitIgnoreFilterButton({ rootPath, disabled, pressed, saving, onToggle }: Props) {
  const { t } = useI18n();
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [savingExceptions, setSavingExceptions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setExceptions = useSidebarStore((s) => s.setGitIgnoreExceptions);

  const cancelPress = () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    pointerRef.current = null;
  };
  const openConfiguration = () => {
    cancelPress();
    if (disabled || savingExceptions || !rootPath) return;
    setDraft([...(useSidebarStore.getState().gitIgnoreExceptions[rootPath] ?? [])]);
    setError(null);
    setOpen(true);
  };
  const close = () => {
    if (!savingExceptions) setOpen(false);
  };
  const startPress = (event: PointerEvent<HTMLButtonElement>) => {
    cancelPress();
    suppressClickRef.current = false;
    if (event.button !== 0 || !event.isPrimary || disabled) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerRef.current = { x: event.clientX, y: event.clientY };
    timerRef.current = setTimeout(() => {
      suppressClickRef.current = true;
      openConfiguration();
    }, 450);
  };

  useEffect(() => {
    setOpen(false);
    cancelPress();
    return cancelPress;
  }, [rootPath]);
  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    return () => buttonRef.current?.focus();
  }, [open]);

  const toggleLabel = pressed ? t('rightSidebar.showGitIgnoredFiles') : t('rightSidebar.hideGitIgnoredFiles');
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled || savingExceptions}
        aria-pressed={pressed}
        aria-label={toggleLabel}
        aria-description={t('rightSidebar.gitIgnoreConfigureHint')}
        title={`${toggleLabel} · ${t('rightSidebar.gitIgnoreConfigureHint')}`}
        onClick={(event) => {
          if (suppressClickRef.current && event.detail !== 0) {
            suppressClickRef.current = false;
            event.preventDefault();
            return;
          }
          onToggle();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          suppressClickRef.current = true;
          if (!open) openConfiguration();
        }}
        onPointerDown={startPress}
        onPointerMove={(event) => {
          const start = pointerRef.current;
          if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancelPress();
        }}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onLostPointerCapture={cancelPress}
        className={`inline-flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-md transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-35 [-webkit-touch-callout:none] ${pressed ? 'bg-surface-2 text-primary hover:bg-surface-elevated' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}
      >
        {saving ? <LoadingSpinner size={14} /> : <Filter size={14} />}
      </button>
      {open && createPortal(
        <div className="fixed inset-0 z-modal-backdrop flex items-center justify-center bg-[var(--app-backdrop)] p-3 backdrop-blur-sm" onClick={close}>
          <form
            ref={dialogRef}
            role="dialog"
            tabIndex={-1}
            aria-modal="true"
            aria-labelledby={`${id}-title`}
            aria-describedby={`${id}-hint`}
            className="relative z-modal-panel flex max-h-[80dvh] w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-xl border border-border/20 bg-surface p-4 text-foreground shadow-2xl"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close();
              }
              if (event.key === 'Tab') {
                const targets = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? []);
                if (!targets.length) { event.preventDefault(); dialogRef.current?.focus(); return; }
                const first = targets[0];
                const last = targets[targets.length - 1];
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                if (document.activeElement === dialogRef.current) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
              }
            }}
            onSubmit={(event) => {
              event.preventDefault();
              if (!rootPath || savingExceptions) return;
              if (draft.length > 200) { setError(t('rightSidebar.gitIgnoreExceptionsInvalid')); return; }
              setSavingExceptions(true);
              setError(null);
              void setExceptions(rootPath, draft)
                .then(() => setOpen(false))
                .catch(() => setError(t('rightSidebar.gitIgnoreExceptionsSaveFailed')))
                .finally(() => setSavingExceptions(false));
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <h2 id={`${id}-title`} className="text-sm font-medium">{t('rightSidebar.gitIgnoreExceptionsTitle')}</h2>
              <button type="button" disabled={savingExceptions} onClick={close} aria-label={t('common.close')} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground disabled:opacity-40"><X size={16} /></button>
            </div>
            <p className="truncate text-xs text-muted-foreground" title={rootPath ?? undefined}>{rootPath}</p>
            <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">{t('rightSidebar.gitIgnoreExceptionsHint')}</p>
            <p className="text-xs font-medium">{t('rightSidebar.gitIgnoreExceptionsPaths')}</p>
            {rootPath && <GitIgnoreExceptionPicker rootPath={rootPath} paths={draft} onChange={setDraft} disabled={savingExceptions} />}
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" disabled={savingExceptions} onClick={close} className="rounded-lg px-3 py-2 text-xs text-muted-foreground hover:bg-surface-2 disabled:opacity-40">{t('common.cancel')}</button>
              <button type="submit" disabled={savingExceptions} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50">
                {savingExceptions && <LoadingSpinner size={13} />}{t('common.save')}
              </button>
            </div>
          </form>
        </div>, document.body,
      )}
    </>
  );
}
