import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useI18n } from '../../i18n';
import { uploadFiles } from '../../terminal/api';
import { formatReviewReference, type ReferenceEvidence } from './reviewReference';

export interface PendingReviewReference extends ReferenceEvidence {
  text: string;
  key: string;
  capturedAt: string;
}

export function ReviewReferenceDialog({ reference, draftEnabled, onInsert, onCancel, initialNote = '', onNoteChange, targetChanged = false }: {
  reference: PendingReviewReference;
  draftEnabled: boolean;
  onInsert: (text: string, key: string) => void;
  onCancel: () => void;
  initialNote?: string;
  onNoteChange?: (note: string) => void;
  targetChanged?: boolean;
}) {
  const { t } = useI18n();
  const [note, setNote] = useState(initialNote);
  const [snapshot, setSnapshot] = useState<Blob | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(Boolean(reference.snapshot));
  const [includeImage, setIncludeImage] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [portalTarget, setPortalTarget] = useState<Element>(() => document.fullscreenElement ?? document.body);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const uploadedPathRef = useRef<string>();
  const busyRef = useRef(false);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    const update = () => setPortalTarget(document.fullscreenElement ?? document.body);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus(); // Do not summon the mobile keyboard on entry.
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!busyRef.current) cancelRef.current();
      }
      if (event.key !== 'Tab') return;
      const elements = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea, input, summary') ?? []);
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      controllerRef.current?.abort();
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', keydown, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let url: string | undefined;
    let timeout: ReturnType<typeof setTimeout>;
    // Captures are initiated by the viewer synchronously before clearing picks.
    void Promise.race([reference.snapshot ?? Promise.resolve(null), new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), 5000); })]).catch(() => null).then((blob) => {
      clearTimeout(timeout);
      if (cancelled) return;
      setSnapshot(blob); setCapturing(false);
      if (blob) { url = URL.createObjectURL(blob); setImageUrl(url); }
    });
    return () => { cancelled = true; clearTimeout(timeout); if (url) URL.revokeObjectURL(url); };
  }, [reference]);

  const insert = async () => {
    if (busyRef.current || capturing || targetChanged) return;
    busyRef.current = true; setBusy(true); setError('');
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      if (includeImage && snapshot && !uploadedPathRef.current) {
        const file = new File([snapshot], `termdock-review-${crypto.randomUUID()}.png`, { type: 'image/png' });
        const result = await uploadFiles('/tmp', [file], controller.signal);
        if (controller.signal.aborted) return;
        if (!result.files[0]?.path) throw new Error(t('rightSidebar.reviewUploadFailed'));
        uploadedPathRef.current = result.files[0].path;
      }
      if (controller.signal.aborted) return;
      onInsert(formatReviewReference(reference.text, note, reference.capturedAt, includeImage ? uploadedPathRef.current : undefined), reference.key);
    } catch {
      if (!controller.signal.aborted) setError(t('rightSidebar.reviewUploadFailed'));
    } finally {
      busyRef.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  return createPortal(<>
    <div className="fixed inset-0 z-modal-backdrop bg-[var(--app-backdrop)] backdrop-blur-sm" onClick={() => { if (!busy) onCancel(); }} />
    <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="review-reference-title" data-sidebar-gesture-ignore onKeyDown={(event) => event.stopPropagation()}
      className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-modal-panel flex max-h-[calc(100dvh-1.5rem)] flex-col overflow-hidden rounded-2xl border border-border/15 bg-surface text-foreground shadow-xl sm:bottom-auto sm:left-1/2 sm:right-auto sm:top-1/2 sm:w-[min(32rem,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2">
      <header className="flex shrink-0 items-center gap-2 border-b border-border/15 px-4 py-2">
        <div className="min-w-0 flex-1"><h2 id="review-reference-title" className="text-sm font-semibold">{t('rightSidebar.reviewReference')}</h2><p className="text-xs text-muted-foreground">{t('rightSidebar.reviewReferenceHint')}</p></div>
        <button ref={closeRef} type="button" disabled={busy} onClick={onCancel} aria-label={t('common.close')} className="flex h-11 w-11 items-center justify-center rounded-lg hover:bg-surface-2 disabled:opacity-40"><X size={18} /></button>
      </header>
      <div className="min-h-0 overflow-y-auto overscroll-contain p-4">
        {imageUrl && <img src={imageUrl} alt={t('rightSidebar.reviewSnapshot')} className="mb-2 max-h-44 w-full rounded-lg bg-surface-2 object-contain" />}
        {reference.snapshot && <label className="mb-3 flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked={includeImage} disabled={!snapshot || busy} onChange={(event) => setIncludeImage(event.target.checked)} />{capturing ? t('rightSidebar.reviewCapturing') : snapshot ? t('rightSidebar.reviewIncludeImage') : t('rightSidebar.reviewCaptureFailed')}</label>}
        <label className="block text-xs font-medium">{t('rightSidebar.reviewNote')}<textarea value={note} disabled={busy} onChange={(event) => { setNote(event.target.value); onNoteChange?.(event.target.value); }} maxLength={4000} rows={3} placeholder={t('rightSidebar.reviewNotePlaceholder')} className="mt-2 block w-full resize-y rounded-lg border border-border/30 bg-surface-2 p-3 text-base outline-primary" /></label>
        <details className="mt-3 text-xs"><summary className="min-h-8 cursor-pointer text-muted-foreground">{t('rightSidebar.reviewDetails')}</summary><pre className="whitespace-pre-wrap break-words py-2 font-mono text-xs">{reference.text}</pre></details>
        {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
        {targetChanged && <p role="alert" className="mt-2 text-xs text-destructive">{t('rightSidebar.reviewTargetChanged')}</p>}
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border/15 p-3">
        <button type="button" disabled={busy} onClick={onCancel} className="min-h-11 rounded-lg px-4 text-sm hover:bg-surface-2 disabled:opacity-40">{t('common.cancel')}</button>
        <button type="button" disabled={busy || capturing || targetChanged} onClick={() => void insert()} className="min-h-11 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-40">{busy ? t('rightSidebar.reviewUploading') : draftEnabled ? t('rightSidebar.reviewAddToDraft') : t('rightSidebar.reviewInsert')}</button>
      </footer>
    </section>
  </>, portalTarget);
}
