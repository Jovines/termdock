import { getActiveClient } from '../../federation/browserIntegration';
import { prepareSecureHtmlPreview, type SecureHtmlPreview } from '../../federation/secureHtmlPreview';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Minimize2 as RiFullscreenExit } from 'lucide-react';

export interface HtmlPreviewFrameHandle {
  toggleFullscreen: () => Promise<void>;
}

interface HtmlPreviewFrameProps {
  src: string;
  title: string;
  exitFullscreenLabel: string;
  onFullscreenChange?: (fullscreen: boolean) => void;
}

export const HtmlPreviewFrame = forwardRef<HtmlPreviewFrameHandle, HtmlPreviewFrameProps>(function HtmlPreviewFrame({
  src,
  title,
  exitFullscreenLabel,
  onFullscreenChange,
}, ref) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [prepared, setPrepared] = useState<SecureHtmlPreview>();
  const [previewError, setPreviewError] = useState('');
  useEffect(() => {
    const abort = new AbortController(); let preview: SecureHtmlPreview | undefined;
    setPrepared(undefined); setPreviewError('');
    void (async () => {
      const client = await getActiveClient();
      preview = await prepareSecureHtmlPreview(src, { fetch: (path, init) => client.fetch(path, init), signal: abort.signal });
      if (abort.signal.aborted) { preview.dispose(); return; }
      setPrepared(preview); if (preview.errors.length) setPreviewError(preview.errors.join('；'));
    })().catch(error => { if (!abort.signal.aborted) setPreviewError(error instanceof Error ? error.message : '安全预览加载失败'); });
    return () => { abort.abort(); preview?.dispose(); };
  }, [src]);
  useEffect(() => {
    if (!prepared || !iframeRef.current) return;
    return prepared.attach(iframeRef.current, setPreviewError);
  }, [prepared]);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [pseudoFullscreen, setPseudoFullscreen] = useState(false);
  const expanded = nativeFullscreen || pseudoFullscreen;

  useEffect(() => {
    onFullscreenChange?.(expanded);
  }, [expanded, onFullscreenChange]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setNativeFullscreen(document.fullscreenElement === rootRef.current);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  useEffect(() => {
    if (!pseudoFullscreen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPseudoFullscreen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [pseudoFullscreen]);

  const toggleFullscreen = useCallback(async () => {
    const root = rootRef.current;
    if (!root) return;

    if (pseudoFullscreen) {
      setPseudoFullscreen(false);
      return;
    }
    if (document.fullscreenElement === root) {
      await document.exitFullscreen();
      return;
    }
    if (root.requestFullscreen && document.fullscreenEnabled !== false) {
      try {
        await root.requestFullscreen();
        return;
      } catch {
        // iOS/WebViews can expose the API but still reject element fullscreen.
      }
    }
    setPseudoFullscreen(true);
  }, [pseudoFullscreen]);

  useImperativeHandle(ref, () => ({ toggleFullscreen }), [toggleFullscreen]);

  const preview = (
    <div
      ref={rootRef}
      data-html-preview-frame
      className={expanded
        ? 'fixed inset-0 z-modal-panel flex min-h-0 flex-col overflow-hidden bg-surface pt-[env(safe-area-inset-top,0px)] text-foreground'
        : 'flex h-full min-h-0 flex-col overflow-hidden bg-surface'}
    >
      {expanded && (
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/15 bg-[var(--chrome-bg)] px-3">
          <span className="min-w-0 truncate text-[12px] font-semibold">{title}</span>
          <button
            type="button"
            onClick={() => void toggleFullscreen()}
            aria-label={exitFullscreenLabel}
            title={`${exitFullscreenLabel} (Esc)`}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
          >
            <RiFullscreenExit size={15} />
          </button>
        </div>
      )}
      {previewError && <div role="status" className="shrink-0 border-b border-border px-3 py-2 text-xs text-muted-foreground">{previewError}</div>}
      {!prepared && !previewError && <div role="status" className="p-3 text-xs text-muted-foreground">正在安全加载预览资源…</div>}
      <iframe
        ref={iframeRef}
        src={prepared?.shellUrl}
        referrerPolicy="no-referrer"
        title={title}
        sandbox="allow-scripts"
        className="block min-h-0 w-full flex-1 border-0 bg-white"
      />
    </div>
  );

  return pseudoFullscreen ? createPortal(preview, document.body) : preview;
});
