import React from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import type { TerminalTheme } from '../../terminal';
import type { TerminalChunk } from '../../terminal';
import type { TerminalRendererMode } from '../../terminal/renderer';
import { useTouchScroll } from '../../hooks/useTouchScroll';
import { TerminalLoading, TerminalInitializing } from './TerminalLoading';
import { TerminalError } from './TerminalError';
import { createDebugLogger } from '../../utils/debug';

/**
 * 清洗用户输入，处理各种特殊字符
 * 1. 换行符统一转换为 CR (\r) - 终端标准
 * 2. Unicode 空格变体转换为普通空格
 * 3. 移除零宽字符
 */
function sanitizeTerminalInput(input: string): string {
  if (!input) {
    return '';
  }

  return input
    // 换行符统一处理：LF (\n) 和 CR-LF (\r\n) → CR (\r)
    .replace(/\r\n|\r|\n/g, '\r')
    // 所有 Unicode 空格变体 → 普通空格
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    // 移除零宽字符
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}

function decodeBase64Utf8(base64Data: string): string | null {
  try {
    const raw = atob(base64Data);
    const bytes = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return null;
  }
}

function processOsc52Clipboard(data: string): { cleaned: string; remainder: string } {
  const osc52Prefix = '\u001b]52;';
  let index = 0;
  let cleaned = '';

  while (index < data.length) {
    const start = data.indexOf(osc52Prefix, index);
    if (start === -1) {
      cleaned += data.slice(index);
      return { cleaned, remainder: '' };
    }

    cleaned += data.slice(index, start);

    let end = -1;
    let terminatorLength = 1;

    for (let i = start + osc52Prefix.length; i < data.length; i += 1) {
      const code = data.charCodeAt(i);
      if (code === 0x07) {
        end = i;
        terminatorLength = 1;
        break;
      }
      if (code === 0x1b && i + 1 < data.length && data[i + 1] === '\\') {
        end = i;
        terminatorLength = 2;
        break;
      }
    }

    if (end === -1) {
      return { cleaned, remainder: data.slice(start) };
    }

    const content = data.slice(start + osc52Prefix.length, end);
    const separatorIndex = content.indexOf(';');
    if (separatorIndex >= 0) {
      const payload = content.slice(separatorIndex + 1);
      if (payload && payload !== '?') {
        const text = decodeBase64Utf8(payload);
        if (text !== null) {
          navigator.clipboard?.writeText(text).catch(() => {
          });
        }
      }
    }

    index = end + terminatorLength;
  }

  return { cleaned, remainder: '' };
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
  onInputFocusChange?: (isFocused: boolean) => void;
  rendererMode?: TerminalRendererMode;
  theme: TerminalTheme;
  fontFamily: string;
  fontSize: number;
  className?: string;
  enableTouchScroll?: boolean;
  autoFocus?: boolean;
}

type LoadingState = 'loading' | 'ready' | 'error';
const TEXTURE_ATLAS_REFRESH_DELAY_MS = 120;
const INPUT_BLUR_GUARD_ACTIVE_MS = 260;
const INPUT_BLUR_GUARD_RELEASE_MS = 140;
const KEYBOARD_OPEN_THRESHOLD_PX = 80;

const getTerminalFontFamily = (userFontFamily: string): string => {
  return `${userFontFamily}, monospace`;
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
    scrollbarSliderBackground: 'transparent',
    scrollbarSliderHoverBackground: 'transparent',
    scrollbarSliderActiveBackground: 'transparent',
  };
}

