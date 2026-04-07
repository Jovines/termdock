import React from 'react';
import {
  DEFAULT_TERMINAL_RENDERER_MODE,
  isTerminalRendererMode,
  type TerminalRendererMode,
} from '../terminal/renderer';

const SETTINGS_STORAGE_KEY = 'termdock-settings';

interface UseTerminalRendererReturn {
  rendererMode: TerminalRendererMode;
  setRendererMode: (mode: TerminalRendererMode) => void;
}

function loadRendererMode(): TerminalRendererMode {
  if (typeof window === 'undefined') {
    return DEFAULT_TERMINAL_RENDERER_MODE;
  }

  try {
    const stored = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!stored) {
      return DEFAULT_TERMINAL_RENDERER_MODE;
    }

    const data = JSON.parse(stored) as { rendererMode?: unknown; renderer?: unknown };
    const candidate = data.rendererMode ?? data.renderer;
    if (isTerminalRendererMode(candidate)) {
      return candidate;
    }
  } catch {
  }

  return DEFAULT_TERMINAL_RENDERER_MODE;
}

function persistRendererMode(mode: TerminalRendererMode): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const stored = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    const existingData = stored ? JSON.parse(stored) as Record<string, unknown> : {};
    const nextData = { ...existingData, rendererMode: mode };
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(nextData));
  } catch {
  }
}

export function useTerminalRenderer(): UseTerminalRendererReturn {
  const [rendererMode, setRendererModeState] = React.useState<TerminalRendererMode>(
    loadRendererMode
  );

  const setRendererMode = React.useCallback((mode: TerminalRendererMode) => {
    setRendererModeState(mode);
    persistRendererMode(mode);
  }, []);

  return {
    rendererMode,
    setRendererMode,
  };
}
