import { create } from 'zustand';
import type { TerminalSession, TerminalChunk, TerminalSessionState, AgentStatus, AgentIndicator } from '../terminal';

export interface TerminalStore {
  sessions: Map<string, TerminalSessionState>;
  nextChunkId: number;
  activeSessionId: string | null;

  getTerminalSession: (sessionId: string) => TerminalSessionState | undefined;
  setActiveSessionId: (id: string | null) => void;
  setTerminalSession: (sessionId: string, terminalSession: TerminalSession & { history?: string[] }) => void;
  setSessionHistory: (sessionId: string, history: string[]) => void;
  setSessionActiveProgram: (
    sessionId: string,
    activeProgram: string | null,
    activeProgramSource?: 'tmux-pane' | 'tmux-tty' | 'shell-tty' | 'shell-pid' | 'unknown' | null,
    activeProgramRaw?: string | null,
  ) => void;
  setSessionCwd: (sessionId: string, cwd: string | null) => void;
  setSessionCopyMode: (sessionId: string, inCopyMode: boolean) => void;
  setSessionAgentStatus: (sessionId: string, agentStatus: AgentStatus | null, agentColor?: string | null, agentIndicator?: AgentIndicator | null) => void;
  clearAgentNeedsReview: (sessionId: string) => void;
  setConnecting: (sessionId: string, isConnecting: boolean) => void;
  appendToBuffer: (sessionId: string, chunk: string) => void;
  replaceBuffer: (sessionId: string, chunks: string[]) => void;
  clearTerminalSession: (sessionId: string) => void;
  clearBuffer: (sessionId: string) => void;
  removeTerminalSession: (sessionId: string) => void;
  clearAllTerminalSessions: () => void;
}

const TERMINAL_BUFFER_LIMIT = 1_000_000;

