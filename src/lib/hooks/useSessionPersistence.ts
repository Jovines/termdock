import { useState, useEffect, useCallback, useRef } from 'react';
import { clearTerminalClientState, getTerminalClientState, replaceTerminalClientState, type PersistedTerminalClientSession } from '../terminal/api';

const LEGACY_STORAGE_KEY = 'termdock-sessions';

function writeLegacyLocalState(sessionList: PersistedSession[], activeSessionId: string | null): void {
  if (typeof window === 'undefined') {
    return;
  }

  localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ sessions: sessionList, activeSessionId }));
}

export interface PersistedSession {
  sessionId: string;  // 前端生成的 session ID
  name: string;
  backendSessionId: string | null;  // 后端 sessionId，用于复用
  mode: 'shell' | 'tmux';
  tmuxSessionName: string | null;
  keepAliveMs: number | null;
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
  updateSessionKeepAliveMs: (sessionId: string, keepAliveMs: number | null) => void;
  renameSession: (sessionId: string, newName: string) => void;
  clearAllSessions: () => void;
  restoreSessions: () => Promise<PersistedSession[]>;
}

const DEFAULT_KEEP_ALIVE_MS = 3 * 60 * 60 * 1000;

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
      keepAliveMs: Object.prototype.hasOwnProperty.call(session, 'keepAliveMs')
        ? (session.keepAliveMs ?? null)
        : DEFAULT_KEEP_ALIVE_MS,
    }));
  }, []);

  const queuePersist = useCallback((sessionList: PersistedSession[], nextActiveSessionId: string | null = activeSessionIdRef.current) => {
    const nextState = {
      sessions: sessionList,
      activeSessionId: nextActiveSessionId,
    };

    writeLegacyLocalState(sessionList, nextActiveSessionId);

    persistQueueRef.current = persistQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        try {
          if (nextState.sessions.length === 0) {
            await clearTerminalClientState();
            return;
          }
          await replaceTerminalClientState(nextState);
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
    setActiveSessionIdState(storedActiveSessionId);

    if (sessionList.length > 0) {
      await replaceTerminalClientState({
        sessions: sessionList,
        activeSessionId: storedActiveSessionId,
      });
    } else {
      await clearTerminalClientState();
    }

    localStorage.removeItem(LEGACY_STORAGE_KEY);
    return sessionList;
  }, [normalizeSessionList]);

  // 从服务端读取会话；首次访问时迁移旧版 localStorage 数据。
  const restoreSessions = useCallback(async (): Promise<PersistedSession[]> => {
    if (typeof window === 'undefined') return [];

    try {
      const data = await getTerminalClientState();
      const sessionList = normalizeSessionList(data.sessions || []);
      const restoredActiveSessionId = typeof data.activeSessionId === 'string' && data.activeSessionId.trim().length > 0
        ? data.activeSessionId
        : null;

      if (sessionList.length > 0) {
        setSessions(sessionList);
        setActiveSessionIdState(restoredActiveSessionId);
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

  // 保存新会话
  const saveSession = useCallback((session: Omit<PersistedSession, 'createdAt' | 'lastActivity' | 'backendSessionId'>, backendSessionId: string | null) => {
    const now = Date.now();
    const keepAliveMs = session.keepAliveMs === undefined ? DEFAULT_KEEP_ALIVE_MS : session.keepAliveMs;
    const newSession: PersistedSession = {
      ...session,
      backendSessionId,
      mode: session.mode === 'tmux' ? 'tmux' : 'shell',
      tmuxSessionName: session.tmuxSessionName ?? null,
      keepAliveMs,
      createdAt: now,
      lastActivity: now,
    };

    setSessions(prev => {
      const updated = [...prev, newSession];
      queuePersist(updated, session.sessionId);
      return updated;
    });

    setActiveSessionIdState(session.sessionId);
  }, [queuePersist]);

  // 移除会话
  const removeSession = useCallback((sessionId: string) => {
    setSessions(prev => {
      const updated = prev.filter(s => s.sessionId !== sessionId);
      const nextActiveSessionId = activeSessionIdRef.current === sessionId
        ? (updated[0]?.sessionId ?? null)
        : activeSessionIdRef.current;
      setActiveSessionIdState(nextActiveSessionId);
      queuePersist(updated, nextActiveSessionId);
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

  // 设置活跃会话
  const setActiveSession = useCallback((sessionId: string | null) => {
    setActiveSessionIdState(sessionId);
    queuePersist(sessions, sessionId);
  }, [queuePersist, sessions]);

  // 重命名会话
  const renameSession = useCallback((sessionId: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;

    setSessions(prev => {
      const updated = prev.map(s =>
        s.sessionId === sessionId ? { ...s, name: trimmed } : s
      );
      queuePersist(updated);
      return updated;
    });
  }, [queuePersist]);

  // 清除所有会话
  const clearAllSessions = useCallback(() => {
    setSessions([]);
    setActiveSessionIdState(null);
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

  const updateSessionKeepAliveMs = useCallback((sessionId: string, keepAliveMs: number | null) => {
    setSessions(prev => {
      const updated = prev.map(s =>
        s.sessionId === sessionId ? { ...s, keepAliveMs } : s
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

  return {
    sessions,
    activeSessionId,
    isLoading,
    saveSession,
    removeSession,
    updateSessionActivity,
    setActiveSession,
    updateSessionBackendId,
    updateSessionKeepAliveMs,
    renameSession,
    clearAllSessions,
    restoreSessions,
  };
}
