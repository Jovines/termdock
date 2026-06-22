import React, { useEffect, useCallback, useState, useRef, useMemo } from 'react';
import { Swiper, SwiperSlide } from 'swiper/react';
import type { Swiper as SwiperInstance } from 'swiper';
import 'swiper/css';
import { TerminalView } from './views/TerminalView';
import { useSessionPersistence, type PersistedSession } from '../hooks/useSessionPersistence';
import { closeTerminal, killTmuxSession } from '../terminal/api';
import type { TerminalMode } from '../terminal';
import type { TerminalRendererMode } from '../terminal/renderer';
import { useTerminalStore } from '../stores/useTerminalStore';
import { useSidebarStore } from '../stores/useSidebarStore';
import { deriveGroupedOrder } from '../terminal/display';
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
const SWIPER_TRANSLATE_EPSILON_PX = 1;
const TOUCH_SWIPE_RELEASE_GUARD_MS = SWIPE_ANIMATION_SPEED_MS + 120;

type SyncSwiperOptions = {
  immediate?: boolean;
};

function cancelSwiperWrapperAnimations(swiper: SwiperInstance): void {
  const wrapper = (swiper as unknown as { wrapperEl?: HTMLElement }).wrapperEl;
  if (!wrapper) return;
  try {
    wrapper.getAnimations().forEach((animation) => animation.cancel());
  } catch {
    // Best effort: older WebViews may not expose getAnimations().
  }
}

function forceSwiperTranslate(swiper: SwiperInstance, targetIndex: number): void {
  const targetTranslate = getSwiperTargetTranslate(swiper, targetIndex);
  if (targetTranslate === null) return;
  const wrapper = (swiper as unknown as { wrapperEl?: HTMLElement }).wrapperEl;
  cancelSwiperWrapperAnimations(swiper);
  if (wrapper) {
    wrapper.style.transitionDuration = '0ms';
  }
  try {
    const mutableSwiper = swiper as unknown as {
      setTransition?: (duration: number) => void;
      setTranslate?: (translate: number) => void;
    };
    mutableSwiper.setTransition?.(0);
    mutableSwiper.setTranslate?.(targetTranslate);
    cancelSwiperWrapperAnimations(swiper);
    if (wrapper) {
      wrapper.style.transitionDuration = '0ms';
      wrapper.style.transform = `translate3d(${targetTranslate}px, 0px, 0px)`;
    }
  } catch {
    if (wrapper) {
      wrapper.style.transitionDuration = '0ms';
      wrapper.style.transform = `translate3d(${targetTranslate}px, 0px, 0px)`;
    }
  }
}

function getSwiperTranslate(swiper: SwiperInstance): number | null {
  try {
    const translate = typeof swiper.getTranslate === 'function'
      ? swiper.getTranslate()
      : swiper.translate;
    return typeof translate === 'number' && Number.isFinite(translate) ? translate : null;
  } catch {
    return typeof swiper.translate === 'number' && Number.isFinite(swiper.translate)
      ? swiper.translate
      : null;
  }
}

function getSwiperTargetTranslate(swiper: SwiperInstance, targetIndex: number): number | null {
  const snapGrid = swiper.snapGrid;
  const targetSnap = Array.isArray(snapGrid) ? snapGrid[targetIndex] : undefined;
  if (typeof targetSnap !== 'number' || !Number.isFinite(targetSnap)) {
    return null;
  }
  return -targetSnap;
}

function isSwiperTranslateAligned(swiper: SwiperInstance, targetIndex: number): boolean {
  const translate = getSwiperTranslate(swiper);
  const targetTranslate = getSwiperTargetTranslate(swiper, targetIndex);
  return translate !== null && targetTranslate !== null &&
    Math.abs(translate - targetTranslate) <= SWIPER_TRANSLATE_EPSILON_PX;
}

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

