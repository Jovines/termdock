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
  Keyboard as RiKeyboardLine,
  SlidersHorizontal as RiEqualizerLine,
  Layers as RiStackLine,
  Trash2 as RiDeleteBinLine,
  Unplug as RiLogoutBoxRLine,
  Bot as RiBotLine,
  LoaderCircle as RiLoaderCircle,
} from 'lucide-react';
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd';
import { useFontSize } from './lib/hooks/useFontSize';
import { useTerminalRenderer } from './lib/hooks/useTerminalRenderer';
import { useViewportHeight } from './lib/hooks/useViewportHeight';
import { useNewSessionDefaults } from './lib/hooks/useNewSessionDefaults';
import type { TerminalSessionState, TmuxSessionSummary, TmuxStatus } from './lib/terminal/types';
import type { TerminalRendererMode } from './lib/terminal/renderer';
import { getTmuxStatus, killTmuxSession, listTmuxSessions, getToolbarPresetsDoc, replaceToolbarPresetsDoc, logout, getSettings, updateSettings, getAgentRules, replaceAgentRules, resetAgentRules } from './lib/terminal/api';
import type { AgentProgramConfig } from './lib/terminal/api';
import { useTerminalStore } from './lib/stores/useTerminalStore';
import { useSidebarStore } from './lib/stores/useSidebarStore';
import { LeftSidebar } from './lib/components/sidebar/LeftSidebar';
import { RightSidebar } from './lib/components/sidebar/RightSidebar';
import { ToolbarPresetSettings } from './lib/components/settings/ToolbarPresetSettings';
import { AgentRulesSettings } from './lib/components/settings/AgentRulesSettings';
import { BUILTIN_TOOLBAR_PRESETS_VERSION, createDefaultToolbarPresets, getBuiltinToolbarPresetIds, sanitizeToolbarPresets, type ToolbarPresetDefinition } from './lib/components/terminal/mobileKeyboardPresets';

const SHELL_NAMES = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'nu']);

function getCwdLeafName(cwd: string | null): string | null {
  if (!cwd) return null;
  if (cwd === '/') return '/';
  const segments = cwd.replace(/\/+$/, '').split('/');
  return segments[segments.length - 1] || cwd;
}

function getTabDisplayLines(
  session: { name: string; customName?: boolean },
  activeProgram: string | null,
  cwd: string | null,
): { primary: string; secondary: string | null } {
  if (session.customName) return { primary: session.name, secondary: getCwdLeafName(cwd) };
  // 打开了非 shell 程序时：第一行程序名，第二行当前目录名
  if (activeProgram && !SHELL_NAMES.has(activeProgram)) {
    return { primary: activeProgram, secondary: getCwdLeafName(cwd) };
  }
  // 否则回落到目录名 / session.name
  const dir = getCwdLeafName(cwd);
  if (dir) return { primary: dir, secondary: null };
  return { primary: session.name, secondary: null };
}

type TabTerminalSessionState = Pick<
  TerminalSessionState,
  | 'cwd'
  | 'activeProgram'
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
  const baseIcon = sessionMode === 'tmux'
    ? <RiLayoutGridLine size={11} className="shrink-0" />
    : <RiTerminalLine size={11} className="shrink-0" />;
  const color = state?.agentColor || (state?.agentStatus === 'waiting' || state?.agentNeedsReview || state?.inCopyMode ? '#facc15' : undefined);

  if (state?.agentStatus) {
    const indicator = state.agentIndicator || (state.agentStatus === 'running' ? 'spinner' : 'pulse');
    const style = color ? { color } : undefined;
    if (indicator === 'spinner') {
      return <RiLoaderCircle size={11} className="shrink-0 animate-spin" style={style} />;
    }
    if (indicator === 'dot') {
      return <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color || '#4ade80' }} />;
    }
    if (indicator === 'ring') {
      return <span className="h-2.5 w-2.5 shrink-0 rounded-full border-2 animate-pulse" style={{ borderColor: color || '#facc15' }} />;
    }
    if (indicator === 'badge') {
      return <span className="shrink-0 rounded bg-surface px-1 text-[8px] font-semibold uppercase leading-3" style={style}>{state.agentStatus.slice(0, 2)}</span>;
    }
    if (indicator === 'terminal') {
      return sessionMode === 'tmux'
        ? <RiLayoutGridLine size={11} className="shrink-0" style={style} />
        : <RiTerminalLine size={11} className="shrink-0" style={style} />;
    }
    return <span className="h-2 w-2 shrink-0 animate-pulse rounded-full" style={{ backgroundColor: color || '#4ade80' }} />;
  }

  if (state?.agentNeedsReview || state?.inCopyMode) {
    return sessionMode === 'tmux'
      ? <RiLayoutGridLine size={11} className="shrink-0 text-yellow-400" />
      : <RiTerminalLine size={11} className="shrink-0 text-yellow-400" />;
  }

  return baseIcon;
}


