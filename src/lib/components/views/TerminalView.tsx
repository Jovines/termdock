import React from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useTerminalStore } from '../../stores/useTerminalStore';
import type { TerminalMode, TerminalStreamEvent, TmuxActionPayload, TmuxLayout } from '../../terminal';
import { TerminalViewport, type TerminalController } from '../terminal/TerminalViewport';
import { getTerminalTheme, type TermdockColorTheme } from '../../terminal';
import { createTermdockAPI } from '../../terminal/factory';
import { probeTerminalConnection, sendTerminalFlowControlState, sendTerminalFocusState, updateSessionInventoryEntry } from '../../terminal/api';
import { computeTerminalLogicalFocus } from '../../terminal/focus';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { MobileKeyboard, getSequenceForKey } from '../terminal/MobileKeyboard';
import { buildDesktopToolbarPresetOptions, buildToolbarPresetOptions, decodeToolbarSequence, detectToolbarPreset, getToolbarActionLabel, getToolbarPreset, normalizeActiveProgram, sanitizeToolbarPresets, splitToolbarSequenceSegments, TOOLBAR_SEGMENT_DELAY_MS, type ToolbarPresetDefinition, type ToolbarPresetMode } from '../terminal/mobileKeyboardPresets';
import { DebugPanel } from '../terminal/DebugPanel';
import { ConnectionStatus } from '../terminal/ConnectionStatus';
import { createDebugLogger } from '../../utils/debug';
import { getDefaultTerminalSettings, type TerminalSettings } from '../../terminal/settings';
import { useViewportKeyboardState } from '../../hooks/useViewportKeyboardState';

const MODIFIER_DOUBLE_TAP_WINDOW_MS = 320;
const MOBILE_KEYBOARD_EXPANDED_STORAGE_KEY = 'termdock:mobile-keyboard-expanded';
const MOBILE_KEYBOARD_PRESET_MODE_STORAGE_KEY = 'termdock:mobile-keyboard-preset-mode';

type Modifier = 'ctrl' | 'alt';

const STREAM_OPTIONS = {
  retry: {
    // PWA 退后台时 JS timer 可能被系统冻结/合并，短重试窗口会在后台被耗尽，
    // 回前台时已经 cleanup，visibility probe 也找不到连接可修复。
    // 拉长到 15 分钟以上，覆盖锁屏/切后台/弱网恢复；回前台还会立刻 probe。
    maxRetries: 60,
    initialDelayMs: 1000,
    maxDelayMs: 20000,
  },
  connectionTimeoutMs: 15_000,
};

interface TerminalViewProps {
  sessionId?: string;
  mode?: TerminalMode;
  tmuxSessionName?: string | null;
  terminalSettings?: TerminalSettings;
  colorTheme?: TermdockColorTheme;
  toolbarPresets?: ToolbarPresetDefinition[];
  isActive?: boolean;
  focusRequestToken?: number;
  resumeRequestToken?: number;
  onKeyboardVisibilityChange?: (sessionId: string, isOpen: boolean) => void;
  showDebug?: boolean;
  onStatusChange?: (status: { isConnecting: boolean; isRestarting: boolean; hasError: boolean; sessionId: string | null }) => void;
}

