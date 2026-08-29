import { create } from 'zustand';
import type { AgentStatusPayload } from '../terminal/api';
import { sendAgentReviewAck } from '../terminal/api';
import type { TerminalSession, TerminalChunk, TerminalSessionState, TuiProgressReport } from '../terminal';
import {
  drainTerminalOutputFrame,
  splitTerminalOutputChunk,
} from '../terminal/outputBacklog';
import { getStoredPwaAiNotificationsEnabled, showPwaNotification } from '../utils/pwaNotifications';

function getStoredLocale(): string {
  try { return localStorage.getItem('termdock:locale') || 'en'; } catch { return 'en'; }
}

function getAgentNotificationText(locale: string, agentName: string) {
  if (locale === 'zh') {
    return {
      waitingTitle: `${agentName} 需要你的处理`,
      waitingBody: `${agentName} 需要你的处理。`,
      doneTitle: `${agentName} 已完成`,
      doneBody: `${agentName} 已完成，点按查看结果。`,
      exitedTitle: `${agentName} 已退出`,
      exitedBody: `${agentName} 已退出，点按查看结果。`,
    };
  }
  return {
    waitingTitle: `${agentName} needs your input`,
    waitingBody: `${agentName} is waiting for your input.`,
    doneTitle: `${agentName} finished`,
    doneBody: 'Tap to see the result.',
    exitedTitle: `${agentName} exited`,
    exitedBody: 'Tap to see the result.',
  };
}

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
  setSessionShellTitle: (sessionId: string, title: string | null) => void;
  setSessionPromptState: (sessionId: string, state: 'idle' | 'running', exitCode?: number | null) => void;
  setSessionTuiProgress: (sessionId: string, report: TuiProgressReport | null) => void;
  setSessionGitStatus: (sessionId: string, gitStatus: import('../terminal/types').GitStatusReport | null) => void;
  setSessionCopyMode: (sessionId: string, inCopyMode: boolean) => void;
  setSessionAgentStatus: (sessionId: string, payload: AgentStatusPayload) => void;
  setAgentResumeRecovered: (sessionId: string, recovered: boolean) => void;
  clearAgentNeedsReview: (sessionId: string) => void;
  setConnecting: (sessionId: string, isConnecting: boolean) => void;
  appendToBuffer: (sessionId: string, chunk: string, options?: { markActivity?: boolean }) => void;
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

// WS 'data' 事件 rAF 批处理：密集输出(ls -R / git clone)时,一帧内
// 可能来几十个 WS 帧,每个都直接 setState 会触发 zustand subscribers
// + 所有 useEffect 跑。改成在 create 闭包内维护 per-session 队列 + rAF
// flush,一帧合并成一次 setState,节省 30~50% CPU(实测 / cat huge.log)。
// 每帧仍有硬预算：后台 renderer 被系统暂停时队列可能积压数十秒，恢复后
// 必须逐帧追赶并让出交互事件，不能在第一个 rAF 中一次性处理完整 backlog。
//
// 注意:不放在 store state 里 —— 如果放 state 里,每次 push 都会触发
// setState,等于没优化。挂在 create 闭包里(set 函数可访问)。
interface BatchState {
  pendingChunksBySession: Map<string, string[]>;
  activitySessionIds: Set<string>;
  batchFlushRafRef: number | null;
}

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
    agentIndicator: null,
    agentStatusDetail: null,
    agent: null,
    agentMessage: null,
    agentNativeSessionId: null,
    agentResumeRecovered: false,
    agentRich: false,
    agentActivity: 0,
    agentCwd: null,
    agentNeedsReview: false,
    shellTitle: null,
    promptState: null,
    shellExitCode: null,
    tuiProgress: null,
    gitStatus: null,
    bufferChunks: [],
    bufferLength: 0,
    lastOutputAt: null,
    updatedAt: Date.now(),
  };
}

