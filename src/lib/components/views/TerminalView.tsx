import React from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useTerminalStore } from '../../stores/useTerminalStore';
import type { TerminalStreamEvent, TmuxActionPayload, TmuxLayout } from '../../terminal';
import { TerminalViewport, type TerminalController } from '../terminal/TerminalViewport';
import { FLEXOKI_DARK } from '../../terminal';
import { createTermdockAPI } from '../../terminal/factory';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { MobileKeyboard, getSequenceForKey } from '../terminal/MobileKeyboard';
import { buildToolbarPresetOptions, decodeToolbarSequence, detectToolbarPreset, getToolbarActionLabel, getToolbarPreset, normalizeActiveProgram, sanitizeToolbarPresets, type ToolbarPresetDefinition, type ToolbarPresetMode } from '../terminal/mobileKeyboardPresets';
import { DebugPanel } from '../terminal/DebugPanel';
import { ConnectionStatus } from '../terminal/ConnectionStatus';
import { createDebugLogger } from '../../utils/debug';
import type { TerminalRendererMode } from '../../terminal/renderer';
import { useViewportKeyboardState } from '../../hooks/useViewportKeyboardState';

const TERMINAL_FONT_SIZE = 13;
const MODIFIER_DOUBLE_TAP_WINDOW_MS = 320;
const RESIZE_THROTTLE_MS = 90;
const MOBILE_KEYBOARD_EXPANDED_STORAGE_KEY = 'termdock:mobile-keyboard-expanded';
const MOBILE_KEYBOARD_PRESET_MODE_STORAGE_KEY = 'termdock:mobile-keyboard-preset-mode';

type Modifier = 'ctrl' | 'alt';

const STREAM_OPTIONS = {
  retry: {
    maxRetries: 5,
    initialDelayMs: 1000,
    maxDelayMs: 15000,
  },
  connectionTimeoutMs: 15_000,
};

interface TerminalViewProps {
  sessionId?: string;
  fontFamily?: string;
  fontSize?: number;
  rendererMode?: TerminalRendererMode;
  toolbarPresets?: ToolbarPresetDefinition[];
  isActive?: boolean;
  focusRequestToken?: number;
  onKeyboardVisibilityChange?: (sessionId: string, isOpen: boolean) => void;
  showDebug?: boolean;
  onStatusChange?: (status: { isConnecting: boolean; isRestarting: boolean; hasError: boolean; sessionId: string | null }) => void;
}

