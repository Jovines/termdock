import { create } from 'zustand';
import type { TerminalSession, TerminalChunk, TerminalSessionState } from '../terminal';

export interface TerminalStore {
  sessions: Map<string, TerminalSessionState>;
  nextChunkId: number;

  getTerminalSession: (sessionId: string) => TerminalSessionState | undefined;
  setTerminalSession: (sessionId: string, terminalSession: TerminalSession, directory: string) => void;
  setSessionHistory: (sessionId: string, history: string[]) => void;
  setConnecting: (sessionId: string, isConnecting: boolean) => void;
  appendToBuffer: (sessionId: string, chunk: string) => void;
  clearTerminalSession: (sessionId: string) => void;
  clearBuffer: (sessionId: string) => void;
  removeTerminalSession: (sessionId: string) => void;
  clearAllTerminalSessions: () => void;
}

const TERMINAL_BUFFER_LIMIT = 1_000_000;

function createEmptySessionState(sessionId: string, directory: string): TerminalSessionState {
  return {
    sessionId,
    directory,
    terminalSessionId: null,
    isConnecting: false,
    buffer: '',
    bufferChunks: [],
    bufferLength: 0,
    updatedAt: Date.now(),
  };
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  sessions: new Map(),
  nextChunkId: 1,

  getTerminalSession: (sessionId: string) => {
    return get().sessions.get(sessionId);
  },

  setTerminalSession: (sessionId: string, terminalSession: TerminalSession, directory: string) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(sessionId);
      const shouldResetBuffer =
        !existing ||
        existing.terminalSessionId !== terminalSession.sessionId;

      const baseState = shouldResetBuffer
        ? createEmptySessionState(sessionId, directory)
        : existing ?? createEmptySessionState(sessionId, directory);

      newSessions.set(sessionId, {
        ...baseState,
        terminalSessionId: terminalSession.sessionId,
        sessionId,
        directory,
        isConnecting: false,
        updatedAt: Date.now(),
      });

      return { sessions: newSessions };
    });
  },

  setSessionHistory: (sessionId: string, history: string[]) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(sessionId) ?? createEmptySessionState(sessionId, '');
      newSessions.set(sessionId, {
        ...existing,
        history,
        updatedAt: Date.now(),
      });
      return { sessions: newSessions };
    });
  },

  setConnecting: (sessionId: string, isConnecting: boolean) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(sessionId) ?? createEmptySessionState(sessionId, '');
      newSessions.set(sessionId, {
        ...existing,
        isConnecting,
        updatedAt: Date.now(),
      });
      return { sessions: newSessions };
    });
  },

  appendToBuffer: (sessionId: string, chunk: string) => {
    if (!chunk) {
      return;
    }

    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(sessionId) ?? createEmptySessionState(sessionId, '');

      const chunkId = state.nextChunkId;
      const chunkEntry: TerminalChunk = { id: chunkId, data: chunk };

      const bufferChunks = [...existing.bufferChunks, chunkEntry];
      let bufferLength = existing.bufferLength + chunk.length;

      while (bufferLength > TERMINAL_BUFFER_LIMIT && bufferChunks.length > 1) {
        const removed = bufferChunks.shift();
        if (!removed) {
          break;
        }
        bufferLength -= removed.data.length;
      }

      const buffer = bufferChunks.map((entry) => entry.data).join('');

      newSessions.set(sessionId, {
        ...existing,
        buffer,
        bufferChunks,
        bufferLength,
        updatedAt: Date.now(),
      });

      return { sessions: newSessions, nextChunkId: chunkId + 1 };
    });
  },

  clearTerminalSession: (sessionId: string) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(sessionId);
      if (existing) {
        newSessions.set(sessionId, {
          ...existing,
          terminalSessionId: null,
          isConnecting: false,
          updatedAt: Date.now(),
        });
      }
      return { sessions: newSessions };
    });
  },

  clearBuffer: (sessionId: string) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(sessionId);
      if (!existing) {
        return state;
      }
      newSessions.set(sessionId, {
        ...existing,
        buffer: '',
        bufferChunks: [],
        bufferLength: 0,
        updatedAt: Date.now(),
      });
      return { sessions: newSessions };
    });
  },

  removeTerminalSession: (sessionId: string) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      newSessions.delete(sessionId);
      return { sessions: newSessions };
    });
  },

  clearAllTerminalSessions: () => {
    set({ sessions: new Map(), nextChunkId: 1 });
  },
}));