function App() {
  const safeTopInset = 'env(safe-area-inset-top, 0px)';
  const safeBottomInset = 'env(safe-area-inset-bottom, 0px)';

  useViewportHeight();

  const [showDebug, setShowDebug] = React.useState(false);
  const [preventSleep, setPreventSleep] = React.useState(false);
  const [networkAvailable, setNetworkAvailable] = React.useState(true);
  const [debugInfo, setDebugInfo] = React.useState<Record<string, any>>({});
  const { fontSize, setFontSize } = useFontSize();
  const { rendererMode, setRendererMode } = useTerminalRenderer();
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

  // Sidebar state — only subscribe to the booleans we render, not the whole store.
  const sidebarLeftOpen = useSidebarStore((s) => s.leftOpen);
  const sidebarRightOpen = useSidebarStore((s) => s.rightOpen);
  const [isDesktopViewport, setIsDesktopViewport] = useState(() => (
    typeof window === 'undefined' ? true : window.matchMedia('(min-width: 1024px)').matches
  ));

  const [tmuxSessions, setTmuxSessions] = useState<TmuxSessionSummary[]>([]);
  const [tmuxStatus, setTmuxStatus] = useState<TmuxStatus>({ available: true, version: null, reason: null });
  const [tmuxRefreshing, setTmuxRefreshing] = useState(false);
  const [tmuxConfirmKillName, setTmuxConfirmKillName] = useState<string | null>(null);
  const [tmuxKillingName, setTmuxKillingName] = useState<string | null>(null);
  const [tmuxKillError, setTmuxKillError] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [tabMenuSessionId, setTabMenuSessionId] = useState<string | null>(null);
  const [tabCopiedHint, setTabCopiedHint] = useState<string | null>(null);
  const renameInputRef = React.useRef<HTMLInputElement | null>(null);
  const activeSessionTabRef = React.useRef<HTMLButtonElement | null>(null);
  const tabLongPressTimerRef = React.useRef<number | null>(null);
  const tabLongPressedRef = React.useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(min-width: 1024px)');
    const updateViewportMode = () => setIsDesktopViewport(media.matches);
    updateViewportMode();
    media.addEventListener('change', updateViewportMode);
    return () => media.removeEventListener('change', updateViewportMode);
  }, []);

  // Sync active session's cwd to sidebar store
  useEffect(() => {
    const ts = activeSessionId ? terminalSessions.get(activeSessionId) : null;
    useSidebarStore.getState().setRootPath(ts?.cwd ?? null);
  }, [activeSessionId, terminalSessions]);

  // Silently prewarm the git bundle when active cwd changes — populates
  // the server-side findGitRoot cache and the front-end sidebar store so
  // opening the right sidebar shows changes instantly. Throttled to avoid
  // hammering during bursty cwd updates (cd; cd; cd…).
  const prewarmTimerRef = React.useRef<number | null>(null);
  useEffect(() => {
    const ts = activeSessionId ? terminalSessions.get(activeSessionId) : null;
    const cwd = ts?.cwd ?? null;
    if (!cwd) return;
    if (prewarmTimerRef.current !== null) {
      window.clearTimeout(prewarmTimerRef.current);
    }
    let cancelled = false;
    prewarmTimerRef.current = window.setTimeout(() => {
      prewarmTimerRef.current = null;
      // Lazy import via existing API. Fire-and-forget; failure is fine.
      void import('./lib/terminal/api').then(({ getGitBundle }) => {
        if (cancelled) return;
        return getGitBundle(cwd).then((bundle) => {
          if (cancelled) return;
          // Only seed the store if user hasn't opened the sidebar yet OR
          // the rootPath still matches — avoid clobbering an in-flight
          // refresh from RightSidebar itself.
          const state = useSidebarStore.getState();
          if (state.rootPath !== cwd) return;
          if (state.changedFiles.size > 0) return;
          const map = new Map<string, string>();
          for (const f of bundle.files) {
            map.set(f.absolutePath || f.path, f.status);
          }
          state.setChangedFiles(map);
        }).catch(() => { /* ignore — not a git repo */ });
      });
    }, 600);
    return () => {
      cancelled = true;
      if (prewarmTimerRef.current !== null) {
        window.clearTimeout(prewarmTimerRef.current);
        prewarmTimerRef.current = null;
      }
    };
  }, [activeSessionId, terminalSessions]);

  // Sidebar drawer dimensions — overlays on both mobile & desktop, so we
  // never cause the terminal column to resize when toggling the sidebar.
  // Left and right have different ergonomic widths:
  //  - Right (file tree + diff): wide so we can fit a dual-column workspace.
  //  - Left  (session list):     narrow; one row per session is enough.
  const isMobile = !isDesktopViewport;
  const viewportWidth = typeof window === 'undefined' ? 1024 : window.innerWidth;
  const rightDrawerWidthPx = isMobile
    ? Math.min(viewportWidth * 0.92, 420)
    : Math.min(Math.max(viewportWidth * 0.9, 360), viewportWidth - 56);
  const leftDrawerWidthPx = isMobile
    ? Math.min(viewportWidth * 0.86, 380)
    : Math.min(Math.max(viewportWidth * 0.22, 280), 340);

  // Desktop keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'b' && !e.shiftKey) {
        e.preventDefault();
        useSidebarStore.getState().toggleLeft();
      }
      if (mod && e.shiftKey && e.key === 'E') {
        e.preventDefault();
        useSidebarStore.getState().toggleRight();
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
    };
  }, []);

  const handleDragEnd = useCallback((result: DropResult) => {
    if (!result.destination || result.source.index === result.destination.index) return;
    const newOrder = [...sessions];
    const [moved] = newOrder.splice(result.source.index, 1);
    newOrder.splice(result.destination.index, 0, moved);
    // 乐观更新本地顺序,避免 MultiTerminalView 异步回传期间发生一帧布局回弹
    setSessions(newOrder);
    window.dispatchEvent(new CustomEvent('reorder-terminal-session', {
      detail: { sessionIds: newOrder.map(s => s.id) },
    }));
  }, [sessions]);

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
    setNewSessionMode,
  } = useNewSessionDefaults();

  const [isToolbarPresetsOpen, setIsToolbarPresetsOpen] = React.useState(false);
  // Toolbar presets are owned by the server (~/.termdock/toolbar-presets.json)
  // and shared across every browser pointing at this server. We start with the
  // built-in defaults so the UI is usable on first paint, then load + reconcile
  // with the server state on mount.
  const [toolbarPresets, setToolbarPresets] = React.useState<ToolbarPresetDefinition[]>(() => createDefaultToolbarPresets());
  const [toolbarPresetsLoaded, setToolbarPresetsLoaded] = React.useState(false);
  const [selectedToolbarPresetId, setSelectedToolbarPresetId] = React.useState<string>('default');

  // Agent detection rules — owned by server (~/.termdock/agent-rules.json)
  const [isAgentRulesOpen, setIsAgentRulesOpen] = React.useState(false);
  const [agentRules, setAgentRules] = React.useState<AgentProgramConfig[]>([]);
  const [agentRulesLoaded, setAgentRulesLoaded] = React.useState(false);
  const [agentRulesSaving, setAgentRulesSaving] = React.useState(false);

  useEffect(() => {
    getAgentRules()
      .then((rules) => { setAgentRules(rules); setAgentRulesLoaded(true); })
      .catch(() => { /* use empty state */ });
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
        const stored = sanitizeToolbarPresets(
          Array.isArray(doc.presets) ? (doc.presets as ToolbarPresetDefinition[]) : [],
        );
        const storedVersion = typeof doc.version === 'number' ? doc.version : 0;
        const versionMismatch = storedVersion < BUILTIN_TOOLBAR_PRESETS_VERSION;

        let next: ToolbarPresetDefinition[];
        if (stored.length === 0) {
          next = defaults;
        } else if (versionMismatch) {
          // Replace built-in presets with the latest definitions, but
          // preserve user-customized rowLayout from stored presets.
          const storedMap = new Map(stored.map((p) => [p.id, p]));
          const customPresets = stored.filter((preset) => !builtinIds.has(preset.id));
          const updatedDefaults = defaults.map((preset) => {
            const existing = storedMap.get(preset.id);
            if (existing) {
              return { ...preset, rowLayout: existing.rowLayout };
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
        setToolbarPresets(next);
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
        setPreventSleep(s.preventSleep);
        setNetworkAvailable(s.networkAvailable);
      })
      .catch(() => { /* ignore — settings not available */ });
  }, []);

  useEffect(() => {
    if (!toolbarPresets.some((preset) => preset.id === selectedToolbarPresetId)) {
      setSelectedToolbarPresetId(toolbarPresets[0]?.id ?? 'default');
    }
  }, [selectedToolbarPresetId, toolbarPresets]);

  useEffect(() => {
    if (!tmuxStatus.available && newSessionMode === 'tmux') {
      setNewSessionMode('shell');
    }
  }, [newSessionMode, tmuxStatus.available, setNewSessionMode]);

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

  const activeSessionIndex = activeSessionId
    ? sessions.findIndex((session) => session.id === activeSessionId)
    : -1;
  const activeSessionPositionLabel = sessions.length > 0 && activeSessionIndex >= 0
    ? `${activeSessionIndex + 1}/${sessions.length}`
    : `${sessions.length}`;
  const agentTabCounts = React.useMemo(() => {
    let running = 0;
    let review = 0;
    for (const s of sessions) {
      const ts = terminalSessions.get(s.id);
      if (ts?.agentStatus === 'running') running += 1;
      if (ts?.agentNeedsReview) review += 1;
    }
    return { running, review };
  }, [sessions, terminalSessions]);
  const connectedTmuxNames = React.useMemo(
    () => new Set(sessions.filter((s) => s.mode === 'tmux' && s.tmuxSessionName).map((s) => s.tmuxSessionName)),
    [sessions],
  );

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

  const editingSessionIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    editingSessionIdRef.current = editingSessionId;
  }, [editingSessionId]);
  const lastTabTapRef = React.useRef<{ id: string; time: number } | null>(null);
  const tabSingleClickTimerRef = React.useRef<number | null>(null);

  const handleTabClick = useCallback((sessionId: string) => {
    window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: sessionId }));
  }, []);

  const handleTabPress = useCallback((sessionId: string) => {
    const DOUBLE_TAP_MS = 320;
    const now = performance.now();
    const last = lastTabTapRef.current;
    if (last && last.id === sessionId && now - last.time <= DOUBLE_TAP_MS) {
      // 双击 → 进入编辑态;取消挂起的单击切换
      if (tabSingleClickTimerRef.current !== null) {
        window.clearTimeout(tabSingleClickTimerRef.current);
        tabSingleClickTimerRef.current = null;
      }
      lastTabTapRef.current = null;
      setEditingSessionId(sessionId);
      return;
    }
    lastTabTapRef.current = { id: sessionId, time: now };
    if (tabSingleClickTimerRef.current !== null) {
      window.clearTimeout(tabSingleClickTimerRef.current);
    }
    tabSingleClickTimerRef.current = window.setTimeout(() => {
      tabSingleClickTimerRef.current = null;
      // 编辑态下不再发起切换
      if (editingSessionIdRef.current === sessionId) return;
      handleTabClick(sessionId);
    }, DOUBLE_TAP_MS);
  }, []);

  const handleTabPointerDown = useCallback((sessionId: string) => {
    tabLongPressedRef.current = false;
    if (tabLongPressTimerRef.current !== null) {
      window.clearTimeout(tabLongPressTimerRef.current);
    }
    tabLongPressTimerRef.current = window.setTimeout(() => {
      tabLongPressedRef.current = true;
      tabLongPressTimerRef.current = null;
      // 取消挂起的单击切换
      if (tabSingleClickTimerRef.current !== null) {
        window.clearTimeout(tabSingleClickTimerRef.current);
        tabSingleClickTimerRef.current = null;
      }
      lastTabTapRef.current = null;
      setTabMenuSessionId(sessionId);
      // 触觉反馈
      try { window.navigator.vibrate?.(15); } catch { /* ignore */ }
    }, 480);
  }, []);

  const cancelTabLongPress = useCallback(() => {
    if (tabLongPressTimerRef.current !== null) {
      window.clearTimeout(tabLongPressTimerRef.current);
      tabLongPressTimerRef.current = null;
    }
  }, []);

  const handleTabClickGuarded = useCallback((sessionId: string) => {
    if (tabLongPressedRef.current) {
      tabLongPressedRef.current = false;
      return;
    }
    handleTabPress(sessionId);
  }, [handleTabPress]);

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

  return (
    <div
      className="w-screen h-full flex flex-col bg-background text-foreground"
    >
      <main className="relative min-h-0 flex-1 overflow-visible px-0 pb-0 pt-0">
        <div className="flex h-full w-full min-h-0 flex-col overflow-visible bg-background">
          <div
            className="flex h-9 shrink-0 items-center justify-between gap-1 bg-background px-1 sm:h-10 sm:px-1.5"
          >
            <button
              type="button"
              onClick={() => useSidebarStore.getState().toggleLeft()}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted-foreground ring-1 ring-border/10 transition hover:bg-surface-elevated hover:text-foreground sm:h-8 sm:w-8"
              aria-label="Toggle sessions sidebar"
              title="Sessions"
            >
              <RiPanelLeftLine size={14} />
            </button>
            <DragDropContext onDragEnd={handleDragEnd}>
            <Droppable droppableId="tabs" direction="horizontal">
              {(provided) => (
            <div
              ref={provided.innerRef}
              {...provided.droppableProps}
              className="scrollbar-thin flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden whitespace-nowrap"
            >
              {sessions.map((session, index) => {
                const isActive = session.id === activeSessionId;
                const isEditing = session.id === editingSessionId;
                const ts = terminalSessions.get(session.id);
                const { primary: displayName, secondary: displaySubName } = getTabDisplayLines(
                  session,
                  ts?.activeProgram ?? null,
                  ts?.cwd ?? null,
                );
                const cwdLeaf = getCwdLeafName(ts?.cwd ?? null);
                const tabDirLabel = displaySubName ?? (cwdLeaf && cwdLeaf !== displayName ? cwdLeaf : null);
                const tooltip = ts?.cwd || session.name;
                const accentColor = ts?.agentStatus === 'running'
                  ? '#4ade80'
                  : (ts?.agentStatus === 'waiting' || ts?.agentNeedsReview)
                    ? '#facc15'
                    : ts?.inCopyMode
                      ? '#facc15'
                      : null;

                if (isEditing) {
                  const commitRename = (sessionId: string, value: string) => {
                    const trimmed = value.trim();
                    if (!trimmed) {
                      // 清空 → 重置为默认(程序名/目录名)显示
                      resetSessionName(sessionId);
                    } else if (trimmed !== session.name) {
                      // 只在值实际改变时才写入,避免双击直接退出就把 session 标成 customName
                      renameSession(sessionId, trimmed);
                    }
                    setEditingSessionId(null);
                  };

                return (
                  <React.Fragment key={session.id}>
                    <Draggable draggableId={session.id} index={index}>
                      {(provided) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.draggableProps}
                      {...provided.dragHandleProps}
                      className="flex h-full items-center"
                    >
                    <input
                      ref={(el) => {
                        renameInputRef.current = el;
                      }}
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
                    </div>
                      )}
                    </Draggable>
                    </React.Fragment>
                  );
                }

                return (
                  <React.Fragment key={session.id}>
                  <Draggable draggableId={session.id} index={index}>
                    {(provided, snapshot) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.draggableProps}
                      {...provided.dragHandleProps}
                      className={`flex h-full shrink-0 items-center ${snapshot.isDragging ? 'opacity-70' : ''}`}
                    >
                  <button
                    ref={isActive ? activeSessionTabRef : null}
                    type="button"
                    onClick={() => handleTabClickGuarded(session.id)}
                    onPointerDown={() => handleTabPointerDown(session.id)}
                    onPointerUp={cancelTabLongPress}
                    onPointerLeave={cancelTabLongPress}
                    onPointerCancel={cancelTabLongPress}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      cancelTabLongPress();
                      setTabMenuSessionId(session.id);
                    }}
                    className={`group relative inline-flex h-8 shrink-0 items-center overflow-hidden rounded-md pl-1.5 pr-2 text-[12px] leading-none transition max-w-[8rem] sm:h-8 sm:max-w-[12rem] ${
                      isActive
                        ? 'bg-surface-elevated text-foreground shadow-sm'
                        : 'text-muted-foreground hover:bg-surface-elevated/50 hover:text-foreground'
                    }`}
                    style={isActive && accentColor
                      ? { boxShadow: `inset 2px 0 0 0 ${accentColor}` }
                      : isActive
                        ? { boxShadow: 'inset 2px 0 0 0 rgb(var(--primary-rgb, 99 102 241))' }
                        : undefined}
                    title={tooltip}
                  >
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <span className="inline-flex shrink-0 items-center">
                        {renderTabIcon(session.mode, ts)}
                      </span>
                      {tabDirLabel ? (
                        <span className="flex min-w-0 flex-col justify-center leading-[0.85rem]">
                          <span className={`truncate text-[12px] ${ts?.inCopyMode ? 'text-yellow-400' : ''}`}>{displayName}</span>
                          <span className="truncate text-[9.5px] text-muted-foreground/80">
                            {tabDirLabel}
                          </span>
                        </span>
                      ) : (
                        <span className={`truncate text-[12px] ${ts?.inCopyMode ? 'text-yellow-400' : ''}`}>{displayName}</span>
                      )}
                    </span>
                  </button>
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
                aria-label="New session"
                title="New session"
              >
                <RiAddLine size={14} />
              </button>
              {provided.placeholder}
            </div>
              )}
            </Droppable>
            </DragDropContext>
            <div className="flex shrink-0 items-center gap-1.5">
              {(agentTabCounts.running > 0 || agentTabCounts.review > 0) && (
                <span className="hidden items-center gap-1 sm:inline-flex">
                  {agentTabCounts.running > 0 && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full bg-green-400/10 px-1.5 py-0.5 text-[10px] font-medium text-green-400"
                      title="AI running"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
                      {agentTabCounts.running}
                    </span>
                  )}
                  {agentTabCounts.review > 0 && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full bg-yellow-400/10 px-1.5 py-0.5 text-[10px] font-medium text-yellow-400"
                      title="Needs review"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-yellow-400" />
                      {agentTabCounts.review}
                    </span>
                  )}
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
                onClick={() => useSidebarStore.getState().toggleRight()}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted-foreground ring-1 ring-border/10 transition hover:bg-surface-elevated hover:text-foreground sm:h-8 sm:w-8"
                aria-label="Toggle explorer sidebar"
                title="Explorer"
              >
                <RiPanelRightLine size={14} />
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 flex overflow-hidden bg-background">
            <div className="min-h-0 flex-1 overflow-hidden">
              <MultiTerminalView
                fontSize={fontSize}
                rendererMode={rendererMode}
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

      {/* Settings drawer (single page) */}
      {isDrawerOpen && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 bg-[rgba(0,0,0,0.5)] backdrop-blur-sm animate-fade-in cursor-default"
            onClick={() => setIsDrawerOpen(false)}
          />
          <div
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[26rem] flex-col border-l border-border/15 bg-surface animate-fade-in"
            style={{ paddingTop: safeTopInset, paddingBottom: safeBottomInset }}
          >
            {/* Header — compact single row */}
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/15 px-3 py-2.5">
              <div className="min-w-0 flex items-center gap-2">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-primary">
                  <RiEqualizerLine size={14} />
                </span>
                <h2 className="text-[14px] font-semibold text-foreground">Settings</h2>
              </div>
              <button
                type="button"
                onClick={() => setIsDrawerOpen(false)}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-destructive/20 hover:text-destructive"
                aria-label="Close"
              >
                <RiCloseLine size={16} />
              </button>
            </div>

            {/* Content */}
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
              {/* Quick row: font size + renderer + toggles, all visible at-a-glance */}
              <div className="space-y-2">
                {/* Font size */}
                <div className="flex items-center gap-2 rounded-xl bg-surface-2 px-2.5 py-2">
                  <span className="text-[12px] font-medium text-foreground/90 w-14 shrink-0">Font</span>
                  <button
                    type="button"
                    onClick={() => setFontSize(Math.max(8, fontSize - 1))}
                    className="h-8 w-8 shrink-0 rounded-md bg-surface text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
                  >
                    −
                  </button>
                  <input
                    type="range"
                    min="8"
                    max="32"
                    value={fontSize}
                    onChange={(e) => setFontSize(parseInt(e.target.value, 10))}
                    className="min-w-0 flex-1"
                    aria-label="Font size"
                  />
                  <button
                    type="button"
                    onClick={() => setFontSize(Math.min(32, fontSize + 1))}
                    className="h-8 w-8 shrink-0 rounded-md bg-surface text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground active:scale-95"
                  >
                    +
                  </button>
                  <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{fontSize}px</span>
                </div>

                {/* Renderer + Debug + Prevent-sleep — single dense row */}
                <div className="flex items-center gap-2 rounded-xl bg-surface-2 px-2.5 py-2">
                  <span className="text-[12px] font-medium text-foreground/90 w-14 shrink-0">Render</span>
                  <div className="flex flex-1 items-center gap-1 rounded-md bg-surface p-0.5">
                    {(['auto', 'webgl', 'canvas'] as TerminalRendererMode[]).map((mode) => {
                      const selected = rendererMode === mode;
                      return (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => setRendererMode(mode)}
                          className={`flex-1 rounded px-2 py-1 text-[11px] font-medium transition ${
                            selected ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:bg-surface-elevated'
                          }`}
                        >
                          {mode === 'auto' ? 'Auto' : mode === 'webgl' ? 'WebGL' : 'Canvas'}
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
                    <span className="font-medium">Debug</span>
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
                      } catch {
                        setPreventSleep(!newValue);
                      }
                    }}
                    className={`flex items-center justify-between rounded-xl px-3 py-2 text-[12px] transition ${
                      preventSleep ? 'bg-green-500/15 text-green-400' : 'bg-surface-2 text-foreground hover:bg-surface-elevated'
                    }`}
                    title={!networkAvailable && preventSleep ? 'No network — disabled' : undefined}
                  >
                    <span className="font-medium truncate">No sleep</span>
                    <span className={`inline-flex h-4 w-7 items-center rounded-full transition ${
                      preventSleep ? 'bg-green-500' : 'bg-surface-elevated'
                    }`}>
                      <span className={`mx-0.5 inline-block h-3 w-3 rounded-full transition ${
                        preventSleep ? 'translate-x-3 bg-white' : 'bg-foreground/90'
                      }`} />
                    </span>
                  </button>
                </div>
              </div>

              {/* New session shortcut */}
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => { dispatchNewSession({ mode: 'shell' }); setIsDrawerOpen(false); }}
                  className="flex items-center justify-center gap-1.5 rounded-xl bg-primary/15 px-3 py-2.5 text-[13px] font-medium text-primary transition hover:bg-primary/25 active:scale-[0.98]"
                >
                  <RiAddLine size={14} />
                  <RiTerminalLine size={12} />
                  Shell
                </button>
                <button
                  type="button"
                  disabled={!tmuxStatus.available}
                  onClick={() => { dispatchNewSession({ mode: 'tmux' }); setIsDrawerOpen(false); }}
                  className={`flex items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-[13px] font-medium transition active:scale-[0.98] ${
                    tmuxStatus.available
                      ? 'bg-surface-2 text-foreground hover:bg-surface-elevated'
                      : 'bg-surface-2/50 text-muted-foreground/50 cursor-not-allowed'
                  }`}
                >
                  <RiAddLine size={14} />
                  <RiLayoutGridLine size={12} />
                  Tmux
                </button>
              </div>

              {/* Tmux server (only when available or has sessions) */}
              {(tmuxStatus.available || tmuxSessions.length > 0) && (
                <details className="mt-3 group rounded-xl bg-surface-2 [&[open]]:bg-surface-2">
                  <summary className="flex cursor-pointer items-center justify-between rounded-xl px-3 py-2.5 text-[13px] hover:bg-surface-elevated">
                    <span className="flex items-center gap-2">
                      <span className={`inline-flex h-2 w-2 rounded-full ${tmuxStatus.available ? 'bg-primary' : 'bg-destructive'}`} />
                      <span className="font-medium">Tmux server</span>
                      <span className="text-[11px] text-muted-foreground">
                        {tmuxStatus.available
                          ? `${tmuxSessions.length} session${tmuxSessions.length === 1 ? '' : 's'}`
                          : 'unavailable'}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={(e) => { e.preventDefault(); void refreshTmuxSessions(); }}
                      disabled={tmuxRefreshing}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground disabled:opacity-50"
                      aria-label="Refresh tmux"
                    >
                      <RiRefreshLine size={12} className={tmuxRefreshing ? 'animate-spin' : ''} />
                    </button>
                  </summary>
                  <div className="px-2 pb-2">
                    {!tmuxStatus.available ? (
                      <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
                        {tmuxStatus.reason || 'Install tmux on the server to enable.'}
                      </p>
                    ) : tmuxSessions.length === 0 ? (
                      <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
                        No tmux sessions on the server.
                      </p>
                    ) : (
                      <div className="space-y-1">
                        {tmuxSessions.map((tmux) => {
                          const connected = connectedTmuxNames.has(tmux.name);
                          const confirming = tmuxConfirmKillName === tmux.name;
                          const killing = tmuxKillingName === tmux.name;
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
                                <div className="text-[10px] text-muted-foreground">
                                  {tmux.windows} window{tmux.windows === 1 ? '' : 's'}{connected && ' · attached'}
                                </div>
                              </div>
                              {!confirming ? (
                                <>
                                  <button
                                    type="button"
                                    disabled={connected}
                                    onClick={() => dispatchNewSession({ mode: 'tmux', tmuxSessionName: tmux.name })}
                                    className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                                      connected
                                        ? 'bg-surface text-muted-foreground cursor-not-allowed'
                                        : 'bg-primary/15 text-primary hover:bg-primary/25'
                                    }`}
                                  >
                                    {connected ? 'Attached' : 'Attach'}
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
                                    {killing ? '…' : 'Destroy'}
                                  </button>
                                  <button
                                    type="button"
                                    disabled={killing}
                                    onClick={() => { setTmuxConfirmKillName(null); setTmuxKillError(null); }}
                                    className="shrink-0 rounded-full bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-foreground transition hover:bg-surface-elevated"
                                  >
                                    Cancel
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
                  <span className="font-medium text-foreground">Keyboard toolbar</span>
                </span>
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span>{toolbarPresets.length} preset{toolbarPresets.length === 1 ? '' : 's'}</span>
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
                  <span className="font-medium text-foreground">AI agent detection</span>
                </span>
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span>{agentRulesLoaded ? `${agentRules.length} prog${agentRules.length === 1 ? '' : 's'}` : '…'}</span>
                  <span>›</span>
                </span>
              </button>

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
                Sign out
              </button>
            </div>
          </div>
        </>
      )}

      {/* Tab long-press menu */}
      {tabMenuSessionId && (() => {
        const menuSession = sessions.find((s) => s.id === tabMenuSessionId);
        if (!menuSession) return null;
        const ts = terminalSessions.get(menuSession.id);
        const { primary: menuName } = getTabDisplayLines(
          menuSession,
          ts?.activeProgram ?? null,
          ts?.cwd ?? null,
        );
        return (
          <>
            <button
              type="button"
              className="fixed inset-0 z-[55] bg-[rgba(0,0,0,0.4)] backdrop-blur-sm cursor-default animate-fade-in"
              onClick={() => setTabMenuSessionId(null)}
              aria-label="Close menu"
            />
            <div
              className="fixed inset-x-3 bottom-6 z-[60] mx-auto max-w-sm rounded-2xl bg-surface-elevated border border-border/15 shadow-[0_18px_48px_rgba(0,0,0,0.18)] animate-fade-in sm:bottom-auto sm:top-[15%]"
              style={{ paddingBottom: safeBottomInset }}
            >
              <div className="border-b border-border/15 px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Session</div>
                <div className="mt-0.5 truncate text-[14px] font-medium text-foreground">{menuName}</div>
                {ts?.cwd && (
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground/80">{ts.cwd}</div>
                )}
              </div>
              <div className="flex flex-col py-1">
                <button
                  type="button"
                  onClick={() => {
                    setTabMenuSessionId(null);
                    setEditingSessionId(menuSession.id);
                  }}
                  className="flex items-center gap-3 px-4 py-3 text-left text-[13px] text-foreground transition hover:bg-surface-2"
                >
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-surface-2 text-muted-foreground">
                    <RiTerminalLine size={14} />
                  </span>
                  Rename
                </button>
                <button
                  type="button"
                  disabled={!ts?.cwd}
                  onClick={() => {
                    void copyCwdToClipboard(menuSession.id);
                    setTabMenuSessionId(null);
                  }}
                  className={`flex items-center gap-3 px-4 py-3 text-left text-[13px] transition ${
                    ts?.cwd
                      ? 'text-foreground hover:bg-surface-2'
                      : 'text-muted-foreground/50 cursor-not-allowed'
                  }`}
                >
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-surface-2 text-muted-foreground">
                    <RiStackLine size={14} />
                  </span>
                  Copy cwd
                  {tabCopiedHint && tabCopiedHint === ts?.cwd && (
                    <span className="ml-auto text-[11px] text-primary">Copied</span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTabMenuSessionId(null);
                    window.dispatchEvent(new CustomEvent('close-terminal-session', { detail: menuSession.id }));
                  }}
                  className="flex items-center gap-3 px-4 py-3 text-left text-[13px] text-destructive transition hover:bg-destructive/10"
                >
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-destructive/15 text-destructive">
                    <RiCloseLine size={14} />
                  </span>
                  Close session
                </button>
              </div>
              <div className="border-t border-border/15 px-3 py-2">
                <button
                  type="button"
                  onClick={() => setTabMenuSessionId(null)}
                  className="w-full rounded-full bg-surface-2 px-3 py-2 text-[12px] font-medium text-muted-foreground transition hover:bg-surface hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
            </div>
          </>
        );
      })()}

      {isToolbarPresetsOpen && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-[60] bg-[rgba(0,0,0,0.5)] backdrop-blur-sm cursor-default"
            onClick={() => setIsToolbarPresetsOpen(false)}
          />
          <div className="fixed inset-x-3 top-6 bottom-6 z-[70] mx-auto flex max-w-4xl flex-col overflow-hidden rounded-2xl bg-surface border border-border/15 shadow-[0_28px_70px_rgba(0,0,0,0.14),0_14px_32px_rgba(0,0,0,0.10)]">
            <div className="flex shrink-0 items-center justify-between border-b border-border/15 px-4 py-4 sm:px-6">
              <div className="min-w-0">
                <div className="ui-kicker">Mobile keyboard</div>
                <h2 className="section-title mt-1">Toolbar presets</h2>
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
            className="fixed inset-0 z-[60] bg-[rgba(0,0,0,0.5)] backdrop-blur-sm cursor-default"
            onClick={() => setIsAgentRulesOpen(false)}
          />
          <div className="fixed inset-x-3 top-6 bottom-6 z-[70] mx-auto flex max-w-4xl flex-col overflow-hidden rounded-2xl bg-surface border border-border/15 shadow-[0_28px_70px_rgba(0,0,0,0.14),0_14px_32px_rgba(0,0,0,0.10)]">
            <div className="flex shrink-0 items-center justify-between border-b border-border/15 px-4 py-4 sm:px-6">
              <div className="min-w-0">
                <div className="ui-kicker">AI agent detection</div>
                <h2 className="section-title mt-1">Detection rules</h2>
              </div>
              <div className="flex items-center gap-2">
                {agentRulesSaving && (
                  <span className="text-[11px] text-muted-foreground">Saving…</span>
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
                  setAgentRulesSaving(true);
                  replaceAgentRules(rules)
                    .then((saved) => setAgentRules(saved))
                    .catch(() => { /* keep local state */ })
                    .finally(() => setAgentRulesSaving(false));
                }}
                onResetDefaults={() => {
                  setAgentRulesSaving(true);
                  resetAgentRules()
                    .then((rules) => setAgentRules(rules))
                    .catch(() => { /* keep local state */ })
                    .finally(() => setAgentRulesSaving(false));
                }}
              />
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
        onClose={useSidebarStore.getState().closeLeft}
        onOpen={useSidebarStore.getState().openLeft}
        sessions={sessions}
        activeSessionId={activeSessionId}
        sessionStates={terminalSessions}
        onNewSession={(opts) => dispatchNewSession(opts)}
        onCloseSession={(sessionId) => {
          window.dispatchEvent(new CustomEvent('close-terminal-session', { detail: sessionId }));
        }}
        onOpenSettings={() => setIsDrawerOpen(true)}
        tmuxAvailable={tmuxStatus.available}
      />
      <RightSidebar
        isOpen={sidebarRightOpen}
        drawerWidthPx={rightDrawerWidthPx}
        onClose={useSidebarStore.getState().closeRight}
        onOpen={useSidebarStore.getState().openRight}
      />

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