function createEmptySessionState(sessionId: string): TerminalSessionState {
  return {
    sessionId,
    directory: '',
    terminalSessionId: null,
    mode: 'shell',
    tmuxSessionName: null,
    activeProgram: null,
    activeProgramRaw: null,
    activeProgramSource: null,
    cwd: null,
    inCopyMode: false,
    isConnecting: false,
    agentStatus: null,
    agentColor: null,
    agentIndicator: null,
    agentNeedsReview: false,
    buffer: '',
    bufferChunks: [],
    bufferLength: 0,
    updatedAt: Date.now(),
  };
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  sessions: new Map(),
  nextChunkId: 1,
  activeSessionId: null,

  getTerminalSession: (sessionId: string) => {
    return get().sessions.get(sessionId);
  },

  setActiveSessionId: (id: string | null) => {
    set({ activeSessionId: id });
    // When user switches to a session, clear its needs-review flag
    if (id) {
      const session = get().sessions.get(id);
      if (session?.agentNeedsReview) {
        const newSessions = new Map(get().sessions);
        newSessions.set(id, { ...session, agentNeedsReview: false, updatedAt: Date.now() });
        set({ sessions: newSessions });
      }
    }
  },

  setTerminalSession: (sessionId: string, terminalSession: TerminalSession & { history?: string[] }) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(sessionId);
      const shouldResetBuffer =
        !existing ||
        existing.terminalSessionId !== terminalSession.sessionId;

      const baseState = shouldResetBuffer
        ? createEmptySessionState(sessionId)
        : existing ?? createEmptySessionState(sessionId);

      // Preserve history if provided, otherwise keep existing history
      const history = terminalSession.history ?? existing?.history ?? [];

      newSessions.set(sessionId, {
        ...baseState,
        terminalSessionId: terminalSession.sessionId,
        mode: terminalSession.mode ?? baseState.mode,
        tmuxSessionName: terminalSession.tmuxSessionName ?? baseState.tmuxSessionName,
        activeProgram: terminalSession.activeProgram ?? baseState.activeProgram,
        activeProgramRaw: terminalSession.activeProgramRaw ?? baseState.activeProgramRaw,
        activeProgramSource: terminalSession.activeProgramSource ?? baseState.activeProgramSource,
        cwd: terminalSession.cwd ?? baseState.cwd,
        sessionId,
        isConnecting: false,
        history,
        updatedAt: Date.now(),
      });

      return { sessions: newSessions };
    });
  },

  setSessionHistory: (sessionId: string, history: string[]) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(sessionId) ?? createEmptySessionState(sessionId);
      newSessions.set(sessionId, {
        ...existing,
        history,
        updatedAt: Date.now(),
      });
      return { sessions: newSessions };
    });
  },

  setSessionActiveProgram: (sessionId: string, activeProgram: string | null, activeProgramSource = null, activeProgramRaw = null) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(sessionId) ?? createEmptySessionState(sessionId);
      newSessions.set(sessionId, {
        ...existing,
        activeProgram,
        activeProgramRaw,
        activeProgramSource,
        updatedAt: Date.now(),
      });
      return { sessions: newSessions };
    });
  },

  setSessionCwd: (sessionId: string, cwd: string | null) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(sessionId) ?? createEmptySessionState(sessionId);
      newSessions.set(sessionId, {
        ...existing,
        cwd,
        updatedAt: Date.now(),
      });
      return { sessions: newSessions };
    });
  },

  setSessionCopyMode: (sessionId: string, inCopyMode: boolean) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(sessionId);
      if (!existing || existing.inCopyMode === inCopyMode) return state;
      newSessions.set(sessionId, { ...existing, inCopyMode, updatedAt: Date.now() });
      return { sessions: newSessions };
    });
  },

  setSessionAgentStatus: (sessionId: string, agentStatus: AgentStatus | null, agentColor?: string | null, agentIndicator?: AgentIndicator | null) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(sessionId);
      if (!existing) return state;
      const nextAgentColor = agentStatus ? (agentColor ?? existing.agentColor) : null;
      const nextAgentIndicator = agentStatus ? (agentIndicator ?? existing.agentIndicator ?? null) : null;
      if (
        existing.agentStatus === agentStatus &&
        existing.agentColor === nextAgentColor &&
        existing.agentIndicator === nextAgentIndicator
      ) return state;

      // any status → null: AI stopped. If user is NOT on this session, mark needs-review.
      const wasActive = existing.agentStatus !== null;
      const nowStopped = agentStatus === null;
      const userNotViewing = state.activeSessionId !== sessionId;
      const agentNeedsReview = wasActive && nowStopped && userNotViewing;

      newSessions.set(sessionId, {
        ...existing,
        agentStatus,
        agentColor: nextAgentColor,
        agentIndicator: nextAgentIndicator,
        agentNeedsReview: agentNeedsReview || (existing.agentNeedsReview && !agentStatus),
        updatedAt: Date.now(),
      });
      return { sessions: newSessions };
    });
  },

  clearAgentNeedsReview: (sessionId: string) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(sessionId);
      if (!existing || !existing.agentNeedsReview) return state;
      newSessions.set(sessionId, { ...existing, agentNeedsReview: false, updatedAt: Date.now() });
      return { sessions: newSessions };
    });
  },

  setConnecting: (sessionId: string, isConnecting: boolean) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(sessionId) ?? createEmptySessionState(sessionId);
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
      const existing = newSessions.get(sessionId) ?? createEmptySessionState(sessionId);

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

  replaceBuffer: (sessionId: string, chunks: string[]) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(sessionId);
      if (!existing) {
        return state;
      }

      if (!chunks || chunks.length === 0) {
        newSessions.set(sessionId, {
          ...existing,
          buffer: '',
          bufferChunks: [],
          bufferLength: 0,
          updatedAt: Date.now(),
        });
        return { sessions: newSessions };
      }

      let nextChunkId = state.nextChunkId;
      const bufferChunks: TerminalChunk[] = [];
      let bufferLength = 0;

      for (const chunk of chunks) {
        if (!chunk) continue;
        const chunkEntry: TerminalChunk = { id: nextChunkId, data: chunk };
        nextChunkId += 1;
        bufferChunks.push(chunkEntry);
        bufferLength += chunk.length;
      }

      while (bufferLength > TERMINAL_BUFFER_LIMIT && bufferChunks.length > 1) {
        const removed = bufferChunks.shift();
        if (!removed) break;
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

      return { sessions: newSessions, nextChunkId };
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
          activeProgram: null,
          activeProgramRaw: null,
          activeProgramSource: null,
          isConnecting: false,
          agentStatus: null,
          agentColor: null,
          agentIndicator: null,
          agentNeedsReview: false,
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