// Shell-title localStorage cache: persists the last-known OSC 2 title per session
// so that on page refresh the sidebar shows the real title immediately instead of
// the default session name, before the WebSocket reconnects and delivers the live title.
const SHELL_TITLE_CACHE_KEY = 'termdock-shell-titles-v1';

function readCachedShellTitles(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(SHELL_TITLE_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch { return {}; }
}

/** Public API for sidebar fallback: reads the cached shell title synchronously. */
export function getCachedShellTitle(sessionId: string): string | null {
  return readCachedShellTitles()[sessionId] ?? null;
}

function writeCachedShellTitle(sessionId: string, title: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    const titles = readCachedShellTitles();
    if (title) {
      titles[sessionId] = title;
    } else {
      delete titles[sessionId];
    }
    localStorage.setItem(SHELL_TITLE_CACHE_KEY, JSON.stringify(titles));
  } catch { /* ignore */ }
}

function removeCachedShellTitle(sessionId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const titles = readCachedShellTitles();
    delete titles[sessionId];
    localStorage.setItem(SHELL_TITLE_CACHE_KEY, JSON.stringify(titles));
  } catch { /* ignore */ }
}


// Agent identity localStorage cache: persists the last-known agent identity per
// session so the sidebar icon (AgentBrandAvatar) renders immediately on page refresh.
const AGENT_CACHE_KEY = 'termdock-agent-cache-v1';

function readCachedAgents(): Record<string, import('../terminal/types').AgentIdentity> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(AGENT_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch { return {}; }
}

function writeCachedAgent(sessionId: string, agent: import('../terminal/types').AgentIdentity | null): void {
  if (typeof window === 'undefined') return;
  try {
    const agents = readCachedAgents();
    if (agent) {
      agents[sessionId] = agent;
    } else {
      delete agents[sessionId];
    }
    localStorage.setItem(AGENT_CACHE_KEY, JSON.stringify(agents));
  } catch { /* ignore */ }
}

function removeCachedAgent(sessionId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const agents = readCachedAgents();
    delete agents[sessionId];
    localStorage.setItem(AGENT_CACHE_KEY, JSON.stringify(agents));
  } catch { /* ignore */ }
}

function clearAllCachedAgents(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(AGENT_CACHE_KEY);
  } catch { /* ignore */ }
}

/** Public API for sidebar fallback: reads the cached agent identity synchronously. */
export function getCachedAgentIdentity(sessionId: string): import('../terminal/types').AgentIdentity | null {
  return readCachedAgents()[sessionId] ?? null;
}

function clearAllCachedShellTitles(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(SHELL_TITLE_CACHE_KEY);
  } catch { /* ignore */ }
}

