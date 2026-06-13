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

function loadSettings(): TerminalRendererMode {
  if (typeof window === 'undefined') {
    return DEFAULT_TERMINAL_RENDERER_MODE;
  }

  try {
    const stored = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!stored) {
      return DEFAULT_TERMINAL_RENDERER_MODE;
    }

    const data = JSON.parse(stored) as {
      rendererMode?: unknown;
      renderer?: unknown;
    };

    const rawRenderer = data.rendererMode ?? data.renderer;
    if (isTerminalRendererMode(rawRenderer)) {
      return rawRenderer;
    }
  } catch {
  }

  return DEFAULT_TERMINAL_RENDERER_MODE;
}

function persistSettings(updates: { rendererMode?: TerminalRendererMode }): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const stored = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    const existingData = stored ? JSON.parse(stored) as Record<string, unknown> : {};
    const nextData: Record<string, unknown> = { ...existingData, ...updates };
    delete nextData.engine;
    delete nextData.renderer;
    if (!isTerminalRendererMode(nextData.rendererMode)) {
      nextData.rendererMode = DEFAULT_TERMINAL_RENDERER_MODE;
    }
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(nextData));
  } catch {
  }
}

export function useTerminalRenderer(): UseTerminalRendererReturn {
  const [rendererMode, setRendererModeState] = React.useState(loadSettings);

  React.useEffect(() => {
    persistSettings({ rendererMode });
  }, [rendererMode]);

  const setRendererMode = React.useCallback((mode: TerminalRendererMode) => {
    setRendererModeState(mode);
    persistSettings({ rendererMode: mode });
  }, []);

  return {
    rendererMode,
    setRendererMode,
  };
}
