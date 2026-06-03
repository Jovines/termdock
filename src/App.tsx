import React, { useEffect, useCallback, useState } from 'react';
import { MultiTerminalView, type TerminalSessionInfo } from './lib/components/MultiTerminalView';
import {
  SquareTerminal as RiTerminalBoxLine,
  Plus as RiAddLine,
  X as RiCloseLine,
  PanelLeft as RiPanelLeftLine,
  PanelRight as RiPanelRightLine,
  LayoutGrid as RiLayoutGridLine,
  RefreshCw as RiRefreshLine,
  Check as RiCheckLine,
  Terminal as RiTerminalLine,
  Keyboard as RiKeyboardLine,
  SlidersHorizontal as RiEqualizerLine,
  Layers as RiStackLine,
  Trash2 as RiDeleteBinLine,
  Unplug as RiLogoutBoxRLine,
  GripVertical,
  Bot as RiBotLine,
  LoaderCircle as RiLoaderCircle,
} from 'lucide-react';
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd';
import { useFontSize } from './lib/hooks/useFontSize';
import { useTerminalRenderer } from './lib/hooks/useTerminalRenderer';
import { useViewportHeight } from './lib/hooks/useViewportHeight';
import { useNewSessionDefaults } from './lib/hooks/useNewSessionDefaults';
import { clientLog } from './lib/utils/clientLog';
import type { TerminalSessionState, TmuxSessionSummary, TmuxStatus } from './lib/terminal/types';
import type { TerminalRendererMode } from './lib/terminal/renderer';
import { getTmuxStatus, killTmuxSession, listTmuxSessions, getToolbarPresetsDoc, replaceToolbarPresetsDoc, logout, getSettings, updateSettings, getAgentRules, replaceAgentRules, resetAgentRules } from './lib/terminal/api';
import type { AgentProgramConfig } from './lib/terminal/api';
import { readCache, writeCache, shallowJsonEqual } from './lib/utils/localStorageCache';
import { useTerminalStore } from './lib/stores/useTerminalStore';
import { useSidebarStore } from './lib/stores/useSidebarStore';
import { LeftSidebar } from './lib/components/sidebar/LeftSidebar';
import { RightSidebar } from './lib/components/sidebar/RightSidebar';
import { ToolbarPresetSettings } from './lib/components/settings/ToolbarPresetSettings';
import { AgentRulesSettings } from './lib/components/settings/AgentRulesSettings';
import { BUILTIN_TOOLBAR_PRESETS_VERSION, createDefaultToolbarPresets, getBuiltinToolbarPresetIds, sanitizeToolbarPresets, type ToolbarPresetDefinition } from './lib/components/terminal/mobileKeyboardPresets';

type DrawerTab = 'sessions' | 'new' | 'tmux' | 'settings';

// Cache keys for app-level lazy data fetched from the server. 缓存只是"上次看到"的
// 快照，每次启动还是会发 HTTP 校准；命中时让 UI 不再闪烁默认值 → 自定义值。
const AGENT_RULES_CACHE_KEY = 'termdock-agent-rules-cache';
const TOOLBAR_PRESETS_CACHE_KEY = 'termdock-toolbar-presets-cache';
const SETTINGS_CACHE_KEY = 'termdock-settings-cache';

function isAgentRulesArray(v: unknown): v is AgentProgramConfig[] {
  return Array.isArray(v) && v.every((entry) =>
    typeof entry === 'object' && entry !== null &&
    typeof (entry as { program?: unknown }).program === 'string' &&
    Array.isArray((entry as { rules?: unknown }).rules)
  );
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
}
function isSettingsCacheDoc(v: unknown): v is SettingsCacheDoc {
  return typeof v === 'object' && v !== null &&
    typeof (v as { preventSleep?: unknown }).preventSleep === 'boolean' &&
    typeof (v as { networkAvailable?: unknown }).networkAvailable === 'boolean';
}

