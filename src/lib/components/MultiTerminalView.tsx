import React, { useEffect, useCallback, useState, useRef, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Swiper, SwiperSlide } from 'swiper/react';
import type { Swiper as SwiperInstance } from 'swiper';
import 'swiper/css';
import { TerminalView } from './views/TerminalView';
import { useSessionPersistence } from '../hooks/useSessionPersistence';
import { attachTerminalSession, listTerminalProcesses, createTerminalSession, closeTerminal, updateTerminalSessionPolicy } from '../terminal/api';
import type { TerminalMode } from '../terminal';
import { useTerminalStore } from '../stores/useTerminalStore';

interface TerminalSession {
  id: string;
  name: string;
  sessionId: string | null;
  mode: TerminalMode;
  tmuxSessionName: string | null;
  keepAliveMs: number | null;
  history?: string[];
}

export interface TerminalSessionInfo {
  id: string;
  name: string;
  mode: TerminalMode;
  tmuxSessionName: string | null;
  keepAliveMs: number | null;
}

interface NewSessionEventDetail {
  keepAliveMs?: number | null;
  mode?: TerminalMode;
  tmuxSessionName?: string;
}

interface UpdateSessionPolicyEventDetail {
  sessionId: string;
  keepAliveMs?: number | null;
}

const DEFAULT_KEEP_ALIVE_MS = 3 * 60 * 60 * 1000;
const SWIPE_ANIMATION_SPEED_MS = 320;

interface MultiTerminalViewProps {
  theme?: 'dark' | 'light' | 'solarized' | 'dracula' | 'nord';
  fontFamily?: string;
  fontSize?: number;
  showDebug?: boolean;
  defaultSessionMode?: TerminalMode;
  defaultTmuxSessionName?: string;
  onStatusChange?: (status: { isConnecting: boolean; isRestarting: boolean; hasError: boolean; sessionId: string | null }) => void;
  onSessionDataUpdate?: (data: { sessions: TerminalSessionInfo[]; activeSessionId: string | null }) => void;
}

let sessionCounter = 1;

function generateSessionName(): string {
  return `terminal-${sessionCounter++}`;
}
function SessionLineIndicator({
  sessionCount,
  activeIndex,
}: {
  sessionCount: number;
  activeIndex: number;
}) {
  if (sessionCount <= 1) {
    return null;
  }

  const safeActiveIndex = Math.max(0, Math.min(activeIndex, sessionCount - 1));
  const segmentWidthPercent = 100 / sessionCount;

  return (
    <div className="px-3 pt-1 pb-0.5 shrink-0">
      <div className="relative h-px overflow-hidden rounded-full bg-border/60">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-primary transition-transform duration-300 ease-out"
          style={{
            width: `${segmentWidthPercent}%`,
            transform: `translateX(${safeActiveIndex * 100}%)`,
          }}
        />
      </div>
    </div>
  );
}

