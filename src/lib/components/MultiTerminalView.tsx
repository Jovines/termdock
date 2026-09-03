import React, { useEffect, useCallback, useState, useRef, useMemo } from 'react';
import { Swiper, SwiperSlide } from 'swiper/react';
import type { Swiper as SwiperInstance } from 'swiper';
import 'swiper/css';
import { TerminalView } from './views/TerminalView';
import { useSessionPersistence, type PersistedSession } from '../hooks/useSessionPersistence';
import { VIEWPORT_LAYOUT_CHANGE_EVENT } from '../hooks/useViewportHeight';
import {
  closeTerminal,
  dismissTmuxRecovery,
  killTmuxSession,
  restoreAllTmuxAgentSessions,
  sendTerminalInput,
  suspendTerminalConnectionReconnects,
} from '../terminal/api';
import type { TerminalMode } from '../terminal';
import { getDefaultTerminalSettings, type TerminalSettings } from '../terminal/settings';
import type { TermdockColorTheme } from '../terminal/theme';
import {
  BACKGROUND_RESUME_INITIAL_DELAY_MS,
  buildResumeDelayBySessionId,
  resolvePrioritySessionId,
  selectConnectionForegroundSessionId,
  shouldScheduleForegroundResume,
  shouldRunResumeRequest,
  shouldForceForegroundReconnect,
  shouldMountSessionViewport,
  shouldPublishSessionDataUpdate,
  shouldStartInitialConnection,
} from '../terminal/resumeScheduling';
import { useTerminalStore } from '../stores/useTerminalStore';
import {
  PINNED_SIDEBAR_SEPARATOR_WIDTH_PX,
  clampPinnedRightSidebarWidth,
  readRightSidebarWidthForContext,
  useSidebarStore,
} from '../stores/useSidebarStore';
import { deriveGroupedOrder, getCwdLeafName, getSessionDisplayLines } from '../terminal/display';
import { createDebugLogger } from '../utils/debug';
import { clientLog } from '../utils/clientLog';
import { markStartupMilestone } from '../utils/startupPerformance';
import { pickSessionAfterClose } from '../utils/sessionSelection';
import type { ToolbarPresetDefinition } from './terminal/mobileKeyboardPresets';
import { activateSplitPaneForWheel } from './splitPaneWheelActivation';
import { AlertTriangle, Check, Columns2, Folder, Plus, RotateCcw, X } from 'lucide-react';
import { useI18n } from '../i18n';
import {
  combineSplitWorkspaces,
  equalRatios,
  findSplitWorkspace,
  getSplitGridDimensions,
  normalizeRatios,
  normalizeSplitWorkspaces,
  pruneSplitWorkspaces,
  removeSessionFromSplitWorkspace,
  removeSplitWorkspaceForSession,
  reorderSplitWorkspaceSessions,
  renameSplitWorkspace,
  resizeAdjacentRatios,
  type SplitLayout,
  type SplitWorkspace,
  type SplitWorkspaceSummary,
} from '../terminal/splitWorkspaces';

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
  createIfEmpty?: boolean;
  command?: string;
}

interface CloseSessionEventDetail {
  sessionId: string;
  source?: 'sidebar' | 'tab-menu' | 'other';
  closeMode?: 'auto' | 'destroy';
}

const SWIPE_ANIMATION_SPEED_MS = 320;
const SWIPER_TRANSLATE_EPSILON_PX = 1;
const TOUCH_SWIPE_RELEASE_GUARD_MS = SWIPE_ANIMATION_SPEED_MS + 120;
type SyncSwiperOptions = {
  immediate?: boolean;
};

type ResumeRequest = {
  token: number;
  reason: 'visibility' | 'bfcache' | 'online';
  forceForegroundReconnect: boolean;
};

type WorkspaceSlide = {
  key: string;
  sessions: TerminalSession[];
  workspace?: SplitWorkspace;
};

const SPLIT_WORKSPACES_STORAGE_KEY = 'termdock:split-workspaces:v2';
const LEGACY_SPLIT_WORKSPACE_STORAGE_KEY = 'termdock:split-workspace:v1';
const MIN_SPLIT_RATIO = 0.1;
const MAX_SPLIT_RATIO = 0.9;
const MOBILE_MIN_SPLIT_RATIO = 0.28;
const MOBILE_SPLIT_LONG_PRESS_MS = 300;
const MOBILE_SPLIT_MOVE_CANCEL_PX = 8;
const MOBILE_SPLIT_HIT_SLOP_PX = 12;
const DESKTOP_SPLIT_MIN_WIDTH_PX = 280;
const DESKTOP_SPLIT_MIN_HEIGHT_PX = 160;

function detectMobileSplitLayout(): { mobile: boolean; landscape: boolean } {
  if (typeof window === 'undefined') return { mobile: false, landscape: false };
  const hasTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
  const mobile = hasTouch && Math.min(window.innerWidth, window.innerHeight) < 768;
  return {
    mobile,
    landscape: mobile && window.innerWidth > window.innerHeight,
  };
}

function readSplitWorkspaces(): SplitWorkspace[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = window.localStorage.getItem(SPLIT_WORKSPACES_STORAGE_KEY);
    if (stored) return normalizeSplitWorkspaces(JSON.parse(stored));
    const legacy = JSON.parse(window.localStorage.getItem(LEGACY_SPLIT_WORKSPACE_STORAGE_KEY) || 'null') as {
      primaryId?: unknown;
      secondaryId?: unknown;
      ratio?: unknown;
      direction?: unknown;
    } | null;
    if (legacy && typeof legacy.primaryId === 'string' && typeof legacy.secondaryId === 'string' && legacy.primaryId !== legacy.secondaryId) {
      const firstRatio = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, typeof legacy.ratio === 'number' ? legacy.ratio : 0.5));
      return [{
        id: `split:${legacy.primaryId}`,
        sessionIds: [legacy.primaryId, legacy.secondaryId],
        layout: legacy.direction === 'vertical' ? 'vertical' : 'horizontal',
        ratios: [firstRatio, 1 - firstRatio],
      }];
    }
  } catch {
    // Ignore invalid or stale local state.
  }
  return [];
}

