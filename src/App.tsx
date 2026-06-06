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
} from 'lucide-react';
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd';
import { useFontSize } from './lib/hooks/useFontSize';
import { useTerminalRenderer } from './lib/hooks/useTerminalRenderer';
import { useViewportHeight } from './lib/hooks/useViewportHeight';
import { useNewSessionDefaults } from './lib/hooks/useNewSessionDefaults';
import type { TerminalSessionState, TmuxSessionSummary, TmuxStatus } from './lib/terminal/types';
import type { TerminalRendererMode } from './lib/terminal/renderer';
import { getTmuxStatus, killTmuxSession, listTmuxSessions, getToolbarPresetsDoc, replaceToolbarPresetsDoc, logout, getSettings, updateSettings, getAgentRules, replaceAgentRules, resetAgentRules, getProgramRules, replaceProgramRules, resetProgramRules } from './lib/terminal/api';
import type { AgentProgramConfig, ProgramLabelRule } from './lib/terminal/api';
import { readCache, writeCache, shallowJsonEqual } from './lib/utils/localStorageCache';
import { useTerminalStore } from './lib/stores/useTerminalStore';
import { useSidebarStore } from './lib/stores/useSidebarStore';
import { useI18n } from './lib/i18n';
import { LeftSidebar } from './lib/components/sidebar/LeftSidebar';
import { RightSidebar } from './lib/components/sidebar/RightSidebar';
import { AgentTabIcon, AgentCountBadge } from './lib/components/AgentIndicators';
import { ToolbarPresetSettings } from './lib/components/settings/ToolbarPresetSettings';
import { AgentRulesSettings } from './lib/components/settings/AgentRulesSettings';
import { BUILTIN_TOOLBAR_PRESETS_VERSION, createDefaultToolbarPresets, getBuiltinToolbarPresetIds, sanitizeToolbarPresets, type ToolbarPresetDefinition } from './lib/components/terminal/mobileKeyboardPresets';

