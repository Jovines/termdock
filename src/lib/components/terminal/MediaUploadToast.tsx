import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, X } from 'lucide-react';
import { useI18n } from '../../i18n';

export type MediaUploadResult = {
  file: File;
  kind: 'image' | 'video';
  originalSize: number;
  uploadedSize: number;
  originalRetained: boolean;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${Number((bytes / 1024 ** unit).toFixed(1))} ${units[unit]}`;
}

function MediaUploadPreview({ result, message, onClose }: {
  result: MediaUploadResult;
  message: string;
  onClose: () => void;
}) {
  const { locale } = useI18n();
  const chinese = locale === 'zh';
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // Preview the exact uploaded bytes locally, without another network request.
    const objectUrl = URL.createObjectURL(result.file);
    setUrl(objectUrl);
    setFailed(false);
    return () => URL.revokeObjectURL(objectUrl);
  }, [result.file]);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return <dialog ref={dialogRef} aria-label={chinese ? '上传结果预览' : 'Uploaded media preview'}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={event => event.stopPropagation()}
    onKeyUp={event => event.stopPropagation()}
    className="fixed inset-0 z-modal-panel m-0 h-[100dvh] max-h-none w-screen max-w-none bg-transparent p-3 text-foreground backdrop:bg-[var(--app-backdrop)] open:flex open:items-center open:justify-center">
    <section className="flex max-h-[calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-1.5rem)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border/15 bg-surface shadow-xl">
      <header className="flex shrink-0 items-start gap-3 border-b border-border/15 p-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{chinese ? '上传结果预览' : 'Uploaded media preview'}</h2>
          <p className="mt-1 break-words text-xs text-muted-foreground">{message}</p>
          <p className="mt-1 truncate text-[11px] text-muted-foreground">{result.file.name}</p>
        </div>
        <button type="button" autoFocus onClick={onClose} aria-label={chinese ? '关闭预览' : 'Close preview'}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
          <X size={18} />
        </button>
      </header>
      <div className="min-h-0 overflow-auto p-2">
        {failed ? <p role="alert" className="p-4 text-sm text-muted-foreground">{chinese ? '文件已上传，但当前浏览器无法预览此格式。' : 'File uploaded, but this browser cannot preview this format.'}</p>
          : url && (result.kind === 'image'
            ? <img src={url} alt={result.file.name} onError={() => setFailed(true)} className="mx-auto block max-h-[65dvh] max-w-full object-contain" />
            : <video src={url} controls playsInline preload="metadata" onError={() => setFailed(true)} className="mx-auto block max-h-[65dvh] w-full" />)}
      </div>
    </section>
  </dialog>;
}

export function MediaUploadToast({ result: pendingResult, onDismiss }: {
  result: MediaUploadResult | null;
  onDismiss: () => void;
}) {
  const { locale } = useI18n();
  const chinese = locale === 'zh';
  const [preview, setPreview] = useState<{ result: MediaUploadResult; message: string } | null>(null);
  useEffect(() => {
    if (!pendingResult) return;
    const timer = window.setTimeout(onDismiss, 2000);
    return () => window.clearTimeout(timer);
  }, [pendingResult, onDismiss]);

  const result = pendingResult ?? preview?.result;
  if (!result) return null;
  const saved = result.originalSize - result.uploadedSize;
  const percentage = result.originalSize > 0 ? Math.abs(saved) / result.originalSize * 100 : 0;
  const percentageText = percentage < 1 ? '<1%' : `${Math.floor(percentage)}%`;
  const media = result.kind === 'image' ? (chinese ? '图片' : 'Image') : (chinese ? '视频' : 'Video');
  const title = saved > 0
    ? (chinese ? '已压缩上传' : 'Compressed upload')
    : (chinese ? '已处理上传' : 'Processed upload');
  const savingsLabel = saved > 0
    ? (chinese ? `省 ${percentageText}` : `${percentageText} saved`)
    : saved < 0
      ? `+${percentageText}`
      : (chinese ? '体积未变' : 'Size unchanged');
  const message = result.originalRetained
    ? (chinese ? `已尝试压缩 · 保留原图 ${formatSize(result.uploadedSize)}，已上传` : `Compression tried · original ${formatSize(result.uploadedSize)} uploaded`)
    : `${title} · ${formatSize(result.originalSize)} → ${formatSize(result.uploadedSize)} · ${savingsLabel}`;

  // Anchor the toast to the terminal content box, which already shrinks and
  // moves with the soft keyboard. Only the preview escapes into a global layer.
  return (
    <>
    {pendingResult && <div role="status" aria-live="polite" aria-atomic="true"
      className="pointer-events-none absolute left-1/2 top-1/2 z-30 w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 -translate-y-1/2 motion-safe:animate-[fade-in_0.15s_ease-out]">
      <button type="button" aria-label={`${media}：${message} · ${chinese ? '点击预览' : 'Preview'}`}
        onClick={() => { setPreview({ result: pendingResult, message }); onDismiss(); }}
        className="pointer-events-auto flex max-w-full select-none items-center gap-1.5 rounded-full border border-border/15 bg-surface-elevated px-3 py-2 text-[11px] leading-4 text-foreground shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
      <Check size={13} strokeWidth={2.5} className="shrink-0 text-primary" aria-hidden="true" />
      <span className="truncate tabular-nums">{message}</span>
      <span className="shrink-0 text-muted-foreground">{chinese ? '预览 ›' : 'Preview ›'}</span>
      </button>
    </div>}
    {preview && createPortal(<MediaUploadPreview result={preview.result} message={preview.message} onClose={() => setPreview(null)} />, document.body)}
    </>
  );
}
