import React, { useEffect, useCallback, useState, useRef, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Swiper, SwiperSlide } from 'swiper/react';
import type { Swiper as SwiperInstance } from 'swiper';
import 'swiper/css';
import { TerminalView } from './views/TerminalView';
import { useSessionPersistence } from '../hooks/useSessionPersistence';
import { attachTerminalSession, listTerminalProcesses, createTerminalSession, closeTerminal, updateTerminalSessionPolicy } from '../terminal/api';
import type { TerminalMode } from '../terminal';
import type { TerminalRendererMode } from '../terminal/renderer';
import { useTerminalStore } from '../stores/useTerminalStore';
import { createDebugLogger } from '../utils/debug';
import type { ToolbarPresetDefinition } from './terminal/mobileKeyboardPresets';

interface TerminalSession {
  id: string;
  name: string;
  customName: boolean;
  sessionId: string | null;
  mode: TerminalMode;
  tmuxSessionName: string | null;
  keepAliveMs: number | null;
  history?: string[];
}

export interface TerminalSessionInfo {
  id: string;
  name: string;
  customName: boolean;
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
  fontFamily?: string;
  fontSize?: number;
  rendererMode?: TerminalRendererMode;
  toolbarPresets?: ToolbarPresetDefinition[];
  showDebug?: boolean;
  defaultSessionMode?: TerminalMode;
  defaultTmuxSessionName?: string;
  showSessionStrip?: boolean;
  onStatusChange?: (status: { isConnecting: boolean; isRestarting: boolean; hasError: boolean; sessionId: string | null }) => void;
  onSessionDataUpdate?: (data: { sessions: TerminalSessionInfo[]; activeSessionId: string | null }) => void;
}

let sessionCounter = 1;

function generateSessionName(): string {
  return `terminal-${sessionCounter++}`;
}

function generateTmuxSessionName(seed?: string): string {
  const normalizedSeed = (seed || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 12);
  if (normalizedSeed) {
    return `wt-${normalizedSeed}`;
  }
  const timePart = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `wt-${timePart}${randomPart}`;
}

