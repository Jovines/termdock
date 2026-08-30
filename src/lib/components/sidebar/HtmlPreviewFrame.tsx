import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2 as RiFullscreen, Minimize2 as RiFullscreenExit } from 'lucide-react';

interface HtmlPreviewFrameProps {
  src: string;
  title: string;
  enterFullscreenLabel: string;
  exitFullscreenLabel: string;
}

export function HtmlPreviewFrame({
  src,
  title,
  enterFullscreenLabel,
  exitFullscreenLabel,
}: HtmlPreviewFrameProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [pseudoFullscreen, setPseudoFullscreen] = useState(false);
  const expanded = nativeFullscreen || pseudoFullscreen;

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

  const preview = (
    <div
      ref={rootRef}
      data-html-preview-frame
      className={expanded
        ? 'fixed inset-0 z-modal-panel min-h-0 overflow-hidden bg-surface pt-[env(safe-area-inset-top,0px)]'
        : 'relative h-full min-h-0 overflow-hidden bg-surface'}
    >
      <iframe
        src={src}
        title={title}
        sandbox="allow-scripts"
        className="block h-full w-full border-0 bg-white"
      />
      <button
        type="button"
        onClick={() => void toggleFullscreen()}
        aria-label={expanded ? exitFullscreenLabel : enterFullscreenLabel}
        title={expanded ? `${exitFullscreenLabel} (Esc)` : enterFullscreenLabel}
        className="absolute right-[max(0.5rem,env(safe-area-inset-right,0px))] top-[max(0.5rem,env(safe-area-inset-top,0px))] z-20 inline-flex h-9 w-9 items-center justify-center rounded-full border border-border/20 bg-surface/95 text-muted-foreground shadow-lg backdrop-blur transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
      >
        {expanded ? <RiFullscreenExit size={15} /> : <RiFullscreen size={15} />}
      </button>
    </div>
  );

  return pseudoFullscreen ? createPortal(preview, document.body) : preview;
}