function getValidPersistedActiveSessionId(persisted: PersistedSession[], activeSessionId: string | null): string | null {
  if (persisted.length === 0) return null;
  return activeSessionId && persisted.some((session) => session.sessionId === activeSessionId)
    ? activeSessionId
    : persisted[0]?.sessionId ?? null;
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
  toolbarPresets?: ToolbarPresetDefinition[];
  showDebug?: boolean;
  defaultSessionMode?: TerminalMode;
  defaultTmuxSessionName?: string;
  onStatusChange?: (status: { isConnecting: boolean; isRestarting: boolean; hasError: boolean; sessionId: string | null }) => void;
  onSessionDataUpdate?: (data: { sessions: TerminalSessionInfo[]; activeSessionId: string | null }) => void;
}

function pickCwdById(sessions: Map<string, { cwd: string | null }>): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const [id, state] of sessions) {
    map.set(id, state.cwd ?? null);
  }
  return map;
}

function cwdMapEqual(a: Map<string, string | null>, b: Map<string, string | null>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, value] of b) {
    if (a.get(id) !== value) return false;
  }
  return true;
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
  const debugTerminal = useMemo(() => createDebugLogger('terminal'), []);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(true);
  const [resumeRequestToken, setResumeRequestToken] = useState(0);
  const restoredRef = useRef(false);
  const swiperRef = useRef<SwiperInstance | null>(null);
  const keyboardOpenBySessionRef = useRef<Record<string, boolean>>({});
  const [focusTransferRequest, setFocusTransferRequest] = useState<{ sessionId: string; token: number } | null>(null);
  const isTouchSwipeRef = useRef(false);
  const touchSwipeReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swiperDrivenActiveSessionIdRef = useRef<string | null>(null);
  const isMobileRef = useRef(false);
  const activeSessionIdRef = useRef<string | null>(null);
  const sessionsRef = useRef<TerminalSession[]>([]);
  const activeSessionIndexRef = useRef(0);
  const persistedActiveIdRef = useRef<string | null>(null);
  const isLoadingRef = useRef(false);
  const isRestoringRef = useRef(true);
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
  const {
    sessions: persistedSessions,
    activeSessionId: persistedActiveId,
    isLoading,
    openSession,
    setActiveSession,
    removeSession: removePersistedSession,
    renameSession,
    resetSessionCustomName,
    reorderSessions,
  } = useSessionPersistence();

  // 分组状态（与顶栏 tab / 侧边栏共享同一份）。
  const groupByFolder = useSidebarStore((s) => s.groupByFolder);

  // 订阅 useTerminalStore 的 cwd（分组按 cwd 归类）。只取 id→cwd 的 Map，
  // 浅比较避免终端高频输出导致的重渲染。
  const [cwdById, setCwdById] = useState<Map<string, string | null>>(
    () => pickCwdById(useTerminalStore.getState().sessions),
  );
  useEffect(() => {
    return useTerminalStore.subscribe((state) => {
      const next = pickCwdById(state.sessions);
      setCwdById((current) => (cwdMapEqual(current, next) ? current : next));
    });
  }, []);

  // 贯穿式分组：arranged = 所有 session 按 cwd 聚拢的顺序。所有 slide 常驻、
  // 左右滑动连续穿过全部（不折叠、不隐藏）。
  const { arranged } = useMemo(
    () => deriveGroupedOrder(
      sessions,
      (session) => cwdById.get(session.id) ?? null,
      groupByFolder,
      '',
    ),
    [sessions, cwdById, groupByFolder],
  );
  const arrangedRef = useRef<TerminalSession[]>(arranged);
  arrangedRef.current = arranged;

  activeSessionIdRef.current = activeSessionId;
  sessionsRef.current = sessions;
  persistedActiveIdRef.current = persistedActiveId;
  isLoadingRef.current = isLoading;
  isRestoringRef.current = isRestoring;

  const getSwiperDebugState = useCallback((swiper: SwiperInstance | null = swiperRef.current) => {
    const targetIndex = activeSessionIndexRef.current;
    const visualViewport = typeof window !== 'undefined' ? window.visualViewport : null;
    const translate = swiper ? getSwiperTranslate(swiper) : null;
    const targetTranslate = swiper ? getSwiperTargetTranslate(swiper, targetIndex) : null;
    return {
      sessionsLength: sessionsRef.current.length,
      sessionIds: sessionsRef.current.map((session) => session.id),
      activeSessionId: activeSessionIdRef.current,
      activeSessionIndex: targetIndex,
      persistedActiveId: persistedActiveIdRef.current,
      isLoading: isLoadingRef.current,
      isRestoring: isRestoringRef.current,
      activeIndex: swiper?.activeIndex ?? null,
      previousIndex: swiper?.previousIndex ?? null,
      animating: swiper?.animating ?? null,
      allowTouchMove: swiper?.allowTouchMove ?? null,
      width: swiper?.width ?? null,
      translate,
      targetTranslate,
      translateDelta: translate !== null && targetTranslate !== null ? translate - targetTranslate : null,
      snapGridLength: swiper?.snapGrid?.length ?? null,
      targetSnap: swiper?.snapGrid?.[targetIndex] ?? null,
      visualViewport: visualViewport
        ? {
            width: Math.round(visualViewport.width),
            height: Math.round(visualViewport.height),
            offsetTop: Math.round(visualViewport.offsetTop),
          }
        : null,
    };
  }, []);

  const logSwiperState = useCallback((event: string, extra?: Record<string, unknown>) => {
    debugSession(event, { ...getSwiperDebugState(), ...extra });
  }, [debugSession, getSwiperDebugState]);

  useEffect(() => {
    if (isLoading || isRestoring) {
      return;
    }
    if (activeSessionId === persistedActiveId) {
      return;
    }
    setActiveSession(activeSessionId);
  }, [activeSessionId, isLoading, isRestoring, persistedActiveId, setActiveSession]);

  // Get active session index (基于 arranged：与 Swiper 的 slide 顺序一致)
  const activeSessionIndex = useMemo(() => {
    if (arranged.length === 0) {
      return 0;
    }
    if (!activeSessionId) {
      return 0;
    }
    const foundIndex = arranged.findIndex((s) => s.id === activeSessionId);
    return foundIndex >= 0 ? foundIndex : 0;
  }, [arranged, activeSessionId]);

  activeSessionIndexRef.current = activeSessionIndex;

  const clearTouchSwipeReleaseTimer = useCallback(() => {
    if (!touchSwipeReleaseTimerRef.current) return;
    clearTimeout(touchSwipeReleaseTimerRef.current);
    touchSwipeReleaseTimerRef.current = null;
  }, []);

  const endTouchSwipeAfterNativeSettle = useCallback((reason: string) => {
    clearTouchSwipeReleaseTimer();
    touchSwipeReleaseTimerRef.current = setTimeout(() => {
      touchSwipeReleaseTimerRef.current = null;
      isTouchSwipeRef.current = false;
      logSwiperState('[swiper:touch-guard-clear]', { reason });
    }, TOUCH_SWIPE_RELEASE_GUARD_MS);
  }, [clearTouchSwipeReleaseTimer, logSwiperState]);

  const syncSwiperToActiveIndex = useCallback((reason: string, options: SyncSwiperOptions = {}) => {
    const swiper = swiperRef.current;
    const targetIndex = activeSessionIndexRef.current;
    const currentSessions = sessionsRef.current;
    if (!swiper || currentSessions.length === 0) {
      return;
    }
    if (targetIndex < 0 || targetIndex >= currentSessions.length) {
      return;
    }
    if (isTouchSwipeRef.current) {
      logSwiperState('[swiper:sync-skip-touch]', { reason });
      return;
    }
    if (swiper.animating) {
      logSwiperState('[swiper:sync-skip-animating]', { reason });
      return;
    }

    const translate = getSwiperTranslate(swiper);
    const targetTranslate = getSwiperTargetTranslate(swiper, targetIndex);
    const translateAligned = translate !== null && targetTranslate !== null &&
      Math.abs(translate - targetTranslate) <= SWIPER_TRANSLATE_EPSILON_PX;
    const activeIndexAligned = swiper.activeIndex === targetIndex;

    logSwiperState('[swiper:sync-check]', {
      reason,
      activeIndexAligned,
      translateAligned,
      immediate: options.immediate === true,
    });

    if (activeIndexAligned && translateAligned) {
      return;
    }

    // When the active index is already correct, any mismatch is layout drift
    // (for example a stale Web Animation/transition left behind after iOS PWA
    // resume). Do not start another animated slide here: cancel and snap the
    // wrapper to the exact target translate so the visible terminal is restored
    // synchronously.
    if (activeIndexAligned) {
      forceSwiperTranslate(swiper, targetIndex);
      logSwiperState('[swiper:sync-forced-active]', {
        reason,
        translateAligned,
        immediate: options.immediate === true,
      });
      return;
    }

    if (options.immediate) {
      forceSwiperTranslate(swiper, targetIndex);
      swiper.slideTo(targetIndex, 0, false);
      forceSwiperTranslate(swiper, targetIndex);
    } else {
      swiper.slideTo(
        targetIndex,
        SWIPE_ANIMATION_SPEED_MS,
        false
      );
    }

    logSwiperState('[swiper:sync-applied]', {
      reason,
      activeIndexAligned,
      translateAligned,
      immediate: options.immediate === true,
    });
  }, [logSwiperState]);

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
      logSwiperState('[swiper:gesture-lock]', { locked: ce.detail.locked });
    };
    document.addEventListener('termdock:gesture-lock', handler);
    return () => document.removeEventListener('termdock:gesture-lock', handler);
  }, [logSwiperState]);

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
    // instance.activeIndex 与 arranged（slide 渲染顺序）对应。
    const nextSessionId = arrangedRef.current[instance.activeIndex]?.id;
    logSwiperState('[swiper:slide-change]', {
      nextSessionId: nextSessionId ?? null,
      instanceActiveIndex: instance.activeIndex,
    });
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

    // Swiper itself is the source of truth for this update: it has already
    // moved (or is animating) the wrapper to `instance.activeIndex`. If the
    // React active-session effect immediately reconciles back into Swiper, it
    // races the native touch-release animation and may overwrite the wrapper
    // transform with a 0ms snap. Mark this state change so the effect below
    // updates app state/persistence only, without commanding Swiper again.
    swiperDrivenActiveSessionIdRef.current = nextSessionId;
    setActiveSessionId(nextSessionId);
    if (shouldTransferFocus) {
      setFocusTransferRequest({ sessionId: nextSessionId, token: Date.now() });
      return;
    }
    setFocusTransferRequest(null);
  }, [sessions, activeSessionId, logSwiperState]);

  useEffect(() => {
    if (swiperDrivenActiveSessionIdRef.current === activeSessionId) {
      logSwiperState('[swiper:sync-skip-swiper-driven]', { activeSessionId });
      swiperDrivenActiveSessionIdRef.current = null;
      return;
    }
    // This is a state reconciliation path, not the user's touch gesture path.
    // Keep it synchronous: after PWA resume WebKit can leave Swiper's wrapper
    // transition/Web Animation frozen, and another animated slideTo() preserves
    // the visually wrong transform for too long (or indefinitely).
    syncSwiperToActiveIndex('active-session-index', { immediate: true });
  }, [activeSessionId, activeSessionIndex, sessions.length, syncSwiperToActiveIndex, logSwiperState]);

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
    const nextAllow = arranged.length > 1;
    if (swiper.allowTouchMove !== nextAllow) {
      swiper.allowTouchMove = nextAllow;
      logSwiperState('[swiper:allow-touch-sync]', { nextAllow });
    }
  }, [arranged.length, logSwiperState]);

  const updateSwiperLayout = useCallback((reason: string) => {
    const swiper = swiperRef.current;
    if (!swiper) return;
    const el = swiper.el as HTMLElement | undefined;
    logSwiperState('[swiper:layout-before]', { reason, scrollLeft: el?.scrollLeft ?? null });
    if (el) el.scrollLeft = 0;
    swiper.updateSize();
    swiper.updateSlides();
    swiper.updateProgress();
    swiper.updateSlidesClasses();
    if (el) el.scrollLeft = 0;
    logSwiperState('[swiper:layout-after]', { reason, scrollLeft: el?.scrollLeft ?? null });
    if (isTouchSwipeRef.current || swiper.animating) {
      logSwiperState('[swiper:layout-skip-sync-motion]', { reason });
      return;
    }
    syncSwiperToActiveIndex(`layout:${reason}`, { immediate: true });
    requestAnimationFrame(() => {
      const current = swiperRef.current;
      if (!current) return;
      if (isTouchSwipeRef.current) return;
      if (current.animating) return;
      forceSwiperTranslate(current, activeSessionIndexRef.current);
    });
  }, [logSwiperState, syncSwiperToActiveIndex]);

  useEffect(() => {
    return () => clearTouchSwipeReleaseTimer();
  }, [clearTouchSwipeReleaseTimer]);

  // 分组开关 / 排列顺序变化后，slide 顺序改变 → 让 Swiper 重算 snapGrid 并把
  // translate 对齐到当前 active 的位置。
  const arrangedKey = arranged.map((s) => s.id).join('\u0000');
  useEffect(() => {
    requestAnimationFrame(() => updateSwiperLayout('group-change'));
  }, [groupByFolder, arrangedKey, updateSwiperLayout]);

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

  // PWA 从后台恢复 / 网络恢复时，不能只让当前 active slide 自检：
  // Swiper 中其它 TerminalView 虽然不可见但仍持有各自 WebSocket，服务重启后
  // 它们也会变成半开/已关闭连接。这里广播一个 token 给所有子 TerminalView，
  // 让每个 session 都 probe / 必要时重新 ensureSession。
  useEffect(() => {
    if (typeof document === 'undefined') return;

    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleResume = (reason: string) => {
      if (reason !== 'online' && document.hidden) return;
      setResumeRequestToken((token) => token + 1);

      // 刚回前台时 visualViewport / Swiper translate 经常还没稳定，立即 +
      // 延迟各 update 一次，避免重连后 active slide 宽高/translate 短暂错位。
      requestAnimationFrame(() => updateSwiperLayout(`resume:${reason}:raf`));
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        updateSwiperLayout(`resume:${reason}:settled`);
      }, 320);
    };

    const handleVisibility = () => {
      if (!document.hidden) scheduleResume('visibility');
    };
    const handlePageShow = (event: PageTransitionEvent) => {
      scheduleResume(event.persisted ? 'bfcache' : 'pageshow');
    };
    const handleOnline = () => scheduleResume('online');

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('online', handleOnline);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('online', handleOnline);
      if (settleTimer) clearTimeout(settleTimer);
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

  // 恢复会话（尝试复用现有 session）- 只执行一次
  useEffect(() => {
    if (isLoading) return;
    if (restoredRef.current) return;  // 防止重复执行
    restoredRef.current = true;

    const nextActiveSessionId = getValidPersistedActiveSessionId(persistedSessions, persistedActiveId);

    // 方案 A：一次性把所有 tab 渲染出来。
    // tab UI 不依赖后端 PTY attach 完成，每个 TerminalView 挂载后会各自跑
    // ensureSession —— store 里有 backendSessionId 就 health-check 复用，没有
    // 就自己 createSession。所以这里直接用 persistedSessions 同步渲染全部 tab，
    // 后端连接由各 TerminalView 并发完成，避免之前"串行 open 一个才 setSessions
    // 一个"导致 tab 从 1、2、3… 逐个长出来的卡顿。
    const runtimeSessions = dedupeRuntimeSessions(persistedSessions.map(toRuntimeSession));

    debugSession('[Session] Restoring', runtimeSessions.length, 'persisted sessions (one-shot)');
    logSwiperState('[swiper:restore-start]', {
      persistedSessionIds: persistedSessions.map((session) => session.sessionId),
      nextActiveSessionId,
    });

    if (runtimeSessions.length > 0) {
      // 预填 store：让带 backendSessionId 的 session 走 TerminalView 的复用路径，
      // 避免 ensureSession 误判为需要新建。backendSessionId 来自 inventory，
      // 无需再写回服务端。
      const store = useTerminalStore.getState();
      runtimeSessions.forEach((session) => {
        if (session.sessionId) {
          store.setTerminalSession(session.id, {
            sessionId: session.sessionId,
            cols: 80,
            rows: 24,
            mode: session.mode,
            tmuxSessionName: session.tmuxSessionName,
            history: session.history,
          });
        }
      });
      // 预填展示名提示（activeProgram / cwd）：来自 inventory / localStorage 缓存。
      // 这样 tab 首帧就能显示「coco termdock」，不必等 WS 连上后轮询 tmux 才跳变。
      // WS connected / active-program 事件到达后会用实时值覆盖这里的提示值。
      persistedSessions.forEach((session) => {
        if (session.activeProgram != null) {
          store.setSessionActiveProgram(session.sessionId, session.activeProgram);
        }
        if (session.cwd != null) {
          store.setSessionCwd(session.sessionId, session.cwd);
        }
      });

      setSessions(runtimeSessions);
      setActiveSessionId(nextActiveSessionId || runtimeSessions[0]?.id || null);
      logSwiperState('[swiper:restore-complete]', {
        restoredSessionIds: runtimeSessions.map((session) => session.id),
        nextActiveSessionId: nextActiveSessionId || runtimeSessions[0]?.id || null,
      });
    }

    const finalize = async () => {
      // 没有任何 session 时，在 isRestoring=false 之前同步等待创建完成，
      // 确保外部 effect 不会同时触发创建。
      if (runtimeSessions.length === 0) {
        await handleNewSessionRef.current?.();
      }
      setIsRestoring(false);
      requestAnimationFrame(() => syncSwiperToActiveIndex('restore-finished', { immediate: true }));
    };

    void finalize();
  }, [
    isLoading,
    persistedSessions,
    persistedActiveId,
    debugSession,
    logSwiperState,
    syncSwiperToActiveIndex,
  ]);

  // 增量同步：轮询检测到 persistedSessions 变化时，处理新增/移除/重命名的 session
  const prevPersistedRef = useRef<PersistedSession[]>([]);
  const seededRef = useRef(false);
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
        termType: 'xterm-256color',
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
  }, [defaultSessionMode, defaultTmuxSessionName, activeSessionId, openSession, debugSession]);
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

    const handleCycleSessionEvent = (event: Event) => {
      const customEvent = event as CustomEvent<{ direction: 'prev' | 'next' } | undefined>;
      const direction = customEvent.detail?.direction;
      if (direction !== 'prev' && direction !== 'next') return;
      const list = arrangedRef.current;
      if (list.length <= 1) return;
      const currentId = activeSessionIdRef.current;
      const currentIndex = currentId ? list.findIndex((s) => s.id === currentId) : -1;
      const base = currentIndex >= 0 ? currentIndex : 0;
      const delta = direction === 'next' ? 1 : -1;
      const nextIndex = (base + delta + list.length) % list.length;
      const nextId = list[nextIndex]?.id;
      if (nextId && nextId !== currentId) {
        handleSwitchSession(nextId);
      }
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
    window.addEventListener('cycle-terminal-session', handleCycleSessionEvent);
    window.addEventListener('close-terminal-session', handleCloseSessionEvent);
    window.addEventListener('close-terminal-session-by-backend', handleCloseSessionByBackendIdEvent);
    window.addEventListener('rename-terminal-session', handleRenameSessionEvent);
    window.addEventListener('reset-terminal-session-name', handleResetSessionNameEvent);
    window.addEventListener('reorder-terminal-session', handleReorderSessionEvent);

    return () => {
      window.removeEventListener('new-terminal-session', handleNewSessionEvent);
      window.removeEventListener('switch-terminal-session', handleSwitchSessionEvent);
      window.removeEventListener('cycle-terminal-session', handleCycleSessionEvent);
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
            instance.allowTouchMove = arranged.length > 1;
            logSwiperState('[swiper:on-swiper]', { allowTouchMove: instance.allowTouchMove });
            requestAnimationFrame(() => updateSwiperLayout('on-swiper'));
          }}
          onSlideChange={handleSwiperChange}
          onTouchStart={(_, event) => {
            const pointerType = getSwipeEventPointerType(event);
            const allowed = pointerType === 'touch' || pointerType === 'pen' || pointerType === 'unknown';
            debugTerminal('[swipe:touch-start]', { pointerType, allowed });
            logSwiperState('[swiper:touch-start]', { pointerType, allowed });
            if (!allowed) {
              return;
            }
            clearTouchSwipeReleaseTimer();
            isTouchSwipeRef.current = true;
          }}
          onTouchEnd={(_, event) => {
            const pointerType = getSwipeEventPointerType(event);
            const allowed = pointerType === 'touch' || pointerType === 'pen' || pointerType === 'unknown';
            debugTerminal('[swipe:touch-end]', { pointerType, allowed });
            logSwiperState('[swiper:touch-end]', { pointerType, allowed });
            if (!allowed) {
              return;
            }
            // Android Chrome can report `swiper.animating === false` at the
            // exact touchend frame, then start the native release animation a
            // moment later. If we clear the touch guard immediately, the React
            // active-session sync effect sees the new activeIndex and calls the
            // immediate snap path, so the page jumps with no release animation.
            // Keep the guard through the expected release window; transitionEnd
            // clears it earlier when Swiper does emit one.
            endTouchSwipeAfterNativeSettle('touch-end');
          }}
          onTransitionEnd={() => {
            const swiper = swiperRef.current;
            if (
              isTouchSwipeRef.current &&
              swiper &&
              !isSwiperTranslateAligned(swiper, activeSessionIndexRef.current)
            ) {
              // Android WebView/Chrome can emit a transitionEnd-like callback
              // on the touchend frame before Swiper's release animation has
              // actually settled. Clearing the touch guard here re-enables the
              // active-session sync effect, which then forces translate with
              // transitionDuration=0 and makes the page jump instantly. Keep the
              // guard alive until the wrapper is visually aligned, or until the
              // touch-end fallback timer expires.
              logSwiperState('[swiper:transition-end-deferred]');
              return;
            }
            clearTouchSwipeReleaseTimer();
            isTouchSwipeRef.current = false;
            logSwiperState('[swiper:transition-end]');
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
          {arranged.map((session) => {
            const isActive = session.id === activeSessionId;
            return (
              <SwiperSlide
                key={session.id}
                className="h-full"
              >
                <TerminalView
                  sessionId={session.id}
                  mode={session.mode}
                  tmuxSessionName={session.tmuxSessionName}
                  fontFamily={fontFamily}
                  fontSize={fontSize}
                  rendererMode={rendererMode}
                  toolbarPresets={toolbarPresets}
                  isActive={isActive}
                  focusRequestToken={focusTransferRequest?.sessionId === session.id ? focusTransferRequest.token : 0}
                  resumeRequestToken={resumeRequestToken}
                  onKeyboardVisibilityChange={handleKeyboardVisibilityChange}
                  showDebug={showDebug}
                  onStatusChange={isActive ? onStatusChange : undefined}
                />
              </SwiperSlide>
            );
          })}
        </Swiper>
      </div>
    </div>
  );
};