export const TerminalViewport = React.forwardRef<TerminalController, TerminalViewportProps>(
  (
    {
      sessionKey,
      chunks,
      onInput,
      onResize,
      onInputFocusChange,
      rendererMode = 'auto',
      theme,
      fontFamily,
      fontSize,
      className,
      enableTouchScroll,
      autoFocus = true,
    },
    ref
  ) => {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const viewportRef = React.useRef<HTMLElement | null>(null);
    const terminalRef = React.useRef<Terminal | null>(null);
    const fitAddonRef = React.useRef<FitAddon | null>(null);
    const inputHandlerRef = React.useRef<(data: string) => void>(onInput);
    const resizeHandlerRef = React.useRef<(cols: number, rows: number) => void>(onResize);
    const inputFocusHandlerRef = React.useRef<typeof onInputFocusChange>(onInputFocusChange);
    const lastReportedSizeRef = React.useRef<{ cols: number; rows: number } | null>(null);
    const pendingWriteRef = React.useRef('');
    const writeScheduledRef = React.useRef<number | null>(null);
    const isWritingRef = React.useRef(false);
    const lastProcessedChunkIdRef = React.useRef<number | null>(null);
    const touchScrollCleanupRef = React.useRef<(() => void) | null>(null);
    const hiddenInputRef = React.useRef<HTMLTextAreaElement>(null);
    const remainderPxRef = React.useRef(0);
    const osc52RemainderRef = React.useRef('');
    const webglAddonRef = React.useRef<WebglAddon | null>(null);
    const webglContextLossDisposableRef = React.useRef<{ dispose: () => void } | null>(null);
    const textureAtlasRefreshTimerRef = React.useRef<number | null>(null);
    const lastDevicePixelRatioRef = React.useRef(
      typeof window !== 'undefined' ? window.devicePixelRatio : 1
    );
    const isComposingRef = React.useRef(false);
    const wheelHandlerRef = React.useRef<((event: WheelEvent) => void) | null>(null);
    const keepInputFocusUntilRef = React.useRef(0);
    const lastTouchInteractionAtRef = React.useRef(0);
    const [, forceRender] = React.useReducer((x) => x + 1, 0);
    const [terminalReadyVersion, bumpTerminalReady] = React.useReducer((x) => x + 1, 0);
    const [loadingState, setLoadingState] = React.useState<LoadingState>('loading');
    const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
    const debugTerminal = React.useMemo(() => createDebugLogger('terminal'), []);

    // Early initialization loading indicator
    const [isInitializing, setIsInitializing] = React.useState(true);

    inputHandlerRef.current = onInput;
    resizeHandlerRef.current = onResize;
    inputFocusHandlerRef.current = onInputFocusChange;

    const shouldUseWebgl = rendererMode !== 'canvas';

    React.useEffect(() => {
      if (enableTouchScroll) {
        return;
      }
      inputFocusHandlerRef.current?.(false);
    }, [enableTouchScroll]);

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

    /**
     * 处理点击事件，发送鼠标点击给TUI程序
     * 使用SGR 1006协议发送：\x1b[<button;x;yM (press) 和 \x1b[<button;x;ym (release)
     */
    const handleClick = React.useCallback((clientX: number, clientY: number): void => {
      const terminal = terminalRef.current;
      if (!terminal) return;

      // 如果程序启用了鼠标报告，发送鼠标点击事件
      if (terminal.modes.mouseTrackingMode !== 'none') {
        // 将屏幕坐标转换为字符网格坐标
        const coords = pixelToCharCoords(clientX, clientY, terminal);
        const charX = coords.x;
        const charY = coords.y;

        // SGR 1006协议：先发送按下事件，再发送释放事件
        // 按钮0 = 左键按下
        const buttonPress = `\x1b[<0;${charX};${charY}M`;
        // 按钮编码3表示释放
        const buttonRelease = `\x1b[<0;${charX};${charY}m`;

        // 发送按下和释放事件
        inputHandlerRef.current(buttonPress);
        inputHandlerRef.current(buttonRelease);
      }
    }, [pixelToCharCoords]);

    const nowMs = React.useCallback(() => {
      return typeof performance !== 'undefined' ? performance.now() : Date.now();
    }, []);

    const focusHiddenInput = React.useCallback((_clientX?: number, _clientY?: number) => {
      const input = hiddenInputRef.current;
      if (!input) {
        return;
      }

      if (typeof document !== 'undefined' && document.activeElement === input) {
        return;
      }

      try {
        input.focus({ preventScroll: true });
      } catch {
        try {
          input.focus();
        } catch { /* ignored */ }
      }
    }, []);

    const isHiddenInputFocused = React.useCallback(() => {
      const input = hiddenInputRef.current;
      if (!input || typeof document === 'undefined') {
        return false;
      }
      return document.activeElement === input;
    }, []);

    const isViewportKeyboardLikelyOpen = React.useCallback(() => {
      if (typeof window === 'undefined' || !window.visualViewport) {
        return false;
      }

      const keyboardApproxHeight = Math.max(
        0,
        Math.round(window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop)
      );

      return keyboardApproxHeight >= KEYBOARD_OPEN_THRESHOLD_PX;
    }, []);

    const markInputBlurGuard = React.useCallback((durationMs: number) => {
      keepInputFocusUntilRef.current = nowMs() + durationMs;
    }, [nowMs]);

    const shouldGuardInputBlur = React.useCallback(() => {
      if (!enableTouchScroll) {
        return false;
      }
      return nowMs() <= keepInputFocusUntilRef.current;
    }, [enableTouchScroll, nowMs]);

    const shouldPreventDefaultForTouch = React.useCallback(() => {
      if (!enableTouchScroll) {
        return false;
      }
      return isHiddenInputFocused() || isViewportKeyboardLikelyOpen();
    }, [enableTouchScroll, isHiddenInputFocused, isViewportKeyboardLikelyOpen]);

    const handlePointerDownCapture = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
      if (!enableTouchScroll || event.pointerType !== 'touch') {
        return;
      }

      lastTouchInteractionAtRef.current = nowMs();

      if (!shouldPreventDefaultForTouch()) {
        return;
      }

      markInputBlurGuard(INPUT_BLUR_GUARD_ACTIVE_MS);
      if (event.cancelable) {
        event.preventDefault();
      }
    }, [enableTouchScroll, markInputBlurGuard, shouldPreventDefaultForTouch]);

    const handlePointerMoveCapture = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
      if (!enableTouchScroll || event.pointerType !== 'touch') {
        return;
      }

      lastTouchInteractionAtRef.current = nowMs();

      if (!shouldPreventDefaultForTouch()) {
        return;
      }

      markInputBlurGuard(INPUT_BLUR_GUARD_ACTIVE_MS);
    }, [enableTouchScroll, markInputBlurGuard, shouldPreventDefaultForTouch]);

    const handlePointerEndCapture = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
      if (!enableTouchScroll || event.pointerType !== 'touch') {
        return;
      }

      lastTouchInteractionAtRef.current = nowMs();

      if (!shouldPreventDefaultForTouch()) {
        return;
      }

      markInputBlurGuard(INPUT_BLUR_GUARD_RELEASE_MS);
    }, [enableTouchScroll, markInputBlurGuard, shouldPreventDefaultForTouch]);

    const handleTouchStartCapture = React.useCallback((event: React.TouchEvent<HTMLDivElement>) => {
      if (!enableTouchScroll) {
        return;
      }

      lastTouchInteractionAtRef.current = nowMs();

      if (!shouldPreventDefaultForTouch()) {
        return;
      }

      markInputBlurGuard(INPUT_BLUR_GUARD_ACTIVE_MS);
      if (event.cancelable) {
        event.preventDefault();
      }
    }, [enableTouchScroll, markInputBlurGuard, shouldPreventDefaultForTouch]);

    const handleTouchMoveCapture = React.useCallback(() => {
      if (!enableTouchScroll) {
        return;
      }

      lastTouchInteractionAtRef.current = nowMs();

      if (!shouldPreventDefaultForTouch()) {
        return;
      }

      markInputBlurGuard(INPUT_BLUR_GUARD_ACTIVE_MS);
    }, [enableTouchScroll, markInputBlurGuard, shouldPreventDefaultForTouch]);

    const handleTouchEndCapture = React.useCallback(() => {
      if (!enableTouchScroll) {
        return;
      }

      lastTouchInteractionAtRef.current = nowMs();

      if (!shouldPreventDefaultForTouch()) {
        return;
      }

      markInputBlurGuard(INPUT_BLUR_GUARD_RELEASE_MS);
    }, [enableTouchScroll, markInputBlurGuard, shouldPreventDefaultForTouch]);

    const { setupTouchScroll } = useTouchScroll(containerRef, {
      shouldCaptureTouch: shouldPreventDefaultForTouch,
      onScroll: handleScroll,
      onScrollWithCoords: handleScroll,
      onClickWithCoords: handleClick,
      onTap: focusHiddenInput,
      tapThreshold: 12,
    });

    React.useEffect(() => {
      if (!enableTouchScroll) {
        return;
      }

      const container = containerRef.current;
      if (!container) {
        return;
      }

      const handleCompatMouseCapture = (event: MouseEvent) => {
        if (!shouldPreventDefaultForTouch()) {
          return;
        }

        const sourceCaps = event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } };
        const fromTouch = sourceCaps.sourceCapabilities?.firesTouchEvents === true;
        const recentlyTouched = nowMs() - lastTouchInteractionAtRef.current <= 1200;

        if (!fromTouch && !recentlyTouched) {
          return;
        }

        if (event.cancelable) {
          event.preventDefault();
        }
        event.stopImmediatePropagation();
        event.stopPropagation();
      };

      container.addEventListener('mousedown', handleCompatMouseCapture, { capture: true, passive: false });
      container.addEventListener('click', handleCompatMouseCapture, { capture: true, passive: false });

      return () => {
        container.removeEventListener('mousedown', handleCompatMouseCapture, true);
        container.removeEventListener('click', handleCompatMouseCapture, true);
      };
    }, [enableTouchScroll, shouldPreventDefaultForTouch, nowMs]);

    const resetWriteState = React.useCallback(() => {
      pendingWriteRef.current = '';
      if (writeScheduledRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(writeScheduledRef.current);
      }
      writeScheduledRef.current = null;
      isWritingRef.current = false;
      lastProcessedChunkIdRef.current = null;
      osc52RemainderRef.current = '';
    }, []);

    const fitTerminal = React.useCallback((reason: string = 'unknown') => {
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
        debugTerminal('skip fit: container too small', {
          reason,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
        return;
      }
      try {
        const before = { cols: terminal.cols, rows: terminal.rows };
        fitAddon.fit();
        const next = { cols: terminal.cols, rows: terminal.rows };
        const previous = lastReportedSizeRef.current;

        debugTerminal('fit', {
          reason,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          before,
          next,
          changed: before.cols !== next.cols || before.rows !== next.rows,
        });

        if (!previous || previous.cols !== next.cols || previous.rows !== next.rows) {
          lastReportedSizeRef.current = next;
          resizeHandlerRef.current(next.cols, next.rows);
        }
      } catch { /* ignored */ }
    }, [debugTerminal]);

    const clearTextureAtlasRefreshTimer = React.useCallback(() => {
      if (textureAtlasRefreshTimerRef.current === null) {
        return;
      }
      window.clearTimeout(textureAtlasRefreshTimerRef.current);
      textureAtlasRefreshTimerRef.current = null;
    }, []);

    const scheduleTextureAtlasRefresh = React.useCallback((reason: string) => {
      if (typeof window === 'undefined') {
        return;
      }

      clearTextureAtlasRefreshTimer();

      textureAtlasRefreshTimerRef.current = window.setTimeout(() => {
        textureAtlasRefreshTimerRef.current = null;

        const addon = webglAddonRef.current;
        const terminal = terminalRef.current;
        if (!addon || !terminal) {
          return;
        }

        try {
          addon.clearTextureAtlas();
          terminal.refresh(0, Math.max(0, terminal.rows - 1));
          debugTerminal('texture atlas refreshed', {
            reason,
            cols: terminal.cols,
            rows: terminal.rows,
          });
        } catch (error) {
          debugTerminal('texture atlas refresh failed', { reason, error });
        }
      }, TEXTURE_ATLAS_REFRESH_DELAY_MS);
    }, [clearTextureAtlasRefreshTimer, debugTerminal]);

    const disposeWebglRenderer = React.useCallback((reason: string): boolean => {
      clearTextureAtlasRefreshTimer();

      const contextLossDisposable = webglContextLossDisposableRef.current;
      if (contextLossDisposable) {
        try {
          contextLossDisposable.dispose();
        } catch { /* ignored */ }
        webglContextLossDisposableRef.current = null;
      }

      const addon = webglAddonRef.current;
      if (!addon) {
        return false;
      }

      try {
        addon.dispose();
      } catch { /* ignored */ }

      webglAddonRef.current = null;
      debugTerminal('renderer disposed', { type: 'webgl', reason });
      return true;
    }, [clearTextureAtlasRefreshTimer, debugTerminal]);

    const enableWebglRenderer = React.useCallback((terminal: Terminal, reason: string): boolean => {
      if (webglAddonRef.current) {
        return true;
      }

      try {
        const webglAddon = new WebglAddon();

        webglContextLossDisposableRef.current = webglAddon.onContextLoss(() => {
          debugTerminal('webgl context loss', { reason: 'onContextLoss' });
          disposeWebglRenderer('context-loss');
          fitTerminal('webgl-context-loss');
        });

        terminal.loadAddon(webglAddon);
        webglAddonRef.current = webglAddon;

        debugTerminal('renderer', {
          type: 'webgl',
          reason,
          mobile: enableTouchScroll,
          mode: rendererMode,
        });
        scheduleTextureAtlasRefresh(`webgl-enabled:${reason}`);
        return true;
      } catch (error) {
        debugTerminal('webgl load failed, fallback to canvas', {
          reason,
          error,
          mobile: enableTouchScroll,
          mode: rendererMode,
        });
        return false;
      }
    }, [
      debugTerminal,
      disposeWebglRenderer,
      enableTouchScroll,
      fitTerminal,
      rendererMode,
      scheduleTextureAtlasRefresh,
    ]);

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

      container.tabIndex = enableTouchScroll ? -1 : 0;

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
            customGlyphs: true,
            rescaleOverlappingGlyphs: true,
            letterSpacing: 0,
            lineHeight: 1,
            overviewRuler: {
              width: 2,
            },
          });

          const fitAddon = new FitAddon();
          terminal.loadAddon(fitAddon);

          localTerminal = terminal;
          terminalRef.current = terminal;
          fitAddonRef.current = fitAddon;
          lastDevicePixelRatioRef.current = typeof window !== 'undefined' ? window.devicePixelRatio : 1;

          terminal.open(container);
          if (shouldUseWebgl) {
            enableWebglRenderer(terminal, 'init');
          } else {
            debugTerminal('renderer', {
              type: 'canvas',
              reason: 'renderer-mode-canvas',
              mobile: enableTouchScroll,
              mode: rendererMode,
            });
          }
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

          fitTerminal('init');
          if (autoFocus) {
            terminal.focus();
          }

          terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
            if (event.type !== 'keydown') {
              return true;
            }

            const key = event.key.toLowerCase();
            const hasPrimaryModifier = event.metaKey || event.ctrlKey;

            if (!hasPrimaryModifier || event.altKey) {
              return true;
            }

            if (key === 'c') {
              const selected = terminal.getSelection();
              if (!selected) {
                return true;
              }
              event.preventDefault();
              navigator.clipboard?.writeText(selected).catch(() => {
              });
              return false;
            }

            if (key === 'v') {
              event.preventDefault();
              navigator.clipboard?.readText().then((text) => {
                if (!text) {
                  return;
                }
                inputHandlerRef.current(sanitizeTerminalInput(text));
              }).catch(() => {
              });
              return false;
            }

            return true;
          });

          // Handle data input
          localDisposables.push(
            terminal.onData((data: string) => {
              inputHandlerRef.current(data);
            })
          );

          localResizeObserver = new ResizeObserver((entries) => {
            const firstEntry = entries[0];
            if (firstEntry) {
              debugTerminal('resize observer', {
                width: Math.round(firstEntry.contentRect.width),
                height: Math.round(firstEntry.contentRect.height),
              });
            }

            const nextDevicePixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
            if (Math.abs(nextDevicePixelRatio - lastDevicePixelRatioRef.current) > 0.001) {
              lastDevicePixelRatioRef.current = nextDevicePixelRatio;
              debugTerminal('device pixel ratio changed', { value: nextDevicePixelRatio });
              scheduleTextureAtlasRefresh('device-pixel-ratio-change');
            }

            fitTerminal('resize-observer');
            scheduleTextureAtlasRefresh('resize-observer');
          });
          localResizeObserver.observe(container);

          if (typeof window !== 'undefined') {
            window.setTimeout(() => {
              fitTerminal('post-init-timeout');
              scheduleTextureAtlasRefresh('post-init-timeout');
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
        inputFocusHandlerRef.current?.(false);
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

        disposeWebglRenderer('component-unmount');
        localTerminal?.dispose();
        clearTextureAtlasRefreshTimer();
        terminalRef.current = null;
        fitAddonRef.current = null;
        viewportRef.current = null;
        lastReportedSizeRef.current = null;
        resetWriteState();
      };
    }, [
      fitTerminal,
      fontFamily,
      fontSize,
      theme,
      resetWriteState,
      enableTouchScroll,
      shouldUseWebgl,
      rendererMode,
      autoFocus,
      enableWebglRenderer,
      scheduleTextureAtlasRefresh,
      disposeWebglRenderer,
      clearTextureAtlasRefreshTimer,
      debugTerminal,
    ]);

    React.useEffect(() => {
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }
      terminal.reset();
      resetWriteState();
      lastReportedSizeRef.current = null;
      fitTerminal('session-reset');
      if (autoFocus) {
        terminal.focus();
      }
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
          fitTerminal('buffer-reset');
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
        const rawChunk = pending.map((chunk) => chunk.data).join('');
        const merged = osc52RemainderRef.current + rawChunk;
        const { cleaned, remainder } = processOsc52Clipboard(merged);
        osc52RemainderRef.current = remainder;
        if (cleaned) {
          enqueueWrite(cleaned);
        }
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
          fitTerminal('imperative-clear');
        },
        fit: () => {
          fitTerminal('imperative-fit');
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
        tabIndex={enableTouchScroll ? -1 : 0}
        onPointerDownCapture={handlePointerDownCapture}
        onPointerMoveCapture={handlePointerMoveCapture}
        onPointerUpCapture={handlePointerEndCapture}
        onPointerCancelCapture={handlePointerEndCapture}
        onTouchStartCapture={handleTouchStartCapture}
        onTouchMoveCapture={handleTouchMoveCapture}
        onTouchEndCapture={handleTouchEndCapture}
        onTouchCancelCapture={handleTouchEndCapture}
        onClick={() => {
          if (!enableTouchScroll) {
            terminalRef.current?.focus();
          }
        }}
        onKeyDown={(event) => {
          if (!enableTouchScroll && event.key === 'Enter') {
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
        {loadingState === 'ready' && (
          <>
            {enableTouchScroll ? (
              <textarea
                ref={hiddenInputRef}
                aria-hidden="true"
                data-terminal-input-anchor="true"
                inputMode="text"
                enterKeyHint="enter"
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                tabIndex={-1}
                style={{
                  position: 'absolute',
                  left: 8,
                  top: 8,
                  width: 1,
                  height: 1,
                  opacity: 0,
                  zIndex: 0,
                  pointerEvents: 'none',
                  background: 'transparent',
                  color: 'transparent',
                  caretColor: 'transparent',
                  resize: 'none',
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  fontSize: '16px',
                  border: 'none',
                  padding: 0,
                  margin: 0,
                  outline: 'none',
                }}
                onFocus={() => {
                  debugTerminal('input anchor focus');
                  scheduleTextureAtlasRefresh('input-focus');
                  inputFocusHandlerRef.current?.(true);
                }}
                onBlur={() => {
                  const guarded = shouldGuardInputBlur();
                  const activeElement = typeof document !== 'undefined'
                    ? document.activeElement as HTMLElement | null
                    : null;
                  debugTerminal('input anchor blur', {
                    guarded,
                    activeTag: activeElement?.tagName ?? null,
                    activeClass: activeElement?.className ?? null,
                  });
                  scheduleTextureAtlasRefresh('input-blur');

                  if (!guarded) {
                    inputFocusHandlerRef.current?.(false);
                    return;
                  }

                  if (typeof window === 'undefined') {
                    inputFocusHandlerRef.current?.(false);
                    return;
                  }

                  window.setTimeout(() => {
                    if (isHiddenInputFocused()) {
                      return;
                    }

                    if (!isViewportKeyboardLikelyOpen()) {
                      inputFocusHandlerRef.current?.(false);
                    }
                  }, INPUT_BLUR_GUARD_RELEASE_MS);
                }}
                onBeforeInput={(event) => {
                  if (isComposingRef.current) {
                    return;
                  }

                  const nativeEvent = event.nativeEvent;
                  if (!(nativeEvent instanceof InputEvent)) {
                    return;
                  }

                  if (nativeEvent.inputType === 'insertLineBreak') {
                    event.preventDefault();
                    inputHandlerRef.current('\r');
                    event.currentTarget.value = '';
                    return;
                  }

                  if (nativeEvent.inputType === 'deleteContentBackward') {
                    event.preventDefault();
                    if (!event.currentTarget.value) {
                      inputHandlerRef.current('\x7f');
                    }
                  }
                }}
                onInput={(event) => {
                  if (isComposingRef.current) {
                    return;
                  }

                  const raw = String(event.currentTarget.value || '');
                  if (!raw) {
                    return;
                  }

                  const value = sanitizeTerminalInput(raw);
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
                    const value = sanitizeTerminalInput(raw);
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
