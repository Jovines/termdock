import React from 'react';

const SETTINGS_STORAGE_KEY = 'termdock-settings';

export type NewSessionMode = 'shell' | 'tmux';

interface UseNewSessionDefaultsReturn {
  newSessionMode: NewSessionMode;
  newSessionTmuxName: string;
  userSelectedNewSessionMode: NewSessionMode | null;
  setNewSessionMode: (mode: NewSessionMode, options?: { userInitiated?: boolean }) => void;
  setNewSessionTmuxName: (name: string) => void;
}

interface PersistedDefaults {
  newSessionMode?: unknown;
  newSessionModeUserSelected?: unknown;
  newSessionTmuxName?: unknown;
}

function isNewSessionMode(value: unknown): value is NewSessionMode {
  return value === 'shell' || value === 'tmux';
}

function loadDefaults(): { mode: NewSessionMode; tmuxName: string; userSelectedMode: NewSessionMode | null } {
  if (typeof window === 'undefined') {
    return { mode: 'shell', tmuxName: '', userSelectedMode: null };
  }

  try {
    const stored = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!stored) {
      return { mode: 'shell', tmuxName: '', userSelectedMode: null };
    }

    const data = JSON.parse(stored) as PersistedDefaults;
    const userSelectedMode = data.newSessionModeUserSelected === true && isNewSessionMode(data.newSessionMode)
      ? data.newSessionMode
      : null;
    const mode = userSelectedMode ?? 'shell';
    const tmuxName = typeof data.newSessionTmuxName === 'string' ? data.newSessionTmuxName : '';
    return { mode, tmuxName, userSelectedMode };
  } catch {
    return { mode: 'shell', tmuxName: '', userSelectedMode: null };
  }
}

function persistDefaults(updates: Partial<{ newSessionMode: NewSessionMode; newSessionModeUserSelected: boolean; newSessionTmuxName: string }>): void {
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

  const setNewSessionMode = React.useCallback((mode: NewSessionMode, options?: { userInitiated?: boolean }) => {
    const userInitiated = options?.userInitiated !== false;
    setState((prev) => ({
      ...prev,
      mode,
      userSelectedMode: userInitiated ? mode : prev.userSelectedMode,
    }));
    if (userInitiated) {
      persistDefaults({ newSessionMode: mode, newSessionModeUserSelected: true });
    }
  }, []);

  const setNewSessionTmuxName = React.useCallback((name: string) => {
    setState((prev) => ({ ...prev, tmuxName: name }));
    persistDefaults({ newSessionTmuxName: name });
  }, []);

  return {
    newSessionMode: state.mode,
    newSessionTmuxName: state.tmuxName,
    userSelectedNewSessionMode: state.userSelectedMode,
    setNewSessionMode,
    setNewSessionTmuxName,
  };
}
