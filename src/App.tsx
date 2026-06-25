import React, { useEffect, useCallback, useState } from 'react';
import { MultiTerminalView, type TerminalSessionInfo } from './lib/components/MultiTerminalView';
import {
  Plus as RiAddLine,
  X as RiCloseLine,
  PanelLeft as RiPanelLeftLine,
  PanelRight as RiPanelRightLine,
  LayoutGrid as RiLayoutGridLine,
  RefreshCw as RiRefreshLine,
  Terminal as RiTerminalLine,
  PenLine as RiPencilLine,
  Keyboard as RiKeyboardLine,
  SlidersHorizontal as RiEqualizerLine,
  Layers as RiStackLine,
  Trash2 as RiDeleteBinLine,
  Unplug as RiLogoutBoxRLine,
  Bot as RiBotLine,
  Bell as RiBellLine,
  ChevronRight as RiChevronRightLine,
  Loader2 as RiLoaderLine,
  Moon as RiMoonLine,
  Sun as RiSunLine,
} from 'lucide-react';
import { DragDropContext, Droppable, Draggable, type DropResult, type DraggableProvidedDragHandleProps } from '@hello-pangea/dnd';
import { useTerminalSettings } from './lib/hooks/useTerminalSettings';
import { useViewportHeight } from './lib/hooks/useViewportHeight';
import { useNewSessionDefaults } from './lib/hooks/useNewSessionDefaults';
import type { TerminalSessionState, TmuxSessionSummary, TmuxStatus } from './lib/terminal/types';
import { getCwdLeafName, getSessionDisplayLines, deriveGroupedOrder, reorderGroupedSessionIds, reorderSessionsWithinGroup } from './lib/terminal/display';
import type { TerminalRendererMode } from './lib/terminal/renderer';
import { getTmuxStatus, killTmuxSession, listTmuxSessions, getToolbarPresetsDoc, replaceToolbarPresetsDoc, logout, getSettings, updateSettings, getAgentRules, replaceAgentRules, resetAgentRules, getProgramRules, replaceProgramRules, resetProgramRules, getProgramDetection, replaceProgramDetection, resetProgramDetection } from './lib/terminal/api';
import type { AgentProgramConfig, ProgramLabelRule, ProgramDetectionConfig, LocalAccessState } from './lib/terminal/api';
import { readCache, writeCache, shallowJsonEqual } from './lib/utils/localStorageCache';
import {
  getStoredPwaAiNotificationsEnabled,
  getStoredPwaNotificationAlertStyle,
  getPwaNotificationPermission,
  getStoredPwaNotificationsEnabled,
  isPwaNotificationSupported,
  requestPwaNotificationPermission,
  setStoredPwaAiNotificationsEnabled,
  setStoredPwaNotificationAlertStyle,
  setStoredPwaNotificationsEnabled,
  showPwaNotification,
  type PwaNotificationAlertStyle,
} from './lib/utils/pwaNotifications';
import { useTerminalStore } from './lib/stores/useTerminalStore';
import { useSidebarStore } from './lib/stores/useSidebarStore';
import { useI18n } from './lib/i18n';
import { LeftSidebar } from './lib/components/sidebar/LeftSidebar';
import { RightSidebar } from './lib/components/sidebar/RightSidebar';
import { AgentTabIcon, AgentCountBadge, AgentCompactStatusOverlay } from './lib/components/AgentIndicators';
import { ToolbarPresetSettings } from './lib/components/settings/ToolbarPresetSettings';
import { AgentRulesSettings } from './lib/components/settings/AgentRulesSettings';
import { BUILTIN_TOOLBAR_PRESETS_VERSION, createDefaultToolbarPresets, getBuiltinToolbarPresetIds, sanitizeToolbarPresets, type ToolbarPresetDefinition } from './lib/components/terminal/mobileKeyboardPresets';
import type { TermdockColorTheme } from './lib/terminal/theme';

// Cache keys for app-level lazy data fetched from the server. 缓存只是"上次看到"的
// 快照，每次启动还是会发 HTTP 校准；命中时让 UI 不再闪烁默认值 → 自定义值。
const AGENT_RULES_CACHE_KEY = 'termdock-agent-rules-cache';
const PROGRAM_RULES_CACHE_KEY = 'termdock-program-rules-cache';
const TOOLBAR_PRESETS_CACHE_KEY = 'termdock-toolbar-presets-cache';
const SETTINGS_CACHE_KEY = 'termdock-settings-cache';
const COLOR_THEME_CACHE_KEY = 'termdock-color-theme';
const DESKTOP_TAB_MENU_WIDTH = 320;
const DESKTOP_TAB_MENU_MAX_HEIGHT = 420;
const DESKTOP_TAB_MENU_GAP = 8;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getDesktopTabMenuPosition(anchor: { x: number; y: number } | null): React.CSSProperties {
  if (typeof window === 'undefined') {
    return { left: DESKTOP_TAB_MENU_GAP, top: DESKTOP_TAB_MENU_GAP };
  }
  const fallbackX = window.innerWidth / 2;
  const fallbackY = Math.min(64, window.innerHeight / 4);
  const sourceX = anchor?.x ?? fallbackX;
  const sourceY = anchor?.y ?? fallbackY;
  const maxLeft = Math.max(DESKTOP_TAB_MENU_GAP, window.innerWidth - DESKTOP_TAB_MENU_WIDTH - DESKTOP_TAB_MENU_GAP);
  const maxTop = Math.max(DESKTOP_TAB_MENU_GAP, window.innerHeight - DESKTOP_TAB_MENU_MAX_HEIGHT - DESKTOP_TAB_MENU_GAP);
  return {
    left: clampNumber(sourceX + DESKTOP_TAB_MENU_GAP, DESKTOP_TAB_MENU_GAP, maxLeft),
    top: clampNumber(sourceY + DESKTOP_TAB_MENU_GAP, DESKTOP_TAB_MENU_GAP, maxTop),
    width: DESKTOP_TAB_MENU_WIDTH,
    maxHeight: `min(${DESKTOP_TAB_MENU_MAX_HEIGHT}px, calc(100vh - ${DESKTOP_TAB_MENU_GAP * 2}px))`,
  };
}

function isTermdockColorTheme(v: unknown): v is TermdockColorTheme {
  return v === 'dark' || v === 'light';
}

function isAgentRulesArray(v: unknown): v is AgentProgramConfig[] {
  return Array.isArray(v) && v.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const cfg = entry as { program?: unknown; programs?: unknown; rules?: unknown };
    const hasLegacyProgram = typeof cfg.program === 'string';
    const hasPrograms = Array.isArray(cfg.programs) && cfg.programs.every((item) => typeof item === 'string');
    return (hasLegacyProgram || hasPrograms) && Array.isArray(cfg.rules);
  });
}

function isProgramRulesArray(v: unknown): v is ProgramLabelRule[] {
  return Array.isArray(v) && v.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const rule = entry as Partial<ProgramLabelRule>;
    return typeof rule.id === 'string'
      && typeof rule.pattern === 'string'
      && typeof rule.output === 'string'
      && (rule.matchType === 'exact' || rule.matchType === 'includes' || rule.matchType === 'prefix' || rule.matchType === 'regex');
  });
}

interface ToolbarPresetsCacheDoc {
  version: number;
  presets: ToolbarPresetDefinition[];
}
function isToolbarPresetsCacheDoc(v: unknown): v is ToolbarPresetsCacheDoc {
  return typeof v === 'object' && v !== null &&
    typeof (v as { version?: unknown }).version === 'number' &&
    Array.isArray((v as { presets?: unknown }).presets);
}

interface SettingsCacheDoc {
  preventSleep: boolean;
  networkAvailable: boolean;
  localAccess?: LocalAccessState;
}
function isSettingsCacheDoc(v: unknown): v is SettingsCacheDoc {
  return typeof v === 'object' && v !== null &&
    typeof (v as { preventSleep?: unknown }).preventSleep === 'boolean' &&
    typeof (v as { networkAvailable?: unknown }).networkAvailable === 'boolean';
}

const DEFAULT_LOCAL_ACCESS: LocalAccessState = {
  name: '',
  source: 'auto',
  hostname: '',
  fallbackHostname: '',
  url: '',
  fallbackUrl: '',
  onboardingUrl: null,
  status: 'disabled',
  reason: null,
  httpsEnabled: false,
  caAvailable: false,
  lanAddresses: [],
  interfaces: [],
};
const HISTORY_OVERLAY_STATE_KEY = '__termdockOverlay';
const HISTORY_BASE_ANCHOR_STATE_KEY = '__termdockBaseAnchor';
const HISTORY_BASE_GUARD_STATE_KEY = '__termdockBaseGuard';
const BASE_HISTORY_GUARD_BUFFER_SIZE = 3;
const BASE_HISTORY_GUARD_REARM_DELAY_MS = 250;
type HistoryOverlay = 'left-sidebar' | 'right-sidebar' | 'settings';

