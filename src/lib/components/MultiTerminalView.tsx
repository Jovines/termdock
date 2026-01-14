import React, { useEffect, useCallback, useState } from 'react';
import { TerminalView } from './views/TerminalView';
import { SessionTabs } from './session/SessionTabs';
import { useSessionPersistence } from '../hooks/useSessionPersistence';

interface TerminalSession {
  id: string;
  cwd: string;
  name: string;
}

interface MultiTerminalViewProps {
  defaultCwd?: string;
  theme?: 'dark' | 'light' | 'solarized' | 'dracula' | 'nord';
  fontFamily?: string;
  fontSize?: number;
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
}) => {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(true);

  const {
    tabs: persistedTabs,
    activeTabId: persistedActiveId,
    isLoading,
    saveTab,
    removeTab,
    setActiveTab,
  } = useSessionPersistence();

  // 恢复标签页（不包含后端sessionId）
  useEffect(() => {
    if (isLoading) return;

    console.log('[Session] Restoring', persistedTabs.length, 'persisted tabs');

    if (persistedTabs.length > 0) {
      const restoredSessions = persistedTabs.map((tab) => ({
        id: tab.tabId, // 使用前端tabId作为会话标识
        cwd: tab.cwd,
        name: tab.name,
      }));

      console.log('[Session] Restored sessions:', restoredSessions.map(s => ({ id: s.id, cwd: s.cwd })));

      setSessions(restoredSessions);
      setActiveSessionId(persistedActiveId || restoredSessions[0].id);
      setIsRestoring(false);
      return;
    }

    console.log('[Session] No persisted tabs');
    setIsRestoring(false);
  }, [isLoading, persistedTabs, persistedActiveId]);

  // 创建新标签页
  const createSession = useCallback((cwd: string) => {
    const tabId = crypto.randomUUID();
    const name = generateSessionName();
    const newSession = { id: tabId, cwd, name };

    setSessions((prev) => {
      const updated = [...prev, newSession];
      return updated;
    });

    setActiveSessionId(tabId);

    // 持久化标签页（不包含后端sessionId）
    saveTab({ tabId, cwd, name });

    return tabId;
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
      <SessionTabs
        sessions={sessions}
        activeSessionId={activeSessionId}
        onNewSession={() => createSession(defaultCwd)}
        onSwitchSession={switchSession}
        onCloseSession={closeSession}
      />

      <div className="flex-1 overflow-hidden">
        {activeSession && (
          <TerminalView
            key={activeSession.id}
            cwd={activeSession.cwd}
            theme={theme}
            fontFamily={fontFamily}
            fontSize={fontSize}
          />
        )}
      </div>
    </div>
  );
};
