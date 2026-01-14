import React from 'react';
import { RiAlertLine, RiArrowDownLine, RiArrowGoBackLine, RiArrowLeftLine, RiArrowRightLine, RiArrowUpLine, RiCheckboxCircleLine, RiCircleLine, RiCloseLine, RiCommandLine, RiDeleteBinLine, RiRestartLine } from '@remixicon/react';
import { useTerminalStore } from '../../stores/useTerminalStore';
import type { TerminalStreamEvent } from '../../terminal';
import { TerminalViewport, type TerminalController } from '../terminal/TerminalViewport';
import { convertThemeToXterm, getDefaultTheme } from '../../terminal';
import { createWebTerminalAPI } from '../../terminal/factory';
import { ErrorBoundary } from '../ui/ErrorBoundary';

const TERMINAL_FONT_SIZE = 13;

type Modifier = 'ctrl' | 'cmd';
type MobileKey =
  | 'esc'
  | 'tab'
  | 'enter'
  | 'arrow-up'
  | 'arrow-down'
  | 'arrow-left'
  | 'arrow-right';

const BASE_KEY_SEQUENCES: Record<MobileKey, string> = {
  esc: '\u001b',
  tab: '\t',
  enter: '\r',
  'arrow-up': '\u001b[A',
  'arrow-down': '\u001b[B',
  'arrow-left': '\u001b[D',
  'arrow-right': '\u001b[C',
};

const MODIFIER_ARROW_SUFFIX: Record<Modifier, string> = {
  ctrl: '5',
  cmd: '3',
};

const STREAM_OPTIONS = {
  retry: {
    maxRetries: 5,
    initialDelayMs: 1000,
    maxDelayMs: 15000,
  },
  connectionTimeoutMs: 15_000,
};

const getSequenceForKey = (key: MobileKey, modifier: Modifier | null): string | null => {
  if (modifier) {
    switch (key) {
      case 'arrow-up':
        return `\u001b[1;${MODIFIER_ARROW_SUFFIX[modifier]}A`;
      case 'arrow-down':
        return `\u001b[1;${MODIFIER_ARROW_SUFFIX[modifier]}B`;
      case 'arrow-right':
        return `\u001b[1;${MODIFIER_ARROW_SUFFIX[modifier]}C`;
      case 'arrow-left':
        return `\u001b[1;${MODIFIER_ARROW_SUFFIX[modifier]}D`;
      default:
        break;
    }
  }

  return BASE_KEY_SEQUENCES[key] ?? null;
};

interface TerminalViewProps {
  cwd?: string;
  theme?: 'dark' | 'light' | 'solarized' | 'dracula' | 'nord';
  fontFamily?: string;
  fontSize?: number;
}

