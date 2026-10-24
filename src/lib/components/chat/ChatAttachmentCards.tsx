import { FileText, Image, Video, X } from 'lucide-react';
import { chatAttachmentKind, type ChatAttachment } from './chatComposerContent';
export function ChatAttachmentCards({ files, onRemove, onReference, onPreview }: { files: ChatAttachment[]; onPreview?: (file: ChatAttachment) => void; onRemove?: (index: number) => void; onReference?: (file: ChatAttachment) => void }) {
  if (!files.length) return null;
  return <ul aria-label="消息附件" className="mb-2 grid max-h-[min(9rem,calc(var(--app-visible-vh,100dvh)*0.2))] grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2">{files.map((file, index) => {
    const kind = chatAttachmentKind(file), Icon = kind === '图片' ? Image : kind === '视频' ? Video : FileText;
    const size = file.size === undefined ? '' : file.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
    const body = <><Icon size={19} aria-hidden="true" className="shrink-0 text-primary" /><div className="min-w-0 flex-1"><p className="truncate text-sm" title={file.name}>{file.name}</p><p className="text-[11px] text-muted-foreground">{file.reference || kind}{size && ` · ${size}`}</p></div></>;
    return <li key={`${index}:${file.path}`} className="flex min-w-0 items-center gap-2.5 rounded-xl border border-border/60 bg-surface-2 px-3 py-1.5">
      {(kind === '图片' || kind === '视频') && onPreview ? <button type="button" aria-label={`预览${kind} ${file.name}`} title={`点击预览${kind}`} className="flex min-w-0 flex-1 items-center gap-2.5 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onPointerDown={event => event.preventDefault()} onClick={() => onPreview(file)}>{body}</button> : <div className="flex min-w-0 flex-1 items-center gap-2.5">{body}</div>}
      {onReference && file.reference && <button type="button" aria-label={`插入引用 ${file.reference}`} title="在光标处插入引用" className="min-h-11 shrink-0 rounded-lg px-2 text-xs text-primary hover:bg-surface-elevated" onPointerDown={event => event.preventDefault()} onClick={() => onReference(file)}>引用</button>}
      {onRemove && <button type="button" aria-label={`移除附件 ${file.name}`} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-elevated focus-visible:ring-2 focus-visible:ring-ring" onPointerDown={event => event.preventDefault()} onClick={() => onRemove(index)}><X size={14} /></button>}
    </li>;
  })}</ul>;
}
