import React from 'react';
import { Ghostty, Terminal as GhosttyTerminal, FitAddon } from 'ghostty-web';
import type { TerminalTheme } from '../../terminal';
import { getGhosttyTerminalOptions } from '../../terminal';
import type { TerminalChunk } from '../../terminal';
import { useTouchScroll } from '../../hooks/useTouchScroll';
import { TerminalLoading, TerminalInitializing } from './TerminalLoading';
import { TerminalError } from './TerminalError';

let ghosttyPromise: Promise<Ghostty> | null = null;

function getGhostty(): Promise<Ghostty> {
  if (!ghosttyPromise) {
    ghosttyPromise = Ghostty.load();
  }
  return ghosttyPromise;
}

function findScrollableViewport(container: HTMLElement): HTMLElement | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const candidates = [container, ...Array.from(container.querySelectorAll<HTMLElement>('*'))];
  let fallback: HTMLElement | null = null;

  for (const element of candidates) {
    const style = window.getComputedStyle(element);
    const overflowY = style.overflowY;
    if (overflowY !== 'auto' && overflowY !== 'scroll') {
      continue;
    }

    if (element.scrollHeight - element.clientHeight > 2) {
      return element;
    }

    if (!fallback) {
      fallback = element;
    }
  }

  return fallback;
}

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
  enableTouchScroll?: boolean;
}

type LoadingState = 'loading' | 'ready' | 'error';