function reportHistoryGuardDebug(message: string, data: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return;
  const payload = JSON.stringify({
    level: 'info',
    message: `DEBUG_HistoryBack ${message}`,
    data: {
      ...data,
      href: window.location.href,
      historyLength: window.history.length,
      historyState: window.history.state,
      visibilityState: typeof document === 'undefined' ? null : document.visibilityState,
      userAgent: window.navigator.userAgent,
      ts: Date.now(),
    },
  });
  try {
    const blob = new Blob([payload], { type: 'application/json' });
    if (window.navigator.sendBeacon?.('/api/client-log', blob)) {
      return;
    }
  } catch {
    // ignore and fall back to fetch
  }
  void fetch('/api/client-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => undefined);
}

function isHistoryOverlay(value: unknown): value is HistoryOverlay {
  return value === 'left-sidebar' || value === 'right-sidebar' || value === 'settings';
}

function getHistoryOverlay(state: unknown): HistoryOverlay | null {
  if (!state || typeof state !== 'object') return null;
  const value = (state as Record<string, unknown>)[HISTORY_OVERLAY_STATE_KEY];
  return isHistoryOverlay(value) ? value : null;
}

function toHistoryStateObject(state: unknown): Record<string, unknown> {
  return state && typeof state === 'object' ? { ...(state as Record<string, unknown>) } : {};
}

function withoutHistoryOverlay(state: unknown): Record<string, unknown> {
  const next = toHistoryStateObject(state);
  delete next[HISTORY_OVERLAY_STATE_KEY];
  return next;
}

function toBaseHistoryAnchorState(state: unknown): Record<string, unknown> {
  const next = withoutHistoryOverlay(state);
  delete next[HISTORY_BASE_GUARD_STATE_KEY];
  return {
    ...next,
    [HISTORY_BASE_ANCHOR_STATE_KEY]: true,
  };
}

function pushBaseHistoryGuard(): void {
  if (typeof window === 'undefined') return;
  reportHistoryGuardDebug('pushBaseHistoryGuard:before');
  window.history.pushState(
    {
      ...withoutHistoryOverlay(window.history.state),
      [HISTORY_BASE_ANCHOR_STATE_KEY]: true,
      [HISTORY_BASE_GUARD_STATE_KEY]: true,
    },
    '',
    window.location.href,
  );
  reportHistoryGuardDebug('pushBaseHistoryGuard:after');
}

function pushBaseHistoryGuardBuffer(): void {
  reportHistoryGuardDebug('pushBaseHistoryGuardBuffer:start', { size: BASE_HISTORY_GUARD_BUFFER_SIZE });
  for (let index = 0; index < BASE_HISTORY_GUARD_BUFFER_SIZE; index += 1) {
    pushBaseHistoryGuard();
  }
  reportHistoryGuardDebug('pushBaseHistoryGuardBuffer:end', { size: BASE_HISTORY_GUARD_BUFFER_SIZE });
}

function ensureBaseHistoryGuard(): void {
  if (typeof window === 'undefined') return;
  reportHistoryGuardDebug('ensureBaseHistoryGuard:before');
  window.history.replaceState(
    toBaseHistoryAnchorState(window.history.state),
    '',
    window.location.href,
  );
  pushBaseHistoryGuardBuffer();
  reportHistoryGuardDebug('ensureBaseHistoryGuard:after');
}

function pushHistoryOverlay(overlay: HistoryOverlay): void {
  if (typeof window === 'undefined') return;
  reportHistoryGuardDebug('pushHistoryOverlay:before', { overlay });
  window.history.pushState(
    {
      ...toHistoryStateObject(window.history.state),
      [HISTORY_BASE_ANCHOR_STATE_KEY]: true,
      [HISTORY_OVERLAY_STATE_KEY]: overlay,
      [HISTORY_BASE_GUARD_STATE_KEY]: false,
    },
    '',
    window.location.href,
  );
  reportHistoryGuardDebug('pushHistoryOverlay:after', { overlay });
}

function replaceHistoryOverlay(overlay: HistoryOverlay): void {
  if (typeof window === 'undefined') return;
  reportHistoryGuardDebug('replaceHistoryOverlay:before', { overlay });
  window.history.replaceState(
    {
      ...toHistoryStateObject(window.history.state),
      [HISTORY_BASE_ANCHOR_STATE_KEY]: true,
      [HISTORY_OVERLAY_STATE_KEY]: overlay,
      [HISTORY_BASE_GUARD_STATE_KEY]: false,
    },
    '',
    window.location.href,
  );
  reportHistoryGuardDebug('replaceHistoryOverlay:after', { overlay });
}
// Default shell names for initial render — overridden once the server responds
// with the actual config. Kept in sync with the backend DEFAULT_PROGRAM_DETECTION.shellNames.
const DEFAULT_SHELL_NAMES = ['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'nu'];
let SHELL_NAMES = new Set(DEFAULT_SHELL_NAMES);

type TabTerminalSessionState = Pick<
  TerminalSessionState,
  | 'cwd'
  | 'activeProgram'
  | 'activeProgramRaw'
  | 'inCopyMode'
  | 'isConnecting'
  | 'agentStatus'
  | 'agentColor'
  | 'agentIndicator'
  | 'agentNeedsReview'
>;

function pickTabTerminalSessions(
  source: Map<string, TerminalSessionState>,
): Map<string, TabTerminalSessionState> {
  const picked = new Map<string, TabTerminalSessionState>();
  for (const [id, state] of source) {
    picked.set(id, {
      cwd: state.cwd,
      activeProgram: state.activeProgram,
      activeProgramRaw: state.activeProgramRaw,
      inCopyMode: state.inCopyMode,
      isConnecting: state.isConnecting,
      agentStatus: state.agentStatus,
      agentColor: state.agentColor,
      agentIndicator: state.agentIndicator,
      agentNeedsReview: state.agentNeedsReview,
    });
  }
  return picked;
}

function areTabTerminalSessionsEqual(
  current: Map<string, TabTerminalSessionState>,
  next: Map<string, TabTerminalSessionState>,
): boolean {
  if (current.size !== next.size) return false;

  for (const [id, nextState] of next) {
    const currentState = current.get(id);
    if (!currentState) return false;
    if (
      currentState.cwd !== nextState.cwd ||
      currentState.activeProgram !== nextState.activeProgram ||
      currentState.activeProgramRaw !== nextState.activeProgramRaw ||
      currentState.inCopyMode !== nextState.inCopyMode ||
      currentState.isConnecting !== nextState.isConnecting ||
      currentState.agentStatus !== nextState.agentStatus ||
      currentState.agentColor !== nextState.agentColor ||
      currentState.agentIndicator !== nextState.agentIndicator ||
      currentState.agentNeedsReview !== nextState.agentNeedsReview
    ) {
      return false;
    }
  }

  return true;
}

function renderTabIcon(
  sessionMode: 'shell' | 'tmux',
  state?: TabTerminalSessionState,
): React.ReactNode {
  return <AgentTabIcon sessionMode={sessionMode} state={state} />;
}

interface CloseSessionEventDetail {
  sessionId: string;
  source?: 'sidebar' | 'tab-menu' | 'other';
  closeMode?: 'auto' | 'detach' | 'destroy';
}

function reorderSessionsByIds<T extends { id: string }>(items: T[], orderedIds: string[]): T[] {
  const idToItem = new Map(items.map((item) => [item.id, item]));
  const reordered = orderedIds
    .map((id) => idToItem.get(id))
    .filter((item): item is T => item !== undefined);
  const covered = new Set(orderedIds);
  const remaining = items.filter((item) => !covered.has(item.id));
  return [...reordered, ...remaining];
}

function App() {
  const { t, locale, setLocale } = useI18n();
  const safeTopInset = 'env(safe-area-inset-top, 0px)';
  const safeBottomInset = 'env(safe-area-inset-bottom, 0px)';

  useViewportHeight();

  const [showDebug, setShowDebug] = React.useState(false);
  const [colorTheme, setColorTheme] = React.useState<TermdockColorTheme>(() =>
    readCache(COLOR_THEME_CACHE_KEY, isTermdockColorTheme) ?? 'dark',
  );
  // Hydrate settings from cache so the toggles show user's real choice on cold
  // start instead of flashing the defaults until the HTTP fetch resolves.
  const cachedSettings = React.useRef<SettingsCacheDoc | null>(readCache(SETTINGS_CACHE_KEY, isSettingsCacheDoc)).current;
  const [preventSleep, setPreventSleep] = React.useState(cachedSettings?.preventSleep ?? false);
  const [networkAvailable, setNetworkAvailable] = React.useState(cachedSettings?.networkAvailable ?? true);
  const [pwaNotificationsEnabled, setPwaNotificationsEnabled] = React.useState(getStoredPwaNotificationsEnabled);
  const [pwaAiNotificationsEnabled, setPwaAiNotificationsEnabled] = React.useState(getStoredPwaAiNotificationsEnabled);
  const [pwaNotificationAlertStyle, setPwaNotificationAlertStyle] = React.useState<PwaNotificationAlertStyle>(getStoredPwaNotificationAlertStyle);
  const [pwaNotificationPermission, setPwaNotificationPermission] = React.useState(getPwaNotificationPermission);
  const [localAccess, setLocalAccess] = React.useState<LocalAccessState>(cachedSettings?.localAccess ?? DEFAULT_LOCAL_ACCESS);
  const [localAccessNameInput, setLocalAccessNameInput] = React.useState(cachedSettings?.localAccess?.name ?? '');
  const [localAccessSaving, setLocalAccessSaving] = React.useState(false);
  const [localAccessError, setLocalAccessError] = React.useState<string | null>(null);
  const [localAccessCopied, setLocalAccessCopied] = React.useState<string | null>(null);
  const [showBackGuardHint, setShowBackGuardHint] = React.useState(false);
  const backGuardHintTimerRef = React.useRef<number | null>(null);
  const [debugInfo, setDebugInfo] = React.useState<Record<string, any>>({});
  const { terminalSettings, updateTerminalSettings } = useTerminalSettings();
  const fontSize = terminalSettings.fontSize;
  const rendererMode = terminalSettings.rendererMode;
  const [isDrawerOpen, setIsDrawerOpen] = React.useState(false);
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(null);
  // Only re-render the chrome when tab metadata changes, not on every terminal output chunk.
  const [terminalSessions, setTerminalSessions] = useState(() =>
    pickTabTerminalSessions(useTerminalStore.getState().sessions),
  );

  useEffect(() => {
    return useTerminalStore.subscribe((state) => {
      const next = pickTabTerminalSessions(state.sessions);
      setTerminalSessions((current) => (
        areTabTerminalSessionsEqual(current, next) ? current : next
      ));
    });
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = colorTheme;
    writeCache(COLOR_THEME_CACHE_KEY, colorTheme);
  }, [colorTheme]);

  // Per-session xterm scrollback + tab metadata cache 已撤回：高频写 + 多种边界
  // （clearBuffer 写空、setTerminalSession reset、auto-recreate 路径等）导致缓存
  // 经常被脏写，xterm 首帧反而经常拿到空内容。等想清楚每一种状态变迁该不该入缓存
  // 之前，先不做这一层。设置 / 工具栏 / agent rules 这种简单 KV 缓存继续保留。

  // Sidebar state — only subscribe to the booleans we render, not the whole store.
  const sidebarLeftOpen = useSidebarStore((s) => s.leftOpen);
  const sidebarRightOpen = useSidebarStore((s) => s.rightOpen);
  const groupByFolder = useSidebarStore((s) => s.groupByFolder);
  const collapsedGroups = useSidebarStore((s) => s.collapsedGroups);
  const toggleGroupCollapsed = useSidebarStore((s) => s.toggleGroupCollapsed);
  const [isDesktopViewport, setIsDesktopViewport] = useState(() => (
    typeof window === 'undefined' ? true : window.matchMedia('(min-width: 1024px)').matches
  ));
  // Landscape orientation. A phone in landscape (typically 667-896px wide)
  // has plenty of room for a wide workbench-style drawer, even though
  // its *short* side is < 1024px so the regular desktop check returns
  // false. We re-derive the drawer width when orientation flips so the
  // layout upgrades immediately after the user rotates the device.
  const [isLandscape, setIsLandscape] = useState(() => (
    typeof window === 'undefined' ? false : window.matchMedia('(orientation: landscape)').matches
  ));

  const [tmuxSessions, setTmuxSessions] = useState<TmuxSessionSummary[]>([]);
  const [tmuxStatus, setTmuxStatus] = useState<TmuxStatus>({ available: true, version: null, reason: null });
  const [tmuxRefreshing, setTmuxRefreshing] = useState(false);
  const [tmuxConfirmKillName, setTmuxConfirmKillName] = useState<string | null>(null);
  const [tmuxKillingName, setTmuxKillingName] = useState<string | null>(null);
  const [tmuxKillError, setTmuxKillError] = useState<string | null>(null);
  const [tmuxAttachingName, setTmuxAttachingName] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [tabMenuSessionId, setTabMenuSessionId] = useState<string | null>(null);
  const [tabMenuAnchor, setTabMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const [tabCopiedHint, setTabCopiedHint] = useState<string | null>(null);
  const [sidebarCloseChoiceSessionId, setSidebarCloseChoiceSessionId] = useState<string | null>(null);
  const renameInputRef = React.useRef<HTMLInputElement | null>(null);
  const activeSessionTabRef = React.useRef<HTMLDivElement | null>(null);
  const closeTabMenu = useCallback(() => {
    setTabMenuSessionId(null);
    setTabMenuAnchor(null);
  }, []);
  // 通知点击 / SW postMessage 请求聚焦的目标 session。会话列表可能还没恢复完，
  // 先记在 ref 里，等对应 session 出现在列表里再 dispatch 切换。
  const pendingFocusSessionRef = React.useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(min-width: 1024px)');
    const updateViewportMode = () => setIsDesktopViewport(media.matches);
    updateViewportMode();
    media.addEventListener('change', updateViewportMode);
    return () => media.removeEventListener('change', updateViewportMode);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(orientation: landscape)');
    const updateOrientation = () => setIsLandscape(media.matches);
    updateOrientation();
    media.addEventListener('change', updateOrientation);
    return () => media.removeEventListener('change', updateOrientation);
  }, []);

  // Sync active session's cwd to sidebar store
  useEffect(() => {
    const ts = activeSessionId ? terminalSessions.get(activeSessionId) : null;
    useSidebarStore.getState().setRootPath(ts?.cwd ?? null);
  }, [activeSessionId, terminalSessions]);

  // Sidebar drawer dimensions — overlays on both mobile & desktop, so we
  // never cause the terminal column to resize when toggling the sidebar.
  // Left and right have different ergonomic widths:
  //  - Right (file tree + diff): wide so we can fit a dual-column workspace.
  //  - Left  (session list):     narrow; one row per session is enough.
  //
  // Landscape phones get the desktop-sized right drawer so the diff
  // viewer can show its full workbench (file list + diff + hunk
  // outline) instead of the cramped single-column mobile layout. The
  // device's *short* side is < 1024px so the regular desktop check
  // returns false — the orientation check is what tells us there's
  // enough horizontal real estate for a wide drawer.
  const useDesktopDrawer = isDesktopViewport || isLandscape;
  const viewportWidth = typeof window === 'undefined' ? 1024 : window.innerWidth;
  const rightDrawerWidthPx = useDesktopDrawer
    ? Math.min(Math.max(viewportWidth * 0.9, 360), viewportWidth - 56)
    : Math.min(viewportWidth * 0.92, 420);
  const leftDrawerWidthPx = useDesktopDrawer
    ? Math.min(Math.max(viewportWidth * 0.22, 280), 340)
    : Math.min(viewportWidth * 0.86, 380);

  const activeHistoryOverlay: HistoryOverlay | null = isDrawerOpen
    ? 'settings'
    : sidebarRightOpen
      ? 'right-sidebar'
      : sidebarLeftOpen
        ? 'left-sidebar'
        : null;
  const activeHistoryOverlayRef = React.useRef<HistoryOverlay | null>(activeHistoryOverlay);
  const lastHistoryOverlayRef = React.useRef<HistoryOverlay | null>(activeHistoryOverlay);
  const closingFromPopStateRef = React.useRef(false);
  const baseHistoryGuardArmedByUserRef = React.useRef(false);

  const closeHistoryOverlayDirect = useCallback((overlay: HistoryOverlay) => {
    if (overlay === 'settings') {
      setIsDrawerOpen(false);
      setIsToolbarPresetsOpen(false);
      setIsNotificationsOpen(false);
      setIsAgentRulesOpen(false);
      return;
    }
    if (overlay === 'left-sidebar') {
      useSidebarStore.getState().closeLeft();
      return;
    }
    useSidebarStore.getState().closeRight();
  }, []);

  const requestCloseHistoryOverlay = useCallback((overlay: HistoryOverlay) => {
    if (typeof window !== 'undefined'
      && activeHistoryOverlayRef.current === overlay
      && getHistoryOverlay(window.history.state) === overlay) {
      window.history.back();
      return;
    }
    closeHistoryOverlayDirect(overlay);
  }, [closeHistoryOverlayDirect]);

  const handleOpenLeftSidebar = useCallback(() => {
    setIsDrawerOpen(false);
    const sidebar = useSidebarStore.getState();
    sidebar.closeRight();
    sidebar.openLeft();
  }, []);

  const handleOpenRightSidebar = useCallback(() => {
    setIsDrawerOpen(false);
    const sidebar = useSidebarStore.getState();
    sidebar.closeLeft();
    sidebar.openRight();
  }, []);

  const handleOpenRightSearch = useCallback(() => {
    setIsDrawerOpen(false);
    const sidebar = useSidebarStore.getState();
    sidebar.closeLeft();
    sidebar.openRight();
    sidebar.setRightTab('files');
    sidebar.openRightSearch();
  }, []);

  const handleToggleLeftSidebar = useCallback(() => {
    if (sidebarLeftOpen) {
      requestCloseHistoryOverlay('left-sidebar');
      return;
    }
    handleOpenLeftSidebar();
  }, [handleOpenLeftSidebar, requestCloseHistoryOverlay, sidebarLeftOpen]);

  const handleToggleRightSidebar = useCallback(() => {
    if (sidebarRightOpen) {
      requestCloseHistoryOverlay('right-sidebar');
      return;
    }
    handleOpenRightSidebar();
  }, [handleOpenRightSidebar, requestCloseHistoryOverlay, sidebarRightOpen]);

  const handleOpenSettings = useCallback(() => {
    if (typeof window !== 'undefined'
      && activeHistoryOverlayRef.current
      && getHistoryOverlay(window.history.state) === activeHistoryOverlayRef.current) {
      replaceHistoryOverlay('settings');
      lastHistoryOverlayRef.current = 'settings';
    }
    useSidebarStore.getState().closeAll();
    setIsDrawerOpen(true);
  }, []);

  const handleCloseSettings = useCallback(() => {
    requestCloseHistoryOverlay('settings');
  }, [requestCloseHistoryOverlay]);

  const showMainBackGuardHint = useCallback(() => {
    setShowBackGuardHint(true);
    if (backGuardHintTimerRef.current !== null) {
      window.clearTimeout(backGuardHintTimerRef.current);
      backGuardHintTimerRef.current = null;
    }
  }, []);

  const handleContinueAfterBackGuard = useCallback(() => {
    reportHistoryGuardDebug('continueAfterBackGuard:click');
    if (backGuardHintTimerRef.current !== null) {
      window.clearTimeout(backGuardHintTimerRef.current);
      backGuardHintTimerRef.current = null;
    }
    setShowBackGuardHint(false);
    baseHistoryGuardArmedByUserRef.current = true;
    ensureBaseHistoryGuard();
    reportHistoryGuardDebug('continueAfterBackGuard:rearmed', { armedByUser: baseHistoryGuardArmedByUserRef.current });
  }, []);

  useEffect(() => () => {
    if (backGuardHintTimerRef.current !== null) {
      window.clearTimeout(backGuardHintTimerRef.current);
    }
  }, []);

  useEffect(() => {
    ensureBaseHistoryGuard();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    let rearmTimer: number | null = null;
    const clearRearmTimer = () => {
      if (rearmTimer !== null) {
        window.clearTimeout(rearmTimer);
        rearmTimer = null;
      }
    };
    const rearmBaseHistoryGuard = (options?: { force?: boolean; userActivated?: boolean }) => {
      reportHistoryGuardDebug('rearmBaseHistoryGuard:called', {
        options: options ?? null,
        activeOverlay: activeHistoryOverlayRef.current,
        armedByUser: baseHistoryGuardArmedByUserRef.current,
      });
      if (activeHistoryOverlayRef.current) {
        reportHistoryGuardDebug('rearmBaseHistoryGuard:skip-active-overlay', { activeOverlay: activeHistoryOverlayRef.current });
        return;
      }
      if (!options?.force && baseHistoryGuardArmedByUserRef.current) {
        reportHistoryGuardDebug('rearmBaseHistoryGuard:skip-already-armed');
        return;
      }
      if (options?.userActivated) {
        baseHistoryGuardArmedByUserRef.current = true;
      }
      ensureBaseHistoryGuard();
      reportHistoryGuardDebug('rearmBaseHistoryGuard:done', { armedByUser: baseHistoryGuardArmedByUserRef.current });
    };
    const rearmBaseHistoryGuardSoon = () => {
      reportHistoryGuardDebug('rearmBaseHistoryGuardSoon:schedule');
      clearRearmTimer();
      rearmTimer = window.setTimeout(() => {
        rearmTimer = null;
        reportHistoryGuardDebug('rearmBaseHistoryGuardSoon:fire');
        rearmBaseHistoryGuard({ force: true });
      }, BASE_HISTORY_GUARD_REARM_DELAY_MS);
    };
    const handleUserActivation = () => {
      reportHistoryGuardDebug('userActivation', { type: 'pointer/touch/key' });
      rearmBaseHistoryGuard({ userActivated: true });
    };
    const handlePageShow = () => {
      reportHistoryGuardDebug('pageshow');
      rearmBaseHistoryGuardSoon();
    };
    const handleVisibilityChange = () => {
      reportHistoryGuardDebug('visibilitychange', { visibilityState: document.visibilityState });
      if (document.visibilityState === 'visible') {
        rearmBaseHistoryGuardSoon();
      }
    };

    window.addEventListener('pointerdown', handleUserActivation, { capture: true, passive: true });
    window.addEventListener('touchstart', handleUserActivation, { capture: true, passive: true });
    window.addEventListener('keydown', handleUserActivation, { capture: true });
    window.addEventListener('pageshow', handlePageShow);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearRearmTimer();
      window.removeEventListener('pointerdown', handleUserActivation, { capture: true });
      window.removeEventListener('touchstart', handleUserActivation, { capture: true });
      window.removeEventListener('keydown', handleUserActivation, { capture: true });
      window.removeEventListener('pageshow', handlePageShow);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    activeHistoryOverlayRef.current = activeHistoryOverlay;
    reportHistoryGuardDebug('activeHistoryOverlayRef:update', { activeHistoryOverlay });
  }, [activeHistoryOverlay]);

  useEffect(() => {
    if (typeof window === 'undefined' || activeHistoryOverlay) return;
    reportHistoryGuardDebug('mainPageRearm:schedule', { activeHistoryOverlay });
    const rearmTimer = window.setTimeout(() => {
      if (!activeHistoryOverlayRef.current) {
        reportHistoryGuardDebug('mainPageRearm:fire');
        ensureBaseHistoryGuard();
      } else {
        reportHistoryGuardDebug('mainPageRearm:skip-active-overlay', { activeOverlay: activeHistoryOverlayRef.current });
      }
    }, BASE_HISTORY_GUARD_REARM_DELAY_MS);
    return () => window.clearTimeout(rearmTimer);
  }, [activeHistoryOverlay]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const previousOverlay = lastHistoryOverlayRef.current;
    reportHistoryGuardDebug('overlayEffect', { activeHistoryOverlay, previousOverlay, closingFromPopState: closingFromPopStateRef.current });
    if (activeHistoryOverlay && activeHistoryOverlay !== previousOverlay && !closingFromPopStateRef.current) {
      pushHistoryOverlay(activeHistoryOverlay);
    }
    lastHistoryOverlayRef.current = activeHistoryOverlay;

    if (!activeHistoryOverlay && closingFromPopStateRef.current) {
      window.setTimeout(() => {
        closingFromPopStateRef.current = false;
      }, 0);
    }
  }, [activeHistoryOverlay]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handlePopState = () => {
      const overlay = activeHistoryOverlayRef.current;
      reportHistoryGuardDebug('popstate', {
        overlay,
        armedByUser: baseHistoryGuardArmedByUserRef.current,
      });
      if (!overlay) {
        // 本次返回已消耗一个 base guard。重置 latch，让下一次用户交互能重新补上
        // “被信任(user-activated)”的 guard —— popstate 里补的 guard 不带用户激活，
        // Android/Chrome 可能跳过，仅靠它无法持续拦截返回退出。
        baseHistoryGuardArmedByUserRef.current = false;
        reportHistoryGuardDebug('popstate:main-page-guard', { armedByUser: baseHistoryGuardArmedByUserRef.current });
        showMainBackGuardHint();
        pushBaseHistoryGuardBuffer();
        return;
      }
      closingFromPopStateRef.current = true;
      reportHistoryGuardDebug('popstate:close-overlay', { overlay });
      closeHistoryOverlayDirect(overlay);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [closeHistoryOverlayDirect, showMainBackGuardHint]);

  // Desktop keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'b' && !e.shiftKey) {
        e.preventDefault();
        handleToggleLeftSidebar();
      }
      if (mod && e.shiftKey && e.key === 'E') {
        e.preventDefault();
        handleToggleRightSidebar();
      }
      if (mod && e.shiftKey && e.key === 'P') {
        e.preventDefault();
        handleOpenRightSearch();
      }
      // Session 切换：Cmd/Ctrl+Alt+←/→ 或 Cmd/Ctrl+Shift+[/]
      if (mod && !e.shiftKey && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        const direction = e.key === 'ArrowRight' ? 'next' : 'prev';
        window.dispatchEvent(new CustomEvent('cycle-terminal-session', { detail: { direction } }));
        return;
      }
      if (mod && e.shiftKey && !e.altKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        e.preventDefault();
        const direction = e.code === 'BracketRight' ? 'next' : 'prev';
        window.dispatchEvent(new CustomEvent('cycle-terminal-session', { detail: { direction } }));
        return;
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
    };
  }, [handleToggleLeftSidebar, handleToggleRightSidebar, handleOpenRightSearch]);

  const handleSaveLocalAccess = useCallback(async () => {
    setLocalAccessSaving(true);
    setLocalAccessError(null);
    try {
      const result = await updateSettings({ localAccess: { name: localAccessNameInput } });
      setLocalAccess(result.localAccess);
      setLocalAccessNameInput(result.localAccess.name);
      writeCache(SETTINGS_CACHE_KEY, {
        preventSleep: result.preventSleep,
        networkAvailable: result.networkAvailable,
        localAccess: result.localAccess,
      });
    } catch (error) {
      setLocalAccessError(error instanceof Error ? error.message : 'Failed to save local access name');
    } finally {
      setLocalAccessSaving(false);
    }
  }, [localAccessNameInput]);

  const handleResetLocalAccess = useCallback(async () => {
    setLocalAccessSaving(true);
    setLocalAccessError(null);
    try {
      const result = await updateSettings({ localAccess: { reset: true } });
      setLocalAccess(result.localAccess);
      setLocalAccessNameInput(result.localAccess.name);
      writeCache(SETTINGS_CACHE_KEY, {
        preventSleep: result.preventSleep,
        networkAvailable: result.networkAvailable,
        localAccess: result.localAccess,
      });
    } catch (error) {
      setLocalAccessError(error instanceof Error ? error.message : 'Failed to reset local access name');
    } finally {
      setLocalAccessSaving(false);
    }
  }, []);

  const handleCopyText = useCallback(async (value: string | null | undefined, label = 'url') => {
    if (!value) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(value);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setLocalAccessCopied(label);
      window.setTimeout(() => setLocalAccessCopied((current) => current === label ? null : current), 1600);
    } catch {
      setLocalAccessCopied(null);
    }
  }, []);

  const applySessionOrder = useCallback((orderedIds: string[]) => {
    const newOrder = reorderSessionsByIds(sessions, orderedIds);
    if (newOrder.map((session) => session.id).join('\u0000') === sessions.map((session) => session.id).join('\u0000')) {
      return;
    }
    // 乐观更新本地顺序,避免 MultiTerminalView 异步回传期间发生一帧布局回弹
    setSessions(newOrder);
    window.dispatchEvent(new CustomEvent('reorder-terminal-session', {
      detail: { sessionIds: newOrder.map(s => s.id) },
    }));
  }, [sessions]);

  const handleDragEnd = useCallback((result: DropResult) => {
    if (!result.destination || result.source.index === result.destination.index) return;
    const newOrder = [...sessions];
    const [moved] = newOrder.splice(result.source.index, 1);
    newOrder.splice(result.destination.index, 0, moved);
    applySessionOrder(newOrder.map((session) => session.id));
  }, [applySessionOrder, sessions]);

  const renameSession = useCallback((sessionId: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    window.dispatchEvent(new CustomEvent('rename-terminal-session', { detail: { sessionId, name: trimmed } }));
  }, []);

  // 把自定义名称清空回退为「程序名/目录名」默认显示
  const resetSessionName = useCallback((sessionId: string) => {
    window.dispatchEvent(new CustomEvent('reset-terminal-session-name', { detail: { sessionId } }));
  }, []);

  const {
    newSessionMode,
    newSessionTmuxName,
    userSelectedNewSessionMode,
    setNewSessionMode,
  } = useNewSessionDefaults();
  const [newSessionShortcutConfirmMode, setNewSessionShortcutConfirmMode] = useState<'shell' | 'tmux' | null>(null);

  const [isToolbarPresetsOpen, setIsToolbarPresetsOpen] = React.useState(false);
  const [isNotificationsOpen, setIsNotificationsOpen] = React.useState(false);
  // Toolbar presets are owned by the server (~/.termdock/toolbar-presets.json)
  // and shared across every browser pointing at this server. We start with the
  // built-in defaults so the UI is usable on first paint, then load + reconcile
  // with the server state on mount.
  //
  // 缓存：上次从服务端拿到的 presets 也会缓存到 localStorage，下次冷启动同步
  // hydrate，避免短暂出现"内置默认 → 用户自定义"的闪烁。
  const cachedToolbarPresets = React.useRef<ToolbarPresetsCacheDoc | null>(
    readCache(TOOLBAR_PRESETS_CACHE_KEY, isToolbarPresetsCacheDoc)
  ).current;
  const [toolbarPresets, setToolbarPresets] = React.useState<ToolbarPresetDefinition[]>(() => {
    // 注意：必须把 cached 取出来用作 type narrowing，否则 closure 里 cached?.presets
    // ?? [] 在 sanitize 后可能返回非空数组（sanitize 会补默认字段），又会回到 if
    // 分支去用 cached!.presets 引发 null 解引用。直接显式判 null 最稳。
    const cached = cachedToolbarPresets?.presets;
    if (cached && cached.length > 0) {
      const sanitized = sanitizeToolbarPresets(cached);
      if (sanitized.length > 0) return sanitized;
    }
    return createDefaultToolbarPresets();
  });
  const [toolbarPresetsLoaded, setToolbarPresetsLoaded] = React.useState(false);
  const [selectedToolbarPresetId, setSelectedToolbarPresetId] = React.useState<string>('default');

  // Agent detection rules — owned by server (~/.termdock/agent-rules.json)
  // 同样缓存到 localStorage，让 agent 检测在冷启动后立即生效。
  const cachedAgentRules = React.useRef<AgentProgramConfig[] | null>(
    readCache(AGENT_RULES_CACHE_KEY, isAgentRulesArray)
  ).current;
  const [isAgentRulesOpen, setIsAgentRulesOpen] = React.useState(false);
  const [agentRules, setAgentRules] = React.useState<AgentProgramConfig[]>(cachedAgentRules ?? []);
  const [agentRulesLoaded, setAgentRulesLoaded] = React.useState(cachedAgentRules !== null);
  const [agentRulesSaving, setAgentRulesSaving] = React.useState(false);

  const cachedProgramRules = React.useRef<ProgramLabelRule[] | null>(
    readCache(PROGRAM_RULES_CACHE_KEY, isProgramRulesArray)
  ).current;
  const [programRules, setProgramRules] = React.useState<ProgramLabelRule[]>(cachedProgramRules ?? []);
  const [programRulesLoaded, setProgramRulesLoaded] = React.useState(cachedProgramRules !== null);
  const [programRulesSaving, setProgramRulesSaving] = React.useState(false);

  // 全局 ESC：按"返回键"语义，从最里层往外依次关闭浮层。
  // 顺序：通知/工具栏/AI 规则 二级 modal → tab 长按菜单 → settings drawer → 侧边栏。
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (isNotificationsOpen) {
        event.preventDefault();
        setIsNotificationsOpen(false);
        return;
      }
      if (isToolbarPresetsOpen) {
        event.preventDefault();
        setIsToolbarPresetsOpen(false);
        return;
      }
      if (isAgentRulesOpen) {
        event.preventDefault();
        setIsAgentRulesOpen(false);
        return;
      }
      if (tabMenuSessionId) {
        event.preventDefault();
        closeTabMenu();
        return;
      }
      if (isDrawerOpen) {
        event.preventDefault();
        handleCloseSettings();
        return;
      }
      if (sidebarRightOpen) {
        event.preventDefault();
        requestCloseHistoryOverlay('right-sidebar');
        return;
      }
      if (sidebarLeftOpen) {
        event.preventDefault();
        requestCloseHistoryOverlay('left-sidebar');
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [
    isNotificationsOpen,
    isToolbarPresetsOpen,
    isAgentRulesOpen,
    tabMenuSessionId,
    closeTabMenu,
    isDrawerOpen,
    sidebarRightOpen,
    sidebarLeftOpen,
    handleCloseSettings,
    requestCloseHistoryOverlay,
  ]);

  useEffect(() => {
    getAgentRules()
      .then((rules) => {
        // 写缓存；diff 后只在不同才 setState，避免无谓 re-render。
        writeCache(AGENT_RULES_CACHE_KEY, rules);
        setAgentRules((current) => (shallowJsonEqual(current, rules) ? current : rules));
        setAgentRulesLoaded(true);
      })
      .catch(() => { /* use empty state */ });
  }, []);

  useEffect(() => {
    getProgramRules()
      .then((rules) => {
        writeCache(PROGRAM_RULES_CACHE_KEY, rules);
        setProgramRules((current) => (shallowJsonEqual(current, rules) ? current : rules));
        setProgramRulesLoaded(true);
      })
      .catch(() => { /* use empty state */ });
  }, []);

  // Program detection config — single source of truth is the backend;
  // initial state is empty until the server responds.
  const [programDetection, setProgramDetection] = React.useState<ProgramDetectionConfig>({
    genericProgramNames: [],
    wrapperScriptNames: [],
    shellNames: DEFAULT_SHELL_NAMES,
  });
  const [, setProgramDetectionLoaded] = React.useState(false);

  useEffect(() => {
    getProgramDetection()
      .then((config) => {
        setProgramDetection(config);
        SHELL_NAMES = new Set(config.shellNames);
        setProgramDetectionLoaded(true);
      })
      .catch(() => { /* use defaults */ });
  }, []);

  // Initial load from server: merge any stored custom presets with the latest
  // built-ins, force-overwriting built-in ids when the server's stored version
  // is older than BUILTIN_TOOLBAR_PRESETS_VERSION.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const doc = await getToolbarPresetsDoc();
        if (cancelled) return;
        const defaults = createDefaultToolbarPresets();
        const builtinIds = new Set(getBuiltinToolbarPresetIds());
        const rawStoredPresets = Array.isArray(doc.presets) ? (doc.presets as Partial<ToolbarPresetDefinition>[]) : [];
        const stored = sanitizeToolbarPresets(rawStoredPresets);
        const storedVersion = typeof doc.version === 'number' ? doc.version : 0;
        const versionMismatch = storedVersion < BUILTIN_TOOLBAR_PRESETS_VERSION;

        let next: ToolbarPresetDefinition[];
        if (stored.length === 0) {
          next = defaults;
        } else if (versionMismatch) {
          // Replace built-in presets with the latest definitions, but
          // preserve user-customized rowLayout from stored presets.
          const storedMap = new Map(stored.map((p) => [p.id, p]));
          const rawStoredMap = new Map(rawStoredPresets.map((p) => [typeof p.id === 'string' ? p.id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-') : '', p]));
          const customPresets = stored.filter((preset) => !builtinIds.has(preset.id));
          const updatedDefaults = defaults.map((preset) => {
            const existing = storedMap.get(preset.id);
            const rawExisting = rawStoredMap.get(preset.id);
            if (existing) {
              return {
                ...preset,
                rowLayout: existing.rowLayout,
                showOnDesktop: typeof rawExisting?.showOnDesktop === 'boolean'
                  ? rawExisting.showOnDesktop
                  : preset.showOnDesktop,
              };
            }
            return preset;
          });
          next = [...updatedDefaults, ...customPresets];
        } else {
          const storedIds = new Set(stored.map((p) => p.id));
          next = [...stored];
          for (const preset of defaults) {
            if (!storedIds.has(preset.id)) next.push(preset);
          }
        }
        setToolbarPresets((current) => {
          if (shallowJsonEqual(current, next)) return current;
          return next;
        });
        // 缓存最新合成结果，下次冷启动直接 hydrate。
        writeCache(TOOLBAR_PRESETS_CACHE_KEY, {
          version: BUILTIN_TOOLBAR_PRESETS_VERSION,
          presets: next,
        });
      } catch (error) {
        console.warn('[toolbar-presets] Failed to load from server:', error);
      } finally {
        if (!cancelled) setToolbarPresetsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist to the server whenever the in-memory presets change. Skip the
  // initial render before the server load has resolved to avoid clobbering
  // the server doc with the temporary defaults seed.
  useEffect(() => {
    if (!toolbarPresetsLoaded) return;
    // 同步写本地缓存
    writeCache(TOOLBAR_PRESETS_CACHE_KEY, {
      version: BUILTIN_TOOLBAR_PRESETS_VERSION,
      presets: toolbarPresets,
    });
    void replaceToolbarPresetsDoc({
      version: BUILTIN_TOOLBAR_PRESETS_VERSION,
      presets: toolbarPresets,
    }).catch((error) => {
      console.warn('[toolbar-presets] Failed to save to server:', error);
    });
  }, [toolbarPresets, toolbarPresetsLoaded]);

  // Load settings (prevent sleep) from server on mount
  useEffect(() => {
    getSettings()
      .then((s) => {
        setPreventSleep((cur) => (cur === s.preventSleep ? cur : s.preventSleep));
        setNetworkAvailable((cur) => (cur === s.networkAvailable ? cur : s.networkAvailable));
        setLocalAccess(s.localAccess);
        setLocalAccessNameInput(s.localAccess.name);
        writeCache(SETTINGS_CACHE_KEY, {
          preventSleep: s.preventSleep,
          networkAvailable: s.networkAvailable,
          localAccess: s.localAccess,
        });
      })
      .catch(() => { /* ignore — settings not available */ });
  }, []);

  useEffect(() => {
    if (!pwaNotificationsEnabled) return;
    const permission = getPwaNotificationPermission();
    setPwaNotificationPermission(permission);
    if (permission !== 'granted') {
      setPwaNotificationsEnabled(false);
      setStoredPwaNotificationsEnabled(false);
    }
  }, [pwaNotificationsEnabled]);

  const handleTogglePwaNotifications = useCallback(async () => {
    if (pwaNotificationsEnabled) {
      setPwaNotificationsEnabled(false);
      setStoredPwaNotificationsEnabled(false);
      setPwaNotificationPermission(getPwaNotificationPermission());
      return;
    }

    const permission = await requestPwaNotificationPermission();
    setPwaNotificationPermission(permission);
    if (permission !== 'granted') {
      setPwaNotificationsEnabled(false);
      setStoredPwaNotificationsEnabled(false);
      return;
    }

    setPwaNotificationsEnabled(true);
    setStoredPwaNotificationsEnabled(true);
    void showPwaNotification({
      title: 'Termdock',
      body: t('settings.notificationsTestBody'),
      tag: 'termdock-notifications-enabled',
      requireHidden: false,
      data: { url: '/' },
    });
  }, [pwaNotificationsEnabled, t]);

  const handleTogglePwaAiNotifications = useCallback((enabled: boolean) => {
    setPwaAiNotificationsEnabled(enabled);
    setStoredPwaAiNotificationsEnabled(enabled);
  }, []);

  const handleSelectPwaNotificationAlertStyle = useCallback((style: PwaNotificationAlertStyle) => {
    setPwaNotificationAlertStyle(style);
    setStoredPwaNotificationAlertStyle(style);
  }, []);

  useEffect(() => {
    if (!toolbarPresets.some((preset) => preset.id === selectedToolbarPresetId)) {
      setSelectedToolbarPresetId(toolbarPresets[0]?.id ?? 'default');
    }
  }, [selectedToolbarPresetId, toolbarPresets]);

  useEffect(() => {
    if (!tmuxStatus.available && newSessionMode === 'tmux') {
      setNewSessionMode('shell', { userInitiated: false });
      return;
    }
    if (tmuxStatus.available && userSelectedNewSessionMode !== 'shell' && newSessionMode !== 'tmux') {
      setNewSessionMode('tmux', { userInitiated: false });
    }
  }, [newSessionMode, tmuxStatus.available, userSelectedNewSessionMode, setNewSessionMode]);

  useEffect(() => {
    setNewSessionShortcutConfirmMode(null);
  }, [isDrawerOpen, newSessionMode, tmuxStatus.available]);

  useEffect(() => {
    const info: Record<string, any> = {};

    if (typeof navigator !== 'undefined') {
      info.userAgent = navigator.userAgent;
      info.platform = navigator.platform;
      info.maxTouchPoints = navigator.maxTouchPoints;
      info.hasTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
      info.vendor = navigator.vendor;
    }

    if (typeof window !== 'undefined') {
      info.screenWidth = window.innerWidth;
      info.screenHeight = window.innerHeight;
      info.pixelRatio = window.devicePixelRatio;
      info.orientation = window.screen?.orientation?.type || 'unknown';
      info.hasVisualViewport = !!window.visualViewport;
      info.visualViewportHeight = window.visualViewport?.height;
      info.visualViewportWidth = window.visualViewport?.width;
      info.location = window.location.href;
    }

    info.timestamp = new Date().toISOString();
    info.isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    info.isAndroid = /Android/.test(navigator.userAgent);

    setDebugInfo(info);
  }, []);

  // 顶栏 tab 分组（贯穿式胶囊）：groups = 按 cwd 聚拢的组，每组一个胶囊容器。
  const { groups: tabGroups } = React.useMemo(
    () => deriveGroupedOrder(
      sessions,
      (s) => terminalSessions.get(s.id)?.cwd ?? null,
      groupByFolder,
      t('sidebar.ungrouped'),
    ),
    [sessions, terminalSessions, groupByFolder, t],
  );

  // 分组模式下的拖拽：单个 DragDropContext，按 result.type 区分两种拖动。
  //  - type 'group'：整组顺序拖动（组与组之间排序），组内顺序保持不变。
  //  - type 'session'：组内排序；禁止跨组拖动（分组依据是 cwd，跨组无意义）。
  const handleGroupedDragEnd = useCallback((result: DropResult) => {
    if (!result.destination) return;
    if (result.type === 'group') {
      if (result.source.index === result.destination.index) return;
      applySessionOrder(reorderGroupedSessionIds(tabGroups, result.source.index, result.destination.index));
      return;
    }
    // 组内 session 排序：源与目标必须同组。
    if (result.source.droppableId !== result.destination.droppableId) return;
    if (result.source.index === result.destination.index) return;
    const groupKey = result.source.droppableId.replace(/^group-sessions:/, '');
    applySessionOrder(reorderSessionsWithinGroup(tabGroups, groupKey, result.source.index, result.destination.index));
  }, [tabGroups, applySessionOrder]);

  // 位置角标 N/total 按当前可见的分组后顺序算，避免分组时编号与视觉顺序不一致。
  const arrangedSessions = React.useMemo(
    () => tabGroups.length > 0 ? tabGroups.flatMap((group) => group.sessions) : sessions,
    [tabGroups, sessions],
  );
  const activeSessionIndex = activeSessionId
    ? arrangedSessions.findIndex((session) => session.id === activeSessionId)
    : -1;
  const activeSessionPositionLabel = arrangedSessions.length > 0 && activeSessionIndex >= 0
    ? `${activeSessionIndex + 1}/${arrangedSessions.length}`
    : `${arrangedSessions.length}`;
  const agentTabCounts = React.useMemo(() => {
    let running = 0;
    let review = 0;
    for (const s of sessions) {
      const ts = terminalSessions.get(s.id);
      if (ts?.agentStatus === 'running') running += 1;
      if (ts?.agentStatus === 'waiting' || ts?.agentNeedsReview) review += 1;
    }
    return { running, review };
  }, [sessions, terminalSessions]);
  useEffect(() => {
    activeSessionTabRef.current?.scrollIntoView({
      inline: 'center',
      block: 'nearest',
      behavior: 'smooth',
    });
  }, [activeSessionId]);

  useEffect(() => {
    if (editingSessionId && renameInputRef.current) {
      renameInputRef.current.select();
    }
  }, [editingSessionId]);

  const handleTabClick = useCallback((sessionId: string) => {
    window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: sessionId }));
  }, []);

  // 请求聚焦某个 session：若它已在当前会话列表里，立即切换；否则记下来，
  // 等会话恢复 / inventory 同步后由下面的 effect 补发。
  const requestFocusSession = useCallback((sessionId: string | null) => {
    if (!sessionId) return;
    if (sessions.some((s) => s.id === sessionId)) {
      pendingFocusSessionRef.current = null;
      window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: sessionId }));
    } else {
      pendingFocusSessionRef.current = sessionId;
    }
  }, [sessions]);

  // 启动时解析 ?session=<id>（来自通知点击的 SW 导航），切换后清理 query。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const target = params.get('session');
    if (!target) return;
    pendingFocusSessionRef.current = target;
    params.delete('session');
    const nextSearch = params.toString();
    const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`;
    window.history.replaceState(window.history.state, '', nextUrl);
  }, []);

  // 监听 SW 转发的「已有窗口」聚焦消息：点击通知时若 PWA 已开着，SW 走
  // postMessage 而非新开窗口，这里收到后切到目标 session。
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const handler = (event: MessageEvent) => {
      const data = event.data;
      if (data && data.type === 'termdock:focus-session' && typeof data.sessionId === 'string') {
        requestFocusSession(data.sessionId);
      }
    };
    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  }, [requestFocusSession]);

  // 会话列表变化时，补发尚未兑现的聚焦请求（目标 session 刚恢复出来）。
  useEffect(() => {
    const pending = pendingFocusSessionRef.current;
    if (!pending) return;
    if (sessions.some((s) => s.id === pending)) {
      pendingFocusSessionRef.current = null;
      window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: pending }));
    }
  }, [sessions]);

  // 按 tab 顺序列出「需要我处理」的 session（waiting / 跑完待查看）。
  const attentionSessionIds = React.useMemo(() => {
    const ids: string[] = [];
    for (const s of sessions) {
      const ts = terminalSessions.get(s.id);
      if (ts?.agentStatus === 'waiting' || ts?.agentNeedsReview) {
        ids.push(s.id);
      }
    }
    return ids;
  }, [sessions, terminalSessions]);

  // 一键轮转到下一个待处理 session：从当前 active 之后找第一个，环回到列表头。
  const handleJumpToNextAttention = useCallback(() => {
    if (attentionSessionIds.length === 0) return;
    const fromIndex = activeSessionId ? sessions.findIndex((s) => s.id === activeSessionId) : -1;
    const next = attentionSessionIds.find((id) => sessions.findIndex((s) => s.id === id) > fromIndex)
      ?? attentionSessionIds[0];
    if (next) {
      window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: next }));
    }
  }, [attentionSessionIds, sessions, activeSessionId]);

  const copyCwdToClipboard = useCallback(async (sessionId: string) => {
    const ts = useTerminalStore.getState().sessions.get(sessionId);
    const cwd = ts?.cwd;
    if (!cwd) return;
    try {
      await navigator.clipboard?.writeText(cwd);
      setTabCopiedHint(cwd);
      window.setTimeout(() => {
        setTabCopiedHint((current) => (current === cwd ? null : current));
      }, 1400);
    } catch {
      /* ignore */
    }
  }, []);

  const handleSessionDataUpdate = useCallback((data: { sessions: TerminalSessionInfo[]; activeSessionId: string | null }) => {
    setSessions(data.sessions);
    setActiveSessionId(data.activeSessionId);
    useTerminalStore.getState().setActiveSessionId(data.activeSessionId);
  }, []);

  const dispatchNewSession = useCallback((overrides?: { mode?: 'shell' | 'tmux'; tmuxSessionName?: string }) => {
    const mode = overrides?.mode ?? newSessionMode;
    const tmuxSessionName = mode === 'tmux'
      ? (overrides?.tmuxSessionName?.trim() || newSessionTmuxName.trim() || undefined)
      : undefined;
    // Inherit cwd from the currently active session
    const activeCwd = activeSessionId
      ? useTerminalStore.getState().sessions.get(activeSessionId)?.cwd
      : undefined;
    window.dispatchEvent(new CustomEvent('new-terminal-session', {
      detail: {
        mode,
        tmuxSessionName,
        cwd: activeCwd,
      },
    }));
  }, [newSessionMode, newSessionTmuxName, activeSessionId]);

  const refreshTmuxSessions = useCallback(async () => {
    setTmuxRefreshing(true);
    try {
      const status = await getTmuxStatus();
      setTmuxStatus(status);
      if (!status.available) {
        setTmuxSessions([]);
        return;
      }
      const list = await listTmuxSessions();
      setTmuxSessions(list);
    } catch {
      setTmuxStatus({ available: false, version: null, reason: 'tmux integration is unavailable with the current server build.' });
      setTmuxSessions([]);
    } finally {
      setTmuxRefreshing(false);
    }
  }, []);

  const handleKillTmuxSession = useCallback(async (name: string) => {
    setTmuxKillingName(name);
    setTmuxKillError(null);
    try {
      const { cleanedSessions } = await killTmuxSession(name);
      // Drop any frontend tabs that were attached to this tmux session.
      for (const backendId of cleanedSessions) {
        window.dispatchEvent(new CustomEvent('close-terminal-session-by-backend', { detail: backendId }));
      }
      setTmuxConfirmKillName(null);
      await refreshTmuxSessions();
    } catch (error) {
      setTmuxKillError(error instanceof Error ? error.message : 'Failed to kill tmux session');
    } finally {
      setTmuxKillingName(null);
    }
  }, [refreshTmuxSessions]);

  // Clear attaching state when the tmux session becomes connected or after timeout
  useEffect(() => {
    if (!tmuxAttachingName) return;
    const attached = tmuxSessions.find(s => s.name === tmuxAttachingName && (s.connected || s.boundFrontendSessionId));
    if (attached) {
      setTmuxAttachingName(null);
      return;
    }
    const timer = setTimeout(() => setTmuxAttachingName(null), 10000);
    return () => clearTimeout(timer);
  }, [tmuxAttachingName, tmuxSessions]);

  const dispatchCloseSession = useCallback((detail: string | CloseSessionEventDetail) => {
    window.dispatchEvent(new CustomEvent('close-terminal-session', { detail }));
  }, []);

  const handleSidebarCloseSession = useCallback((sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;
    if (session.mode !== 'tmux') {
      dispatchCloseSession({ sessionId, source: 'sidebar', closeMode: 'auto' });
      return;
    }
    setSidebarCloseChoiceSessionId(sessionId);
    setTmuxKillError(null);
  }, [sessions, dispatchCloseSession]);

  const sidebarCloseChoiceSession = React.useMemo(
    () => sessions.find((s) => s.id === sidebarCloseChoiceSessionId) ?? null,
    [sessions, sidebarCloseChoiceSessionId],
  );

  // Auto-refresh tmux sessions when drawer is open
  useEffect(() => {
    if (!isDrawerOpen) return;

    let cancelled = false;
    let pollingDisabled = false;
    const fetchSessions = async () => {
      if (pollingDisabled) return;
      try {
        const status = await getTmuxStatus();
        if (!cancelled) setTmuxStatus(status);
        if (!status.available) {
          if (!cancelled) setTmuxSessions([]);
          return;
        }
        const list = await listTmuxSessions();
        if (!cancelled) setTmuxSessions(list);
      } catch {
        pollingDisabled = true;
        if (!cancelled) {
          setTmuxStatus({ available: false, version: null, reason: 'tmux integration is unavailable with the current server build.' });
          setTmuxSessions([]);
        }
      }
    };

    void fetchSessions();
    const interval = setInterval(() => { void fetchSessions(); }, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isDrawerOpen]);

  const highlightedNewSessionMode = newSessionShortcutConfirmMode ?? newSessionMode;
  const shellShortcutHighlighted = highlightedNewSessionMode === 'shell';
  const tmuxShortcutHighlighted = highlightedNewSessionMode === 'tmux' && tmuxStatus.available;

  // 单个 tab 的渲染（编辑态 input / 普通态 tab 外壳），flat 与 分组 两种布局共用。
  //  - showDir: 是否显示目录副行（分组时为 false，只显示程序名/主名）
  //  - dragHandleProps: flat 模式由 Draggable 注入；分组模式不传（禁用拖拽）
  const renderTabShell = (
    session: TerminalSessionInfo,
    showDir: boolean,
    dragHandleProps?: DraggableProvidedDragHandleProps | null,
    compact = false,
  ): React.ReactNode => {
    const isActive = session.id === activeSessionId;
    const isEditing = session.id === editingSessionId;
    const ts = terminalSessions.get(session.id);
    const { primary: displayName, secondary: displaySubName } = getSessionDisplayLines(
      session,
      ts?.activeProgram ?? null,
      ts?.cwd ?? null,
      SHELL_NAMES,
    );
    const cwdLeaf = getCwdLeafName(ts?.cwd ?? null);
    const tabDirLabel = showDir
      ? (displaySubName ?? (cwdLeaf && cwdLeaf !== displayName ? cwdLeaf : null))
      : null;
    const tooltip = ts?.cwd || session.name;
    const accentColor = ts?.agentStatus === 'running'
      ? 'var(--success)'
      : (ts?.agentStatus === 'waiting' || ts?.agentNeedsReview)
        ? 'var(--warning)'
        : ts?.inCopyMode
          ? 'var(--warning)'
          : null;

    if (isEditing) {
      const commitRename = (sessionId: string, value: string) => {
        const trimmed = value.trim();
        if (!trimmed) {
          resetSessionName(sessionId);
        } else if (trimmed !== session.name) {
          renameSession(sessionId, trimmed);
        }
        setEditingSessionId(null);
      };
      return (
        <input
          ref={(el) => { renameInputRef.current = el; }}
          type="text"
          defaultValue={session.name}
          maxLength={48}
          className="h-8 shrink-0 rounded-md bg-surface-elevated px-2 text-[12px] leading-none text-foreground outline-none ring-1 ring-primary/50 sm:h-8 min-w-[5rem]"
          style={{ width: `${Math.min(Math.max(session.name.length, 5), 18)}ch` }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitRename(session.id, (e.target as HTMLInputElement).value);
            } else if (e.key === 'Escape') {
              setEditingSessionId(null);
            }
          }}
          onBlur={(e) => commitRename(session.id, e.target.value)}
        />
      );
    }

    return (
      <div
        ref={isActive ? activeSessionTabRef : null}
        onContextMenu={(e) => {
          e.preventDefault();
          setTabMenuAnchor({ x: e.clientX, y: e.clientY });
          setTabMenuSessionId(session.id);
        }}
        className={
          compact
            ? `group relative inline-flex h-5 shrink-0 items-center overflow-hidden rounded-sm text-[11px] leading-none transition max-w-[6rem] ${
                isActive
                  ? 'bg-surface-elevated text-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-surface-elevated/40 hover:text-foreground'
              }`
            : `group relative inline-flex h-8 shrink-0 items-center overflow-hidden rounded-md text-[12px] leading-none transition max-w-[6.25rem] sm:h-8 sm:max-w-[12rem] ${
                isActive
                  ? 'bg-surface-elevated text-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-surface-elevated/50 hover:text-foreground'
              }`
        }
        style={!compact && isActive && accentColor
          ? { boxShadow: `inset 2px 0 0 0 ${accentColor}` }
          : !compact && isActive
            ? { boxShadow: 'inset 2px 0 0 0 rgb(var(--primary-rgb, 99 102 241))' }
            : undefined}
        title={tooltip}
      >
        <button
          type="button"
          {...(dragHandleProps ?? {})}
          onClick={() => handleTabClick(session.id)}
          className={`inline-flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-left ${
            compact ? 'px-1' : 'py-1 pl-1 pr-1.5 sm:pl-1.5 sm:pr-2'
          } ${dragHandleProps ? 'cursor-grab active:cursor-grabbing' : ''}`}
          title={tooltip}
        >
          <span className="inline-flex min-w-0 items-center gap-1 overflow-hidden">
            <span className="inline-flex shrink-0 items-center">
              {renderTabIcon(session.mode, ts)}
            </span>
            {tabDirLabel ? (
              <span className="flex min-w-0 flex-col justify-center leading-[0.82rem] sm:leading-[0.85rem]">
                <span className={`truncate text-[11px] sm:text-[12px] ${ts?.inCopyMode ? 'text-[color:var(--warning)]' : ''}`}>{displayName}</span>
                <span className="truncate text-[9px] text-muted-foreground/80 sm:text-[9.5px]">
                  {tabDirLabel}
                </span>
              </span>
            ) : (
              <span className={`truncate text-[11px] sm:text-[12px] ${ts?.inCopyMode ? 'text-[color:var(--warning)]' : ''}`}>{displayName}</span>
            )}
          </span>
        </button>
      </div>
    );
  };

  return (
    <div
      className="w-screen h-full flex flex-col bg-background text-foreground"
    >
      <main className="relative min-h-0 flex-1 overflow-visible px-0 pb-0 pt-0">
        <div className="flex h-full w-full min-h-0 flex-col overflow-visible bg-background">
          <div
            className={`flex shrink-0 items-center justify-between gap-1 bg-background px-1 sm:px-1.5 ${
              groupByFolder ? 'h-10 sm:h-10' : 'h-9 sm:h-10'
            }`}
          >
            <button
              type="button"
              onClick={handleToggleLeftSidebar}
              className="relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted-foreground ring-1 ring-border/10 transition hover:bg-surface-elevated hover:text-foreground sm:h-8 sm:w-8"
              aria-label={t('tab.sessionsTitle')}
              title={`${t('tab.sessionsTitle')} · ${t('agent.aiRunning')}: ${agentTabCounts.running} · ${t('agent.needsReview')}: ${agentTabCounts.review}`}
            >
              <RiPanelLeftLine size={14} />
              <AgentCompactStatusOverlay
                runningCount={agentTabCounts.running}
                reviewCount={agentTabCounts.review}
                className="sm:hidden"
              />
            </button>
            {attentionSessionIds.length > 0 && (
              <button
                type="button"
                onClick={handleJumpToNextAttention}
                className="relative inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-[rgb(var(--warning-rgb)_/_0.12)] px-1.5 text-[color:var(--warning)] ring-1 ring-[rgb(var(--warning-rgb)_/_0.30)] transition hover:bg-[rgb(var(--warning-rgb)_/_0.20)] sm:h-8"
                aria-label={t('agent.jumpToNext')}
                title={t('agent.jumpToNext')}
              >
                <RiBellLine size={14} className="animate-pulse" />
                <span className="text-[11px] font-semibold leading-none">{attentionSessionIds.length}</span>
              </button>
            )}
            {groupByFolder ? (
            <DragDropContext onDragEnd={handleGroupedDragEnd}>
            <Droppable droppableId="groups" type="group" direction="horizontal">
              {(groupsProvided) => (
            <div
              ref={groupsProvided.innerRef}
              {...groupsProvided.droppableProps}
              className="scrollbar-hidden flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden whitespace-nowrap px-0.5 py-0.5"
              style={{ touchAction: 'pan-x' }}
            >
              {tabGroups.map((group, groupIndex) => {
                let groupRunning = 0;
                let groupReview = 0;
                for (const s of group.sessions) {
                  const ts = terminalSessions.get(s.id);
                  if (ts?.agentStatus === 'running') groupRunning += 1;
                  if (ts?.agentStatus === 'waiting' || ts?.agentNeedsReview) groupReview += 1;
                }
                const hasActive = group.sessions.some((s) => s.id === activeSessionId);
                const collapsed = collapsedGroups.has(group.key);
                // 「其他」组（无 cwd）永远被 buildFolderGroups 排到最后，禁止整组拖动。
                const groupDragDisabled = group.key === '';
                return (
                  <Draggable
                    key={group.key || '__ungrouped__'}
                    draggableId={`group-${group.key || '__ungrouped__'}`}
                    index={groupIndex}
                    isDragDisabled={groupDragDisabled}
                    disableInteractiveElementBlocking
                  >
                    {(groupDragProvided, groupSnapshot) => (
                  // 一个组 = 一个垂直胶囊：顶部目录名（点击折叠/展开 + 整组拖动手柄），下面是子 tab 行。
                  // 压缩间距，内容自然撑开高度。
                  <div
                    ref={groupDragProvided.innerRef}
                    {...groupDragProvided.draggableProps}
                    className={`flex w-fit shrink-0 flex-col justify-center gap-px rounded-md py-0.5 px-1 ring-1 transition-colors ${
                      groupSnapshot.isDragging
                        ? 'bg-surface-elevated ring-primary/30 shadow-lg opacity-90'
                        : hasActive
                          ? 'bg-primary/[0.06] ring-primary/20'
                          : 'bg-surface-2/40 ring-border/10'
                    }`}
                  >
                    {/* 组目录名：点击折叠/展开该组，长按/拖动整组重排。多 session 时 w-0 min-w-full
                        让目录名宽度跟随下方 tab 行；单 session 时去掉限制，让目录名自然撑宽胶囊，
                        避免短程序名导致长目录名被截断。 */}
                    <button
                      type="button"
                      {...(groupDragDisabled ? {} : groupDragProvided.dragHandleProps)}
                      onClick={() => toggleGroupCollapsed(group.key)}
                      className={`flex ${collapsed ? '' : group.sessions.length > 1 ? 'w-0 min-w-full' : ''} items-center gap-0.5 rounded text-[9px] font-semibold uppercase tracking-[0.08em] leading-none transition hover:bg-surface-elevated/40 ${
                        groupDragDisabled ? '' : 'cursor-grab active:cursor-grabbing'
                      } ${
                        hasActive ? 'text-primary/80' : 'text-muted-foreground/55'
                      }`}
                      title={group.key || group.label}
                    >
                      <RiChevronRightLine size={9} className={`shrink-0 opacity-70 transition-transform ${collapsed ? '' : 'rotate-90'}`} />
                      <span className="min-w-0 truncate">{group.label}</span>
                      {groupRunning > 0 && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--success)]" />}
                      {groupReview > 0 && <span className={`h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--warning)] ${groupRunning > 0 ? '' : 'ml-auto'}`} />}

                    </button>
                    {/* 展开时显示子 tab（组内可拖动排序）；折叠时显示 session 数，保持高度一致 */}
                    {collapsed ? (
                      <span className="flex h-5 items-center text-[10px] leading-none text-muted-foreground/50">{group.sessions.length} sessions</span>
                    ) : (
                      <Droppable droppableId={`group-sessions:${group.key}`} type="session" direction="horizontal">
                        {(sessionsProvided) => (
                          <div
                            ref={sessionsProvided.innerRef}
                            {...sessionsProvided.droppableProps}
                            className="flex items-center gap-px"
                          >
                            {group.sessions.map((session, sessionIndex) => (
                              <Draggable key={session.id} draggableId={session.id} index={sessionIndex} disableInteractiveElementBlocking>
                                {(sessionDragProvided, sessionSnapshot) => (
                                  <div
                                    ref={sessionDragProvided.innerRef}
                                    {...sessionDragProvided.draggableProps}
                                    className={`flex shrink-0 items-center ${sessionSnapshot.isDragging ? 'opacity-70' : ''}`}
                                  >
                                    {renderTabShell(session, false, sessionDragProvided.dragHandleProps, true)}
                                  </div>
                                )}
                              </Draggable>
                            ))}
                            {sessionsProvided.placeholder}
                          </div>
                        )}
                      </Droppable>
                    )}
                  </div>
                    )}
                  </Draggable>
                );
              })}
              {groupsProvided.placeholder}
              <button
                type="button"
                onClick={() => dispatchNewSession()}
                className="my-auto inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted-foreground ring-1 ring-border/10 transition hover:bg-primary/15 hover:text-primary active:scale-95"
                aria-label={t('tab.new')}
                title={t('tab.new')}
              >
                <RiAddLine size={14} />
              </button>
            </div>
              )}
            </Droppable>
            </DragDropContext>
            ) : (
            <DragDropContext onDragEnd={handleDragEnd}>
            <Droppable droppableId="tabs" direction="horizontal">
              {(provided) => (
            <div
              ref={provided.innerRef}
              {...provided.droppableProps}
              className="scrollbar-hidden flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden whitespace-nowrap"
              style={{ touchAction: 'pan-x' }}
            >
              {sessions.map((session, index) => {
                const isEditing = session.id === editingSessionId;
                if (isEditing) {
                  return (
                    <React.Fragment key={session.id}>
                      <Draggable draggableId={session.id} index={index} isDragDisabled>
                        {(provided) => (
                          <div
                            ref={provided.innerRef}
                            {...provided.draggableProps}
                            className="flex h-full items-center"
                          >
                            {renderTabShell(session, true)}
                          </div>
                        )}
                      </Draggable>
                    </React.Fragment>
                  );
                }
                return (
                  <React.Fragment key={session.id}>
                  <Draggable draggableId={session.id} index={index} disableInteractiveElementBlocking>
                    {(provided, snapshot) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.draggableProps}
                      className={`flex h-full shrink-0 items-center ${snapshot.isDragging ? 'opacity-70' : ''}`}
                    >
                      {renderTabShell(session, true, provided.dragHandleProps)}
                    </div>
                    )}
                  </Draggable>
                  </React.Fragment>
                );
              })}
              <button
                type="button"
                onClick={() => dispatchNewSession()}
                className="ml-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted-foreground ring-1 ring-border/10 transition hover:bg-primary/15 hover:text-primary active:scale-95"
                aria-label={t('tab.new')}
                title={t('tab.new')}
              >
                <RiAddLine size={14} />
              </button>
              {provided.placeholder}
            </div>
              )}
            </Droppable>
            </DragDropContext>
            )}
            <div className="flex shrink-0 items-center gap-1.5">
              {(agentTabCounts.running > 0 || agentTabCounts.review > 0) && (
                <span className="hidden items-center gap-1 sm:inline-flex">
                  <AgentCountBadge count={agentTabCounts.running} tone="running" title="AI running" />
                  <AgentCountBadge count={agentTabCounts.review} tone="review" title="Needs review" />
                </span>
              )}
              {sessions.length > 0 && (
              <span
                className="inline-flex shrink-0 items-center px-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground sm:text-[11px]"
                title={`Session ${activeSessionIndex + 1} of ${sessions.length}`}
              >
                {activeSessionPositionLabel}
              </span>
              )}
              <button
                type="button"
                onClick={handleToggleRightSidebar}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted-foreground ring-1 ring-border/10 transition hover:bg-surface-elevated hover:text-foreground sm:h-8 sm:w-8"
                aria-label={t('tab.explorerTitle')}
                title={t('tab.explorerTitle')}
              >
                <RiPanelRightLine size={14} />
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 flex overflow-hidden bg-background">
            <div className="min-h-0 flex-1 overflow-hidden">
              <MultiTerminalView
                terminalSettings={terminalSettings}
                colorTheme={colorTheme}
                toolbarPresets={toolbarPresets}
                showDebug={showDebug}
                defaultSessionMode={newSessionMode}
                defaultTmuxSessionName={newSessionTmuxName}
                onSessionDataUpdate={handleSessionDataUpdate}
              />
            </div>
          </div>
        </div>
      </main>

      {/* Settings modal (single page) */}
      {isDrawerOpen && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-drawer-backdrop bg-[var(--app-backdrop)] backdrop-blur-sm animate-fade-in cursor-default"
            onClick={handleCloseSettings}
            aria-label="Close settings"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-dialog-title"
            className="pointer-events-none fixed inset-0 z-drawer-panel flex items-stretch justify-center p-0 animate-fade-in sm:p-4 md:p-6"
          >
          <div
            className="pointer-events-auto flex h-full w-full max-w-5xl flex-col overflow-hidden bg-surface shadow-[0_28px_90px_var(--app-shadow-strong),0_14px_34px_var(--app-shadow-soft)] sm:max-h-[calc(100dvh-3rem)] sm:rounded-3xl sm:border sm:border-border/15"
            style={{ paddingTop: safeTopInset, paddingBottom: safeBottomInset }}
          >
            {/* Header — compact single row */}
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/15 px-4 py-3 sm:px-6 sm:py-4">
              <div className="min-w-0 flex items-center gap-2">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 text-primary sm:h-9 sm:w-9">
                  <RiEqualizerLine size={15} />
                </span>
                <h2 id="settings-dialog-title" className="text-[15px] font-semibold text-foreground sm:text-[16px]">{t('settings.title')}</h2>
              </div>
              <button
                type="button"
                onClick={handleCloseSettings}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-destructive/20 hover:text-destructive"
                aria-label="Close"
              >
                <RiCloseLine size={16} />
              </button>
            </div>

            {/* Content */}
            <div className="min-h-0 flex-1 overflow-y-auto bg-background/25 px-3 py-3 sm:px-6 sm:py-5 md:px-8">
              {/* Quick row: font size + renderer + toggles, all visible at-a-glance */}
              <div className="space-y-2">
                {/* Font size */}
                <div className="flex items-center gap-2 rounded-xl bg-surface-2 px-2.5 py-2">
                  <span className="text-[12px] font-medium text-foreground/90 w-14 shrink-0">{t('settings.font')}</span>
                  <button
                    type="button"
                    onClick={() => updateTerminalSettings({ fontSize: Math.max(8, fontSize - 1) })}
                    className="h-8 w-8 shrink-0 rounded-md bg-surface text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
                  >
                    −
                  </button>
                  <input
                    type="range"
                    min="8"
                    max="32"
                    value={fontSize}
                    onChange={(e) => updateTerminalSettings({ fontSize: parseInt(e.target.value, 10) })}
                    className="min-w-0 flex-1"
                    aria-label={t('settings.font')}
                  />
                  <button
                    type="button"
                    onClick={() => updateTerminalSettings({ fontSize: Math.min(32, fontSize + 1) })}
                    className="h-8 w-8 shrink-0 rounded-md bg-surface text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
                  >
                    +
                  </button>
                  <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{fontSize}px</span>
                </div>

                {/* Renderer */}
                <div className="space-y-1.5 rounded-xl bg-surface-2 px-2.5 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] font-medium text-foreground/90 w-14 shrink-0">{t('settings.render')}</span>
                    <div className="flex flex-1 items-center gap-1 rounded-md bg-surface p-0.5">
                      {(['auto', 'webgl', 'canvas'] as TerminalRendererMode[]).map((mode) => {
                        const selected = rendererMode === mode;
                        return (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => updateTerminalSettings({ rendererMode: mode })}
                            className={`flex-1 rounded px-2 py-1 text-[11px] font-medium transition ${
                              selected ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:bg-surface-elevated'
                            }`}
                          >
                            {mode === 'auto' ? t('settings.auto') : mode === 'webgl' ? t('settings.webgl') : t('settings.canvas')}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Theme */}
                <div className="space-y-1.5 rounded-xl bg-surface-2 px-2.5 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] font-medium text-foreground/90 w-14 shrink-0">{t('settings.theme')}</span>
                    <div className="flex flex-1 items-center gap-1 rounded-md bg-surface p-0.5">
                      {([
                        ['dark', RiMoonLine, t('settings.darkTheme')],
                        ['light', RiSunLine, t('settings.lightTheme')],
                      ] as const).map(([theme, Icon, label]) => {
                        const selected = colorTheme === theme;
                        return (
                          <button
                            key={theme}
                            type="button"
                            onClick={() => setColorTheme(theme)}
                            className={`flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition ${
                              selected ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:bg-surface-elevated'
                            }`}
                          >
                            <Icon size={12} />
                            <span>{label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Default mode for the top-tab + button */}
                <div className="flex items-center gap-2 rounded-xl bg-surface-2 px-2.5 py-2">
                  <span className="text-[12px] font-medium text-foreground/90 w-14 shrink-0">{t('settings.newTab')}</span>
                  <div className="flex flex-1 items-center gap-1 rounded-md bg-surface p-0.5">
                    {(['shell', 'tmux'] as const).map((mode) => {
                      const selected = newSessionMode === mode;
                      const disabled = mode === 'tmux' && !tmuxStatus.available;
                      return (
                        <button
                          key={mode}
                          type="button"
                          disabled={disabled}
                          onClick={() => setNewSessionMode(mode, { userInitiated: true })}
                          className={`flex-1 rounded px-2 py-1 text-[11px] font-medium transition ${
                            selected
                              ? 'bg-primary/20 text-primary'
                              : disabled
                                ? 'cursor-not-allowed text-muted-foreground/40'
                                : 'text-muted-foreground hover:bg-surface-elevated'
                          }`}
                          title={disabled ? (tmuxStatus.reason || t('settings.installTmuxHint')) : undefined}
                        >
                          {mode === 'shell' ? t('settings.shell') : t('settings.tmux')}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Toggles row */}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setShowDebug(!showDebug)}
                    className={`flex items-center justify-between rounded-xl px-3 py-2 text-[12px] transition ${
                      showDebug ? 'bg-primary/15 text-primary' : 'bg-surface-2 text-foreground hover:bg-surface-elevated'
                    }`}
                  >
                    <span className="font-medium">{t('settings.debug')}</span>
                    <span className={`inline-flex h-4 w-7 items-center rounded-full transition ${
                      showDebug ? 'bg-primary/70' : 'bg-surface-elevated'
                    }`}>
                      <span className={`mx-0.5 inline-block h-3 w-3 rounded-full bg-foreground/90 transition ${
                        showDebug ? 'translate-x-3' : ''
                      }`} />
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      const newValue = !preventSleep;
                      setPreventSleep(newValue);
                      try {
                        const result = await updateSettings({ preventSleep: newValue });
                        setPreventSleep(result.preventSleep);
                        setNetworkAvailable(result.networkAvailable);
                        setLocalAccess(result.localAccess);
                        writeCache(SETTINGS_CACHE_KEY, {
                          preventSleep: result.preventSleep,
                          networkAvailable: result.networkAvailable,
                          localAccess: result.localAccess,
                        });
                      } catch {
                        setPreventSleep(!newValue);
                      }
                    }}
                    className={`flex items-center justify-between rounded-xl px-3 py-2 text-[12px] transition ${
                      preventSleep ? 'bg-[rgb(var(--success-rgb)_/_0.15)] text-[color:var(--success)]' : 'bg-surface-2 text-foreground hover:bg-surface-elevated'
                    }`}
                    title={!networkAvailable && preventSleep ? t('settings.noSleepUnavailable') : undefined}
                  >
                    <span className="font-medium truncate">{t('settings.noSleep')}</span>
                    <span className={`inline-flex h-4 w-7 items-center rounded-full transition ${
                      preventSleep ? 'bg-[var(--success)]' : 'bg-surface-elevated'
                    }`}>
                      <span className={`mx-0.5 inline-block h-3 w-3 rounded-full transition ${
                        preventSleep ? 'translate-x-3 bg-[var(--background)]' : 'bg-foreground/90'
                      }`} />
                    </span>
                  </button>
                </div>
              </div>

              {/* Notifications */}
              <button
                type="button"
                onClick={() => setIsNotificationsOpen(true)}
                className="mt-3 flex w-full items-center justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-left text-[13px] transition hover:bg-surface-elevated"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <RiBellLine size={14} className={pwaNotificationsEnabled ? 'shrink-0 text-primary' : 'shrink-0 text-muted-foreground'} />
                  <span className="min-w-0">
                    <span className="block font-medium text-foreground">{t('settings.notifications')}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {pwaNotificationsEnabled
                        ? (pwaAiNotificationsEnabled ? t('settings.notificationsAiOnSummary') : t('settings.notificationsNoEventsSummary'))
                        : t('settings.notificationsOffSummary')}
                    </span>
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span>{pwaNotificationsEnabled ? t('common.on') : t('common.off')}</span>
                  <span>›</span>
                </span>
              </button>

              <details className="mt-3 rounded-xl bg-surface-2 px-3 py-3" open={false}>
                <summary className="flex cursor-pointer items-start justify-between gap-2 list-none">
                  <div>
                    <div className="text-[12px] font-medium text-foreground/90">{t('settings.localAccess')}</div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground">{t('settings.localAccessHint')}</div>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] ${localAccess.status === 'active' ? 'bg-primary/15 text-primary' : 'bg-surface text-muted-foreground'}`}>
                    {localAccess.status}
                  </span>
                </summary>
                <div className="mt-3 flex items-center overflow-hidden rounded-lg bg-surface ring-1 ring-border/10 focus-within:ring-primary/40">
                  <input
                    value={localAccessNameInput}
                    onChange={(event) => setLocalAccessNameInput(event.target.value.toLowerCase())}
                    className="min-w-0 flex-1 bg-transparent px-2.5 py-2 text-[12px] text-foreground outline-none"
                    placeholder="jovn"
                    spellCheck={false}
                  />
                  <span className="shrink-0 border-l border-border/10 px-2.5 py-2 text-[11px] text-muted-foreground">.termdock.local</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={localAccessSaving}
                    onClick={() => void handleSaveLocalAccess()}
                    className="rounded-full bg-primary/15 px-3 py-1.5 text-[11px] font-medium text-primary transition hover:bg-primary/25 disabled:opacity-50"
                  >
                    {localAccessSaving ? t('settings.saving') : t('common.save')}
                  </button>
                  <button
                    type="button"
                    disabled={localAccessSaving}
                    onClick={() => void handleResetLocalAccess()}
                    className="rounded-full bg-surface px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition hover:bg-surface-elevated disabled:opacity-50"
                  >
                    {t('settings.resetAutoName')}
                  </button>
                </div>
                <div className="mt-3 space-y-1.5 text-[11px]">
                  {localAccess.url && (
                    <button type="button" onClick={() => void handleCopyText(localAccess.url, 'lan')} className="flex w-full items-center justify-between gap-2 rounded-lg bg-surface px-2.5 py-2 text-left text-muted-foreground transition hover:bg-surface-elevated">
                      <span className="min-w-0 truncate">Branded: {localAccess.url}</span>
                      <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium">{localAccessCopied === 'lan' ? 'Copied' : t('common.copy')}</span>
                    </button>
                  )}
                  {localAccess.interfaces.length > 0 && (
                    <details className="rounded-lg bg-surface px-2.5 py-2 text-muted-foreground" open={false}>
                      <summary className="cursor-pointer text-[11px] font-medium text-foreground/80">IP fallback addresses</summary>
                      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {localAccess.interfaces.map((entry) => {
                          const url = entry.url ?? `${localAccess.httpsEnabled ? 'https' : 'http'}://${entry.address}:9834`;
                          return (
                            <div key={`${entry.name}-${entry.address}`} className="rounded-lg bg-surface-2 p-2">
                              <div className="text-[11px] font-medium text-foreground/85">{entry.label} ({entry.name})</div>
                              <div className="mt-0.5 text-[10px] text-muted-foreground">{entry.address}</div>
                              {entry.qrDataUrl && (
                                <div className="mt-2 inline-block rounded-lg bg-[var(--background)] p-1.5">
                                  <img src={entry.qrDataUrl} alt={`QR code for ${url}`} className="h-28 w-28" />
                                </div>
                              )}
                              <button type="button" onClick={() => void handleCopyText(url, `ip-${entry.address}`)} className="mt-2 flex w-full items-center justify-between gap-2 rounded-md bg-surface px-2 py-1.5 text-left text-[11px] transition hover:bg-surface-elevated">
                                <span className="min-w-0 truncate">{url}</span>
                                <span className="shrink-0 text-[10px]">{localAccessCopied === `ip-${entry.address}` ? 'Copied' : t('common.copy')}</span>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  )}
                  {localAccess.onboardingUrl && (
                    <button type="button" onClick={() => void handleCopyText(localAccess.onboardingUrl, 'setup')} className="flex w-full items-center justify-between gap-2 rounded-lg bg-surface px-2.5 py-2 text-left text-muted-foreground transition hover:bg-surface-elevated">
                      <span className="min-w-0 truncate">{t('settings.onboardingUrl')}: {localAccess.onboardingUrl}</span>
                      <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium">{localAccessCopied === 'setup' ? 'Copied' : t('common.copy')}</span>
                    </button>
                  )}
                  <div className="text-muted-foreground">
                    {localAccess.httpsEnabled ? t('settings.httpsActive') : t('settings.httpsInactive')}
                    {!localAccess.caAvailable && ` · ${t('settings.caMissing')}`}
                  </div>
                  {localAccess.reason && <div className="text-[color:var(--warning)]">{localAccess.reason}</div>}
                  {localAccessError && <div className="text-destructive">{localAccessError}</div>}
                </div>
              </details>

              {/* New session shortcut */}
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setNewSessionShortcutConfirmMode(null);
                    dispatchNewSession({ mode: 'shell' });
                    handleCloseSettings();
                  }}
                  className={`flex min-w-0 items-center justify-center gap-1.5 rounded-xl text-[13px] font-semibold transition active:scale-[0.98] ${
                    shellShortcutHighlighted
                      ? 'flex-[2.7] bg-primary px-3 py-2.5 text-primary-foreground ring-1 ring-primary/40 shadow-md shadow-primary/25 hover:bg-primary/90'
                      : 'flex-[0.78] bg-surface-2 px-2 py-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
                  }`}
                  title={newSessionShortcutConfirmMode === 'shell' ? t('sidebar.confirmNewShell') : t('settings.shell')}
                >
                  <RiAddLine size={14} className={shellShortcutHighlighted ? 'shrink-0' : 'hidden'} />
                  <RiTerminalLine size={12} />
                  <span className={shellShortcutHighlighted ? 'whitespace-nowrap' : 'hidden'}>
                    {newSessionShortcutConfirmMode === 'shell' ? t('sidebar.confirmNewShell') : t('settings.shell')}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={!tmuxStatus.available}
                  onClick={() => {
                    if (!tmuxStatus.available) return;
                    setNewSessionShortcutConfirmMode(null);
                    dispatchNewSession({ mode: 'tmux' });
                    handleCloseSettings();
                  }}
                  className={`flex min-w-0 items-center justify-center gap-1.5 rounded-xl text-[13px] font-semibold transition active:scale-[0.98] ${
                    tmuxStatus.available
                      ? tmuxShortcutHighlighted
                        ? 'flex-[2.7] bg-primary px-3 py-2.5 text-primary-foreground ring-1 ring-primary/40 shadow-md shadow-primary/25 hover:bg-primary/90'
                        : 'flex-[0.78] bg-surface-2 px-2 py-2 text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
                      : 'flex-1 bg-surface-2/50 text-muted-foreground/50 cursor-not-allowed'
                  }`}
                  title={tmuxStatus.available ? (newSessionShortcutConfirmMode === 'tmux' ? t('sidebar.confirmNewTmux') : t('settings.tmux')) : (tmuxStatus.reason || t('settings.installTmuxHint'))}
                >
                  <RiAddLine size={14} className={tmuxShortcutHighlighted ? 'shrink-0' : 'hidden'} />
                  <RiLayoutGridLine size={12} />
                  <span className={tmuxShortcutHighlighted ? 'whitespace-nowrap' : 'hidden'}>
                    {newSessionShortcutConfirmMode === 'tmux' ? t('sidebar.confirmNewTmux') : t('settings.tmux')}
                  </span>
                </button>
              </div>

              {/* Tmux server (only when available or has sessions) */}
              {(tmuxStatus.available || tmuxSessions.length > 0) && (
                <details className="mt-3 group rounded-xl bg-surface-2 [&[open]]:bg-surface-2">
                  <summary className="flex cursor-pointer items-center justify-between rounded-xl px-3 py-2.5 text-[13px] hover:bg-surface-elevated">
                    <span className="flex items-center gap-2">
                      <span className={`inline-flex h-2 w-2 rounded-full ${tmuxStatus.available ? 'bg-primary' : 'bg-destructive'}`} />
                      <span className="font-medium">{t('settings.tmuxServer')}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {tmuxStatus.available
                          ? t('settings.sessions', { n: tmuxSessions.length })
                          : t('settings.tmuxUnavailable')}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={(e) => { e.preventDefault(); void refreshTmuxSessions(); }}
                      disabled={tmuxRefreshing}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground disabled:opacity-50"
                      aria-label={t('settings.refresh')}
                    >
                      <RiRefreshLine size={12} className={tmuxRefreshing ? 'animate-spin' : ''} />
                    </button>
                  </summary>
                  <div className="px-2 pb-2">
                    {!tmuxStatus.available ? (
                      <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
                        {tmuxStatus.reason || t('settings.installTmuxHint')}
                      </p>
                    ) : tmuxSessions.length === 0 ? (
                      <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
                        {t('settings.noTmuxSessions')}
                      </p>
                    ) : (
                      <div className="space-y-1">
                        {tmuxSessions.map((tmux) => {
                          const boundFrontendSessionId = tmux.boundFrontendSessionId ?? null;
                          const connected = Boolean(tmux.connected || boundFrontendSessionId);
                          const existingSession = boundFrontendSessionId
                            ? sessions.find((session) => session.id === boundFrontendSessionId) ?? null
                            : null;
                          const confirming = tmuxConfirmKillName === tmux.name;
                          const killing = tmuxKillingName === tmux.name;
                          const attaching = tmuxAttachingName === tmux.name;
                          return (
                            <div
                              key={tmux.name}
                              className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${
                                confirming ? 'bg-destructive/10 ring-1 ring-destructive/40' : 'bg-surface'
                              }`}
                            >
                              <RiLayoutGridLine size={12} className={connected ? 'shrink-0 text-primary' : 'shrink-0 text-muted-foreground'} />
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-[12px] font-medium text-foreground">{tmux.name}</div>
                                <div className="truncate text-[10px] text-muted-foreground">
                                  {tmux.program && <span className="text-foreground/70">{tmux.program}</span>}
                                  {tmux.program && tmux.cwd && ' · '}
                                  {tmux.cwd && <span>{tmux.cwd}</span>}
                                  {(tmux.program || tmux.cwd) && ' · '}
                                  {t('settings.windows', { n: tmux.windows })}
                                  {tmux.attached > 0 && ` · tmux:${tmux.attached}`}
                                  {connected && ` · ${tmux.restorable ? t('settings.restorable') : t('settings.attached')}`}
                                </div>
                              </div>
                              {!confirming ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (existingSession) {
                                        handleTabClick(existingSession.id);
                                      } else {
                                        setTmuxAttachingName(tmux.name);
                                        dispatchNewSession({ mode: 'tmux', tmuxSessionName: tmux.name });
                                      }
                                    }}
                                    disabled={attaching}
                                    className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition disabled:opacity-50 ${
                                      connected
                                        ? 'bg-surface text-foreground hover:bg-surface-elevated'
                                        : attaching
                                          ? 'bg-primary/10 text-primary'
                                          : 'bg-primary/15 text-primary hover:bg-primary/25'
                                    }`}
                                  >
                                    {attaching ? <><RiLoaderLine size={10} className="animate-spin" />{t('settings.attaching')}</> : connected ? t('settings.attached') : t('settings.attach')}
                                  </button>
                                  <button
                                    type="button"
                                    disabled={killing}
                                    onClick={() => { setTmuxKillError(null); setTmuxConfirmKillName(tmux.name); }}
                                    className="shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition hover:bg-destructive/15 hover:text-destructive"
                                    aria-label={`Kill tmux session ${tmux.name}`}
                                  >
                                    <RiDeleteBinLine size={12} />
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    disabled={killing}
                                    onClick={() => void handleKillTmuxSession(tmux.name)}
                                    className="shrink-0 rounded-full bg-destructive/90 px-2.5 py-1 text-[11px] font-medium text-destructive-foreground transition hover:bg-destructive disabled:opacity-50"
                                  >
                                    {killing ? '…' : t('settings.destroy')}
                                  </button>
                                  <button
                                    type="button"
                                    disabled={killing}
                                    onClick={() => { setTmuxConfirmKillName(null); setTmuxKillError(null); }}
                                    className="shrink-0 rounded-full bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-foreground transition hover:bg-surface-elevated"
                                  >
                                    {t('common.cancel')}
                                  </button>
                                </>
                              )}
                            </div>
                          );
                        })}
                        {tmuxKillError && (
                          <p className="px-2 text-[11px] text-destructive">{tmuxKillError}</p>
                        )}
                      </div>
                    )}
                  </div>
                </details>
              )}

              {/* Toolbar presets */}
              <button
                type="button"
                onClick={() => setIsToolbarPresetsOpen(true)}
                className="mt-2 flex w-full items-center justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-left text-[13px] transition hover:bg-surface-elevated"
              >
                <span className="flex items-center gap-2">
                  <RiKeyboardLine size={14} className="text-muted-foreground" />
                  <span className="font-medium text-foreground">{t('settings.keyboardToolbar')}</span>
                </span>
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span>{t('settings.sessions', { n: toolbarPresets.length })}</span>
                  <span>›</span>
                </span>
              </button>

              {/* Agent detection */}
              <button
                type="button"
                onClick={() => setIsAgentRulesOpen(true)}
                className="mt-2 flex w-full items-center justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-left text-[13px] transition hover:bg-surface-elevated"
              >
                <span className="flex items-center gap-2">
                  <RiBotLine size={14} className="text-muted-foreground" />
                  <span className="font-medium text-foreground">{t('settings.aiAgentDetection')}</span>
                </span>
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span>{agentRulesLoaded ? `${agentRules.length} prog${agentRules.length === 1 ? '' : 's'}` : '…'}</span>
                  <span>›</span>
                </span>
              </button>

              {/* Language switcher */}
              <div className="mt-3 flex items-center gap-2 rounded-xl bg-surface-2 px-2.5 py-2">
                <span className="text-[12px] font-medium text-foreground/90 w-14 shrink-0">{t('settings.language')}</span>
                <div className="flex flex-1 items-center gap-1 rounded-md bg-surface p-0.5">
                  {([
                    { code: 'en' as const, label: 'English' },
                    { code: 'zh' as const, label: '中文' },
                  ]).map((opt) => {
                    const selected = locale === opt.code;
                    return (
                      <button
                        key={opt.code}
                        type="button"
                        onClick={() => setLocale(opt.code)}
                        className={`flex-1 rounded px-2 py-1 text-[11px] font-medium transition ${
                          selected
                            ? 'bg-primary/20 text-primary'
                            : 'text-muted-foreground hover:bg-surface-elevated'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Sign out */}
              <button
                type="button"
                onClick={async () => {
                  try {
                    await logout();
                  } catch {
                    // ignore — auth gate will handle 401
                  }
                  window.dispatchEvent(new CustomEvent('auth:unauthorized'));
                }}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-destructive/10 px-3 py-2.5 text-[13px] font-medium text-destructive transition hover:bg-destructive/20 active:scale-[0.98]"
              >
                <RiLogoutBoxRLine size={14} />
                {t('settings.signOut')}
              </button>
            </div>
          </div>
          </div>
        </>
      )}

      {/* Sidebar close action chooser for tmux sessions */}
      {sidebarCloseChoiceSession && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-menu-backdrop bg-[var(--app-backdrop-soft)] backdrop-blur-sm cursor-default animate-fade-in"
            onClick={() => {
              setSidebarCloseChoiceSessionId(null);
              setTmuxKillError(null);
            }}
            aria-label="Close close-session chooser"
          />
          <div
            className="fixed inset-x-3 bottom-6 z-menu-panel mx-auto max-w-sm rounded-2xl bg-surface-elevated border border-border/15 shadow-[0_18px_48px_var(--app-shadow-soft)] animate-fade-in sm:bottom-auto sm:top-[15%]"
            style={{ paddingBottom: safeBottomInset }}
          >
            <div className="border-b border-border/15 px-4 py-3">
              <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Tmux session</div>
              <div className="mt-0.5 truncate text-[14px] font-medium text-foreground">{sidebarCloseChoiceSession.tmuxSessionName ?? sidebarCloseChoiceSession.name}</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground/80">Choose what "Close" should do for this tmux session.</div>
            </div>
            <div className="flex flex-col py-1">
              <button
                type="button"
                onClick={() => {
                  dispatchCloseSession({
                    sessionId: sidebarCloseChoiceSession.id,
                    source: 'sidebar',
                    closeMode: 'detach',
                  });
                  setSidebarCloseChoiceSessionId(null);
                  setTmuxKillError(null);
                }}
                className="flex items-center gap-3 px-4 py-3 text-left text-[13px] text-foreground transition hover:bg-surface-2"
              >
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-surface-2 text-muted-foreground">
                  <RiTerminalLine size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">Detach</span>
                  <span className="block text-[11px] text-muted-foreground">Close this tab only, keep tmux session running.</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  dispatchCloseSession({
                    sessionId: sidebarCloseChoiceSession.id,
                    source: 'sidebar',
                    closeMode: 'destroy',
                  });
                  setSidebarCloseChoiceSessionId(null);
                }}
                className="flex items-center gap-3 px-4 py-3 text-left text-[13px] text-destructive transition hover:bg-destructive/10"
              >
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-destructive/15 text-destructive">
                  <RiDeleteBinLine size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">Destroy</span>
                  <span className="block text-[11px] text-muted-foreground">Kill the tmux session and all processes inside it.</span>
                </span>
              </button>
              {tmuxKillError && (
                <p className="px-4 py-2 text-[11px] text-destructive">{tmuxKillError}</p>
              )}
            </div>
            <div className="border-t border-border/15 px-3 py-2">
              <button
                type="button"
                onClick={() => {
                  setSidebarCloseChoiceSessionId(null);
                  setTmuxKillError(null);
                }}
                className="w-full rounded-full bg-surface-2 px-3 py-2 text-[12px] font-medium text-muted-foreground transition hover:bg-surface hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
        </>
      )}

      {/* Tab actions menu */}
      {tabMenuSessionId && (() => {
        const menuSession = sessions.find((s) => s.id === tabMenuSessionId);
        if (!menuSession) return null;
        const ts = terminalSessions.get(menuSession.id);
        const { primary: menuName } = getSessionDisplayLines(
          menuSession,
          ts?.activeProgram ?? null,
          ts?.cwd ?? null,
          SHELL_NAMES,
        );
        const isDesktopTabMenu = isDesktopViewport;
        const menuPanelStyle = isDesktopTabMenu
          ? getDesktopTabMenuPosition(tabMenuAnchor)
          : { paddingBottom: safeBottomInset };
        const menuPanelClassName = isDesktopTabMenu
          ? 'fixed z-menu-panel overflow-y-auto overflow-x-hidden rounded-lg bg-surface-elevated border border-border/15 shadow-[0_18px_48px_var(--app-shadow-soft)] animate-fade-in'
          : 'fixed inset-x-3 bottom-6 z-menu-panel mx-auto max-w-sm rounded-2xl bg-surface-elevated border border-border/15 shadow-[0_18px_48px_var(--app-shadow-soft)] animate-fade-in sm:bottom-auto sm:top-[15%]';
        const menuHeaderClassName = isDesktopTabMenu
          ? 'border-b border-border/15 px-3 py-2'
          : 'border-b border-border/15 px-4 py-3';
        const menuItemClassName = isDesktopTabMenu
          ? 'flex items-center gap-2 px-3 py-2 text-left text-[12px] transition'
          : 'flex items-center gap-3 px-4 py-3 text-left text-[13px] transition';
        const menuIconClassName = isDesktopTabMenu
          ? 'inline-flex h-6 w-6 items-center justify-center rounded-md'
          : 'inline-flex h-7 w-7 items-center justify-center rounded-full';
        return (
          <>
            <button
              type="button"
              className={`fixed inset-0 z-menu-backdrop cursor-default animate-fade-in ${
                isDesktopTabMenu ? 'bg-transparent' : 'bg-[var(--app-backdrop-soft)] backdrop-blur-sm'
              }`}
              onClick={closeTabMenu}
              aria-label="Close menu"
            />
            <div
              className={menuPanelClassName}
              style={menuPanelStyle}
            >
              <div className={menuHeaderClassName}>
                <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{t('tab.session')}</div>
                <div className="mt-0.5 truncate text-[14px] font-medium text-foreground">{menuName}</div>
                {ts?.cwd && (
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground/80">{ts.cwd}</div>
                )}
              </div>
              <div className="flex flex-col py-1">
                <button
                  type="button"
                  onClick={() => {
                    closeTabMenu();
                    setEditingSessionId(menuSession.id);
                  }}
                  className={`${menuItemClassName} text-foreground hover:bg-surface-2`}
                >
                  <span className={`${menuIconClassName} bg-primary/15 text-primary`}>
                    <RiPencilLine size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{t('tab.rename')}</span>
                    <span className="block text-[11px] text-muted-foreground">{t('tab.renameHint')}</span>
                  </span>
                </button>
                <button
                  type="button"
                  disabled={!ts?.cwd}
                  onClick={() => {
                    void copyCwdToClipboard(menuSession.id);
                    closeTabMenu();
                  }}
                  className={`${menuItemClassName} ${
                    ts?.cwd
                      ? 'text-foreground hover:bg-surface-2'
                      : 'text-muted-foreground/50 cursor-not-allowed'
                  }`}
                >
                  <span className={`${menuIconClassName} bg-surface-2 text-muted-foreground`}>
                    <RiStackLine size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{t('tab.copyCwd')}</span>
                    <span className="block text-[11px] text-muted-foreground">{t('tab.copyCwdHint')}</span>
                  </span>
                  {tabCopiedHint && tabCopiedHint === ts?.cwd && (
                    <span className="ml-auto text-[11px] text-primary">{t('tab.copied')}</span>
                  )}
                </button>
                <div className="my-1 border-t border-border/15" />
                {menuSession.mode === 'tmux' ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        dispatchCloseSession({
                          sessionId: menuSession.id,
                          source: 'tab-menu',
                          closeMode: 'detach',
                        });
                        closeTabMenu();
                        setTmuxKillError(null);
                      }}
                      className={`${menuItemClassName} text-foreground hover:bg-surface-2`}
                    >
                      <span className={`${menuIconClassName} bg-surface-2 text-muted-foreground`}>
                        <RiTerminalLine size={14} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">Detach</span>
                        <span className="block text-[11px] text-muted-foreground">Close this tab only, keep tmux session running.</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        dispatchCloseSession({
                          sessionId: menuSession.id,
                          source: 'tab-menu',
                          closeMode: 'destroy',
                        });
                        closeTabMenu();
                      }}
                      className={`${menuItemClassName} text-destructive hover:bg-destructive/10`}
                    >
                      <span className={`${menuIconClassName} bg-destructive/15 text-destructive`}>
                        <RiDeleteBinLine size={14} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">Destroy</span>
                        <span className="block text-[11px] text-muted-foreground">Kill the tmux session and all processes inside it.</span>
                      </span>
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      closeTabMenu();
                      dispatchCloseSession({ sessionId: menuSession.id, source: 'tab-menu', closeMode: 'auto' });
                    }}
                    className={`${menuItemClassName} text-destructive hover:bg-destructive/10`}
                  >
                    <span className={`${menuIconClassName} bg-destructive/15 text-destructive`}>
                      <RiCloseLine size={14} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{t('tab.close')}</span>
                      <span className="block text-[11px] text-muted-foreground">{t('tab.closeHint')}</span>
                    </span>
                  </button>
                )}
                {!isDesktopTabMenu && (
                  <button
                    type="button"
                    className="flex items-center justify-center px-4 py-2 text-[11px] text-muted-foreground/80 transition hover:text-foreground"
                    onClick={() => {
                      closeTabMenu();
                    }}
                  >
                    {t('tab.longPressTip')}
                  </button>
                )}
              </div>
              {!isDesktopTabMenu && (
                <div className="border-t border-border/15 px-3 py-2">
                  <button
                    type="button"
                    onClick={closeTabMenu}
                    className="w-full rounded-full bg-surface-2 px-3 py-2 text-[12px] font-medium text-muted-foreground transition hover:bg-surface hover:text-foreground"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              )}
            </div>
          </>
        );
      })()}

      {isNotificationsOpen && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-modal-backdrop bg-[var(--app-backdrop)] backdrop-blur-sm cursor-default"
            onClick={() => setIsNotificationsOpen(false)}
          />
          <div className="fixed inset-x-3 top-6 bottom-6 z-modal-panel mx-auto flex max-w-xl flex-col overflow-hidden rounded-2xl bg-surface border border-border/15 shadow-[0_28px_70px_var(--app-shadow-strong),0_14px_32px_var(--app-shadow-soft)] sm:top-[10%] sm:bottom-auto sm:max-h-[80vh]">
            <div className="flex shrink-0 items-center justify-between border-b border-border/15 px-4 py-4 sm:px-6">
              <div className="min-w-0">
                <div className="ui-kicker">{t('settings.notifications')}</div>
                <h2 className="section-title mt-1">{t('settings.notificationsTitle')}</h2>
              </div>
              <button
                type="button"
                onClick={() => setIsNotificationsOpen(false)}
                className="shrink-0 rounded-full bg-surface-2 p-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground"
                aria-label="Close notifications settings"
              >
                <RiCloseLine size={18} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                {t('settings.notificationsPageHint')}
              </p>

              <div className="mt-4 rounded-2xl bg-surface-2 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-foreground">{t('settings.notificationsMaster')}</div>
                    <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                      {pwaNotificationPermission === 'denied'
                        ? t('settings.notificationsDenied')
                        : !isPwaNotificationSupported()
                          ? t('settings.notificationsUnsupported')
                          : t('settings.notificationsMasterHint')}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleTogglePwaNotifications()}
                    disabled={!isPwaNotificationSupported() || pwaNotificationPermission === 'denied'}
                    className={`inline-flex h-7 w-12 shrink-0 items-center rounded-full transition ${
                      pwaNotificationsEnabled
                        ? 'bg-primary/80'
                        : pwaNotificationPermission === 'denied' || !isPwaNotificationSupported()
                          ? 'cursor-not-allowed bg-surface-elevated/50 opacity-60'
                          : 'bg-surface-elevated'
                    }`}
                    aria-pressed={pwaNotificationsEnabled}
                  >
                    <span className={`mx-1 inline-block h-5 w-5 rounded-full bg-[var(--background)] transition ${pwaNotificationsEnabled ? 'translate-x-5' : ''}`} />
                  </button>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
                  <span className={`rounded-full px-2 py-0.5 ${pwaNotificationPermission === 'granted' ? 'bg-primary/15 text-primary' : 'bg-surface text-muted-foreground'}`}>
                    {t('settings.notificationsPermission')}: {pwaNotificationPermission}
                  </span>
                  <button
                    type="button"
                    disabled={!pwaNotificationsEnabled || pwaNotificationPermission !== 'granted'}
                    onClick={() => void showPwaNotification({
                      title: 'Termdock',
                      body: t('settings.notificationsTestBody'),
                      tag: `termdock-notification-test-${Date.now()}`,
                      requireHidden: false,
                      data: { url: '/' },
                    })}
                    className="rounded-full bg-surface px-3 py-1.5 font-medium text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t('settings.notificationsTest')}
                  </button>
                </div>
              </div>

              <div className="mt-4 rounded-2xl bg-surface-2 p-3">
                <div className="text-[13px] font-semibold text-foreground">{t('settings.notificationsAlertStyle')}</div>
                <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  {t('settings.notificationsAlertStyleHint')}
                </div>
                <div className="mt-3 grid grid-cols-3 gap-1 rounded-xl bg-surface p-1">
                  {([
                    ['normal', t('settings.notificationsStyleNormal'), t('settings.notificationsStyleNormalHint')],
                    ['quiet', t('settings.notificationsStyleQuiet'), t('settings.notificationsStyleQuietHint')],
                    ['persistent', t('settings.notificationsStylePersistent'), t('settings.notificationsStylePersistentHint')],
                  ] as const).map(([style, label, hint]) => {
                    const selected = pwaNotificationAlertStyle === style;
                    return (
                      <button
                        key={style}
                        type="button"
                        disabled={!pwaNotificationsEnabled}
                        onClick={() => handleSelectPwaNotificationAlertStyle(style)}
                        className={`min-w-0 rounded-lg px-2 py-2 text-left transition ${
                          selected && pwaNotificationsEnabled
                            ? 'bg-primary/15 text-primary'
                            : pwaNotificationsEnabled
                              ? 'text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
                              : 'cursor-not-allowed text-muted-foreground/40'
                        }`}
                        title={hint}
                      >
                        <span className="block truncate text-[11px] font-semibold">{label}</span>
                        <span className="mt-0.5 block truncate text-[9px] opacity-80">{hint}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="mt-4">
                <div className="ui-kicker">{t('settings.notificationsEvents')}</div>
                <div className="mt-2 rounded-2xl bg-surface-2 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold text-foreground">{t('settings.notificationsAiFinished')}</div>
                      <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                        {t('settings.notificationsAiFinishedHint')}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={!pwaNotificationsEnabled}
                      onClick={() => handleTogglePwaAiNotifications(!pwaAiNotificationsEnabled)}
                      className={`inline-flex h-7 w-12 shrink-0 items-center rounded-full transition ${
                        pwaAiNotificationsEnabled && pwaNotificationsEnabled
                          ? 'bg-primary/80'
                          : pwaNotificationsEnabled
                            ? 'bg-surface-elevated'
                            : 'cursor-not-allowed bg-surface-elevated/50 opacity-60'
                      }`}
                      aria-pressed={pwaAiNotificationsEnabled && pwaNotificationsEnabled}
                    >
                      <span className={`mx-1 inline-block h-5 w-5 rounded-full bg-[var(--background)] transition ${pwaAiNotificationsEnabled && pwaNotificationsEnabled ? 'translate-x-5' : ''}`} />
                    </button>
                  </div>
                </div>
                <p className="mt-2 text-[10px] text-muted-foreground">
                  {t('settings.notificationsFutureHint')}
                </p>
              </div>
            </div>
          </div>
        </>
      )}

      {isToolbarPresetsOpen && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-modal-backdrop bg-[var(--app-backdrop)] backdrop-blur-sm cursor-default"
            onClick={() => setIsToolbarPresetsOpen(false)}
          />
          <div className="fixed inset-x-3 top-6 bottom-6 z-modal-panel mx-auto flex max-w-4xl flex-col overflow-hidden rounded-2xl bg-surface border border-border/15 shadow-[0_28px_70px_var(--app-shadow-strong),0_14px_32px_var(--app-shadow-soft)]">
            <div className="flex shrink-0 items-center justify-between border-b border-border/15 px-4 py-4 sm:px-6">
              <div className="min-w-0">
                <div className="ui-kicker">{t('settings.mobileKeyboard')}</div>
                <h2 className="section-title mt-1">{t('settings.toolbarPresets')}</h2>
              </div>
              <button
                type="button"
                onClick={() => setIsToolbarPresetsOpen(false)}
                className="shrink-0 rounded-full bg-surface-2 p-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground"
                aria-label="Close toolbar presets"
              >
                <RiCloseLine size={18} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
              <ToolbarPresetSettings
                presets={toolbarPresets}
                selectedPresetId={selectedToolbarPresetId}
                onSelectPreset={setSelectedToolbarPresetId}
                onUpdatePreset={(presetId, updater) => {
                  setToolbarPresets((current) => sanitizeToolbarPresets(current.map((preset) => (
                    preset.id === presetId ? updater(preset) : preset
                  ))));
                }}
                onAddPreset={() => {
                  const presetId = `preset-${Date.now()}`;
                  setToolbarPresets((current) => sanitizeToolbarPresets([
                    ...current,
                    {
                      id: presetId,
                      label: `Preset ${current.length}`,
                      programs: [],
                      includeAlt: false,
                      rowLayout: [3, 3],
                      actions: [],
                      showOnDesktop: false,
                    },
                  ]));
                  setSelectedToolbarPresetId(presetId);
                }}
                onRemovePreset={(presetId) => {
                  setToolbarPresets((current) => sanitizeToolbarPresets(current.filter((preset) => preset.id !== presetId)));
                }}
                onResetDefaults={() => {
                  setToolbarPresets(createDefaultToolbarPresets());
                  setSelectedToolbarPresetId('default');
                }}
              />
            </div>
          </div>
        </>
      )}

      {isAgentRulesOpen && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-modal-backdrop bg-[var(--app-backdrop)] backdrop-blur-sm cursor-default"
            onClick={() => setIsAgentRulesOpen(false)}
          />
          <div className="fixed inset-x-3 top-6 bottom-6 z-modal-panel mx-auto flex max-w-4xl flex-col overflow-hidden rounded-2xl bg-surface border border-border/15 shadow-[0_28px_70px_var(--app-shadow-strong),0_14px_32px_var(--app-shadow-soft)]">
            <div className="flex shrink-0 items-center justify-between border-b border-border/15 px-4 py-4 sm:px-6">
              <div className="min-w-0">
                <div className="ui-kicker">{t('settings.aiAgentDetection')}</div>
                <h2 className="section-title mt-1">{t('settings.detectionRules')}</h2>
              </div>
              <div className="flex items-center gap-2">
                {agentRulesSaving && (
                  <span className="text-[11px] text-muted-foreground">{t('settings.saving')}</span>
                )}
                <button
                  type="button"
                  onClick={() => setIsAgentRulesOpen(false)}
                  className="shrink-0 rounded-full bg-surface-2 p-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground"
                  aria-label="Close agent rules"
                >
                  <RiCloseLine size={18} />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
              <p className="mb-4 text-[11px] text-muted-foreground">
                Configure regex patterns to detect what an AI tool is doing in a terminal tab.
                Each rule can choose its label, color, icon style and how long the indicator is kept after output quiets down.
                When it stops and you haven't viewed the tab yet, the tab keeps a yellow review hint.
              </p>
              <AgentRulesSettings
                rules={agentRules}
                onChange={(rules) => {
                  setAgentRules(rules);
                  writeCache(AGENT_RULES_CACHE_KEY, rules);
                  setAgentRulesSaving(true);
                  replaceAgentRules(rules)
                    .then((saved) => {
                      setAgentRules(saved);
                      writeCache(AGENT_RULES_CACHE_KEY, saved);
                    })
                    .catch(() => { /* keep local state */ })
                    .finally(() => setAgentRulesSaving(false));
                }}
                onResetDefaults={() => {
                  setAgentRulesSaving(true);
                  resetAgentRules()
                    .then((rules) => {
                      setAgentRules(rules);
                      writeCache(AGENT_RULES_CACHE_KEY, rules);
                    })
                    .catch(() => { /* keep local state */ })
                    .finally(() => setAgentRulesSaving(false));
                }}
              />

              <div className="mt-6 border-t border-border/15 pt-4">
                <div className="ui-kicker">{t('settings.programLabelResolution')}</div>
                <h3 className="mt-1 text-sm font-semibold text-foreground">{t('settings.rawCommandMapping')}</h3>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t('settings.rawCommandMappingHint')}
                </p>
                <div className="mt-3 space-y-2 rounded-xl bg-surface-2 p-3">
                  {sessions.map((session) => {
                    const ts = terminalSessions.get(session.id);
                    const raw = ts?.activeProgramRaw ?? null;
                    const display = ts?.activeProgram ?? null;
                    return (
                      <div key={`raw-${session.id}`} className="rounded-lg bg-surface/60 px-2.5 py-2">
                        <div className="truncate text-[11px] text-muted-foreground">{session.name}</div>
                        <div className="mt-0.5 text-[11px] text-foreground"><span className="text-muted-foreground">display:</span> {display || '—'}</div>
                        <div className="mt-0.5 break-all font-mono text-[10px] text-muted-foreground"><span className="text-muted-foreground/80">raw:</span> {raw || '—'}</div>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-3 space-y-3">
                  {/* Detection config tag lists */}
                  {([
                    { key: 'genericProgramNames' as const, label: t('settings.genericProgramNames'), hint: t('settings.genericProgramNamesHint') },
                    { key: 'wrapperScriptNames' as const, label: t('settings.wrapperScriptNames'), hint: t('settings.wrapperScriptNamesHint') },
                    { key: 'shellNames' as const, label: t('settings.shellNamesConfig'), hint: t('settings.shellNamesHint') },
                  ] as const).map(({ key, label, hint }) => (
                    <div key={key}>
                      <div className="mb-0.5 text-[11px] font-medium text-foreground">{label}</div>
                      <div className="text-[10px] text-muted-foreground">{hint}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {programDetection[key].map((name) => (
                          <span
                            key={name}
                            className="inline-flex items-center gap-0.5 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-mono text-foreground"
                          >
                            {name}
                            <button
                              type="button"
                              onClick={() => {
                                const next = { ...programDetection, [key]: programDetection[key].filter((n) => n !== name) };
                                setProgramDetection(next);
                                if (key === 'shellNames') SHELL_NAMES = new Set(next.shellNames);
                                replaceProgramDetection(next).catch(() => {});
                              }}
                              className="ml-0.5 text-muted-foreground hover:text-destructive"
                            >
                              ×
                            </button>
                          </span>
                        ))}
                        <input
                          placeholder={t('settings.addTag')}
                          className="w-16 rounded bg-surface px-1.5 py-0.5 text-[11px] font-mono"
                          onKeyDown={(e) => {
                            if (e.key !== 'Enter') return;
                            const val = (e.target as HTMLInputElement).value.trim().toLowerCase();
                            if (!val || programDetection[key].includes(val)) return;
                            const next = { ...programDetection, [key]: [...programDetection[key], val] };
                            setProgramDetection(next);
                            if (key === 'shellNames') SHELL_NAMES = new Set(next.shellNames);
                            (e.target as HTMLInputElement).value = '';
                            replaceProgramDetection(next).catch(() => {});
                          }}
                        />
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      resetProgramDetection().then((config) => {
                        setProgramDetection(config);
                        SHELL_NAMES = new Set(config.shellNames);
                      }).catch(() => {});
                    }}
                    className="rounded-full bg-surface-2 px-3 py-1 text-[11px] text-muted-foreground hover:bg-surface-elevated hover:text-foreground"
                  >
                    {t('settings.resetDefaults')}
                  </button>
                </div>

                <div className="mt-3">
                  <div className="mb-1 text-[11px] font-medium text-foreground">{t('settings.customRules')}</div>
                  {programRules.map((rule, idx) => (
                    <div key={rule.id} className="mb-2 rounded-lg bg-surface-2 p-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="checkbox"
                          checked={rule.enabled !== false}
                          onChange={(e) => {
                            const next = programRules.map((r, i) => i === idx ? { ...r, enabled: e.target.checked } : r);
                            setProgramRules(next);
                            writeCache(PROGRAM_RULES_CACHE_KEY, next);
                            setProgramRulesSaving(true);
                            replaceProgramRules(next).then((saved) => {
                              setProgramRules(saved);
                              writeCache(PROGRAM_RULES_CACHE_KEY, saved);
                            }).catch(() => { /* keep local */ }).finally(() => setProgramRulesSaving(false));
                          }}
                        />
                        <select
                          value={rule.matchType}
                          onChange={(e) => {
                            const next = programRules.map((r, i) => i === idx ? { ...r, matchType: e.target.value as ProgramLabelRule['matchType'] } : r);
                            setProgramRules(next);
                            writeCache(PROGRAM_RULES_CACHE_KEY, next);
                            setProgramRulesSaving(true);
                            replaceProgramRules(next).then((saved) => {
                              setProgramRules(saved);
                              writeCache(PROGRAM_RULES_CACHE_KEY, saved);
                            }).catch(() => { /* keep local */ }).finally(() => setProgramRulesSaving(false));
                          }}
                          className="rounded bg-surface px-2 py-1 text-[11px]"
                        >
                          <option value="includes">includes</option>
                          <option value="exact">exact</option>
                          <option value="prefix">prefix</option>
                          <option value="regex">regex</option>
                        </select>
                        <input
                          value={rule.pattern}
                          onChange={(e) => {
                            const next = programRules.map((r, i) => i === idx ? { ...r, pattern: e.target.value } : r);
                            setProgramRules(next);
                            writeCache(PROGRAM_RULES_CACHE_KEY, next);
                          }}
                          onBlur={() => {
                            setProgramRulesSaving(true);
                            replaceProgramRules(programRules).then((saved) => {
                              setProgramRules(saved);
                              writeCache(PROGRAM_RULES_CACHE_KEY, saved);
                            }).catch(() => { /* keep local */ }).finally(() => setProgramRulesSaving(false));
                          }}
                          placeholder="pattern"
                          className="min-w-[180px] flex-1 rounded bg-surface px-2 py-1 text-[11px] font-mono"
                        />
                        <input
                          value={rule.output}
                          onChange={(e) => {
                            const next = programRules.map((r, i) => i === idx ? { ...r, output: e.target.value } : r);
                            setProgramRules(next);
                            writeCache(PROGRAM_RULES_CACHE_KEY, next);
                          }}
                          onBlur={() => {
                            setProgramRulesSaving(true);
                            replaceProgramRules(programRules).then((saved) => {
                              setProgramRules(saved);
                              writeCache(PROGRAM_RULES_CACHE_KEY, saved);
                            }).catch(() => { /* keep local */ }).finally(() => setProgramRulesSaving(false));
                          }}
                          placeholder="output"
                          className="w-28 rounded bg-surface px-2 py-1 text-[11px]"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const next = programRules.filter((_, i) => i !== idx);
                            setProgramRules(next);
                            writeCache(PROGRAM_RULES_CACHE_KEY, next);
                            setProgramRulesSaving(true);
                            replaceProgramRules(next).then((saved) => {
                              setProgramRules(saved);
                              writeCache(PROGRAM_RULES_CACHE_KEY, saved);
                            }).catch(() => { /* keep local */ }).finally(() => setProgramRulesSaving(false));
                          }}
                          className="rounded bg-surface px-2 py-1 text-[11px] text-muted-foreground hover:text-destructive"
                        >
                          {t('common.delete')}
                        </button>
                      </div>
                    </div>
                  ))}

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const next: ProgramLabelRule[] = [
                          ...programRules,
                          {
                            id: `rule-${Date.now()}`,
                            enabled: true,
                            priority: 100,
                            matchType: 'includes',
                            pattern: '',
                            output: '',
                          },
                        ];
                        setProgramRules(next);
                        writeCache(PROGRAM_RULES_CACHE_KEY, next);
                        setProgramRulesSaving(true);
                        replaceProgramRules(next).then((saved) => {
                          setProgramRules(saved);
                          writeCache(PROGRAM_RULES_CACHE_KEY, saved);
                        }).catch(() => { /* keep local */ }).finally(() => setProgramRulesSaving(false));
                      }}
                      className="rounded-full bg-primary/15 px-3 py-1.5 text-[11px] font-medium text-primary hover:bg-primary/25"
                    >
                      {t('settings.addRule')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setProgramRulesSaving(true);
                        resetProgramRules().then((rules) => {
                          setProgramRules(rules);
                          writeCache(PROGRAM_RULES_CACHE_KEY, rules);
                        }).catch(() => { /* keep local */ }).finally(() => setProgramRulesSaving(false));
                      }}
                      className="rounded-full bg-surface-2 px-3 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-surface-elevated hover:text-foreground"
                    >
                      {t('settings.resetDefaults')}
                    </button>
                    <span className="text-[11px] text-muted-foreground">{programRulesSaving ? t('settings.saving') : (programRulesLoaded ? `${programRules.length} rules` : '…')}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Overlay sidebars (both desktop and mobile) — overlays prevent the
          terminal area from resizing when the user toggles them, which would
          otherwise force xterm.js to refit on every open/close. */}
      <LeftSidebar
        isOpen={sidebarLeftOpen}
        drawerWidthPx={leftDrawerWidthPx}
        onClose={() => requestCloseHistoryOverlay('left-sidebar')}
        onOpen={handleOpenLeftSidebar}
        sessions={sessions}
        activeSessionId={activeSessionId}
        sessionStates={terminalSessions}
        onNewSession={(opts) => dispatchNewSession(opts)}
        onCloseSession={handleSidebarCloseSession}
        onReorderSessions={applySessionOrder}
        onOpenSettings={handleOpenSettings}
        tmuxAvailable={tmuxStatus.available}
        defaultSessionMode={newSessionMode}
      />
      <RightSidebar
        isOpen={sidebarRightOpen}
        drawerWidthPx={rightDrawerWidthPx}
        onClose={() => requestCloseHistoryOverlay('right-sidebar')}
        onOpen={handleOpenRightSidebar}
      />

      {showBackGuardHint && (
        <button
          type="button"
          onClick={handleContinueAfterBackGuard}
          className="fixed inset-0 z-toast flex cursor-default items-center justify-center bg-[var(--app-backdrop-soft)] px-6 text-left backdrop-blur-[1px]"
          aria-label={locale === 'zh' ? '继续使用 Termdock' : 'Continue using Termdock'}
        >
          <div className="max-w-[18rem] rounded-2xl border border-border/15 bg-surface/95 px-5 py-4 text-center shadow-[0_18px_50px_var(--app-shadow-strong)] backdrop-blur animate-fade-in">
            <div className="text-[14px] font-semibold text-foreground">
              {locale === 'zh' ? '建议使用 Home' : 'Use Home instead'}
            </div>
            <div className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
              {locale === 'zh'
                ? '按 Home 退后台，点任意位置继续。'
                : 'Use Home to leave. Tap anywhere to continue.'}
            </div>
            <div className="mt-3 text-[11px] font-medium text-muted-foreground/80">
              {locale === 'zh' ? '轻点关闭提示' : 'Tap to dismiss'}
            </div>
          </div>
        </button>
      )}

      {/* Debug Info Panel */}
      {showDebug && (
        <div className="fixed bottom-0 left-0 right-0 z-40 max-h-48 overflow-y-auto border-t border-border/15 bg-surface p-3 animate-fade-in">
          <div className="flex items-center justify-between mb-2">
            <h4 className="ui-kicker">Debug Info</h4>
            <button
              type="button"
              onClick={() => setShowDebug(false)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Close
            </button>
          </div>
          <pre className="text-xs font-mono whitespace-pre-wrap break-all">
            {JSON.stringify(debugInfo, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

export default App;