export const MultiTerminalView: React.FC<MultiTerminalViewProps> = ({
  theme = 'dark',
  fontFamily = '"JetBrainsMonoNL Nerd Font", "JetBrains Mono"',
  fontSize = 13,
  showDebug,
  defaultSessionMode = 'shell',
  defaultTmuxSessionName = 'main',
  onStatusChange,
  onSessionDataUpdate,
}) => {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(true);
  const [showRestoreLoader, setShowRestoreLoader] = useState(false);
  const restoredRef = useRef(false);
  const swiperRef = useRef<SwiperInstance | null>(null);
  const keyboardOpenBySessionRef = useRef<Record<string, boolean>>({});
  const [focusTransferRequest, setFocusTransferRequest] = useState<{ sessionId: string; token: number } | null>(null);
  const isTouchSwipeRef = useRef(false);

  const {
    sessions: persistedSessions,
    activeSessionId: persistedActiveId,
    isLoading,
    saveSession,
    setActiveSession,
    updateSessionBackendId,
    updateSessionKeepAliveMs,
    removeSession: removePersistedSession,
  } = useSessionPersistence();

  useEffect(() => {
    if (isLoading || isRestoring) {
      return;
    }
    if (activeSessionId === persistedActiveId) {
      return;
    }
    setActiveSession(activeSessionId);
  }, [activeSessionId, isLoading, isRestoring, persistedActiveId, setActiveSession]);

  // Get active session index
  const activeSessionIndex = useMemo(() => {
    if (sessions.length === 0) {
      return 0;
    }
    if (!activeSessionId) {
      return 0;
    }
    const foundIndex = sessions.findIndex((s) => s.id === activeSessionId);
    return foundIndex >= 0 ? foundIndex : 0;
  }, [sessions, activeSessionId]);

  useEffect(() => {
    if (sessions.length === 0) {
      if (activeSessionId !== null) {
        setActiveSessionId(null);
      }
      return;
    }

    if (!activeSessionId) {
      setActiveSessionId(sessions[0].id);
      return;
    }

    const exists = sessions.some((session) => session.id === activeSessionId);
    if (!exists) {
      setActiveSessionId(sessions[0].id);
    }
  }, [sessions, activeSessionId]);

  const handleKeyboardVisibilityChange = useCallback((sessionId: string, isOpen: boolean) => {
    keyboardOpenBySessionRef.current[sessionId] = isOpen;
  }, []);

  const handleSwiperChange = useCallback((instance: SwiperInstance) => {
    const nextSessionId = sessions[instance.activeIndex]?.id;
    if (!nextSessionId || nextSessionId === activeSessionId) {
      return;
    }

    const shouldTransferFocus =
      isTouchSwipeRef.current &&
      !!activeSessionId &&
      keyboardOpenBySessionRef.current[activeSessionId] === true;

    setActiveSessionId(nextSessionId);
    if (shouldTransferFocus) {
      setFocusTransferRequest({ sessionId: nextSessionId, token: Date.now() });
      return;
    }
    setFocusTransferRequest(null);
  }, [sessions, activeSessionId]);

  useEffect(() => {
    const swiper = swiperRef.current;
    if (!swiper) {
      return;
    }

    if (activeSessionIndex < 0 || activeSessionIndex >= sessions.length) {
      return;
    }

    if (swiper.activeIndex !== activeSessionIndex) {
      swiper.slideTo(activeSessionIndex, SWIPE_ANIMATION_SPEED_MS);
    }
  }, [activeSessionIndex, sessions.length]);

  // Notify parent of session data changes
  useEffect(() => {
    onSessionDataUpdate?.({
      sessions: sessions.map((s) => ({
        id: s.id,
        name: s.name,
        mode: s.mode,
        tmuxSessionName: s.tmuxSessionName,
        keepAliveMs: s.keepAliveMs,
      })),
      activeSessionId,
    });
  }, [sessions, activeSessionId, onSessionDataUpdate]);

  // 尝试为单个 session 恢复或创建 session
  const restoreOrCreateSession = useCallback(async (
    session: typeof persistedSessions[0],
    availableProcessIds: Set<string> | null
  ): Promise<TerminalSession> => {
    const { sessionId, name, backendSessionId } = session;
    const mode: TerminalMode = session.mode === 'tmux' || session.mode === 'shell'
      ? session.mode
      : defaultSessionMode;
    const tmuxSessionName = mode === 'tmux'
      ? (session.tmuxSessionName || defaultTmuxSessionName)
      : null;
    const keepAliveMs = session.keepAliveMs === undefined ? DEFAULT_KEEP_ALIVE_MS : session.keepAliveMs;

    // 如果有 backendSessionId，优先附着到现有持久进程
    if (backendSessionId && (!availableProcessIds || availableProcessIds.has(backendSessionId))) {
      try {
        const attached = await attachTerminalSession(backendSessionId);
        console.log('[Session] Attached to existing session:', {
          backendSessionId,
          frontendSessionId: sessionId,
          attachedSessionId: attached.sessionId,
          cwd: attached.cwd,
          backend: attached.backend,
          clients: attached.clients,
          historyLength: attached.history?.length ?? 0,
        });
        return {
          id: sessionId,
          name,
          sessionId: attached.sessionId,
          mode: attached.mode ?? mode,
          tmuxSessionName: attached.tmuxSessionName ?? tmuxSessionName,
          keepAliveMs: attached.keepAliveMs,
          history: attached.history,
        };
      } catch {
        console.log('[Session] Attach failed, creating new session:', backendSessionId);
      }
    }

    // 创建新 session（服务端会自动使用 home 目录）
    const newSession = await createTerminalSession({
      keepAliveMs,
      mode,
      tmuxSessionName: tmuxSessionName ?? undefined,
    });
    console.log('[Session] Created new session:', newSession.sessionId);

    return {
      id: sessionId,
      name,
      sessionId: newSession.sessionId,
      mode: newSession.mode ?? mode,
      tmuxSessionName: newSession.tmuxSessionName ?? tmuxSessionName,
      keepAliveMs,
    };
  }, [defaultSessionMode, defaultTmuxSessionName]);

  // 恢复会话（尝试复用现有 session）- 只执行一次
  useEffect(() => {
    if (isLoading) return;
    if (restoredRef.current) return;  // 防止重复执行
    restoredRef.current = true;

    console.log('[Session] Restoring', persistedSessions.length, 'persisted sessions');

    const restore = async () => {
      try {
        let availableProcessIds: Set<string> | null = null;
        let orphanBackendIds: string[] = [];

        try {
          const processInfo = await listTerminalProcesses();
          availableProcessIds = new Set(processInfo.processes.map((process) => process.sessionId));

          const knownBackendIds = new Set(
            persistedSessions
              .map((session) => session.backendSessionId)
              .filter((id): id is string => !!id)
          );

          orphanBackendIds = processInfo.processes
            .filter((process) => process.isOrphan && !knownBackendIds.has(process.sessionId))
            .map((process) => process.sessionId);

          console.log('[Session] Process snapshot:', {
            total: processInfo.processes.length,
            orphanCandidates: orphanBackendIds.length,
          });
        } catch (error) {
          console.warn('[Session] Failed to list terminal processes, fallback to persisted session mapping only:', error);
        }

        const restoredPersisted = await Promise.all(
          persistedSessions.map(async (session) => restoreOrCreateSession(session, availableProcessIds))
        );

        const adoptedSessions = await Promise.all(
          orphanBackendIds.map(async (backendSessionId) => {
            try {
              const attached = await attachTerminalSession(backendSessionId);
              const frontendSessionId = uuidv4();
              const name = generateSessionName();
              saveSession({
                sessionId: frontendSessionId,
                name,
                mode: attached.mode ?? 'shell',
                tmuxSessionName: attached.tmuxSessionName ?? null,
                keepAliveMs: attached.keepAliveMs,
              }, attached.sessionId);
              return {
                id: frontendSessionId,
                name,
                sessionId: attached.sessionId,
                mode: attached.mode ?? 'shell',
                tmuxSessionName: attached.tmuxSessionName ?? null,
                keepAliveMs: attached.keepAliveMs,
                history: attached.history,
              } as TerminalSession;
            } catch {
              return null;
            }
          })
        );

        const restored = [...restoredPersisted, ...adoptedSessions.filter((s): s is TerminalSession => s !== null)];

        console.log('[Session] Restored sessions:', restored.length);
        setSessions(restored);
        setActiveSessionId(persistedActiveId || restored[0]?.id || null);

        const store = useTerminalStore.getState();
        restored.forEach((session) => {
          if (session.sessionId) {
            updateSessionBackendId(session.id, session.sessionId);
            updateSessionKeepAliveMs(session.id, session.keepAliveMs);
            store.setTerminalSession(session.id, {
              sessionId: session.sessionId,
              cols: 80,
              rows: 24,
              mode: session.mode,
              tmuxSessionName: session.tmuxSessionName,
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
      } catch (error) {
        console.error('[Session] Failed to restore sessions:', error);
        const fallbackSessions = persistedSessions.map((session) => ({
          id: session.sessionId,
          name: session.name,
          sessionId: null as string | null,
          mode: session.mode === 'tmux' || session.mode === 'shell' ? session.mode : defaultSessionMode,
          tmuxSessionName: session.tmuxSessionName ?? null,
          keepAliveMs: session.keepAliveMs === undefined ? DEFAULT_KEEP_ALIVE_MS : session.keepAliveMs,
        }));
        setSessions(fallbackSessions);
        setActiveSessionId(persistedActiveId || fallbackSessions[0]?.id || null);
      } finally {
        setIsRestoring(false);
      }
    };

    void restore();
  }, [isLoading, persistedSessions, persistedActiveId, restoreOrCreateSession, updateSessionBackendId, updateSessionKeepAliveMs, defaultSessionMode]);

  // Handle new session creation from custom event
  const handleNewSession = useCallback(async (options?: NewSessionEventDetail) => {
    try {
      const keepAliveMs = options && Object.prototype.hasOwnProperty.call(options, 'keepAliveMs')
        ? (options.keepAliveMs ?? null)
        : DEFAULT_KEEP_ALIVE_MS;
      const mode: TerminalMode = options?.mode === 'tmux' || options?.mode === 'shell'
        ? options.mode
        : defaultSessionMode;
      const tmuxSessionName = mode === 'tmux'
        ? (options?.tmuxSessionName?.trim() || defaultTmuxSessionName)
        : null;
      // 服务端会自动使用 home 目录，不需要客户端传递
      const newTerminalSession = await createTerminalSession({
        keepAliveMs,
        mode,
        tmuxSessionName: tmuxSessionName ?? undefined,
      });
      const sessionId = uuidv4();
      const name = generateSessionName();

      const newSession: TerminalSession = {
        id: sessionId,
        name,
        sessionId: newTerminalSession.sessionId,
        mode: newTerminalSession.mode ?? mode,
        tmuxSessionName: newTerminalSession.tmuxSessionName ?? tmuxSessionName,
        keepAliveMs: newTerminalSession.keepAliveMs ?? keepAliveMs,
      };

      setSessions((prev) => {
        const updated = [...prev, newSession];
        return updated;
      });

      setActiveSessionId(sessionId);

      // Persist the new session
      saveSession({
        sessionId,
        name,
        mode: newSession.mode,
        tmuxSessionName: newSession.tmuxSessionName,
        keepAliveMs: newSession.keepAliveMs,
      }, newTerminalSession.sessionId);

      // Update useTerminalStore with the new backend session
      const store = useTerminalStore.getState();
      if (newTerminalSession.sessionId) {
        store.setTerminalSession(sessionId, {
          sessionId: newTerminalSession.sessionId,
          cols: 80,
          rows: 24,
          mode: newSession.mode,
          tmuxSessionName: newSession.tmuxSessionName,
        });
      }

      console.log('[Session] Created new session:', sessionId, newTerminalSession.sessionId, 'keepAliveMs=', newSession.keepAliveMs);
    } catch (error) {
      console.error('[Session] Failed to create new session:', error);
    }
  }, [defaultSessionMode, defaultTmuxSessionName, saveSession]);

  const handleUpdateSessionPolicy = useCallback(async (detail: UpdateSessionPolicyEventDetail) => {
    const target = sessions.find((session) => session.id === detail.sessionId);
    if (!target?.sessionId) {
      return;
    }

    const keepAliveMs = Object.prototype.hasOwnProperty.call(detail, 'keepAliveMs')
      ? (detail.keepAliveMs ?? null)
      : target.keepAliveMs;

    try {
      const updated = await updateTerminalSessionPolicy(target.sessionId, { keepAliveMs });
      setSessions((prev) => prev.map((session) => (
        session.id === detail.sessionId
          ? { ...session, keepAliveMs: updated.keepAliveMs }
          : session
      )));
      updateSessionKeepAliveMs(detail.sessionId, updated.keepAliveMs);
      console.log('[Session] Updated policy:', detail.sessionId, updated.keepAliveMs);
    } catch (error) {
      console.error('[Session] Failed to update session policy:', error);
    }
  }, [sessions, updateSessionKeepAliveMs]);

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
    delete keyboardOpenBySessionRef.current[sessionId];

    console.log('[Session] Closed session:', sessionId);
  }, [sessions, removePersistedSession]);

  // Set up event listeners for session management
  useEffect(() => {
    const handleNewSessionEvent = (event: Event) => {
      const customEvent = event as CustomEvent<NewSessionEventDetail | undefined>;
      handleNewSession(customEvent.detail);
    };

    const handleSwitchSessionEvent = (event: Event) => {
      const customEvent = event as CustomEvent<string>;
      handleSwitchSession(customEvent.detail);
    };

    const handleCloseSessionEvent = (event: Event) => {
      const customEvent = event as CustomEvent<string>;
      handleCloseSession(customEvent.detail);
    };

    const handleUpdateSessionPolicyEvent = (event: Event) => {
      const customEvent = event as CustomEvent<UpdateSessionPolicyEventDetail>;
      if (!customEvent.detail?.sessionId) {
        return;
      }
      void handleUpdateSessionPolicy(customEvent.detail);
    };

    window.addEventListener('new-terminal-session', handleNewSessionEvent);
    window.addEventListener('switch-terminal-session', handleSwitchSessionEvent);
    window.addEventListener('close-terminal-session', handleCloseSessionEvent);
    window.addEventListener('update-terminal-session-policy', handleUpdateSessionPolicyEvent);

    return () => {
      window.removeEventListener('new-terminal-session', handleNewSessionEvent);
      window.removeEventListener('switch-terminal-session', handleSwitchSessionEvent);
      window.removeEventListener('close-terminal-session', handleCloseSessionEvent);
      window.removeEventListener('update-terminal-session-policy', handleUpdateSessionPolicyEvent);
    };
  }, [handleNewSession, handleSwitchSession, handleCloseSession, handleUpdateSessionPolicy]);

  // 没有会话时创建新的
  useEffect(() => {
    if (!isRestoring && sessions.length === 0) {
      handleNewSession();
    }
  }, [isRestoring, sessions.length, handleNewSession]);

  useEffect(() => {
    if (!isRestoring) {
      setShowRestoreLoader(false);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setShowRestoreLoader(true);
    }, 260);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isRestoring]);

  if (isRestoring) {
    if (!showRestoreLoader) {
      return <div className="h-full bg-background" />;
    }

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
      <SessionLineIndicator sessionCount={sessions.length} activeIndex={activeSessionIndex} />

      <div className="flex-1 overflow-hidden">
        <Swiper
          onSwiper={(instance) => {
            swiperRef.current = instance;
          }}
          onSlideChange={handleSwiperChange}
          onTouchStart={() => {
            isTouchSwipeRef.current = true;
          }}
          onTouchEnd={() => {
            const swiper = swiperRef.current;
            if (!swiper || !swiper.animating) {
              isTouchSwipeRef.current = false;
            }
          }}
          onTransitionEnd={() => {
            isTouchSwipeRef.current = false;
          }}
          initialSlide={Math.max(0, activeSessionIndex)}
          speed={SWIPE_ANIMATION_SPEED_MS}
          slidesPerView={1}
          resistanceRatio={0.82}
          threshold={8}
          longSwipesRatio={0.2}
          touchAngle={30}
          touchStartPreventDefault={false}
          noSwiping
          noSwipingSelector="[data-mobile-keyboard='true']"
          allowTouchMove={sessions.length > 1}
          className="h-full"
        >
          {sessions.map((session, index) => {
            const isNearActive = Math.abs(index - activeSessionIndex) <= 1;
            return (
              <SwiperSlide key={session.id} className="h-full">
                {isNearActive ? (
                  <TerminalView
                    sessionId={session.id}
                    theme={theme}
                    fontFamily={fontFamily}
                    fontSize={fontSize}
                    isActive={index === activeSessionIndex}
                    focusRequestToken={focusTransferRequest?.sessionId === session.id ? focusTransferRequest.token : 0}
                    onKeyboardVisibilityChange={handleKeyboardVisibilityChange}
                    showDebug={showDebug}
                    onStatusChange={index === activeSessionIndex ? onStatusChange : undefined}
                  />
                ) : (
                  <div className="h-full bg-background" />
                )}
              </SwiperSlide>
            );
          })}
        </Swiper>
      </div>
    </div>
  );
};
