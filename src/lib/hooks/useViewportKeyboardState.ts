import React from 'react';

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
  if (typeof window === 'undefined' || !window.visualViewport) {
    return 0;
  }

  return Math.max(
    0,
    Math.round(window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop)
  );
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
        return { isOpen: nextOpen, isSettled: nextSettled, keyboardHeight };
      });
    };

    const schedule = () => {
      if (rafId !== null) {
        return;
      }
      rafId = window.requestAnimationFrame(sync);
    };

    schedule();

    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);

    return () => {
      window.removeEventListener('resize', schedule);
      window.removeEventListener('orientationchange', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);

      if (rafId !== null) window.cancelAnimationFrame(rafId);
      if (settleTimerRef.current !== null) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
    };
  }, [enabled, openThresholdPx, closeThresholdPx, settleDelayMs]);

  return state;
}
