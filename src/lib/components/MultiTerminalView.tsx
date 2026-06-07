import React, { useEffect, useCallback, useState, useRef, useMemo } from 'react';
import { Swiper, SwiperSlide } from 'swiper/react';
import type { Swiper as SwiperInstance } from 'swiper';
import 'swiper/css';
import { TerminalView } from './views/TerminalView';
import { useSessionPersistence, type PersistedSession } from '../hooks/useSessionPersistence';
import { closeTerminal, killTmuxSession } from '../terminal/api';
import type { TerminalMode } from '../terminal';
import type { TerminalRendererMode, TerminalEngine } from '../terminal/renderer';
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

interface CloseSessionEventDetail {
  sessionId: string;
  source?: 'sidebar' | 'tab-menu' | 'other';
  closeMode?: 'auto' | 'detach' | 'destroy';
}

const SWIPE_ANIMATION_SPEED_MS = 320;

function summarizeDuplicateMappings(sessions: TerminalSession[]): Array<{ kind: 'frontend' | 'backend' | 'tmux'; key: string; sessionIds: string[] }> {
  const buckets: Array<{ kind: 'frontend' | 'backend' | 'tmux'; key: string; sessionIds: string[] }> = [];
  const frontend = new Map<string, string[]>();
  const backend = new Map<string, string[]>();
  const tmux = new Map<string, string[]>();

  for (const session of sessions) {
    const frontendIds = frontend.get(session.id) ?? [];
    frontendIds.push(session.id);
    frontend.set(session.id, frontendIds);

    if (session.sessionId) {
      const backendIds = backend.get(session.sessionId) ?? [];
      backendIds.push(session.id);
      backend.set(session.sessionId, backendIds);
    }

    if (session.mode === 'tmux' && session.tmuxSessionName) {
      const tmuxIds = tmux.get(session.tmuxSessionName) ?? [];
      tmuxIds.push(session.id);
      tmux.set(session.tmuxSessionName, tmuxIds);
    }
  }

  for (const [key, sessionIds] of frontend) {
    if (sessionIds.length > 1) buckets.push({ kind: 'frontend', key, sessionIds });
  }
  for (const [key, sessionIds] of backend) {
    if (sessionIds.length > 1) buckets.push({ kind: 'backend', key, sessionIds });
  }
  for (const [key, sessionIds] of tmux) {
    if (sessionIds.length > 1) buckets.push({ kind: 'tmux', key, sessionIds });
  }

  return buckets;
}

function dedupeRuntimeSessions(sessions: TerminalSession[]): TerminalSession[] {
  const byId = new Map<string, TerminalSession>();
  for (const session of sessions) {
    byId.set(session.id, session);
  }
  return Array.from(byId.values());
}

function toRuntimeSession(session: PersistedSession): TerminalSession {
  return {
    id: session.sessionId,
    name: session.name,
    customName: session.customName === true,
    sessionId: session.backendSessionId,
    mode: session.mode === 'tmux' || session.mode === 'shell' ? session.mode : 'shell',
    tmuxSessionName: session.tmuxSessionName ?? null,
  };
}

function upsertRuntimeSession(sessions: TerminalSession[], nextSession: TerminalSession): TerminalSession[] {
  const next = dedupeRuntimeSessions(sessions);
  const existingIndex = next.findIndex((session) => session.id === nextSession.id);
  if (existingIndex >= 0) {
    const updated = [...next];
    updated[existingIndex] = nextSession;
    return updated;
  }
  return [...next, nextSession];
}

function syncRuntimeSessionsFromPersisted(current: TerminalSession[], persisted: PersistedSession[]): TerminalSession[] {
  const currentById = new Map(current.map((session) => [session.id, session]));
  return persisted.map((session) => {
    const existing = currentById.get(session.sessionId);
    return {
      ...toRuntimeSession(session),
      history: existing?.history,
    };
  });
}

function getSwipeEventPointerType(event: unknown): string {
  if (!event || typeof event !== 'object') {
    return 'unknown';
  }

  const maybeEvent = event as { pointerType?: string; type?: string };
  if (typeof maybeEvent.pointerType === 'string' && maybeEvent.pointerType) {
    return maybeEvent.pointerType;
  }

  if (typeof maybeEvent.type === 'string') {
    if (maybeEvent.type.startsWith('touch')) return 'touch';
    if (maybeEvent.type.startsWith('mouse')) return 'mouse';
    if (maybeEvent.type.startsWith('pointer')) return 'pointer';
  }

  return 'unknown';
}

