import React from 'react';
import {
  DEFAULT_TERMINAL_RENDERER_MODE,
  DEFAULT_TERMINAL_ENGINE,
  isTerminalRendererMode,
  isTerminalEngine,
  type TerminalRendererMode,
  type TerminalEngine,
} from '../terminal/renderer';

const SETTINGS_STORAGE_KEY = 'termdock-settings';

interface UseTerminalRendererReturn {
  rendererMode: TerminalRendererMode;
  setRendererMode: (mode: TerminalRendererMode) => void;
  engine: TerminalEngine;
  setEngine: (engine: TerminalEngine) => void;
}

function loadSettings(): { rendererMode: TerminalRendererMode; engine: TerminalEngine } {
  if (typeof window === 'undefined') {
    return { rendererMode: DEFAULT_TERMINAL_RENDERER_MODE, engine: DEFAULT_TERMINAL_ENGINE };
  }

  try {
    const stored = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!stored) {
      return { rendererMode: DEFAULT_TERMINAL_RENDERER_MODE, engine: DEFAULT_TERMINAL_ENGINE };
    }

    const data = JSON.parse(stored) as {
      rendererMode?: unknown;
      renderer?: unknown;
      engine?: unknown;
      // Legacy: old setting stored 'ghostty' as a rendererMode value
    };

    // Migrate: if old rendererMode was 'ghostty', move it to engine
    let rendererMode = DEFAULT_TERMINAL_RENDERER_MODE;
    let engine = DEFAULT_TERMINAL_ENGINE;

    const rawRenderer = data.rendererMode ?? data.renderer;
    if (rawRenderer === 'ghostty') {
      engine = 'ghostty';
    } else if (isTerminalRendererMode(rawRenderer)) {
      rendererMode = rawRenderer;
    }

    const rawEngine = data.engine;
    if (isTerminalEngine(rawEngine)) {
      engine = rawEngine;
    }

    return { rendererMode, engine };
  } catch {
    return { rendererMode: DEFAULT_TERMINAL_RENDERER_MODE, engine: DEFAULT_TERMINAL_ENGINE };
  }
}

function persistSettings(updates: { rendererMode?: TerminalRendererMode; engine?: TerminalEngine }): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const stored = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    const existingData = stored ? JSON.parse(stored) as Record<string, unknown> : {};
    const nextData = { ...existingData, ...updates };
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(nextData));
  } catch {
  }
}

export function useTerminalRenderer(): UseTerminalRendererReturn {
  const [settings, setSettings] = React.useState(loadSettings);

  const setRendererMode = React.useCallback((mode: TerminalRendererMode) => {
    setSettings((prev) => {
      const next = { ...prev, rendererMode: mode };
      persistSettings({ rendererMode: mode });
      return next;
    });
  }, []);

  const setEngine = React.useCallback((engine: TerminalEngine) => {
    setSettings((prev) => {
      const next = { ...prev, engine };
      persistSettings({ engine });
      return next;
    });
  }, []);

  return {
    rendererMode: settings.rendererMode,
    setRendererMode,
    engine: settings.engine,
    setEngine,
  };
}