function SessionTabStrip({
  sessions,
  activeSessionId,
  onSelect,
  onRename,
}: {
  sessions: Array<Pick<TerminalSession, 'id' | 'name'>>;
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onRename: (sessionId: string, newName: string) => void;
}) {
  const activeTabRef = React.useRef<HTMLButtonElement | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    activeTabRef.current?.scrollIntoView({
      inline: 'center',
      block: 'nearest',
      behavior: 'smooth',
    });
  }, [activeSessionId]);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.select();
    }
  }, [editingId]);

  const commitRename = useCallback((sessionId: string, value: string) => {
    const trimmed = value.trim();
    if (trimmed) {
      onRename(sessionId, trimmed);
    }
    setEditingId(null);
  }, [onRename]);

  if (sessions.length === 0) {
    return null;
  }

  return (
    <div className="shrink-0 bg-background-2/50 px-1 py-1 sm:px-2">
      <div className="scrollbar-thin flex items-center gap-1 overflow-x-auto overflow-y-hidden whitespace-nowrap">
        {sessions.map((session) => {
          const isActive = session.id === activeSessionId;
          const isEditing = session.id === editingId;

          if (isEditing) {
            return (
              <input
                key={session.id}
                ref={inputRef}
                type="text"
                defaultValue={session.name}
                maxLength={48}
                className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] outline-none bg-background-elevated text-foreground shadow-sm ring-1 ring-primary/50 min-w-[6rem]`}
                style={{ width: `${Math.min(Math.max(session.name.length, 6), 28)}ch` }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    commitRename(session.id, (e.target as HTMLInputElement).value);
                  } else if (e.key === 'Escape') {
                    setEditingId(null);
                  }
                }}
                onBlur={(e) => commitRename(session.id, e.target.value)}
              />
            );
          }

          return (
            <button
              key={session.id}
              ref={isActive ? activeTabRef : null}
              type="button"
              onClick={() => onSelect(session.id)}
              onDoubleClick={() => setEditingId(session.id)}
              className={`shrink-0 truncate rounded-full px-3 py-1.5 text-[11px] transition max-w-[16rem] ${
                isActive
                  ? 'bg-background-elevated text-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-background-elevated/50 hover:text-foreground'
              }`}
              title={session.name}
            >
              {session.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export const MultiTerminalView: React.FC<MultiTerminalViewProps> = ({
  fontFamily = '"JetBrains Mono NL", "Symbols Nerd Font Mono"',
  fontSize = 13,
  rendererMode = 'auto',
  toolbarPresets = [],
  showDebug,
  defaultSessionMode = 'shell',
  defaultTmuxSessionName = '',
  showSessionStrip = true,
  onStatusChange,
  onSessionDataUpdate,
}) => {
  const debugSession = useMemo(() => createDebugLogger('session'), []);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(true);
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
    renameSession,
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
        customName: s.customName,
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
    const configuredDefaultTmuxName = defaultTmuxSessionName.trim();
    const persistedTmuxName = (session.tmuxSessionName || '').trim();
    const tmuxSessionName = mode === 'tmux'
      ? (persistedTmuxName || configuredDefaultTmuxName || generateTmuxSessionName(sessionId))
      : null;
    const keepAliveMs = session.keepAliveMs === undefined ? DEFAULT_KEEP_ALIVE_MS : session.keepAliveMs;

    // 如果有 backendSessionId，优先附着到现有持久进程
    if (backendSessionId && (!availableProcessIds || availableProcessIds.has(backendSessionId))) {
      try {
        const attached = await attachTerminalSession(backendSessionId);
        debugSession('[Session] Attached to existing session:', {
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
          customName: session.customName === true,
          sessionId: attached.sessionId,
          mode: attached.mode ?? mode,
          tmuxSessionName: attached.tmuxSessionName ?? tmuxSessionName,
          keepAliveMs: attached.keepAliveMs,
          history: attached.history,
        };
      } catch {
        debugSession('[Session] Attach failed, creating new session:', backendSessionId);
      }
    }

    // 创建新 session（服务端会自动使用 home 目录）
    const newSession = await createTerminalSession({
      keepAliveMs,
      mode,
      tmuxSessionName: tmuxSessionName ?? undefined,
    });
    debugSession('[Session] Created new session:', newSession.sessionId);

    return {
      id: sessionId,
      name,
      customName: session.customName === true,
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

    debugSession('[Session] Restoring', persistedSessions.length, 'persisted sessions');

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

          debugSession('[Session] Process snapshot:', {
            total: processInfo.processes.length,
            orphanCandidates: orphanBackendIds.length,
          });
        } catch (error) {
          debugSession('[Session] Failed to list terminal processes, fallback to persisted session mapping only:', error);
        }

        const restoredPersisted = await Promise.all(
          persistedSessions.map(async (session) => restoreOrCreateSession(session, availableProcessIds))
        );

        // 收集已恢复的 tmux 会话名，防止 adopted 阶段重复创建
        const restoredTmuxNames = new Set(
          restoredPersisted
            .filter((s) => s.mode === 'tmux' && s.tmuxSessionName)
            .map((s) => s.tmuxSessionName!)
        );

        const adoptedSessions = await Promise.all(
          orphanBackendIds.map(async (backendSessionId) => {
            try {
              const attached = await attachTerminalSession(backendSessionId);

              // 如果已恢复的会话已覆盖此 tmux 会话则跳过，避免 UI 出现重复 tab
              if (
                attached.tmuxSessionName &&
                restoredTmuxNames.has(attached.tmuxSessionName)
              ) {
                return null;
              }

              const frontendSessionId = uuidv4();
              const name = attached.tmuxSessionName
                ? `tmux:${attached.tmuxSessionName}`
                : generateSessionName();
              saveSession({
                sessionId: frontendSessionId,
                name,
                customName: false,
                mode: attached.mode ?? 'shell',
                tmuxSessionName: attached.tmuxSessionName ?? null,
                keepAliveMs: attached.keepAliveMs,
              }, attached.sessionId);
              return {
                id: frontendSessionId,
                name,
                customName: false,
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

        const adopted = adoptedSessions.filter((s): s is TerminalSession => s !== null);
        const adoptedTmuxNames = new Set(
          adopted.filter((s) => s.mode === 'tmux' && s.tmuxSessionName).map((s) => s.tmuxSessionName!)
        );

        // 如果 adopted 中有 tmux 会话，从 restoredPersisted 中剔除同名的旧条目
        const restored = adoptedTmuxNames.size > 0
          ? [...restoredPersisted.filter(
              (s) => !(s.mode === 'tmux' && s.tmuxSessionName && adoptedTmuxNames.has(s.tmuxSessionName))
            ), ...adopted]
          : [...restoredPersisted, ...adopted];

        debugSession('[Session] Restored sessions:', restored.length);
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
            debugSession('[Session] Updated store for frontend session:', {
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
          customName: session.customName === true,
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
  }, [
    isLoading,
    persistedSessions,
    persistedActiveId,
    restoreOrCreateSession,
    updateSessionBackendId,
    updateSessionKeepAliveMs,
    defaultSessionMode,
    debugSession,
  ]);

  // Handle new session creation from custom event
  const handleNewSession = useCallback(async (options?: NewSessionEventDetail) => {
    try {
      const keepAliveMs = options && Object.prototype.hasOwnProperty.call(options, 'keepAliveMs')
        ? (options.keepAliveMs ?? null)
        : DEFAULT_KEEP_ALIVE_MS;
      const mode: TerminalMode = options?.mode === 'tmux' || options?.mode === 'shell'
        ? options.mode
        : defaultSessionMode;
      const requestedTmuxName = (options?.tmuxSessionName || '').trim();
      const configuredDefaultTmuxName = defaultTmuxSessionName.trim();
      const tmuxSessionName = mode === 'tmux'
        ? (requestedTmuxName || configuredDefaultTmuxName || generateTmuxSessionName())
        : null;
      // 服务端会自动使用 home 目录，不需要客户端传递
      const newTerminalSession = await createTerminalSession({
        keepAliveMs,
        mode,
        tmuxSessionName: tmuxSessionName ?? undefined,
      });
      const sessionId = uuidv4();
      const effectiveTmuxSessionName = newTerminalSession.tmuxSessionName ?? tmuxSessionName;
      const name = effectiveTmuxSessionName
        ? `tmux:${effectiveTmuxSessionName}`
        : generateSessionName();

      const newSession: TerminalSession = {
        id: sessionId,
        name,
        customName: false,
        sessionId: newTerminalSession.sessionId,
        mode: newTerminalSession.mode ?? mode,
        tmuxSessionName: effectiveTmuxSessionName,
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
        customName: false,
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

      debugSession('[Session] Created new session:', sessionId, newTerminalSession.sessionId, 'keepAliveMs=', newSession.keepAliveMs);
    } catch (error) {
      console.error('[Session] Failed to create new session:', error);
    }
  }, [defaultSessionMode, defaultTmuxSessionName, saveSession, debugSession]);

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
      debugSession('[Session] Updated policy:', detail.sessionId, updated.keepAliveMs);
    } catch (error) {
      console.error('[Session] Failed to update session policy:', error);
    }
  }, [sessions, updateSessionKeepAliveMs, debugSession]);

  // Handle session switching from custom event
  const handleSwitchSession = useCallback((sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    if (session) {
      setActiveSessionId(sessionId);
      debugSession('[Session] Switched to session:', sessionId);
    }
  }, [sessions, debugSession]);

  // Handle session rename
  const handleRenameSession = useCallback((sessionId: string, newName: string) => {
    if (!newName.trim()) return;
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, name: newName.trim(), customName: true } : s))
    );
    renameSession(sessionId, newName.trim());
  }, [renameSession]);

  // Handle session closing from custom event
  const handleCloseSession = useCallback(async (sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;

    try {
      // Close the backend terminal session if it exists
      if (session.sessionId) {
        await closeTerminal(session.sessionId);
        debugSession('[Session] Closed backend terminal:', session.sessionId);
      }
    } catch (error) {
      console.error('[Session] Failed to close backend terminal:', error);
      return;
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

    debugSession('[Session] Closed session:', sessionId);
  }, [sessions, removePersistedSession, debugSession]);

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

    const handleRenameSessionEvent = (event: Event) => {
      const customEvent = event as CustomEvent<{ sessionId: string; name: string }>;
      if (!customEvent.detail?.sessionId || !customEvent.detail?.name) {
        return;
      }
      handleRenameSession(customEvent.detail.sessionId, customEvent.detail.name);
    };

    window.addEventListener('new-terminal-session', handleNewSessionEvent);
    window.addEventListener('switch-terminal-session', handleSwitchSessionEvent);
    window.addEventListener('close-terminal-session', handleCloseSessionEvent);
    window.addEventListener('update-terminal-session-policy', handleUpdateSessionPolicyEvent);
    window.addEventListener('rename-terminal-session', handleRenameSessionEvent);

    return () => {
      window.removeEventListener('new-terminal-session', handleNewSessionEvent);
      window.removeEventListener('switch-terminal-session', handleSwitchSessionEvent);
      window.removeEventListener('close-terminal-session', handleCloseSessionEvent);
      window.removeEventListener('update-terminal-session-policy', handleUpdateSessionPolicyEvent);
      window.removeEventListener('rename-terminal-session', handleRenameSessionEvent);
    };
  }, [handleNewSession, handleSwitchSession, handleCloseSession, handleUpdateSessionPolicy, handleRenameSession]);

  // 没有会话时创建新的
  useEffect(() => {
    if (!isRestoring && sessions.length === 0) {
      handleNewSession();
    }
  }, [isRestoring, sessions.length, handleNewSession]);

  if (isRestoring) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="rounded-full bg-surface-2 px-4 py-2 flex items-center gap-3 shadow-sm">
          <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
          <span className="text-sm text-muted-foreground">Restoring sessions...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {showSessionStrip && (
        <SessionTabStrip
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelect={handleSwitchSession}
          onRename={handleRenameSession}
        />
      )}

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
          touchAngle={15}
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
                    fontFamily={fontFamily}
                    fontSize={fontSize}
                    rendererMode={rendererMode}
                    toolbarPresets={toolbarPresets}
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
