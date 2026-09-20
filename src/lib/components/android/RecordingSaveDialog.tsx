import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { useI18n } from '../../i18n';
import { saveAndroidRecording, discardAndroidRecording, type AndroidRecording } from '../../android/api';
import { DirectoryPickerDialog } from '../sidebar/DirectoryPickerDialog';

/** 录像始终留在服务端；这里只传保存位置和文件引用。 */
export function RecordingSaveDialog({ file, initialPath, onInsert, onDone }: {
  file: AndroidRecording;
  initialPath: string;
  onInsert: (path: string) => Promise<unknown> | void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  const discard = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setDiscarding(true);
    try { await discardAndroidRecording(file.id); onDone(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { inFlight.current = false; setBusy(false); setDiscarding(false); }
  };

  useEffect(() => {
    if (picking) return;
    dialogRef.current?.focus();
    const trapKeys = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === 'Escape') event.preventDefault();
      if (event.key !== 'Tab') return;
      const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      const first = buttons[0];
      const last = buttons.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    };
    document.addEventListener('keydown', trapKeys, true);
    return () => document.removeEventListener('keydown', trapKeys, true);
  }, [picking]);

  const run = async (directory?: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setSaving(directory !== undefined);
    setPicking(false);
    setError(null);
    try {
      const result = await saveAndroidRecording(file.id, directory);
      if (directory === undefined) await onInsert(result.path);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (picking) return <DirectoryPickerDialog open initialPath={initialPath || '/'}
    title={t('android.recordingSave')} onCancel={() => setPicking(false)}
    onConfirm={directory => { void run(directory); }} />;

  return createPortal(
    <div className="fixed inset-0 z-modal-panel flex items-center justify-center bg-[var(--app-backdrop)] p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="recording-save-title" tabIndex={-1}
        aria-busy={busy} className="w-full max-w-sm rounded-xl border border-border bg-surface p-4 text-foreground shadow-xl outline-none">
        <h2 id="recording-save-title" className="text-sm font-semibold">{t('android.recordingConfirm')}</h2>
        <p className="mt-2 text-xs text-muted-foreground">{t('android.recordingSaveHint')}</p>
        <p className="mt-2 break-all text-xs text-muted-foreground">{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</p>
        {(error || file.error) && <p role="alert" className="mt-3 break-words text-xs text-destructive">{error || file.error}</p>}
        {busy && <p role="status" className="mt-3 flex items-center gap-2 text-sm text-primary">
          <Loader2 size={16} className="animate-spin" />
          {discarding ? `${t('android.recordingDiscard')}…` : t(saving ? 'android.recordingSaving' : 'android.captureInserting')}
        </p>}
        <div className="mt-4 flex flex-col gap-2">
          <button type="button" disabled={busy || file.status !== 'ready'} onClick={() => { void run(); }} className="min-h-10 rounded-lg bg-primary px-3 text-sm text-primary-foreground disabled:opacity-40">{t('android.recordingInsert')}</button>
          <button type="button" disabled={busy || file.status !== 'ready'} onClick={() => setPicking(true)} className="min-h-10 rounded-lg bg-surface-2 px-3 text-sm disabled:opacity-40">{t('android.recordingSave')}</button>
          <button type="button" disabled={busy} onClick={() => void discard()} className="min-h-10 rounded-lg px-3 text-sm text-muted-foreground disabled:opacity-40">{t('android.recordingDiscard')}</button>
        </div>
      </div>
    </div>, document.body,
  );
}
