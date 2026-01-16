import React from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalTheme } from '../../terminal';
import type { TerminalChunk } from '../../terminal';
import { TerminalLoading, TerminalInitializing } from './TerminalLoading';
import { TerminalError } from './TerminalError';

export type TerminalController = {
  focus: () => void;
  clear: () => void;
  fit: () => void;
};

interface TerminalViewportProps {
  sessionKey: string;
  chunks: TerminalChunk[];
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  theme: TerminalTheme;
  fontFamily: string;
  fontSize: number;
  className?: string;
}

type LoadingState = 'loading' | 'ready' | 'error';

// NERD Font fallback chain for icons and symbols
const getTerminalFontFamily = (userFontFamily: string): string => {
  const nerdFonts = [
    '"JetBrainsMonoNL Nerd Font"',
    '"FiraCode Nerd Font"',
    '"Cascadia Code PL"',
    '"Fira Code"',
    '"JetBrains Mono"',
    '"SFMono-Regular"',
    'Menlo',
    'Consolas',
    '"Liberation Mono"',
    '"Courier New"',
    'monospace',
  ];
  // If user already specified NERD fonts, just return as is
  if (userFontFamily.toLowerCase().includes('nerd')) {
    return userFontFamily;
  }
  return `${userFontFamily}, ${nerdFonts.join(', ')}`;
};

// Convert TerminalTheme to xterm.js theme format
function convertTheme(theme: TerminalTheme): Record<string, string> {
  return {
    background: theme.background,
    foreground: theme.foreground,
    cursor: theme.cursor || theme.foreground,
    cursorAccent: theme.cursorAccent || theme.background,
    selectionBackground: theme.selectionBackground || 'rgba(0, 0, 0, 0.3)',
    selectionForeground: theme.selectionForeground || theme.foreground,
    black: theme.black || '#000000',
    red: theme.red || '#cd3131',
    green: theme.green || '#0dbc79',
    yellow: theme.yellow || '#e5e510',
    blue: theme.blue || '#2472c8',
    magenta: theme.magenta || '#bc3fbc',
    cyan: theme.cyan || '#11a8cd',
    white: theme.white || '#e5e5e5',
    brightBlack: theme.brightBlack || '#666666',
    brightRed: theme.brightRed || '#f14c4c',
    brightGreen: theme.brightGreen || '#23d18b',
    brightYellow: theme.brightYellow || '#f5f543',
    brightBlue: theme.brightBlue || '#3b8eea',
    brightMagenta: theme.brightMagenta || '#d670d6',
    brightCyan: theme.brightCyan || '#29b8db',
    brightWhite: theme.brightWhite || '#ffffff',
  };
}

