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
// 单个 chunk 上限：超过这个字节数会在 store 端按 \n 切分成多块。
// 256KB 是经验值：远大于 OSC 序列长度（最长几百字节 base64）所以不会
// 切到 OSC/ST 序列中间；又小于 view 端 500KB high watermark,view
// 端可以稳定分批 enqueueWrite,避免一次性吃 5MB 拖死主线程。
// 现象：cat huge.log / git clone 输出密集时,单 WS 帧可能带几 MB,
// 不切分会导致整页花屏（长时间不响应）。
const MAX_CHUNK_SIZE = 256 * 1024;

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

      let chunkId = state.nextChunkId;
      // 拆大 chunk：单个 WS 帧可能带几 MB（cat huge.log、git clone 输出）。
      // store 端 while trim 用的是 `chunks.length > 1` 保护至少留一块,
      // 这导致单 chunk > 1MB 时永远 trim 不到,view 端一次性 enqueueWrite
      // 几 MB 字符串,拖死主线程,密集输出时肉眼可见的"花屏"（长时间不响应）。
      // 拆成 ≤ 256KB 的块,按行（\n）切分,不会切到 OSC 序列中间
      // (OSC 序列最长几百字节,且自带 ST/BEL terminator,与行无关)。
      const bufferChunks: TerminalChunk[] = [...existing.bufferChunks];
      let bufferLength = existing.bufferLength;

      const pushSlice = (slice: string) => {
        if (!slice) return;
        bufferChunks.push({ id: chunkId++, data: slice });
        bufferLength += slice.length;
      };

      if (chunk.length <= MAX_CHUNK_SIZE) {
        pushSlice(chunk);
      } else {
        let offset = 0;
        while (offset < chunk.length) {
          let end = Math.min(offset + MAX_CHUNK_SIZE, chunk.length);
          // 找最近一个 \n,避免切到 SGR 序列或 UTF-8 多字节字符中间
          if (end < chunk.length) {
            const lastNewline = chunk.lastIndexOf('\n', end);
            if (lastNewline > offset) {
              end = lastNewline + 1;
            }
          }
          pushSlice(chunk.slice(offset, end));
          offset = end;
        }
      }

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
        // 拆大 chunk:同 appendToBuffer 注释
        if (chunk.length <= MAX_CHUNK_SIZE) {
          bufferChunks.push({ id: nextChunkId++, data: chunk });
          bufferLength += chunk.length;
        } else {
          let offset = 0;
          while (offset < chunk.length) {
            let end = Math.min(offset + MAX_CHUNK_SIZE, chunk.length);
            if (end < chunk.length) {
              const lastNewline = chunk.lastIndexOf('\n', end);
              if (lastNewline > offset) {
                end = lastNewline + 1;
              }
            }
            const slice = chunk.slice(offset, end);
            bufferChunks.push({ id: nextChunkId++, data: slice });
            bufferLength += slice.length;
            offset = end;
          }
        }
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
