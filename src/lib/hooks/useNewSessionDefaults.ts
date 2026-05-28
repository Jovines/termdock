import React from 'react';

const SETTINGS_STORAGE_KEY = 'termdock-settings';

export type NewSessionMode = 'shell' | 'tmux';

interface UseNewSessionDefaultsReturn {
  newSessionMode: NewSessionMode;
  newSessionTmuxName: string;
  setNewSessionMode: (mode: NewSessionMode) => void;
  setNewSessionTmuxName: (name: string) => void;
}

interface PersistedDefaults {
  newSessionMode?: unknown;
  newSessionTmuxName?: unknown;
}

function isNewSessionMode(value: unknown): value is NewSessionMode {
  return value === 'shell' || value === 'tmux';
}

function loadDefaults(): { mode: NewSessionMode; tmuxName: string } {
  if (typeof window === 'undefined') {
    return { mode: 'shell', tmuxName: '' };
  }

  try {
    const stored = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!stored) {
      return { mode: 'shell', tmuxName: '' };
    }

    const data = JSON.parse(stored) as PersistedDefaults;
    const mode = isNewSessionMode(data.newSessionMode) ? data.newSessionMode : 'shell';
    const tmuxName = typeof data.newSessionTmuxName === 'string' ? data.newSessionTmuxName : '';
    return { mode, tmuxName };
  } catch {
    return { mode: 'shell', tmuxName: '' };
  }
}

function persistDefaults(updates: Partial<{ newSessionMode: NewSessionMode; newSessionTmuxName: string }>): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const stored = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    const existingData = stored ? JSON.parse(stored) as Record<string, unknown> : {};
    const nextData = { ...existingData, ...updates };
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(nextData));
  } catch {
    // Ignore storage errors
  }
}

export function useNewSessionDefaults(): UseNewSessionDefaultsReturn {
  const [state, setState] = React.useState(loadDefaults);

  const setNewSessionMode = React.useCallback((mode: NewSessionMode) => {
    setState((prev) => ({ ...prev, mode }));
    persistDefaults({ newSessionMode: mode });
  }, []);

  const setNewSessionTmuxName = React.useCallback((name: string) => {
    setState((prev) => ({ ...prev, tmuxName: name }));
    persistDefaults({ newSessionTmuxName: name });
  }, []);

  return {
    newSessionMode: state.mode,
    newSessionTmuxName: state.tmuxName,
    setNewSessionMode,
    setNewSessionTmuxName,
  };
}
