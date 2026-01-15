import React, { useEffect, useCallback, useState, useRef, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  rectSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TerminalView } from './views/TerminalView';
import { useSessionPersistence } from '../hooks/useSessionPersistence';
import { reconnectTerminalSession, createTerminalSession, closeTerminal } from '../terminal/api';
import { useTerminalStore } from '../stores/useTerminalStore';
import { RiTerminalBoxLine, RiDraggable } from '@remixicon/react';

interface TerminalSession {
  id: string;
  cwd: string;
  name: string;
  sessionId: string | null;
  history?: string[];
}

export interface TerminalSessionInfo {
  id: string;
  cwd: string;
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

// Sortable Session Item Component
function SortableSessionItem({
  session,
  isActive,
  onClick,
  onClose,
}: {
  session: TerminalSession;
  isActive: boolean;
  onClick: () => void;
  onClose: (e: React.MouseEvent) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: session.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative flex items-center gap-2 p-3 rounded-lg border cursor-pointer transition-all ${
        isActive
          ? 'bg-primary/15 border-primary/30'
          : 'bg-surface-elevated hover:bg-surface-elevated/80 border-border/50'
      }`}
      onClick={onClick}
    >
      {/* Drag Handle */}
      <div
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing p-1 rounded hover:bg-muted"
        onClick={(e) => e.stopPropagation()}
      >
        <RiDraggable className="w-4 h-4 text-muted-foreground" />
      </div>

      <RiTerminalBoxLine
        className={`w-4 h-4 ${isActive ? 'text-primary' : 'text-muted-foreground'}`}
      />
      <span className={`flex-1 truncate text-sm ${isActive ? 'text-primary' : ''}`}>
        {session.name}
      </span>
      <span className="text-xs text-muted-foreground truncate max-w-[80px]">
        {session.cwd.replace(/^\/home\/[^/]+/, '~')}
      </span>
      <button
        type="button"
        onClick={onClose}
        className="p-1 rounded hover:bg-red-500/20 hover:text-red-500"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

// Session Indicator Component
function SessionIndicator({
  sessions,
  activeIndex,
}: {
  sessions: TerminalSession[];
  activeIndex: number;
}) {
  if (sessions.length <= 1) return null;

  return (
    <div className="fixed top-3 left-1/2 -translate-x-1/2 z-20">
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
  fontFamily = 'Menlo, Monaco, Consolas, monospace',
  fontSize = 13,
  showDebug,
  onStatusChange,
  onSessionDataUpdate,
}) => {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(true);
  const [isSortMode, setIsSortMode] = useState(false);
  const restoredRef = useRef(false);

  // Touch gesture state
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const LONG_PRESS_DURATION = 500;
  const SWIPE_THRESHOLD = 50;
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isLongPressRef = useRef(false);

  const {
    sessions: persistedSessions,
    activeSessionId: persistedActiveId,
    isLoading,
    saveSession,
    updateSessionBackendId,
    removeSession: removePersistedSession,
  } = useSessionPersistence();

  // Setup dnd-kit sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Get active session index
  const activeSessionIndex = useMemo(() => {
    if (!activeSessionId) return 0;
    return sessions.findIndex((s) => s.id === activeSessionId);
  }, [sessions, activeSessionId]);

  // Notify parent of session data changes
  useEffect(() => {
    onSessionDataUpdate?.({
      sessions: sessions.map((s) => ({ id: s.id, cwd: s.cwd, name: s.name })),
      activeSessionId,
    });
  }, [sessions, activeSessionId, onSessionDataUpdate]);

  // 尝试为单个 session 恢复或创建 session
  const restoreOrCreateSession = useCallback(async (session: typeof persistedSessions[0]): Promise<TerminalSession> => {
    const { sessionId, cwd, name, backendSessionId } = session;

    // 如果有 backendSessionId，尝试重连
    if (backendSessionId) {
      try {
        const reconnected = await reconnectTerminalSession(backendSessionId);
        console.log('[Session] Reconnected to existing session:', backendSessionId);
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
            }, session.cwd);
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

  // Handle new session creation from custom event
  const handleNewSession = useCallback(async () => {
    try {
      // 服务端会自动使用 home 目录，不需要客户端传递
      const newTerminalSession = await createTerminalSession({});
      const sessionId = uuidv4();
      const name = generateSessionName();

      const newSession: TerminalSession = {
        id: sessionId,
        cwd: '/',  // 服务端实际使用的目录会不同，但前端显示不需要精确
        name,
        sessionId: newTerminalSession.sessionId,
      };

      setSessions((prev) => {
        const updated = [...prev, newSession];
        return updated;
      });

      setActiveSessionId(sessionId);

      // Persist the new session
      saveSession({ sessionId, cwd: '/', name }, newTerminalSession.sessionId);

      // Update useTerminalStore with the new backend session
      const store = useTerminalStore.getState();
      if (newTerminalSession.sessionId) {
        store.setTerminalSession(sessionId, {
          sessionId: newTerminalSession.sessionId,
          cols: 80,
          rows: 24,
        }, '/');
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

  // Internal switch session function
  const switchToSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
  }, []);

  // Internal close session function (for sort mode)
  const closeSessionInternal = useCallback(async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await handleCloseSession(sessionId);
  }, [handleCloseSession]);

  // Drag end handler for reordering
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      setSessions((items) => {
        const oldIndex = items.findIndex((item) => item.id === active.id);
        const newIndex = items.findIndex((item) => item.id === over.id);
        const newOrder = arrayMove(items, oldIndex, newIndex);

        // Update active session if needed
        if (activeSessionId && !newOrder.find(s => s.id === activeSessionId)) {
          setActiveSessionId(newOrder[0]?.id || null);
        }

        return newOrder;
      });
    }
  }, [activeSessionId]);

  // Touch event handlers for swipe and long press
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    touchStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      time: Date.now(),
    };
    isLongPressRef.current = false;

    // Start long press timer
    longPressTimerRef.current = setTimeout(() => {
      if (touchStartRef.current) {
        isLongPressRef.current = true;
        setIsSortMode(true);
      }
    }, LONG_PRESS_DURATION);
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStartRef.current) return;

    const touch = e.touches[0];
    const deltaX = touch.clientX - touchStartRef.current.x;
    const deltaY = touch.clientY - touchStartRef.current.y;
    const deltaTime = Date.now() - touchStartRef.current.time;

    // Cancel long press if moved significantly
    if (Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10) {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    }

    // Handle horizontal swipe
    if (deltaTime < 300 && Math.abs(deltaX) > SWIPE_THRESHOLD) {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }

      const currentIndex = sessions.findIndex(s => s.id === activeSessionId);
      if (currentIndex === -1) return;

      if (deltaX > 0) {
        // Swipe right - go to previous session
        const newIndex = Math.max(0, currentIndex - 1);
        switchToSession(sessions[newIndex].id);
      } else {
        // Swipe left - go to next session
        const newIndex = Math.min(sessions.length - 1, currentIndex + 1);
        switchToSession(sessions[newIndex].id);
      }

      touchStartRef.current = null;
    }
  }, [sessions, activeSessionId, switchToSession]);

  const handleTouchEnd = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    touchStartRef.current = null;
  }, []);

  // Exit sort mode
  const exitSortMode = useCallback(() => {
    setIsSortMode(false);
  }, []);

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
    <div
      className="h-full flex flex-col touch-none"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Session Indicator */}
      <SessionIndicator sessions={sessions} activeIndex={activeSessionIndex} />

      {/* Sort Mode Overlay */}
      {isSortMode && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm animate-fade-in"
          onClick={exitSortMode}
          onContextMenu={(e) => e.preventDefault()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-surface/95 border-b border-border">
            <span className="text-sm font-medium">Long press to exit</span>
            <span className="text-xs text-muted-foreground">
              Drag to reorder ({sessions.length} sessions)
            </span>
          </div>

          {/* Sortable List */}
          <div className="p-4 space-y-2 overflow-y-auto max-h-[calc(100vh-120px)]">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={sessions.map((s) => s.id)} strategy={rectSortingStrategy}>
                {sessions.map((session) => (
                  <SortableSessionItem
                    key={session.id}
                    session={session}
                    isActive={session.id === activeSessionId}
                    onClick={() => {
                      switchToSession(session.id);
                      exitSortMode();
                    }}
                    onClose={(e) => closeSessionInternal(session.id, e)}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </div>

          {/* Exit Hint */}
          <div className="fixed bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/60 to-transparent pointer-events-none">
            <div className="text-center text-xs text-muted-foreground">
              Tap outside or long press to exit
            </div>
          </div>
        </div>
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
    </div>
  );
};
