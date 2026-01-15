import React, { useEffect, useCallback, useState, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { TerminalView } from './views/TerminalView';
import { SessionTabs } from './session/SessionTabs';
import { SessionListDrawer } from './ui/BottomDrawer';
import { useSessionPersistence } from '../hooks/useSessionPersistence';
import { reconnectTerminalSession, createTerminalSession } from '../terminal/api';
import { useTerminalStore } from '../stores/useTerminalStore';

interface TerminalSession {
  id: string;
  cwd: string;
  name: string;
  sessionId: string | null;
  history?: string[];
}

interface MultiTerminalViewProps {
  defaultCwd?: string;
  theme?: 'dark' | 'light' | 'solarized' | 'dracula' | 'nord';
  fontFamily?: string;
  fontSize?: number;
  showDebug?: boolean;
  onStatusChange?: (status: { isConnecting: boolean; isRestarting: boolean; hasError: boolean; sessionId: string | null }) => void;
}

let sessionCounter = 1;

function generateSessionName(): string {
  return `terminal-${sessionCounter++}`;
}

export const MultiTerminalView: React.FC<MultiTerminalViewProps> = ({
  defaultCwd = '/',
  theme = 'dark',
  fontFamily = 'Menlo, Monaco, Consolas, monospace',
  fontSize = 13,
  showDebug,
  onStatusChange,
}) => {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(true);
  const restoredRef = useRef(false);  // 防止重复恢复
  const [isSessionDrawerOpen, setIsSessionDrawerOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  const {
    sessions: persistedSessions,
    activeSessionId: persistedActiveId,
    isLoading,
    saveSession,
    removeSession,
    setActiveSession,
    updateSessionBackendId,
  } = useSessionPersistence();

  // 尝试为单个 session 恢复或创建 session
  const restoreOrCreateSession = useCallback(async (session: typeof persistedSessions[0]): Promise<TerminalSession> => {
    const { sessionId, cwd, name, backendSessionId } = session;

    // 如果有 backendSessionId，尝试重连
    if (backendSessionId) {
      try {
        const reconnected = await reconnectTerminalSession(backendSessionId);
        console.log('[Session] Reconnected to existing session:', backendSessionId, 'history chunks:', reconnected.history?.length);
        return {
          id: sessionId,
          cwd: reconnected.cwd,
          name,
          sessionId: reconnected.sessionId,
          history: reconnected.history,
        };
      } catch {
        console.log('[Session] Reconnect failed, creating new session:', backendSessionId);
      }
    }

    // 创建新 session
    const newSession = await createTerminalSession({ cwd });
    console.log('[Session] Created new session:', newSession.sessionId);

    return {
      id: sessionId,
      cwd,
      name,
      sessionId: newSession.sessionId,
    };
  }, []);

  // 恢复会话（尝试复用现有 session）- 只执行一次
  useEffect(() => {
    if (isLoading) return;
    if (restoredRef.current) return;  // 防止重复执行
    restoredRef.current = true;

    console.log('[Session] Restoring', persistedSessions.length, 'persisted sessions');

    if (persistedSessions.length > 0) {
      // 并行恢复所有 session
      Promise.all(persistedSessions.map(async (session) => {
        const s = await restoreOrCreateSession(session);
        return s;
      })).then((sessions) => {
        console.log('[Session] Restored sessions:', sessions.map(s => ({ id: s.id, cwd: s.cwd, sessionId: s.sessionId })));
        setSessions(sessions);
        setActiveSessionId(persistedActiveId || sessions[0]?.id || null);
        setIsRestoring(false);

        // Update localStorage and useTerminalStore
        const store = useTerminalStore.getState();
        sessions.forEach(session => {
          if (session.sessionId) {
            updateSessionBackendId(session.id, session.sessionId);
            store.setTerminalSession(session.id, {
              sessionId: session.sessionId,
              cols: 80,
              rows: 24,
            }, session.cwd);
            // 存储历史数据
            if (session.history && session.history.length > 0) {
              store.setSessionHistory(session.id, session.history);
              console.log('[Session] Stored history for session:', session.id, 'chunks:', session.history.length);
            }
            console.log('[Session] Updated useTerminalStore for session:', session.id, 'backendSessionId:', session.sessionId);
          }
        });
      }).catch((error) => {
        console.error('[Session] Failed to restore sessions:', error);
        // 即使失败也继续，使用空的 session
        const fallbackSessions = persistedSessions.map((session) => ({
          id: session.sessionId,
          cwd: session.cwd,
          name: session.name,
          sessionId: null as string | null,
        }));
        setSessions(fallbackSessions);
        setActiveSessionId(persistedActiveId || fallbackSessions[0]?.id || null);
        setIsRestoring(false);
      });

      return;
    }

    console.log('[Session] No persisted sessions');
    setIsRestoring(false);
  }, [isLoading, persistedSessions, persistedActiveId, restoreOrCreateSession, updateSessionBackendId]);

  // 创建新会话
  const createSession = useCallback(async (cwd: string) => {
    const sessionId = uuidv4();
    const name = generateSessionName();

    // 创建新 session
    const newTerminalSession = await createTerminalSession({ cwd });

    const newSession: TerminalSession = {
      id: sessionId,
      cwd,
      name,
      sessionId: newTerminalSession.sessionId,
    };

    setSessions((prev) => {
      const updated = [...prev, newSession];
      return updated;
    });

    setActiveSessionId(sessionId);

    // 持久化会话
    saveSession({ sessionId, cwd, name }, newTerminalSession.sessionId);

    return { sessionId, backendSessionId: newTerminalSession.sessionId };
  }, [saveSession]);

  // 关闭会话
  const closeSession = useCallback((sessionId: string) => {
    setSessions((prev) => {
      const filtered = prev.filter((s) => s.id !== sessionId);
      setActiveSessionId((currentId) => {
        if (currentId === sessionId) {
          return filtered.length > 0 ? filtered[0].id : null;
        }
        return currentId;
      });
      return filtered;
    });

    // 移除持久化
    removeSession(sessionId);
  }, [removeSession]);

  // 切换会话
  const switchSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
    setActiveSession(sessionId);
  }, [setActiveSession]);

  // 移动端检测
  useEffect(() => {
    const checkIsMobile = () => {
      if (typeof window === 'undefined') return false;
      const hasTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
      const isNarrow = window.innerWidth < 768;
      return hasTouch && isNarrow;
    };
    setIsMobile(checkIsMobile());
    const handleResize = () => setIsMobile(checkIsMobile());
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // 监听来自 App.tsx 的打开会话抽屉事件
  useEffect(() => {
    const handleOpenSessionDrawer = () => {
      if (isMobile) {
        setIsSessionDrawerOpen(true);
      }
    };
    window.addEventListener('open-session-drawer', handleOpenSessionDrawer);
    return () => window.removeEventListener('open-session-drawer', handleOpenSessionDrawer);
  }, [isMobile]);

  // 没有会话时创建新的
  useEffect(() => {
    if (!isRestoring && sessions.length === 0) {
      createSession(defaultCwd);
    }
  }, [isRestoring, sessions.length, defaultCwd, createSession]);

  const activeSession = sessions.find((s) => s.id === activeSessionId) || sessions[0];

  if (isRestoring) {
    return (
      <div className="h-full flex items-center justify-center bg-background text-muted">
        <div className="flex flex-col items-center gap-2">
          <div className="w-6 h-6 border-2 border-border border-t-accent rounded-full animate-spin" />
          <span className="text-sm">Restoring sessions...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Desktop: Show session tabs */}
      {!isMobile && (
        <SessionTabs
          sessions={sessions}
          activeSessionId={activeSessionId}
          onNewSession={() => createSession(defaultCwd)}
          onSwitchSession={switchSession}
          onCloseSession={closeSession}
        />
      )}

      <div className="flex-1 overflow-hidden">
        {activeSession && (
          <TerminalView
            key={activeSession.id}
            sessionId={activeSession.id}
            cwd={activeSession.cwd}
            theme={theme}
            fontFamily={fontFamily}
            fontSize={fontSize}
            showDebug={showDebug}
            onStatusChange={onStatusChange}
          />
        )}
      </div>

      {/* Mobile: Session list drawer */}
      {isMobile && (
        <SessionListDrawer
          isOpen={isSessionDrawerOpen}
          onClose={() => setIsSessionDrawerOpen(false)}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onNewSession={() => {
            createSession(defaultCwd);
            setIsSessionDrawerOpen(false);
          }}
          onSwitchSession={(id) => {
            switchSession(id);
            setIsSessionDrawerOpen(false);
          }}
          onCloseSession={closeSession}
        />
      )}
    </div>
  );
};
