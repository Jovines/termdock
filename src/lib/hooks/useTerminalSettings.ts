import React from 'react';
import {
  normalizeTerminalSettings,
  TERMINAL_SETTINGS_STORAGE_KEY,
  type TerminalSettings,
} from '../terminal/settings';

function loadTerminalSettings(): TerminalSettings {
  if (typeof window === 'undefined') {
    return normalizeTerminalSettings(undefined);
  }

  try {
    const stored = window.localStorage.getItem(TERMINAL_SETTINGS_STORAGE_KEY);
    return normalizeTerminalSettings(stored ? JSON.parse(stored) : undefined);
  } catch {
    return normalizeTerminalSettings(undefined);
  }
}

function persistTerminalSettings(settings: TerminalSettings): void {
  if (typeof window === 'undefined') return;
  try {
    const stored = window.localStorage.getItem(TERMINAL_SETTINGS_STORAGE_KEY);
    const existingData = stored ? JSON.parse(stored) as Record<string, unknown> : {};
    const nextData = normalizeTerminalSettings({ ...existingData, ...settings });
    window.localStorage.setItem(TERMINAL_SETTINGS_STORAGE_KEY, JSON.stringify(nextData));
  } catch {
  }
}

export function useTerminalSettings(): {
  terminalSettings: TerminalSettings;
  updateTerminalSettings: (updates: Partial<TerminalSettings>) => void;
  resetTerminalSettings: () => void;
} {
  const [terminalSettings, setTerminalSettings] = React.useState(loadTerminalSettings);

  React.useEffect(() => {
    persistTerminalSettings(terminalSettings);
  }, [terminalSettings]);

  const updateTerminalSettings = React.useCallback((updates: Partial<TerminalSettings>) => {
    setTerminalSettings((current) => {
      const next = normalizeTerminalSettings({ ...current, ...updates });
      persistTerminalSettings(next);
      return next;
    });
  }, []);

  const resetTerminalSettings = React.useCallback(() => {
    const next = normalizeTerminalSettings(undefined);
    setTerminalSettings(next);
    persistTerminalSettings(next);
  }, []);

  return {
    terminalSettings,
    updateTerminalSettings,
    resetTerminalSettings,
  };
}
