import React from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import type { TerminalTheme } from '../../terminal';
import type { TerminalChunk } from '../../terminal';
import type { TerminalRendererMode } from '../../terminal/renderer';
import { useTouchScroll, type TouchScrollConfig } from '../../hooks/useTouchScroll';
import { light as hapticLight } from 'browser-haptic';
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
  /** 同步立即清纹理图集 + 重绘所有行（恢复 / 切换 session 关键路径用） */
  refreshNow: () => void;
  /** 防抖延迟刷新（高频场景，如 ResizeObserver 回调） */
  refreshTextureAtlas: () => void;
  /** 恢复 WebGL renderer：addon 丢失时重建 + 立即刷新 */
  recoverRenderer: () => void;
  /** 滚动到底部（除非用户在 alternate buffer 或 tmux copy-mode） */
  scrollToBottom: () => void;
};

interface TerminalViewportProps {
  sessionKey: string;
  chunks: TerminalChunk[];
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onTmuxScroll?: (direction: 'up' | 'down', lines: number) => void;
  tmuxScrollSensitivity?: number;
  onDoubleTap?: () => void;
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
    black: theme.black || '#6F6E69',
    red: theme.red || '#AF3029',
    green: theme.green || '#66800B',
    yellow: theme.yellow || '#AD8301',
    blue: theme.blue || '#205EA6',
    magenta: theme.magenta || '#A02F6F',
    cyan: theme.cyan || '#24837B',
    white: theme.white || '#CECDC3',
    brightBlack: theme.brightBlack || '#6F6E69',
    brightRed: theme.brightRed || '#D14D41',
    brightGreen: theme.brightGreen || '#879A39',
    brightYellow: theme.brightYellow || '#D0A215',
    brightBlue: theme.brightBlue || '#4385BE',
    brightMagenta: theme.brightMagenta || '#CE5D97',
    brightCyan: theme.brightCyan || '#3AA99F',
    brightWhite: theme.brightWhite || '#FFFCF0',
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
      onTmuxScroll,
      tmuxScrollSensitivity = 0.55,
      onDoubleTap,
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
    const sentValueRef = React.useRef('');
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

    // Gesture feedback indicators
    const [tabIndicator, setTabIndicator] = React.useState(false);
    const [arrowIndicator, setArrowIndicator] = React.useState<{
      visible: boolean;
      activeDir: string; // 'up' | 'down' | 'left' | 'right' | ''
    }>({ visible: false, activeDir: '' });
    const arrowIndicatorRef = React.useRef<HTMLDivElement>(null);
    const tabIndicatorTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

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

    // Shared pre-checks: mouse tracking and alternate buffer modes
    // apply equally to normal and tmux scrolling.  Returns true/false if
    // the event was consumed; null means "continue to mode-specific handler".
    const handleScrollPreChecks = React.useCallback((deltaPixels: number, touchX?: number, touchY?: number): boolean | null => {
      const terminal = terminalRef.current;
      if (!terminal) return false;

      const lines = deltaPixels > 0 ? -1 : 1;

      if (terminal.modes.mouseTrackingMode !== 'none') {
        let charX: number;
        let charY: number;
        if (touchX !== undefined && touchY !== undefined) {
          const coords = pixelToCharCoords(touchX, touchY, terminal);
          charX = coords.x;
          charY = coords.y;
        } else {
          charX = terminal.buffer.active.cursorX + 1;
          charY = terminal.buffer.active.cursorY + 1;
        }
        const button = lines > 0 ? 64 : 65;
        const mouseEvent = `\x1b[<${button};${charX};${charY}M`;
        inputHandlerRef.current(mouseEvent);
        return true;
      }

      if (terminal.buffer.active.type === 'alternate') {
        const arrowKey = lines > 0 ? '\x1b[A' : '\x1b[B';
        inputHandlerRef.current(arrowKey);
        return true;
      }

      return null;
    }, [pixelToCharCoords]);

    // --- Normal mode: xterm.js local scrollback ---
    const handleNormalScroll = React.useCallback((deltaPixels: number): boolean => {
      const terminal = terminalRef.current;
      if (!terminal) return false;

      const lineHeightPx = Math.max(12, Math.round(fontSize * 1.35));
      const total = remainderPxRef.current + deltaPixels;
      const scrollLines = Math.trunc(total / lineHeightPx);
      remainderPxRef.current = total - scrollLines * lineHeightPx;

      if (scrollLines !== 0) {
        terminal.scrollLines(scrollLines);
        return true;
      }
      return false;
    }, [fontSize]);

    // --- Tmux mode: server-side copy-mode scrolling ---
    const handleTmuxScrollInternal = React.useCallback((deltaPixels: number): boolean => {
      const terminal = terminalRef.current;
      if (!terminal) return false;

      const lineHeightPx = Math.max(12, Math.round(fontSize * 1.35));
      const effectiveLineHeight = lineHeightPx / Math.max(0.1, tmuxScrollSensitivity);
      const total = remainderPxRef.current + deltaPixels;
      let scrollLines = Math.trunc(total / effectiveLineHeight);
      remainderPxRef.current = total - scrollLines * effectiveLineHeight;

      // Short swipes may not accumulate a full line — give at least 1 line
      // of feedback when a meaningful fraction of the effective height has
      // accumulated, so slow finger movements still produce visible scroll.
      if (scrollLines === 0 && Math.abs(total) >= effectiveLineHeight / 3) {
        scrollLines = total > 0 ? 1 : -1;
        remainderPxRef.current = 0;
      }

      if (scrollLines === 0) return false;

      const direction = scrollLines > 0 ? 'down' : 'up';
      onTmuxScroll!(direction, Math.max(1, Math.min(Math.abs(scrollLines), 10)));
      return true;
    }, [fontSize, onTmuxScroll, tmuxScrollSensitivity]);

