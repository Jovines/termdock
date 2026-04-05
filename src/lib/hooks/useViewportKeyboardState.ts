import React from 'react';

interface UseViewportKeyboardStateOptions {
  enabled: boolean;
  openThresholdPx?: number;
  closeThresholdPx?: number;
}

interface ViewportKeyboardState {
  isOpen: boolean;
  keyboardHeight: number;
}

const DEFAULT_OPEN_THRESHOLD_PX = 120;
const DEFAULT_CLOSE_THRESHOLD_PX = 80;

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
  } = options;

  const isOpenRef = React.useRef(false);
  const [state, setState] = React.useState<ViewportKeyboardState>({
    isOpen: false,
    keyboardHeight: 0,
  });

  React.useEffect(() => {
    if (typeof window === 'undefined' || !enabled) {
      isOpenRef.current = false;
      setState((current) => {
        if (!current.isOpen && current.keyboardHeight === 0) {
          return current;
        }
        return { isOpen: false, keyboardHeight: 0 };
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

      setState((current) => {
        if (current.isOpen === nextOpen && current.keyboardHeight === keyboardHeight) {
          return current;
        }
        return {
          isOpen: nextOpen,
          keyboardHeight,
        };
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

      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [enabled, openThresholdPx, closeThresholdPx]);

  return state;
}
