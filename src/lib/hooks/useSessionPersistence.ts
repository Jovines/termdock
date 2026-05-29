import { useState, useEffect, useCallback, useRef } from 'react';
import { clearTerminalClientState, getTerminalClientState, replaceTerminalClientState, type PersistedTerminalClientSession } from '../terminal/api';

const LEGACY_STORAGE_KEY = 'termdock-sessions';
const ACTIVE_SESSION_STORAGE_KEY = 'termdock-active-session';
const SESSIONS_POLL_INTERVAL = 5000; // 5 seconds

function readActiveSessionId(): string | null {
  try {
    const val = localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
    return val && val.trim().length > 0 ? val : null;
  } catch { return null; }
}

function writeActiveSessionId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, id);
    else localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
  } catch { /* ignore */ }
}

export interface PersistedSession {
  sessionId: string;  // 前端生成的 session ID
  name: string;
  customName: boolean;
  backendSessionId: string | null;  // 后端 sessionId，用于复用
  mode: 'shell' | 'tmux';
  tmuxSessionName: string | null;
  createdAt: number;
  lastActivity: number;
}

interface UseSessionPersistenceReturn {
  sessions: PersistedSession[];
  activeSessionId: string | null;
  isLoading: boolean;
  saveSession: (session: Omit<PersistedSession, 'createdAt' | 'lastActivity' | 'backendSessionId'>, backendSessionId: string | null) => void;
  removeSession: (sessionId: string) => void;
  updateSessionActivity: (sessionId: string) => void;
  setActiveSession: (sessionId: string | null) => void;
  updateSessionBackendId: (sessionId: string, backendSessionId: string) => void;
  renameSession: (sessionId: string, newName: string) => void;
  resetSessionCustomName: (sessionId: string) => void;
  reorderSessions: (orderedIds: string[]) => void;
  clearAllSessions: () => void;
  restoreSessions: () => Promise<PersistedSession[]>;
}

