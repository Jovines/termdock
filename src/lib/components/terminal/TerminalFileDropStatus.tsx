import { useEffect, useState, type RefObject } from 'react';
import { Check, LoaderCircle, Upload, X } from 'lucide-react';

type DropStatus = { phase: string; progress?: string; cancellable: boolean };
export function TerminalFileDropStatus({ target }: { target: RefObject<HTMLElement | null> }) {
  const [state, setState] = useState<DropStatus | null>(null);
  useEffect(() => {
    const element = target.current;
    if (!element) return;
    element.dataset.nativeFileFeedback = 'true';
    const read = () => {
      const phase = element.dataset.nativeFileDropState;
      const progress = element.dataset.nativeFileDropProgress;
      const cancellable = element.dataset.nativeFileDropCancellable === 'true';
      setState(previous => !phase ? null : previous?.phase === phase && previous.progress === progress && previous.cancellable === cancellable ? previous : { phase, progress, cancellable });
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(element, { attributes: true, attributeFilter: ['data-native-file-drop-state', 'data-native-file-drop-progress', 'data-native-file-drop-cancellable'] });
    return () => { observer.disconnect(); delete element.dataset.nativeFileFeedback; };
  }, [target]);
  if (!state) return null;
  const busy = state.phase === 'preparing' || state.phase === 'uploading';
  const success = state.phase === 'uploaded' || state.phase === 'inserted';
  const value = state.progress === undefined ? undefined : Number(state.progress);
  const progress = value !== undefined && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : undefined;
  const text = state.phase === 'local' ? '松开以插入原文件路径' : state.phase === 'remote' ? '松开以上传到当前服务并插入路径'
    : state.phase === 'preparing' ? '正在读取文件…' : state.phase === 'uploading' ? `正在上传到当前服务${progress === undefined ? '…' : ` · ${progress}%`}`
    : state.phase === 'uploaded' ? '上传完成，已插入远端路径' : state.phase === 'inserted' ? '已插入原文件路径'
    : state.phase === 'cancelled' ? '已取消' : '文件处理失败，请重新拖入';
  return <div className="absolute bottom-3 left-3 right-3 z-30 flex justify-center pointer-events-none" data-terminal-file-drop-feedback>
    <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-foreground shadow-lg"
      onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => event.stopPropagation()}>
      {busy ? <LoaderCircle size={15} className="shrink-0 animate-spin text-primary" /> : success ? <Check size={15} className="shrink-0 text-primary" /> : <Upload size={15} className="shrink-0 text-muted-foreground" />}
      <span role="status" aria-live="polite" className="min-w-0 break-words">{text}</span>
      {state.phase === 'uploading' && <span role="progressbar" aria-label="文件上传进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} className="sr-only" />}
      {busy && state.cancellable && <button type="button" aria-label="取消文件处理" className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded px-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground"
        onClick={() => target.current?.dispatchEvent(new CustomEvent('termdock:file-drop-cancel', { bubbles: true }))}><X size={13} />取消</button>}
    </div>
  </div>;
}
