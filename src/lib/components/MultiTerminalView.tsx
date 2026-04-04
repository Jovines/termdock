import React, { useEffect, useCallback, useState, useRef, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { TerminalView } from './views/TerminalView';
import { useSessionPersistence } from '../hooks/useSessionPersistence';
import { reconnectTerminalSession, createTerminalSession, closeTerminal } from '../terminal/api';
import { useTerminalStore } from '../stores/useTerminalStore';

interface TerminalSession {
  id: string;
  name: string;
  sessionId: string | null;
  history?: string[];
}

export interface TerminalSessionInfo {
  id: string;
  name: string;
}

interface MultiTerminalViewProps {
  theme?: 'dark' | 'light' | 'solarized' | 'dracula' | 'nord';
  fontFamily?: string;
  fontSize?: number;
  showDebug?: boolean;
  onStatusChange?: (status: { isConnecting: boolean; isRestarting: boolean; hasError: boolean; sessionId: string | null }) => void;
  onSessionDataUpdate?: (data: { sessions: TerminalSessionInfo[]; activeSessionId: string | null }) => void;
}

let sessionCounter = 1;

function generateSessionName(): string {
  return `terminal-${sessionCounter++}`;
}
function SessionIndicator({
  sessions,
  activeIndex,
}: {
  sessions: TerminalSession[];
  activeIndex: number;
}) {
  if (sessions.length <= 1) return null;

  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-20"
      style={{ top: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}
    >
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-surface/80 backdrop-blur-sm rounded-full border border-border/50 shadow-lg">
        {sessions.map((_, index) => (
          <div
            key={index}
            className={`w-2 h-2 rounded-full transition-all ${
              index === activeIndex
                ? 'bg-primary w-4'
                : 'bg-muted-foreground/30'
            }`}
          />
        ))}
        <span className="ml-2 text-xs text-muted-foreground font-medium">
          {activeIndex + 1}/{sessions.length}
        </span>
      </div>
    </div>
  );
}

export const MultiTerminalView: React.FC<MultiTerminalViewProps> = ({
  theme = 'dark',
  fontFamily = '"JetBrainsMonoNL Nerd Font", "JetBrains Mono"',
  fontSize = 13,
  showDebug,
  onStatusChange,
  onSessionDataUpdate,
}) => {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(true);
  const restoredRef = useRef(false);

  const {
    sessions: persistedSessions,
    activeSessionId: persistedActiveId,
    isLoading,
    saveSession,
    updateSessionBackendId,
    removeSession: removePersistedSession,
  } = useSessionPersistence();

  // Get active session index
  const activeSessionIndex = useMemo(() => {
    if (!activeSessionId) return 0;
    return sessions.findIndex((s) => s.id === activeSessionId);
  }, [sessions, activeSessionId]);

  // Notify parent of session data changes
  useEffect(() => {
    onSessionDataUpdate?.({
      sessions: sessions.map((s) => ({ id: s.id, name: s.name })),
      activeSessionId,
    });
  }, [sessions, activeSessionId, onSessionDataUpdate]);

  // 尝试为单个 session 恢复或创建 session
  const restoreOrCreateSession = useCallback(async (session: typeof persistedSessions[0]): Promise<TerminalSession> => {
    const { sessionId, name, backendSessionId } = session;

    // 如果有 backendSessionId，尝试重连
    if (backendSessionId) {
      try {
        const reconnected = await reconnectTerminalSession(backendSessionId);
        console.log('[Session] Reconnected to existing session:', {
          backendSessionId,
          frontendSessionId: sessionId,
          reconnectedSessionId: reconnected.sessionId,
          cwd: reconnected.cwd,
          backend: reconnected.backend,
          clients: reconnected.clients,
          historyLength: reconnected.history?.length ?? 0,
        });
        return {
          id: sessionId,
          name,
          sessionId: reconnected.sessionId,
          history: reconnected.history,
        };
      } catch {
        console.log('[Session] Reconnect failed, creating new session:', backendSessionId);
      }
    }

    // 创建新 session（服务端会自动使用 home 目录）
    const newSession = await createTerminalSession({});
    console.log('[Session] Created new session:', newSession.sessionId);

    return {
      id: sessionId,
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
        console.log('[Session] Restored sessions:', sessions.length);
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
              history: session.history,
            });
            console.log('[Session] Updated store for frontend session:', {
              frontendId: session.id,
              backendId: session.sessionId,
              hasHistory: !!(session.history?.length),
              historyLength: session.history?.length ?? 0,
            });
          }
        });
      }).catch((error) => {
        console.error('[Session] Failed to restore sessions:', error);
        // 即使失败也继续，使用空的 session
        const fallbackSessions = persistedSessions.map((session) => ({
          id: session.sessionId,
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

  // Handle new session creation from custom event
  const handleNewSession = useCallback(async () => {
    try {
      // 服务端会自动使用 home 目录，不需要客户端传递
      const newTerminalSession = await createTerminalSession({});
      const sessionId = uuidv4();
      const name = generateSessionName();

      const newSession: TerminalSession = {
        id: sessionId,
        name,
        sessionId: newTerminalSession.sessionId,
      };

      setSessions((prev) => {
        const updated = [...prev, newSession];
        return updated;
      });

      setActiveSessionId(sessionId);

      // Persist the new session
      saveSession({ sessionId, name }, newTerminalSession.sessionId);

      // Update useTerminalStore with the new backend session
      const store = useTerminalStore.getState();
      if (newTerminalSession.sessionId) {
        store.setTerminalSession(sessionId, {
          sessionId: newTerminalSession.sessionId,
          cols: 80,
          rows: 24,
        });
      }

      console.log('[Session] Created new session:', sessionId, newTerminalSession.sessionId);
    } catch (error) {
      console.error('[Session] Failed to create new session:', error);
    }
  }, [saveSession]);

  // Handle session switching from custom event
  const handleSwitchSession = useCallback((sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    if (session) {
      setActiveSessionId(sessionId);
      console.log('[Session] Switched to session:', sessionId);
    }
  }, [sessions]);

  // Handle session closing from custom event
  const handleCloseSession = useCallback(async (sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;

    try {
      // Close the backend terminal session if it exists
      if (session.sessionId) {
        await closeTerminal(session.sessionId);
        console.log('[Session] Closed backend terminal:', session.sessionId);
      }
    } catch (error) {
      console.error('[Session] Failed to close backend terminal:', error);
    }

    // Remove from local state
    setSessions(prev => {
      const updated = prev.filter(s => s.id !== sessionId);
      const newActiveId = updated.length > 0 ? updated[0].id : null;
      setActiveSessionId(newActiveId);
      return updated;
    });

    // Remove from persistence
    removePersistedSession(sessionId);

    console.log('[Session] Closed session:', sessionId);
  }, [sessions, removePersistedSession]);

  // Set up event listeners for session management
  useEffect(() => {
    const handleNewSessionEvent = () => {
      handleNewSession();
    };

    const handleSwitchSessionEvent = (event: Event) => {
      const customEvent = event as CustomEvent<string>;
      handleSwitchSession(customEvent.detail);
    };

    const handleCloseSessionEvent = (event: Event) => {
      const customEvent = event as CustomEvent<string>;
      handleCloseSession(customEvent.detail);
    };

    window.addEventListener('new-terminal-session', handleNewSessionEvent);
    window.addEventListener('switch-terminal-session', handleSwitchSessionEvent);
    window.addEventListener('close-terminal-session', handleCloseSessionEvent);

    return () => {
      window.removeEventListener('new-terminal-session', handleNewSessionEvent);
      window.removeEventListener('switch-terminal-session', handleSwitchSessionEvent);
      window.removeEventListener('close-terminal-session', handleCloseSessionEvent);
    };
  }, [handleNewSession, handleSwitchSession, handleCloseSession]);

  // 没有会话时创建新的
  useEffect(() => {
    console.log('[Debug] useEffect triggered:', {
      isRestoring,
      sessionsLength: sessions.length,
      sessions: sessions.map(s => ({ id: s.id, name: s.name, sessionId: s.sessionId })),
    });
    
    if (!isRestoring && sessions.length === 0) {
      console.log('[Debug] About to call handleNewSession');
      handleNewSession();
    } else {
      console.log('[Debug] Skipping handleNewSession:', { 
        isRestoring, 
        sessionsLength: sessions.length,
        condition: !isRestoring && sessions.length === 0 
      });
    }
  }, [isRestoring, sessions.length, handleNewSession]);

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
      {/* Session Indicator */}
      <SessionIndicator sessions={sessions} activeIndex={activeSessionIndex} />

      <div className="flex-1 overflow-hidden">
        {activeSession && (
          <TerminalView
            key={activeSession.id}
            sessionId={activeSession.id}
            theme={theme}
            fontFamily={fontFamily}
            fontSize={fontSize}
            showDebug={showDebug}
            onStatusChange={onStatusChange}
          />
        )}
      </div>
    </div>
  );
};