export const TerminalViewport = React.forwardRef<TerminalController, TerminalViewportProps>(
  (
    { sessionKey, chunks, onInput, onResize, theme, fontFamily, fontSize, className },
    ref
  ) => {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const terminalRef = React.useRef<Terminal | null>(null);
    const fitAddonRef = React.useRef<FitAddon | null>(null);
    const inputHandlerRef = React.useRef<(data: string) => void>(onInput);
    const resizeHandlerRef = React.useRef<(cols: number, rows: number) => void>(onResize);
    const lastReportedSizeRef = React.useRef<{ cols: number; rows: number } | null>(null);
    const pendingWriteRef = React.useRef('');
    const writeScheduledRef = React.useRef<number | null>(null);
    const isWritingRef = React.useRef(false);
    const lastProcessedChunkIdRef = React.useRef<number | null>(null);
    const [, forceRender] = React.useReducer((x) => x + 1, 0);
    const [terminalReadyVersion, bumpTerminalReady] = React.useReducer((x) => x + 1, 0);
    const [loadingState, setLoadingState] = React.useState<LoadingState>('loading');
    const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

    // Early initialization loading indicator
    const [isInitializing, setIsInitializing] = React.useState(true);

    inputHandlerRef.current = onInput;
    resizeHandlerRef.current = onResize;

    const resetWriteState = React.useCallback(() => {
      pendingWriteRef.current = '';
      if (writeScheduledRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(writeScheduledRef.current);
      }
      writeScheduledRef.current = null;
      isWritingRef.current = false;
      lastProcessedChunkIdRef.current = null;
    }, []);

    const fitTerminal = React.useCallback(() => {
      const fitAddon = fitAddonRef.current;
      const terminal = terminalRef.current;
      const container = containerRef.current;
      if (!fitAddon || !terminal || !container) {
        return;
      }
      // Check if terminal element is attached and has dimensions
      if (!terminal.element || !terminal.cols || !terminal.rows) {
        return;
      }
      const rect = container.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 24) {
        return;
      }
      try {
        fitAddon.fit();
        const next = { cols: terminal.cols, rows: terminal.rows };
        const previous = lastReportedSizeRef.current;
        if (!previous || previous.cols !== next.cols || previous.rows !== next.rows) {
          lastReportedSizeRef.current = next;
          resizeHandlerRef.current(next.cols, next.rows);
        }
      } catch { /* ignored */ }
    }, []);

    const flushWrites = React.useCallback(() => {
      if (isWritingRef.current) {
        return;
      }

      const term = terminalRef.current;
      if (!term) {
        resetWriteState();
        return;
      }

      if (!pendingWriteRef.current) {
        return;
      }

      const chunk = pendingWriteRef.current;
      pendingWriteRef.current = '';

      isWritingRef.current = true;
      term.write(chunk, () => {
        isWritingRef.current = false;
        if (pendingWriteRef.current) {
          if (typeof window !== 'undefined') {
            writeScheduledRef.current = window.requestAnimationFrame(() => {
              writeScheduledRef.current = null;
              flushWrites();
            });
          } else {
            flushWrites();
          }
        }
      });
    }, [resetWriteState]);

    const scheduleFlushWrites = React.useCallback(() => {
      if (writeScheduledRef.current !== null) {
        return;
      }
      if (typeof window !== 'undefined') {
        writeScheduledRef.current = window.requestAnimationFrame(() => {
          writeScheduledRef.current = null;
          flushWrites();
        });
      } else {
        flushWrites();
      }
    }, [flushWrites]);

    const enqueueWrite = React.useCallback(
      (data: string) => {
        if (!data) {
          return;
        }
        pendingWriteRef.current += data;
        scheduleFlushWrites();
      },
      [scheduleFlushWrites]
    );

    React.useEffect(() => {
      let disposed = false;
      let localTerminal: Terminal | null = null;
      let localResizeObserver: ResizeObserver | null = null;
      let localDisposables: Array<{ dispose: () => void }> = [];

      const container = containerRef.current;
      if (!container) {
        return;
      }

      container.tabIndex = 0;

      const initialize = () => {
        setLoadingState('loading');
        setErrorMessage(null);
        setIsInitializing(true);

        try {
          // Create terminal with xterm.js
          const terminal = new Terminal({
            fontFamily: getTerminalFontFamily(fontFamily),
            fontSize,
            theme: convertTheme(theme),
            cursorBlink: true,
            cursorStyle: 'block',
            scrollback: 1000,
            allowTransparency: false,
            convertEol: true,
            // Enable mouse events for vim and other apps
            mouseEvents: true,
          });

          const fitAddon = new FitAddon();
          terminal.loadAddon(fitAddon);

          localTerminal = terminal;
          terminalRef.current = terminal;
          fitAddonRef.current = fitAddon;

          terminal.open(container);
          setIsInitializing(false);
          bumpTerminalReady();

          fitTerminal();
          terminal.focus();

          // Handle data input
          localDisposables.push(
            terminal.onData((data: string) => {
              inputHandlerRef.current(data);
            })
          );

          // Handle resize events
          localDisposables.push(
            terminal.onResize(({ cols, rows }) => {
              resizeHandlerRef.current(cols, rows);
            })
          );

          localResizeObserver = new ResizeObserver(() => {
            fitTerminal();
          });
          localResizeObserver.observe(container);

          if (typeof window !== 'undefined') {
            window.setTimeout(() => {
              fitTerminal();
            }, 0);
          }

          setLoadingState('ready');
        } catch (error) {
          console.error('Failed to initialize terminal:', error);
          setIsInitializing(false);
          setLoadingState('error');
          setErrorMessage(error instanceof Error ? error.message : 'Failed to load terminal');
        }
      };

      initialize();

      return () => {
        void disposed;

        for (const disposable of localDisposables) {
          disposable.dispose();
        }
        localResizeObserver?.disconnect();

        localTerminal?.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
        lastReportedSizeRef.current = null;
        resetWriteState();
      };
    }, [fitTerminal, fontFamily, fontSize, theme, resetWriteState]);

    React.useEffect(() => {
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }
      terminal.reset();
      resetWriteState();
      lastReportedSizeRef.current = null;
      fitTerminal();
      terminal.focus();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionKey, terminalReadyVersion, fitTerminal, resetWriteState]);

    React.useEffect(() => {
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }

      if (chunks.length === 0) {
        if (lastProcessedChunkIdRef.current !== null) {
          terminal.reset();
          resetWriteState();
          fitTerminal();
        }
        return;
      }

      const lastProcessedId = lastProcessedChunkIdRef.current;
      let pending: TerminalChunk[];

      if (lastProcessedId === null) {
        pending = chunks;
      } else {
        const lastProcessedIndex = chunks.findIndex((chunk) => chunk.id === lastProcessedId);
        pending = lastProcessedIndex >= 0 ? chunks.slice(lastProcessedIndex + 1) : chunks;
      }

      if (pending.length > 0) {
        enqueueWrite(pending.map((chunk) => chunk.data).join(''));
      }

      lastProcessedChunkIdRef.current = chunks[chunks.length - 1].id;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chunks, terminalReadyVersion, enqueueWrite, fitTerminal, resetWriteState]);

    React.useImperativeHandle(
      ref,
      (): TerminalController => ({
        focus: () => {
          terminalRef.current?.focus();
        },
        clear: () => {
          const terminal = terminalRef.current;
          if (!terminal) {
            return;
          }
          terminal.reset();
          resetWriteState();
          fitTerminal();
        },
        fit: () => {
          fitTerminal();
        },
      }),
      [fitTerminal, resetWriteState]
    );

    return (
      <div
        ref={containerRef}
        className={`relative h-full w-full terminal-viewport-container ${className || ''}`}
        style={{ backgroundColor: theme.background }}
        role="button"
        tabIndex={0}
        onClick={() => {
          terminalRef.current?.focus();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            terminalRef.current?.focus();
          }
        }}
      >
        {/* Early initialization loading - shows before xterm.js loads */}
        {isInitializing && <TerminalInitializing />}

        {/* Loading state */}
        {loadingState === 'loading' && !isInitializing && <TerminalLoading />}

        {/* Error state */}
        {loadingState === 'error' && (
          <TerminalError
            message={errorMessage || undefined}
            onRetry={() => {
              window.location.reload();
            }}
          />
        )}

        {/* Terminal content - only show when ready */}
        {loadingState === 'ready' && null}
      </div>
    );
  }
);

TerminalViewport.displayName = 'TerminalViewport';
