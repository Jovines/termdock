import React from 'react';
import { createDebugLogger } from '../utils/debug';

interface UseViewportKeyboardStateOptions {
  enabled: boolean;
  openThresholdPx?: number;
  closeThresholdPx?: number;
  settleDelayMs?: number;
}

interface ViewportKeyboardState {
  isOpen: boolean;
  isSettled: boolean;
  keyboardHeight: number;
}

const DEFAULT_OPEN_THRESHOLD_PX = 120;
const DEFAULT_CLOSE_THRESHOLD_PX = 80;
const DEFAULT_SETTLE_DELAY_MS = 400;

function getKeyboardHeightPx(): number {
  if (typeof window === 'undefined') {
    return 0;
  }

  const fromCssVar = Number.parseFloat(
    document.documentElement.style.getPropertyValue('--kb-height') || '0'
  );
  if (Number.isFinite(fromCssVar) && fromCssVar > 0) {
    return Math.round(fromCssVar);
  }

  const visualViewport = window.visualViewport;
  if (!visualViewport) return 0;

  const baseHeight = Number.parseFloat(
    document.documentElement.style.getPropertyValue('--app-base-vh') || '0'
  ) || window.innerHeight;
  const safeBottom = Number.parseFloat(
    document.documentElement.style.getPropertyValue('--safe-bottom-inset') || '0'
  ) || 0;
  const visibleBottom = visualViewport.height + visualViewport.offsetTop;
  return Math.max(0, Math.round(baseHeight - visibleBottom - safeBottom));
}

export function useViewportKeyboardState(
  options: UseViewportKeyboardStateOptions
): ViewportKeyboardState {
  const {
    enabled,
    openThresholdPx = DEFAULT_OPEN_THRESHOLD_PX,
    closeThresholdPx = DEFAULT_CLOSE_THRESHOLD_PX,
    settleDelayMs = DEFAULT_SETTLE_DELAY_MS,
  } = options;
  const debugKeyboard = React.useMemo(() => createDebugLogger('keyboard'), []);

  const isOpenRef = React.useRef(false);
  const settleTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastKeyboardHeightRef = React.useRef(0);
  const [state, setState] = React.useState<ViewportKeyboardState>({
    isOpen: false,
    isSettled: false,
    keyboardHeight: 0,
  });

  React.useEffect(() => {
    if (typeof window === 'undefined' || !enabled) {
      isOpenRef.current = false;
      if (settleTimerRef.current !== null) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      setState((current) => {
        if (!current.isOpen && !current.isSettled && current.keyboardHeight === 0) return current;
        return { isOpen: false, isSettled: false, keyboardHeight: 0 };
      });
      return;
    }

    let rafId: number | null = null;

    const sync = () => {
      rafId = null;

      const keyboardHeight = getKeyboardHeightPx();
      let nextOpen = isOpenRef.current;

      if (keyboardHeight >= openThresholdPx) {
        nextOpen = true;
      } else if (keyboardHeight <= closeThresholdPx) {
        nextOpen = false;
      }

      isOpenRef.current = nextOpen;

      if (nextOpen) {
        const heightDelta = Math.abs(keyboardHeight - lastKeyboardHeightRef.current);
        lastKeyboardHeightRef.current = keyboardHeight;
        if (heightDelta > 10) {
          if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
          settleTimerRef.current = setTimeout(() => {
            settleTimerRef.current = null;
            setState((c) => (c.isSettled ? c : { ...c, isSettled: true }));
          }, settleDelayMs);
        }
      } else {
        if (settleTimerRef.current !== null) {
          clearTimeout(settleTimerRef.current);
          settleTimerRef.current = null;
        }
      }

      setState((current) => {
        const nextSettled = nextOpen ? current.isSettled : false;
        if (current.isOpen === nextOpen && current.keyboardHeight === keyboardHeight && current.isSettled === nextSettled) {
          return current;
        }
        debugKeyboard('sync', {
          keyboardHeight,
          isOpen: nextOpen,
          isSettled: nextSettled,
          visualViewport: window.visualViewport
            ? {
                width: Math.round(window.visualViewport.width),
                height: Math.round(window.visualViewport.height),
                offsetTop: Math.round(window.visualViewport.offsetTop),
              }
            : null,
        });
        return { isOpen: nextOpen, isSettled: nextSettled, keyboardHeight };
      });
    };

    const schedule = (source = 'event') => {
      if (source.includes('visibilitychange') || source.includes('pageshow')) {
        debugKeyboard('schedule', { source });
      }
      if (rafId !== null) {
        return;
      }
      rafId = window.requestAnimationFrame(sync);
    };

    schedule('mount');

    const handleResize = () => schedule('resize');
    const handleOrientationChange = () => schedule('orientationchange');
    const handleVisualViewportResize = () => schedule('visualViewport.resize');
    const handleVisualViewportScroll = () => schedule('visualViewport.scroll');
    const handleViewportKeyboardChange = () => schedule('viewport-keyboard-change');

    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleOrientationChange);
    window.visualViewport?.addEventListener('resize', handleVisualViewportResize);
    window.visualViewport?.addEventListener('scroll', handleVisualViewportScroll);
    document.addEventListener('termdock:viewport-keyboard-change', handleViewportKeyboardChange);

    // 从后台返回 / BFCache 恢复时强制重读 visualViewport，避免 isOpen 卡在
    // "软键盘打开"状态。和 useViewportHeight 一样要多次 schedule 覆盖 iOS
    // 异步 settle。
    const handleResume = (source: string) => {
      debugKeyboard('resume', {
        source,
        keyboardHeight: getKeyboardHeightPx(),
        hidden: document.hidden,
      });
      schedule(`${source}:now`);
      window.setTimeout(() => schedule(`${source}:50ms`), 50);
      window.setTimeout(() => schedule(`${source}:200ms`), 200);
    };
    const handleVisibilityChange = () => {
      if (!document.hidden) handleResume('visibilitychange');
    };
    const handlePageShow = () => handleResume('pageshow');
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pageshow', handlePageShow);

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleOrientationChange);
      window.visualViewport?.removeEventListener('resize', handleVisualViewportResize);
      window.visualViewport?.removeEventListener('scroll', handleVisualViewportScroll);
      document.removeEventListener('termdock:viewport-keyboard-change', handleViewportKeyboardChange);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', handlePageShow);

      if (rafId !== null) window.cancelAnimationFrame(rafId);
      if (settleTimerRef.current !== null) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
    };
  }, [debugKeyboard, enabled, openThresholdPx, closeThresholdPx, settleDelayMs]);

  return state;
}