export const TerminalView: React.FC<TerminalViewProps> = ({
  sessionId: initialSessionId,
  mode: expectedMode,
  tmuxSessionName: expectedTmuxSessionName = null,
  terminalSettings = getDefaultTerminalSettings(),
  colorTheme = 'dark',
  toolbarPresets: configuredToolbarPresets = [],
  isActive = true,
  focusRequestToken = 0,
  resumeRequestToken = 0,
  onKeyboardVisibilityChange,
  showDebug: externalShowDebug,
  onStatusChange,
}) => {
  // Use external fontSize from props, with local override support for pinch-to-zoom
  const [fontSize, setFontSize] = React.useState(terminalSettings.fontSize);
  const terminal = React.useMemo(() => createTermdockAPI(), []);
  const debugSession = React.useMemo(() => createDebugLogger('session'), []);
  const debugKeyboard = React.useMemo(() => createDebugLogger('keyboard'), []);

  // Sync with external fontSize changes while allowing local pinch-to-zoom overrides
  React.useEffect(() => {
    setFontSize(terminalSettings.fontSize);
  }, [terminalSettings.fontSize]);

  const effectiveTerminalSettings = React.useMemo(() => ({
    ...terminalSettings,
    fontSize,
  }), [terminalSettings, fontSize]);

  const [sessionId] = React.useState(initialSessionId || uuidv4());
  const [isMobile, setIsMobile] = React.useState(false);
  const [isIOS, setIsIOS] = React.useState(false);
  const [isInputFocused, setIsInputFocused] = React.useState(false);
  const [isViewportFocused, setIsViewportFocused] = React.useState(false);
  const [isDocumentVisible, setIsDocumentVisible] = React.useState(() => typeof document === 'undefined' ? true : !document.hidden);
  const [isWindowFocused, setIsWindowFocused] = React.useState(() => typeof document === 'undefined' ? true : document.hasFocus());
  const [isStreamReady, setIsStreamReady] = React.useState(false);
  const {
    isOpen: isViewportKeyboardOpen,
    keyboardHeight: viewportKeyboardHeight,
  } = useViewportKeyboardState({
    enabled: isMobile && isActive,
  });
  const [activeModifier, setActiveModifier] = React.useState<Modifier | null>(null);
  const [lockedModifier, setLockedModifier] = React.useState<Modifier | null>(null);
  const [showExtendedKeyboard, setShowExtendedKeyboard] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return false;
    }

    return window.localStorage.getItem(MOBILE_KEYBOARD_EXPANDED_STORAGE_KEY) === 'true';
  });
  const [toolbarPresetMode, setToolbarPresetMode] = React.useState<ToolbarPresetMode>(() => {
    if (typeof window === 'undefined') {
      return 'auto';
    }

    const stored = window.localStorage.getItem(MOBILE_KEYBOARD_PRESET_MODE_STORAGE_KEY);
    return stored && stored.length > 0 ? stored : 'auto';
  });

  const terminalStore = useTerminalStore();
  const terminalSessions = terminalStore.sessions;
  const setTerminalSession = terminalStore.setTerminalSession;
  const setConnecting = terminalStore.setConnecting;
  const appendToBuffer = terminalStore.appendToBuffer;
  const clearTerminalSession = terminalStore.clearTerminalSession;
  const removeTerminalSession = terminalStore.removeTerminalSession;
  const clearBuffer = terminalStore.clearBuffer;
  const setSessionActiveProgram = terminalStore.setSessionActiveProgram;
  const setSessionCwd = terminalStore.setSessionCwd;
  const setSessionCopyMode = terminalStore.setSessionCopyMode;
  const setSessionAgentStatus = terminalStore.setSessionAgentStatus;
  const setSessionShellTitle = terminalStore.setSessionShellTitle;
  const setSessionPromptState = terminalStore.setSessionPromptState;

  const terminalState = React.useMemo(() => {
    if (!sessionId) return undefined;
    return terminalSessions.get(sessionId);
  }, [terminalSessions, sessionId]);

  const fallbackTmuxSessionName = React.useMemo(() => `wt-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12)}`, [sessionId]);

  const terminalSessionRef = terminalState?.terminalSessionId ?? null;
  const sessionMode = terminalState?.mode ?? 'shell';
  const preferredTmuxSessionName = terminalState?.tmuxSessionName || fallbackTmuxSessionName;
  const detectedActiveProgram = terminalState?.activeProgram ?? null;
  const toolbarPresets = React.useMemo(() => sanitizeToolbarPresets(configuredToolbarPresets), [configuredToolbarPresets]);
  const isTmuxMode = sessionMode === 'tmux';
  const bufferChunks = terminalState?.bufferChunks ?? [];
  const isConnecting = terminalState?.isConnecting ?? false;
  const terminalSessionId = terminalSessionRef;
  const desiredSessionMode: TerminalMode = expectedMode ?? terminalState?.mode ?? 'shell';
  const desiredTmuxSessionName = desiredSessionMode === 'tmux'
    ? (expectedTmuxSessionName ?? terminalState?.tmuxSessionName ?? null)
    : null;

  const [connectionError, setConnectionError] = React.useState<string | null>(null);
  const [isFatalError, setIsFatalError] = React.useState(false);
  const [isRestarting, setIsRestarting] = React.useState(false);
  // 触发器：当后端 session 丢失（服务端重启 / idle 清理）后，bump 这个值
  // 让 ensureSession 的 useEffect 重新跑。只改 ref 没用，React 不会因此 re-run effect。
  const [restartTrigger, setRestartTrigger] = React.useState(0);
  const [_tmuxLayout, setTmuxLayout] = React.useState<TmuxLayout | null>(null);
  const showDebug = externalShowDebug !== undefined ? externalShowDebug : false;

  // 流清理和活动终端引用
  const streamCleanupRef = React.useRef<(() => void) | null>(null);
  const activeTerminalIdRef = React.useRef<string | null>(null);
  const terminalIdRef = React.useRef<string | null>(null);
  const sessionIdRef = React.useRef<string | null>(null);
  const terminalControllerRef = React.useRef<TerminalController | null>(null);
  const flowPausedRef = React.useRef(false);
  const lastSentFlowPausedRef = React.useRef<boolean | null>(null);
  const flowPausedBufferRef = React.useRef<string[]>([]);
  const suppressInputUntilRef = React.useRef(0);
  const shouldExitTmuxCopyModeOnInputRef = React.useRef(false);
  const tmuxScrollPendingRef = React.useRef<{ direction: 'up' | 'down'; lines: number } | null>(null);
  const tmuxScrollFlushTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const modifierTapRef = React.useRef<{ modifier: Modifier; timestamp: number } | null>(null);
  const lastFocusRequestTokenRef = React.useRef(0);
  const lastSentLogicalFocusRef = React.useRef<boolean | null>(null);
  const streamVersionRef = React.useRef(0);
  const isActiveRef = React.useRef(isActive);
  const isMobileRef = React.useRef(isMobile);
  const pendingShellTitleRef = React.useRef<{ sessionId: string; title: string | null } | null>(null);
  const shellTitleRafRef = React.useRef<number | null>(null);

  const flushPendingShellTitle = React.useCallback(() => {
    shellTitleRafRef.current = null;
    const pending = pendingShellTitleRef.current;
    pendingShellTitleRef.current = null;
    if (!pending) return;
    setSessionShellTitle(pending.sessionId, pending.title);
  }, [setSessionShellTitle]);

  const scheduleShellTitleUpdate = React.useCallback((targetSessionId: string, title: string | null) => {
    pendingShellTitleRef.current = { sessionId: targetSessionId, title };
    if (shellTitleRafRef.current !== null) return;
    if (typeof window === 'undefined') {
      flushPendingShellTitle();
      return;
    }
    shellTitleRafRef.current = window.requestAnimationFrame(flushPendingShellTitle);
  }, [flushPendingShellTitle]);

  const cancelPendingShellTitle = React.useCallback(() => {
    if (shellTitleRafRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(shellTitleRafRef.current);
    }
    shellTitleRafRef.current = null;
    pendingShellTitleRef.current = null;
  }, []);

  React.useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  // Swiper 翻到本页（isActive 从 false→true）：让编排器走一遍刷新。
  //
  // 注意只在 isActive 由 false→true 时才跑。terminalSessionId 变化、初次 mount
  // 不应该触发——那些场景由 'connected' / 'session-key-change' / 'mount' 自己
  // 的 refresh 负责，page-flip 多来一次会让用户看到 connected 之后再"闪一下"。
  const wasActiveRef = React.useRef(false);
  React.useEffect(() => {
    if (!isActive) {
      terminalControllerRef.current?.blur();
      wasActiveRef.current = false;
      return;
    }
    if (wasActiveRef.current) {
      // 已经处于 active，依赖里其它值变化（terminalSessionId）触发的 effect，
      // 不是真正的翻页，直接跳过。
      return;
    }
    wasActiveRef.current = true;
    // 双 rAF 等 swiper 的 transform 收尾，容器尺寸稳定后再 fit
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        terminalControllerRef.current?.requestRefresh('page-flip');
      });
    });
    const postTransitionTimer = window.setTimeout(() => {
      terminalControllerRef.current?.requestRefresh('page-flip');
    }, 360);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(postTransitionTimer);
    };
  }, [isActive, terminalSessionId]);

  React.useEffect(() => {
    isMobileRef.current = isMobile;
  }, [isMobile]);

  const focusTerminalIfActive = React.useCallback(() => {
    if (!isActiveRef.current) {
      return;
    }
    terminalControllerRef.current?.focus();
  }, []);

  const restartEnsureSession = React.useCallback(() => {
    hasInitializedRef.current = false;
    setRestartTrigger((token) => token + 1);
  }, []);

  const probeOrRestartSession = React.useCallback((reason: string) => {
    const tid = terminalIdRef.current;
    if (tid && probeTerminalConnection(tid)) {
      debugSession('[Terminal] resume probe sent', { reason, backendSessionId: tid, active: isActiveRef.current });
      return;
    }
    debugSession('[Terminal] resume probe missing connection, restarting ensureSession', {
      reason,
      backendSessionId: tid,
      active: isActiveRef.current,
    });
    restartEnsureSession();
  }, [debugSession, restartEnsureSession]);

  const reportFlowControl = React.useCallback((paused: boolean, reason: string) => {
    const backendSessionId = terminalIdRef.current;
    if (!backendSessionId) return;
    if (lastSentFlowPausedRef.current === paused) return;
    lastSentFlowPausedRef.current = paused;
    sendTerminalFlowControlState(backendSessionId, paused, reason);
    debugSession('[Terminal] flow-control state sent', { backendSessionId, paused, reason });
  }, [debugSession]);

  const reportLogicalFocus = React.useCallback((focused: boolean, reason: string) => {
    const backendSessionId = terminalIdRef.current;
    if (!backendSessionId) return;
    if (lastSentLogicalFocusRef.current === focused) return;
    lastSentLogicalFocusRef.current = focused;
    sendTerminalFocusState(backendSessionId, focused, reason);
    debugSession('[Terminal] focus state sent', { backendSessionId, focused, reason });
  }, [debugSession]);

  const logicalFocus = computeTerminalLogicalFocus({
    isActive,
    viewportFocused: isViewportFocused,
    documentVisible: isDocumentVisible,
    windowFocused: isWindowFocused,
    streamReady: isStreamReady,
  });

  React.useEffect(() => {
    reportLogicalFocus(logicalFocus, 'logical-focus-change');
  }, [logicalFocus, reportLogicalFocus, terminalSessionId]);

  // Listen for font size changes from TerminalViewport (pinch-to-zoom)
  React.useEffect(() => {
    const handleFontChange = (event: Event) => {
      const customEvent = event as CustomEvent<number>;
      const newSize = customEvent.detail;
      if (typeof newSize === 'number' && newSize >= 8 && newSize <= 32) {
        setFontSize(newSize);
      }
    };

    document.addEventListener('termfontchange', handleFontChange);
    return () => document.removeEventListener('termfontchange', handleFontChange);
  }, []);

  // 统一恢复入口：visibility / bfcache / online 全部走 controller.requestRefresh。
  // 编排器在内部完成 throttle（200ms 互斥）、fit/refresh/scrollToBottom 序列、
  // resize 推送（first-fit immediate / 90ms debounce）、renderer 按需重建。
  // 真正"重绘"的逻辑收编到 TerminalViewport 的 refresh 编排器里，本组件不再持有
  // rAF 句柄、throttle 时间戳、tmux sessionId 等任何同步状态。
  React.useEffect(() => {
    const handleVisibility = () => {
      const visible = !document.hidden;
      setIsDocumentVisible(visible);
      if (visible && isActive) {
        terminalControllerRef.current?.requestRefresh('visibility');
        // 唤醒后立刻探测 WS 是否还活着（iOS PWA 后台返回常出现"半开连接"）。
        // probe 内部会发 ping，超时没回应就主动替换连接并重连补帧。
        probeOrRestartSession('visibility-active');
      }
    };
    const handlePageShow = (event: PageTransitionEvent) => {
      if (!isActive) return;
      terminalControllerRef.current?.requestRefresh(event.persisted ? 'bfcache' : 'visibility');
      probeOrRestartSession(event.persisted ? 'bfcache-active' : 'pageshow-active');
    };
    const handleOnline = () => {
      if (!isActive) return;
      terminalControllerRef.current?.requestRefresh('online');
      probeOrRestartSession('online-active');
    };
    const handleWindowFocus = () => setIsWindowFocused(true);
    const handleWindowBlur = () => setIsWindowFocused(false);
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('online', handleOnline);
    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('focus', handleWindowFocus);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [isActive, probeOrRestartSession]);

  // MultiTerminalView 在 visibility/pageshow/online 时会给所有 TerminalView
  // 广播这个 token。active slide 已由上面的本地 visibility/pageshow/online
  // 监听负责 refresh + probe；这里仅处理非活跃 SwiperSlide 的 WS 自检，避免
  // active terminal 在同一次恢复里重复 refresh / probe。
  React.useEffect(() => {
    if (!resumeRequestToken) return;
    if (isActiveRef.current) return;
    probeOrRestartSession('global-resume');
  }, [resumeRequestToken, probeOrRestartSession]);

  // 失败态自愈：session 用尽底层 10 次重试后会进入 fatal（connection failed），
  // 此时 wsConnections 里的 conn 已被 cleanup 删除，仅靠 visibility/focus/online
  // 事件才会触发 probeOrRestartSession 重连。但如果页面一直开在前台、没有任何
  // 可见性/聚焦变化（桌面常驻、或弱网下某条 session 首连就失败），这条 session
  // 会永久停在失败态：tab 一直显示默认名、没有程序名/目录——正是偶现「某些
  // session 一直连接失败」的根因。
  //
  // 这里加一个不依赖用户操作的后台自愈定时器：fatal 持续期间按退避节奏自动
  // 重跑 ensureSession，最多 MAX 次，避免对真正挂掉的后端无限打。
  //
  // 实现要点（避免状态抖动）：
  //  - 成功判据用 isStreamReady（connected 时才置 true），不用 isFatalError，
  //    因为 timer 重连过程中 isFatalError 会经历 true→false→true 抖动。
  //  - 每次自愈调用 restartEnsureSession（bump restartTrigger），本 effect 依赖
  //    restartTrigger，故每次尝试后必然重跑：连上了就 reset 收手，没连上就按
  //    递增 attempt 继续退避，到 MAX 上限后停手等用户手动 Retry。
  const fatalSelfHealAttemptRef = React.useRef(0);
  React.useEffect(() => {
    // 已连上（流就绪）：清零计数，结束自愈。
    if (isStreamReady) {
      fatalSelfHealAttemptRef.current = 0;
      return;
    }
    // 只在 fatal 失败态下自愈；非 fatal 的正常连接中/重连中交给既有路径。
    if (!isFatalError) return;

    const MAX_SELF_HEAL = 8;
    if (fatalSelfHealAttemptRef.current >= MAX_SELF_HEAL) return;

    const attempt = fatalSelfHealAttemptRef.current;
    // 退避：2s, 4s, 8s … 上限 30s。给后端/网络恢复留时间，又不至于太久无响应。
    const delay = Math.min(2000 * Math.pow(2, attempt), 30000);
    const timer = setTimeout(() => {
      fatalSelfHealAttemptRef.current += 1;
      debugSession('[Terminal] fatal self-heal: auto restarting ensureSession', {
        attempt: fatalSelfHealAttemptRef.current,
        backendSessionId: terminalIdRef.current,
      });
      setConnectionError('Reconnecting...');
      setIsFatalError(false);
      restartEnsureSession();
    }, delay);

    return () => clearTimeout(timer);
  }, [isFatalError, isStreamReady, restartTrigger, debugSession, restartEnsureSession]);

  // iOS detection
  React.useEffect(() => {
    if (typeof window === 'undefined') {
      setIsIOS(false);
      return;
    }
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
               (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    setIsIOS(ios);
  }, []);

  React.useEffect(() => {
    if (!isActive || !isMobile) {
      setIsInputFocused(false);
    }
    if (!isActive) {
      setIsViewportFocused(false);
    }
  }, [isActive, isMobile]);

  React.useEffect(() => {
    terminalIdRef.current = terminalSessionId;
    lastSentLogicalFocusRef.current = null;
    lastSentFlowPausedRef.current = null;
  }, [terminalSessionId]);

  React.useEffect(() => {
    if (!isTmuxMode) {
      shouldExitTmuxCopyModeOnInputRef.current = false;
      tmuxScrollPendingRef.current = null;
      if (tmuxScrollFlushTimerRef.current) {
        clearTimeout(tmuxScrollFlushTimerRef.current);
        tmuxScrollFlushTimerRef.current = null;
      }
    }
  }, [isTmuxMode]);

  // 后端 session 切换（auto-recreate / 显式重启）时通知编排器重置 lastServerSize，
  // 让下一个 first-fit 走 immediate 路径，把新 session 的真实尺寸告诉服务端。
  React.useEffect(() => {
    if (!terminalSessionId) return;
    terminalControllerRef.current?.requestRefresh('session-key-change', { force: true });
  }, [terminalSessionId]);

  React.useEffect(() => {
    const visible = isActive && isMobile && isViewportKeyboardOpen;

    debugKeyboard('visibility signal', {
      sessionId,
      isActive,
      isMobile,
      isInputFocused,
      isViewportKeyboardOpen,
      viewportKeyboardHeight,
      visible,
    });
    onKeyboardVisibilityChange?.(sessionId, visible);
  }, [
    onKeyboardVisibilityChange,
    sessionId,
    isActive,
    isMobile,
    isViewportKeyboardOpen,
    viewportKeyboardHeight,
    debugKeyboard,
  ]);

  React.useEffect(() => {
    if (!isActive) {
      return;
    }
    if (!focusRequestToken) {
      return;
    }
    if (focusRequestToken === lastFocusRequestTokenRef.current) {
      return;
    }
    lastFocusRequestTokenRef.current = focusRequestToken;
    focusTerminalIfActive();
  }, [focusRequestToken, focusTerminalIfActive, isActive]);

  React.useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  React.useEffect(() => {
    if (!isMobile && (activeModifier !== null || lockedModifier !== null)) {
      setActiveModifier(null);
      setLockedModifier(null);
      modifierTapRef.current = null;
    }
  }, [isMobile, activeModifier, lockedModifier]);

  React.useEffect(() => {
    if (!terminalSessionId && (activeModifier !== null || lockedModifier !== null)) {
      setActiveModifier(null);
      setLockedModifier(null);
      modifierTapRef.current = null;
    }
  }, [terminalSessionId, activeModifier, lockedModifier]);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(MOBILE_KEYBOARD_EXPANDED_STORAGE_KEY, showExtendedKeyboard ? 'true' : 'false');
  }, [showExtendedKeyboard]);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(MOBILE_KEYBOARD_PRESET_MODE_STORAGE_KEY, toolbarPresetMode);
  }, [toolbarPresetMode]);

  React.useEffect(() => {
    const checkIsMobile = () => {
      if (typeof window === 'undefined') return false;
      const hasTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
      const isNarrow = window.innerWidth < 768;
      return hasTouch && isNarrow;
    };

    setIsMobile(checkIsMobile());

    const handleResize = () => {
      setIsMobile(checkIsMobile());
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const disconnectStream = React.useCallback(() => {
    streamVersionRef.current += 1;
    flushPendingShellTitle();
    cancelPendingShellTitle();
    const cleanup = streamCleanupRef.current;
    streamCleanupRef.current = null;
    activeTerminalIdRef.current = null;
    // 断开后立即把 sessionReady 复位：后续 resize push 会被编排器 gate 住，
    setIsStreamReady(false);
    // 直到下次 connected 事件再 setSessionReady(true)。
    // 这样避免把新 resize 用旧 terminalId 发出去。
    terminalControllerRef.current?.setSessionReady(false);
    const currentBackendSessionId = terminalIdRef.current;
    if (currentBackendSessionId) {
      sendTerminalFlowControlState(currentBackendSessionId, false, 'stream-disconnect');
    }
    flowPausedRef.current = false;
    lastSentFlowPausedRef.current = null;
    flowPausedBufferRef.current = [];
    cleanup?.();
  }, [cancelPendingShellTitle, flushPendingShellTitle]);

  const startStream = React.useCallback(
    (terminalId: string) => {
      if (activeTerminalIdRef.current === terminalId) {
        debugSession(`[startStream] Skipping - already connected to ${terminalId}`);
        return;
      }

      debugSession(`[startStream] Starting stream for frontendSessionId=${sessionId} backendSessionId=${terminalId}`);
      disconnectStream();
      const streamVersion = streamVersionRef.current + 1;
      streamVersionRef.current = streamVersion;

      const subscription = terminal.connect(
        terminalId,
        {
          onEvent: (event: TerminalStreamEvent) => {
            if (streamVersionRef.current !== streamVersion) {
              return;
            }

            const storeSessionId = sessionId;
            if (!storeSessionId) return;

            switch (event.type) {
              case 'connected': {
                if (event.runtime || event.ptyBackend) {
                  debugSession(
                    `[Terminal] connected frontendSessionId=${storeSessionId} backendSessionId=${terminalIdRef.current} runtime=${event.runtime ?? 'unknown'} pty=${event.ptyBackend ?? 'unknown'} cwd=${event.cwd ?? 'unknown'}`
                  );
                }
                setConnecting(storeSessionId, false);
                setConnectionError(null);
                setIsFatalError(false);

                // 标记 WS 已就绪：编排器从这一刻起才允许 push resize 给服务端。
                setIsStreamReady(true);
                // 之前没有这个 gate，reload 时 ResizeObserver 在 ensureSession
                // 跑完前就拿 OLD terminalId POST 出去，server 直接 404 + WS 4001
                // 触发 auto-recreate，必须完全重连才能用。
                terminalControllerRef.current?.setSessionReady(true);

                // WS 重连后服务端的 per-client flow 状态是新的，补发当前水位状态，
                // 避免前端仍处于 paused 而服务端继续灌输出。
                lastSentFlowPausedRef.current = null;
                reportFlowControl(flowPausedRef.current, 'stream-connected');

                // Sync agent status from server on connect
                if (event.agentStatus !== undefined) {
                  setSessionAgentStatus(
                    storeSessionId,
                    event.agentStatus ?? null,
                    event.agentColor ?? null,
                    event.agentIndicator ?? null,
                  );
                }
                if (event.tuiProgress !== undefined) {
                  useTerminalStore.getState().setSessionTuiProgress(storeSessionId, event.tuiProgress ?? null);
                }

                const sessionState = useTerminalStore.getState().getTerminalSession(storeSessionId);
                if (sessionState?.terminalSessionId && event.mode) {
                  useTerminalStore.getState().setTerminalSession(storeSessionId, {
                    sessionId: sessionState.terminalSessionId,
                    cols: 80,
                    rows: 24,
                    mode: event.mode,
                    tmuxSessionName: event.tmuxSessionName ?? null,
                    cwd: event.cwd ?? null,
                  });
                }

                // 首帧立即写入 activeProgram：connected 事件已携带服务端连接时
                // detect 的 activeProgram（terminal.ts:4348-4358 / 4402）。之前
                // 只写了 cwd，activeProgram 要白等到第一次 active-program 轮询
                // （1200ms）才到，tab 名会从默认名「迟一拍」跳成程序名。这里补上
                // 后，WS 一连上 tab 就能显示「coco termdock」，少一次可见跳变。
                if (event.activeProgram !== undefined) {
                  setSessionActiveProgram(
                    storeSessionId,
                    event.activeProgram ?? null,
                    event.activeProgramSource ?? null,
                    event.activeProgramRaw ?? null,
                  );
                }

                // 连接建立后强制刷新：等 history 落盘后由编排器完成 fit + atlas + scroll。
                // 编排器内部默认会推 first-fit immediate resize 告诉服务端真实尺寸。
                requestAnimationFrame(() => {
                  requestAnimationFrame(() => {
                    terminalControllerRef.current?.requestRefresh('connected', { force: true, resizeDebounceMs: 0 });
                  });
                });
                // 移动端兜底：软键盘 / Safari 视口尺寸在 connected 后才稳定，
                // 多刷两次让 fit 跟上最终布局。桌面没有这个抖动，多刷反而会
                // 让用户看到第二次 fit + scroll 的"闪一下"，所以仅 mobile 启用。
                if (typeof window !== 'undefined' && isActiveRef.current && isMobileRef.current) {
                  window.setTimeout(() => {
                    terminalControllerRef.current?.requestRefresh('connected', { force: true, resizeDebounceMs: 0 });
                  }, 120);
                  window.setTimeout(() => {
                    terminalControllerRef.current?.requestRefresh('connected', { force: true, resizeDebounceMs: 0 });
                  }, 360);
                }

                if (event.mode !== 'tmux') {
                  setTmuxLayout(null);
                  setSessionCopyMode(storeSessionId, false);
                }
                // tmux 模式不需要单独复位：编排器内 session-key-change 已经
                // 处理了 lastServerSize 重置；tmux-layout 第一次到达时由 useEffect
                // 触发 candidateSize 防 shrink 路径。

                debugSession('[Terminal] Connected event received:', {
                  frontendSessionId: storeSessionId,
                  backendSessionId: terminalIdRef.current,
                  storeHasState: !!sessionState,
                  storeTerminalId: sessionState?.terminalSessionId,
                  hasHistoryInStore: !!(sessionState?.history?.length),
                  historyLength: sessionState?.history?.length ?? 0,
                });

                if (sessionState?.history && sessionState.history.length > 0) {
                  debugSession(`[Terminal] Restoring ${sessionState.history.length} history chunks to frontend session ${storeSessionId}`);
                  const totalHistoryBytes = sessionState.history.reduce((total, chunk) => total + chunk.length, 0);
                  const suppressionMs = Math.max(300, Math.min(2000, Math.ceil(totalHistoryBytes / 200)));
                  suppressInputUntilRef.current = Date.now() + suppressionMs;
                  sessionState.history.forEach((chunk) => {
                    appendToBuffer(storeSessionId, chunk, { markActivity: false });
                  });
                  useTerminalStore.getState().setSessionHistory(storeSessionId, []);
                  debugSession(`[Terminal] History restoration complete for ${storeSessionId}`);
                } else {
                  debugSession(`[Terminal] No history to restore for ${storeSessionId}`);
                }

                // 短线重连补帧：服务端按 sinceSeq 返回断线期间产生的输出。
                // - replayOutOfWindow 表示客户端基线已被服务端淘汰（环形 buffer
                //   覆盖），此时清屏 + 全量重放，避免错位拼接。
                // - 否则直接 append，与现有 buffer 衔接。
                const replayChunks = event.replayChunks;
                if (replayChunks && replayChunks.length > 0) {
                  if (event.replayOutOfWindow) {
                    debugSession(`[Terminal] Replay out-of-window, clearing buffer before replay (${replayChunks.length} chunks)`);
                    clearBuffer(storeSessionId);
                    terminalControllerRef.current?.clear();
                  } else {
                    debugSession(`[Terminal] Replay incremental: ${replayChunks.length} chunks`);
                  }
                  // 抑制 replay 期间的用户输入，避免 echo 顺序错乱。
                  const replayBytes = replayChunks.reduce((total, chunk) => total + chunk.length, 0);
                  const suppressionMs = Math.max(200, Math.min(1500, Math.ceil(replayBytes / 200)));
                  suppressInputUntilRef.current = Math.max(suppressInputUntilRef.current, Date.now() + suppressionMs);
                  for (const chunk of replayChunks) {
                    appendToBuffer(storeSessionId, chunk);
                  }
                }
                break;
              }
              case 'reconnecting': {
                const attempt = event.attempt ?? 0;
                const maxAttempts = event.maxAttempts ?? 3;
                setConnectionError(`Reconnecting (${attempt}/${maxAttempts})...`);
                setIsFatalError(false);
                break;
              }
              case 'data': {
                if (event.data) {
                  if (flowPausedRef.current) {
                    flowPausedBufferRef.current.push(event.data);
                  } else {
                    appendToBuffer(storeSessionId, event.data);
                  }
                }
                break;
              }
              case 'tmux-layout': {
                setTmuxLayout(event.layout ?? null);
                if (event.layout) {
                  setSessionCopyMode(storeSessionId, event.layout.inCopyMode);
                }
                break;
              }
              case 'active-program': {
                setSessionActiveProgram(
                  storeSessionId,
                  event.activeProgram ?? null,
                  event.activeProgramSource ?? null,
                  event.activeProgramRaw ?? null,
                );
                break;
              }
              case 'cwd': {
                setSessionCwd(storeSessionId, event.cwd ?? null);
                break;
              }
              case 'agent-status': {
                setSessionAgentStatus(
                  storeSessionId,
                  event.agentStatus ?? null,
                  event.agentColor ?? null,
                  event.agentIndicator ?? null,
                );
                break;
              }
              case 'focus-mode': {
                debugSession('[Terminal] focus tracking mode', {
                  backendSessionId: terminalIdRef.current,
                  requested: event.focusTrackingRequested === true,
                });
                break;
              }
              case 'pty-size': {
                // 服务端在任意 client resize 之后广播过来的真实 pty 尺寸。
                // 同步给 viewport 的 lastServerSize：多端切换后 ensureSizeMatches
                // 比对时才有正确的"服务端事实"。同时让本端进入 ~1.5s 冷却窗口
                // 不主动反推，避免双端互相覆盖（防拉扯）。
                if (typeof event.cols === 'number' && typeof event.rows === 'number') {
                  terminalControllerRef.current?.notifyServerSize(
                    event.cols,
                    event.rows,
                    event.source,
                  );
                }
                break;
              }
              case 'shell-title': {
                // Shell integration (OSC 2) reported title — cwd when idle, command when running.
                scheduleShellTitleUpdate(storeSessionId, event.title ?? null);
                break;
              }
              case 'prompt-state': {
                // Shell integration (OSC 133) reported prompt state — 'idle' or 'running'.
                setSessionPromptState(storeSessionId, event.state ?? 'idle', event.exitCode ?? null);
                break;
              }
              case 'tui-progress': {
                useTerminalStore.getState().setSessionTuiProgress(storeSessionId, event.tuiProgress ?? null);
                break;
              }
              case 'exit': {
                const exitCode =
                  typeof event.exitCode === 'number' ? event.exitCode : null;
                const signal = typeof event.signal === 'number' ? event.signal : null;
                appendToBuffer(
                  storeSessionId,
                  `\r\n[Process exited${
                    exitCode !== null ? ` with code ${exitCode}` : ''
                  }${signal !== null ? ` (signal ${signal})` : ''}]\r\n`
                );
                clearTerminalSession(storeSessionId);
                setConnecting(storeSessionId, false);
                setConnectionError('Terminal session ended');
                setIsStreamReady(false);
                setIsFatalError(false);
                setTmuxLayout(null);
                setSessionCopyMode(storeSessionId, false);
                disconnectStream();
                break;
              }
            }
          },
          onError: (error, fatal) => {
            if (streamVersionRef.current !== streamVersion) {
              return;
            }

            const storeSessionId = sessionId;
            if (!storeSessionId) return;

            const errorMsg = fatal
              ? `Connection failed: ${error.message}`
              : error.message || 'Terminal stream connection error';
            console.error(`[Terminal] Stream error (fatal=${fatal}):`, errorMsg);

            // 单独高亮 Session not found，方便 grep / 自动化检测
            if (error.message === 'Session not found on server') {
              // eslint-disable-next-line no-console
              console.warn('[Terminal] SESSION_NOT_FOUND_DETECTED', {
                terminalIdAtError: terminalIdRef.current,
                frontendSessionId: storeSessionId,
                isActive,
                isMobile,
                fatal,
                stack: new Error().stack,
              });
            }

            setConnectionError(errorMsg);
            setIsFatalError(!!fatal);

            if (fatal) {
              setConnecting(storeSessionId, false);
              disconnectStream();

              // Session lost on server (e.g. server restart) — automatically
              // recreate instead of making the user manually refresh.
              if (error.message === 'Session not found on server') {
                debugSession(`[onError] Session lost, auto-recreating`);
                // 友好提示：先把红字 "Connection failed" 替换成普通灰字 "Reconnecting..."，
                // 这样 200ms 过渡期 UI 不会闪一下错误，紧接着 setConnectionError(null) 收尾。
                setConnectionError('Reconnecting...');
                setIsFatalError(false);
                clearTerminalSession(storeSessionId);
                clearBuffer(storeSessionId);
                terminalIdRef.current = null;
                // Allow ensureSession to run again
                hasInitializedRef.current = false;
                // Small delay to let cleanup settle, then re-init.
                // 关键：bump restartTrigger 才能真正让 useEffect 重跑；
                // 只重置 ref + 清 error state 不会触发 effect。
                setTimeout(() => {
                  hasInitializedRef.current = false;
                  setRestartTrigger((t) => t + 1);
                }, 200);
              }
            }
          },
        },
        STREAM_OPTIONS
      );

      streamCleanupRef.current = () => {
        subscription.close();
        if (streamVersionRef.current === streamVersion) {
          activeTerminalIdRef.current = null;
        }
      };
      activeTerminalIdRef.current = terminalId;
    },
    [appendToBuffer, clearBuffer, clearTerminalSession, debugSession, disconnectStream, reportFlowControl, scheduleShellTitleUpdate, setConnecting, setSessionActiveProgram, setSessionAgentStatus, setSessionCopyMode, setSessionCwd, setSessionPromptState, terminal, sessionId]
  );

  const hasInitializedRef = React.useRef(false);
  const currentRunIdRef = React.useRef(0);

  React.useEffect(() => {
    return () => {
      currentRunIdRef.current += 1;
      hasInitializedRef.current = false;
      disconnectStream();
    };
  }, [disconnectStream]);

  const desiredSessionModeRef = React.useRef<TerminalMode>(desiredSessionMode);
  const desiredTmuxSessionNameRef = React.useRef<string | null>(desiredTmuxSessionName);
  React.useEffect(() => {
    const previousMode = desiredSessionModeRef.current;
    const previousTmuxSessionName = desiredTmuxSessionNameRef.current;
    desiredSessionModeRef.current = desiredSessionMode;
    desiredTmuxSessionNameRef.current = desiredTmuxSessionName;
    if (sessionIdRef.current !== sessionId) return;
    if (previousMode === desiredSessionMode && previousTmuxSessionName === desiredTmuxSessionName) return;
    hasInitializedRef.current = false;
    disconnectStream();
    setRestartTrigger((token) => token + 1);
  }, [desiredSessionMode, desiredTmuxSessionName, disconnectStream, sessionId]);

  React.useEffect(() => {
    if (sessionIdRef.current !== sessionId) {
      debugSession(`[useEffect] sessionId changed from ${sessionIdRef.current} to ${sessionId}, allowing reinitialization`);
      hasInitializedRef.current = false;
    }

    if (hasInitializedRef.current && sessionIdRef.current === sessionId) {
      debugSession(`[useEffect] Already initialized for sessionId=${sessionId}, skipping`);
      return;
    }

    debugSession(`[useEffect] Running ensureSession for sessionId=${sessionId}, hasInitialized=${hasInitializedRef.current}`);
    hasInitializedRef.current = true;

    const runId = ++currentRunIdRef.current;

    const ensureSession = async () => {
      debugSession(`[ensureSession] Starting for sessionId=${sessionId}, runId=${runId}`);

      if (!sessionIdRef.current || sessionIdRef.current !== sessionId) {
        debugSession(`[ensureSession] SessionId mismatch or stale run (current=${sessionIdRef.current}, target=${sessionId}), skipping`);
        return;
      }

      if (runId !== currentRunIdRef.current) {
        debugSession(`[ensureSession] Stale run detected (runId=${runId}, currentRunId=${currentRunIdRef.current}), skipping`);
        return;
      }

      const store = useTerminalStore.getState();
      const currentState = store.getTerminalSession(sessionId);
      const currentMode = currentState?.mode ?? desiredSessionMode;
      debugSession(`[ensureSession] Current state from store:`, {
        terminalSessionId: currentState?.terminalSessionId,
        mode: currentState?.mode,
        tmuxSessionName: currentState?.tmuxSessionName,
        isConnecting: currentState?.isConnecting
      });

      let terminalId = currentState?.terminalSessionId ?? null;
      let shouldCreateNewSession = !terminalId;
      if (terminalId && currentMode !== desiredSessionMode) {
        debugSession(`[ensureSession] Store mode mismatch for ${terminalId}: current=${currentMode} desired=${desiredSessionMode}, will create new session`);
        shouldCreateNewSession = true;
        store.clearTerminalSession(sessionId);
        terminalId = null;
      } else if (
        terminalId &&
        desiredSessionMode === 'tmux' &&
        desiredTmuxSessionName &&
        currentState?.tmuxSessionName !== desiredTmuxSessionName
      ) {
        debugSession(`[ensureSession] Store tmux name mismatch for ${terminalId}: current=${currentState?.tmuxSessionName} desired=${desiredTmuxSessionName}, will create new session`);
        shouldCreateNewSession = true;
        store.clearTerminalSession(sessionId);
        terminalId = null;
      }

      if (terminalId && terminal.checkHealth) {
        debugSession(`[ensureSession] Checking health of existing session ${terminalId}`);
        try {
          const health = await terminal.checkHealth(terminalId);
          debugSession(`[ensureSession] Health check result:`, health);
          if (!health.healthy) {
            debugSession(`[ensureSession] Session ${terminalId} is NOT healthy (healthy=${health.healthy}), will create new session`);
            debugSession(`[ensureSession] Health check details:`, health);
            shouldCreateNewSession = true;
            store.clearTerminalSession(sessionId);
            debugSession(`[ensureSession] Cleared unhealthy session from store`);
          } else {
            debugSession(`[ensureSession] Session ${terminalId} is healthy, reusing it, cwd=${health.cwd}, clients=${health.clients}, lastActivity=${Date.now() - (health.lastActivity || 0)}ms ago`);
            if (health.mode && currentState?.terminalSessionId) {
              store.setTerminalSession(sessionId, {
                sessionId: currentState.terminalSessionId,
                cols: 80,
                rows: 24,
                mode: health.mode,
                tmuxSessionName: health.tmuxSessionName ?? null,
              });
            }
            debugSession(`[ensureSession] Setting terminalIdRef to ${terminalId} and starting stream`);
            terminalIdRef.current = terminalId;
            startStream(terminalId);
            debugSession(`[ensureSession] Successfully reused healthy session ${terminalId}, returning early`);
            return;
          }
        } catch (error) {
          debugSession(`[ensureSession] Failed to check health of session ${terminalId}:`, error);
          debugSession(`[ensureSession] Health check API call failed, proceeding as if session might be unhealthy`);
        }
      }

      debugSession(`[ensureSession] Decision: shouldCreateNewSession=${shouldCreateNewSession}, terminalId=${terminalId}`);
      if (shouldCreateNewSession) {
        debugSession(`[ensureSession] Creating new session, shouldCreateNewSession=${shouldCreateNewSession}, runId=${runId}`);
        setConnectionError(null);
        setIsFatalError(false);
        store.setConnecting(sessionId, true);

        const currentStore = useTerminalStore.getState();
        const recheckedState = currentStore.getTerminalSession(sessionId);
        const recheckedMode = recheckedState?.mode ?? desiredSessionMode;
        const recheckedMatchesDesired =
          recheckedMode === desiredSessionMode &&
          (
            desiredSessionMode !== 'tmux' ||
            !desiredTmuxSessionName ||
            recheckedState?.tmuxSessionName === desiredTmuxSessionName
          );
        if (recheckedState?.terminalSessionId && recheckedMatchesDesired) {
          debugSession(`[ensureSession] Race condition avoided: another instance already created session ${recheckedState.terminalSessionId}`);
          store.setConnecting(sessionId, false);
          terminalId = recheckedState.terminalSessionId;
          shouldCreateNewSession = false;
        } else {
          try {
            const modeForNewSession = desiredSessionMode;
            const tmuxSessionNameForNewSession = desiredTmuxSessionName || fallbackTmuxSessionName;
            const session = await terminal.createSession({
              mode: modeForNewSession,
              tmuxSessionName: modeForNewSession === 'tmux' ? tmuxSessionNameForNewSession : undefined,
              termType: 'xterm-256color',
            });
            debugSession(`[ensureSession] Created new session ${session.sessionId}`);

            if (runId !== currentRunIdRef.current) {
              // 这次 ensureSession 是 stale 的：另一个并发 run 已经接管了。
              // 关键：绝对不能 close 刚创建的 session！它可能正是 sibling 即将
              // 通过 store 里 recheckedState 拿到的同一个 ID（tmux-reuse 路径
              // 会让多个 ensureSession 拿到相同的 backend sessionId）。如果
              // 这里 close，sibling 的 WS 立刻 4001，整条 tmux 链路挂掉。
              // 正确做法：让 sibling 自然走自己的"复用"分支，session 留在服务端
              // 给所有人用。
              debugSession(`[ensureSession] Stale run after session creation (runId=${runId}, currentRunId=${currentRunIdRef.current}), leaving ${session.sessionId} for sibling`);
              return;
            }

            store.setTerminalSession(sessionId, session);
            void updateSessionInventoryEntry(sessionId, {
              backendSessionId: session.sessionId,
              tmuxSessionName: session.tmuxSessionName ?? null,
            }).catch((error) => {
              console.warn('[Terminal] failed to update inventory after auto recreate', error);
            });
            debugSession(`[ensureSession] Updated store with new session ${session.sessionId}`);
            terminalId = session.sessionId;
          } catch (error) {
            if (runId !== currentRunIdRef.current) {
              debugSession(`[ensureSession] Stale run after session creation failed, skipping error handling`);
              return;
            }
            setConnectionError(
              error instanceof Error
                ? error.message
                : 'Failed to start terminal session'
            );
            setIsFatalError(true);
            store.setConnecting(sessionId, false);
            return;
          }
        }
      }

      if (runId !== currentRunIdRef.current) {
        debugSession(`[ensureSession] Stale run before starting stream (runId=${runId}, currentRunId=${currentRunIdRef.current}), skipping`);
        return;
      }

      if (!terminalId) {
        debugSession(`[ensureSession] No terminalId, terminalId=${terminalId}`);
        return;
      }

      debugSession(`[ensureSession] Starting stream for session ${terminalId}`);
      terminalIdRef.current = terminalId;
      startStream(terminalId);
      debugSession(`[ensureSession] ensureSession completed for sessionId=${sessionId}, terminalId=${terminalId}`);
    };

    void ensureSession();

    return () => {
      debugSession(`[useEffect] Cleanup for sessionId=${sessionId}, runId=${runId}`);
    };
  }, [sessionId, restartTrigger, startStream, disconnectStream, terminal, debugSession, desiredSessionMode, desiredTmuxSessionName, fallbackTmuxSessionName]);

  const handleHardRestart = React.useCallback(async () => {
    if (!sessionId) return;
    if (isRestarting) return;

    setIsRestarting(true);
    setConnectionError(null);
    setIsFatalError(false);
    disconnectStream();

    try {
      if (terminal.forceKill) {
        await terminal.forceKill({ sessionId });
      }
    } catch { /* ignored */ }

    removeTerminalSession(sessionId);
    clearBuffer(sessionId);
    terminalControllerRef.current?.clear();

    await new Promise(r => setTimeout(r, 100));

    try {
      setConnecting(sessionId, true);
      const session = await terminal.createSession({
        mode: sessionMode,
        tmuxSessionName: sessionMode === 'tmux' ? preferredTmuxSessionName : undefined,
        termType: 'xterm-256color',
      });
      setTerminalSession(sessionId, session);
      void updateSessionInventoryEntry(sessionId, {
        backendSessionId: session.sessionId,
        tmuxSessionName: session.tmuxSessionName ?? (sessionMode === 'tmux' ? preferredTmuxSessionName : null),
      }).catch((error) => {
        console.warn('[Terminal] failed to update inventory after hard restart', error);
      });
      terminalIdRef.current = session.sessionId;
      startStream(session.sessionId);
    } catch (error) {
      setConnectionError(
        error instanceof Error ? error.message : 'Failed to create terminal'
      );
      setIsFatalError(true);
      setConnecting(sessionId, false);
    } finally {
      setIsRestarting(false);
    }
  }, [sessionId, isRestarting, disconnectStream, terminal, removeTerminalSession, clearBuffer, setConnecting, setTerminalSession, startStream, sessionMode, preferredTmuxSessionName]);

  const handleViewportInput = React.useCallback(
    (data: string, options?: { skipModifierTransform?: boolean; consumeModifier?: boolean }) => {
      if (!isActiveRef.current) {
        return;
      }

      if (!data) {
        return;
      }

      // 桌面端：xterm 在 mouseTracking 模式下把触控板/滚轮上滑转成
      // SGR mouse wheel（按钮码 64/65）。命中后标记 ref，让下一次真正的
      // 键盘输入触发 tmux 退出 copy-mode（与移动端 onTmuxScroll 路径一致）。
      // 注意：wheel 事件本身不退出 copy-mode（连续滚动要继续生效），
      // 只是打个标记，等真正的键盘输入再退出。
      const isMouseWheelSeq = /^\x1b\[<6[45];[0-9]+;[0-9]+M/.test(data);
      if (isTmuxMode && isMouseWheelSeq) {
        shouldExitTmuxCopyModeOnInputRef.current = true;
      }

      if (Date.now() < suppressInputUntilRef.current) {
        return;
      }

      let payload = data;
      let modifierConsumed = options?.consumeModifier ?? false;

      if (!options?.skipModifierTransform && activeModifier && data.length > 0) {
        const firstChar = data[0];
        if (firstChar.length === 1 && /[a-zA-Z]/.test(firstChar)) {
          const upper = firstChar.toUpperCase();
          if (activeModifier === 'ctrl') {
            payload = String.fromCharCode(upper.charCodeAt(0) & 0b11111);
            modifierConsumed = true;
          } else if (activeModifier === 'alt') {
            payload = `\u001b${data}`;
            modifierConsumed = true;
          }
        }

        if (!modifierConsumed) {
          if (activeModifier === 'alt') {
            payload = `\u001b${data}`;
          }
          modifierConsumed = true;
        }
      }

      const terminalId = terminalIdRef.current;
      if (!terminalId) {
        return;
      }

      const sendPayload = async () => {
        try {
          // 只有非 wheel 的真键盘输入才触发退出 copy-mode；
          // wheel 事件自身（包括首次进入 copy-mode 的那次滚轮）不退出。
          if (
            isTmuxMode &&
            !isMouseWheelSeq &&
            shouldExitTmuxCopyModeOnInputRef.current &&
            terminal.tmuxAction
          ) {
            shouldExitTmuxCopyModeOnInputRef.current = false;
            try {
              await terminal.tmuxAction(terminalId, { action: 'copy-mode', enabled: false });
            } catch {
              // exit-copy-mode failure shouldn't block sending input
            }
          }

          await terminal.sendInput(terminalId, payload);
        } catch (error) {
          setConnectionError(error instanceof Error ? error.message : 'Failed to send input');
        }
      };

      void sendPayload();

      if (modifierConsumed) {
        if (!lockedModifier) {
          setActiveModifier(null);
        }
        focusTerminalIfActive();
      }
    },
    [activeModifier, focusTerminalIfActive, isTmuxMode, lockedModifier, terminal]
  );

  React.useEffect(() => {
    const handleInsertReference = (event: Event) => {
      if (!isActiveRef.current) return;
      const customEvent = event as CustomEvent<{ text?: string; focus?: boolean }>;
      const text = customEvent.detail?.text;
      if (!text) return;
      handleViewportInput(text, {
        skipModifierTransform: true,
        consumeModifier: false,
      });
      if (customEvent.detail?.focus !== false) {
        focusTerminalIfActive();
      }
    };

    window.addEventListener('termdock-insert-reference', handleInsertReference);
    return () => window.removeEventListener('termdock-insert-reference', handleInsertReference);
  }, [focusTerminalIfActive, handleViewportInput]);

  // 推 resize 给服务端。本组件不再做 debounce / skip-if-same —— 编排器在
  // TerminalViewport 内部已经决定了 first-fit immediate / 90ms debounce /
  // skip-if-same，调用本函数说明编排器已经决策好了，直接发。
  const handleViewportResize = React.useCallback(
    (cols: number, rows: number) => {
      const terminalId = terminalIdRef.current;
      if (!terminalId) {
        debugKeyboard('xterm resize push skipped: no terminalId', { cols, rows });
        return;
      }
      debugKeyboard('xterm resize push', { cols, rows });
      void terminal.resize({ sessionId: terminalId, cols, rows }).catch((err) => {
        // 静默失败：resize 失败不影响终端渲染
        // 但需要知道是不是 session-not-found——这通常是后端 session 已被清掉
        // 而前端 ref 还指着旧 id，是 race 的明确信号。
        if (err && /session not found/i.test(String(err.message || err))) {
          // eslint-disable-next-line no-console
          console.warn('[Terminal] resize 404 session not found', {
            sessionId: terminalId,
            cols,
            rows,
            stack: new Error().stack,
          });
        }
      });
    },
    [terminal, debugKeyboard]
  );

  const sendTmuxAction = React.useCallback(async (payload: TmuxActionPayload) => {
    const terminalId = terminalIdRef.current;
    if (!terminalId || !terminal.tmuxAction) {
      return;
    }

    try {
      const result = await terminal.tmuxAction(terminalId, payload);
      if (result.layout) {
        setTmuxLayout(result.layout);
        if (payload.action === 'switch-session') {
          setTerminalSession(sessionId, {
            sessionId: terminalId,
            cols: 80,
            rows: 24,
            mode: 'tmux',
            tmuxSessionName: result.layout.sessionName,
          });
          void updateSessionInventoryEntry(sessionId, { tmuxSessionName: result.layout.sessionName }).catch((error) => {
            console.warn('[Terminal] failed to update inventory after tmux switch', error);
          });
        }
      }
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : 'Failed to execute tmux action');
    }
  }, [sessionId, setTerminalSession, terminal]);

  // tmux-layout 事件：把"服务端报的尺寸"作为 candidate 交给编排器。
  // 编排器内部做：
  //   1) dedupe by sessionId+activePaneId（避免同会话内重复 resize）
  //   2) candidateSize 防 shrink：比当前 xterm 小就忽略
  //   3) skipScrollToBottom：tmux 模式下不应强制滚底（vim/less 位置）
  // 这样原来散在 useEffect 里的三个 ref 全部下沉到编排器内部。
  React.useEffect(() => {
    // 必须等 terminalSessionId 就绪后再用 dedupeKey：reload 期间 tmux-layout
    // 事件可能比 connected 事件先到，那时 terminalSessionId 还是 null/旧值，
    // 会用旧 key 调一次 requestRefresh，编排器会拿新 key 比对旧的 lastDedupeKeyRef
    // 直接判重复。等 terminalSessionId 更新后再用新 key 重跑。
    if (!_tmuxLayout || !terminalSessionId) return;
    const activeWindow = _tmuxLayout.windows.find((w) => w.id === _tmuxLayout.activeWindowId);
    const activePane = activeWindow?.panes.find((p) => p.id === _tmuxLayout.activePaneId);
    if (!activePane) return;

    terminalControllerRef.current?.requestRefresh('tmux-layout', {
      candidateSize: { cols: activePane.width, rows: activePane.height },
      skipScrollToBottom: true,
      dedupeKey: `${terminalSessionId}:${_tmuxLayout.sessionId}:${activePane.id}:${activePane.width}x${activePane.height}`,
    });
  }, [_tmuxLayout, terminalSessionId]);

  const handleTmuxScroll = React.useCallback((direction: 'up' | 'down', lines = 5) => {
    const normalizedLines = Math.max(1, Math.min(Math.floor(lines) || 1, 40));
    shouldExitTmuxCopyModeOnInputRef.current = true;

    // The tick loop already batches lines per rAF frame, so most calls
    // arrive with a meaningful line count.  We still merge consecutive
    // same-direction calls that happen synchronously (rare edge case),
    // but send immediately — no artificial timer delay.
    const pending = tmuxScrollPendingRef.current;
    if (pending && pending.direction === direction) {
      pending.lines += normalizedLines;
      return;
    }

    if (pending) {
      void sendTmuxAction({ action: 'scroll', direction: pending.direction, lines: pending.lines }).finally(() => {
        focusTerminalIfActive();
      });
    }
    tmuxScrollPendingRef.current = { direction, lines: normalizedLines };

    // Microtask drain: flush on the next microtask so synchronous batches
    // (rare with tick-level batching) are merged, but we don't block on
    // an arbitrary timer.
    if (tmuxScrollFlushTimerRef.current) clearTimeout(tmuxScrollFlushTimerRef.current);
    tmuxScrollFlushTimerRef.current = setTimeout(() => {
      const p = tmuxScrollPendingRef.current;
      if (p) {
        tmuxScrollPendingRef.current = null;
        void sendTmuxAction({ action: 'scroll', direction: p.direction, lines: p.lines }).finally(() => {
          focusTerminalIfActive();
        });
      }
    }, 0);
  }, [focusTerminalIfActive, sendTmuxAction]);

  const handleModifierToggle = React.useCallback(
    (modifier: Modifier) => {
      const now = Date.now();
      const lastTap = modifierTapRef.current;
      const isDoubleTap =
        lastTap !== null &&
        lastTap.modifier === modifier &&
        now - lastTap.timestamp <= MODIFIER_DOUBLE_TAP_WINDOW_MS;

      modifierTapRef.current = { modifier, timestamp: now };

      if (lockedModifier === modifier) {
        setLockedModifier(null);
        setActiveModifier(null);
        return;
      }

      if (isDoubleTap) {
        setLockedModifier(modifier);
        setActiveModifier(modifier);
        return;
      }

      if (lockedModifier !== null && lockedModifier !== modifier) {
        setLockedModifier(null);
      }

      setActiveModifier((current) => (current === modifier ? null : modifier));
    },
    [lockedModifier]
  );

  const handleInputFocusChange = React.useCallback((focused: boolean) => {
    setIsViewportFocused(focused && isActiveRef.current);
    debugKeyboard('input focus changed', {
      focused,
      isActive: isActiveRef.current,
      isMobile: isMobileRef.current,
    });
    if (!isMobileRef.current || !isActiveRef.current) {
      setIsInputFocused(false);
      return;
    }
    setIsInputFocused((current) => (current === focused ? current : focused));
  }, [debugKeyboard]);

  const handleFlowControl = React.useCallback((paused: boolean) => {
    flowPausedRef.current = paused;
    reportFlowControl(paused, 'viewport-watermark');
    if (!paused && flowPausedBufferRef.current.length > 0) {
      const storeSessionId = sessionId;
      if (storeSessionId) {
        const buffered = flowPausedBufferRef.current;
        flowPausedBufferRef.current = [];
        for (const chunk of buffered) {
          appendToBuffer(storeSessionId, chunk);
        }
      }
    }
  }, [appendToBuffer, reportFlowControl, sessionId]);

  const handleEnsureSizeMatches = React.useCallback((reason: string) => {
    if (!isActiveRef.current) return;
    terminalControllerRef.current?.ensureSizeMatches(reason);
  }, []);

  // 多端同步：用户在本端做交互（点击 / 按键 / 触摸 / 滚轮）时，让 viewport
  // 比对本端 xterm 尺寸与服务端最近广播的 pty-size。不一致就立即重推 resize。
  // 防拉扯逻辑（visibility gate + 服务端广播冷却 + 400ms 节流）在 viewport
  // 内部完成。
  //
  // 监听挂在 viewport 容器上而非 window：
  //  - 多 tab 时只有 active session 的容器在前台收到事件，避免 N 份监听都
  //    跑早退判断。
  //  - 容器外的工具栏 / 侧边栏交互不视为"对终端的操作"，不必触发尺寸比对。
  // wheel 必须包含——触控板滚动只触发 wheel，不会触发 pointer。
  const interactionHostRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!isActive) return;
    const host = interactionHostRef.current;
    if (!host) return;
    const onPointerDown = () => handleEnsureSizeMatches('pointerdown');
    const onKeyDown = () => handleEnsureSizeMatches('keydown');
    const onTouchStart = () => handleEnsureSizeMatches('touchstart');
    const onWheel = () => handleEnsureSizeMatches('wheel');
    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('keydown', onKeyDown);
    host.addEventListener('touchstart', onTouchStart, { passive: true });
    host.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('keydown', onKeyDown);
      host.removeEventListener('touchstart', onTouchStart);
      host.removeEventListener('wheel', onWheel);
    };
  }, [isActive, handleEnsureSizeMatches]);

  const handleTerminalControllerRef = React.useCallback((controller: TerminalController | null) => {
    terminalControllerRef.current = controller;
  }, []);

  const handleMobileKeyPress = React.useCallback(
    (key: 'esc' | 'enter' | 'home' | 'end' | 'ctrl-c' | 'ctrl-d' | 'ctrl-w' | 'ctrl-u') => {
      const sequence = getSequenceForKey(key, activeModifier);
      if (!sequence) {
        return;
      }
      const shouldConsumeModifier = activeModifier !== null;
      handleViewportInput(sequence, {
        skipModifierTransform: true,
        consumeModifier: shouldConsumeModifier,
      });
    },
    [activeModifier, handleViewportInput]
  );

  const handleToolbarTextPress = React.useCallback((sequence: string) => {
    const segments = splitToolbarSequenceSegments(sequence);
    if (segments.length === 0) {
      return;
    }
    const consumeModifier = activeModifier !== null;
    handleViewportInput(decodeToolbarSequence(segments[0]), {
      skipModifierTransform: true,
      consumeModifier,
    });
    for (let i = 1; i < segments.length; i += 1) {
      const segment = segments[i];
      window.setTimeout(() => {
        handleViewportInput(decodeToolbarSequence(segment), {
          skipModifierTransform: true,
        });
      }, TOOLBAR_SEGMENT_DELAY_MS * i);
    }
  }, [activeModifier, handleViewportInput]);

  // 重连抖动修复：auto-recreate / 短线重连过渡期 activeProgram 会被清成 null
  // （clearTerminalSession），随后 connected 事件再写回。若直接用它推导 preset，
  // 桌面工具条 showOnDesktop 会 true→false→true 跳变（max-h-24↔max-h-0 塌陷/撑开），
  // 作为 terminal flex 同级元素挤压高度，触发 ResizeObserver→fit，造成布局抖动。
  // 过渡期沿用上一次稳定的 activeProgram，让 preset/工具条高度保持不变。
  const isConnectionTransition = isConnecting || connectionError !== null;
  const stableActiveProgramRef = React.useRef(detectedActiveProgram);
  if (!isConnectionTransition) {
    stableActiveProgramRef.current = detectedActiveProgram;
  }
  const presetActiveProgram = isConnectionTransition ? stableActiveProgramRef.current : detectedActiveProgram;
  const detectedPreset = React.useMemo(() => detectToolbarPreset(presetActiveProgram, toolbarPresets), [presetActiveProgram, toolbarPresets]);
  const storedPreset = React.useMemo(() => getToolbarPreset(toolbarPresets, toolbarPresetMode), [toolbarPresetMode, toolbarPresets]);
  const renderPresetMode = !isMobile && toolbarPresetMode !== 'auto' && storedPreset.showOnDesktop !== true
    ? 'auto'
    : toolbarPresetMode;
  const effectivePresetId = renderPresetMode === 'auto' ? detectedPreset : renderPresetMode;
  const toolbarPreset = React.useMemo(() => getToolbarPreset(toolbarPresets, effectivePresetId), [effectivePresetId, toolbarPresets]);
  const runtimeToolbarActions = React.useMemo(
    () => toolbarPreset.actions
      .filter((action: { sequence: string }) => action.sequence.trim().length > 0)
      .map((action: { id: string; label: string; sequence: string; doubleTapSequence?: string }, index: number) => ({
        ...action,
        label: getToolbarActionLabel(action, index),
      })),
    [toolbarPreset.actions]
  );
  const activeProgramLabel = React.useMemo(() => normalizeActiveProgram(detectedActiveProgram), [detectedActiveProgram]);
  const presetLabel = toolbarPreset.label;
  const presetModeLabel = React.useMemo(() => {
    if (renderPresetMode !== 'auto') {
      return `Manual preset: ${toolbarPreset.label}`;
    }

    return activeProgramLabel
      ? `Auto preset · ${toolbarPreset.label} (${activeProgramLabel})`
      : 'Auto preset';
  }, [activeProgramLabel, renderPresetMode, toolbarPreset.label]);
  const handlePresetSelect = React.useCallback((mode: ToolbarPresetMode) => {
    setToolbarPresetMode(mode);
  }, []);
  const handleExpandedChange = React.useCallback((nextExpanded: boolean) => {
    setShowExtendedKeyboard(nextExpanded);
  }, []);
  const presetOptions = React.useMemo(
    () => (isMobile ? buildToolbarPresetOptions(toolbarPresets) : buildDesktopToolbarPresetOptions(toolbarPresets)),
    [isMobile, toolbarPresets],
  );

  const xtermTheme = React.useMemo(() => getTerminalTheme(colorTheme), [colorTheme]);

  const terminalSessionKey = React.useMemo(() => {
    // 故意只用前端 sessionId（每个 tab 一个，整个生命周期不变），
    // 不绑后端 terminalSessionId。否则 auto-recreate（后端 session 被 idle 清掉后
    // 重建）会让 key 从 `terminal::abc` → `terminal::pending` → `terminal::xyz`
    // 走两次，TerminalViewport 整个被 unmount/remount，loadingState 回到 'loading'，
    // 用户看到一次"全屏 loading"。
    //
    // 改成前端 sessionId 后，viewport 实例稳定不动，xterm/WebGL 都不需要重建；
    // 后端 session 变更时由 'connected' 事件里的显式 clear() 处理画面同步。
    return `terminal::${sessionId}`;
  }, [sessionId]);

  React.useEffect(() => {
    onStatusChange?.({
      isConnecting,
      isRestarting,
      hasError: !!connectionError,
      sessionId: terminalSessionId,
    });
  }, [isConnecting, isRestarting, connectionError, terminalSessionId, onStatusChange]);

  const quickKeysDisabled = !terminalSessionId || isConnecting || isRestarting;
  const handleViewportTmuxScroll = React.useCallback((direction: 'up' | 'down', lines: number) => {
    if (quickKeysDisabled) {
      return;
    }

    const normalizedLines = Math.max(1, Math.min(Math.floor(lines) || 1, 40));
    handleTmuxScroll(direction, normalizedLines);
  }, [handleTmuxScroll, quickKeysDisabled]);
  React.useEffect(() => {
    if (!isActive || !isMobile) return;
    const controller = terminalControllerRef.current;
    controller?.requestRefresh('resize', {
      resizeDebounceMs: 0,
      skipScrollToBottom: !isViewportKeyboardOpen,
      force: true,
    });
  }, [isActive, isMobile, isViewportKeyboardOpen, viewportKeyboardHeight, sessionId]);

  React.useEffect(() => {
    if (!isActive || !isMobile) return;
    const handleViewportKeyboardChange = (event: Event) => {
      const detail = (event as CustomEvent<{ isOpen?: boolean }>).detail;
      terminalControllerRef.current?.requestRefresh('resize', {
        resizeDebounceMs: 0,
        skipScrollToBottom: detail?.isOpen !== true,
        force: true,
      });
    };
    document.addEventListener('termdock:viewport-keyboard-change', handleViewportKeyboardChange);
    return () => {
      document.removeEventListener('termdock:viewport-keyboard-change', handleViewportKeyboardChange);
    };
  }, [isActive, isMobile, sessionId]);

  // 桌面端工具条的「显隐」只看 preset 是否声明 showOnDesktop，不再绑 isActive。
  // 否则每个非激活 tab 的工具条会被收成 max-h-0，切到该 tab 时 isActive false→true
  // 重新从 0 撑开，重放 150ms 展开动画 + 终端回流，表现为「先消失再冒出来」。
  // 让非激活 slide（已在 Swiper 视图外，用户看不见）保持展开，切进来时直接就是
  // 展开态，同类 tab 间切换不再闪动。交互仍由 isKeyboardInteractive=isActive 控制，
  // 非激活 tab 的按钮照旧禁用，不会误触。
  const isKeyboardVisible = isMobile || toolbarPreset.showOnDesktop === true;
  const isKeyboardInteractive = isActive;

  // The translateY / margin-top formulas are always applied on mobile.
  // They naturally evaluate to 0 when the keyboard is closed (appVh ===
  // appBaseVh), so we don't gate them on isViewportKeyboardOpen.  This
  // avoids a 1-frame race between the CSS-variable rAF (useViewportHeight)
  // and the React-state rAF (useViewportKeyboardState).  Layout depends
  // ONLY on CSS custom properties, not React state.
  const wrapperStyle = isMobile
    ? {
        transform: 'translateY(var(--kb-translate-y, 0px))',
        transition: 'none',
      } as React.CSSProperties
    : undefined;

  const keyboardShrinkStyle = isMobile
    ? {
        marginTop: 'var(--kb-margin-top, 0px)',
        transition: 'none',
      } as React.CSSProperties
    : undefined;

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden" style={wrapperStyle}>
      {showDebug && (
        <DebugPanel
          isMobile={isMobile}
          isInputFocused={isInputFocused}
          isIOS={isIOS}
          isConnecting={isConnecting}
          connectionError={connectionError}
          terminalSessionId={terminalSessionId}
        />
      )}

      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        style={{
          backgroundColor: xtermTheme.background,
          ...keyboardShrinkStyle,
        }}
      >
        <div ref={interactionHostRef} className="h-full w-full box-border">
          <ErrorBoundary
            fallback={
              <div className="flex h-full items-center justify-center bg-background">
                <div className="flex flex-col items-center gap-3 text-center rounded-2xl bg-surface-2 px-6 py-5 shadow-sm">
                  <div className="w-10 h-10 rounded-full bg-destructive/15 flex items-center justify-center">
                    <svg className="w-5 h-5 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                  </div>
                  <span className="text-sm text-muted-foreground">Terminal component failed to load</span>
                </div>
              </div>
            }
          >
            <TerminalViewport
              key={terminalSessionKey}
              ref={handleTerminalControllerRef}
              sessionKey={terminalSessionKey}
              chunks={bufferChunks}
              onInput={handleViewportInput}
              onResize={handleViewportResize}
              onFlowControl={handleFlowControl}
              onTmuxScroll={isTmuxMode ? handleViewportTmuxScroll : undefined}
              tmuxScrollSensitivity={0.38}
              onDoubleTap={isMobile ? () => {
                handleViewportInput('\t', { skipModifierTransform: true });
              } : undefined}
              onInputFocusChange={handleInputFocusChange}
              terminalSettings={effectiveTerminalSettings}
              theme={xtermTheme}
              enableTouchScroll={isMobile}
              autoFocus={!isMobile}
            />
          </ErrorBoundary>
        </div>

        <ConnectionStatus
          connectionError={connectionError}
          isFatalError={isFatalError}
          isRestarting={isRestarting}
          isConnecting={isConnecting}
          onHardRestart={handleHardRestart}
        />

      </div>

      <MobileKeyboard
        visible={isKeyboardVisible}
        interactive={isKeyboardInteractive}
        presentation={isMobile ? 'mobile' : 'desktop-actions'}
        activeModifier={activeModifier}
        lockedModifier={lockedModifier}
        disabled={quickKeysDisabled}
        defaultShowExtended={showExtendedKeyboard}
        presetLabel={presetLabel}
        presetModeLabel={presetModeLabel}
        presetMode={renderPresetMode}
        presetOptions={presetOptions}
        includeAlt={toolbarPreset.includeAlt}
        presetRowLayout={toolbarPreset.rowLayout}
        extraActions={runtimeToolbarActions}
        onKeyPress={handleMobileKeyPress}
        onTextPress={handleToolbarTextPress}
        onModifierToggle={handleModifierToggle}
        onPresetSelect={handlePresetSelect}
        onExpandedChange={handleExpandedChange}
      />
    </div>
  );
};
