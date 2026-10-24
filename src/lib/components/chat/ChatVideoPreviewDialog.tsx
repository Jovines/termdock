import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { VideoPreviewPlayer } from '../sidebar/VideoPreviewPlayer';
import { buildVideoPreviewUrl } from '../../terminal/api';
import { useKeyboardLayer } from '../../hooks/useKeyboardLayer';
import type { ChatAttachment } from './chatComposerContent';

export function ChatVideoPreviewDialog({ file, close }: { file: ChatAttachment; close: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false), [ready, setReady] = useState(false), [attempt, setAttempt] = useState(0);
  useKeyboardLayer(panel, true, close);
  return createPortal(<div data-sidebar-gesture-ignore className="fixed inset-0 z-modal-backdrop flex items-center justify-center bg-[var(--app-backdrop)] preview-safe-area [--preview-safe-area-gap:0.5rem] sm:[--preview-safe-area-gap:1.5rem]" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={panel} role="dialog" aria-modal="true" aria-label="视频预览" tabIndex={-1} className="z-modal-panel flex h-full max-h-[90dvh] min-h-0 w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-border bg-[var(--chrome-bg)] text-foreground">
      <header className="flex min-h-12 shrink-0 items-center gap-3 border-b border-border/50 px-3"><span className="min-w-0 flex-1 truncate text-sm" title={file.name}>{file.name}</span><button type="button" aria-label="关闭视频预览" className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-2" onClick={close}><X size={17} /></button></header>
      <div className="relative min-h-0 flex-1" onLoadedDataCapture={() => setReady(true)}>
        {failed ? <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-sm text-muted-foreground"><p>视频加载失败，请检查文件是否仍然可用。</p><button type="button" className="min-h-11 rounded-lg bg-surface-2 px-4 text-foreground hover:bg-surface-elevated" onClick={() => { setReady(false); setFailed(false); setAttempt(value => value + 1); }}>重试加载视频</button></div>
          : <><VideoPreviewPlayer key={attempt} url={buildVideoPreviewUrl(file.path)} onLoadError={() => setFailed(true)} />{!ready && <div role="status" className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">正在加载视频…</div>}</>}
      </div>
    </div>
  </div>, document.body);
}