export function useSessionPersistence(): UseSessionPersistenceReturn {
  const [sessions, setSessions] = useState<PersistedSession[]>([]);
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const initialized = useRef(false);
  const persistQueueRef = useRef<Promise<void>>(Promise.resolve());
  const activeSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const normalizeSessionList = useCallback((sessionList: PersistedTerminalClientSession[]): PersistedSession[] => {
    return sessionList.map((session) => ({
      ...session,
      mode: session.mode === 'tmux' ? 'tmux' : 'shell',
      tmuxSessionName: session.tmuxSessionName ?? null,
      customName: session.customName === true,
    }));
  }, []);

  const queuePersist = useCallback((sessionList: PersistedSession[]) => {
    writeActiveSessionId(activeSessionIdRef.current);

    persistQueueRef.current = persistQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        try {
          if (sessionList.length === 0) {
            await clearTerminalClientState();
            return;
          }
          // Only send sessions, not activeSessionId (that's localStorage-only now)
          await replaceTerminalClientState({ sessions: sessionList });
        } catch (error) {
          console.error('Failed to persist sessions to server:', error);
        }
      });
  }, []);

  const migrateLegacyLocalState = useCallback(async (): Promise<PersistedSession[]> => {
    if (typeof window === 'undefined') {
      return [];
    }

    const stored = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!stored) {
      return [];
    }

    const data = JSON.parse(stored);
    const sessionList = normalizeSessionList((data.sessions || []) as PersistedTerminalClientSession[]);
    const storedActiveSessionId = typeof data.activeSessionId === 'string' && data.activeSessionId.trim().length > 0
      ? data.activeSessionId
      : null;

    setSessions(sessionList);
    if (storedActiveSessionId) {
      setActiveSessionIdState(storedActiveSessionId);
      writeActiveSessionId(storedActiveSessionId);
    }

    if (sessionList.length > 0) {
      await replaceTerminalClientState({ sessions: sessionList });
    } else {
      await clearTerminalClientState();
    }

    localStorage.removeItem(LEGACY_STORAGE_KEY);
    return sessionList;
  }, [normalizeSessionList]);

  // 从服务端读取会话；首次访问时迁移旧版 localStorage 数据。
  // activeSessionId 从 localStorage 读取（不再从服务器）。
  const restoreSessions = useCallback(async (): Promise<PersistedSession[]> => {
    if (typeof window === 'undefined') return [];

    try {
      const data = await getTerminalClientState();
      const sessionList = normalizeSessionList(data.sessions || []);
      // Read activeSessionId from localStorage, not server
      const restoredActiveSessionId = readActiveSessionId();

      if (sessionList.length > 0) {
        setSessions(sessionList);
        // Only set activeSessionId if it still exists in the session list
        const validActiveId = sessionList.some(s => s.sessionId === restoredActiveSessionId)
          ? restoredActiveSessionId
          : (sessionList[0]?.sessionId ?? null);
        setActiveSessionIdState(validActiveId);
        writeActiveSessionId(validActiveId);
        return sessionList;
      }

      return await migrateLegacyLocalState();
    } catch (error) {
      console.error('Failed to restore sessions from server:', error);

      try {
        return await migrateLegacyLocalState();
      } catch (migrationError) {
        console.error('Failed to migrate legacy local sessions:', migrationError);
      }
    } finally {
      setIsLoading(false);
    }

    return [];
  }, [migrateLegacyLocalState, normalizeSessionList]);

  // 保存新会话（带去重：同 sessionId 或同 tmuxSessionName 更新已有条目）
  const saveSession = useCallback((session: Omit<PersistedSession, 'createdAt' | 'lastActivity' | 'backendSessionId'>, backendSessionId: string | null) => {
    const now = Date.now();
    const newSession: PersistedSession = {
      ...session,
      backendSessionId,
      mode: session.mode === 'tmux' ? 'tmux' : 'shell',
      tmuxSessionName: session.tmuxSessionName ?? null,
      customName: session.customName ?? false,
      createdAt: now,
      lastActivity: now,
    };

    setSessions(prev => {
      // 去重：相同 sessionId 直接更新
      const exactIdx = prev.findIndex(s => s.sessionId === session.sessionId);
      if (exactIdx >= 0) {
        const updated = [...prev];
        updated[exactIdx] = newSession;
        queuePersist(updated);
        return updated;
      }

      // 去重：tmux 模式同名 session 视为同一个，替换已有条目
      if (newSession.mode === 'tmux' && newSession.tmuxSessionName) {
        const tmuxIdx = prev.findIndex(
          s => s.mode === 'tmux' && s.tmuxSessionName === newSession.tmuxSessionName
        );
        if (tmuxIdx >= 0) {
          const updated = [...prev];
          updated[tmuxIdx] = newSession;
          queuePersist(updated);
          return updated;
        }
      }

      const updated = [...prev, newSession];
      queuePersist(updated);
      return updated;
    });

    setActiveSessionIdState(session.sessionId);
    writeActiveSessionId(session.sessionId);
  }, [queuePersist]);

  // 移除会话
  const removeSession = useCallback((sessionId: string) => {
    setSessions(prev => {
      const updated = prev.filter(s => s.sessionId !== sessionId);
      const nextActiveSessionId = activeSessionIdRef.current === sessionId
        ? (updated[0]?.sessionId ?? null)
        : activeSessionIdRef.current;
      setActiveSessionIdState(nextActiveSessionId);
      writeActiveSessionId(nextActiveSessionId);
      queuePersist(updated);
      return updated;
    });
  }, [queuePersist]);

  // 更新会话活跃时间
  const updateSessionActivity = useCallback((sessionId: string) => {
    const now = Date.now();
    setSessions(prev => {
      const updated = prev.map(s =>
        s.sessionId === sessionId ? { ...s, lastActivity: now } : s
      );
      queuePersist(updated);
      return updated;
    });
  }, [queuePersist]);

  // 设置活跃会话（仅本地，不触发服务器持久化）
  const setActiveSession = useCallback((sessionId: string | null) => {
    setActiveSessionIdState(sessionId);
    writeActiveSessionId(sessionId);
  }, []);

  // 重命名会话
  const renameSession = useCallback((sessionId: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;

    setSessions(prev => {
      const updated = prev.map(s =>
        s.sessionId === sessionId ? { ...s, name: trimmed, customName: true } : s
      );
      queuePersist(updated);
      return updated;
    });
  }, [queuePersist]);

  // 取消自定义名称,回退到默认显示规则
  const resetSessionCustomName = useCallback((sessionId: string) => {
    setSessions(prev => {
      const updated = prev.map(s =>
        s.sessionId === sessionId ? { ...s, customName: false } : s
      );
      queuePersist(updated);
      return updated;
    });
  }, [queuePersist]);

  // 重排会话顺序
  const reorderSessions = useCallback((orderedIds: string[]) => {
    setSessions(prev => {
      const idToSession = new Map(prev.map(s => [s.sessionId, s]));
      const reordered = orderedIds
        .map(id => idToSession.get(id))
        .filter((s): s is PersistedSession => s !== undefined);
      const covered = new Set(orderedIds);
      const remaining = prev.filter(s => !covered.has(s.sessionId));
      const updated = [...reordered, ...remaining];
      queuePersist(updated);
      return updated;
    });
  }, [queuePersist]);

  // 清除所有会话
  const clearAllSessions = useCallback(() => {
    setSessions([]);
    setActiveSessionIdState(null);
    writeActiveSessionId(null);
    queuePersist([]);
    if (typeof window !== 'undefined') {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
  }, [queuePersist]);

  // 更新会话的 backendSessionId
  const updateSessionBackendId = useCallback((sessionId: string, backendSessionId: string) => {
    setSessions(prev => {
      const updated = prev.map(s =>
        s.sessionId === sessionId ? { ...s, backendSessionId } : s
      );
      queuePersist(updated);
      return updated;
    });
  }, [queuePersist]);

  // 初始化时恢复会话
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      restoreSessions();
    }
  }, [restoreSessions]);

  // 轮询同步：定期从服务器获取 session 列表，检测其他客户端的变更
  useEffect(() => {
    if (isLoading) return;

    const poll = async () => {
      try {
        const data = await getTerminalClientState();
        const serverSessions = normalizeSessionList(data.sessions || []);

        setSessions(prev => {
          // Check if anything actually changed (avoid unnecessary re-renders)
          const key = (s: PersistedSession) => `${s.sessionId}:${s.name}:${s.customName}:${s.backendSessionId}:${s.mode}:${s.tmuxSessionName}`;
          const prevKey = prev.map(key).join('|');
          const nextKey = serverSessions.map(key).join('|');
          if (prevKey === nextKey) return prev;
          return serverSessions;
        });
      } catch {
        // Polling failure is non-fatal
      }
    };

    const intervalId = setInterval(poll, SESSIONS_POLL_INTERVAL);
    return () => clearInterval(intervalId);
  }, [isLoading, normalizeSessionList]);

  return {
    sessions,
    activeSessionId,
    isLoading,
    saveSession,
    removeSession,
    updateSessionActivity,
    setActiveSession,
    updateSessionBackendId,
    renameSession,
    resetSessionCustomName,
    reorderSessions,
    clearAllSessions,
    restoreSessions,
  };
}