export const TerminalView: React.FC<TerminalViewProps> = ({
  sessionId: initialSessionId,
  fontFamily = '"JetBrains Mono NL", "Symbols Nerd Font Mono"',
  fontSize: initialFontSize = TERMINAL_FONT_SIZE,
  rendererMode = 'auto',
  toolbarPresets: configuredToolbarPresets = [],
  isActive = true,
  focusRequestToken = 0,
  onKeyboardVisibilityChange,
  showDebug: externalShowDebug,
  onStatusChange,
}) => {
  // Use external fontSize from props, with local override support for pinch-to-zoom
  const [fontSize, setFontSize] = React.useState(initialFontSize);
  const terminal = React.useMemo(() => createTermdockAPI(), []);
  const debugSession = React.useMemo(() => createDebugLogger('session'), []);
  const debugKeyboard = React.useMemo(() => createDebugLogger('keyboard'), []);

  // Sync with external fontSize changes while allowing local pinch-to-zoom overrides
  React.useEffect(() => {
    setFontSize(initialFontSize);
  }, [initialFontSize]);

  const [sessionId] = React.useState(initialSessionId || uuidv4());
  const [isMobile, setIsMobile] = React.useState(false);
  const [isIOS, setIsIOS] = React.useState(false);
  const [isInputFocused, setIsInputFocused] = React.useState(false);
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

  const [connectionError, setConnectionError] = React.useState<string | null>(null);
  const [isFatalError, setIsFatalError] = React.useState(false);
  const [isRestarting, setIsRestarting] = React.useState(false);
  const [_tmuxLayout, setTmuxLayout] = React.useState<TmuxLayout | null>(null);
  const showDebug = externalShowDebug !== undefined ? externalShowDebug : false;

  // 流清理和活动终端引用
  const streamCleanupRef = React.useRef<(() => void) | null>(null);
  const activeTerminalIdRef = React.useRef<string | null>(null);
  const terminalIdRef = React.useRef<string | null>(null);
  const sessionIdRef = React.useRef<string | null>(null);
  const terminalControllerRef = React.useRef<TerminalController | null>(null);
  const suppressInputUntilRef = React.useRef(0);
  const shouldExitTmuxCopyModeOnInputRef = React.useRef(false);
  const tmuxScrollPendingRef = React.useRef<{ direction: 'up' | 'down'; lines: number } | null>(null);
  const tmuxScrollFlushTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const modifierTapRef = React.useRef<{ modifier: Modifier; timestamp: number } | null>(null);
  const lastFocusRequestTokenRef = React.useRef(0);
  const streamVersionRef = React.useRef(0);
  const resizeStateRef = React.useRef<{
    timerId: number | null;
    pending: { cols: number; rows: number } | null;
    lastSent: { cols: number; rows: number } | null;
  }>({
    timerId: null,
    pending: null,
    lastSent: null,
  });

  const focusTerminalIfActive = React.useCallback(() => {
    if (!isActive) {
      return;
    }
    terminalControllerRef.current?.focus();
  }, [isActive]);

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

  // 统一恢复入口：从后台返回 / BFCache 恢复 / 网络恢复 / 切回当前 session 时调用。
  // 单一职责：清 resize 去重 → fit → 同步刷新纹理图集 → 滚动到底（非 alternate buffer）。
  // 不使用 setTimeout 重试链：rAF 内一次性同步完成，避免与 ResizeObserver / 防抖刷新互相覆盖。
  const recoverActive = React.useCallback((reason: string) => {
    if (!isActive) return;
    debugSession(`[recoverActive] ${reason}`);

    // 清掉 resize 去重，强制下一帧把本地尺寸推给后端 / tmux
    resizeStateRef.current.lastSent = null;
    tmuxSessionResizedRef.current = null;
    skipLayoutResizeRef.current = true;

    const controller = terminalControllerRef.current;
    if (!controller) return;

    // 在浏览器下一帧（容器尺寸已经稳定后）：fit → 立即同步刷新 → 滚到底
    const raf = requestAnimationFrame(() => {
      const c = terminalControllerRef.current;
      if (!c) return;
      c.recoverRenderer();   // WebGL addon 丢失时重建 + 同步刷新
      c.fit();               // 重新 fit 容器
      c.refreshNow();        // 同步立即清纹理 + 重绘所有行
      c.scrollToBottom();    // 滚到底（alternate buffer 内部会自动跳过）
    });
    return () => cancelAnimationFrame(raf);
  }, [isActive, debugSession]);

  // 1) 页面可见性变化（前后台切换）
  React.useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden) {
        recoverActive('visibilitychange');
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [recoverActive]);

  // 2) BFCache 恢复（iOS Safari PWA 从后台回来不会触发 visibilitychange）
  //    online：网络恢复时也强制刷一遍，与 WS 重连联动
  React.useEffect(() => {
    const handlePageShow = (event: PageTransitionEvent) => {
      recoverActive(event.persisted ? 'pageshow:bfcache' : 'pageshow');
    };
    const handleOnline = () => recoverActive('online');
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('online', handleOnline);
    };
  }, [recoverActive]);

  // 3) 切换回当前 session（左右翻页 inactive → active）
  const prevIsActiveRef = React.useRef(isActive);
  React.useEffect(() => {
    const wasInactive = !prevIsActiveRef.current;
    prevIsActiveRef.current = isActive;
    if (!isActive || !wasInactive) return;
    return recoverActive('session-active');
  }, [isActive, recoverActive]);

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
  }, [isActive, isMobile]);

  React.useEffect(() => {
    terminalIdRef.current = terminalSessionId;
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

  React.useEffect(() => {
    const resizeState = resizeStateRef.current;
    resizeState.lastSent = null;
    resizeState.pending = null;
    if (resizeState.timerId !== null) {
      window.clearTimeout(resizeState.timerId);
      resizeState.timerId = null;
    }
  }, [terminalSessionId]);

  React.useEffect(() => {
    return () => {
      const resizeState = resizeStateRef.current;
      if (resizeState.timerId !== null) {
        window.clearTimeout(resizeState.timerId);
        resizeState.timerId = null;
      }
    };
  }, []);

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
    const cleanup = streamCleanupRef.current;
    streamCleanupRef.current = null;
    activeTerminalIdRef.current = null;
    cleanup?.();
  }, []);

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

                if (event.mode !== 'tmux') {
                  setTmuxLayout(null);
                  setSessionCopyMode(storeSessionId, false);
                } else {
                  // 进入/重连 tmux 后强制 resize：单次 rAF，复用 recoverActive 思路
                  resizeStateRef.current.lastSent = null;
                  tmuxSessionResizedRef.current = null;
                  skipLayoutResizeRef.current = true;
                  requestAnimationFrame(() => {
                    const c = terminalControllerRef.current;
                    if (!c) return;
                    c.fit();
                    c.refreshNow();
                    c.scrollToBottom();
                  });
                }

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
                    appendToBuffer(storeSessionId, chunk);
                  });
                  useTerminalStore.getState().setSessionHistory(storeSessionId, []);
                  debugSession(`[Terminal] History restoration complete for ${storeSessionId}`);
                } else {
                  debugSession(`[Terminal] No history to restore for ${storeSessionId}`);
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
                  appendToBuffer(storeSessionId, event.data);
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
                  event.activeProgramSource ?? null
                );
                break;
              }
              case 'cwd': {
                setSessionCwd(storeSessionId, event.cwd ?? null);
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

            setConnectionError(errorMsg);
            setIsFatalError(!!fatal);

            if (fatal) {
              setConnecting(storeSessionId, false);
              disconnectStream();
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
    [appendToBuffer, clearTerminalSession, debugSession, disconnectStream, setConnecting, setSessionActiveProgram, terminal, sessionId]
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
      debugSession(`[ensureSession] Current state from store:`, {
        terminalSessionId: currentState?.terminalSessionId,
        isConnecting: currentState?.isConnecting
      });

      let terminalId = currentState?.terminalSessionId ?? null;
      let shouldCreateNewSession = !terminalId;

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
        if (recheckedState?.terminalSessionId) {
          debugSession(`[ensureSession] Race condition avoided: another instance already created session ${recheckedState.terminalSessionId}`);
          store.setConnecting(sessionId, false);
          terminalId = recheckedState.terminalSessionId;
          shouldCreateNewSession = false;
        } else {
          try {
            const modeForNewSession = currentState?.mode ?? 'shell';
            const tmuxSessionNameForNewSession = currentState?.tmuxSessionName || fallbackTmuxSessionName;
            const session = await terminal.createSession({
              mode: modeForNewSession,
              tmuxSessionName: modeForNewSession === 'tmux' ? tmuxSessionNameForNewSession : undefined,
            });
            debugSession(`[ensureSession] Created new session ${session.sessionId}`);

            if (runId !== currentRunIdRef.current) {
              debugSession(`[ensureSession] Stale run after session creation (runId=${runId}, currentRunId=${currentRunIdRef.current}), closing session`);
              try {
                await terminal.close(session.sessionId);
              } catch { /* ignored */ }
              return;
            }

            store.setTerminalSession(sessionId, session);
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
  }, [sessionId, startStream, disconnectStream, terminal, debugSession]);

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
      });
      setTerminalSession(sessionId, {
        ...session,
        mode: session.mode ?? sessionMode,
        tmuxSessionName: session.tmuxSessionName ?? (sessionMode === 'tmux' ? preferredTmuxSessionName : null),
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
      if (!isActive) {
        return;
      }

      if (!data) {
        return;
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
      if (!terminalId) return;

      const sendPayload = async () => {
        try {
          if (isTmuxMode && shouldExitTmuxCopyModeOnInputRef.current && terminal.tmuxAction) {
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
    [activeModifier, focusTerminalIfActive, isActive, isTmuxMode, lockedModifier, terminal]
  );

  const flushPendingResize = React.useCallback(() => {
    const resizeState = resizeStateRef.current;
    resizeState.timerId = null;

    const pending = resizeState.pending;
    if (!pending) {
      return;
    }

    const terminalId = terminalIdRef.current;
    if (!terminalId) {
      return;
    }

    const lastSent = resizeState.lastSent;
    if (lastSent && lastSent.cols === pending.cols && lastSent.rows === pending.rows) {
      resizeState.pending = null;
      debugKeyboard('resize skipped (duplicate)', pending);
      return;
    }

    resizeState.lastSent = pending;
    resizeState.pending = null;

    debugKeyboard('resize flush', pending);

    void terminal.resize({ sessionId: terminalId, cols: pending.cols, rows: pending.rows }).catch(() => {

    });
  }, [terminal, debugKeyboard]);

  const queueViewportResize = React.useCallback((cols: number, rows: number) => {
    const resizeState = resizeStateRef.current;
    const pending = resizeState.pending;
    if (pending && pending.cols === cols && pending.rows === rows) {
      return;
    }

    resizeState.pending = { cols, rows };

    debugKeyboard('resize queued', {
      cols,
      rows,
      immediate: resizeState.lastSent === null,
      hasTimer: resizeState.timerId !== null,
    });

    if (resizeState.lastSent === null) {
      flushPendingResize();
      return;
    }

    if (resizeState.timerId !== null) {
      window.clearTimeout(resizeState.timerId);
    }

    resizeState.timerId = window.setTimeout(() => {
      flushPendingResize();
    }, RESIZE_THROTTLE_MS);
  }, [flushPendingResize, debugKeyboard]);

  const handleViewportResize = React.useCallback(
    (cols: number, rows: number) => {
      queueViewportResize(cols, rows);
    },
    [queueViewportResize]
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
        }
      }
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : 'Failed to execute tmux action');
    }
  }, [sessionId, setTerminalSession, terminal]);

  const tmuxSessionResizedRef = React.useRef<string | null>(null);
  const skipLayoutResizeRef = React.useRef(false); // 重连时跳过 layout resize，优先用本地尺寸
  React.useEffect(() => {
    if (!_tmuxLayout) return;
    const layoutSessionId = _tmuxLayout.sessionId;
    if (tmuxSessionResizedRef.current === layoutSessionId) return;
    // 重连后跳过 layout 尺寸，因为那是其他客户端的窗口大小
    if (skipLayoutResizeRef.current) {
      skipLayoutResizeRef.current = false;
      return;
    }
    tmuxSessionResizedRef.current = layoutSessionId;
    const activeWindow = _tmuxLayout.windows.find((w) => w.id === _tmuxLayout.activeWindowId);
    const activePane = activeWindow?.panes.find((p) => p.id === _tmuxLayout.activePaneId);
    if (!activePane) return;
    handleViewportResize(activePane.width, activePane.height);
  }, [_tmuxLayout, handleViewportResize]);

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
        focusTerminalIfActive();
        return;
      }

      if (isDoubleTap) {
        setLockedModifier(modifier);
        setActiveModifier(modifier);
        focusTerminalIfActive();
        return;
      }

      if (lockedModifier !== null && lockedModifier !== modifier) {
        setLockedModifier(null);
      }

      setActiveModifier((current) => (current === modifier ? null : modifier));
      focusTerminalIfActive();
    },
    [focusTerminalIfActive, lockedModifier]
  );

  const handleMobileToolbarPressStart = React.useCallback(() => {
    focusTerminalIfActive();
  }, [focusTerminalIfActive]);

  const handleInputFocusChange = React.useCallback((focused: boolean) => {
    debugKeyboard('input focus changed', {
      focused,
      isActive,
      isMobile,
    });
    if (!isMobile || !isActive) {
      setIsInputFocused(false);
      return;
    }
    setIsInputFocused((current) => (current === focused ? current : focused));
  }, [isActive, isMobile, debugKeyboard]);

  const handleMobileKeyPress = React.useCallback(
    (key: 'esc' | 'tab' | 'enter' | 'home' | 'end' | 'ctrl-c' | 'ctrl-d' | 'arrow-up' | 'arrow-down' | 'arrow-left' | 'arrow-right') => {
      const sequence = getSequenceForKey(key, activeModifier);
      if (!sequence) {
        return;
      }
      const shouldConsumeModifier = activeModifier !== null;
      handleViewportInput(sequence, {
        skipModifierTransform: true,
        consumeModifier: shouldConsumeModifier,
      });
      focusTerminalIfActive();
    },
    [activeModifier, focusTerminalIfActive, handleViewportInput]
  );

  const handleToolbarTextPress = React.useCallback((sequence: string) => {
    handleViewportInput(decodeToolbarSequence(sequence), {
      skipModifierTransform: true,
      consumeModifier: activeModifier !== null,
    });
    focusTerminalIfActive();
  }, [activeModifier, focusTerminalIfActive, handleViewportInput]);

  const detectedPreset = React.useMemo(() => detectToolbarPreset(detectedActiveProgram, toolbarPresets), [detectedActiveProgram, toolbarPresets]);
  const effectivePresetId = toolbarPresetMode === 'auto' ? detectedPreset : toolbarPresetMode;
  const toolbarPreset = React.useMemo(() => getToolbarPreset(toolbarPresets, effectivePresetId), [effectivePresetId, toolbarPresets]);
  const runtimeToolbarActions = React.useMemo(
    () => toolbarPreset.actions
      .filter((action: { sequence: string }) => action.sequence.trim().length > 0)
      .map((action: { id: string; label: string; sequence: string }, index: number) => ({
        ...action,
        label: getToolbarActionLabel(action, index),
      })),
    [toolbarPreset.actions]
  );
  const activeProgramLabel = React.useMemo(() => normalizeActiveProgram(detectedActiveProgram), [detectedActiveProgram]);
  const presetLabel = React.useMemo(() => {
    if (toolbarPresetMode !== 'auto') {
      return toolbarPreset.label;
    }

    return activeProgramLabel ? `Auto:${toolbarPreset.label}` : 'Auto';
  }, [activeProgramLabel, toolbarPreset.label, toolbarPresetMode]);
  const presetModeLabel = React.useMemo(() => {
    if (toolbarPresetMode !== 'auto') {
      return `Manual preset: ${toolbarPreset.label}`;
    }

    return activeProgramLabel
      ? `Auto preset from ${activeProgramLabel}`
      : 'Auto preset';
  }, [activeProgramLabel, toolbarPreset.label, toolbarPresetMode]);
  const handlePresetSelect = React.useCallback((mode: ToolbarPresetMode) => {
    setToolbarPresetMode(mode);
  }, []);
  const handleExpandedChange = React.useCallback((nextExpanded: boolean) => {
    setShowExtendedKeyboard(nextExpanded);
  }, []);
  const presetOptions = React.useMemo(() => buildToolbarPresetOptions(toolbarPresets), [toolbarPresets]);

  const xtermTheme = FLEXOKI_DARK;

  const terminalSessionKey = React.useMemo(() => {
    const terminalPart = terminalSessionId ?? 'pending';
    return `terminal::${terminalPart}`;
  }, [terminalSessionId]);

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
  const isKeyboardVisible = isActive && isMobile && isViewportKeyboardOpen;

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
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
        }}
      >
        <div className="h-full w-full box-border">
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
              ref={(controller) => {
                terminalControllerRef.current = controller;
              }}
              sessionKey={terminalSessionKey}
              chunks={bufferChunks}
              onInput={handleViewportInput}
              onResize={handleViewportResize}
              onTmuxScroll={isTmuxMode ? handleViewportTmuxScroll : undefined}
              tmuxScrollSensitivity={0.38}
              onDoubleTap={isMobile ? () => {
                handleViewportInput('\t', { skipModifierTransform: true });
              } : undefined}
              onInputFocusChange={handleInputFocusChange}
              rendererMode={rendererMode}
              theme={xtermTheme}
              fontFamily={fontFamily}
              fontSize={fontSize}
              enableTouchScroll={isMobile}
              autoFocus={!isMobile && isActive}
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
        activeModifier={activeModifier}
        lockedModifier={lockedModifier}
        disabled={quickKeysDisabled}
        defaultShowExtended={showExtendedKeyboard}
        presetLabel={presetLabel}
        presetModeLabel={presetModeLabel}
        presetMode={toolbarPresetMode}
        presetOptions={presetOptions}
        includeAlt={toolbarPreset.includeAlt}
        presetRowLayout={toolbarPreset.rowLayout}
        extraActions={runtimeToolbarActions}
        onKeyPress={handleMobileKeyPress}
        onTextPress={handleToolbarTextPress}
        onModifierToggle={handleModifierToggle}
        onPresetSelect={handlePresetSelect}
        onExpandedChange={handleExpandedChange}
        onPressStart={handleMobileToolbarPressStart}
      />
    </div>
  );
};