export const TerminalView: React.FC<TerminalViewProps> = ({
  cwd: initialCwd,
  theme: themeName = 'dark',
  fontFamily = 'Menlo, Monaco, Consolas, monospace',
  fontSize = TERMINAL_FONT_SIZE,
}) => {
  const terminal = React.useMemo(() => createWebTerminalAPI(), []);

  const [currentTheme, setCurrentTheme] = React.useState(getDefaultTheme);
  const [cwd] = React.useState(initialCwd || process.cwd());
  const [isMobile, setIsMobile] = React.useState(false);

  const terminalStore = useTerminalStore();
  const terminalSessions = terminalStore.sessions;
  const setTerminalSession = terminalStore.setTerminalSession;
  const setConnecting = terminalStore.setConnecting;
  const appendToBuffer = terminalStore.appendToBuffer;
  const clearTerminalSession = terminalStore.clearTerminalSession;
  const removeTerminalSession = terminalStore.removeTerminalSession;
  const clearBuffer = terminalStore.clearBuffer;

  const terminalState = React.useMemo(() => {
    if (!cwd) return undefined;
    return terminalSessions.get(cwd);
  }, [terminalSessions, cwd]);

  const terminalSessionRef = terminalState?.terminalSessionId ?? null;
  const bufferChunks = terminalState?.bufferChunks ?? [];
  const bufferLength = terminalState?.bufferLength ?? 0;
  const isConnecting = terminalState?.isConnecting ?? false;
  const terminalSessionId = terminalSessionRef;

  const [connectionError, setConnectionError] = React.useState<string | null>(null);
  const [isFatalError, setIsFatalError] = React.useState(false);
  const [activeModifier, setActiveModifier] = React.useState<Modifier | null>(null);
  const [isRestarting, setIsRestarting] = React.useState(false);
  const [keyboardHeight, setKeyboardHeight] = React.useState(0);
  const [showDebug, setShowDebug] = React.useState(false);

  // 软键盘状态管理（防抖逻辑用 ref，渲染用 state）
  const keyboardStateRef = React.useRef({
    debounceTimer: null as NodeJS.Timeout | null,
    isKeyboardVisible: false,
  });

  // 流清理和活动终端引用
  const streamCleanupRef = React.useRef<(() => void) | null>(null);
  const activeTerminalIdRef = React.useRef<string | null>(null);
  const terminalIdRef = React.useRef<string | null>(null);
  const directoryRef = React.useRef<string | null>(null);
  const terminalControllerRef = React.useRef<TerminalController | null>(null);

  const isIOS = React.useMemo(() => {
    if (typeof window === 'undefined') return false;
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || 
           (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }, []);

  // iOS 软键盘上方导航条高度
  const IOS_KEYBOARD_ACCESSORY_HEIGHT = 44;

  // 键盘检测配置
  const KEYBOARD_MIN_HEIGHT = 100; // 最小键盘高度阈值
  const KEYBOARD_DEBOUNCE_MS = 300; // 键盘关闭延迟确认时间

  React.useEffect(() => {
    if (!isMobile || typeof window === 'undefined') return;

    const state = keyboardStateRef.current;
    
    const updateKeyboardState = (visible: boolean, height: number) => {
      // 清除之前的防抖定时器
      if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
        state.debounceTimer = null;
      }

      if (visible) {
        // 软键盘升起：立即更新
        state.isKeyboardVisible = true;
        setKeyboardHeight(height);
      } else {
        // 软键盘关闭：延迟确认后再更新
        state.debounceTimer = setTimeout(() => {
          const viewport = window.visualViewport;
          if (viewport) {
            const currentWindowHeight = window.innerHeight;
            const currentKeyboardH = currentWindowHeight - viewport.height;
            // 使用更严格的阈值判断
            if (currentKeyboardH < KEYBOARD_MIN_HEIGHT) {
              state.isKeyboardVisible = false;
              setKeyboardHeight(0);
            }
          }
          state.debounceTimer = null;
        }, KEYBOARD_DEBOUNCE_MS);
      }
    };

    const handleVisualViewportChange = () => {
      if (!window.visualViewport) return;

      const viewport = window.visualViewport;
      const windowHeight = window.innerHeight;
      const keyboardH = windowHeight - viewport.height;

      // 使用可配置的阈值
      if (keyboardH >= KEYBOARD_MIN_HEIGHT) {
        updateKeyboardState(true, keyboardH);
      } else if (keyboardH < KEYBOARD_MIN_HEIGHT && state.isKeyboardVisible) {
        updateKeyboardState(false, 0);
      }
    };

    // 初始检测
    handleVisualViewportChange();

    window.visualViewport?.addEventListener('resize', handleVisualViewportChange);
    window.visualViewport?.addEventListener('scroll', handleVisualViewportChange);

    return () => {
      window.visualViewport?.removeEventListener('resize', handleVisualViewportChange);
      window.visualViewport?.removeEventListener('scroll', handleVisualViewportChange);
      if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
      }
    };
  }, [isMobile]);

  React.useEffect(() => {
    terminalIdRef.current = terminalSessionId;
  }, [terminalSessionId]);

  React.useEffect(() => {
    directoryRef.current = cwd;
  }, [cwd]);

  React.useEffect(() => {
    if (!isMobile && activeModifier !== null) {
      setActiveModifier(null);
    }
  }, [isMobile, activeModifier]);

  React.useEffect(() => {
    if (!terminalSessionId && activeModifier !== null) {
      setActiveModifier(null);
    }
  }, [terminalSessionId, activeModifier]);

  // 改进的移动端检测：结合触屏能力和屏幕宽度
  React.useEffect(() => {
    const checkIsMobile = () => {
      if (typeof window === 'undefined') return false;
      // 检测触屏设备
      const hasTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
      // 结合屏幕宽度判断
      const isNarrow = window.innerWidth < 768;
      return hasTouch && isNarrow;
    };
    
    // 初始化检测
    setIsMobile(checkIsMobile());
    
    // 监听窗口大小变化
    const handleResize = () => {
      setIsMobile(checkIsMobile());
    };
    
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  React.useEffect(() => {
    const themes = {
      dark: 0,
      light: 1,
      solarized: 2,
      dracula: 3,
      nord: 4,
    };
    const themeIndex = themes[themeName] ?? 0;
    import('../../terminal/theme').then(({ THEMES }) => {
      setCurrentTheme(THEMES[themeIndex]);
    });
  }, [themeName]);

  const disconnectStream = React.useCallback(() => {
    streamCleanupRef.current?.();
    streamCleanupRef.current = null;
    activeTerminalIdRef.current = null;
  }, []);

  const startStream = React.useCallback(
    (terminalId: string) => {
      if (activeTerminalIdRef.current === terminalId) {
        return;
      }

      disconnectStream();

      const subscription = terminal.connect(
        terminalId,
        {
          onEvent: (event: TerminalStreamEvent) => {
            const directory = directoryRef.current;
            if (!directory) return;

            switch (event.type) {
              case 'connected': {
                if (event.runtime || event.ptyBackend) {
                  console.log(
                    `[Terminal] connected runtime=${event.runtime ?? 'unknown'} pty=${event.ptyBackend ?? 'unknown'}`
                  );
                }
                setConnecting(directory, false);
                setConnectionError(null);
                setIsFatalError(false);
                terminalControllerRef.current?.focus();
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
                  appendToBuffer(directory, event.data);
                }
                break;
              }
              case 'exit': {
                const exitCode =
                  typeof event.exitCode === 'number' ? event.exitCode : null;
                const signal = typeof event.signal === 'number' ? event.signal : null;
                appendToBuffer(
                  directory,
                  `\r\n[Process exited${
                    exitCode !== null ? ` with code ${exitCode}` : ''
                  }${signal !== null ? ` (signal ${signal})` : ''}]\r\n`
                );
                clearTerminalSession(directory);
                setConnecting(directory, false);
                setConnectionError('Terminal session ended');
                setIsFatalError(false);
                disconnectStream();
                break;
              }
            }
          },
          onError: (error, fatal) => {
            const directory = directoryRef.current;
            if (!directory) return;

            const errorMsg = fatal
              ? `Connection failed: ${error.message}`
              : error.message || 'Terminal stream connection error';
            console.error(`[Terminal] Stream error (fatal=${fatal}):`, errorMsg);

            setConnectionError(errorMsg);
            setIsFatalError(!!fatal);

            if (fatal) {
              setConnecting(directory, false);
              disconnectStream();
            }
          },
        },
        STREAM_OPTIONS
      );

      streamCleanupRef.current = () => {
        subscription.close();
        activeTerminalIdRef.current = null;
      };
      activeTerminalIdRef.current = terminalId;
    },
    [appendToBuffer, clearTerminalSession, disconnectStream, removeTerminalSession, setConnecting, terminal]
  );

  const hasInitializedRef = React.useRef(false);

  React.useEffect(() => {
    if (!cwd) {
      setConnectionError('No working directory available for terminal.');
      disconnectStream();
      return;
    }

    // 如果cwd改变了，允许重新初始化
    if (directoryRef.current !== cwd) {
      console.log(`[useEffect] cwd changed from ${directoryRef.current} to ${cwd}, allowing reinitialization`);
      hasInitializedRef.current = false;
    }
    
    // 防止重复初始化
    if (hasInitializedRef.current && directoryRef.current === cwd) {
      console.log(`[useEffect] Already initialized for cwd=${cwd}, skipping`);
      return;
    }

    console.log(`[useEffect] Running ensureSession for cwd=${cwd}, hasInitialized=${hasInitializedRef.current}`);
    hasInitializedRef.current = true;

    let cancelled = false;

    const ensureSession = async () => {
      const directory = cwd;
      console.log(`[ensureSession] Starting for directory=${directory}, directoryRef.current=${directoryRef.current}`);
      if (!directoryRef.current || directoryRef.current !== directory) {
        console.log(`[ensureSession] Directory mismatch, skipping`);
        return;
      }
      
      // 直接从store获取最新状态和函数，避免闭圈问题
      const store = useTerminalStore.getState();
      const currentState = store.getTerminalSession(directory);
      console.log(`[ensureSession] Current state from store:`, { 
        terminalSessionId: currentState?.terminalSessionId,
        isConnecting: currentState?.isConnecting 
      });

      let terminalId = currentState?.terminalSessionId ?? null;
      let shouldCreateNewSession = !terminalId;

      // 如果存在会话ID，检查会话是否健康
      if (terminalId && terminal.checkHealth) {
        console.log(`[ensureSession] Checking health of existing session ${terminalId}`);
        try {
          const health = await terminal.checkHealth(terminalId);
          console.log(`[ensureSession] Health check result:`, health);
          if (!health.healthy) {
            console.log(`[ensureSession] Session ${terminalId} is NOT healthy (healthy=${health.healthy}), will create new session`);
            console.log(`[ensureSession] Health check details:`, health);
            shouldCreateNewSession = true;
            // 清理不健康的会话
            store.clearTerminalSession(directory);
            console.log(`[ensureSession] Cleared unhealthy session from store`);
          } else {
            console.log(`[ensureSession] Session ${terminalId} is healthy, reusing it, cwd=${health.cwd}, clients=${health.clients}, lastActivity=${Date.now() - (health.lastActivity || 0)}ms ago`);
            console.log(`[ensureSession] Setting terminalIdRef to ${terminalId} and starting stream`);
            terminalIdRef.current = terminalId;
            startStream(terminalId);
            console.log(`[ensureSession] Successfully reused healthy session ${terminalId}, returning early`);
            return;
          }
        } catch (error) {
          console.warn(`[ensureSession] Failed to check health of session ${terminalId}:`, error);
          console.warn(`[ensureSession] Health check API call failed, proceeding as if session might be unhealthy`);
          // 健康检查失败，保守起见认为会话可能不健康，但先尝试连接
          // 如果连接失败，会在流连接错误处理中处理
        }
      }

      // 需要创建新会话（要么没有会话ID，要么会话不健康）
      console.log(`[ensureSession] Decision: shouldCreateNewSession=${shouldCreateNewSession}, terminalId=${terminalId}`);
      if (shouldCreateNewSession) {
        console.log(`[ensureSession] Creating new session, shouldCreateNewSession=${shouldCreateNewSession}, cancelled=${cancelled}`);
        setConnectionError(null);
        setIsFatalError(false);
        store.setConnecting(directory, true);
        
        // 重新检查store，防止竞争条件：其他实例可能已经创建了会话
        const currentStore = useTerminalStore.getState();
        const recheckedState = currentStore.getTerminalSession(directory);
        if (recheckedState?.terminalSessionId) {
          console.log(`[ensureSession] Race condition avoided: another instance already created session ${recheckedState.terminalSessionId}`);
          store.setConnecting(directory, false); // 重置连接状态
          terminalId = recheckedState.terminalSessionId;
          shouldCreateNewSession = false;
          // 继续执行流程，使用现有会话
        } else {
          // 继续创建新会话
          try {
          const session = await terminal.createSession({
            cwd: directory,
          });
          console.log(`[ensureSession] Created new session ${session.sessionId}, cwd=${directory}`);
          if (cancelled) {
            console.log(`[ensureSession] Cancelled, closing new session`);
            try {
              await terminal.close(session.sessionId);
            } catch { /* ignored */ }
            return;
          }
          store.setTerminalSession(directory, session);
          console.log(`[ensureSession] Updated store with new session ${session.sessionId}`);
          terminalId = session.sessionId;
        } catch (error) {
          if (!cancelled) {
            setConnectionError(
              error instanceof Error
                ? error.message
                : 'Failed to start terminal session'
            );
            setIsFatalError(true);
            store.setConnecting(directory, false);
          }
          return;
        }
      }
    }

      if (!terminalId || cancelled) {
        console.log(`[ensureSession] No terminalId or cancelled, terminalId=${terminalId}, cancelled=${cancelled}`);
        return;
      }

      console.log(`[ensureSession] Starting stream for session ${terminalId}`);
      terminalIdRef.current = terminalId;
      startStream(terminalId);
      console.log(`[ensureSession] ensureSession completed for directory=${directory}, terminalId=${terminalId}`);
    };

    void ensureSession();

    return () => {
      cancelled = true;
      terminalIdRef.current = null;
      disconnectStream();
    };
  }, [cwd, startStream, disconnectStream, terminal]);

  const handleRestart = React.useCallback(async () => {
    if (!cwd) return;
    if (isRestarting) return;

    setIsRestarting(true);
    setConnectionError(null);
    setIsFatalError(false);
    disconnectStream();

    const currentTerminalId = terminalIdRef.current;

    try {
      if (terminal.restartSession && currentTerminalId) {
        const newSession = await terminal.restartSession(currentTerminalId, {
          cwd,
        });
        setTerminalSession(cwd, newSession);
        terminalIdRef.current = newSession.sessionId;
        startStream(newSession.sessionId);
      } else {
        if (currentTerminalId) {
          try {
            await terminal.close(currentTerminalId);
          } catch { /* ignored */ }
        }
        removeTerminalSession(cwd);
      }
    } catch (error) {
      setConnectionError(
        error instanceof Error ? error.message : 'Failed to restart terminal'
      );
      setIsFatalError(true);
    } finally {
      setIsRestarting(false);
    }
  }, [cwd, isRestarting, disconnectStream, terminal, setTerminalSession, startStream, removeTerminalSession]);

  const handleHardRestart = React.useCallback(async () => {
    if (!cwd) return;
    if (isRestarting) return;

    setIsRestarting(true);
    setConnectionError(null);
    setIsFatalError(false);
    disconnectStream();

    try {
      if (terminal.forceKill) {
        await terminal.forceKill({ cwd });
      }
    } catch { /* ignored */ }

    removeTerminalSession(cwd);
    clearBuffer(cwd);
    terminalControllerRef.current?.clear();

    await new Promise(r => setTimeout(r, 100));

    try {
      setConnecting(cwd, true);
      const session = await terminal.createSession({
        cwd,
      });
      setTerminalSession(cwd, session);
      terminalIdRef.current = session.sessionId;
      startStream(session.sessionId);
    } catch (error) {
      setConnectionError(
        error instanceof Error ? error.message : 'Failed to create terminal'
      );
      setIsFatalError(true);
      setConnecting(cwd, false);
    } finally {
      setIsRestarting(false);
    }
  }, [cwd, isRestarting, disconnectStream, terminal, removeTerminalSession, clearBuffer, setConnecting, setTerminalSession, startStream]);

  const handleClear = React.useCallback(() => {
    if (!cwd) return;
    clearBuffer(cwd);
    terminalControllerRef.current?.clear();
    terminalControllerRef.current?.focus();

    const terminalId = terminalIdRef.current;
    if (terminalId) {
      void terminal.sendInput(terminalId, '\u000c').catch((error) => {
        setConnectionError(error instanceof Error ? error.message : 'Failed to refresh prompt');
      });
    }
  }, [clearBuffer, cwd, terminal]);

  const handleViewportInput = React.useCallback(
    (data: string) => {
      if (!data) {
        return;
      }

      let payload = data;
      let modifierConsumed = false;

      if (activeModifier && data.length > 0) {
        const firstChar = data[0];
        if (firstChar.length === 1 && /[a-zA-Z]/.test(firstChar)) {
          const upper = firstChar.toUpperCase();
          if (activeModifier === 'ctrl' || activeModifier === 'cmd') {
            payload = String.fromCharCode(upper.charCodeAt(0) & 0b11111);
            modifierConsumed = true;
          }
        }

        if (!modifierConsumed) {
          modifierConsumed = true;
        }
      }

      const terminalId = terminalIdRef.current;
      if (!terminalId) return;

      void terminal.sendInput(terminalId, payload).catch((error) => {
        setConnectionError(error instanceof Error ? error.message : 'Failed to send input');
      });

      if (modifierConsumed) {
        setActiveModifier(null);
        terminalControllerRef.current?.focus();
      }
    },
    [activeModifier, terminal]
  );

  const handleViewportResize = React.useCallback(
    (cols: number, rows: number) => {
      const terminalId = terminalIdRef.current;
      if (!terminalId) return;
      void terminal.resize({ sessionId: terminalId, cols, rows }).catch(() => {

      });
    },
    [terminal]
  );

  const handleModifierToggle = React.useCallback(
    (modifier: Modifier) => {
      setActiveModifier((current) => (current === modifier ? null : modifier));
      terminalControllerRef.current?.focus();
    },
    []
  );

  const handleMobileKeyPress = React.useCallback(
    (key: MobileKey) => {
      const sequence = getSequenceForKey(key, activeModifier);
      if (!sequence) {
        return;
      }
      handleViewportInput(sequence);
      setActiveModifier(null);
      terminalControllerRef.current?.focus();
    },
    [activeModifier, handleViewportInput]
  );

  const xtermTheme = React.useMemo(() => convertThemeToXterm(currentTheme), [currentTheme]);

  const terminalSessionKey = React.useMemo(() => {
    const directoryPart = cwd ?? 'no-dir';
    const terminalPart = terminalSessionId ?? 'pending';
    return `${directoryPart}::${terminalPart}`;
  }, [cwd, terminalSessionId]);

  const isReconnecting = connectionError?.includes('Reconnecting');

  const statusIcon = connectionError
    ? isReconnecting
      ? <RiAlertLine size={20} className="text-amber-400" />
      : <RiCloseLine size={20} className="text-red-500" />
    : terminalSessionId && !isConnecting && !isRestarting
      ? <RiCheckboxCircleLine size={20} className="text-emerald-400" />
      : <RiCircleLine size={20} className="text-muted-foreground animate-pulse" />;

  if (!cwd) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
        No working directory available for terminal
      </div>
    );
  }

  const quickKeysDisabled = !terminalSessionId || isConnecting || isRestarting;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="px-3 py-2 text-xs bg-background border-b border-border">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <span className="truncate font-mono text-foreground/90">{cwd}</span>
          </div>
          <div className="flex items-center gap-2">
            {statusIcon}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowDebug(prev => !prev);
              }}
              className={`px-2 py-1 text-xs border rounded ${showDebug ? 'bg-blue-500 text-white' : 'hover:bg-surface-elevated'}`}
            >
              {showDebug ? 'DEBUG ON' : 'DEBUG'}
            </button>
            <button
              type="button"
              onClick={handleClear}
              disabled={!bufferLength}
              title="Clear output"
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <RiDeleteBinLine size={16} className="inline mr-1" />
              Clear
            </button>
            <button
              type="button"
              onClick={handleRestart}
              disabled={isRestarting}
              title="Restart terminal session"
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <RiRestartLine size={16} className={`inline mr-1 ${(isConnecting || isRestarting) ? 'animate-spin' : ''}`} />
              Restart
            </button>
          </div>
        </div>
      </div>

      {/* 调试面板 - 点击3次状态图标或DEBUG按钮显示 */}
      {showDebug && (
        <div className="px-3 py-2 bg-blue-900/90 text-white text-xs border-b border-blue-700">
          <div className="font-bold mb-2">🔧 Debug Info</div>
          <div className="grid grid-cols-2 gap-1 font-mono">
            <div>isMobile: <span className={isMobile ? 'text-green-400' : 'text-red-400'}>{String(isMobile)}</span></div>
            <div>touchPoints: {navigator.maxTouchPoints}</div>
            <div>innerWidth: {typeof window !== 'undefined' ? window.innerWidth : 'N/A'}</div>
            <div>innerHeight: {typeof window !== 'undefined' ? window.innerHeight : 'N/A'}</div>
            <div>viewportH: {typeof window !== 'undefined' && window.visualViewport ? Math.round(window.visualViewport.height) : 'N/A'}</div>
            <div>keyboardH: {keyboardHeight}px</div>
            <div>connecting: <span className={isConnecting ? 'text-yellow-400' : 'text-green-400'}>{String(isConnecting)}</span></div>
            <div>sessionId: <span className={terminalSessionId ? 'text-green-400' : 'text-red-400'}>{terminalSessionId ? '✓' : '✗'}</span></div>
            <div>error: <span className={connectionError ? 'text-red-400' : 'text-green-400'}>{connectionError ? 'Yes' : 'No'}</span></div>
            <div>isIOS: <span className={isIOS ? 'text-yellow-400' : 'text-green-400'}>{String(isIOS)}</span></div>
          </div>
          <div className="mt-2 pt-2 border-t border-blue-700">
            <div>💡 Tip: 连续点击上方状态栏3次可切换调试面板</div>
          </div>
        </div>
      )}

      <div
        className="relative flex-1 overflow-hidden"
        style={{ backgroundColor: xtermTheme.background }}
      >
        <div
          className="h-full w-full box-border px-3 pt-3"
          style={{
            height: isMobile && keyboardHeight > 0
              ? `calc(100% - ${keyboardHeight}px)`
              : undefined,
            paddingBottom: isMobile && keyboardHeight > 0
              ? '16px'
              : '16px',
          }}
        >
          <ErrorBoundary
            fallback={
              <div className="flex h-full items-center justify-center">
                <div className="flex flex-col items-center gap-3 text-center">
                  <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
                    <svg className="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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
              theme={xtermTheme}
              fontFamily={fontFamily}
              fontSize={fontSize}
              enableTouchScroll={isMobile}
            />
          </ErrorBoundary>
        </div>
        {connectionError && (
          <div className="absolute inset-x-0 bottom-0 bg-red-500/90 px-3 py-2 text-xs text-white flex items-center justify-between gap-2">
            <span>{connectionError}</span>
            {isFatalError && (
              <button
                type="button"
                onClick={handleHardRestart}
                disabled={isRestarting}
                title="Force kill and create fresh session"
                className="h-6 px-2 py-0 text-xs bg-white/20 hover:bg-white/30 rounded disabled:opacity-50"
              >
                Hard Restart
              </button>
            )}
          </div>
        )}
      </div>

      {/* 移动端工具区 - 始终显示在底部，软键盘/HOME 指示器升起时保持在键盘上方 */}
      {isMobile && (
        <div
          className="px-3 py-2 border-t border-border bg-background"
          style={{
            paddingBottom: keyboardHeight > 0 
              ? `${keyboardHeight + (isIOS ? IOS_KEYBOARD_ACCESSORY_HEIGHT : 0)}px`
              : isIOS ? `${IOS_KEYBOARD_ACCESSORY_HEIGHT}px` : undefined,
          }}
        >
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => handleMobileKeyPress('esc')}
              disabled={quickKeysDisabled}
              className="h-6 px-2 text-xs border rounded hover:bg-accent disabled:opacity-50"
            >
              Esc
            </button>
            <button
              type="button"
              onClick={() => handleMobileKeyPress('tab')}
              disabled={quickKeysDisabled}
              className="h-6 w-9 p-0 border rounded hover:bg-accent disabled:opacity-50 flex items-center justify-center"
            >
              <RiArrowRightLine size={16} />
            </button>
            <button
              type="button"
              onClick={() => handleModifierToggle('ctrl')}
              disabled={quickKeysDisabled}
              className={`h-6 w-9 p-0 border rounded disabled:opacity-50 flex items-center justify-center ${
                activeModifier === 'ctrl' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'
              }`}
            >
              <span className="text-xs font-medium">Ctrl</span>
            </button>
            <button
              type="button"
              onClick={() => handleModifierToggle('cmd')}
              disabled={quickKeysDisabled}
              className={`h-6 w-9 p-0 border rounded disabled:opacity-50 flex items-center justify-center ${
                activeModifier === 'cmd' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'
              }`}
            >
              <RiCommandLine size={16} />
            </button>
            <button
              type="button"
              onClick={() => handleMobileKeyPress('arrow-up')}
              disabled={quickKeysDisabled}
              className="h-6 w-9 p-0 border rounded hover:bg-accent disabled:opacity-50 flex items-center justify-center"
            >
              <RiArrowUpLine size={16} />
            </button>
            <button
              type="button"
              onClick={() => handleMobileKeyPress('arrow-left')}
              disabled={quickKeysDisabled}
              className="h-6 w-9 p-0 border rounded hover:bg-accent disabled:opacity-50 flex items-center justify-center"
            >
              <RiArrowLeftLine size={16} />
            </button>
            <button
              type="button"
              onClick={() => handleMobileKeyPress('arrow-down')}
              disabled={quickKeysDisabled}
              className="h-6 w-9 p-0 border rounded hover:bg-accent disabled:opacity-50 flex items-center justify-center"
            >
              <RiArrowDownLine size={16} />
            </button>
            <button
              type="button"
              onClick={() => handleMobileKeyPress('arrow-right')}
              disabled={quickKeysDisabled}
              className="h-6 w-9 p-0 border rounded hover:bg-accent disabled:opacity-50 flex items-center justify-center"
            >
              <RiArrowRightLine size={16} />
            </button>
            <button
              type="button"
              onClick={() => handleMobileKeyPress('enter')}
              disabled={quickKeysDisabled}
              className="h-6 w-9 p-0 border rounded hover:bg-accent disabled:opacity-50 flex items-center justify-center"
            >
              <RiArrowGoBackLine size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