// Cache keys for app-level lazy data fetched from the server. 缓存只是"上次看到"的
// 快照，每次启动还是会发 HTTP 校准；命中时让 UI 不再闪烁默认值 → 自定义值。
const AGENT_RULES_CACHE_KEY = 'termdock-agent-rules-cache';
const PROGRAM_RULES_CACHE_KEY = 'termdock-program-rules-cache';
const TOOLBAR_PRESETS_CACHE_KEY = 'termdock-toolbar-presets-cache';
const SETTINGS_CACHE_KEY = 'termdock-settings-cache';

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
}
function isSettingsCacheDoc(v: unknown): v is SettingsCacheDoc {
  return typeof v === 'object' && v !== null &&
    typeof (v as { preventSleep?: unknown }).preventSleep === 'boolean' &&
    typeof (v as { networkAvailable?: unknown }).networkAvailable === 'boolean';
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

function App() {
  const { t, locale, setLocale } = useI18n();
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
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [tabMenuSessionId, setTabMenuSessionId] = useState<string | null>(null);
  const [tabCopiedHint, setTabCopiedHint] = useState<string | null>(null);
  const [sidebarCloseChoiceSessionId, setSidebarCloseChoiceSessionId] = useState<string | null>(null);
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

  const handleTabClick = useCallback((sessionId: string) => {
    window.dispatchEvent(new CustomEvent('switch-terminal-session', { detail: sessionId }));
  }, []);

  const handleTabPointerDown = useCallback((sessionId: string) => {
    tabLongPressedRef.current = false;
    if (tabLongPressTimerRef.current !== null) {
      window.clearTimeout(tabLongPressTimerRef.current);
    }
    tabLongPressTimerRef.current = window.setTimeout(() => {
      tabLongPressedRef.current = true;
      tabLongPressTimerRef.current = null;
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
    handleTabClick(sessionId);
  }, [handleTabClick]);

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
              aria-label={t('tab.sessionsTitle')}
              title={t('tab.sessionsTitle')}
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
                    className={`group relative inline-flex h-8 shrink-0 items-center overflow-hidden rounded-md pl-1 pr-1.5 text-[12px] leading-none transition max-w-[6.25rem] sm:h-8 sm:max-w-[12rem] sm:pl-1.5 sm:pr-2 ${
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
                        <span className="flex min-w-0 flex-col justify-center leading-[0.82rem] sm:leading-[0.85rem]">
                          <span className={`truncate text-[11px] sm:text-[12px] ${ts?.inCopyMode ? 'text-yellow-400' : ''}`}>{displayName}</span>
                          <span className="truncate text-[9px] text-muted-foreground/80 sm:text-[9.5px]">
                            {tabDirLabel}
                          </span>
                        </span>
                      ) : (
                        <span className={`truncate text-[11px] sm:text-[12px] ${ts?.inCopyMode ? 'text-yellow-400' : ''}`}>{displayName}</span>
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
                onClick={() => useSidebarStore.getState().toggleRight()}
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
                <h2 className="text-[14px] font-semibold text-foreground">{t('settings.title')}</h2>
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
                  <span className="text-[12px] font-medium text-foreground/90 w-14 shrink-0">{t('settings.font')}</span>
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
                    aria-label={t('settings.font')}
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
                  <span className="text-[12px] font-medium text-foreground/90 w-14 shrink-0">{t('settings.render')}</span>
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
                          {mode === 'auto' ? t('settings.auto') : mode === 'webgl' ? t('settings.webgl') : t('settings.canvas')}
                        </button>
                      );
                    })}
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
                          onClick={() => setNewSessionMode(mode)}
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
                        writeCache(SETTINGS_CACHE_KEY, {
                          preventSleep: result.preventSleep,
                          networkAvailable: result.networkAvailable,
                        });
                      } catch {
                        setPreventSleep(!newValue);
                      }
                    }}
                    className={`flex items-center justify-between rounded-xl px-3 py-2 text-[12px] transition ${
                      preventSleep ? 'bg-green-500/15 text-green-400' : 'bg-surface-2 text-foreground hover:bg-surface-elevated'
                    }`}
                    title={!networkAvailable && preventSleep ? t('settings.noSleepUnavailable') : undefined}
                  >
                    <span className="font-medium truncate">{t('settings.noSleep')}</span>
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
                  {t('settings.shell')}
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
                  {t('settings.tmux')}
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
                                  {t('settings.windows', { n: tmux.windows })}{connected && ` · ${t('settings.attached')}`}
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
                                    {connected ? t('settings.attached') : t('settings.attach')}
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
        </>
      )}

      {/* Sidebar close action chooser for tmux sessions */}
      {sidebarCloseChoiceSession && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-[55] bg-[rgba(0,0,0,0.4)] backdrop-blur-sm cursor-default animate-fade-in"
            onClick={() => {
              setSidebarCloseChoiceSessionId(null);
              setTmuxKillError(null);
            }}
            aria-label="Close close-session chooser"
          />
          <div
            className="fixed inset-x-3 bottom-6 z-[60] mx-auto max-w-sm rounded-2xl bg-surface-elevated border border-border/15 shadow-[0_18px_48px_rgba(0,0,0,0.18)] animate-fade-in sm:bottom-auto sm:top-[15%]"
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
                    setTabMenuSessionId(null);
                    setEditingSessionId(menuSession.id);
                  }}
                  className="flex items-center gap-3 px-4 py-3 text-left text-[13px] text-foreground transition hover:bg-surface-2"
                >
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-primary">
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
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{t('tab.copyCwd')}</span>
                    <span className="block text-[11px] text-muted-foreground">{t('tab.copyCwdHint')}</span>
                  </span>
                  {tabCopiedHint && tabCopiedHint === ts?.cwd && (
                    <span className="ml-auto text-[11px] text-primary">{t('tab.copied')}</span>
                  )}
                </button>
                <div className="my-1 border-t border-border/15" />
                <button
                  type="button"
                  onClick={() => {
                    setTabMenuSessionId(null);
                    dispatchCloseSession({ sessionId: menuSession.id, source: 'tab-menu', closeMode: 'auto' });
                  }}
                  className="flex items-center gap-3 px-4 py-3 text-left text-[13px] text-destructive transition hover:bg-destructive/10"
                >
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-destructive/15 text-destructive">
                    <RiCloseLine size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{t('tab.close')}</span>
                    <span className="block text-[11px] text-muted-foreground">{t('tab.closeHint')}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="flex items-center justify-center px-4 py-2 text-[11px] text-muted-foreground/80 transition hover:text-foreground"
                  onClick={() => {
                    setTabMenuSessionId(null);
                  }}
                >
                  {t('tab.longPressTip')}
                </button>
              </div>
              <div className="border-t border-border/15 px-3 py-2">
                <button
                  type="button"
                  onClick={() => setTabMenuSessionId(null)}
                  className="w-full rounded-full bg-surface-2 px-3 py-2 text-[12px] font-medium text-muted-foreground transition hover:bg-surface hover:text-foreground"
                >
                  {t('common.cancel')}
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
                <div className="ui-kicker">Program label resolution</div>
                <h3 className="mt-1 text-sm font-semibold text-foreground">Raw command mapping</h3>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Rules below map the raw command line to the tab display label. User rules run before built-ins.
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

                <div className="mt-3">
                  <div className="mb-1 text-[11px] font-medium text-foreground">Custom rules</div>
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
                          Delete
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
                      Add rule
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
                      Reset defaults
                    </button>
                    <span className="text-[11px] text-muted-foreground">{programRulesSaving ? 'Saving…' : (programRulesLoaded ? `${programRules.length} rules` : '…')}</span>
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
        onClose={useSidebarStore.getState().closeLeft}
        onOpen={useSidebarStore.getState().openLeft}
        sessions={sessions}
        activeSessionId={activeSessionId}
        sessionStates={terminalSessions}
        onNewSession={(opts) => dispatchNewSession(opts)}
        onCloseSession={handleSidebarCloseSession}
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