function buildWorkspaceSlides(sessions: TerminalSession[], workspaces: SplitWorkspace[]): WorkspaceSlide[] {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const workspaceBySessionId = new Map<string, SplitWorkspace>();
  workspaces.forEach((workspace) => workspace.sessionIds.forEach((id) => workspaceBySessionId.set(id, workspace)));
  const emittedWorkspaceIds = new Set<string>();
  const slides: WorkspaceSlide[] = [];
  for (const session of sessions) {
    const workspace = workspaceBySessionId.get(session.id);
    if (!workspace) {
      slides.push({ key: session.id, sessions: [session] });
      continue;
    }
    if (emittedWorkspaceIds.has(workspace.id)) continue;
    emittedWorkspaceIds.add(workspace.id);
    const workspaceSessions = workspace.sessionIds.flatMap((id) => {
      const member = sessionsById.get(id);
      return member ? [member] : [];
    });
    if (workspaceSessions.length >= 2) slides.push({ key: workspace.id, sessions: workspaceSessions, workspace });
  }
  return slides;
}

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
  terminalSettings?: TerminalSettings;
  colorTheme?: TermdockColorTheme;
  toolbarPresets?: ToolbarPresetDefinition[];
  showDebug?: boolean;
  terminalFocusAvailable?: boolean;
  defaultSessionMode?: TerminalMode;
  defaultTmuxSessionName?: string;
  connectionPrioritySessionId?: string | null;
  connectionPriorityReady?: boolean;
  desktopPinnedRightSidebar?: boolean;
  desktopPinnedRightSidebarWidth?: number;
  desktopPinnedLeftSidebarWidth?: number;
  desktopViewportWidth?: number;
  onStatusChange?: (status: { isConnecting: boolean; isRestarting: boolean; hasError: boolean; sessionId: string | null }) => void;
  onSessionDataUpdate?: (data: {
    sessions: TerminalSessionInfo[];
    activeSessionId: string | null;
    splitWorkspaces: SplitWorkspaceSummary[];
  }) => void;
  onInitialViewportReady?: () => void;
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
  terminalSettings = getDefaultTerminalSettings(),
  colorTheme = 'dark',
  toolbarPresets = [],
  showDebug,
  terminalFocusAvailable = true,
  defaultSessionMode = 'shell',
  defaultTmuxSessionName = '',
  connectionPrioritySessionId = null,
  connectionPriorityReady = true,
  desktopPinnedRightSidebar = false,
  desktopPinnedRightSidebarWidth = 0,
  desktopPinnedLeftSidebarWidth = 0,
  desktopViewportWidth = 0,
  onStatusChange,
  onSessionDataUpdate,
  onInitialViewportReady,
}) => {
  const { t } = useI18n();
  const debugSession = useMemo(() => createDebugLogger('session'), []);
  const debugTerminal = useMemo(() => createDebugLogger('terminal'), []);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [pendingSwitchSessionId, setPendingSwitchSessionId] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(true);
  const [resumeRequest, setResumeRequest] = useState<ResumeRequest>({
    token: 0,
    reason: 'visibility',
    forceForegroundReconnect: false,
  });
  const [readySessionIds, setReadySessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const [foregroundResumeCompletedToken, setForegroundResumeCompletedToken] = useState(0);
  const [viewportReadySessionIds, setViewportReadySessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const [deferredViewportSessionIds, setDeferredViewportSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const restoredRef = useRef(false);
  const swiperRef = useRef<SwiperInstance | null>(null);
  const keyboardOpenBySessionRef = useRef<Record<string, boolean>>({});
  const [focusTransferRequest, setFocusTransferRequest] = useState<{ sessionId: string; token: number } | null>(null);
  const [splitWorkspaces, setSplitWorkspaces] = useState<SplitWorkspace[]>(() => readSplitWorkspaces());
  const [splitChooserOpen, setSplitChooserOpen] = useState(false);
  const [splitNotice, setSplitNotice] = useState<string | null>(null);
  const [tmuxRecoveryPending, setTmuxRecoveryPending] = useState<'restore' | 'dismiss' | null>(null);
  const [tmuxRecoveryError, setTmuxRecoveryError] = useState<string | null>(null);
  const [isCreatingSplitSession, setIsCreatingSplitSession] = useState(false);
  const [isMobileLayout, setIsMobileLayout] = useState(() => detectMobileSplitLayout().mobile);
  const [isMobileLandscape, setIsMobileLandscape] = useState(() => detectMobileSplitLayout().landscape);
  const [splitKeyboardPortalTarget, setSplitKeyboardPortalTarget] = useState<HTMLDivElement | null>(null);
  const [mobileKeyboardOpenSessionId, setMobileKeyboardOpenSessionId] = useState<string | null>(null);
  const terminalFocusAvailableRef = useRef(terminalFocusAvailable);
  const isTouchSwipeRef = useRef(false);
  const touchSwipeReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swiperDrivenActiveSessionIdRef = useRef<string | null>(null);
  const isMobileRef = useRef(isMobileLayout);
  const activeSessionIdRef = useRef<string | null>(null);
  const resumeRequestTokenRef = useRef(0);
  const sessionsRef = useRef<TerminalSession[]>([]);
  const activeSessionIndexRef = useRef(0);
  const persistedActiveIdRef = useRef<string | null>(null);
  const isLoadingRef = useRef(false);
  const isRestoringRef = useRef(true);
  const handleNewSessionRef = useRef<((options?: NewSessionEventDetail) => Promise<string | null>) | null>(null);
  const lastDuplicateMappingSnapshotRef = useRef('');
  const splitDragCleanupRef = useRef<(() => void) | null>(null);
  const suppressMobileKeyboardOpenUntilRef = useRef(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const check = () => {
      const next = detectMobileSplitLayout();
      isMobileRef.current = next.mobile;
      setIsMobileLayout(next.mobile);
      setIsMobileLandscape(next.landscape);
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  const {
    sessions: persistedSessions,
    inventory,
    activeSessionId: persistedActiveId,
    isLoading,
    openSession,
    setActiveSession,
    removeSession: removePersistedSession,
    renameSession,
    resetSessionCustomName,
    reorderSessions,
    restoreSessions,
  } = useSessionPersistence();

  const tmuxRecovery = inventory?.tmuxRecovery ?? null;
  useEffect(() => {
    setTmuxRecoveryError(null);
    setTmuxRecoveryPending(null);
  }, [tmuxRecovery?.id]);

  const handleRestoreAllTmuxAgents = useCallback(async () => {
    setTmuxRecoveryPending('restore');
    setTmuxRecoveryError(null);
    try {
      const result = await restoreAllTmuxAgentSessions();
      await restoreSessions();
      if (result.failed > 0) {
        setTmuxRecoveryError(t('tab.tmuxRecoveryPartial', { restored: result.restored, failed: result.failed }));
      }
    } catch {
      setTmuxRecoveryError(t('tab.tmuxRecoveryFailed'));
    } finally {
      setTmuxRecoveryPending(null);
    }
  }, [restoreSessions, t]);

  const handleDismissTmuxRecovery = useCallback(async () => {
    setTmuxRecoveryPending('dismiss');
    setTmuxRecoveryError(null);
    try {
      await dismissTmuxRecovery();
      await restoreSessions();
    } catch {
      setTmuxRecoveryError(t('tab.tmuxRecoveryDismissFailed'));
    } finally {
      setTmuxRecoveryPending(null);
    }
  }, [restoreSessions, t]);

  // 分组状态（与顶栏 tab / 侧边栏共享同一份）。
  const groupByFolder = useSidebarStore((s) => s.groupByFolder);
  const sidebarOverlayOpen = useSidebarStore((s) => s.leftOpen || s.rightOpen);

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
  const workspaceSlides = useMemo(
    () => buildWorkspaceSlides(arranged, splitWorkspaces),
    [arranged, splitWorkspaces],
  );
  const workspaceSlidesRef = useRef<WorkspaceSlide[]>(workspaceSlides);
  workspaceSlidesRef.current = workspaceSlides;
  const activeSplitWorkspace = useMemo(
    () => findSplitWorkspace(splitWorkspaces, activeSessionId),
    [activeSessionId, splitWorkspaces],
  );
  const visibleSessionIds = useMemo(() => {
    const activeSlide = workspaceSlides.find((slide) =>
      slide.sessions.some((session) => session.id === activeSessionId)
    );
    return new Set(activeSlide?.sessions.map((session) => session.id) ?? []);
  }, [activeSessionId, workspaceSlides]);
  const pinnedRightSidebarInsetBySlideKey = useMemo(() => {
    const insets = new Map<string, number>();
    if (!desktopPinnedRightSidebar || desktopViewportWidth <= 0) return insets;
    for (const slide of workspaceSlides) {
      const firstSession = slide.sessions[0];
      if (!firstSession) continue;
      const requestedWidth = slide.sessions.some((session) => session.id === activeSessionId)
        ? desktopPinnedRightSidebarWidth
        : readRightSidebarWidthForContext(
            firstSession.id,
            cwdById.get(firstSession.id) ?? null,
            slide.workspace?.id ?? null,
          );
      const width = clampPinnedRightSidebarWidth(
        requestedWidth,
        desktopViewportWidth,
        desktopPinnedLeftSidebarWidth,
      );
      insets.set(slide.key, width + PINNED_SIDEBAR_SEPARATOR_WIDTH_PX);
    }
    return insets;
  }, [
    activeSessionId,
    cwdById,
    desktopPinnedLeftSidebarWidth,
    desktopPinnedRightSidebar,
    desktopPinnedRightSidebarWidth,
    desktopViewportWidth,
    workspaceSlides,
  ]);
  const priorityForegroundSessionId = useMemo(() => resolvePrioritySessionId(
    sessions.map((session) => ({ id: session.id, backendSessionId: session.sessionId })),
    connectionPrioritySessionId,
  ), [connectionPrioritySessionId, sessions]);
  const persistedForegroundSessionId = useMemo(
    () => getValidPersistedActiveSessionId(persistedSessions, persistedActiveId),
    [persistedActiveId, persistedSessions],
  );
  const foregroundSessionId = selectConnectionForegroundSessionId({
    prioritySessionId: priorityForegroundSessionId,
    activeSessionId: pendingSwitchSessionId ?? activeSessionId,
    persistedActiveSessionId: persistedForegroundSessionId,
    firstSessionId: sessions[0]?.id ?? null,
  });
  const backgroundResumeDelayBySessionId = useMemo(() => {
    return buildResumeDelayBySessionId(
      workspaceSlides.flatMap((slide) => slide.sessions.map((session) => session.id)),
      visibleSessionIds,
    );
  }, [visibleSessionIds, workspaceSlides]);
  const foregroundConnectionReady = foregroundSessionId !== null && readySessionIds.has(foregroundSessionId);
  const handleStreamReadyChange = useCallback((sessionId: string, ready: boolean) => {
    setReadySessionIds((current) => {
      const alreadyReady = current.has(sessionId);
      if (alreadyReady === ready) return current;
      const next = new Set(current);
      if (ready) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }, []);
  const handleStreamConnected = useCallback((sessionId: string) => {
    const expectedForeground = priorityForegroundSessionId
      ?? pendingSwitchSessionId
      ?? activeSessionIdRef.current;
    if (sessionId !== expectedForeground) return;
    markStartupMilestone('foreground-stream-connected');
    setForegroundResumeCompletedToken(resumeRequestTokenRef.current);
  }, [pendingSwitchSessionId, priorityForegroundSessionId]);
  const handleViewportReadyChange = useCallback((sessionId: string, ready: boolean) => {
    setViewportReadySessionIds((current) => {
      if (current.has(sessionId) === ready) return current;
      const next = new Set(current);
      if (ready) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }, []);
  const foregroundViewportReady = foregroundSessionId !== null
    && viewportReadySessionIds.has(foregroundSessionId);

  useEffect(() => {
    if (foregroundViewportReady) markStartupMilestone('foreground-viewport-ready');
  }, [foregroundViewportReady]);

  useEffect(() => {
    if (!onInitialViewportReady) return;
    if (!isRestoring && sessions.length === 0) {
      onInitialViewportReady();
      return;
    }
    if (!foregroundViewportReady || !foregroundConnectionReady) return;

    // `connected` opens the write gate; the history chunk is parsed immediately
    // afterward. Keep the cold-start surface for a few paint opportunities so
    // we never reveal the fully mounted chrome with a still-empty xterm frame.
    const timer = window.setTimeout(onInitialViewportReady, 120);
    return () => window.clearTimeout(timer);
  }, [
    foregroundConnectionReady,
    foregroundViewportReady,
    isRestoring,
    onInitialViewportReady,
    sessions.length,
  ]);

  useEffect(() => {
    if (visibleSessionIds.size === 0) return;
    // Keep mounted terminals bounded on both desktop and mobile. Mobile used to
    // create an xterm/canvas for every restored session at once, so a workspace
    // with many Agent tabs delayed the first visible terminal and made the tab
    // strip appear well before its content. Warm the neighbouring mobile slides
    // for smooth swiping, then retain every slide the user has visited.
    const idsToMount = new Set(visibleSessionIds);
    if (isMobileLayout) {
      const activeSlideIndex = workspaceSlides.findIndex((slide) => (
        slide.sessions.some((session) => visibleSessionIds.has(session.id))
      ));
      for (const slideIndex of [activeSlideIndex - 1, activeSlideIndex + 1]) {
        workspaceSlides[slideIndex]?.sessions.forEach((session) => idsToMount.add(session.id));
      }
    }
    setDeferredViewportSessionIds((current) => {
      let changed = false;
      const next = new Set(current);
      for (const sessionId of idsToMount) {
        if (next.has(sessionId)) continue;
        next.add(sessionId);
        changed = true;
      }
      return changed ? next : current;
    });
  }, [isMobileLayout, visibleSessionIds, workspaceSlides]);

  useEffect(() => {
    if (!pendingSwitchSessionId) return;
    if (!sessions.some((session) => session.id === pendingSwitchSessionId)) {
      setPendingSwitchSessionId(null);
      return;
    }
    if (
      !viewportReadySessionIds.has(pendingSwitchSessionId)
      || !readySessionIds.has(pendingSwitchSessionId)
    ) return;

    // Keep the currently painted slide in place while an unvisited target is
    // mounted and connected off-screen. Switching only after its xterm has had
    // a few paint opportunities avoids the single black frame that otherwise
    // appears between distant mobile tabs.
    const timer = window.setTimeout(() => {
      setActiveSessionId(pendingSwitchSessionId);
      setPendingSwitchSessionId((current) => (
        current === pendingSwitchSessionId ? null : current
      ));
      if (terminalFocusAvailableRef.current && !isMobileRef.current) {
        setFocusTransferRequest({ sessionId: pendingSwitchSessionId, token: Date.now() });
      }
    }, 80);
    return () => window.clearTimeout(timer);
  }, [pendingSwitchSessionId, readySessionIds, sessions, viewportReadySessionIds]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (splitWorkspaces.length > 0) {
      window.localStorage.setItem(SPLIT_WORKSPACES_STORAGE_KEY, JSON.stringify(splitWorkspaces));
      window.localStorage.removeItem(LEGACY_SPLIT_WORKSPACE_STORAGE_KEY);
    } else {
      window.localStorage.removeItem(SPLIT_WORKSPACES_STORAGE_KEY);
    }
  }, [splitWorkspaces]);

  useEffect(() => {
    if (isLoading || isRestoring || splitWorkspaces.length === 0) return;
    setSplitWorkspaces((current) => pruneSplitWorkspaces(current, sessions.map((session) => session.id)));
  }, [isLoading, isRestoring, sessions, splitWorkspaces.length]);

  useEffect(() => {
    if (!splitNotice) return;
    const timer = window.setTimeout(() => setSplitNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [splitNotice]);

  useEffect(() => () => splitDragCleanupRef.current?.(), []);

  activeSessionIdRef.current = activeSessionId;
  resumeRequestTokenRef.current = resumeRequest.token;
  sessionsRef.current = sessions;
  persistedActiveIdRef.current = persistedActiveId;
  isLoadingRef.current = isLoading;
  isRestoringRef.current = isRestoring;
  terminalFocusAvailableRef.current = terminalFocusAvailable;

  const getSwiperDebugState = useCallback((swiper: SwiperInstance | null = swiperRef.current) => {
    const targetIndex = activeSessionIndexRef.current;
    const visualViewport = typeof window !== 'undefined' ? window.visualViewport : null;
    const translate = swiper ? getSwiperTranslate(swiper) : null;
    const targetTranslate = swiper ? getSwiperTargetTranslate(swiper, targetIndex) : null;
    return {
      sessionsLength: sessionsRef.current.length,
      workspaceSlidesLength: workspaceSlidesRef.current.length,
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
    const foundIndex = workspaceSlides.findIndex((slide) =>
      slide.sessions.some((session) => session.id === activeSessionId)
    );
    return foundIndex >= 0 ? foundIndex : 0;
  }, [workspaceSlides, activeSessionId]);

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
    const currentSlides = workspaceSlidesRef.current;
    if (!swiper || currentSlides.length === 0) {
      return;
    }
    if (targetIndex < 0 || targetIndex >= currentSlides.length) {
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
      if (!connectionPriorityReady) return;
      setActiveSessionId(selectConnectionForegroundSessionId({
        prioritySessionId: priorityForegroundSessionId,
        activeSessionId: null,
        persistedActiveSessionId: persistedForegroundSessionId,
        firstSessionId: sessions[0]?.id ?? null,
      }));
      return;
    }

    const exists = sessions.some((session) => session.id === activeSessionId);
    if (!exists) {
      setActiveSessionId(sessions[0].id);
    }
  }, [sessions, activeSessionId, connectionPriorityReady, priorityForegroundSessionId, persistedForegroundSessionId]);

  const handleKeyboardVisibilityChange = useCallback((sessionId: string, isOpen: boolean) => {
    if (isOpen && Date.now() < suppressMobileKeyboardOpenUntilRef.current) {
      keyboardOpenBySessionRef.current[sessionId] = false;
      return;
    }
    keyboardOpenBySessionRef.current[sessionId] = isOpen;
    setMobileKeyboardOpenSessionId((current) => {
      if (isOpen) return sessionId;
      return current === sessionId ? null : current;
    });
  }, []);

  const handleSwiperChange = useCallback((instance: SwiperInstance) => {
    // Swiper may emit slideChange while it is mounting or recalculating widths.
    // That is not user intent: accepting its temporary index (usually zero)
    // would overwrite the restored selection after the page already looked
    // correct. Programmatic tab changes use slideTo(..., false), while a real
    // swipe holds the touch guard, so only the latter may drive persistence.
    if (!isTouchSwipeRef.current && instance.activeIndex !== activeSessionIndexRef.current) {
      logSwiperState('[swiper:slide-change-ignored-layout]', {
        instanceActiveIndex: instance.activeIndex,
        expectedActiveIndex: activeSessionIndexRef.current,
      });
      requestAnimationFrame(() => syncSwiperToActiveIndex('ignored-layout-slide-change', { immediate: true }));
      return;
    }
    // instance.activeIndex 与 arranged（slide 渲染顺序）对应。
    const nextSlide = workspaceSlidesRef.current[instance.activeIndex];
    const nextSessionId = nextSlide?.sessions.some((session) => session.id === activeSessionId)
      ? activeSessionId
      : nextSlide?.sessions[0]?.id;
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
      terminalFocusAvailableRef.current && (!isMobileRef.current || isKeyboardOpen);

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
  }, [sessions, activeSessionId, logSwiperState, syncSwiperToActiveIndex]);

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
    const nextAllow = workspaceSlides.length > 1 && !sidebarOverlayOpen && !splitChooserOpen;
    if (swiper.allowTouchMove !== nextAllow) {
      swiper.allowTouchMove = nextAllow;
      logSwiperState('[swiper:allow-touch-sync]', { nextAllow, sidebarOverlayOpen });
    }
  }, [workspaceSlides.length, logSwiperState, sidebarOverlayOpen, splitChooserOpen]);

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
  const arrangedKey = workspaceSlides.map((slide) => slide.key).join('\u0000');
  useEffect(() => {
    requestAnimationFrame(() => updateSwiperLayout('group-change'));
  }, [groupByFolder, arrangedKey, updateSwiperLayout]);

  useEffect(() => {
    let pendingLayoutRaf: number | null = null;
    let pendingReason = 'mount';
    const scheduleSwiperUpdate = (reason: string) => {
      pendingReason = reason;
      if (pendingLayoutRaf !== null) return;
      pendingLayoutRaf = requestAnimationFrame(() => {
        pendingLayoutRaf = null;
        updateSwiperLayout(`viewport-change:${pendingReason}`);
      });
    };
    const handleWindowResize = () => scheduleSwiperUpdate('window-resize');
    const handleVisualViewportResize = () => scheduleSwiperUpdate('visual-viewport-resize');
    const handleVisualViewportScroll = () => scheduleSwiperUpdate('visual-viewport-scroll');
    const handleMeasuredLayout = (event: CustomEvent<{ source?: string }>) => {
      scheduleSwiperUpdate(`measured:${event.detail?.source ?? 'unknown'}`);
    };

    window.addEventListener('resize', handleWindowResize);
    window.visualViewport?.addEventListener('resize', handleVisualViewportResize);
    window.visualViewport?.addEventListener('scroll', handleVisualViewportScroll);
    document.addEventListener(VIEWPORT_LAYOUT_CHANGE_EVENT, handleMeasuredLayout);

    scheduleSwiperUpdate('mount');

    return () => {
      window.removeEventListener('resize', handleWindowResize);
      window.visualViewport?.removeEventListener('resize', handleVisualViewportResize);
      window.visualViewport?.removeEventListener('scroll', handleVisualViewportScroll);
      document.removeEventListener(VIEWPORT_LAYOUT_CHANGE_EVENT, handleMeasuredLayout);
      if (pendingLayoutRaf !== null) cancelAnimationFrame(pendingLayoutRaf);
    };
  }, [updateSwiperLayout]);

  // PWA / Electron 从后台恢复或网络恢复时，不能只让当前 active slide 自检：
  // Swiper 中其它 TerminalView 虽然不可见但仍持有各自 WebSocket，服务重启后
  // 它们也会变成半开/已关闭连接。这里广播一个 token 给所有子 TerminalView；
  // 当前可见 slide（包括分屏里的所有可见 pane）立即 probe，后台 session 从
  // 300ms 起按 120ms 错峰补连，优先恢复用户眼前内容并压低瞬时连接风暴。
  useEffect(() => {
    if (typeof document === 'undefined') return;

    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastResumeScheduledAt: number | null = null;
    let wasPageHidden = document.hidden;
    const scheduleResume = (reason: string) => {
      if (reason !== 'online' && document.hidden) return;
      const now = performance.now();
      if (!shouldScheduleForegroundResume(lastResumeScheduledAt, now)) return;
      lastResumeScheduledAt = now;
      const refreshReason = reason === 'bfcache' || reason === 'online' ? reason : 'visibility';
      const forceForegroundReconnect = shouldForceForegroundReconnect({ wasPageHidden, reason });
      wasPageHidden = false;
      clientLog('info', 'PWA_RESUME scheduled', {
        source: reason,
        forceForegroundReconnect,
        activeSessionId: activeSessionIdRef.current,
      });
      setResumeRequest((request) => ({
        token: request.token + 1,
        reason: refreshReason,
        forceForegroundReconnect,
      }));

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
      if (document.hidden) {
        wasPageHidden = true;
        suspendTerminalConnectionReconnects();
        return;
      }
      scheduleResume('visibility');
    };
    const handlePageHide = () => {
      wasPageHidden = true;
      suspendTerminalConnectionReconnects();
    };
    const handlePageShow = (event: PageTransitionEvent) => {
      scheduleResume(event.persisted ? 'bfcache' : 'pageshow');
    };
    const handleOnline = () => scheduleResume('online');
    const handleWindowFocus = () => scheduleResume('focus');

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('online', handleOnline);
    window.addEventListener('focus', handleWindowFocus);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('focus', handleWindowFocus);
      if (settleTimer) clearTimeout(settleTimer);
    };
  }, [updateSwiperLayout]);

  // Notify parent of session data changes
  useEffect(() => {
    // App has already hydrated its tab chrome synchronously from the same
    // persistence cache. Publishing this component's initial empty state would
    // erase that stable first paint, then reinsert every tab after restore.
    // Besides the visible flash, the active-tab scroll position was also reset.
    if (!shouldPublishSessionDataUpdate(isRestoring)) return;

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
      splitWorkspaces: splitWorkspaces.map(({ id, name, sessionIds, layout }) => ({
        id,
        ...(name ? { name } : {}),
        sessionIds,
        layout,
      })),
    });
  }, [sessions, activeSessionId, splitWorkspaces, onSessionDataUpdate, isRestoring]);

  // 恢复会话（尝试复用现有 session）- 只执行一次
  useEffect(() => {
    if (isLoading) return;
    if (restoredRef.current) return;  // 防止重复执行
    restoredRef.current = true;

    const requestedActiveSessionId = resolvePrioritySessionId(
      persistedSessions.map((session) => ({
        id: session.sessionId,
        backendSessionId: session.backendSessionId ?? null,
      })),
      connectionPrioritySessionId,
    );
    const persistedSelection = getValidPersistedActiveSessionId(persistedSessions, persistedActiveId);
    const nextActiveSessionId = selectConnectionForegroundSessionId({
      prioritySessionId: connectionPriorityReady ? requestedActiveSessionId : null,
      activeSessionId: null,
      persistedActiveSessionId: persistedSelection,
      firstSessionId: persistedSessions[0]?.sessionId ?? null,
    });

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
      const restoredActiveSessionId = nextActiveSessionId || runtimeSessions[0]?.id || null;
      setActiveSessionId(restoredActiveSessionId);
      logSwiperState('[swiper:restore-complete]', {
        restoredSessionIds: runtimeSessions.map((session) => session.id),
        nextActiveSessionId: restoredActiveSessionId,
      });
    }

    const finalize = async () => {
      // 没有任何 session 时，在 isRestoring=false 之前同步等待创建完成，
      // 确保外部 effect 不会同时触发创建。
      if (runtimeSessions.length === 0) {
        await handleNewSessionRef.current?.({ createIfEmpty: true });
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
    connectionPriorityReady,
    connectionPrioritySessionId,
  ]);

  // Notification priority may arrive asynchronously from the service worker's
  // Cache Storage fallback. Tabs can already be painted, but connection startup
  // stays gated until this effect selects the requested session.
  useEffect(() => {
    if (!connectionPriorityReady || isRestoring || sessions.length === 0) return;
    const requestedSessionId = resolvePrioritySessionId(
      sessions.map((session) => ({ id: session.id, backendSessionId: session.sessionId })),
      connectionPrioritySessionId,
    );
    const nextSessionId = selectConnectionForegroundSessionId({
      prioritySessionId: requestedSessionId,
      activeSessionId: activeSessionIdRef.current,
      persistedActiveSessionId: persistedForegroundSessionId,
      firstSessionId: sessions[0]?.id ?? null,
    });
    if (nextSessionId && nextSessionId !== activeSessionIdRef.current) {
      setActiveSessionId(nextSessionId);
    }
  }, [connectionPriorityReady, connectionPrioritySessionId, isRestoring, persistedForegroundSessionId, sessions]);

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
        createIfEmpty: options?.createIfEmpty === true,
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
      const command = options?.command?.trim();
      if (command) {
        await sendTerminalInput(terminalSession.sessionId, `${command}\r`);
      }
      return nextSession.id;
    } catch (error) {
      console.error('[Session] Failed to create new session:', error);
      return null;
    }
  }, [defaultSessionMode, defaultTmuxSessionName, activeSessionId, openSession, debugSession]);
  handleNewSessionRef.current = handleNewSession;

  const activateSplitPane = useCallback((
    sessionId: string,
    options: { preserveMobileKeyboard?: boolean } = {},
  ) => {
    const previousSessionId = activeSessionIdRef.current;
    const shouldKeepKeyboardOpen = !!previousSessionId &&
      keyboardOpenBySessionRef.current[previousSessionId] === true;
    setActiveSessionId(sessionId);
    if (isMobileRef.current && options.preserveMobileKeyboard === false) {
      suppressMobileKeyboardOpenUntilRef.current = Date.now() + 600;
      if (previousSessionId) {
        keyboardOpenBySessionRef.current[previousSessionId] = false;
      }
      setMobileKeyboardOpenSessionId(null);
      setFocusTransferRequest(null);
      const activeElement = document.activeElement;
      if (
        activeElement instanceof HTMLTextAreaElement &&
        activeElement.closest('.terminal-viewport-container')
      ) {
        activeElement.blur();
      }
      return;
    }
    if (shouldKeepKeyboardOpen && isMobileRef.current) {
      setMobileKeyboardOpenSessionId(sessionId);
    }
    if (terminalFocusAvailableRef.current && (!isMobileRef.current || shouldKeepKeyboardOpen)) {
      setFocusTransferRequest({ sessionId, token: Date.now() });
    }
  }, []);

  const openSplitChooser = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
    setSplitChooserOpen(true);
    setSplitNotice(null);
  }, []);

  const pairWithExistingSession = useCallback((secondaryId: string) => {
    const primaryId = activeSessionIdRef.current;
    if (!primaryId || primaryId === secondaryId) return;
    setSplitWorkspaces((current) => combineSplitWorkspaces(current, primaryId, secondaryId));
    setSplitChooserOpen(false);
    activateSplitPane(primaryId, { preserveMobileKeyboard: false });
  }, [activateSplitPane]);

  const createSessionInSplit = useCallback(async () => {
    const primaryId = activeSessionIdRef.current;
    if (!primaryId || isCreatingSplitSession) return;
    setIsCreatingSplitSession(true);
    const cwd = useTerminalStore.getState().sessions.get(primaryId)?.cwd ?? undefined;
    const secondaryId = await handleNewSession({
      cwd: cwd || undefined,
      mode: defaultSessionMode,
    });
    setIsCreatingSplitSession(false);
    if (!secondaryId) {
      setSplitNotice(t('common.error'));
      return;
    }
    setSplitWorkspaces((current) => combineSplitWorkspaces(current, primaryId, secondaryId));
    setSplitChooserOpen(false);
    activateSplitPane(primaryId, { preserveMobileKeyboard: false });
  }, [activateSplitPane, defaultSessionMode, handleNewSession, isCreatingSplitSession, t]);

  const closeSplitWorkspace = useCallback((focusSessionId?: string) => {
    setSplitWorkspaces((current) => removeSplitWorkspaceForSession(current, focusSessionId));
    if (focusSessionId) {
      activateSplitPane(focusSessionId, { preserveMobileKeyboard: false });
    }
  }, [activateSplitPane]);

  const removeSplitPane = useCallback((sessionId: string) => {
    setSplitWorkspaces((current) => removeSessionFromSplitWorkspace(current, sessionId));
    activateSplitPane(sessionId, { preserveMobileKeyboard: false });
  }, [activateSplitPane]);

  const startSplitResize = useCallback((
    event: React.PointerEvent<HTMLButtonElement>,
    container: HTMLDivElement,
    vertical: boolean,
    workspaceId: string,
    dividerIndex: number,
    trackKind: 'linear' | 'grid-columns' | 'grid-rows' = 'linear',
    trackCount?: number,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const divider = event.currentTarget;
    const pointerId = event.pointerId;
    const pointerStart = { x: event.clientX, y: event.clientY };
    divider.setPointerCapture?.(pointerId);
    const rect = container.getBoundingClientRect();
    let dragging = !isMobileLayout;
    let longPressTimer: number | null = null;

    const update = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      if (!dragging) {
        const distance = Math.hypot(
          pointerEvent.clientX - pointerStart.x,
          pointerEvent.clientY - pointerStart.y,
        );
        if (distance > MOBILE_SPLIT_MOVE_CANCEL_PX && longPressTimer !== null) {
          window.clearTimeout(longPressTimer);
          longPressTimer = null;
        }
        return;
      }
      pointerEvent.preventDefault();
      const pointerRatio = vertical
        ? (pointerEvent.clientY - rect.top) / rect.height
        : (pointerEvent.clientX - rect.left) / rect.width;
      const dimension = vertical ? rect.height : rect.width;
      const minPanePx = isMobileLayout
        ? 0
        : vertical
          ? DESKTOP_SPLIT_MIN_HEIGHT_PX
          : DESKTOP_SPLIT_MIN_WIDTH_PX;
      setSplitWorkspaces((current) => current.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;
        const resolvedTrackCount = trackCount ?? workspace.sessionIds.length;
        const sourceRatios = trackKind === 'grid-columns'
          ? workspace.gridColumnRatios
          : trackKind === 'grid-rows'
            ? workspace.gridRowRatios
            : workspace.ratios;
        const ratios = normalizeRatios(sourceRatios, resolvedTrackCount);
        const pairTotal = ratios[dividerIndex]! + ratios[dividerIndex + 1]!;
        const minimumRatio = minPanePx > 0
          ? Math.min(pairTotal / 2, minPanePx / Math.max(1, dimension))
          : Math.min(pairTotal / 2, MOBILE_MIN_SPLIT_RATIO);
        const resizedRatios = resizeAdjacentRatios(ratios, dividerIndex, pointerRatio, minimumRatio);
        if (trackKind === 'grid-columns') return { ...workspace, gridColumnRatios: resizedRatios };
        if (trackKind === 'grid-rows') return { ...workspace, gridRowRatios: resizedRatios };
        return { ...workspace, ratios: resizedRatios };
      }));
    };
    const stop = () => {
      if (longPressTimer !== null) {
        window.clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      window.removeEventListener('pointermove', update);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      divider.classList.remove('bg-primary');
      if (isMobileLayout) {
        document.dispatchEvent(new CustomEvent('termdock:gesture-lock', { detail: { locked: false } }));
      }
      splitDragCleanupRef.current = null;
    };
    splitDragCleanupRef.current?.();
    splitDragCleanupRef.current = stop;
    window.addEventListener('pointermove', update);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);

    if (isMobileLayout) {
      document.dispatchEvent(new CustomEvent('termdock:gesture-lock', { detail: { locked: true } }));
      longPressTimer = window.setTimeout(() => {
        longPressTimer = null;
        dragging = true;
        divider.classList.add('bg-primary');
        navigator.vibrate?.(8);
      }, MOBILE_SPLIT_LONG_PRESS_MS);
    }
  }, [isMobileLayout]);

  // Handle session switching from custom event
  const handleSwitchSession = useCallback((sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    if (session) {
      if (sessionId === activeSessionIdRef.current) return;
      setDeferredViewportSessionIds((current) => {
        if (current.has(sessionId)) return current;
        const next = new Set(current);
        next.add(sessionId);
        return next;
      });
      setPendingSwitchSessionId(sessionId);
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
    const nextActiveSessionId = pickSessionAfterClose(arranged, sessionId, (candidate) => candidate.id);

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
        // Shell close path: close the backend terminal wrapper session.
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
      setActiveSessionId(nextActiveSessionId);
      return updated;
    });

    // Remove from persistence
    void removePersistedSession(sessionId, nextActiveSessionId);
    delete keyboardOpenBySessionRef.current[sessionId];

    debugSession('[Session] Closed session:', { sessionId, closeMode });
  }, [sessions, arranged, removePersistedSession, debugSession]);

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

    const handleFocusActiveSessionEvent = () => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId || isMobileRef.current) return;
      setFocusTransferRequest({ sessionId, token: Date.now() });
    };

    const handleOpenSplitChooserEvent = (event: Event) => {
      const customEvent = event as CustomEvent<string>;
      if (!customEvent.detail) return;
      openSplitChooser(customEvent.detail);
    };

    const handleCloseSplitEvent = (event: Event) => {
      const requestedSessionId = (event as CustomEvent<string | undefined>).detail;
      closeSplitWorkspace(requestedSessionId ?? activeSessionIdRef.current ?? undefined);
    };

    const handleRemoveSplitPaneEvent = (event: Event) => {
      const sessionId = (event as CustomEvent<string>).detail;
      if (sessionId) removeSplitPane(sessionId);
    };

    const handleSetSplitDirectionEvent = (event: Event) => {
      const detail = (event as CustomEvent<SplitLayout | { sessionId?: string; layout?: SplitLayout }>).detail;
      const layout = typeof detail === 'string' ? detail : detail?.layout;
      const sessionId = typeof detail === 'string' ? activeSessionIdRef.current : detail?.sessionId;
      if (layout !== 'horizontal' && layout !== 'vertical' && layout !== 'grid') return;
      setSplitWorkspaces((current) => current.map((workspace) => (
        workspace.sessionIds.includes(sessionId ?? '') ? { ...workspace, layout } : workspace
      )));
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

    const handleReorderSplitWorkspaceEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId?: string; sessionIds?: string[] }>).detail;
      if (!detail?.workspaceId || !Array.isArray(detail.sessionIds)) return;
      setSplitWorkspaces((current) => reorderSplitWorkspaceSessions(
        current,
        detail.workspaceId!,
        detail.sessionIds!,
      ));
    };

    const handleRenameSplitWorkspaceEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId?: string; name?: string }>).detail;
      if (!detail?.workspaceId || typeof detail.name !== 'string') return;
      setSplitWorkspaces((current) => renameSplitWorkspace(current, detail.workspaceId!, detail.name!));
    };

    const handleCombineSplitSessionsEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ primaryId?: string; secondaryId?: string }>).detail;
      if (!detail?.primaryId || !detail.secondaryId || detail.primaryId === detail.secondaryId) return;
      setSplitWorkspaces((current) => combineSplitWorkspaces(current, detail.primaryId!, detail.secondaryId!));
      activateSplitPane(detail.primaryId, { preserveMobileKeyboard: false });
    };

    window.addEventListener('new-terminal-session', handleNewSessionEvent);
    window.addEventListener('switch-terminal-session', handleSwitchSessionEvent);
    window.addEventListener('focus-active-terminal-session', handleFocusActiveSessionEvent);
    window.addEventListener('open-terminal-split-chooser', handleOpenSplitChooserEvent);
    window.addEventListener('close-terminal-split', handleCloseSplitEvent);
    window.addEventListener('remove-terminal-split-pane', handleRemoveSplitPaneEvent);
    window.addEventListener('set-terminal-split-direction', handleSetSplitDirectionEvent);
    window.addEventListener('cycle-terminal-session', handleCycleSessionEvent);
    window.addEventListener('close-terminal-session', handleCloseSessionEvent);
    window.addEventListener('close-terminal-session-by-backend', handleCloseSessionByBackendIdEvent);
    window.addEventListener('rename-terminal-session', handleRenameSessionEvent);
    window.addEventListener('reset-terminal-session-name', handleResetSessionNameEvent);
    window.addEventListener('reorder-terminal-session', handleReorderSessionEvent);
    window.addEventListener('reorder-terminal-split-workspace', handleReorderSplitWorkspaceEvent);
    window.addEventListener('rename-terminal-split-workspace', handleRenameSplitWorkspaceEvent);
    window.addEventListener('combine-terminal-split-sessions', handleCombineSplitSessionsEvent);

    return () => {
      window.removeEventListener('new-terminal-session', handleNewSessionEvent);
      window.removeEventListener('switch-terminal-session', handleSwitchSessionEvent);
      window.removeEventListener('focus-active-terminal-session', handleFocusActiveSessionEvent);
      window.removeEventListener('open-terminal-split-chooser', handleOpenSplitChooserEvent);
      window.removeEventListener('close-terminal-split', handleCloseSplitEvent);
      window.removeEventListener('remove-terminal-split-pane', handleRemoveSplitPaneEvent);
      window.removeEventListener('set-terminal-split-direction', handleSetSplitDirectionEvent);
      window.removeEventListener('cycle-terminal-session', handleCycleSessionEvent);
      window.removeEventListener('close-terminal-session', handleCloseSessionEvent);
      window.removeEventListener('close-terminal-session-by-backend', handleCloseSessionByBackendIdEvent);
      window.removeEventListener('rename-terminal-session', handleRenameSessionEvent);
      window.removeEventListener('reset-terminal-session-name', handleResetSessionNameEvent);
      window.removeEventListener('reorder-terminal-session', handleReorderSessionEvent);
      window.removeEventListener('reorder-terminal-split-workspace', handleReorderSplitWorkspaceEvent);
      window.removeEventListener('rename-terminal-split-workspace', handleRenameSplitWorkspaceEvent);
      window.removeEventListener('combine-terminal-split-sessions', handleCombineSplitSessionsEvent);
    };
  }, [activateSplitPane, handleNewSession, handleSwitchSession, openSplitChooser, closeSplitWorkspace, removeSplitPane, handleCloseSession, handleCloseSessionByBackendId, handleRenameSession, handleResetSessionName, handleReorderSessions]);

  useEffect(() => {
    if (!activeSplitWorkspace || isMobileLayout) return;
    const handleSplitShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;

      const directionMatches =
        activeSplitWorkspace.layout === 'horizontal'
          ? event.key === 'ArrowLeft' || event.key === 'ArrowRight'
          : activeSplitWorkspace.layout === 'vertical'
            ? event.key === 'ArrowUp' || event.key === 'ArrowDown'
            : event.key.startsWith('Arrow');
      if (directionMatches) {
        event.preventDefault();
        event.stopPropagation();
        const activeIndex = activeSplitWorkspace.sessionIds.indexOf(activeSessionIdRef.current ?? '');
        const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
        const targetIndex = (Math.max(0, activeIndex) + delta + activeSplitWorkspace.sessionIds.length)
          % activeSplitWorkspace.sessionIds.length;
        const targetId = activeSplitWorkspace.sessionIds[targetIndex];
        if (!targetId) return;
        activateSplitPane(targetId);
        return;
      }

      if (event.key === 'Backspace') {
        event.preventDefault();
        event.stopPropagation();
        closeSplitWorkspace(activeSessionIdRef.current ?? undefined);
      }
    };
    window.addEventListener('keydown', handleSplitShortcut, true);
    return () => window.removeEventListener('keydown', handleSplitShortcut, true);
  }, [activateSplitPane, activeSplitWorkspace, closeSplitWorkspace, isMobileLayout]);

  // 注意：以前这里有 `if (isRestoring) { 全屏 spinner }`，但它在两种场景下都很烦：
  // 1. PWA 从后台返回（iOS 会把页面踢出内存重新加载）：每次都看一遍全屏 loading
  // 2. 真·首次启动：也是 1-3s 蜂窝 RTT 的全屏 loading
  // 现在 useSessionPersistence 走 localStorage 缓存命中时 isRestoring 几乎是
  // 瞬间 false，UI 直接渲染；缓存未命中且服务端确实没有会话时，restore 阶段
  // 只走一次 createIfEmpty，由服务端保证多客户端并发时只创建同一条默认会话。

  const getSessionLabel = (session: TerminalSession): { primary: string; secondary: string | null } => {
    const state = useTerminalStore.getState().sessions.get(session.id);
    return getSessionDisplayLines(
      session,
      state?.activeProgram ?? null,
      state?.cwd ?? null,
      undefined,
      state?.shellTitle ?? null,
      state?.promptState ?? null,
    );
  };

  const renderTerminal = (
    session: TerminalSession,
    options: {
      suppressKeyboard?: boolean;
      keyboardPortalTarget?: HTMLElement | null;
      sharedMobileKeyboardLayout?: boolean;
      suppressPageFlipRefresh?: boolean;
      hidden?: boolean;
      containerStyle?: React.CSSProperties;
    } = {},
  ) => {
    const isActive = session.id === activeSessionId;
    const isLayoutVisible = visibleSessionIds.has(session.id) && !options.hidden;
    const shouldMountViewport = connectionPriorityReady && shouldMountSessionViewport({
      sessionId: session.id,
      foregroundSessionId,
      visibleSessionIds,
      deferredViewportSessionIds,
    });
    const initialConnectEnabled = shouldStartInitialConnection({
      sessionId: session.id,
      foregroundSessionId,
      foregroundReady: foregroundConnectionReady,
    }) && connectionPriorityReady;
    const resumeRequestEnabled = shouldRunResumeRequest({
      sessionId: session.id,
      foregroundSessionId,
      requestToken: resumeRequest.token,
      foregroundCompletedToken: foregroundResumeCompletedToken,
    }) && connectionPriorityReady;
    const initialConnectDelayMs = session.id === foregroundSessionId
      ? 0
      : backgroundResumeDelayBySessionId.get(session.id) ?? BACKGROUND_RESUME_INITIAL_DELAY_MS;
    return (
      <div
        key={session.id}
        className={`relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden ${
          options.hidden ? 'invisible pointer-events-none' : ''
        }`}
        style={options.containerStyle}
        aria-hidden={options.hidden || undefined}
        onPointerDown={() => {
          if (!isActive) activateSplitPane(session.id);
        }}
        onWheelCapture={() => {
          // A trackpad/mouse wheel does not emit pointerdown. Activate during
          // capture so this same wheel event reaches xterm as foreground input
          // instead of being discarded by TerminalView's inactive-session gate.
          activateSplitPaneForWheel(isActive, () => activateSplitPane(session.id));
        }}
      >
        <div className="min-h-0 flex-1 app-chrome-bg">
          {shouldMountViewport && <TerminalView
            sessionId={session.id}
            mode={session.mode}
            tmuxSessionName={session.tmuxSessionName}
            terminalSettings={terminalSettings}
            colorTheme={colorTheme}
            toolbarPresets={toolbarPresets}
            isActive={isActive}
            isLayoutVisible={isLayoutVisible}
            initialConnectEnabled={initialConnectEnabled}
            resumeRequestEnabled={resumeRequestEnabled}
            suppressKeyboard={options.suppressKeyboard}
            keyboardPortalTarget={options.keyboardPortalTarget}
            sharedMobileKeyboardLayout={options.sharedMobileKeyboardLayout}
            suppressPageFlipRefresh={options.suppressPageFlipRefresh}
            focusRequestToken={focusTransferRequest?.sessionId === session.id ? focusTransferRequest.token : 0}
            resumeRequestToken={resumeRequest.token}
            resumeRequestReason={resumeRequest.reason}
            forceResumeReconnect={resumeRequest.forceForegroundReconnect && session.id === foregroundSessionId}
            resumeRequestDelayMs={session.id === foregroundSessionId
              ? 0
              : options.hidden
                ? BACKGROUND_RESUME_INITIAL_DELAY_MS
                : backgroundResumeDelayBySessionId.get(session.id) ?? BACKGROUND_RESUME_INITIAL_DELAY_MS}
            initialConnectDelayMs={initialConnectDelayMs}
            onStreamReadyChange={handleStreamReadyChange}
            onStreamConnected={handleStreamConnected}
            onViewportReadyChange={handleViewportReadyChange}
            onKeyboardVisibilityChange={handleKeyboardVisibilityChange}
            showDebug={showDebug}
            onStatusChange={isActive ? onStatusChange : undefined}
          />}
        </div>
      </div>
    );
  };

  return (
    <div className="relative h-full flex flex-col">
      {tmuxRecovery && (
        <section
          className="fixed inset-x-3 top-[calc(var(--safe-top-inset)+0.75rem)] z-toast mx-auto max-w-lg rounded-2xl border border-warning/30 bg-surface-elevated px-4 py-3.5 shadow-[0_20px_60px_var(--app-shadow-strong)]"
          role="alert"
          aria-live="assertive"
        >
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-warning/15 text-warning">
              <AlertTriangle size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-[13px] font-semibold text-foreground">
                {t('tab.tmuxRecoveryTitle', { count: tmuxRecovery.sessions.length })}
              </h2>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                {t('tab.tmuxRecoveryHint')}
              </p>
              <p className="mt-1.5 truncate text-[10px] text-foreground/70">
                {tmuxRecovery.sessions.map((session) => session.name).join(' · ')}
              </p>
              {tmuxRecoveryError && (
                <p className="mt-2 text-[10px] text-destructive">{tmuxRecoveryError}</p>
              )}
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  disabled={tmuxRecoveryPending !== null}
                  onClick={() => void handleRestoreAllTmuxAgents()}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-[11px] font-medium text-primary-foreground transition active:opacity-80 disabled:opacity-50"
                >
                  <RotateCcw size={13} className={tmuxRecoveryPending === 'restore' ? 'animate-spin' : ''} />
                  {tmuxRecoveryPending === 'restore'
                    ? t('tab.tmuxRecoveryRestoring')
                    : t('tab.tmuxRecoveryRestoreAll')}
                </button>
                <button
                  type="button"
                  disabled={tmuxRecoveryPending !== null}
                  onClick={() => void handleDismissTmuxRecovery()}
                  className="inline-flex min-h-9 items-center rounded-lg px-3 text-[11px] text-muted-foreground transition hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
                >
                  {t('tab.tmuxRecoveryDismiss')}
                </button>
              </div>
            </div>
          </div>
        </section>
      )}
      <div className="flex-1 overflow-hidden">
        <Swiper
          onSwiper={(instance) => {
            swiperRef.current = instance;
            instance.allowTouchMove = workspaceSlides.length > 1 && !sidebarOverlayOpen && !splitChooserOpen;
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
          {workspaceSlides.map((slide) => {
            const workspace = slide.workspace;
            const isSplit = !!workspace && slide.sessions.length >= 2;
            const effectiveLayout: SplitLayout = isMobileLayout
              ? !isMobileLandscape
                ? 'vertical'
                : 'horizontal'
              : workspace?.layout ?? 'horizontal';
            const verticalSplit = effectiveLayout === 'vertical';
            const ratios = workspace?.ratios.length === slide.sessions.length
              ? workspace.ratios
              : equalRatios(slide.sessions.length);
            const keyboardFocusSessionIndex = mobileKeyboardOpenSessionId
              ? slide.sessions.findIndex((session) => session.id === mobileKeyboardOpenSessionId)
              : -1;
            const mobileKeyboardFocusMode = isMobileLayout && mobileKeyboardOpenSessionId
              ? slide.sessions.some((session) => session.id === mobileKeyboardOpenSessionId)
              : false;
            const splitToolbarOwnerId = slide.sessions.some((session) => session.id === activeSessionId)
              ? activeSessionId
              : slide.sessions[0]?.id;
            const linearTracks = ratios.flatMap((ratio, index) => [
              mobileKeyboardFocusMode && index !== keyboardFocusSessionIndex ? '0px' : `minmax(0, ${ratio}fr)`,
              ...(index < ratios.length - 1 ? [mobileKeyboardFocusMode ? '0px' : '1px'] : []),
            ]).join(' ');
            const { columns: gridColumns, rows: gridRows } = getSplitGridDimensions(slide.sessions.length);
            const gridColumnRatios = normalizeRatios(workspace?.gridColumnRatios, gridColumns);
            const gridRowRatios = normalizeRatios(workspace?.gridRowRatios, gridRows);
            const gridColumnDividerOffsets = gridColumnRatios
              .slice(0, -1)
              .map((_, index) => gridColumnRatios.slice(0, index + 1).reduce((sum, ratio) => sum + ratio, 0));
            const gridRowDividerOffsets = gridRowRatios
              .slice(0, -1)
              .map((_, index) => gridRowRatios.slice(0, index + 1).reduce((sum, ratio) => sum + ratio, 0));
            const gridLastRowCount = slide.sessions.length % gridColumns;
            const splitGridStyle: React.CSSProperties = {
              ...(effectiveLayout === 'grid'
                ? {
                    gridTemplateColumns: gridColumnRatios.map((ratio) => `minmax(0, ${ratio}fr)`).join(' '),
                    gridTemplateRows: gridRowRatios.map((ratio) => `minmax(0, ${ratio}fr)`).join(' '),
                    gap: '1px',
                  }
                : verticalSplit
                  ? { gridTemplateRows: linearTracks }
                  : { gridTemplateColumns: linearTracks }),
              ...(isMobileLayout
                ? {
                    marginTop: 'var(--kb-margin-top, 0px)',
                    transition: 'none',
                  }
                : {}),
            };
            return (
              <SwiperSlide
                key={slide.key}
                className="h-full"
              >
                <div
                  className="h-full min-w-0"
                  data-pinned-right-sidebar-inset={pinnedRightSidebarInsetBySlideKey.get(slide.key) ?? 0}
                  style={{ paddingRight: pinnedRightSidebarInsetBySlideKey.get(slide.key) ?? 0 }}
                >
                  {isSplit ? (
                    <div
                      className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--chrome-bg)]"
                      style={isMobileLayout
                        ? {
                            transform: 'translateY(var(--kb-translate-y, 0px))',
                            transition: 'none',
                          }
                        : undefined
                      }
                    >
                    <div
                      data-split-container="true"
                      className="relative grid min-h-0 min-w-0 flex-1 overflow-hidden"
                      style={splitGridStyle}
                    >
                      {slide.sessions.map((session, index) => (
                        <React.Fragment key={session.id}>
                          {renderTerminal(session, {
                            suppressKeyboard: isMobileLayout && session.id !== splitToolbarOwnerId,
                            keyboardPortalTarget: isMobileLayout ? splitKeyboardPortalTarget : null,
                            sharedMobileKeyboardLayout: isMobileLayout,
                            suppressPageFlipRefresh: true,
                            hidden: mobileKeyboardFocusMode && keyboardFocusSessionIndex !== index,
                            containerStyle: effectiveLayout === 'grid'
                              && gridLastRowCount > 0
                              && index === slide.sessions.length - 1
                              ? { gridColumn: `span ${gridColumns - gridLastRowCount + 1}` }
                              : undefined,
                          })}
                          {effectiveLayout !== 'grid' && index < slide.sessions.length - 1 && workspace && (
                            <button
                              type="button"
                              className={`swiper-no-swiping relative z-20 touch-none select-none bg-[var(--border-strong)] transition-colors hover:bg-primary active:bg-primary ${
                                verticalSplit ? 'cursor-row-resize' : 'cursor-col-resize'
                              } ${mobileKeyboardFocusMode ? 'invisible pointer-events-none' : ''}`}
                              onPointerDownCapture={(event) => {
                                const container = event.currentTarget.closest('[data-split-container="true"]');
                                if (container instanceof HTMLDivElement) {
                                  startSplitResize(event, container, verticalSplit, workspace.id, index);
                                }
                              }}
                              onDoubleClick={(event) => {
                                if (isMobileLayout) return;
                                event.preventDefault();
                                event.stopPropagation();
                                setSplitWorkspaces((current) => current.map((candidate) => (
                                  candidate.id === workspace.id
                                    ? { ...candidate, ratios: equalRatios(candidate.sessionIds.length) }
                                    : candidate
                                )));
                              }}
                              onContextMenu={(event) => {
                                if (isMobileLayout) event.preventDefault();
                              }}
                              aria-label={t('tab.split')}
                            >
                              <span
                                aria-hidden="true"
                                data-split-divider-hitarea="true"
                                className={`absolute ${verticalSplit ? 'inset-x-0' : 'inset-y-0'}`}
                                style={verticalSplit
                                  ? { top: -MOBILE_SPLIT_HIT_SLOP_PX, bottom: -MOBILE_SPLIT_HIT_SLOP_PX }
                                  : { left: -MOBILE_SPLIT_HIT_SLOP_PX, right: -MOBILE_SPLIT_HIT_SLOP_PX }
                                }
                              />
                            </button>
                          )}
                        </React.Fragment>
                      ))}
                      {effectiveLayout === 'grid' && workspace && gridColumnDividerOffsets.map((offset, index) => (
                        <button
                          key={`grid-column-divider:${index}`}
                          type="button"
                          data-split-grid-column-divider={index}
                          className="swiper-no-swiping absolute top-0 z-20 w-px -translate-x-1/2 touch-none select-none cursor-col-resize bg-[var(--border-strong)] transition-colors hover:bg-primary active:bg-primary"
                          style={{
                            left: `${offset * 100}%`,
                            bottom: gridLastRowCount === 0 || index < gridLastRowCount - 1
                              ? 0
                              : `${(gridRowRatios.at(-1) ?? 0) * 100}%`,
                          }}
                          onPointerDownCapture={(event) => {
                            const container = event.currentTarget.closest('[data-split-container="true"]');
                            if (container instanceof HTMLDivElement) {
                              startSplitResize(event, container, false, workspace.id, index, 'grid-columns', gridColumns);
                            }
                          }}
                          onDoubleClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setSplitWorkspaces((current) => current.map((candidate) => (
                              candidate.id === workspace.id
                                ? { ...candidate, gridColumnRatios: equalRatios(gridColumns) }
                                : candidate
                            )));
                          }}
                          aria-label={t('tab.split')}
                        >
                          <span
                            aria-hidden="true"
                            data-split-divider-hitarea="true"
                            className="absolute inset-y-0"
                            style={{ left: -MOBILE_SPLIT_HIT_SLOP_PX, right: -MOBILE_SPLIT_HIT_SLOP_PX }}
                          />
                        </button>
                      ))}
                      {effectiveLayout === 'grid' && workspace && gridRowDividerOffsets.map((offset, index) => (
                        <button
                          key={`grid-row-divider:${index}`}
                          type="button"
                          data-split-grid-row-divider={index}
                          className="swiper-no-swiping absolute inset-x-0 z-20 h-px -translate-y-1/2 touch-none select-none cursor-row-resize bg-[var(--border-strong)] transition-colors hover:bg-primary active:bg-primary"
                          style={{ top: `${offset * 100}%` }}
                          onPointerDownCapture={(event) => {
                            const container = event.currentTarget.closest('[data-split-container="true"]');
                            if (container instanceof HTMLDivElement) {
                              startSplitResize(event, container, true, workspace.id, index, 'grid-rows', gridRows);
                            }
                          }}
                          onDoubleClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setSplitWorkspaces((current) => current.map((candidate) => (
                              candidate.id === workspace.id
                                ? { ...candidate, gridRowRatios: equalRatios(gridRows) }
                                : candidate
                            )));
                          }}
                          aria-label={t('tab.split')}
                        >
                          <span
                            aria-hidden="true"
                            data-split-divider-hitarea="true"
                            className="absolute inset-x-0"
                            style={{ top: -MOBILE_SPLIT_HIT_SLOP_PX, bottom: -MOBILE_SPLIT_HIT_SLOP_PX }}
                          />
                        </button>
                      ))}
                    </div>
                    {isMobileLayout && (
                      <div
                        ref={setSplitKeyboardPortalTarget}
                        className="relative shrink-0 app-chrome-bg"
                        data-split-keyboard-host="true"
                      />
                    )}
                    </div>
                  ) : renderTerminal(slide.sessions[0]!)}
                </div>
              </SwiperSlide>
            );
          })}
        </Swiper>
      </div>

      {splitChooserOpen && activeSessionId && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-modal-backdrop bg-[var(--app-backdrop-soft)] backdrop-blur-sm"
            onClick={() => setSplitChooserOpen(false)}
            aria-label={t('common.close')}
          />
          <section
            className="fixed inset-x-3 bottom-3 z-modal-panel mx-auto max-h-[min(78svh,620px)] max-w-md overflow-hidden rounded-2xl border border-border/20 bg-surface shadow-[0_24px_70px_var(--app-shadow-strong)] sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2"
            style={{ paddingBottom: 'var(--safe-bottom-inset)' }}
            role="dialog"
            aria-modal="true"
            aria-label={t('tab.splitTitle')}
          >
            <header className="flex items-start gap-3 border-b border-border/20 px-4 py-3.5">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                <Columns2 size={17} />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-[14px] font-semibold text-foreground">{t('tab.splitTitle')}</h2>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                  {t('tab.splitExistingHint')}
                </p>
              </div>
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-surface-2 hover:text-foreground"
                onClick={() => setSplitChooserOpen(false)}
                aria-label={t('common.close')}
              >
                <X size={16} />
              </button>
            </header>

            <div className="max-h-[calc(min(78svh,620px)-72px)] overflow-y-auto overscroll-contain p-2">
              <button
                type="button"
                disabled={isCreatingSplitSession}
                onClick={() => void createSessionInSplit()}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition hover:bg-surface-2 active:bg-surface-elevated disabled:opacity-60"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                  <Plus size={17} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-foreground">{t('tab.splitNew')}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">{t('tab.splitNewHint')}</span>
                </span>
              </button>

              {splitWorkspaces.filter((workspace) => workspace.id !== activeSplitWorkspace?.id).length > 0 && (
                <>
                  <div className="px-3 pb-1 pt-3 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                    {t('tab.splitExistingGroups')}
                  </div>
                  {splitWorkspaces.filter((workspace) => workspace.id !== activeSplitWorkspace?.id).map((workspace, workspaceIndex) => {
                    const members = workspace.sessionIds.flatMap((id) => {
                      const member = sessions.find((session) => session.id === id);
                      return member ? [member] : [];
                    });
                    if (members.length < 2) return null;
                    const workspaceName = workspace.name || `${t('tab.splitWorkspace')} ${workspaceIndex + 1}`;
                    const memberSummary = members.map((member) => getSessionLabel(member).primary).join(' · ');
                    return (
                      <button
                        key={workspace.id}
                        type="button"
                        onClick={() => pairWithExistingSession(members[0]!.id)}
                        className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-surface-2 active:bg-surface-elevated"
                      >
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <Columns2 size={15} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">{workspaceName}</span>
                            <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                              {t('tab.splitOccupied')}
                            </span>
                          </span>
                          <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                            {t('tab.sessionCount', { count: members.length })} · {memberSummary}
                          </span>
                        </span>
                        <Check size={14} className="text-primary opacity-0 transition group-hover:opacity-100" />
                      </button>
                    );
                  })}
                </>
              )}

              <div className="px-3 pb-1 pt-3 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                {t('tab.splitAvailableSessions')}
              </div>
              {sessions.filter((session) => !splitWorkspaces.some((workspace) => workspace.sessionIds.includes(session.id)) && session.id !== activeSessionId).length === 0
                && splitWorkspaces.filter((workspace) => workspace.id !== activeSplitWorkspace?.id).length === 0 ? (
                <p className="px-3 py-4 text-[12px] text-muted-foreground">{t('tab.splitNoOtherSessions')}</p>
              ) : sessions.filter((session) => !splitWorkspaces.some((workspace) => workspace.sessionIds.includes(session.id)) && session.id !== activeSessionId).map((session) => {
                const sessionCwd = cwdById.get(session.id) ?? null;
                const label = getSessionLabel(session);
                return (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => pairWithExistingSession(session.id)}
                    className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-surface-2 active:bg-surface-elevated"
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted-foreground">
                      {sessionCwd ? <Folder size={15} /> : <Columns2 size={15} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium text-foreground">{label.primary}</span>
                      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                        {sessionCwd ? (getCwdLeafName(sessionCwd) ?? sessionCwd) : session.name}
                      </span>
                    </span>
                    <Check size={14} className="text-primary opacity-0 transition group-hover:opacity-100" />
                  </button>
                );
              })}
            </div>
          </section>
        </>
      )}

      {splitNotice && (
        <div className="fixed inset-x-3 bottom-4 z-toast mx-auto max-w-md rounded-xl border border-border/20 bg-surface-elevated px-4 py-3 text-center text-[12px] text-foreground shadow-lg">
          {splitNotice}
        </div>
      )}
    </div>
  );
};