interface MultiTerminalViewProps {
  fontFamily?: string;
  fontSize?: number;
  rendererMode?: TerminalRendererMode;
  engine?: TerminalEngine;
  toolbarPresets?: ToolbarPresetDefinition[];
  showDebug?: boolean;
  defaultSessionMode?: TerminalMode;
  defaultTmuxSessionName?: string;
  onStatusChange?: (status: { isConnecting: boolean; isRestarting: boolean; hasError: boolean; sessionId: string | null }) => void;
  onSessionDataUpdate?: (data: { sessions: TerminalSessionInfo[]; activeSessionId: string | null }) => void;
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
  engine = 'xterm',
  toolbarPresets = [],
  showDebug,
  defaultSessionMode = 'shell',
  defaultTmuxSessionName = '',
  onStatusChange,
  onSessionDataUpdate,
}) => {
  const debugSession = useMemo(() => createDebugLogger('session'), []);
  const debugTerminal = useMemo(() => createDebugLogger('terminal'), []);
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
  const lastDuplicateMappingSnapshotRef = useRef('');

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
    openSession,
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
      swiper.slideTo(activeSessionIndex, SWIPE_ANIMATION_SPEED_MS, false);
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

  const updateSwiperLayout = useCallback((reason: string) => {
    const swiper = swiperRef.current;
    if (!swiper) return;
    const el = swiper.el as HTMLElement | undefined;
    if (el) el.scrollLeft = 0;
    swiper.updateSize();
    swiper.updateSlides();
    swiper.updateProgress();
    swiper.updateSlidesClasses();
    if (el) el.scrollLeft = 0;
    debugSession('[Swiper] layout update', {
      reason,
      width: swiper.width,
      activeSessionIndex,
      activeIndex: swiper.activeIndex,
      scrollLeft: el?.scrollLeft ?? null,
    });
  }, [activeSessionIndex, debugSession]);

  useEffect(() => {
    const updateSwiperSize = () => {
      requestAnimationFrame(() => updateSwiperLayout('viewport-change'));
    };

    window.addEventListener('resize', updateSwiperSize);
    window.visualViewport?.addEventListener('resize', updateSwiperSize);
    window.visualViewport?.addEventListener('scroll', updateSwiperSize);

    updateSwiperSize();

    return () => {
      window.removeEventListener('resize', updateSwiperSize);
      window.visualViewport?.removeEventListener('resize', updateSwiperSize);
      window.visualViewport?.removeEventListener('scroll', updateSwiperSize);
    };
  }, [updateSwiperLayout]);

  // Notify parent of session data changes
  useEffect(() => {
    const duplicateMappings = summarizeDuplicateMappings(sessions);
    const duplicateSnapshot = JSON.stringify(duplicateMappings);
    if (duplicateMappings.length > 0 && duplicateSnapshot !== lastDuplicateMappingSnapshotRef.current) {
      lastDuplicateMappingSnapshotRef.current = duplicateSnapshot;
      console.warn('[session-invariant] duplicate mapping detected', duplicateMappings);
    } else if (duplicateMappings.length === 0 && lastDuplicateMappingSnapshotRef.current) {
      lastDuplicateMappingSnapshotRef.current = '';
    }

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

  // 通过服务端 Session Inventory 恢复或打开单个 session。
  // create / attach / restore 统一走同一个原子 open 接口，避免前端先本地
  // append 一条，再让持久化层去重造成闪烁或重复创建。
  const restoreOrCreateSession = useCallback(async (
    session: typeof persistedSessions[0],
  ): Promise<TerminalSession> => {
    const { sessionId, name } = session;
    const mode: TerminalMode = session.mode === 'tmux' || session.mode === 'shell'
      ? session.mode
      : defaultSessionMode;
    const configuredDefaultTmuxName = defaultTmuxSessionName.trim();
    const persistedTmuxName = (session.tmuxSessionName || '').trim();
    const tmuxSessionName = mode === 'tmux'
      ? (persistedTmuxName || configuredDefaultTmuxName || generateTmuxSessionName(sessionId))
      : null;

    const result = await openSession({
      preferredFrontendSessionId: sessionId,
      name,
      customName: session.customName === true,
      mode,
      tmuxSessionName,
      termType: engine === 'ghostty' ? 'xterm-ghostty' : 'xterm-256color',
    });
    const canonical = result.session;
    const terminalSession = result.terminalSession;
    debugSession('[Session] Inventory restore/open:', {
      requestedFrontendSessionId: sessionId,
      frontendSessionId: canonical.sessionId,
      backendSessionId: terminalSession.sessionId,
      reused: result.reused,
      mode: canonical.mode,
      tmuxSessionName: canonical.tmuxSessionName,
    });

    return {
      id: canonical.sessionId,
      name: canonical.name,
      customName: canonical.customName === true,
      sessionId: terminalSession.sessionId,
      mode: terminalSession.mode ?? canonical.mode,
      tmuxSessionName: terminalSession.tmuxSessionName ?? canonical.tmuxSessionName,
    };
  }, [defaultSessionMode, defaultTmuxSessionName, debugSession, engine, openSession]);

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
        const restoredSessions = dedupeRuntimeSessions(restored);
        setSessions(restoredSessions);
        setActiveSessionId(persistedActiveId || restoredSessions[0]?.id || null);

        const store = useTerminalStore.getState();
        restoredSessions.forEach((session) => {
          if (session.sessionId) {
            void updateSessionBackendId(session.id, session.sessionId);
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
        const fallbackSessions = dedupeRuntimeSessions(persistedSessions.map((session) => ({
          id: session.sessionId,
          name: session.name,
          customName: session.customName === true,
          sessionId: null as string | null,
          mode: session.mode === 'tmux' || session.mode === 'shell' ? session.mode : defaultSessionMode,
          tmuxSessionName: session.tmuxSessionName ?? null,
        })));
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
  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  useEffect(() => {
    if (isRestoring) return;

    const prev = prevPersistedRef.current;
    const curr = persistedSessions;

    // Seed the ref on first non-restoring render (before any diff logic)
    if (!seededRef.current) {
      setSessions((prevSessions) => syncRuntimeSessionsFromPersisted(prevSessions, curr));
      prevPersistedRef.current = curr;
      seededRef.current = true;
      return;
    }

    const prevIds = new Set(prev.map(s => s.sessionId));
    const currIds = new Set(curr.map(s => s.sessionId));
    const prevNameMap = new Map(prev.map(s => [s.sessionId, s.name]));

    prevPersistedRef.current = curr;

    setSessions((prevSessions) => {
      const synced = syncRuntimeSessionsFromPersisted(prevSessions, curr);
      if (!activeSessionIdRef.current || !synced.some((session) => session.id === activeSessionIdRef.current)) {
        setActiveSessionId(synced[0]?.id ?? null);
      }
      return synced;
    });

    const newPersisted = curr.filter(ps => !prevIds.has(ps.sessionId));
    const removedSessionIds = [...prevIds].filter(id => !currIds.has(id));
    const renamedSessions = curr.filter(ps =>
      prevIds.has(ps.sessionId) && prevNameMap.get(ps.sessionId) !== ps.name
    );

    if (newPersisted.length > 0 || removedSessionIds.length > 0 || renamedSessions.length > 0) {
      debugSession('[Session] Synced persisted sessions:', {
        newSessionIds: newPersisted.map((session) => session.sessionId),
        removedSessionIds,
        renamedSessionIds: renamedSessions.map((session) => session.sessionId),
        currentSessionIds: curr.map((session) => session.sessionId),
      });
    }

    for (const session of curr) {
      if (!session.backendSessionId) continue;
      const store = useTerminalStore.getState();
      store.setTerminalSession(session.sessionId, {
        sessionId: session.backendSessionId,
        cols: 80,
        rows: 24,
        mode: session.mode,
        tmuxSessionName: session.tmuxSessionName,
      });
    }
  }, [persistedSessions, isRestoring, debugSession]);

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

      const requestedCwd = typeof options?.cwd === 'string' ? options.cwd : null;
      const activeCwd = activeSessionId
        ? (useTerminalStore.getState().sessions.get(activeSessionId)?.cwd ?? null)
        : null;
      const effectiveCwd = typeof requestedCwd === 'string' && requestedCwd.trim().length > 0
        ? requestedCwd
        : (typeof activeCwd === 'string' && activeCwd.trim().length > 0 ? activeCwd : undefined);

      const result = await openSession({
        mode,
        tmuxSessionName,
        cwd: effectiveCwd,
        termType: engine === 'ghostty' ? 'xterm-ghostty' : 'xterm-256color',
      });
      const canonical = result.session;
      const terminalSession = result.terminalSession;
      const nextSession: TerminalSession = {
        id: canonical.sessionId,
        name: canonical.name,
        customName: canonical.customName === true,
        sessionId: terminalSession.sessionId,
        mode: terminalSession.mode ?? canonical.mode,
        tmuxSessionName: terminalSession.tmuxSessionName ?? canonical.tmuxSessionName,
      };

      setSessions((prev) => upsertRuntimeSession(prev, nextSession));

      setActiveSessionId(nextSession.id);

      const store = useTerminalStore.getState();
      store.setTerminalSession(nextSession.id, {
        sessionId: terminalSession.sessionId,
        cols: 80,
        rows: 24,
        mode: nextSession.mode,
        tmuxSessionName: nextSession.tmuxSessionName,
        activeProgram: terminalSession.activeProgram,
        activeProgramRaw: terminalSession.activeProgramRaw,
        activeProgramSource: terminalSession.activeProgramSource,
        cwd: terminalSession.cwd,
      });

      debugSession('[Session] Inventory opened session:', {
        frontendSessionId: nextSession.id,
        backendSessionId: terminalSession.sessionId,
        reused: result.reused,
        mode: nextSession.mode,
        tmuxSessionName: nextSession.tmuxSessionName,
      });
    } catch (error) {
      console.error('[Session] Failed to create new session:', error);
    }
  }, [defaultSessionMode, defaultTmuxSessionName, activeSessionId, openSession, debugSession, engine]);
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
      void renameSession(sessionId, newName.trim());
  }, [renameSession]);

  // Reset session name → 清掉 customName,后续渲染回退到「程序名/目录名」默认显示
  const handleResetSessionName = useCallback((sessionId: string) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, customName: false } : s))
    );
    void resetSessionCustomName(sessionId);
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
    void reorderSessions(orderedIds);
    debugSession('[Session] Reordered sessions:', orderedIds);
    requestAnimationFrame(() => {
      swiperRef.current?.update();
    });
  }, [reorderSessions, debugSession]);

  // Handle session closing from custom event
  const handleCloseSession = useCallback(async (
    detail: string | CloseSessionEventDetail,
  ) => {
    const sessionId = typeof detail === 'string' ? detail : detail.sessionId;
    const closeMode = typeof detail === 'string' ? 'auto' : (detail.closeMode ?? 'auto');
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;

    try {
      // tmux destroy: kill the tmux server session itself.
      if (
        closeMode === 'destroy' &&
        session.mode === 'tmux' &&
        session.tmuxSessionName
      ) {
        await killTmuxSession(session.tmuxSessionName);
        debugSession('[Session] Destroyed tmux session:', {
          frontendSessionId: session.id,
          tmuxSessionName: session.tmuxSessionName,
        });
      } else if (session.sessionId) {
        // default/detach path: close backend terminal wrapper session.
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
    void removePersistedSession(sessionId);
    delete keyboardOpenBySessionRef.current[sessionId];

    debugSession('[Session] Closed session:', { sessionId, closeMode });
  }, [sessions, removePersistedSession, debugSession]);

  // Drop a frontend session whose backend pty was already cleaned up server-side
  // (e.g. after `tmux kill-session`). Skip the DELETE call to avoid 404s.
  const handleCloseSessionByBackendId = useCallback((backendSessionId: string) => {
    if (!backendSessionId) return;
    const matched = sessions.filter((s) => s.sessionId === backendSessionId);
    if (matched.length === 0) return;
    if (matched.length > 1) {
      console.warn('[session-invariant] backend matched multiple frontend sessions during cleanup', {
        backendSessionId,
        frontendSessionIds: matched.map((session) => session.id),
      });
    }

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
      void removePersistedSession(s.id);
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
      const customEvent = event as CustomEvent<string | CloseSessionEventDetail>;
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
            requestAnimationFrame(() => updateSwiperLayout('on-swiper'));
          }}
          onSlideChange={handleSwiperChange}
          onTouchStart={(_, event) => {
            const pointerType = getSwipeEventPointerType(event);
            const allowed = pointerType === 'touch' || pointerType === 'pen' || pointerType === 'unknown';
            debugTerminal('[swipe:touch-start]', { pointerType, allowed });
            if (!allowed) {
              return;
            }
            isTouchSwipeRef.current = true;
          }}
          onTouchEnd={(_, event) => {
            const pointerType = getSwipeEventPointerType(event);
            const allowed = pointerType === 'touch' || pointerType === 'pen' || pointerType === 'unknown';
            debugTerminal('[swipe:touch-end]', { pointerType, allowed });
            if (!allowed) {
              return;
            }
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
          simulateTouch={false}
          noSwiping
          noSwipingSelector="[data-mobile-keyboard='true']"
          className="h-full"
        >
          {sessions.map((session, index) => (
            <SwiperSlide key={session.id} className="h-full">
              <TerminalView
                sessionId={session.id}
                mode={session.mode}
                tmuxSessionName={session.tmuxSessionName}
                fontFamily={fontFamily}
                fontSize={fontSize}
                rendererMode={rendererMode}
                engine={engine}
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
