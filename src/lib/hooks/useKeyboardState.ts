import React from 'react';

type Modifier = 'ctrl' | 'cmd';

interface KeyboardState {
  isMobile: boolean;
  isIOS: boolean;
  keyboardHeight: number;
  activeModifier: Modifier | null;
}

interface KeyboardStateInternal extends KeyboardState {
  debounceTimer: NodeJS.Timeout | null;
  isKeyboardVisible: boolean;
}

interface KeyboardActions {
  setIsMobile: (value: boolean) => void;
  setActiveModifier: (value: Modifier | null) => void;
}

const KEYBOARD_MIN_HEIGHT = 100;
const KEYBOARD_DEBOUNCE_MS = 300;

export function useKeyboardState(): [React.MutableRefObject<KeyboardStateInternal>, KeyboardActions] {
  const keyboardStateRef = React.useRef<KeyboardStateInternal>({
    isMobile: false,
    isIOS: false,
    keyboardHeight: 0,
    activeModifier: null,
    debounceTimer: null,
    isKeyboardVisible: false,
  });

  const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);

  const isIOS = React.useMemo(() => {
    if (typeof window === 'undefined') return false;
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
           (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }, []);

  const checkIsMobile = React.useCallback(() => {
    if (typeof window === 'undefined') return false;
    const hasTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
    const isNarrow = window.innerWidth < 768;
    return hasTouch && isNarrow;
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    keyboardStateRef.current.isIOS = isIOS;

    const state = keyboardStateRef.current;

    const updateKeyboardState = (visible: boolean, height: number) => {
      if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
        state.debounceTimer = null;
      }

      if (visible) {
        state.isKeyboardVisible = true;
        keyboardStateRef.current.keyboardHeight = height;
        forceUpdate();
      } else {
        state.debounceTimer = setTimeout(() => {
          const viewport = window.visualViewport;
          if (viewport) {
            const currentWindowHeight = window.innerHeight;
            const currentKeyboardH = currentWindowHeight - viewport.height;
            if (currentKeyboardH < KEYBOARD_MIN_HEIGHT) {
              state.isKeyboardVisible = false;
              keyboardStateRef.current.keyboardHeight = 0;
              forceUpdate();
            }
          }
          state.debounceTimer = null;
        }, KEYBOARD_DEBOUNCE_MS);
      }
    };

    const handleVisualViewportChange = () => {
      if (!window.visualViewport) return;

      const viewport = window.visualViewport;
      const windowHeight = window.innerHeight;
      const keyboardH = windowHeight - viewport.height;

      if (keyboardH >= KEYBOARD_MIN_HEIGHT) {
        updateKeyboardState(true, keyboardH);
      } else if (keyboardH < KEYBOARD_MIN_HEIGHT && state.isKeyboardVisible) {
        updateKeyboardState(false, 0);
      }
    };

    handleVisualViewportChange();

    window.visualViewport?.addEventListener('resize', handleVisualViewportChange);
    window.visualViewport?.addEventListener('scroll', handleVisualViewportChange);

    return () => {
      window.visualViewport?.removeEventListener('resize', handleVisualViewportChange);
      window.visualViewport?.removeEventListener('scroll', handleVisualViewportChange);
      if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
      }
    };
  }, [isIOS]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    keyboardStateRef.current.isMobile = checkIsMobile();
    forceUpdate();

    const handleResize = () => {
      keyboardStateRef.current.isMobile = checkIsMobile();
      forceUpdate();
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [checkIsMobile]);

  const actions: KeyboardActions = {
    setIsMobile: (value: boolean) => {
      keyboardStateRef.current.isMobile = value;
      forceUpdate();
    },
    setActiveModifier: (value: Modifier | null) => {
      keyboardStateRef.current.activeModifier = value;
      forceUpdate();
    },
  };

  return [keyboardStateRef, actions];
}