export const useTerminalStore = create<TerminalStore>((set, get) => {
  // 闭包内批处理状态。详见顶部 BatchState 接口注释。
  const batch: BatchState = {
    pendingChunksBySession: new Map(),
    activitySessionIds: new Set(),
    batchFlushRafRef: null,
  };

  const scheduleBatchFlush = () => {
    if (batch.batchFlushRafRef !== null) return;
    if (typeof window === 'undefined') {
      flushPendingBatches();
      return;
    }
    batch.batchFlushRafRef = window.requestAnimationFrame(() => {
      batch.batchFlushRafRef = null;
      flushPendingBatches();
    });
  };

  const flushPendingBatches = () => {
    if (batch.pendingChunksBySession.size === 0) return;
    const batches = drainTerminalOutputFrame(batch.pendingChunksBySession);
    const activitySessionIds = new Set(
      [...batches.keys()].filter((sessionId) => batch.activitySessionIds.has(sessionId)),
    );
    for (const sessionId of batches.keys()) {
      if (!batch.pendingChunksBySession.has(sessionId)) {
        batch.activitySessionIds.delete(sessionId);
      }
    }
    set((state) => {
      const newSessions = new Map(state.sessions);
      let nextChunkId = state.nextChunkId;
      const now = Date.now();
      for (const [sessionId, chunks] of batches) {
        const existing = newSessions.get(sessionId) ?? createEmptySessionState(sessionId);
        let bufferChunks: TerminalChunk[] = existing.bufferChunks.length > 0
          ? [...existing.bufferChunks]
          : [];
        let bufferLength = existing.bufferLength;

        for (const data of chunks) {
          bufferChunks.push({ id: nextChunkId++, data });
          bufferLength += data.length;
        }

        while (bufferLength > TERMINAL_BUFFER_LIMIT && bufferChunks.length > 1) {
          const removed = bufferChunks.shift();
          if (!removed) break;
          bufferLength -= removed.data.length;
        }

        newSessions.set(sessionId, {
          ...existing,
          bufferChunks,
          bufferLength,
          lastOutputAt: activitySessionIds.has(sessionId) ? now : existing.lastOutputAt,
          updatedAt: now,
        });
      }
      return { sessions: newSessions, nextChunkId };
    });
    if (batch.pendingChunksBySession.size > 0) scheduleBatchFlush();
  };

  return {
  sessions: new Map(),
  nextChunkId: 1,
  activeSessionId: null,

  getTerminalSession: (sessionId: string) => {
    return get().sessions.get(sessionId);
  },

  setActiveSessionId: (id: string | null) => {
    set({ activeSessionId: id });
    // When user switches to a session, clear its needs-review flag
    // and tell the server so it survives page refresh.
    if (id) {
      const session = get().sessions.get(id);
      if (session?.agentNeedsReview) {
        const newSessions = new Map(get().sessions);
        newSessions.set(id, { ...session, agentNeedsReview: false, updatedAt: Date.now() });
        set({ sessions: newSessions });
        if (session.terminalSessionId) {
          sendAgentReviewAck(session.terminalSessionId);
        }
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

      // 展示元数据（程序名/目录）延续旧值作为占位：换绑后端连接时 buffer 应重置，
      // 但 tab 名不应塌空。新连接的 connected/active-program 事件会随后覆盖。
      newSessions.set(sessionId, {
        ...baseState,
        terminalSessionId: terminalSession.sessionId,
        mode: terminalSession.mode ?? baseState.mode,
        tmuxSessionName: terminalSession.tmuxSessionName ?? baseState.tmuxSessionName,
        activeProgram: terminalSession.activeProgram ?? existing?.activeProgram ?? baseState.activeProgram,
        activeProgramRaw: terminalSession.activeProgramRaw ?? existing?.activeProgramRaw ?? baseState.activeProgramRaw,
        activeProgramSource: terminalSession.activeProgramSource ?? existing?.activeProgramSource ?? baseState.activeProgramSource,
        cwd: terminalSession.cwd ?? existing?.cwd ?? baseState.cwd,
        agentResumeRecovered: existing?.agentResumeRecovered ?? baseState.agentResumeRecovered,
        shellTitle: existing?.shellTitle ?? readCachedShellTitles()[sessionId] ?? baseState.shellTitle,
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

  setSessionShellTitle: (sessionId: string, title: string | null) => {
    set((state) => {
      const existing = state.sessions.get(sessionId);
      if (!existing || existing.shellTitle === title) return state;
      const newSessions = new Map(state.sessions);
      newSessions.set(sessionId, { ...existing, shellTitle: title, updatedAt: Date.now() });
      return { sessions: newSessions };
    });
    writeCachedShellTitle(sessionId, title);
  },

  setSessionPromptState: (sessionId: string, promptState: 'idle' | 'running', exitCode?: number | null) => {
    set((state) => {
      const existing = state.sessions.get(sessionId);
      if (!existing || existing.promptState === promptState) return state;
      const newSessions = new Map(state.sessions);
      newSessions.set(sessionId, {
        ...existing,
        promptState,
        shellExitCode: exitCode ?? existing.shellExitCode,
        updatedAt: Date.now(),
      });
      return { sessions: newSessions };
    });
  },

  setSessionTuiProgress: (sessionId: string, report: TuiProgressReport | null) => {
    set((state) => {
      const existing = state.sessions.get(sessionId);
      if (!existing) return state;
      const nextReport = report?.state === 'remove' ? null : report;
      if (
        existing.tuiProgress?.state === nextReport?.state &&
        existing.tuiProgress?.progress === nextReport?.progress
      ) return state;
      const newSessions = new Map(state.sessions);
      newSessions.set(sessionId, { ...existing, tuiProgress: nextReport, updatedAt: Date.now() });
      return { sessions: newSessions };
    });
  },

  setSessionGitStatus: (sessionId: string, gitStatus) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(sessionId);
      if (!existing) return state;
      const same = JSON.stringify(existing.gitStatus) === JSON.stringify(gitStatus);
      if (same) return state;
      newSessions.set(sessionId, { ...existing, gitStatus, updatedAt: Date.now() });
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

  setSessionAgentStatus: (sessionId: string, payload: AgentStatusPayload) => {
    const state = get();
    const existing = state.sessions.get(sessionId);
    if (!existing) return;

    const agentStatus = payload.agentStatus ?? null;
    const nextAgentIndicator = agentStatus && agentStatus !== 'idle' ? (payload.agentIndicator ?? existing.agentIndicator ?? null) : null;
    const nextAgentStatusDetail = agentStatus && agentStatus !== 'idle'
      ? (payload.agentStatusDetail ?? null)
      : null;
    const nextAgent = payload.agent !== undefined ? payload.agent : existing.agent;
    const nextMessage = payload.agentMessage !== undefined ? payload.agentMessage : (agentStatus ? existing.agentMessage : null);
    const nextNativeId = payload.agentNativeSessionId !== undefined ? payload.agentNativeSessionId : existing.agentNativeSessionId;
    const nextResumeRecovered = payload.agentResumeRecovered !== undefined
      ? payload.agentResumeRecovered
      : existing.agentResumeRecovered;
    const nextRich = payload.agentRich ?? existing.agentRich;
    const nextActivity = payload.agentActivity ?? existing.agentActivity;
    const nextAgentCwd = payload.agentCwd !== undefined ? payload.agentCwd : existing.agentCwd;

    const userNotViewing = state.activeSessionId !== sessionId;
    const wasActive = existing.agentStatus === 'working' || existing.agentStatus === 'waiting' || existing.agentStatus === 'done';
    // Server-authoritative reviewed flag: false means the current turn's result
    // hasn't been acknowledged by any client. Survives page refresh because
    // the server broadcasts it on every WS reconnect.
    const agentNeedsReview = payload.reviewed === false
      // Fallback for agent-exit (null status, no session): old heuristic as
      // a one-shot frontend-side flag. Won't survive refresh, which is fine
      // because the browser reload itself is a strong "reviewed" signal.
      || (payload.reviewed === null && agentStatus === null && wasActive && userNotViewing);

    if (
      existing.agentStatus === agentStatus &&
      existing.agentIndicator === nextAgentIndicator &&
      existing.agentStatusDetail === nextAgentStatusDetail &&
      existing.agent === nextAgent &&
      existing.agentMessage === nextMessage &&
      existing.agentNativeSessionId === nextNativeId &&
      existing.agentResumeRecovered === nextResumeRecovered &&
      existing.agentRich === nextRich &&
      existing.agentActivity === nextActivity &&
      existing.agentCwd === nextAgentCwd &&
      existing.agentNeedsReview === agentNeedsReview
    ) return;

    const newSessions = new Map(state.sessions);
    newSessions.set(sessionId, {
      ...existing,
      agentStatus,
      agentIndicator: nextAgentIndicator,
      agentStatusDetail: nextAgentStatusDetail,
      agent: nextAgent,
      agentMessage: nextMessage,
      agentNativeSessionId: nextNativeId,
      agentResumeRecovered: nextResumeRecovered,
      agentRich: nextRich,
      agentActivity: nextActivity,
      agentCwd: nextAgentCwd,
      agentNeedsReview,
      updatedAt: Date.now(),
    });
    set({ sessions: newSessions });

    // Cache agent identity for sidebar fallback on page refresh.
    if (nextAgent) {
      writeCachedAgent(sessionId, nextAgent);
    }

    if (!getStoredPwaAiNotificationsEnabled()) return;

    const agentName = nextAgent?.displayName ?? existing.agent?.displayName ?? 'Agent';
    const locale = getStoredLocale();
    const nt = getAgentNotificationText(locale, agentName);
    // Tags match the server push path format (pushService.ts notifyAgentTransition)
    // so the in-memory dedup (claimNotificationPayload) prevents double-fire when
    // both the WS path here and the SW postMessage handler fire for the same event.
    // waiting：agent 回合中停下来等人（权限/提问）——这是整个功能的核心时刻。
    if (agentStatus === 'waiting' && existing.agentStatus !== 'waiting' && userNotViewing) {
      void showPwaNotification({
        title: nt.waitingTitle,
        body: nextMessage ?? nt.waitingBody,
        tag: `agent:${sessionId}`,
        dedupKey: `agent:${sessionId}:waiting:${nextActivity}`,
        data: { url: '/', sessionId },
        deferToPush: true,
      });
      return;
    }
    // done：回合完成。
    if (agentStatus === 'done' && existing.agentStatus !== 'done' && userNotViewing) {
      void showPwaNotification({
        title: nt.doneTitle,
        body: nt.doneBody,
        tag: `agent:${sessionId}`,
        dedupKey: `agent:${sessionId}:done:${nextActivity}`,
        data: { url: '/', sessionId },
        deferToPush: true,
      });
      return;
    }
    // 退出：agent 在工作中/等待中直接退出（done 已通知过，不重复）。
    if (agentStatus === null && (existing.agentStatus === 'working' || existing.agentStatus === 'waiting') && userNotViewing) {
      void showPwaNotification({
        title: nt.exitedTitle,
        body: nt.exitedBody,
        tag: `agent:${sessionId}`,
        dedupKey: `agent:${sessionId}:exited:${nextActivity}`,
        data: { url: '/', sessionId },
        deferToPush: true,
      });
    }
  },

  setAgentResumeRecovered: (sessionId: string, recovered: boolean) => {
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(sessionId) ?? createEmptySessionState(sessionId);
      if (existing.agentResumeRecovered === recovered) return state;
      newSessions.set(sessionId, {
        ...existing,
        agentResumeRecovered: recovered,
        updatedAt: Date.now(),
      });
      return { sessions: newSessions };
    });
  },

  clearAgentNeedsReview: (sessionId: string) => {
    const session = get().sessions.get(sessionId);
    if (!session?.agentNeedsReview) return;
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(sessionId);
      if (!existing || !existing.agentNeedsReview) return state;
      newSessions.set(sessionId, { ...existing, agentNeedsReview: false, updatedAt: Date.now() });
      return { sessions: newSessions };
    });
    if (session.terminalSessionId) {
      sendAgentReviewAck(session.terminalSessionId);
    }
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

  appendToBuffer: (sessionId: string, chunk: string, options?: { markActivity?: boolean }) => {
    if (!chunk) {
      return;
    }
    // rAF 批处理:把 chunk push 到 module 级 per-session 队列,下一帧合并 flush。
    // 单次 setState 处理多个 chunk,而不是 N 次 setState 处理 N 个 chunk。
    // 详见 scheduleBatchFlush 注释。
    let list = batch.pendingChunksBySession.get(sessionId);
    if (!list) {
      list = [];
      batch.pendingChunksBySession.set(sessionId, list);
    }
    list.push(...splitTerminalOutputChunk(chunk));
    if (options?.markActivity !== false) {
      batch.activitySessionIds.add(sessionId);
    }
    scheduleBatchFlush();
  },

  replaceBuffer: (sessionId: string, chunks: string[]) => {
    // 清掉这个 session 的 pending batch:replaceBuffer 是一次性整体替换,
    // 之前的 pending chunks 不能 flush 进 state(否则新旧数据混在一起)。
    batch.pendingChunksBySession.delete(sessionId);
    batch.activitySessionIds.delete(sessionId);
    if (batch.pendingChunksBySession.size === 0 && batch.batchFlushRafRef !== null) {
      window.cancelAnimationFrame(batch.batchFlushRafRef);
      batch.batchFlushRafRef = null;
    }
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(sessionId);
      if (!existing) {
        return state;
      }

      if (!chunks || chunks.length === 0) {
        newSessions.set(sessionId, {
          ...existing,
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
        for (const slice of splitTerminalOutputChunk(chunk)) {
          bufferChunks.push({ id: nextChunkId++, data: slice });
          bufferLength += slice.length;
        }
      }

      while (bufferLength > TERMINAL_BUFFER_LIMIT && bufferChunks.length > 1) {
        const removed = bufferChunks.shift();
        if (!removed) break;
        bufferLength -= removed.data.length;
      }

      newSessions.set(sessionId, {
        ...existing,
        bufferChunks,
        bufferLength,
        updatedAt: Date.now(),
      });

      return { sessions: newSessions, nextChunkId };
    });
  },

  clearTerminalSession: (sessionId: string) => {
    // 清掉这个 session 的 pending batch,避免 stale chunk 复活
    batch.pendingChunksBySession.delete(sessionId);
    batch.activitySessionIds.delete(sessionId);
    if (batch.pendingChunksBySession.size === 0 && batch.batchFlushRafRef !== null) {
      window.cancelAnimationFrame(batch.batchFlushRafRef);
      batch.batchFlushRafRef = null;
    }
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(sessionId);
      if (existing) {
        // 只清「连接层」状态。activeProgram / cwd 属于展示元数据，生命周期绑定
        // 前端 session，应延续作为占位，由新连接的 connected/active-program 事件
        // 覆盖——否则后台返回重连期间 tab 名会先塌回默认名再跳回，造成闪烁。
        newSessions.set(sessionId, {
          ...existing,
          terminalSessionId: null,
          isConnecting: false,
          agentStatus: null,
          agentIndicator: null,
          agentStatusDetail: null,
          agent: null,
          agentMessage: null,
          agentNeedsReview: false,
          updatedAt: Date.now(),
        });
      }
      return { sessions: newSessions };
    });
  },

  clearBuffer: (sessionId: string) => {
    // 清掉 pending batch
    batch.pendingChunksBySession.delete(sessionId);
    batch.activitySessionIds.delete(sessionId);
    if (batch.pendingChunksBySession.size === 0 && batch.batchFlushRafRef !== null) {
      window.cancelAnimationFrame(batch.batchFlushRafRef);
      batch.batchFlushRafRef = null;
    }
    set((state) => {
      const newSessions = new Map(state.sessions);
      const existing = newSessions.get(sessionId);
      if (!existing) {
        return state;
      }
      newSessions.set(sessionId, {
        ...existing,
        bufferChunks: [],
        bufferLength: 0,
        updatedAt: Date.now(),
      });
      return { sessions: newSessions };
    });
  },

  removeTerminalSession: (sessionId: string) => {
    batch.pendingChunksBySession.delete(sessionId);
    batch.activitySessionIds.delete(sessionId);
    set((state) => {
      const newSessions = new Map(state.sessions);
      newSessions.delete(sessionId);
      return { sessions: newSessions };
    });
    removeCachedShellTitle(sessionId);
    removeCachedAgent(sessionId);
  },

  clearAllTerminalSessions: () => {
    // 清掉所有 pending batch
    batch.pendingChunksBySession.clear();
    batch.activitySessionIds.clear();
    if (batch.batchFlushRafRef !== null) {
      window.cancelAnimationFrame(batch.batchFlushRafRef);
      batch.batchFlushRafRef = null;
    }
    set({ sessions: new Map(), nextChunkId: 1 });
    clearAllCachedShellTitles();
    clearAllCachedAgents();
  },
  };
});
