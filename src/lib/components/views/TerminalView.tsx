import React from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useTerminalStore } from '../../stores/useTerminalStore';
import type { TerminalStreamEvent } from '../../terminal';
import { TerminalViewport, type TerminalController } from '../terminal/TerminalViewport';
import { convertThemeToXterm, getDefaultTheme } from '../../terminal';
import { createWebTerminalAPI } from '../../terminal/factory';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { MobileKeyboard, getSequenceForKey } from '../terminal/MobileKeyboard';
import { DebugPanel } from '../terminal/DebugPanel';
import { ConnectionStatus } from '../terminal/ConnectionStatus';

const TERMINAL_FONT_SIZE = 13;

type Modifier = 'ctrl' | 'cmd';

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
  theme?: 'dark' | 'light' | 'solarized' | 'dracula' | 'nord';
  fontFamily?: string;
  fontSize?: number;
  showDebug?: boolean;
  onStatusChange?: (status: { isConnecting: boolean; isRestarting: boolean; hasError: boolean; sessionId: string | null }) => void;
}

export const TerminalView: React.FC<TerminalViewProps> = ({
  sessionId: initialSessionId,
  theme: themeName = 'dark',
  fontFamily = 'Menlo, Monaco, Consolas, monospace',
  fontSize: initialFontSize = TERMINAL_FONT_SIZE,
  showDebug: externalShowDebug,
  onStatusChange,
}) => {
  // Use external fontSize from props, with local override support for pinch-to-zoom
  const [fontSize, setFontSize] = React.useState(initialFontSize);
  const terminal = React.useMemo(() => createWebTerminalAPI(), []);

  // Sync with external fontSize changes while allowing local pinch-to-zoom overrides
  React.useEffect(() => {
    setFontSize(initialFontSize);
  }, [initialFontSize]);

  const [currentTheme, setCurrentTheme] = React.useState(getDefaultTheme);
  const [sessionId] = React.useState(initialSessionId || uuidv4());
  const [isMobile, setIsMobile] = React.useState(false);
  const [isIOS, setIsIOS] = React.useState(false);
  const [keyboardHeight, setKeyboardHeight] = React.useState(0);
  const [activeModifier, setActiveModifier] = React.useState<Modifier | null>(null);

  const terminalStore = useTerminalStore();
  const terminalSessions = terminalStore.sessions;
  const setTerminalSession = terminalStore.setTerminalSession;
  const setConnecting = terminalStore.setConnecting;
  const appendToBuffer = terminalStore.appendToBuffer;
  const clearTerminalSession = terminalStore.clearTerminalSession;
  const removeTerminalSession = terminalStore.removeTerminalSession;
  const clearBuffer = terminalStore.clearBuffer;

  const terminalState = React.useMemo(() => {
    if (!sessionId) return undefined;
    return terminalSessions.get(sessionId);
  }, [terminalSessions, sessionId]);

  const terminalSessionRef = terminalState?.terminalSessionId ?? null;
  const bufferChunks = terminalState?.bufferChunks ?? [];
  const isConnecting = terminalState?.isConnecting ?? false;
  const terminalSessionId = terminalSessionRef;

  const [connectionError, setConnectionError] = React.useState<string | null>(null);
  const [isFatalError, setIsFatalError] = React.useState(false);
  const [isRestarting, setIsRestarting] = React.useState(false);
  const showDebug = externalShowDebug !== undefined ? externalShowDebug : false;

  // 流清理和活动终端引用
  const streamCleanupRef = React.useRef<(() => void) | null>(null);
  const activeTerminalIdRef = React.useRef<string | null>(null);
  const terminalIdRef = React.useRef<string | null>(null);
  const sessionIdRef = React.useRef<string | null>(null);
  const terminalControllerRef = React.useRef<TerminalController | null>(null);

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

  // Keyboard detection
  React.useEffect(() => {
    if (!isMobile || typeof window === 'undefined') return;

    const KEYBOARD_MIN_HEIGHT = 100;
    const KEYBOARD_DEBOUNCE_MS = 300;

    const state = {
      debounceTimer: null as NodeJS.Timeout | null,
      isKeyboardVisible: false,
    };

    const updateKeyboardState = (visible: boolean, height: number) => {
      if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
        state.debounceTimer = null;
      }

      if (visible) {
        state.isKeyboardVisible = true;
        setKeyboardHeight(height);
      } else {
        state.debounceTimer = setTimeout(() => {
          const viewport = window.visualViewport;
          if (viewport) {
            const currentWindowHeight = window.innerHeight;
            const currentKeyboardH = currentWindowHeight - viewport.height;
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

      if (keyboardH >= KEYBOARD_MIN_HEIGHT) {
        updateKeyboardState(true, keyboardH);
      } else if (keyboardH < KEYBOARD_MIN_HEIGHT && state.isKeyboardVisible) {
        updateKeyboardState(false, 0);
      }
    };

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
    sessionIdRef.current = sessionId;
  }, [sessionId]);

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
            const storeSessionId = sessionId;
            if (!storeSessionId) return;

            switch (event.type) {
              case 'connected': {
                if (event.runtime || event.ptyBackend) {
                  console.log(
                    `[Terminal] connected runtime=${event.runtime ?? 'unknown'} pty=${event.ptyBackend ?? 'unknown'}`
                  );
                }
                setConnecting(storeSessionId, false);
                setConnectionError(null);
                setIsFatalError(false);

                const sessionState = useTerminalStore.getState().getTerminalSession(storeSessionId);
                if (sessionState?.history && sessionState.history.length > 0) {
                  console.log(`[Terminal] Restoring ${sessionState.history.length} history chunks`);
                  sessionState.history.forEach(chunk => {
                    appendToBuffer(storeSessionId, chunk);
                  });
                  useTerminalStore.getState().setSessionHistory(storeSessionId, []);
                }

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
                  appendToBuffer(storeSessionId, event.data);
                }
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
                disconnectStream();
                break;
              }
            }
          },
          onError: (error, fatal) => {
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
        activeTerminalIdRef.current = null;
      };
      activeTerminalIdRef.current = terminalId;
    },
    [appendToBuffer, clearTerminalSession, disconnectStream, removeTerminalSession, setConnecting, terminal, sessionId]
  );

  const hasInitializedRef = React.useRef(false);
  const currentRunIdRef = React.useRef(0);

  React.useEffect(() => {
    if (sessionIdRef.current !== sessionId) {
      console.log(`[useEffect] sessionId changed from ${sessionIdRef.current} to ${sessionId}, allowing reinitialization`);
      hasInitializedRef.current = false;
    }

    if (hasInitializedRef.current && sessionIdRef.current === sessionId) {
      console.log(`[useEffect] Already initialized for sessionId=${sessionId}, skipping`);
      return;
    }

    console.log(`[useEffect] Running ensureSession for sessionId=${sessionId}, hasInitialized=${hasInitializedRef.current}`);
    hasInitializedRef.current = true;

    const runId = ++currentRunIdRef.current;

    const ensureSession = async () => {
      console.log(`[ensureSession] Starting for sessionId=${sessionId}, runId=${runId}`);

      if (!sessionIdRef.current || sessionIdRef.current !== sessionId) {
        console.log(`[ensureSession] SessionId mismatch or stale run (current=${sessionIdRef.current}, target=${sessionId}), skipping`);
        return;
      }

      if (runId !== currentRunIdRef.current) {
        console.log(`[ensureSession] Stale run detected (runId=${runId}, currentRunId=${currentRunIdRef.current}), skipping`);
        return;
      }

      const store = useTerminalStore.getState();
      const currentState = store.getTerminalSession(sessionId);
      console.log(`[ensureSession] Current state from store:`, {
        terminalSessionId: currentState?.terminalSessionId,
        isConnecting: currentState?.isConnecting
      });

      let terminalId = currentState?.terminalSessionId ?? null;
      let shouldCreateNewSession = !terminalId;

      if (terminalId && terminal.checkHealth) {
        console.log(`[ensureSession] Checking health of existing session ${terminalId}`);
        try {
          const health = await terminal.checkHealth(terminalId);
          console.log(`[ensureSession] Health check result:`, health);
          if (!health.healthy) {
            console.log(`[ensureSession] Session ${terminalId} is NOT healthy (healthy=${health.healthy}), will create new session`);
            console.log(`[ensureSession] Health check details:`, health);
            shouldCreateNewSession = true;
            store.clearTerminalSession(sessionId);
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
        }
      }

      console.log(`[ensureSession] Decision: shouldCreateNewSession=${shouldCreateNewSession}, terminalId=${terminalId}`);
      if (shouldCreateNewSession) {
        console.log(`[ensureSession] Creating new session, shouldCreateNewSession=${shouldCreateNewSession}, runId=${runId}`);
        setConnectionError(null);
        setIsFatalError(false);
        store.setConnecting(sessionId, true);

        const currentStore = useTerminalStore.getState();
        const recheckedState = currentStore.getTerminalSession(sessionId);
        if (recheckedState?.terminalSessionId) {
          console.log(`[ensureSession] Race condition avoided: another instance already created session ${recheckedState.terminalSessionId}`);
          store.setConnecting(sessionId, false);
          terminalId = recheckedState.terminalSessionId;
          shouldCreateNewSession = false;
        } else {
          try {
            const session = await terminal.createSession({});
            console.log(`[ensureSession] Created new session ${session.sessionId}`);

            if (runId !== currentRunIdRef.current) {
              console.log(`[ensureSession] Stale run after session creation (runId=${runId}, currentRunId=${currentRunIdRef.current}), closing session`);
              try {
                await terminal.close(session.sessionId);
              } catch { /* ignored */ }
              return;
            }

            store.setTerminalSession(sessionId, session);
            console.log(`[ensureSession] Updated store with new session ${session.sessionId}`);
            terminalId = session.sessionId;
          } catch (error) {
            if (runId !== currentRunIdRef.current) {
              console.log(`[ensureSession] Stale run after session creation failed, skipping error handling`);
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
        console.log(`[ensureSession] Stale run before starting stream (runId=${runId}, currentRunId=${currentRunIdRef.current}), skipping`);
        return;
      }

      if (!terminalId) {
        console.log(`[ensureSession] No terminalId, terminalId=${terminalId}`);
        return;
      }

      console.log(`[ensureSession] Starting stream for session ${terminalId}`);
      terminalIdRef.current = terminalId;
      startStream(terminalId);
      console.log(`[ensureSession] ensureSession completed for sessionId=${sessionId}, terminalId=${terminalId}`);
    };

    void ensureSession();

    return () => {
      console.log(`[useEffect] Cleanup for sessionId=${sessionId}, runId=${runId}`);
    };
  }, [sessionId, startStream, disconnectStream, terminal]);

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
      const session = await terminal.createSession({});
      setTerminalSession(sessionId, session);
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
  }, [sessionId, isRestarting, disconnectStream, terminal, removeTerminalSession, clearBuffer, setConnecting, setTerminalSession, startStream]);

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
    (key: 'esc' | 'tab' | 'enter' | 'arrow-up' | 'arrow-down' | 'arrow-left' | 'arrow-right') => {
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

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {showDebug && (
        <DebugPanel
          isMobile={isMobile}
          keyboardHeight={keyboardHeight}
          isIOS={isIOS}
          isConnecting={isConnecting}
          connectionError={connectionError}
          terminalSessionId={terminalSessionId}
        />
      )}

      <div
        className="relative flex-1 overflow-hidden"
        style={{
          backgroundColor: xtermTheme.background,
          height: isMobile && keyboardHeight > 0
            ? `calc(100% - ${keyboardHeight}px)`
            : undefined,
        }}
      >
        <div
          className="h-full w-full box-border px-2 pt-3"
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

        <ConnectionStatus
          connectionError={connectionError}
          isFatalError={isFatalError}
          isRestarting={isRestarting}
          isConnecting={isConnecting}
          onHardRestart={handleHardRestart}
        />
      </div>

      <MobileKeyboard
        isMobile={isMobile}
        keyboardHeight={keyboardHeight}
        isIOS={isIOS}
        activeModifier={activeModifier}
        disabled={quickKeysDisabled}
        onKeyPress={handleMobileKeyPress}
        onModifierToggle={handleModifierToggle}
      />
    </div>
  );
};