function getSessionModeLabel(mode: 'shell' | 'tmux'): string {
  return mode === 'tmux' ? 'tmux' : 'shell';
}

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
  // Hydrate settings from cache so the toggles show user's real choice on cold
  // start instead of flashing the defaults until the HTTP fetch resolves.
  const cachedSettings = React.useRef<SettingsCacheDoc | null>(readCache(SETTINGS_CACHE_KEY, isSettingsCacheDoc)).current;
  const [preventSleep, setPreventSleep] = React.useState(cachedSettings?.preventSleep ?? false);
  const [networkAvailable, setNetworkAvailable] = React.useState(cachedSettings?.networkAvailable ?? true);
  const [debugInfo, setDebugInfo] = React.useState<Record<string, any>>({});
  const { fontSize, setFontSize } = useFontSize();
  const { rendererMode, setRendererMode } = useTerminalRenderer();
  const [isDrawerOpen, setIsDrawerOpen] = React.useState(false);
  const [drawerTab, setDrawerTab] = React.useState<DrawerTab>('sessions');
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

  // Per-session xterm scrollback + tab metadata cache 已撤回：高频写 + 多种边界
  // （clearBuffer 写空、setTerminalSession reset、auto-recreate 路径等）导致缓存
  // 经常被脏写，xterm 首帧反而经常拿到空内容。等想清楚每一种状态变迁该不该入缓存
  // 之前，先不做这一层。设置 / 工具栏 / agent rules 这种简单 KV 缓存继续保留。

  // Sidebar state — only subscribe to the booleans we render, not the whole store.
  const sidebarLeftOpen = useSidebarStore((s) => s.leftOpen);
  const sidebarRightOpen = useSidebarStore((s) => s.rightOpen);

  const [tmuxSessions, setTmuxSessions] = useState<TmuxSessionSummary[]>([]);
  const [tmuxStatus, setTmuxStatus] = useState<TmuxStatus>({ available: true, version: null, reason: null });
  const [tmuxRefreshing, setTmuxRefreshing] = useState(false);
  const [tmuxConfirmKillName, setTmuxConfirmKillName] = useState<string | null>(null);
  const [tmuxKillingName, setTmuxKillingName] = useState<string | null>(null);
  const [tmuxKillError, setTmuxKillError] = useState<string | null>(null);
  const [sessionConfirmDestroyId, setSessionConfirmDestroyId] = useState<string | null>(null);
  const [sessionDestroyingId, setSessionDestroyingId] = useState<string | null>(null);
  const [sessionDestroyError, setSessionDestroyError] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const renameInputRef = React.useRef<HTMLInputElement | null>(null);
  const activeSessionTabRef = React.useRef<HTMLButtonElement | null>(null);

  // Sync active session's cwd to sidebar store
  useEffect(() => {
    const ts = activeSessionId ? terminalSessions.get(activeSessionId) : null;
    useSidebarStore.getState().setRootPath(ts?.cwd ?? null);
  }, [activeSessionId, terminalSessions]);

  // Sidebar drawer dimensions
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  const drawerWidthPx = isMobile ? Math.min(window.innerWidth * 0.92, 420) : 360;

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

    // [DEBUG fn] document 级捕获阶段监控所有 keydown / keyup，看 Fn 单按是否到 web 层
    const dbgDown = (e: KeyboardEvent) => {
      clientLog('debug', '[fn-debug][doc capture keydown]', {
        key: e.key,
        code: e.code,
        keyCode: e.keyCode,
        target: (e.target as HTMLElement)?.tagName,
        activeEl: document.activeElement?.tagName,
      });
    };
    const dbgUp = (e: KeyboardEvent) => {
      clientLog('debug', '[fn-debug][doc capture keyup]', {
        key: e.key,
        code: e.code,
        keyCode: e.keyCode,
        target: (e.target as HTMLElement)?.tagName,
        activeEl: document.activeElement?.tagName,
      });
    };
    const dbgFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      clientLog('debug', '[fn-debug][focusin]', {
        tag: t?.tagName,
        cls: t?.className,
      });
    };
    document.addEventListener('keydown', dbgDown, true);
    document.addEventListener('keyup', dbgUp, true);
    document.addEventListener('focusin', dbgFocusIn);

    return () => {
      document.removeEventListener('keydown', handler);
      document.removeEventListener('keydown', dbgDown, true);
      document.removeEventListener('keyup', dbgUp, true);
      document.removeEventListener('focusin', dbgFocusIn);
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
    setNewSessionTmuxName,
  } = useNewSessionDefaults();

  const [isToolbarPresetsOpen, setIsToolbarPresetsOpen] = React.useState(false);
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
        writeCache(SETTINGS_CACHE_KEY, {
          preventSleep: s.preventSleep,
          networkAvailable: s.networkAvailable,
        });
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

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const activeSessionIndex = activeSessionId
    ? sessions.findIndex((session) => session.id === activeSessionId)
    : -1;
  const activeSessionModeLabel = activeSession ? getSessionModeLabel(activeSession.mode) : null;
  const activeSessionPositionLabel = sessions.length > 0 && activeSessionIndex >= 0
    ? `${activeSessionIndex + 1}/${sessions.length}`
    : `${sessions.length}`;
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

  // Close a session AND destroy its underlying tmux session in one shot.
  // Only meaningful for `mode === 'tmux'` sessions. The backend
  // `tmux/sessions DELETE` route already cleans up local pty sessions wired
  // to that tmux session, so we just need to mirror frontend tab removal via
  // the existing `close-terminal-session-by-backend` event.
  const handleDestroyTmuxForSession = useCallback(async (session: TerminalSessionInfo) => {
    if (session.mode !== 'tmux' || !session.tmuxSessionName) return;
    setSessionDestroyingId(session.id);
    setSessionDestroyError(null);
    try {
      const { cleanedSessions } = await killTmuxSession(session.tmuxSessionName);
      for (const backendId of cleanedSessions) {
        window.dispatchEvent(new CustomEvent('close-terminal-session-by-backend', { detail: backendId }));
      }
      // Fallback: if the backend reported no cleaned sessions (e.g. tmux
      // session was already gone), still drop the local tab.
      if (cleanedSessions.length === 0) {
        window.dispatchEvent(new CustomEvent('close-terminal-session', { detail: session.id }));
      }
      setSessionConfirmDestroyId(null);
    } catch (error) {
      setSessionDestroyError(error instanceof Error ? error.message : 'Failed to destroy tmux session');
    } finally {
      setSessionDestroyingId(null);
    }
  }, []);

  // Auto-refresh tmux sessions when drawer is open and on tmux/new tabs
  useEffect(() => {
    if (!isDrawerOpen) return;
    if (drawerTab !== 'tmux' && drawerTab !== 'new') return;

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
  }, [isDrawerOpen, drawerTab]);

  const tabDefs: Array<{ id: DrawerTab; label: string; icon: React.ReactNode; badge?: number | null }> = [
    { id: 'sessions', label: 'Sessions', icon: <RiStackLine size={16} />, badge: sessions.length },
    { id: 'new', label: 'New', icon: <RiAddLine size={16} /> },
    {
      id: 'tmux',
      label: 'Tmux',
      icon: <RiLayoutGridLine size={16} />,
      badge: tmuxStatus.available ? tmuxSessions.length : null,
    },
    { id: 'settings', label: 'Settings', icon: <RiEqualizerLine size={16} /> },
  ];

  // Swipe-to-switch tab support for the settings drawer.
  const swipeStateRef = React.useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    decided: 'h' | 'v' | null;
    pointerType: string;
  } | null>(null);

  const goToTabByDelta = useCallback((delta: number) => {
    const idx = tabDefs.findIndex((t) => t.id === drawerTab);
    if (idx === -1) return;
    const next = idx + delta;
    if (next < 0 || next >= tabDefs.length) return;
    setDrawerTab(tabDefs[next].id);
  }, [drawerTab, tabDefs]);

  const onSwipePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // Only enable swipe for touch / pen, not mouse.
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    // Skip if interaction starts on a horizontally scrollable element (chips, scrollers, etc.)
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, button, [role="slider"], [data-no-swipe]')) {
      return;
    }
    swipeStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      decided: null,
      pointerType: event.pointerType,
    };
  }, []);

  const onSwipePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const state = swipeStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (state.decided === null) {
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      if (ax < 8 && ay < 8) return;
      // Vertical first → release ownership so scroll can happen.
      state.decided = ay > ax ? 'v' : 'h';
    }
  }, []);

  const onSwipePointerEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const state = swipeStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    swipeStateRef.current = null;
    if (state.decided !== 'h') return;
    const dx = event.clientX - state.startX;
    const ax = Math.abs(dx);
    const ay = Math.abs(event.clientY - state.startY);
    // Require a clearly horizontal swipe of meaningful distance.
    if (ax < 60 || ax < ay * 1.5) return;
    goToTabByDelta(dx < 0 ? 1 : -1);
  }, [goToTabByDelta]);

  return (
    <div
      className="w-screen h-full flex flex-col bg-background text-foreground"
    >
      <main className="relative min-h-0 flex-1 overflow-visible px-0 pb-0 pt-0">
        <div className="flex h-full w-full min-h-0 flex-col overflow-visible bg-background">
          <div
            className="flex h-8 shrink-0 items-center justify-between gap-1 bg-background px-1 sm:h-9 sm:px-1.5"
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
              className="scrollbar-thin flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overflow-y-hidden whitespace-nowrap"
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
                      className="h-7 shrink-0 rounded-full bg-surface-elevated px-1.5 text-[11px] leading-none text-foreground outline-none ring-1 ring-primary/50 sm:h-8 sm:px-2 min-w-[4.5rem]"
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
                    onClick={() => handleTabPress(session.id)}
                    className={`group relative inline-flex h-7 shrink-0 items-center overflow-hidden rounded-full px-1 text-[11px] leading-none transition max-w-[6.25rem] sm:h-8 sm:max-w-[10rem] sm:px-2 ${
                      isActive
                        ? 'bg-surface-elevated text-foreground shadow-sm ring-1 ring-primary/25'
                        : 'text-muted-foreground hover:bg-surface-elevated/50 hover:text-foreground'
                    }`}
                    title={tooltip}
                  >
                    <span className="inline-flex min-w-0 items-center gap-1">
                      <span className="inline-flex shrink-0 items-center">
                        {renderTabIcon(session.mode, ts)}
                      </span>
                      {tabDirLabel ? (
                        <span className="flex min-w-0 flex-col justify-center leading-[0.72rem] sm:leading-[0.78rem]">
                          <span className={`truncate text-[10.5px] ${ts?.inCopyMode ? 'text-yellow-400' : ''}`}>{displayName}</span>
                          <span className="truncate text-[8.5px] text-muted-foreground/80 sm:text-[9px]">
                            {tabDirLabel}
                          </span>
                        </span>
                      ) : (
                        <span className={`truncate text-[10.5px] ${ts?.inCopyMode ? 'text-yellow-400' : ''}`}>{displayName}</span>
                      )}
                    </span>
                  </button>
                    </div>
                    )}
                  </Draggable>
                  </React.Fragment>
                );
              })}
              <div className="hidden items-center gap-1.5 pl-2 lg:flex">
                {activeSessionModeLabel && (
                  <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    {activeSessionModeLabel}
                  </span>
                )}
                <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  {fontSize}px
                </span>
              </div>
              {provided.placeholder}
            </div>
              )}
            </Droppable>
            </DragDropContext>
            <div className="flex shrink-0 items-center gap-2">
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
            {/* Left Sidebar — push mode on desktop */}
            <div className="hidden h-full lg:block">
              <LeftSidebar
                isOpen={sidebarLeftOpen}
                drawerWidthPx={drawerWidthPx}
                onClose={useSidebarStore.getState().closeLeft}
                onOpen={useSidebarStore.getState().openLeft}
                sessions={sessions}
                activeSessionId={activeSessionId}
                sessionStates={terminalSessions}
                onNewSession={() => dispatchNewSession()}
                onOpenDrawer={() => { setDrawerTab('sessions'); setIsDrawerOpen(true); }}
                push
              />
            </div>

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

            {/* Right Sidebar — push mode on desktop */}
            <div className="hidden h-full lg:block">
              <RightSidebar
                isOpen={sidebarRightOpen}
                drawerWidthPx={drawerWidthPx}
                onClose={useSidebarStore.getState().closeRight}
                onOpen={useSidebarStore.getState().openRight}
                push
              />
            </div>
          </div>
        </div>
      </main>

      {/* Drawer with tabs */}
      {isDrawerOpen && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 bg-[rgba(0,0,0,0.5)] backdrop-blur-sm animate-fade-in cursor-default"
            onClick={() => setIsDrawerOpen(false)}
          />
          <div
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[30rem] flex-col border-l border-border/15 bg-surface animate-fade-in"
            style={{ paddingTop: safeTopInset, paddingBottom: safeBottomInset }}
          >
            {/* Header */}
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/15 px-4 py-3 sm:px-6">
              <div className="min-w-0">
                <div className="ui-kicker">Workspace</div>
                <h2 className="section-title mt-0.5">
                  {drawerTab === 'sessions' && 'Sessions'}
                  {drawerTab === 'new' && 'New session'}
                  {drawerTab === 'tmux' && 'Tmux server'}
                  {drawerTab === 'settings' && 'Settings'}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setIsDrawerOpen(false)}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted-foreground transition hover:bg-destructive/20 hover:text-destructive"
                aria-label="Close"
              >
                <RiCloseLine size={18} />
              </button>
            </div>

            {/* Tab bar */}
            <div className="shrink-0 border-b border-border/15 px-2 py-2 sm:px-4">
              <div className="grid grid-cols-4 gap-1">
                {tabDefs.map((tab) => {
                  const isActive = drawerTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setDrawerTab(tab.id)}
                      className={`group flex flex-col items-center justify-center gap-1 rounded-2xl px-2 py-2 text-[11px] font-medium transition ${
                        isActive
                          ? 'bg-surface-elevated text-foreground'
                          : 'text-muted-foreground hover:bg-surface-2'
                      }`}
                    >
                      <span className={`relative flex h-6 w-6 items-center justify-center rounded-full ${
                        isActive ? 'bg-primary/20 text-primary' : 'bg-surface-2 text-muted-foreground group-hover:bg-surface-elevated'
                      }`}>
                        {tab.icon}
                        {typeof tab.badge === 'number' && tab.badge > 0 && (
                          <span className="absolute -top-1 -right-1 inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-accent px-1 text-[9px] text-accent-foreground">
                            {tab.badge}
                          </span>
                        )}
                      </span>
                      <span>{tab.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Tab content */}
            <div
              className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6"
              onPointerDown={onSwipePointerDown}
              onPointerMove={onSwipePointerMove}
              onPointerUp={onSwipePointerEnd}
              onPointerCancel={onSwipePointerEnd}
              style={{ touchAction: 'pan-y' }}
            >
              <div key={drawerTab} className="animate-fade-in">
              {drawerTab === 'sessions' && (
                <div className="space-y-3">
                  {sessions.length === 0 ? (
                    <div className="rounded-2xl bg-surface-2/60 px-4 py-8 text-center">
                      <RiTerminalBoxLine size={28} className="mx-auto mb-2 text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">No open sessions yet.</p>
                      <button
                        type="button"
                        onClick={() => setDrawerTab('new')}
                        className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-4 py-2 text-sm font-medium text-primary"
                      >
                        <RiAddLine size={14} />
                        Create one
                      </button>
                    </div>
                  ) : (
                    <>
                      <DragDropContext onDragEnd={handleDragEnd}>
                        <Droppable droppableId="sessions">
                          {(provided) => (
                          <div
                            ref={provided.innerRef}
                            {...provided.droppableProps}
                            className="space-y-2"
                          >
                            {sessions.map((session, index) => {
                          const ts = terminalSessions.get(session.id);
                          const { primary: display } = getTabDisplayLines(
                            session,
                            ts?.activeProgram ?? null,
                            ts?.cwd ?? null,
                          );
                          const isActive = session.id === activeSessionId;
                          const isTmux = session.mode === 'tmux' && !!session.tmuxSessionName;
                          const confirmingDestroy = sessionConfirmDestroyId === session.id;
                          const destroying = sessionDestroyingId === session.id;
                          return (
                            <Draggable key={session.id} draggableId={`session-${session.id}`} index={index}>
                              {(provided, snapshot) => (
                            <div
                              ref={provided.innerRef}
                              {...provided.draggableProps}
                              className={`flex items-center ${snapshot.isDragging ? 'opacity-70' : ''}`}
                            >
                              <div
                                {...provided.dragHandleProps}
                                className="shrink-0 cursor-grab touch-none p-1 text-muted-foreground/40 active:cursor-grabbing"
                              >
                                <GripVertical size={16} />
                              </div>
                            <div
                              className={`w-full min-w-0 rounded-2xl text-sm transition ${
                                isActive
                                  ? 'bg-surface-elevated text-foreground ring-1 ring-primary/30'
                                  : 'bg-surface-2 text-foreground hover:bg-surface-elevated'
                              }`}
                            >
                              <div className="flex w-full items-center gap-2 px-3 py-3">
                                <button
                                  type="button"
                                  onClick={() => {
                                    window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: session.id }));
                                    setIsDrawerOpen(false);
                                  }}
                                  className="min-w-0 flex flex-1 items-center gap-3 text-left"
                                >
                                  <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                                    isActive ? 'bg-primary/20 text-primary' : 'bg-surface text-muted-foreground'
                                  }`}>
                                    {session.mode === 'tmux' ? <RiLayoutGridLine size={16} /> : <RiTerminalBoxLine size={16} />}
                                  </span>
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm text-foreground">{display}</span>
                                    <span className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                                      <span>{getSessionModeLabel(session.mode)}</span>
                                      {session.tmuxSessionName && <span>· {session.tmuxSessionName}</span>}
                                    </span>
                                  </span>
                                </button>
                                {isTmux ? (
                                  // tmux session: two distinct icon buttons —
                                  // disconnect (logout arrow) + destroy (trash, with confirm).
                                  <div className="shrink-0 inline-flex items-center gap-1">
                                    <button
                                      type="button"
                                      disabled={destroying}
                                      onClick={() => {
                                        window.dispatchEvent(new CustomEvent('close-terminal-session', { detail: session.id }));
                                      }}
                                      title="Disconnect (keep tmux session)"
                                      aria-label={`Disconnect ${display}`}
                                      className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground disabled:opacity-50"
                                    >
                                      <RiLogoutBoxRLine size={15} />
                                    </button>
                                    <button
                                      type="button"
                                      disabled={destroying}
                                      onClick={() => {
                                        setSessionDestroyError(null);
                                        setSessionConfirmDestroyId(confirmingDestroy ? null : session.id);
                                      }}
                                      title="Destroy tmux session (kill-session)"
                                      aria-label={`Destroy tmux session ${session.tmuxSessionName}`}
                                      className={`inline-flex h-9 w-9 items-center justify-center rounded-full transition disabled:opacity-50 ${
                                        confirmingDestroy
                                          ? 'bg-destructive/20 text-destructive'
                                          : 'bg-surface text-muted-foreground hover:bg-destructive/15 hover:text-destructive'
                                      }`}
                                    >
                                      <RiDeleteBinLine size={15} />
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      window.dispatchEvent(new CustomEvent('close-terminal-session', { detail: session.id }));
                                    }}
                                    className="shrink-0 rounded-full p-2 text-muted-foreground transition hover:bg-destructive/15 hover:text-destructive"
                                    aria-label={`Close ${display}`}
                                  >
                                    <RiCloseLine size={16} />
                                  </button>
                                )}
                              </div>

                              {isTmux && confirmingDestroy && (
                                <div className="mx-3 mb-3 space-y-2 rounded-xl bg-surface/80 p-3">
                                  <p className="text-[12px] leading-snug text-foreground">
                                    Close session and permanently destroy tmux session <span className="font-mono font-semibold">{session.tmuxSessionName}</span>?
                                  </p>
                                  <p className="text-[11px] text-muted-foreground">
                                    Runs <span className="font-mono">tmux kill-session</span>. All windows and panes inside will be terminated. Cannot be undone.
                                  </p>
                                  {sessionDestroyError && (
                                    <p className="text-[11px] text-destructive">{sessionDestroyError}</p>
                                  )}
                                  <div className="flex items-center gap-2 pt-1">
                                    <button
                                      type="button"
                                      disabled={destroying}
                                      onClick={() => void handleDestroyTmuxForSession(session)}
                                      className="flex-1 rounded-full bg-destructive/90 px-3 py-2 text-xs font-medium text-destructive-foreground transition hover:bg-destructive disabled:opacity-50"
                                    >
                                      {destroying ? 'Destroying…' : 'Destroy'}
                                    </button>
                                    <button
                                      type="button"
                                      disabled={destroying}
                                      onClick={() => {
                                        setSessionConfirmDestroyId(null);
                                        setSessionDestroyError(null);
                                      }}
                                      className="flex-1 rounded-full bg-surface-2 px-3 py-2 text-xs font-medium text-foreground transition hover:bg-surface-elevated disabled:opacity-50"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                            </div>
                              )}
                            </Draggable>
                          );
                        })}
                          {provided.placeholder}
                          </div>
                          )}
                        </Droppable>
                      </DragDropContext>

                      <button
                        type="button"
                        onClick={() => setDrawerTab('new')}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary/10 px-4 py-3 text-sm font-medium text-primary transition hover:bg-primary/20 active:scale-[0.98]"
                      >
                        <RiAddLine size={16} />
                        New session
                      </button>
                    </>
                  )}
                </div>
              )}

              {drawerTab === 'new' && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <span className="ui-kicker">Mode</span>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setNewSessionMode('shell')}
                        className={`rounded-2xl px-4 py-4 text-left transition ${
                          newSessionMode === 'shell'
                            ? 'bg-surface-elevated ring-1 ring-primary/30'
                            : 'bg-surface-2 hover:bg-surface-elevated'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
                            <RiTerminalLine size={14} /> Shell
                          </span>
                          {newSessionMode === 'shell' && <RiCheckLine size={16} className="text-primary" />}
                        </div>
                        <p className="mt-1.5 text-[11px] text-muted-foreground">
                          Persistent PTY. Best default.
                        </p>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          if (tmuxStatus.available) {
                            setNewSessionMode('tmux');
                          }
                        }}
                        disabled={!tmuxStatus.available}
                        className={`rounded-2xl px-4 py-4 text-left transition ${
                          newSessionMode === 'tmux'
                            ? 'bg-surface-elevated ring-1 ring-primary/30'
                            : 'bg-surface-2 hover:bg-surface-elevated'
                        } ${!tmuxStatus.available ? 'opacity-60 cursor-not-allowed' : ''}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
                            <RiLayoutGridLine size={14} /> Tmux
                          </span>
                          {newSessionMode === 'tmux' && <RiCheckLine size={16} className="text-primary" />}
                        </div>
                        <p className="mt-1.5 text-[11px] text-muted-foreground">
                          {tmuxStatus.available
                            ? 'Named, multi-pane, reattachable.'
                            : 'tmux not detected on server.'}
                        </p>
                      </button>
                    </div>
                  </div>

                  {newSessionMode === 'tmux' && (
                    <div className="space-y-2">
                      <span className="ui-kicker">Tmux name (optional)</span>
                      <input
                        type="text"
                        value={newSessionTmuxName}
                        onChange={(e) => setNewSessionTmuxName(e.target.value)}
                        onBlur={() => setNewSessionTmuxName(newSessionTmuxName.trim())}
                        placeholder="auto-generated when empty"
                        className="ui-input w-full"
                        autoCapitalize="off"
                        autoCorrect="off"
                        autoComplete="off"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Leave blank for an auto name. Reuse an existing name to attach to it.
                      </p>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      dispatchNewSession();
                      setIsDrawerOpen(false);
                    }}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-4 py-3.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 active:scale-[0.98]"
                  >
                    <RiAddLine size={16} />
                    Create {newSessionMode === 'tmux' ? 'tmux' : 'shell'} session
                  </button>

                  {newSessionMode === 'tmux' && tmuxStatus.available && (
                    <div className="rounded-2xl bg-surface-2/60 px-3 py-3">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="ui-kicker">Quick attach</span>
                        <button
                          type="button"
                          onClick={() => setDrawerTab('tmux')}
                          className="text-[11px] text-primary hover:underline"
                        >
                          See all →
                        </button>
                      </div>
                      {tmuxSessions.length === 0 ? (
                        <p className="text-[11px] text-muted-foreground">No tmux sessions on the server yet.</p>
                      ) : (
                        <div className="space-y-1.5">
                          {tmuxSessions.slice(0, 4).map((tmux) => {
                            const connected = connectedTmuxNames.has(tmux.name);
                            return (
                              <button
                                key={tmux.name}
                                type="button"
                                disabled={connected}
                                onClick={() => {
                                  dispatchNewSession({ mode: 'tmux', tmuxSessionName: tmux.name });
                                  setIsDrawerOpen(false);
                                }}
                                className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-left transition ${
                                  connected
                                    ? 'bg-surface text-muted-foreground opacity-70 cursor-not-allowed'
                                    : 'bg-surface text-foreground hover:bg-surface-elevated'
                                }`}
                              >
                                <RiLayoutGridLine size={14} className="shrink-0 text-muted-foreground" />
                                <span className="flex-1 truncate">{tmux.name}</span>
                                <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                                  {connected ? 'attached' : `${tmux.windows}w`}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {drawerTab === 'tmux' && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 rounded-2xl bg-surface-2/60 px-3 py-3">
                    <span className={`inline-flex h-2 w-2 rounded-full ${tmuxStatus.available ? 'bg-primary' : 'bg-destructive'}`} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-foreground">
                        {tmuxStatus.available ? 'tmux available' : 'tmux unavailable'}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {tmuxStatus.available
                          ? (tmuxStatus.version || 'Detected on server')
                          : (tmuxStatus.reason || 'Install tmux on the server to enable.')}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void refreshTmuxSessions()}
                      disabled={tmuxRefreshing}
                      className="shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface text-muted-foreground transition hover:bg-surface-elevated disabled:opacity-50"
                      aria-label="Refresh tmux sessions"
                    >
                      <RiRefreshLine size={14} className={tmuxRefreshing ? 'animate-spin' : ''} />
                    </button>
                  </div>

                  {tmuxStatus.available && (
                    <>
                      {tmuxSessions.length === 0 ? (
                        <div className="rounded-2xl bg-surface-2/60 px-4 py-8 text-center">
                          <RiLayoutGridLine size={28} className="mx-auto mb-2 text-muted-foreground" />
                          <p className="text-sm text-muted-foreground">No tmux sessions on the server.</p>
                          <button
                            type="button"
                            onClick={() => {
                              setNewSessionMode('tmux');
                              setDrawerTab('new');
                            }}
                            className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-4 py-2 text-sm font-medium text-primary"
                          >
                            <RiAddLine size={14} />
                            Create one
                          </button>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {tmuxSessions.map((tmux) => {
                            const connected = connectedTmuxNames.has(tmux.name);
                            const confirming = tmuxConfirmKillName === tmux.name;
                            const killing = tmuxKillingName === tmux.name;
                            return (
                              <div
                                key={tmux.name}
                                className={`rounded-2xl px-3 py-3 transition ${
                                  confirming
                                    ? 'bg-destructive/10 ring-1 ring-destructive/40'
                                    : connected
                                      ? 'bg-surface-2/40'
                                      : 'bg-surface-2 hover:bg-surface-elevated'
                                }`}
                              >
                                <div className="flex items-center gap-3">
                                  <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                                    connected ? 'bg-primary/20 text-primary' : 'bg-surface text-muted-foreground'
                                  }`}>
                                    <RiLayoutGridLine size={16} />
                                  </span>
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm font-medium text-foreground">{tmux.name}</div>
                                    <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                                      {tmux.windows} window{tmux.windows === 1 ? '' : 's'}
                                      {connected && ' · attached'}
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    disabled={connected || confirming || killing}
                                    onClick={() => {
                                      dispatchNewSession({ mode: 'tmux', tmuxSessionName: tmux.name });
                                    }}
                                    className={`shrink-0 rounded-full px-4 py-2 text-xs font-medium transition ${
                                      connected || confirming || killing
                                        ? 'bg-surface text-muted-foreground cursor-not-allowed'
                                        : 'bg-primary/15 text-primary hover:bg-primary/25'
                                    }`}
                                  >
                                    {connected ? 'Attached' : 'Attach'}
                                  </button>
                                  <button
                                    type="button"
                                    disabled={killing}
                                    onClick={() => {
                                      setTmuxKillError(null);
                                      setTmuxConfirmKillName(confirming ? null : tmux.name);
                                    }}
                                    className={`shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-full transition ${
                                      confirming
                                        ? 'bg-destructive/20 text-destructive'
                                        : 'bg-surface text-muted-foreground hover:bg-destructive/15 hover:text-destructive'
                                    } disabled:opacity-50`}
                                    aria-label={`Kill tmux session ${tmux.name}`}
                                  >
                                    <RiDeleteBinLine size={14} />
                                  </button>
                                </div>

                                {confirming && (
                                  <div className="mt-3 space-y-2 rounded-xl bg-surface/80 p-3">
                                    <p className="text-[12px] leading-snug text-foreground">
                                      Permanently destroy tmux session <span className="font-mono font-semibold">{tmux.name}</span>?
                                    </p>
                                    <p className="text-[11px] text-muted-foreground">
                                      Runs <span className="font-mono">tmux kill-session</span>. All windows and panes inside will be terminated. Cannot be undone.
                                    </p>
                                    {tmuxKillError && (
                                      <p className="text-[11px] text-destructive">{tmuxKillError}</p>
                                    )}
                                    <div className="flex items-center gap-2 pt-1">
                                      <button
                                        type="button"
                                        disabled={killing}
                                        onClick={() => void handleKillTmuxSession(tmux.name)}
                                        className="flex-1 rounded-full bg-destructive/90 px-3 py-2 text-xs font-medium text-destructive-foreground transition hover:bg-destructive disabled:opacity-50"
                                      >
                                        {killing ? 'Destroying…' : 'Destroy'}
                                      </button>
                                      <button
                                        type="button"
                                        disabled={killing}
                                        onClick={() => {
                                          setTmuxConfirmKillName(null);
                                          setTmuxKillError(null);
                                        }}
                                        className="flex-1 rounded-full bg-surface-2 px-3 py-2 text-xs font-medium text-foreground transition hover:bg-surface-elevated disabled:opacity-50"
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      <p className="text-center text-[11px] text-muted-foreground">
                        Attach opens a new tab without closing this panel.
                      </p>
                    </>
                  )}
                </div>
              )}

              {drawerTab === 'settings' && (
                <div className="space-y-5">
                  {/* Font Size */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="ui-label">Font size</span>
                      <span className="text-xs text-muted-foreground tabular-nums">{fontSize}px</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setFontSize(Math.max(8, fontSize - 1))}
                        className="h-10 w-10 shrink-0 rounded-full bg-surface-2 text-muted-foreground hover:bg-surface-elevated"
                      >
                        −
                      </button>
                      <input
                        type="range"
                        min="8"
                        max="32"
                        value={fontSize}
                        onChange={(e) => setFontSize(parseInt(e.target.value, 10))}
                        className="flex-1"
                        aria-label="Font size"
                      />
                      <button
                        type="button"
                        onClick={() => setFontSize(Math.min(32, fontSize + 1))}
                        className="h-10 w-10 shrink-0 rounded-full bg-surface-2 text-muted-foreground hover:bg-surface-elevated"
                      >
                        +
                      </button>
                    </div>
                  </div>

                  {/* Renderer */}
                  <div className="space-y-2">
                    <span className="ui-label">Renderer</span>
                    <div className="grid grid-cols-3 gap-1.5">
                      {(['auto', 'webgl', 'canvas'] as TerminalRendererMode[]).map((mode) => {
                        const selected = rendererMode === mode;
                        return (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => setRendererMode(mode)}
                            className={`rounded-full px-3 py-2 text-xs font-medium transition ${
                              selected
                                ? 'bg-primary/20 text-primary ring-1 ring-primary/30'
                                : 'bg-surface-2 text-muted-foreground hover:bg-surface-elevated'
                            }`}
                          >
                            {mode === 'auto' ? 'Auto' : mode === 'webgl' ? 'WebGL' : 'Canvas'}
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      WebGL is sharper. Canvas is more compatible.
                    </p>
                  </div>

                  {/* Toolbar Presets */}
                  <button
                    type="button"
                    onClick={() => setIsToolbarPresetsOpen(true)}
                    className="flex w-full items-center justify-between rounded-2xl bg-surface-2 px-4 py-3.5 text-left text-sm transition hover:bg-surface-elevated"
                  >
                    <span className="flex items-center gap-3">
                      <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface text-muted-foreground">
                        <RiKeyboardLine size={16} />
                      </span>
                      <span>
                        <span className="block font-medium text-foreground">Mobile keyboard toolbar</span>
                        <span className="block text-[11px] text-muted-foreground">
                          {toolbarPresets.length} preset{toolbarPresets.length === 1 ? '' : 's'}
                        </span>
                      </span>
                    </span>
                    <span className="text-muted-foreground">›</span>
                  </button>

                  {/* Agent Detection Rules */}
                  <button
                    type="button"
                    onClick={() => setIsAgentRulesOpen(true)}
                    className="flex w-full items-center justify-between rounded-2xl bg-surface-2 px-4 py-3.5 text-left text-sm transition hover:bg-surface-elevated"
                  >
                    <span className="flex items-center gap-3">
                      <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface text-muted-foreground">
                        <RiBotLine size={16} />
                      </span>
                      <span>
                        <span className="block font-medium text-foreground">AI agent detection</span>
                        <span className="block text-[11px] text-muted-foreground">
                          {agentRulesLoaded ? `${agentRules.length} program${agentRules.length === 1 ? '' : 's'}` : 'Loading…'}
                        </span>
                      </span>
                    </span>
                    <span className="text-muted-foreground">›</span>
                  </button>

                  {/* Debug toggle */}
                  <div className="flex items-center justify-between rounded-2xl bg-surface-2 px-4 py-3">
                    <span className="ui-label">Debug overlay</span>
                    <button
                      type="button"
                      onClick={() => setShowDebug(!showDebug)}
                      className={`inline-flex h-6 w-10 items-center rounded-full transition ${
                        showDebug ? 'bg-primary/70' : 'bg-surface-elevated'
                      }`}
                      aria-label="Toggle debug overlay"
                    >
                      <span
                        className={`mx-0.5 inline-block h-5 w-5 rounded-full bg-foreground/90 transition ${
                          showDebug ? 'translate-x-4' : ''
                        }`}
                      />
                    </button>
                  </div>

                  {/* Prevent sleep toggle */}
                  <div>
                    <div className="flex items-center justify-between rounded-2xl bg-surface-2 px-4 py-3">
                      <span className="flex items-center gap-2">
                        <span className="ui-label">Prevent sleep</span>
                        {!networkAvailable && preventSleep && (
                          <span className="text-[11px] text-yellow-500">No network</span>
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={async () => {
                          const newValue = !preventSleep;
                          setPreventSleep(newValue);
                          try {
                            const result = await updateSettings({ preventSleep: newValue });
                            setPreventSleep(result.preventSleep);
                            setNetworkAvailable(result.networkAvailable);
                            writeCache(SETTINGS_CACHE_KEY, {
                              preventSleep: result.preventSleep,
                              networkAvailable: result.networkAvailable,
                            });
                          } catch {
                            setPreventSleep(!newValue);
                          }
                        }}
                        className={`inline-flex h-6 w-10 items-center rounded-full transition ${
                          preventSleep ? 'bg-green-500' : 'bg-surface-elevated'
                        }`}
                        aria-label="Toggle prevent sleep"
                      >
                        <span
                          className={`mx-0.5 inline-block h-5 w-5 rounded-full transition ${
                            preventSleep ? 'translate-x-4 bg-white' : 'bg-foreground/90'
                          }`}
                        />
                      </button>
                    </div>
                    <p className="mt-1 px-1 text-[11px] text-muted-foreground">
                      Keeps Mac awake while network is available. Turns off if WiFi is lost.
                    </p>
                  </div>

                  {/* Sign out — only visible when password protection is enabled. */}
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await logout();
                      } catch {
                        // Even if the request fails, the global 401 interceptor or
                        // the next status check will eventually flip us back to login.
                      }
                      // Force the AuthGate to re-render the LoginScreen immediately.
                      window.dispatchEvent(new CustomEvent('auth:unauthorized'));
                    }}
                    className="flex w-full items-center justify-between rounded-2xl bg-surface-2 px-4 py-3.5 text-left text-sm transition hover:bg-surface-elevated"
                  >
                    <span className="flex items-center gap-3">
                      <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface text-muted-foreground">
                        <RiLogoutBoxRLine size={16} />
                      </span>
                      <span>
                        <span className="block font-medium text-foreground">Sign out</span>
                        <span className="block text-[11px] text-muted-foreground">
                          End this session and return to the password screen.
                        </span>
                      </span>
                    </span>
                    <span className="text-muted-foreground">›</span>
                  </button>
                </div>
              )}
              </div>
            </div>
          </div>
        </>
      )}

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
            </div>
          </div>
        </>
      )}

      {/* Left Sidebar — overlay mode on mobile */}
      <div className="lg:hidden">
        <LeftSidebar
          isOpen={sidebarLeftOpen}
          drawerWidthPx={drawerWidthPx}
          onClose={useSidebarStore.getState().closeLeft}
          onOpen={useSidebarStore.getState().openLeft}
          sessions={sessions}
          activeSessionId={activeSessionId}
          sessionStates={terminalSessions}
          onNewSession={() => dispatchNewSession()}
          onOpenDrawer={() => { setDrawerTab('sessions'); setIsDrawerOpen(true); }}
        />
      </div>

      {/* Right Sidebar — overlay mode on mobile */}
      <div className="lg:hidden">
        <RightSidebar
          isOpen={sidebarRightOpen}
          drawerWidthPx={drawerWidthPx}
          onClose={useSidebarStore.getState().closeRight}
          onOpen={useSidebarStore.getState().openRight}
        />
      </div>

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