    // Stash the latest mode-specific handlers in refs so the top-level
    // handleScroll has a stable identity.  This prevents useTouchScroll
    // from tearing down and rebuilding event listeners on every render,
    // which can cause state corruption during keyboard open/close cycles.
    const handleScrollPreChecksRef = React.useRef(handleScrollPreChecks);
    handleScrollPreChecksRef.current = handleScrollPreChecks;
    const handleNormalScrollRef = React.useRef(handleNormalScroll);
    handleNormalScrollRef.current = handleNormalScroll;
    const handleTmuxScrollInternalRef = React.useRef(handleTmuxScrollInternal);
    handleTmuxScrollInternalRef.current = handleTmuxScrollInternal;
    const onTmuxScrollRef = React.useRef(onTmuxScroll);
    onTmuxScrollRef.current = onTmuxScroll;

    // Top-level dispatch: pre-checks first, then mode-specific handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const handleScroll = React.useCallback((deltaPixels: number, touchX?: number, touchY?: number): boolean => {
      const pre = handleScrollPreChecksRef.current(deltaPixels, touchX, touchY);
      if (pre !== null) return pre;
      return onTmuxScrollRef.current
        ? handleTmuxScrollInternalRef.current(deltaPixels)
        : handleNormalScrollRef.current(deltaPixels);
    }, []);

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

    const syncTextareaToPty = React.useCallback(
      (textarea: HTMLTextAreaElement) => {
        const raw = textarea.value;
        const sanitized = sanitizeTerminalInput(raw);
        const sent = sentValueRef.current;

        if (sanitized === sent) return;

        let commonLen = 0;
        while (commonLen < sent.length && commonLen < sanitized.length && sent[commonLen] === sanitized[commonLen]) {
          commonLen++;
        }

        // Send backspaces for characters no longer present
        // (user deletion via keyboard or voice autocorrect both flow through here)
        const toDelete = sent.length - commonLen;
        if (toDelete > 0) {
          for (let i = 0; i < toDelete; i++) {
            inputHandlerRef.current('\x7f');
          }
        }

        // Send new content
        const newPart = sanitized.slice(commonLen);
        if (newPart) {
          inputHandlerRef.current(newPart);
        }

        sentValueRef.current = sanitized;
      },
      []
    );

    const flushAndSendEnter = React.useCallback(
      (textarea: HTMLTextAreaElement) => {
        syncTextareaToPty(textarea);
        inputHandlerRef.current('\r');
        textarea.value = '';
        sentValueRef.current = '';
      },
      [syncTextareaToPty]
    );

    const focusHiddenInput = React.useCallback((_clientX?: number, _clientY?: number) => {
      const input = hiddenInputRef.current;
      if (!input) {
        return;
      }

      try {
        // Synchronously remove readonly so iOS shows the keyboard.
        // React state is async — can't use setTextareaReadOnly here.
        input.removeAttribute('readonly');

        // When iOS dismissed the keyboard via its own dismiss button, the
        // textarea stays focused but the keyboard is gone — plain focus() is
        // a no-op.  Only in that specific case do we blur first.
        const alreadyFocused = typeof document !== 'undefined' && document.activeElement === input;
        const keyboardGone = alreadyFocused && !isViewportKeyboardLikelyOpen();

        if (keyboardGone) {
          input.blur();
        }
        input.focus();
      } catch { /* ignored */ }
    }, [isViewportKeyboardLikelyOpen]);

    const markInputBlurGuard = React.useCallback((durationMs: number) => {
      keepInputFocusUntilRef.current = nowMs() + durationMs;
    }, [nowMs]);

    const shouldGuardInputBlur = React.useCallback(() => {
      if (!enableTouchScroll) {
        return false;
      }
      return nowMs() <= keepInputFocusUntilRef.current;
    }, [enableTouchScroll, nowMs]);

    // With the full-size textarea covering the entire terminal, touch events
    // naturally target the textarea.  touch-action:none on the textarea prevents
    // browser scroll/pinch — all custom scroll is handled by useTouchScroll.
    // We only extend the blur guard so transient touch interactions don't
    // prematurely report focus loss to the parent component.
    const extendBlurGuard = React.useCallback((durationMs: number) => {
      markInputBlurGuard(durationMs);
      lastTouchInteractionAtRef.current = nowMs();
    }, [markInputBlurGuard, nowMs]);

    // ---- Normal-mode touch scroll (useTouchScroll) ----
    // Only active when NOT in tmux mode; tmux mode uses its own dedicated
    // touch handler below so the two scroll systems never share state.
    const touchScrollConfig: TouchScrollConfig = React.useMemo(
      () => ({ enableKinetic: true }),
      [],
    );

    const noCaptureRef = React.useRef(() => false);

    // Ref-stabilize callbacks so useTouchScroll never tears down and rebuilds
    // event listeners due to a new closure identity on re-render.  This is
    // critical during keyboard open/close cycles where intermediate renders
    // would otherwise re-install listeners and risk dropping pointerup events,
    // leaving the state machine in a dirty state that blocks all gestures.
    const onTapRef = React.useRef(focusHiddenInput);
    onTapRef.current = focusHiddenInput;
    const stableOnTap = React.useCallback((x: number, y: number) => {
      onTapRef.current(x, y);
    }, []);

    // Stable ref for double-tap callback, consumed by the gesture capture effect
    const onDoubleTapRef = React.useRef(onDoubleTap);
    onDoubleTapRef.current = onDoubleTap;

    const notifyGestureLock = React.useCallback((locked: boolean) => {
      document.dispatchEvent(
        new CustomEvent('termdock:gesture-lock', { detail: { locked } })
      );
    }, []);

    const { setupTouchScroll } = useTouchScroll(containerRef, {
      ...touchScrollConfig,
      shouldCaptureTouch: noCaptureRef.current,
      onScroll: handleScroll,
      onScrollWithCoords: handleScroll,
      onClickWithCoords: handleClick,
      onTap: stableOnTap,
      tapThreshold: 12,
    });

    React.useEffect(() => {
      if (!enableTouchScroll) return;
      // Prevent iOS magnifying glass on long-press by starting in readonly.
      // Removed synchronously in focusHiddenInput, restored on blur.
      hiddenInputRef.current?.setAttribute('readonly', '');
      const cleanup = setupTouchScroll();
      return () => { cleanup(); };
    }, [enableTouchScroll, setupTouchScroll]);

    // When the soft keyboard closes, iOS keeps the textarea focused but
    // with the keyboard gone.  A focused textarea — even with keyboard
    // dismissed — pulls iOS into text-selection touch handling: the
    // browser intercepts horizontal pointermove events for cursor
    // placement / selection handles, which starves Swiper of the
    // events it needs to detect page-flipping swipes.  Blurring the
    // textarea on keyboard close drops iOS out of that mode so
    // subsequent gestures reach Swiper unmodified.
    React.useEffect(() => {
      if (!enableTouchScroll) return;

      let wasOpen = isViewportKeyboardLikelyOpen();

      const handleViewportChange = () => {
        const nowOpen = isViewportKeyboardLikelyOpen();
        if (wasOpen && !nowOpen) {
          const input = hiddenInputRef.current;
          if (input && typeof document !== 'undefined' && document.activeElement === input) {
            input.setAttribute('readonly', '');
            input.blur();
          }
        }
        wasOpen = nowOpen;
      };

      window.visualViewport?.addEventListener('resize', handleViewportChange);
      return () => {
        window.visualViewport?.removeEventListener('resize', handleViewportChange);
      };
    }, [enableTouchScroll, isViewportKeyboardLikelyOpen]);

    // Compat mouse event blocking (shared by both modes).
    React.useEffect(() => {
      if (!enableTouchScroll) return;

      const container = containerRef.current;
      if (!container) return;

      const shouldBlockCompatMouseEvent = (event: MouseEvent) => {
        const sourceCaps = event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } };
        const fromTouch = sourceCaps.sourceCapabilities?.firesTouchEvents === true;
        const recentlyTouched = nowMs() - lastTouchInteractionAtRef.current <= 1200;
        if (!fromTouch && !recentlyTouched) return false;
        return container.contains(event.target as Node | null);
      };

      const handleCompatMouseCapture = (event: MouseEvent) => {
        if (!shouldBlockCompatMouseEvent(event)) return;
        if (event.cancelable) event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
      };

      container.addEventListener('mousedown', handleCompatMouseCapture, { capture: true, passive: false });
      container.addEventListener('mouseup', handleCompatMouseCapture, { capture: true, passive: false });
      container.addEventListener('click', handleCompatMouseCapture, { capture: true, passive: false });
      document.addEventListener('mouseup', handleCompatMouseCapture, { capture: true, passive: false });

      return () => {
        container.removeEventListener('mousedown', handleCompatMouseCapture, true);
        container.removeEventListener('mouseup', handleCompatMouseCapture, true);
        container.removeEventListener('click', handleCompatMouseCapture, true);
        document.removeEventListener('mouseup', handleCompatMouseCapture, true);
      };
    }, [enableTouchScroll, nowMs]);

    // ---- Tmux-mode touch scroll (fully independent) ----
    // Capture-phase pointer listeners that fire before useTouchScroll's
    // bubble-phase handlers.  stopImmediatePropagation() prevents the
    // normal-mode system from ever seeing touch events intended for tmux.
    //
    // Sends SGR (1006) mouse wheel escape sequences directly through the
    // PTY instead of server-side tmux copy-mode commands.  tmux's own
    // WheelUpPane / WheelDownPane bindings then conditionally pass the
    // events through to the TUI program (send -M when the program has
    // mouse reporting enabled) or fall back to copy-mode scrollback.
    React.useEffect(() => {
      if (!enableTouchScroll || !onTmuxScroll) return;

      const container = containerRef.current;
      if (!container) return;

      let pointerId: number | null = null;
      let lastX: number | null = null;
      let lastY: number | null = null;
      let startX: number | null = null;
      let startY: number | null = null;
      let gestureAxis: 'x' | 'y' | null = null;
      let remainder = 0;
      let didScroll = false;
      let rafId: number | null = null;
      let velocity = 0;
      let instantSpeed = 0;

      const lineHeightPx = Math.max(12, Math.round(fontSize * 1.35));
      const eff = lineHeightPx / Math.max(0.1, tmuxScrollSensitivity);

      const stopRaf = () => {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
      };

      // Build an SGR (1006) mouse wheel escape sequence relative to the
      // terminal element.  Button 64 = scroll up, 65 = scroll down.
      const buildSgrScroll = (direction: 'up' | 'down'): string | null => {
        const term = terminalRef.current;
        if (!term || !term.element || !term.cols || !term.rows) return null;
        const rect = term.element.getBoundingClientRect();
        const rx = (lastX ?? rect.left + rect.width / 2) - rect.left;
        const ry = (lastY ?? rect.top + rect.height / 2) - rect.top;
        const charW = term.element.offsetWidth / term.cols || 8;
        const charH = term.element.offsetHeight / term.rows || 16;
        const col = Math.max(1, Math.min(term.cols, Math.floor(rx / charW) + 1));
        const row = Math.max(1, Math.min(term.rows, Math.floor(ry / charH) + 1));
        const button = direction === 'up' ? 64 : 65;
        return `\x1b[<${button};${col};${row}M`;
      };

      const sendSgrScroll = (direction: 'up' | 'down', count: number) => {
        const seq = buildSgrScroll(direction);
        if (!seq) return;
        for (let i = 0; i < count; i++) {
          inputHandlerRef.current(seq);
        }
      };

      // Speed-adjusted effective line height: at rest (speed=0) use the
      // full eff for controlled slow-scroll feel.  At high speed, reduce
      // eff so the terminal content keeps up with the finger instead of
      // falling behind.  The scaling factor saturates at ~6x.
      const dynamicEff = () => {
        const factor = 1 + instantSpeed * 0.10;
        return eff / Math.min(6, factor);
      };

      // rAF loop: consume accumulated remainder at a steady 60 fps so
      // scroll events are spaced evenly in time regardless of how
      // irregularly touch events fire.  Each SGR event translates to one
      // wheel "click" forwarded through tmux's WheelUpPane binding.
      const tick = () => {
        rafId = null;

        const deff = dynamicEff();
        let linesUp = 0;
        let linesDown = 0;

        while ((linesUp + linesDown) < 8 && remainder >= deff) {
          remainder -= deff;
          linesDown++;
        }
        while ((linesUp + linesDown) < 8 && remainder <= -deff) {
          remainder += deff;
          linesUp++;
        }

        if (linesDown > 0) sendSgrScroll('down', linesDown);
        if (linesUp > 0) sendSgrScroll('up', linesUp);

        const consumed = linesUp + linesDown;
        if (consumed > 0) {
          rafId = requestAnimationFrame(tick);
        } else if (pointerId !== null && Math.abs(remainder) >= deff / 3) {
          // Finger still down with a meaningful fraction — flush it.
          const dir = remainder > 0 ? 'down' : 'up';
          remainder = 0;
          sendSgrScroll(dir, 1);
          rafId = requestAnimationFrame(tick);
        }
        // else: stop ticking until more delta arrives
      };

      const scheduleTick = () => {
        if (rafId === null && typeof requestAnimationFrame !== 'undefined') {
          rafId = requestAnimationFrame(tick);
        }
      };

      const onDown = (e: PointerEvent) => {
        if (e.pointerType !== 'touch') return;
        stopRaf();
        pointerId = e.pointerId;
        lastX = e.clientX;
        lastY = e.clientY;
        startX = e.clientX;
        startY = e.clientY;
        gestureAxis = null;
        remainder = 0;
        velocity = 0;
        instantSpeed = 0;
        didScroll = false;
      };

      const onMove = (e: PointerEvent) => {
        if (e.pointerType !== 'touch' || e.pointerId !== pointerId) return;
        if (lastY == null) return;

        // Axis lock: detect horizontal swipes and let them pass through
        // to Swiper for page-flipping between terminal sessions.
        if (gestureAxis === null && startX !== null && startY !== null) {
          const absDx = Math.abs(e.clientX - startX);
          const absDy = Math.abs(e.clientY - startY);
          const axisThreshold = 8;
          if (absDx > axisThreshold || absDy > axisThreshold) {
            if (absDx > absDy * 1.06) {
              gestureAxis = 'x';
            } else if (absDy > absDx * 1.06) {
              gestureAxis = 'y';
            }
          }
        }

        if (gestureAxis === 'x') {
          // Let horizontal swipes reach Swiper for page flipping
          lastX = e.clientX;
          lastY = e.clientY;
          return;
        }

        if (gestureAxis === null) {
          // Direction still ambiguous — don't consume yet
          lastX = e.clientX;
          lastY = e.clientY;
          return;
        }

        e.preventDefault();
        e.stopImmediatePropagation();

        const deltaY = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;

        // Negate to match useTouchScroll direction convention.
        const deltaPixels = -deltaY;
        remainder += deltaPixels;
        instantSpeed = Math.abs(deltaPixels);
        // EMA-smoothed velocity for light inertia on finger lift.
        velocity = velocity * 0.45 + deltaPixels * 0.55;

        if (Math.abs(remainder) >= eff / 3) {
          didScroll = true;
          scheduleTick();
        }
      };

      const onUp = (e: PointerEvent) => {
        if (e.pointerType !== 'touch' || e.pointerId !== pointerId) return;
        stopRaf();
        pointerId = null;
        lastX = null;
        lastY = null;
        startX = null;
        startY = null;
        instantSpeed = 0;

        // Horizontal gestures are handled by Swiper — skip inertia
        if (gestureAxis === 'x') {
          gestureAxis = null;
          return;
        }
        gestureAxis = null;

        // Light inertia: decay velocity and feed into remainder over
        // several frames after finger lift for a subtle glide feel.
        if (didScroll && Math.abs(velocity) > eff * 0.05) {
          const decay = () => {
            velocity *= 0.96;
            remainder += velocity;
            // Use velocity-based dynamic eff so fast swipes produce more
            // wheel events per frame during inertia.
            const factor = 1 + Math.abs(velocity) * 0.10;
            const deff = eff / Math.min(6, factor);
            if (Math.abs(velocity) < eff * 0.08) {
              if (Math.abs(remainder) >= deff / 3) {
                const dir = remainder > 0 ? 'down' : 'up';
                sendSgrScroll(dir, 1);
                remainder = 0;
              }
              velocity = 0;
              rafId = null;
              return;
            }
            // Consume up to 8 events per frame.
            let linesUp = 0;
            let linesDown = 0;
            while ((linesUp + linesDown) < 8 && remainder >= deff) {
              remainder -= deff;
              linesDown++;
            }
            while ((linesUp + linesDown) < 8 && remainder <= -deff) {
              remainder += deff;
              linesUp++;
            }
            if (linesDown > 0) sendSgrScroll('down', linesDown);
            if (linesUp > 0) sendSgrScroll('up', linesUp);
            rafId = requestAnimationFrame(decay);
          };
          rafId = requestAnimationFrame(decay);
        } else if (Math.abs(remainder) >= eff / 3) {
          // No meaningful velocity, just drain the remainder.
          scheduleTick();
        }

        if (didScroll) {
          e.stopImmediatePropagation();
        }
      };

      container.addEventListener('pointerdown', onDown, { capture: true, passive: false });
      container.addEventListener('pointermove', onMove, { capture: true, passive: false });
      container.addEventListener('pointerup', onUp, { capture: true, passive: false });
      container.addEventListener('pointercancel', onUp, { capture: true, passive: false });

      return () => {
        stopRaf();
        container.removeEventListener('pointerdown', onDown, true);
        container.removeEventListener('pointermove', onMove, true);
        container.removeEventListener('pointerup', onUp, true);
        container.removeEventListener('pointercancel', onUp, true);
      };
    }, [enableTouchScroll, onTmuxScroll != null, fontSize, tmuxScrollSensitivity]);

    // ---- Mobile gesture capture (long-press arrows + double-tap Tab) ----
    // Attached to `document` in capture phase so they fire BEFORE Swiper,
    // useTouchScroll, and the hidden textarea — guaranteeing first access
    // to every touch event.  Events are filtered to only those whose target
    // lies within this terminal's container and outside the mobile keyboard.
    React.useEffect(() => {
      if (!enableTouchScroll) return;

      const container = containerRef.current;
      if (!container) return;

      const LONG_PRESS_DURATION_MS = 500;
      const LONG_PRESS_MOVE_THRESHOLD_PX = 12;
      const ARROW_GRID_STEP_PX = 25;
      const TAP_MOVE_THRESHOLD_PX = 10;
      const DOUBLE_TAP_WINDOW_MS = 150;
      const DOUBLE_TAP_DISTANCE_PX = 25;

      const ARROW_SEQUENCES: Record<string, string> = {
        up: '\x1b[A',
        down: '\x1b[B',
        left: '\x1b[D',
        right: '\x1b[C',
      };

      // Long-press state
      let pointerId: number | null = null;
      let originX = 0;
      let originY = 0;
      let holdTimer: ReturnType<typeof setTimeout> | null = null;
      let mode: 'idle' | 'holding' | 'arrow' = 'idle';
      let lastGridX = 0;
      let lastGridY = 0;

      // Double-tap state (independent from long-press)
      let lastTapTime = 0;
      let lastTapX = 0;
      let lastTapY = 0;
      let tapStartX = 0;
      let tapStartY = 0;
      let tapDidMove = false;

      const clearHoldTimer = () => {
        if (holdTimer !== null) {
          clearTimeout(holdTimer);
          holdTimer = null;
        }
      };

      const resetGestureState = () => {
        clearHoldTimer();
        pointerId = null;
        mode = 'idle';
      };

      // Only process touches inside this terminal, not on the keyboard toolbar
      const isTargetInside = (target: EventTarget | null): boolean => {
        if (!(target instanceof HTMLElement)) return false;
        if (!container.contains(target)) return false;
        // Exclude the mobile keyboard toolbar
        if (target.closest('[data-mobile-keyboard="true"]')) return false;
        return true;
      };

      const onDown = (e: PointerEvent) => {
        if (e.pointerType !== 'touch') return;
        if (!isTargetInside(e.target)) return;

        // While in arrow mode, block all new touches to prevent Swiper
        // page-flipping or other handlers from hijacking the gesture.
        if (mode === 'arrow') {
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }

        // Suppress iOS magnifying glass / text selection loupe on long-press.
        // Without this, iOS fires its native loupe when the user holds on the
        // hidden textarea, which conflicts with our long-press gesture.
        e.preventDefault();

        // Double-tap detection fires in pointerdown so we can block the
        // event BEFORE the textarea / useTouchScroll / Swiper see it.
        if (onDoubleTapRef.current) {
          const now = performance.now();
          const x = e.clientX;
          const y = e.clientY;

          if (
            lastTapTime !== 0 &&
            now - lastTapTime <= DOUBLE_TAP_WINDOW_MS &&
            Math.hypot(x - lastTapX, y - lastTapY) <= DOUBLE_TAP_DISTANCE_PX
          ) {
            e.preventDefault();
            e.stopImmediatePropagation();
            hapticLight();
            onDoubleTapRef.current?.();
            // Flash Tab indicator
            setTabIndicator(true);
            if (tabIndicatorTimerRef.current) clearTimeout(tabIndicatorTimerRef.current);
            tabIndicatorTimerRef.current = setTimeout(() => setTabIndicator(false), 400);
            lastTapTime = 0;
            return;
          }
        }

        resetGestureState();
        pointerId = e.pointerId;
        originX = e.clientX;
        originY = e.clientY;
        tapStartX = e.clientX;
        tapStartY = e.clientY;
        tapDidMove = false;
        mode = 'holding';
        lastGridX = 0;
        lastGridY = 0;

        holdTimer = setTimeout(() => {
          holdTimer = null;
          if (mode === 'holding') {
            mode = 'arrow';
            hapticLight();
            notifyGestureLock(true);
            // Show arrow indicator at the touch origin
            setArrowIndicator({ visible: true, activeDir: '' });
            const el = arrowIndicatorRef.current;
            if (el) {
              el.style.left = originX + 'px';
              el.style.top = (originY - 100) + 'px';
            }
          }
        }, LONG_PRESS_DURATION_MS);
      };

      const onMove = (e: PointerEvent) => {
        if (e.pointerType !== 'touch') return;

        // Arrow mode: block ALL touches from reaching Swiper/useTouchScroll.
        // We consume every touchmove at document capture regardless of pointerId.
        if (mode === 'arrow') {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (e.pointerId !== pointerId) return;
          // Fall through to arrow handling below (matching pointerId only)
        } else {
          if (e.pointerId !== pointerId) return;
        }

        // Track whether this touch moved enough to disqualify a tap
        const totalDx = e.clientX - tapStartX;
        const totalDy = e.clientY - tapStartY;
        if (Math.hypot(totalDx, totalDy) > TAP_MOVE_THRESHOLD_PX) {
          tapDidMove = true;
        }

        if (mode === 'holding') {
          // Block ALL touch movement from reaching Swiper during the hold.
          // Even the very first pointermove must not reach Swiper, otherwise
          // it starts tracking and a horizontal swipe will flip pages.
          e.preventDefault();
          e.stopImmediatePropagation();

          const dx = e.clientX - originX;
          const dy = e.clientY - originY;
          if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_THRESHOLD_PX) {
            clearHoldTimer();
            mode = 'idle';
          }
          return;
        }

        if (mode === 'arrow') {
          // (preventDefault + stopImmediatePropagation already called above)

          const dx = e.clientX - originX;
          const dy = e.clientY - originY;

          const gridX = Math.round(dx / ARROW_GRID_STEP_PX);
          const gridY = Math.round(dy / ARROW_GRID_STEP_PX);

          // Axis lock: once committed, ignore the other axis unless it
          // clearly dominates (1.6x displacement ratio).  Within the same
          // axis, no threshold — continuous movement fires immediately.
          const prevDir = arrowIndicator.activeDir;
          const lockedX = prevDir === 'left' || prevDir === 'right';
          const lockedY = prevDir === 'up' || prevDir === 'down';
          const xDominant = !lockedY && (lockedX || Math.abs(dx) > Math.abs(dy) * 1.6);
          const yDominant = !lockedX && (lockedY || Math.abs(dy) > Math.abs(dx) * 1.6);

          let keysSent = 0;

          if (xDominant) {
            if (gridX > lastGridX) {
              for (let i = lastGridX + 1; i <= gridX; i++) {
                inputHandlerRef.current(ARROW_SEQUENCES.right);
                keysSent++;
              }
            } else if (gridX < lastGridX) {
              for (let i = gridX; i < lastGridX; i++) {
                inputHandlerRef.current(ARROW_SEQUENCES.left);
                keysSent++;
              }
            }
          } else if (yDominant) {
            if (gridY > lastGridY) {
              for (let i = lastGridY + 1; i <= gridY; i++) {
                inputHandlerRef.current(ARROW_SEQUENCES.down);
                keysSent++;
              }
            } else if (gridY < lastGridY) {
              for (let i = gridY; i < lastGridY; i++) {
                inputHandlerRef.current(ARROW_SEQUENCES.up);
                keysSent++;
              }
            }
          }

          if (keysSent > 0) {
            hapticLight();
          }

          let activeDir = prevDir;
          if (!lockedX && !lockedY) {
            // First move — lock to whichever axis crosses a grid step
            if (gridX > lastGridX) activeDir = 'right';
            else if (gridX < lastGridX) activeDir = 'left';
            else if (gridY > lastGridY) activeDir = 'down';
            else if (gridY < lastGridY) activeDir = 'up';
          } else if (xDominant && gridX !== lastGridX) {
            activeDir = dx > 0 ? 'right' : 'left';
          } else if (yDominant && gridY !== lastGridY) {
            activeDir = dy > 0 ? 'down' : 'up';
          }

          if (activeDir) {
            setArrowIndicator({ visible: true, activeDir });
          }

          lastGridX = gridX;
          lastGridY = gridY;
        }
      };

      const onUp = (e: PointerEvent) => {
        if (e.pointerType !== 'touch' || e.pointerId !== pointerId) return;

        if (mode === 'arrow') {
          e.preventDefault();
          e.stopImmediatePropagation();
          notifyGestureLock(false);
          setArrowIndicator({ visible: false, activeDir: '' });
          resetGestureState();
          return;
        }

        // Record clean tap for the next onDown to potentially detect as double-tap
        if (!tapDidMove && isTargetInside(e.target)) {
          lastTapTime = performance.now();
          lastTapX = e.clientX;
          lastTapY = e.clientY;
        } else if (tapDidMove) {
          lastTapTime = 0;
        }

        resetGestureState();
      };

      // Attach to document (capture) so we beat Swiper and all other handlers
      document.addEventListener('pointerdown', onDown, { capture: true, passive: false });
      document.addEventListener('pointermove', onMove, { capture: true, passive: false });
      document.addEventListener('pointerup', onUp, { capture: true, passive: false });
      document.addEventListener('pointercancel', onUp, { capture: true, passive: false });

      return () => {
        resetGestureState();
        document.removeEventListener('pointerdown', onDown, true);
        document.removeEventListener('pointermove', onMove, true);
        document.removeEventListener('pointerup', onUp, true);
        document.removeEventListener('pointercancel', onUp, true);
      };
    }, [enableTouchScroll]);

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
          remainderPxRef.current = 0;
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

    /**
     * 立即同步清纹理图集 + 重绘所有行。
     * 用于"必须刷"的关键时刻：从后台返回、切换 session、重建 renderer 后。
     * 不走 setTimeout 防抖，避免被后续高频事件无限推迟。
     */
    const refreshTextureAtlasNow = React.useCallback((reason: string) => {
      clearTextureAtlasRefreshTimer();
      const addon = webglAddonRef.current;
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }
      try {
        if (addon) {
          addon.clearTextureAtlas();
        }
        terminal.refresh(0, Math.max(0, terminal.rows - 1));
        debugTerminal('texture atlas refreshed (sync)', {
          reason,
          cols: terminal.cols,
          rows: terminal.rows,
          hasWebgl: !!addon,
        });
      } catch (error) {
        debugTerminal('texture atlas refresh (sync) failed', { reason, error });
      }
    }, [clearTextureAtlasRefreshTimer, debugTerminal]);

    const scheduleTextureAtlasRefresh = React.useCallback((reason: string) => {
      if (typeof window === 'undefined') {
        return;
      }

      clearTextureAtlasRefreshTimer();

      textureAtlasRefreshTimerRef.current = window.setTimeout(() => {
        textureAtlasRefreshTimerRef.current = null;
        refreshTextureAtlasNow(reason);
      }, TEXTURE_ATLAS_REFRESH_DELAY_MS);
    }, [clearTextureAtlasRefreshTimer, refreshTextureAtlasNow]);

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
          // 异步重建 WebGL renderer（避免在 onContextLoss 回调内同步重建死循环）
          if (typeof window !== 'undefined' && shouldUseWebgl) {
            window.setTimeout(() => {
              const term = terminalRef.current;
              if (term && !webglAddonRef.current) {
                enableWebglRenderer(term, 'auto-recover-after-context-loss');
              }
            }, 0);
          }
        });

        terminal.loadAddon(webglAddon);
        webglAddonRef.current = webglAddon;

        debugTerminal('renderer', {
          type: 'webgl',
          reason,
          mobile: enableTouchScroll,
          mode: rendererMode,
        });
        // 新建 renderer 后立即同步刷新一次，确保字符立刻正确
        refreshTextureAtlasNow(`webgl-enabled:${reason}`);
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
      refreshTextureAtlasNow,
      rendererMode,
      shouldUseWebgl,
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
            cursorInactiveStyle: 'block',
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
            const dprChanged = Math.abs(nextDevicePixelRatio - lastDevicePixelRatioRef.current) > 0.001;
            if (dprChanged) {
              lastDevicePixelRatioRef.current = nextDevicePixelRatio;
              debugTerminal('device pixel ratio changed', { value: nextDevicePixelRatio });
            }

            fitTerminal('resize-observer');
            // DPR 变化必须立即刷（屏幕在缩放/移动），其他场景走防抖即可
            if (dprChanged) {
              refreshTextureAtlasNow('device-pixel-ratio-change');
            } else {
              scheduleTextureAtlasRefresh('resize-observer');
            }
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
      sentValueRef.current = '';
      if (hiddenInputRef.current) {
        hiddenInputRef.current.value = '';
      }
      fitTerminal('session-reset');
      // reset 后立即同步刷新，避免同尺寸切换 session 时纹理图集残留旧字形
      refreshTextureAtlasNow('session-reset');
      if (autoFocus) {
        terminal.focus();
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionKey, terminalReadyVersion, fitTerminal, refreshTextureAtlasNow, resetWriteState]);

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
          refreshTextureAtlasNow('buffer-reset');
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
    }, [chunks, terminalReadyVersion, enqueueWrite, fitTerminal, refreshTextureAtlasNow, resetWriteState]);

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
          refreshTextureAtlasNow('imperative-clear');
        },
        fit: () => {
          fitTerminal('imperative-fit');
        },
        refreshNow: () => {
          refreshTextureAtlasNow('imperative-refresh-now');
        },
        refreshTextureAtlas: () => {
          scheduleTextureAtlasRefresh('imperative-refresh');
        },
        recoverRenderer: () => {
          const terminal = terminalRef.current;
          if (!terminal) return;
          if (!webglAddonRef.current && shouldUseWebgl) {
            // enableWebglRenderer 内部已会同步 refreshTextureAtlasNow
            enableWebglRenderer(terminal, 'recover');
          } else {
            refreshTextureAtlasNow('recover');
          }
        },
        scrollToBottom: () => {
          const terminal = terminalRef.current;
          if (!terminal) return;
          // alternate buffer（vim/less/tmux 等）下不能强制滚到底，会破坏内容定位
          if (terminal.buffer.active.type === 'alternate') return;
          try {
            terminal.scrollToBottom();
          } catch { /* ignored */ }
        },
      }),
      [
        enableTouchScroll,
        focusHiddenInput,
        fitTerminal,
        resetWriteState,
        refreshTextureAtlasNow,
        scheduleTextureAtlasRefresh,
        enableWebglRenderer,
        shouldUseWebgl,
      ]
    );

    return (
      <div
        ref={containerRef}
        className={`relative h-full w-full terminal-viewport-container ${className || ''}`}
        style={{
          backgroundColor: theme.background,
          touchAction: arrowIndicator.visible ? 'none' : undefined,
        }}
        role="button"
        tabIndex={enableTouchScroll ? -1 : 0}
        onPointerDownCapture={() => extendBlurGuard(INPUT_BLUR_GUARD_ACTIVE_MS)}
        onPointerMoveCapture={() => extendBlurGuard(INPUT_BLUR_GUARD_ACTIVE_MS)}
        onPointerUpCapture={() => extendBlurGuard(INPUT_BLUR_GUARD_RELEASE_MS)}
        onPointerCancelCapture={() => extendBlurGuard(INPUT_BLUR_GUARD_RELEASE_MS)}
        onTouchStartCapture={() => extendBlurGuard(INPUT_BLUR_GUARD_ACTIVE_MS)}
        onTouchMoveCapture={() => extendBlurGuard(INPUT_BLUR_GUARD_ACTIVE_MS)}
        onTouchEndCapture={() => extendBlurGuard(INPUT_BLUR_GUARD_RELEASE_MS)}
        onTouchCancelCapture={() => extendBlurGuard(INPUT_BLUR_GUARD_RELEASE_MS)}
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
                aria-label="Terminal input"
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
                  inset: 0,
                  opacity: 0,
                  zIndex: 20,
                  touchAction: 'none',
                  userSelect: 'none',
                  WebkitUserSelect: 'none',
                  WebkitTouchCallout: 'none',
                  background: 'transparent',
                  color: 'transparent',
                  caretColor: 'transparent',
                  resize: 'none',
                  overflow: 'hidden',
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
                    hiddenInputRef.current?.setAttribute('readonly', '');
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
                      hiddenInputRef.current?.setAttribute('readonly', '');
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
                    flushAndSendEnter(event.currentTarget);
                    return;
                  }

                  if (
                    nativeEvent.inputType === 'deleteContentBackward' ||
                    nativeEvent.inputType === 'deleteContentForward' ||
                    nativeEvent.inputType === 'deleteByCut'
                  ) {
                    if (!event.currentTarget.value) {
                      // Textarea is empty — user is deleting from the terminal.
                      // Prevent browser default and send \x7f directly.
                      event.preventDefault();
                      inputHandlerRef.current('\x7f');
                    }
                    // Non-empty: let the browser handle the textarea deletion.
                    // onInput → syncTextareaToPty will send \x7f for the diff.
                    return;
                  }
                }}
                onInput={(event) => {
                  if (isComposingRef.current) {
                    return;
                  }
                  syncTextareaToPty(event.currentTarget);
                }}
                onKeyDown={(event) => {
                  // Handle Enter key (including mobile keyboard confirm button)
                  if (event.key === 'Enter' || event.key === 'Go' || event.key === 'done' || event.key === 'send') {
                    event.preventDefault();
                    flushAndSendEnter(event.currentTarget);
                    return;
                  }

                  if (event.key === 'Backspace') {
                    if (isComposingRef.current) {
                      return;
                    }

                    if (!event.currentTarget.value) {
                      // Textarea empty — user is deleting from the terminal.
                      event.preventDefault();
                      inputHandlerRef.current('\x7f');
                    }
                    // Non-empty: let the browser handle deletion.
                    // onBeforeInput won't preventDefault, browser deletes from
                    // textarea, then syncTextareaToPty sends \x7f for the diff.
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
                  syncTextareaToPty(event.currentTarget);
                }}
              />
            ) : null}
            {viewportRef.current && !enableTouchScroll ? (
              <div className="overlay-scrollbar overlay-scrollbar--flush overlay-scrollbar--dense overlay-scrollbar--zero" />
            ) : null}

            {/* Double-tap Tab indicator */}
            <div
              aria-hidden
              className="absolute left-1/2 -translate-x-1/2 top-6 z-30 pointer-events-none
                         rounded-full bg-white/90 px-4 py-1.5 text-sm font-semibold text-gray-900
                         shadow-lg transition-all duration-150 ease-out"
              style={{
                opacity: tabIndicator ? 1 : 0,
                transform: tabIndicator
                  ? 'translate(-50%, 0) scale(1)'
                  : 'translate(-50%, -8px) scale(0.9)',
              }}
            >
              Tab
            </div>

            {/* Long-press arrow drag indicator */}
            <div
              ref={arrowIndicatorRef}
              aria-hidden
              className="fixed z-30 pointer-events-none transition-opacity duration-150 ease-out"
              style={{
                opacity: arrowIndicator.visible ? 1 : 0,
                transform: 'translate(-50%, -50%)',
              }}
            >
              {arrowIndicator.visible && (() => {
                const { activeDir } = arrowIndicator;
                const A = (d: string) => activeDir === d;

                return (
                  <div className="flex flex-col items-center gap-1 rounded-2xl bg-black/75 backdrop-blur-sm shadow-xl px-2.5 py-2">
                    {/* Up */}
                    <div className={`w-10 h-10 flex items-center justify-center rounded-xl transition-colors ${A('up') ? 'bg-white/25 text-white' : 'text-white/30'}`}>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M7 11l5-5 5 5"/></svg>
                    </div>
                    {/* Left / Right */}
                    <div className="flex items-center gap-1">
                      <div className={`w-10 h-10 flex items-center justify-center rounded-xl transition-colors ${A('left') ? 'bg-white/25 text-white' : 'text-white/30'}`}>
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
                      </div>
                      <div className="w-10 h-10 flex items-center justify-center rounded-xl text-white/15">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="4"/></svg>
                      </div>
                      <div className={`w-10 h-10 flex items-center justify-center rounded-xl transition-colors ${A('right') ? 'bg-white/25 text-white' : 'text-white/30'}`}>
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                      </div>
                    </div>
                    {/* Down */}
                    <div className={`w-10 h-10 flex items-center justify-center rounded-xl transition-colors ${A('down') ? 'bg-white/25 text-white' : 'text-white/30'}`}>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>
                    </div>
                  </div>
                );
              })()}
            </div>
          </>
        )}
      </div>
    );
  }
);

TerminalViewport.displayName = 'TerminalViewport';
