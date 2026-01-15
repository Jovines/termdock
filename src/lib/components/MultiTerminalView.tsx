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
    tabs: persistedTabs,
    activeTabId: persistedActiveId,
    isLoading,
    saveTab,
    removeTab,
    setActiveTab,
    updateTabSessionId,
  } = useSessionPersistence();

  // 尝试为单个 tab 恢复或创建 session
  const restoreOrCreateSession = useCallback(async (tab: typeof persistedTabs[0]): Promise<TerminalSession> => {
    const { tabId, cwd, name, sessionId } = tab;

    // 如果有 sessionId，尝试重连
    if (sessionId) {
      try {
        const reconnected = await reconnectTerminalSession(sessionId);
        console.log('[Session] Reconnected to existing session:', sessionId, 'history chunks:', reconnected.history?.length);
        return {
          id: tabId,
          cwd: reconnected.cwd,
          name,
          sessionId: reconnected.sessionId,
          history: reconnected.history,
        };
      } catch {
        console.log('[Session] Reconnect failed, creating new session:', sessionId);
      }
    }

    // 创建新 session
    const newSession = await createTerminalSession({ cwd });
    console.log('[Session] Created new session:', newSession.sessionId);

    return {
      id: tabId,
      cwd,
      name,
      sessionId: newSession.sessionId,
    };
  }, []);

  // 恢复标签页（尝试复用现有 session）- 只执行一次
  useEffect(() => {
    if (isLoading) return;
    if (restoredRef.current) return;  // 防止重复执行
    restoredRef.current = true;

    console.log('[Session] Restoring', persistedTabs.length, 'persisted tabs');

    if (persistedTabs.length > 0) {
      // 并行恢复所有 session
      Promise.all(persistedTabs.map(async (tab) => {
        const session = await restoreOrCreateSession(tab);
        return session;
      })).then((sessions) => {
        console.log('[Session] Restored sessions:', sessions.map(s => ({ id: s.id, cwd: s.cwd, sessionId: s.sessionId })));
        setSessions(sessions);
        setActiveSessionId(persistedActiveId || sessions[0]?.id || null);
        setIsRestoring(false);

        // Update localStorage and useTerminalStore
        const store = useTerminalStore.getState();
        sessions.forEach(session => {
          if (session.sessionId) {
            updateTabSessionId(session.id, session.sessionId);
            store.setTerminalSession(session.cwd, {
              sessionId: session.sessionId,
              cols: 80,
              rows: 24,
            });
            // 存储历史数据
            if (session.history && session.history.length > 0) {
              store.setSessionHistory(session.cwd, session.history);
              console.log('[Session] Stored history for cwd:', session.cwd, 'chunks:', session.history.length);
            }
            console.log('[Session] Updated useTerminalStore for cwd:', session.cwd, 'sessionId:', session.sessionId);
          }
        });
      }).catch((error) => {
        console.error('[Session] Failed to restore sessions:', error);
        // 即使失败也继续，使用空的 session
        const fallbackSessions = persistedTabs.map((tab) => ({
          id: tab.tabId,
          cwd: tab.cwd,
          name: tab.name,
          sessionId: null as string | null,
        }));
        setSessions(fallbackSessions);
        setActiveSessionId(persistedActiveId || fallbackSessions[0]?.id || null);
        setIsRestoring(false);
      });

      return;
    }

    console.log('[Session] No persisted tabs');
    setIsRestoring(false);
  }, [isLoading, persistedTabs, persistedActiveId, restoreOrCreateSession, updateTabSessionId]);

  // 创建新标签页
  const createSession = useCallback(async (cwd: string) => {
    const tabId = uuidv4();
    const name = generateSessionName();

    // 创建新 session
    const newTerminalSession = await createTerminalSession({ cwd });

    const newSession: TerminalSession = {
      id: tabId,
      cwd,
      name,
      sessionId: newTerminalSession.sessionId,
    };

    setSessions((prev) => {
      const updated = [...prev, newSession];
      return updated;
    });

    setActiveSessionId(tabId);

    // 持久化标签页
    saveTab({ tabId, cwd, name }, newTerminalSession.sessionId);

    return { tabId, sessionId: newTerminalSession.sessionId };
  }, [saveTab]);

  // 关闭标签页
  const closeSession = useCallback((tabId: string) => {
    setSessions((prev) => {
      const filtered = prev.filter((s) => s.id !== tabId);
      setActiveSessionId((currentId) => {
        if (currentId === tabId) {
          return filtered.length > 0 ? filtered[0].id : null;
        }
        return currentId;
      });
      return filtered;
    });

    // 移除持久化
    removeTab(tabId);
  }, [removeTab]);

  // 切换标签页
  const switchSession = useCallback((tabId: string) => {
    setActiveSessionId(tabId);
    setActiveTab(tabId);
  }, [setActiveTab]);

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
