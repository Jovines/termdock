import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type { TerminalSession } from '../terminal';

export interface TerminalSessionInfo {
  id: string;
  cwd: string;
  sessionId: string | null;
  name: string;
  createdAt: number;
  lastActivity: number;
}

interface MultiSessionStore {
  sessions: Map<string, TerminalSessionInfo>;
  activeSessionId: string | null;
  nextSessionNumber: number;

  createSession: (cwd: string) => string;
  closeSession: (sessionId: string) => void;
  switchSession: (sessionId: string) => void;
  updateSession: (sessionId: string, updates: Partial<TerminalSessionInfo>) => void;
  setTerminalSession: (sessionId: string, terminalSession: TerminalSession) => void;
  getActiveSession: () => TerminalSessionInfo | undefined;
  getSessionCount: () => number;
  clearAllSessions: () => void;
}

function generateSessionName(sessions: Map<string, TerminalSessionInfo>): string {
  let counter = 1;
  let name = 'terminal';
  while (true) {
    let found = false;
    for (const session of sessions.values()) {
      if (session.name === name) {
        found = true;
        break;
      }
    }
    if (!found) break;
    name = `terminal-${counter}`;
    counter++;
  }
  return name;
}

export const useMultiSessionStore = create<MultiSessionStore>((set, get) => ({
  sessions: new Map(),
  activeSessionId: null,
  nextSessionNumber: 1,

  createSession: (cwd: string) => {
    const sessionId = uuidv4();
    const timestamp = Date.now();

    const sessions = get().sessions;
    const sessionName = generateSessionName(sessions);

    const sessionInfo: TerminalSessionInfo = {
      id: sessionId,
      cwd,
      sessionId: null,
      name: sessionName,
      createdAt: timestamp,
      lastActivity: timestamp,
    };

    set((state) => {
      const newSessions = new Map(state.sessions);
      newSessions.set(sessionId, sessionInfo);

      return {
        sessions: newSessions,
        activeSessionId: state.activeSessionId ?? sessionId,
        nextSessionNumber: state.nextSessionNumber + 1,
      };
    });

    return sessionId;
  },

  closeSession: (sessionId: string) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const wasActive = state.activeSessionId === sessionId;

      newSessions.delete(sessionId);

      let newActiveId = state.activeSessionId;

      if (wasActive) {
        const remainingIds = Array.from(newSessions.keys());
        newActiveId = remainingIds.length > 0 ? remainingIds[0] : null;
      }

      return {
        sessions: newSessions,
        activeSessionId: newActiveId,
      };
    });
  },

  switchSession: (sessionId: string) => {
    set((state) => {
      if (!state.sessions.has(sessionId)) {
        return state;
      }

      return {
        activeSessionId: sessionId,
      };
    });
  },

  updateSession: (sessionId: string, updates: Partial<TerminalSessionInfo>) => {
    set((state) => {
      const existing = state.sessions.get(sessionId);
      if (!existing) {
        return state;
      }

      const newSessions = new Map(state.sessions);
      newSessions.set(sessionId, {
        ...existing,
        ...updates,
        lastActivity: Date.now(),
      });

      return { sessions: newSessions };
    });
  },

  setTerminalSession: (sessionId: string, terminalSession: TerminalSession) => {
    get().updateSession(sessionId, {
      sessionId: terminalSession.sessionId,
    });
  },

  getActiveSession: () => {
    const state = get();
    if (!state.activeSessionId) {
      return undefined;
    }
    return state.sessions.get(state.activeSessionId);
  },

  getSessionCount: () => {
    return get().sessions.size;
  },

  clearAllSessions: () => {
    set({ sessions: new Map(), activeSessionId: null, nextSessionNumber: 1 });
  },
}));