export const TerminalViewport = React.forwardRef<TerminalController, TerminalViewportProps>(
  (
    { sessionKey, chunks, onInput, onResize, theme, fontFamily, fontSize, className, enableTouchScroll },
    ref
  ) => {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const viewportRef = React.useRef<HTMLElement | null>(null);
    const terminalRef = React.useRef<GhosttyTerminal | null>(null);
    const fitAddonRef = React.useRef<FitAddon | null>(null);
    const inputHandlerRef = React.useRef<(data: string) => void>(onInput);
    const resizeHandlerRef = React.useRef<(cols: number, rows: number) => void>(onResize);
    const lastReportedSizeRef = React.useRef<{ cols: number; rows: number } | null>(null);
    const pendingWriteRef = React.useRef('');
    const writeScheduledRef = React.useRef<number | null>(null);
    const isWritingRef = React.useRef(false);
    const lastProcessedChunkIdRef = React.useRef<number | null>(null);
    const touchScrollCleanupRef = React.useRef<(() => void) | null>(null);
    const hiddenInputRef = React.useRef<HTMLTextAreaElement>(null);
    const remainderPxRef = React.useRef(0);
    const isComposingRef = React.useRef(false); // Track IME composition state
    const [, forceRender] = React.useReducer((x) => x + 1, 0);
    const [terminalReadyVersion, bumpTerminalReady] = React.useReducer((x) => x + 1, 0);
    const [loadingState, setLoadingState] = React.useState<LoadingState>('loading');
    const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

    // 用于显示早期loading
    const [isInitializing, setIsInitializing] = React.useState(true);

    inputHandlerRef.current = onInput;
    resizeHandlerRef.current = onResize;

    const handleScroll = React.useCallback((deltaPixels: number): boolean => {
      const terminal = terminalRef.current;
      if (!terminal) return false;
      
      const lineHeightPx = Math.max(12, Math.round(fontSize * 1.35));
      const total = remainderPxRef.current + deltaPixels;
      const lines = Math.trunc(total / lineHeightPx);
      remainderPxRef.current = total - lines * lineHeightPx;
      
      if (lines !== 0) {
        terminal.scrollLines(lines);
        return true;
      }
      return false;
    }, [fontSize]);

    const focusHiddenInput = React.useCallback((clientX?: number, clientY?: number) => {
      const input = hiddenInputRef.current;
      const container = containerRef.current;
      if (!input || !container) {
        return;
      }

      const rect = container.getBoundingClientRect();
      const fallbackX = rect.left + rect.width / 2;
      const fallbackY = rect.top + rect.height - 12;
      const x = typeof clientX === 'number' ? clientX : fallbackX;
      const y = typeof clientY === 'number' ? clientY : fallbackY;

      const padding = 8;
      const left = Math.max(padding, Math.min(rect.width - padding, x - rect.left));
      const top = Math.max(padding, Math.min(rect.height - padding, y - rect.top));

      input.style.left = `${left}px`;
      input.style.top = `${top}px`;
      input.style.bottom = '';

      try {
        input.focus({ preventScroll: true });
      } catch {
        try {
          input.focus();
        } catch { /* ignored */ }
      }
    }, []);

    const { setupTouchScroll, isScrolling } = useTouchScroll(containerRef, {
      onScroll: handleScroll,
      onTap: focusHiddenInput,
      tapThreshold: 12,
    });

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
      let localTerminal: GhosttyTerminal | null = null;
      let localResizeObserver: ResizeObserver | null = null;
      let localDisposables: Array<{ dispose: () => void }> = [];

      const container = containerRef.current;
      if (!container) {
        return;
      }

      container.tabIndex = 0;

      const initialize = async () => {
        setLoadingState('loading');
        setErrorMessage(null);
        setIsInitializing(true);

        try {
          const ghostty = await getGhostty();
          if (disposed) {
            return;
          }

          setIsInitializing(false);

          const options = getGhosttyTerminalOptions(fontFamily, fontSize, theme, ghostty);

          const terminal = new GhosttyTerminal(options);

          const fitAddon = new FitAddon();

          localTerminal = terminal;
          terminalRef.current = terminal;
          fitAddonRef.current = fitAddon;

          terminal.loadAddon(fitAddon);
          terminal.open(container);
          bumpTerminalReady();

          const viewport = findScrollableViewport(container);
          if (viewport) {
            viewport.classList.add('overlay-scrollbar-target', 'overlay-scrollbar-container');
            viewportRef.current = viewport;
            forceRender();
          } else {
            viewportRef.current = null;
          }

          fitTerminal();
          terminal.focus();

          localDisposables = [
            terminal.onData((data: string) => {
              inputHandlerRef.current(data);
            }),
          ];

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

      void initialize();

      return () => {
        disposed = true;
        touchScrollCleanupRef.current?.();
        touchScrollCleanupRef.current = null;

        for (const disposable of localDisposables) {
          disposable.dispose();
        }
        localResizeObserver?.disconnect();

        localTerminal?.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
        viewportRef.current = null;
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
      if (!enableTouchScroll) return;
      const cleanup = setupTouchScroll();
      touchScrollCleanupRef.current = cleanup;
      return () => {
        cleanup();
        touchScrollCleanupRef.current = null;
      };
    }, [enableTouchScroll, setupTouchScroll]);

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
          if (enableTouchScroll) {
            focusHiddenInput();
            return;
          }
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
      [enableTouchScroll, focusHiddenInput, fitTerminal, resetWriteState]
    );

    return (
      <div
        ref={containerRef}
        className={`relative h-full w-full terminal-viewport-container ${className || ''}`}
        style={{ backgroundColor: theme.background }}
        role="button"
        tabIndex={0}
        onClick={(event) => {
          if (enableTouchScroll && !isScrolling()) {
            focusHiddenInput(event.clientX, event.clientY);
          } else if (!enableTouchScroll) {
            terminalRef.current?.focus();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (enableTouchScroll && !isScrolling()) {
              focusHiddenInput();
            } else if (!enableTouchScroll) {
              terminalRef.current?.focus();
            }
          }
        }}
      >
        {/* Early initialization loading - shows before ghostty loads */}
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
        {loadingState === 'ready' && (
          <>
            {enableTouchScroll ? (
              <textarea
                ref={hiddenInputRef}
                inputMode="text"
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                tabIndex={-1}
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  width: 1,
                  height: 1,
                  opacity: 0,
                  zIndex: 1,
                  background: 'transparent',
                  color: 'transparent',
                  caretColor: 'transparent',
                  resize: 'none',
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  border: 'none',
                  padding: 0,
                  margin: 0,
                  outline: 'none',
                }}
                onInput={(event) => {
                  // Skip input events during IME composition to prevent intermediate characters
                  if (isComposingRef.current) {
                    return;
                  }

                  const raw = String(event.currentTarget.value || '');
                  if (!raw) {
                    return;
                  }

                  const value = raw.replace(/\r\n|\r|\n/g, '\r');
                  inputHandlerRef.current(value);
                  event.currentTarget.value = '';
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Backspace') {
                    if (!event.currentTarget.value) {
                      inputHandlerRef.current('\x7f');
                    }
                  }
                }}
                onCompositionStart={() => {
                  isComposingRef.current = true;
                }}
                onCompositionUpdate={() => {
                  isComposingRef.current = true;
                }}
                onCompositionEnd={(event) => {
                  isComposingRef.current = false;

                  // Send the composed text after composition ends
                  const raw = String(event.currentTarget.value || '');
                  if (raw) {
                    const value = raw.replace(/\r\n|\r|\n/g, '\r');
                    inputHandlerRef.current(value);
                    event.currentTarget.value = '';
                  }
                }}
              />
            ) : null}
            {viewportRef.current && !enableTouchScroll ? (
              <div className="overlay-scrollbar overlay-scrollbar--flush overlay-scrollbar--dense overlay-scrollbar--zero" />
            ) : null}
          </>
        )}
      </div>
    );
  }
);

TerminalViewport.displayName = 'TerminalViewport';