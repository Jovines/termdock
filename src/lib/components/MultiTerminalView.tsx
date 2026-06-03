import React, { useEffect, useCallback, useState, useRef, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Swiper, SwiperSlide } from 'swiper/react';
import type { Swiper as SwiperInstance } from 'swiper';
import 'swiper/css';
import { TerminalView } from './views/TerminalView';
import { useSessionPersistence, type PersistedSession } from '../hooks/useSessionPersistence';
import { createTerminalSession, closeTerminal } from '../terminal/api';
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
  history?: string[];
}

export interface TerminalSessionInfo {
  id: string;
  name: string;
  customName: boolean;
  mode: TerminalMode;
  tmuxSessionName: string | null;
}

interface NewSessionEventDetail {
  mode?: TerminalMode;
  tmuxSessionName?: string;
  cwd?: string;
}

const SWIPE_ANIMATION_SPEED_MS = 320;

interface MultiTerminalViewProps {
  fontFamily?: string;
  fontSize?: number;
  rendererMode?: TerminalRendererMode;
  toolbarPresets?: ToolbarPresetDefinition[];
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

function generateTmuxSessionName(seed?: string): string {
  const normalizedSeed = (seed || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 12);
  if (normalizedSeed) {
    return `wt-${normalizedSeed}`;
  }
  const timePart = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `wt-${timePart}${randomPart}`;
}

export const MultiTerminalView: React.FC<MultiTerminalViewProps> = ({
  fontFamily = 'var(--font-mono)',
  fontSize = 13,
  rendererMode = 'auto',
  toolbarPresets = [],
  showDebug,
  defaultSessionMode = 'shell',
  defaultTmuxSessionName = '',
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
  const isMobileRef = useRef(false);
  const handleNewSessionRef = useRef<((options?: NewSessionEventDetail) => Promise<void>) | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const check = () => {
      const hasTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
      const isNarrow = window.innerWidth < 768;
      isMobileRef.current = hasTouch && isNarrow;
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  // Listen for gesture-lock events from TerminalViewport to disable Swiper.
  // Directly mutates the Swiper instance so allowTouchMove takes effect
  // synchronously — React state (via prop) is too slow for touch sequences
  // already in flight.
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ locked: boolean }>;
      if (swiperRef.current) {
        swiperRef.current.allowTouchMove = !ce.detail.locked;
      }
    };
    document.addEventListener('termdock:gesture-lock', handler);
    return () => document.removeEventListener('termdock:gesture-lock', handler);
  }, []);

  const {
    sessions: persistedSessions,
    activeSessionId: persistedActiveId,
    isLoading,
    saveSession,
    setActiveSession,
    updateSessionBackendId,
    removeSession: removePersistedSession,
    renameSession,
    resetSessionCustomName,
    reorderSessions,
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

    // Desktop: always transfer focus so typing reaches the new terminal.
    // Mobile: only transfer focus if the soft keyboard was already open,
    // otherwise focusHiddenInput() would pop the keyboard unexpectedly.
    const isKeyboardOpen = !!activeSessionId &&
      keyboardOpenBySessionRef.current[activeSessionId] === true;
    const shouldTransferFocus =
      !isMobileRef.current || isKeyboardOpen;

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

  // 同步 Swiper.allowTouchMove。
  //
  // 之前 MultiTerminalView 一进来就有"Restoring sessions..."全屏 loading，等
  // restore 完才渲染 <Swiper>，所以 onSwiper 回调里那行 `allowTouchMove =
  // sessions.length > 1` 一上来就拿到正确值。
  //
  // 现在我们把全屏 loading 干掉了 → Swiper 第一次 mount 时 sessions=[]
  // → allowTouchMove 被设成 false → 之后 sessions 填进来也没人再更新这个值
  // → 用户左右滑不动。
  //
  // 这里加 useEffect 显式跟随 sessions.length 同步。gesture-lock 事件路径
  // 另算（那是临时禁用），稳态由这条 effect 决定。
  useEffect(() => {
    const swiper = swiperRef.current;
    if (!swiper) return;
    const nextAllow = sessions.length > 1;
    if (swiper.allowTouchMove !== nextAllow) {
      swiper.allowTouchMove = nextAllow;
    }
  }, [sessions.length]);

  // Notify parent of session data changes
  useEffect(() => {
    onSessionDataUpdate?.({
      sessions: sessions.map((s) => ({
        id: s.id,
        name: s.name,
        customName: s.customName,
        mode: s.mode,
        tmuxSessionName: s.tmuxSessionName,
      })),
      activeSessionId,
    });
  }, [sessions, activeSessionId, onSessionDataUpdate]);

  // 尝试为单个 session 恢复或创建 session
  //
  // 重要：有 backendSessionId 时**立即**返回 placeholder，不 await attach。
  // 之前会卡在 attach 的 HTTP RTT（蜂窝网络下 1-3 秒）→ MultiTerminalView 持续显示
  // 全屏 "Restoring sessions..."。手机 PWA 长时间后台后 OS 会把页面踢出内存，
  // 回来时就是冷启动跑这段，于是用户每次都看到 loading。
  //
  // 现在的链路：
  //  1. 这里立刻返回 placeholder（backend ID 用持久化的）→ UI 秒渲染
  //  2. TerminalView 的 ensureSession 自己跑 checkHealth(backendId)
  //     - 健康 → startStream，WS 'connected' 事件里 server 现在会直接补 restore history
  //     - 不健康（server 重启 / idle 清理）→ 创建新 session，复用 Fix 2 的 auto-recreate 路径
  //  3. scrollback 由 WS 'connected' 的 replayChunks 携带，不再需要单独 HTTP /attach
  const restoreOrCreateSession = useCallback(async (
    session: typeof persistedSessions[0],
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

    // 快路径：有 backend ID 时直接返回，不阻塞 UI
    if (backendSessionId) {
      debugSession('[Session] Fast restore (no attach):', {
        backendSessionId,
        frontendSessionId: sessionId,
      });
      return {
        id: sessionId,
        name,
        customName: session.customName === true,
        sessionId: backendSessionId,
        mode,
        tmuxSessionName,
      };
    }

    // 没有 backend ID（首次使用 / 之前 session 被彻底删了）：必须 await 创建
    const newSession = await createTerminalSession({
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
    };
  }, [defaultSessionMode, defaultTmuxSessionName, debugSession]);

  // 恢复会话（尝试复用现有 session）- 只执行一次
  useEffect(() => {
    if (isLoading) return;
    if (restoredRef.current) return;  // 防止重复执行
    restoredRef.current = true;

    debugSession('[Session] Restoring', persistedSessions.length, 'persisted sessions');

    const restore = async () => {
      let sessionCount = 0;
      try {
        const restored = await Promise.all(
          persistedSessions.map(async (session) => restoreOrCreateSession(session))
        );

        sessionCount = restored.length;
        debugSession('[Session] Restored sessions:', restored.length);
        setSessions(restored);
        setActiveSessionId(persistedActiveId || restored[0]?.id || null);

        const store = useTerminalStore.getState();
        restored.forEach((session) => {
          if (session.sessionId) {
            updateSessionBackendId(session.id, session.sessionId);
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
        }));
        setSessions(fallbackSessions);
        sessionCount = fallbackSessions.length;
        setActiveSessionId(persistedActiveId || fallbackSessions[0]?.id || null);
      } finally {
        // 恢复后若没有任何 session，在设置 isRestoring=false 之前
        // 同步等待创建完成，确保外部 effect 不会同时触发创建。
        if (sessionCount === 0) {
          await handleNewSessionRef.current?.();
        }
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
    defaultSessionMode,
    debugSession,
  ]);

  // 增量同步：轮询检测到 persistedSessions 变化时，处理新增/移除/重命名的 session
  const prevPersistedRef = useRef<PersistedSession[]>([]);
  const seededRef = useRef(false);
  const sessionsRef = useRef<TerminalSession[]>(sessions);
  sessionsRef.current = sessions;
  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  useEffect(() => {
    if (isRestoring) return;

    const prev = prevPersistedRef.current;
    const curr = persistedSessions;

    // Seed the ref on first non-restoring render (before any diff logic)
    if (!seededRef.current) {
      prevPersistedRef.current = curr;
      seededRef.current = true;
      return;
    }

    const prevIds = new Set(prev.map(s => s.sessionId));
    const currIds = new Set(curr.map(s => s.sessionId));
    // Local sessions already have backend connections — skip these
    const localIds = new Set(sessionsRef.current.map(s => s.id));

    // New sessions (appeared in persisted but not in prev, and not already local)
    const newPersisted = curr.filter(ps => !prevIds.has(ps.sessionId) && !localIds.has(ps.sessionId));
    // Removed sessions (disappeared from persisted)
    const removedSessionIds = [...prevIds].filter(id => !currIds.has(id));
    // Renamed sessions
    const prevNameMap = new Map(prev.map(s => [s.sessionId, s.name]));
    const renamedSessions = curr.filter(ps =>
      prevIds.has(ps.sessionId) && prevNameMap.get(ps.sessionId) !== ps.name
    );

    prevPersistedRef.current = curr;

    // Handle new sessions: attach to existing terminals
    if (newPersisted.length > 0) {
      (async () => {
        const attached = await Promise.all(
          newPersisted.map(async (ps) => {
            try {
              return await restoreOrCreateSession(ps);
            } catch {
              return null;
            }
          })
        );
        const validAttached = attached.filter((s): s is TerminalSession => s !== null);
        if (validAttached.length > 0) {
          setSessions(prev => [...prev, ...validAttached]);
          validAttached.forEach(session => {
            if (session.sessionId) {
              updateSessionBackendId(session.id, session.sessionId);
              const store = useTerminalStore.getState();
              store.setTerminalSession(session.id, {
                sessionId: session.sessionId,
                cols: 80, rows: 24,
                mode: session.mode,
                tmuxSessionName: session.tmuxSessionName,
              });
            }
          });
        }
      })();
    }

    // Handle removed sessions: remove from local state (don't kill backend)
    if (removedSessionIds.length > 0) {
      const currentActiveId = activeSessionIdRef.current;
      setSessions(prev => {
        const remaining = prev.filter(s => !removedSessionIds.includes(s.id));
        if (remaining.length !== prev.length) {
          const wasActiveRemoved = !remaining.some(s => s.id === currentActiveId);
          if (wasActiveRemoved && remaining.length > 0) {
            setActiveSessionId(remaining[0].id);
          } else if (remaining.length === 0) {
            setActiveSessionId(null);
          }
        }
        return remaining;
      });
    }

    // Handle renamed sessions
    if (renamedSessions.length > 0) {
      const renameMap = new Map(renamedSessions.map(ps => [ps.sessionId, ps.name]));
      setSessions(prev => prev.map(s =>
        renameMap.has(s.id) ? { ...s, name: renameMap.get(s.id)!, customName: true } : s
      ));
    }
  }, [persistedSessions, isRestoring, restoreOrCreateSession, updateSessionBackendId]);

  // Handle new session creation from custom event
  const handleNewSession = useCallback(async (options?: NewSessionEventDetail) => {
    try {
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
        mode,
        tmuxSessionName: tmuxSessionName ?? undefined,
        cwd: options?.cwd,
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

      debugSession('[Session] Created new session:', sessionId, newTerminalSession.sessionId);
    } catch (error) {
      console.error('[Session] Failed to create new session:', error);
    }
  }, [defaultSessionMode, defaultTmuxSessionName, saveSession, debugSession]);
  handleNewSessionRef.current = handleNewSession;

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

  // Reset session name → 清掉 customName,后续渲染回退到「程序名/目录名」默认显示
  const handleResetSessionName = useCallback((sessionId: string) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, customName: false } : s))
    );
    resetSessionCustomName(sessionId);
  }, [resetSessionCustomName]);

  // Handle session reorder
  const handleReorderSessions = useCallback((orderedIds: string[]) => {
    setSessions((prev) => {
      const idToSession = new Map(prev.map(s => [s.id, s]));
      const reordered = orderedIds
        .map(id => idToSession.get(id))
        .filter((s): s is TerminalSession => s !== undefined);
      const covered = new Set(orderedIds);
      const remaining = prev.filter(s => !covered.has(s.id));
      return [...reordered, ...remaining];
    });
    reorderSessions(orderedIds);
    debugSession('[Session] Reordered sessions:', orderedIds);
    requestAnimationFrame(() => {
      swiperRef.current?.update();
    });
  }, [reorderSessions, debugSession]);

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

  // Drop a frontend session whose backend pty was already cleaned up server-side
  // (e.g. after `tmux kill-session`). Skip the DELETE call to avoid 404s.
  const handleCloseSessionByBackendId = useCallback((backendSessionId: string) => {
    if (!backendSessionId) return;
    const matched = sessions.filter((s) => s.sessionId === backendSessionId);
    if (matched.length === 0) return;

    setSessions((prev) => {
      const remaining = prev.filter((s) => s.sessionId !== backendSessionId);
      if (remaining.length !== prev.length) {
        const wasActiveRemoved = !remaining.some((s) => s.id === activeSessionId);
        if (wasActiveRemoved) {
          setActiveSessionId(remaining.length > 0 ? remaining[0].id : null);
        }
      }
      return remaining;
    });

    for (const s of matched) {
      removePersistedSession(s.id);
      delete keyboardOpenBySessionRef.current[s.id];
    }
    debugSession('[Session] Backend gone, dropped local session(s):', matched.map((s) => s.id));
  }, [sessions, activeSessionId, removePersistedSession, debugSession]);

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

    const handleCloseSessionByBackendIdEvent = (event: Event) => {
      const customEvent = event as CustomEvent<string>;
      handleCloseSessionByBackendId(customEvent.detail);
    };

    const handleRenameSessionEvent = (event: Event) => {
      const customEvent = event as CustomEvent<{ sessionId: string; name: string }>;
      if (!customEvent.detail?.sessionId || !customEvent.detail?.name) {
        return;
      }
      handleRenameSession(customEvent.detail.sessionId, customEvent.detail.name);
    };

    const handleResetSessionNameEvent = (event: Event) => {
      const customEvent = event as CustomEvent<{ sessionId: string }>;
      if (!customEvent.detail?.sessionId) {
        return;
      }
      handleResetSessionName(customEvent.detail.sessionId);
    };

    const handleReorderSessionEvent = (event: Event) => {
      const customEvent = event as CustomEvent<{ sessionIds: string[] }>;
      if (!customEvent.detail?.sessionIds) {
        return;
      }
      handleReorderSessions(customEvent.detail.sessionIds);
    };

    window.addEventListener('new-terminal-session', handleNewSessionEvent);
    window.addEventListener('switch-terminal-session', handleSwitchSessionEvent);
    window.addEventListener('close-terminal-session', handleCloseSessionEvent);
    window.addEventListener('close-terminal-session-by-backend', handleCloseSessionByBackendIdEvent);
    window.addEventListener('rename-terminal-session', handleRenameSessionEvent);
    window.addEventListener('reset-terminal-session-name', handleResetSessionNameEvent);
    window.addEventListener('reorder-terminal-session', handleReorderSessionEvent);

    return () => {
      window.removeEventListener('new-terminal-session', handleNewSessionEvent);
      window.removeEventListener('switch-terminal-session', handleSwitchSessionEvent);
      window.removeEventListener('close-terminal-session', handleCloseSessionEvent);
      window.removeEventListener('close-terminal-session-by-backend', handleCloseSessionByBackendIdEvent);
      window.removeEventListener('rename-terminal-session', handleRenameSessionEvent);
      window.removeEventListener('reset-terminal-session-name', handleResetSessionNameEvent);
      window.removeEventListener('reorder-terminal-session', handleReorderSessionEvent);
    };
  }, [handleNewSession, handleSwitchSession, handleCloseSession, handleCloseSessionByBackendId, handleRenameSession, handleResetSessionName, handleReorderSessions]);

  // 没有会话时创建新的
  useEffect(() => {
    if (!isRestoring && sessions.length === 0) {
      handleNewSession();
    }
  }, [isRestoring, sessions.length, handleNewSession]);

  // 注意：以前这里有 `if (isRestoring) { 全屏 spinner }`，但它在两种场景下都很烦：
  // 1. PWA 从后台返回（iOS 会把页面踢出内存重新加载）：每次都看一遍全屏 loading
  // 2. 真·首次启动：也是 1-3s 蜂窝 RTT 的全屏 loading
  // 现在 useSessionPersistence 走 localStorage 缓存命中时 isRestoring 几乎是
  // 瞬间 false，UI 直接渲染；缓存未命中时 sessions=[]，下面 useEffect 会自动
  // 触发 handleNewSession() 创建一个新 session（瞬间空白比全屏 spinner 优雅）。

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-hidden">
        <Swiper
          onSwiper={(instance) => {
            swiperRef.current = instance;
            instance.allowTouchMove = sessions.length > 1;
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
          touchAngle={45}
          touchStartPreventDefault={false}
          noSwiping
          noSwipingSelector="[data-mobile-keyboard='true']"
          className="h-full"
        >
          {sessions.map((session, index) => (
            <SwiperSlide key={session.id} className="h-full">
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
            </SwiperSlide>
          ))}
        </Swiper>
      </div>
    </div>
  );
};
