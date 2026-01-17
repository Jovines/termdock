import React from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalTheme } from '../../terminal';
import type { TerminalChunk } from '../../terminal';
import { useTouchScroll } from '../../hooks/useTouchScroll';
import { TerminalLoading, TerminalInitializing } from './TerminalLoading';
import { TerminalError } from './TerminalError';

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
    { sessionKey, chunks, onInput, onResize, theme, fontFamily, fontSize, className, enableTouchScroll },
    ref
  ) => {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const viewportRef = React.useRef<HTMLElement | null>(null);
    const terminalRef = React.useRef<Terminal | null>(null);
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
    const isComposingRef = React.useRef(false);
    const wheelHandlerRef = React.useRef<((event: WheelEvent) => void) | null>(null);
    const [, forceRender] = React.useReducer((x) => x + 1, 0);
    const [terminalReadyVersion, bumpTerminalReady] = React.useReducer((x) => x + 1, 0);
    const [loadingState, setLoadingState] = React.useState<LoadingState>('loading');
    const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

    // Early initialization loading indicator
    const [isInitializing, setIsInitializing] = React.useState(true);

    inputHandlerRef.current = onInput;
    resizeHandlerRef.current = onResize;

    /**
     * 将屏幕像素坐标转换为终端字符网格坐标
     * @param px 屏幕X坐标（像素）
     * @param py 屏幕Y坐标（像素）
     * @param terminal xterm.js Terminal实例
     * @returns 字符网格坐标 {x, y}，1-based
     */
    const pixelToCharCoords = React.useCallback((
      px: number,
      py: number,
      terminal: Terminal
    ): { x: number; y: number } => {
      const charWidth = (terminal.element?.offsetWidth || 0) / terminal.cols || 8;
      const charHeight = (terminal.element?.offsetHeight || 0) / terminal.rows || 16;

      const col = Math.max(1, Math.min(terminal.cols, Math.floor(px / charWidth) + 1));
      const row = Math.max(1, Math.min(terminal.rows, Math.floor(py / charHeight) + 1));

      return { x: col, y: row };
    }, []);

    const handleScroll = React.useCallback((deltaPixels: number, touchX?: number, touchY?: number): boolean => {
      const terminal = terminalRef.current;
      if (!terminal) return false;

      const lineHeightPx = Math.max(12, Math.round(fontSize * 1.35));
      const lines = deltaPixels > 0 ? -1 : 1;

      // 情况1：程序启用了鼠标报告（vim中执行 :set mouse=a）
      // 使用SGR 1006协议发送滚轮事件
      if (terminal.modes.mouseTrackingMode !== 'none') {
        let charX: number;
        let charY: number;

        if (touchX !== undefined && touchY !== undefined) {
          // 使用实际触摸坐标转换为字符网格坐标
          const coords = pixelToCharCoords(touchX, touchY, terminal);
          charX = coords.x;
          charY = coords.y;
        } else {
          // 回退到光标位置（1-based）
          charX = terminal.buffer.active.cursorX + 1;
          charY = terminal.buffer.active.cursorY + 1;
        }

        // SGR 1006协议: \x1b[<button;x;yM
        // 滚轮按钮: 64=wheel up, 65=wheel down
        const button = lines > 0 ? 64 : 65;
        const mouseEvent = `\x1b[<${button};${charX};${charY}M`;
        inputHandlerRef.current(mouseEvent);
        return true;
      }

      // 情况2：在alternate模式（没有scrollback，如vim/less/man）
      // 发送上下箭头键，模拟滚轮
      if (terminal.buffer.active.type === 'alternate') {
        const arrowKey = lines > 0 ? '\x1b[A' : '\x1b[B'; // 上箭头、下箭头
        inputHandlerRef.current(arrowKey);
        return true;
      }

      // 情况3：都不是，走正常触摸滑动逻辑（终端内容滚动）
      const total = remainderPxRef.current + deltaPixels;
      const scrollLines = Math.trunc(total / lineHeightPx);
      remainderPxRef.current = total - scrollLines * lineHeightPx;

      if (scrollLines !== 0) {
        terminal.scrollLines(scrollLines);
        return true;
      }
      return false;
    }, [fontSize, pixelToCharCoords]);

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
      onScrollWithCoords: handleScroll,
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
          });

          const fitAddon = new FitAddon();
          terminal.loadAddon(fitAddon);

          localTerminal = terminal;
          terminalRef.current = terminal;
          fitAddonRef.current = fitAddon;

          terminal.open(container);
          setIsInitializing(false);
          bumpTerminalReady();

          // Setup pinch-to-zoom gesture for font size adjustment (mobile only)
          if (enableTouchScroll) {
            const handleWheel = (event: WheelEvent) => {
              if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                const delta = event.deltaY > 0 ? -1 : 1;
                const newSize = Math.max(8, Math.min(32, fontSize + delta));
                if (newSize !== fontSize) {
                  container.dispatchEvent(new CustomEvent('termfontchange', { detail: newSize }));
                }
              }
            };
            wheelHandlerRef.current = handleWheel;
            container.addEventListener('wheel', handleWheel, { passive: false });
          }

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
        touchScrollCleanupRef.current?.();
        touchScrollCleanupRef.current = null;

        for (const disposable of localDisposables) {
          disposable.dispose();
        }
        localResizeObserver?.disconnect();

        if (wheelHandlerRef.current) {
          container.removeEventListener('wheel', wheelHandlerRef.current);
          wheelHandlerRef.current = null;
        }

        localTerminal?.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
        viewportRef.current = null;
        lastReportedSizeRef.current = null;
        resetWriteState();
      };
    }, [fitTerminal, fontFamily, fontSize, theme, resetWriteState, enableTouchScroll]);

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
          if (event.key === 'Enter') {
            event.preventDefault();
            if (enableTouchScroll && !isScrolling()) {
              focusHiddenInput();
            } else if (!enableTouchScroll) {
              terminalRef.current?.focus();
            }
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
        {loadingState === 'ready' && (
          <>
            {enableTouchScroll ? (
              <textarea
                ref={hiddenInputRef}
                inputMode="text"
                enterKeyHint="enter"
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
                  // Handle Enter key (including mobile keyboard confirm button)
                  if (event.key === 'Enter' || event.key === 'Go' || event.key === 'done' || event.key === 'send') {
                    event.preventDefault();
                    inputHandlerRef.current('\r');
                    event.currentTarget.value = '';
                    return;
                  }

                  if (event.key === 'Backspace') {
                    if (isComposingRef.current) {
                      return;
                    }

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
