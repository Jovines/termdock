import { useState, useEffect, useCallback, useRef } from 'react';

const STORAGE_KEY = 'web-terminal-sessions';

export interface PersistedSession {
  sessionId: string;  // 前端生成的 session ID
  name: string;
  backendSessionId: string | null;  // 后端 sessionId，用于复用
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
  clearAllSessions: () => void;
  restoreSessions: () => Promise<PersistedSession[]>;
}

export function useSessionPersistence(): UseSessionPersistenceReturn {
  const [sessions, setSessions] = useState<PersistedSession[]>([]);
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const initialized = useRef(false);

  // 从 localStorage 读取会话
  const restoreSessions = useCallback(async (): Promise<PersistedSession[]> => {
    if (typeof window === 'undefined') return [];

    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const data = JSON.parse(stored);
        const sessionList = data.sessions || [];
        const activeId = data.activeSessionId || null;

        setSessions(sessionList);
        setActiveSessionIdState(activeId);
        return sessionList;
      }
    } catch (error) {
      console.error('Failed to restore sessions from localStorage:', error);
    } finally {
      setIsLoading(false);
    }

    return [];
  }, []);

  // 保存会话到 localStorage
  const persistSessions = useCallback((sessionList: PersistedSession[], activeId: string | null) => {
    if (typeof window === 'undefined') return;

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        sessions: sessionList,
        activeSessionId: activeId,
      }));
    } catch (error) {
      console.error('Failed to persist sessions to localStorage:', error);
    }
  }, []);

  // 保存新会话
  const saveSession = useCallback((session: Omit<PersistedSession, 'createdAt' | 'lastActivity' | 'backendSessionId'>, backendSessionId: string | null) => {
    const now = Date.now();
    const newSession: PersistedSession = {
      ...session,
      backendSessionId,
      createdAt: now,
      lastActivity: now,
    };

    setSessions(prev => {
      const updated = [...prev, newSession];
      persistSessions(updated, session.sessionId);
      return updated;
    });

    setActiveSessionIdState(session.sessionId);
  }, [persistSessions]);

  // 移除会话
  const removeSession = useCallback((sessionId: string) => {
    setSessions(prev => {
      const updated = prev.filter(s => s.sessionId !== sessionId);
      const newActiveId = updated.length > 0 ? updated[0].sessionId : null;
      persistSessions(updated, newActiveId);
      return updated;
    });
  }, [persistSessions]);

  // 更新会话活跃时间
  const updateSessionActivity = useCallback((sessionId: string) => {
    const now = Date.now();
    setSessions(prev => {
      const updated = prev.map(s =>
        s.sessionId === sessionId ? { ...s, lastActivity: now } : s
      );
      // 保持当前的 activeSessionId 不变
      const currentActive = prev.find(s => s.sessionId === activeSessionId);
      const newActiveId = currentActive ? currentActive.sessionId : (updated[0]?.sessionId || null);
      persistSessions(updated, newActiveId);
      return updated;
    });
  }, [activeSessionId, persistSessions]);

  // 设置活跃会话
  const setActiveSession = useCallback((sessionId: string | null) => {
    setActiveSessionIdState(sessionId);
    setSessions(prev => {
      persistSessions(prev, sessionId);
      return prev;
    });
  }, [persistSessions]);

  // 清除所有会话
  const clearAllSessions = useCallback(() => {
    setSessions([]);
    setActiveSessionIdState(null);
    if (typeof window !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  // 更新会话的 backendSessionId
  const updateSessionBackendId = useCallback((sessionId: string, backendSessionId: string) => {
    setSessions(prev => {
      const updated = prev.map(s =>
        s.sessionId === sessionId ? { ...s, backendSessionId } : s
      );
      // 保持当前的 activeSessionId 不变
      const currentActive = prev.find(s => s.sessionId === activeSessionId);
      const newActiveId = currentActive ? currentActive.sessionId : (updated[0]?.sessionId || null);
      persistSessions(updated, newActiveId);
      return updated;
    });
  }, [activeSessionId, persistSessions]);

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
    clearAllSessions,
    restoreSessions,
  };
}


