import React from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { TerminalTheme } from '../../terminal';
import type { TerminalChunk } from '../../terminal';
import type { TerminalRendererMode, TerminalEngine } from '../../terminal/renderer';
import { getTerminalModes, getCellMetrics, ensureGhosttyWasmReady } from '../../terminal/backend';
import { decideFitHysteresis } from '../../terminal/fitHysteresis';
import type { TerminalBackendType } from '../../terminal/backend';
import { useTouchScroll, type TouchScrollConfig } from '../../hooks/useTouchScroll';
import { useGesture } from '../../hooks/useGesture';
import { PRIORITY_LONG_PRESS, PRIORITY_TMUX_SCROLL } from '../../gesture/types';
import type { GestureAction } from '../../gesture/types';
import { light as hapticLight, medium as hapticMedium, success as hapticSuccess } from 'browser-haptic';
import { TerminalLoading, TerminalInitializing } from './TerminalLoading';
import { TerminalError } from './TerminalError';
import { createDebugLogger } from '../../utils/debug';

/**
 * 清洗用户输入，处理各种特殊字符
 * 1. 换行符统一转换为 CR (\r) - 终端标准
 * 2. Unicode 空格变体转换为普通空格
 * 3. 移除零宽字符
 */
/**
 * 探测当前环境是否支持 WebGL2,用于 auto 模式下的 renderer 降级。
 * 命中下述任一情况返回 false:
 *   - iOS / iPadOS:WebGL 在 mobile Safari 上选词 / long-press 全坏,
 *     长按选词根本不出 selection handle。强制走 DOM。
 *     依据:xterm.js #5377、#3727、#4894
 *   - WebGL2 context 创建失败:macOS 26.5 beta Safari WebGL 全屏绿
 *     条(#5816)、Linux Wayland 上某些驱动 / Firefox 严格模式等。
 *     依据:xterm.js #5816、#4728
 *   - 已知坏掉的 driver/mark:黑名单 UA 子串。
 *
 * 显式 `webgl` 模式不走这个探测(用户强制)——探测失败时由 enableWebglRenderer
 * 内部 try/catch fallback 到 canvas。
 *
 * 缓存到 module 级别:WebGL2 context 创建(canvas + getContext)成本不低;
 * rendererMode 切换会重跑 init useEffect,届时拿到缓存值即可。
 */
let _webglCapabilityCache: { result: boolean; iOS: boolean } | null = null;
function detectWebglCapability(): { supported: boolean; iOS: boolean } {
  if (_webglCapabilityCache) {
    return { supported: _webglCapabilityCache.result, iOS: _webglCapabilityCache.iOS };
  }
  let supported = true;
  let iOS = false;
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent;
    iOS = /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (iOS) {
      supported = false;
    } else if (typeof document !== 'undefined') {
      // 探测 WebGL2 context 能否创建
      try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2');
        if (!gl) {
          supported = false;
        } else {
          // 清理 probe canvas
          const loseExt = gl.getExtension('WEBGL_lose_context');
          loseExt?.loseContext();
        }
      } catch {
        supported = false;
      }
    }
  } else {
    supported = false;
  }
  _webglCapabilityCache = { result: supported, iOS };
  return { supported, iOS };
}

/**
 * 二分查找 chunks 数组中 id 等于 target 的位置。
 * store 端 chunkId 单调递增,数组本身也是单调追加,所以可以二分。
 * 替代原来的 O(n) findIndex,在密集输出(1k+ chunks)场景下提 100x。
 * 未找到返回 -1。
 */
function findChunkIndexById(chunks: TerminalChunk[], target: number): number {
  let lo = 0;
  let hi = chunks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const midId = chunks[mid].id;
    if (midId < target) {
      lo = mid + 1;
    } else if (midId > target) {
      hi = mid - 1;
    } else {
      return mid;
    }
  }
  return -1;
}

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

/**
 * 桌面端特殊键 → ANSI 转义序列映射
 * 所有这些序列都不应再被 TerminalView.handleViewportInput 二次叠加修饰符，
 * 由调用方传 { skipModifierTransform: true } 保证。
 */
const F_KEY_SEQ: Record<string, string> = {
  F1: '\x1bOP',  F2: '\x1bOQ',  F3: '\x1bOR',  F4: '\x1bOS',
  F5: '\x1b[15~', F6: '\x1b[17~', F7: '\x1b[18~', F8: '\x1b[19~',
  F9: '\x1b[20~', F10: '\x1b[21~', F11: '\x1b[23~', F12: '\x1b[24~',
};

function buildArrowSeq(terminal: Terminal, dir: 'A' | 'B' | 'C' | 'D', backend: TerminalBackendType): string {
  // application cursor mode (DECCKM)：vim/less 等会切到 \x1bO?,
  // shell 默认为 \x1b[?。xterm 在 modes 上暴露了这个状态。
  //
  // 注：ghostty 桌面端不再走这条路径——attachCustomKeyEventHandler 已改为只拦截
  // 系统级快捷键，方向键由 ghostty-web 自家 KeyEncoder（lib/input_handler.ts）
  // 通过 getModeCallback(1) 查 DECCKM 后输出正确字节。这里保留 ghostty 分支只是
  // 为了让函数签名在跨 backend 调用时不会爆编译错；实际不会被命中。
  if (backend === 'ghostty') {
    const appCursor = (terminal as any).getMode(1, false); // DECCKM
    return appCursor ? `\x1bO${dir}` : `\x1b[${dir}`;
  }
  const applicationCursor = terminal.modes?.applicationCursorKeysMode === true;
  return applicationCursor ? `\x1bO${dir}` : `\x1b[${dir}`;
}

/**
 * 把 React.KeyboardEvent 映射到终端转义序列。仅返回 PTY 应当收到的字节。
 * 不命中返回 null，调用方继续走默认逻辑（textarea 接管打印字符）。
 */
function mapSpecialKey(event: React.KeyboardEvent, terminal: Terminal, backend: TerminalBackendType): string | null {
  switch (event.key) {
    case 'ArrowUp':    return buildArrowSeq(terminal, 'A', backend);
    case 'ArrowDown':  return buildArrowSeq(terminal, 'B', backend);
    case 'ArrowRight': return buildArrowSeq(terminal, 'C', backend);
    case 'ArrowLeft':  return buildArrowSeq(terminal, 'D', backend);
    case 'Home':       return '\x1b[H';
    case 'End':        return '\x1b[F';
    case 'PageUp':     return '\x1b[5~';
    case 'PageDown':   return '\x1b[6~';
    case 'Insert':     return '\x1b[2~';
    case 'Delete':     return '\x1b[3~';
    case 'Tab':        return '\t';
    case 'Escape':     return '\x1b';
    default:
      if (F_KEY_SEQ[event.key]) return F_KEY_SEQ[event.key];
      return null;
  }
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

/**
 * 过滤 xterm 启动时会主动询问的设备属性回包,避免它们"穿过" PTY
 * 被打印成可见字符。
 *
 * xterm 在 `new Terminal()` 之后会通过 terminal.write 发一组设备探针:
 *   - DA1: \x1b[c                  → 期望回 \x1b[?<attrs>c
 *   - DA2: \x1b[>c                 → 期望回 \x1b[><version>c
 *   - DA3: \x1b[=c                 → 期望回 \x1b[!<unit>c (unit ID report)
 *   - DECRPM: \x1b[?...$p          → 期望回 \x1b[?...;$<mode>$y
 *   - DECRQM: \x1b[?$<mode>$p      → 期望回 \x1b[?<mode>;$<value>$y
 *
 * PTY 服务端在没回包前 xterm 会反复 fire 这些序列(尤其连接刚建立时);
 * shell 实现 (bash/zsh) 会回包,但回包可能与 xterm 自己的 echo 重叠,
 * 用户看到的就是一行行 "[?1;2c" / "[>0;276;0c"。
 *
 * 依据:eclipse-theia/theia terminal-widget-impl.ts:925, 948。
 * 维护一个 deviceStatusCodes 集合,只在 onData 入口过滤;不阻断用户正常输出。
 */
function processDeviceStatusResponses(data: string): { cleaned: string } {
  // 只过滤已知的设备响应序列(上面列出的几种),不阻断任何其他 SGR/CUP/etc。
  // 保守做法:只过滤明确以 \x1b[? 或 \x1b[> 开头且结尾是 c/$y 的小段。
  // 普通 cursor 移动 / SGR 颜色不受影响(不以 ?/>/! 开头或不以 c 结尾)。
  const filtered = data.replace(/\x1b\[\?[\d;]*[a-zA-Z]/g, (match) => {
    // 留下 SGR like \x1b[?...m,因为是颜色指令;但设备响应结尾是 c
    if (/[a-zA-Z]$/.test(match) && match.endsWith('c')) {
      return '';
    }
    return match;
  }).replace(/\x1b\[>[\d;]*c/g, '').replace(/\x1b\[=[\d;]*c/g, '').replace(/\x1b\[![\d;]*c/g, '');
  return { cleaned: filtered };
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

/**
 * 触发一次刷新的原因。所有刷新路径（mount / visibility / resize / swiper /
 * tmux-layout / session-reset / cmd-k / focus / WebGL 上下文丢失）都走
 * `requestRefresh(reason, options?)` 这一个入口，编排器在内部决定：
 *   - 是否重建 WebGL renderer
 *   - 是否需要 fit
 *   - 是否要推 resize 给服务端（first-fit immediate / 90ms debounce / skip）
 *   - 是否滚到底
 *   - 触发 throttle / dedupe
 */
export type RefreshReason =
  | 'mount'                  // xterm 首次初始化
  | 'init-fit'               // post-init timeout 之后的二次 fit
  | 'connected'              // WebSocket 已 connected
  | 'visibility'             // 页面从 hidden→visible
  | 'bfcache'                // 从 BFCache 恢复
  | 'online'                 // 网络恢复
  | 'page-flip'              // swiper 翻到本页（isActive 从 false→true）
  | 'resize'                 // ResizeObserver / 视口高度变化
  | 'dpr-change'             // devicePixelRatio 变化
  | 'tmux-layout'            // tmux 服务端报上来的布局
  | 'session-key-change'     // sessionKey 变化（切到别的 session）
  | 'session-reset'          // 新 chunks 到达（replay / history restore）
  | 'buffer-reset'           // terminal.reset() 之后
  | 'clear'                  // 用户主动 clear（cmd-k）
  | 'focus'                  // 输入框获焦
  | 'blur'                   // 输入框失焦
  | 'scroll'                 // 用户 wheel/touch 翻看本地 scrollback
  | 'webgl-context-loss';    // onContextLoss 回调

export type RefreshOptions = {
  /** 强制重建 renderer（即便 context 看起来还活着）。仅 'webgl-context-loss' 等极少数场景。 */
  forceRendererRecreate?: boolean;
  /** 不推 resize 给服务端（layout 来自服务端时，避免回环）。 */
  skipResizePush?: boolean;
  /** 不滚到底（alternate buffer / tmux copy-mode）。 */
  skipScrollToBottom?: boolean;
  /**
   * 不跑 fit。用于纯"显示状态变化"场景（page-flip / visibility / focus blur）：
   * 容器尺寸理论上没变，强行 fit 会因为 getBoundingClientRect 亚像素抖动 +
   * Math.floor 边界跨越导致 cols 跳 1，触发整页文字 reflow。
   * 即使没 skipFit，fitTerminal 内部对非"真实 resize" reason 也有 hysteresis
   * 兜底（cols/rows 差 < 2 时不接受）。
   */
  skipFit?: boolean;
  /** 服务端报上来的尺寸；如果比当前 xterm 小则忽略（防 shrink）。 */
  candidateSize?: { cols: number; rows: number };
  /** resize 推送的去抖窗口，默认 0（first-fit immediate）。 */
  resizeDebounceMs?: number;
  /** 跳过 throttle / dedupe。 */
  force?: boolean;
  /**
   * 自定义 dedupe key。编排器对每个 reason 维护"上次处理过的 key"：
   * 再次调用时 key 相同则整次跳过（不进 runRefreshSequence）。
   * 用途：tmux-layout 用 `sessionId:activePaneId` 过滤服务端重复推送。
   */
  dedupeKey?: string;
};

export type TerminalController = {
  focus: () => void;
  clear: () => void;
  /** 当前 xterm 的 cols/rows；xterm 未初始化时返回 null */
  getDimensions: () => { cols: number; rows: number } | null;
  /** 当前 backend 类型；用于上层根据 ghostty/xterm 区分 page-flip 之类行为。 */
  getBackendType: () => TerminalBackendType;
  /**
   * 唯一刷新入口。所有"我想让终端重画一下"的需求都走这里。
   * 多次连续调用会按 reason 合并，最后一次调用生效（last-call-wins per reason）。
   */
  requestRefresh: (reason: RefreshReason, options?: RefreshOptions) => void;
  /**
   * 标记 WS 已收到 connected 事件，之后的 resize push 才会真正发出去。
   * 必须在 TerminalView 的 `connected` 事件回调里调一次。
   * 切 session（session-key-change reason）会自动重置。
   */
  setSessionReady: (ready: boolean) => void;
};

export type TerminalViewportInputOptions = {
  skipModifierTransform?: boolean;
  consumeModifier?: boolean;
};

interface TerminalViewportProps {
  sessionKey: string;
  chunks: TerminalChunk[];
  onInput: (data: string, options?: TerminalViewportInputOptions) => void;
  onResize: (cols: number, rows: number) => void;
  onFlowControl?: (paused: boolean) => void;
  onTmuxScroll?: (direction: 'up' | 'down', lines: number) => void;
  tmuxScrollSensitivity?: number;
  onDoubleTap?: () => void;
  onInputFocusChange?: (isFocused: boolean) => void;
  rendererMode?: TerminalRendererMode;
  engine?: TerminalEngine;
  theme: TerminalTheme;
  fontFamily: string;
  fontSize: number;
  className?: string;
  enableTouchScroll?: boolean;
  autoFocus?: boolean;
}

type LoadingState = 'loading' | 'ready' | 'error';
const TEXTURE_ATLAS_REFRESH_DELAY_MS = 120;
const FLOW_CONTROL_HIGH_WATERMARK = 500_000; // bytes — pause PTY above this
const FLOW_CONTROL_LOW_WATERMARK = 100_000;  // bytes — resume PTY below this
const INPUT_BLUR_GUARD_ACTIVE_MS = 260;
const INPUT_BLUR_GUARD_RELEASE_MS = 140;
const KEYBOARD_OPEN_THRESHOLD_PX = 80;

function getTerminalConvertEol(hasTmuxScroll: boolean): boolean {
  // tmux/TUI 程序依赖精确的 CR/LF、scroll region 与局部清空语义。
  // `convertEol` 会把 LF 额外转换为 CRLF，对普通 shell 友好，但在 tmux
  // 里等价于让 Web client 和原生 Terminal 的终端语义不一致，容易放大
  // TUI 滚动时的空白区域残影。因此 tmux 模式保持原始字节语义。
  return !hasTmuxScroll;
}

/**
 * 等待终端使用的自托管字体加载完成，再让 xterm.js 实例化。
 *
 * 背景（xterm.js issue #1164 的根因）：xterm 在 `new Terminal()` 构造时就会
 * 用 fontFamily 测量 cell 宽高，如果此时 webfont 还没下载完成，xterm 会拿到
 * fallback 字体的尺寸，后续即使字体加载好也不会重新测量，从而导致光标错位
 * / 字符宽度算错 / canvas 重叠。VS Code、Hyper 都采用 document.fonts.ready
 * 守卫这一时机。
 *
 * 这里：
 *   - 用 module 级 promise 缓存，整个应用只等一次。
 *   - 显式 load 终端主字体 (JetBrains Mono NL Regular / Bold)，避免 unicode-range
 *     懒加载导致 ready 提前 resolve（document.fonts.ready 只等当前已注册的
 *     FontFace，懒加载字体在被使用前不会注册）。
 *   - 兼容老浏览器 / 测试环境：API 缺失时直接 resolve。
 *   - 任何加载失败都吞掉，让终端继续以 fallback 启动，不阻塞用户。
 */
let terminalFontsReadyPromise: Promise<void> | null = null;
const ensureTerminalFontsReady = (): Promise<void> => {
  if (terminalFontsReadyPromise) return terminalFontsReadyPromise;
  if (typeof document === 'undefined' || !('fonts' in document)) {
    terminalFontsReadyPromise = Promise.resolve();
    return terminalFontsReadyPromise;
  }
  const fonts = document.fonts;
  // 主字体显式预加载，触发 unicode-range 限定的 @font-face 真正下载。
  const preload = Promise.allSettled([
    fonts.load('400 13px "JetBrains Mono NL"'),
    fonts.load('700 13px "JetBrains Mono NL"'),
    fonts.load('400 13px "Symbols Nerd Font Mono"'),
  ]);
  terminalFontsReadyPromise = preload
    .then(() => fonts.ready)
    .then(() => undefined)
    .catch(() => undefined);
  return terminalFontsReadyPromise;
};

const getTerminalFontFamily = (userFontFamily: string): string => {
  // 单一来源：所有终端字体都从 :root 上的 --font-mono CSS 变量读取
  // （定义见 src/index.css）。这里保留 prop 形式只是兼容外部覆盖；当传入
  // 的字符串就是 var(...) 或为空时，回退到 documentElement 上的实际值，
  // xterm 的 canvas 渲染需要拿到一个具体的字体栈字符串而不是 var()。
  if (!userFontFamily || userFontFamily.includes('var(')) {
    if (typeof window !== 'undefined') {
      const resolved = getComputedStyle(document.documentElement)
        .getPropertyValue('--font-mono')
        .trim();
      if (resolved) return resolved;
    }
  }
  return userFontFamily;
};

// Convert TerminalTheme to a backend-agnostic theme object.
//
// Both xterm.js and ghostty-web 0.4.0+ accept the same xterm.js ITheme field set
// (background/foreground/cursor/cursorAccent/selectionBackground/selectionForeground
// + 16 ANSI colors). Note: ghostty-web's scrollbar is rendered on canvas via its
// own SelectionManager, so the xterm.js-specific scrollbar slider fields are dead
// code and intentionally omitted.
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
  };
}

const TerminalViewportInner = React.forwardRef<TerminalController, TerminalViewportProps>(
  (
    {
      sessionKey,
      chunks,
      onInput,
      onResize,
      onFlowControl,
      onTmuxScroll,
      tmuxScrollSensitivity = 0.55,
      onDoubleTap,
      onInputFocusChange,
      rendererMode = 'auto',
      engine = 'xterm',
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
    const ghosttyHostRef = React.useRef<HTMLDivElement>(null);
    const backendTypeRef = React.useRef<TerminalBackendType>(engine === 'ghostty' ? 'ghostty' : 'xterm');
    const viewportRef = React.useRef<HTMLElement | null>(null);
    const terminalRef = React.useRef<Terminal | null>(null);
    const fitAddonRef = React.useRef<FitAddon | null>(null);
    const inputHandlerRef = React.useRef<(data: string, options?: TerminalViewportInputOptions) => void>(onInput);
    const resizeHandlerRef = React.useRef<(cols: number, rows: number) => void>(onResize);
    const inputFocusHandlerRef = React.useRef<typeof onInputFocusChange>(onInputFocusChange);
    const flowControlHandlerRef = React.useRef<typeof onFlowControl>(onFlowControl);
    const lastReportedSizeRef = React.useRef<{ cols: number; rows: number } | null>(null);
    const pendingWriteRef = React.useRef('');
    const pendingBytesRef = React.useRef(0);
    const flowPausedRef = React.useRef(false);
    const writeScheduledRef = React.useRef<number | null>(null);
    const isWritingRef = React.useRef(false);
    const lastProcessedChunkIdRef = React.useRef<number | null>(null);
    const touchScrollCleanupRef = React.useRef<(() => void) | null>(null);
    const hiddenInputRef = React.useRef<HTMLTextAreaElement>(null);
    const remainderPxRef = React.useRef(0);
    const osc52RemainderRef = React.useRef('');
    const webglAddonRef = React.useRef<WebglAddon | null>(null);
    const webglContextLossDisposableRef = React.useRef<{ dispose: () => void } | null>(null);
    // 标记"我们已知 WebGL 上下文死了"。仅由 onContextLoss 回调置 true，
    // 每次新建 renderer 时由 enableWebglRenderer 置回 false。recoverRenderer
    // 只在确认死了时才走 dispose+recreate，避免盲拆活上下文导致一帧空白。
    const webglContextLostRef = React.useRef(false);
    const textureAtlasRefreshTimerRef = React.useRef<number | null>(null);
    // rAF 句柄：把 ResizeObserver 同一帧内的多次 fire 合并成一次 requestRefresh。
    // 防止 sidebar 折叠 / swiper 翻页瞬间 clientHeight=0 → fitAddon 算错 cols/rows
    // → WebGL renderer 在"mid texture-atlas rebuild"状态被连续两次 resize 打断。
    // 依据：NousResearch/hermes-agent use-terminal-session.ts:350-377
    const resizeRafRef = React.useRef<number | null>(null);
    // 记录 init useEffect 上次跑过的 fontSize / fontFamily / theme 值。
    // 当 effect 再次被触发时,先比对这三个值:如果只是它们变了而 xterm 后端已
    // 就绪,走 setOption 路径(live update),不整体 destroy+rebuild。
    // ghostty 模式不享受这个优化(Canvas 2D 重建视觉很轻,直接走原路径)。
    // 依据：huashengdun/webssh main.js:152-167, VS Code setOption 路径。
    const lastInitFontSizeRef = React.useRef<number | null>(null);
    const lastInitFontFamilyRef = React.useRef<string | null>(null);
    const lastInitThemeRef = React.useRef<typeof theme | null>(null);
    const lastDevicePixelRatioRef = React.useRef(
      typeof window !== 'undefined' ? window.devicePixelRatio : 1
    );
    const isComposingRef = React.useRef(false);
    // composition 刚结束的时间戳：IME 选词紧随 compositionend 之后会补发一记
    // keydown(Enter) / beforeinput(insertLineBreak)，我们用时间窗口吞掉。
    const lastCompositionEndAtRef = React.useRef(0);
    const sentValueRef = React.useRef('');
    const wheelHandlerRef = React.useRef<((event: WheelEvent) => void) | null>(null);
    // 桌面 tmux wheel：累积像素余数，凑满 1 行立即发
    const desktopWheelRemainderRef = React.useRef(0);
    const keepInputFocusUntilRef = React.useRef(0);
    const lastTouchInteractionAtRef = React.useRef(0);
    const lastFocusHiddenInputAtRef = React.useRef(0);
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
    // 桌面 IME 候选窗锚点：跟随 xterm 光标的 1 cell 大小区域
    // mobile（enableTouchScroll=true）下不使用，textarea 仍然 inset:0 全覆盖
    const [imeAnchor, setImeAnchor] = React.useState<{ x: number; y: number; cellW: number; cellH: number }>(
      { x: 0, y: 0, cellW: 8, cellH: 17 }
    );
    // composition 期间锚点冻结：后台 PTY 仍可能输出导致 onRender 触发，
    // 此时若仍跟着 cursor 移动 textarea，候选窗会甩飞、文字会抖。
    const imeFrozenAnchorRef = React.useRef<{ x: number; y: number; cellW: number; cellH: number } | null>(null);
    // 桌面 IME 行内显示状态：composition 期间把 textarea 显形为
    // 「带下划线、不透明背景遮住下方 xterm」的可见 overlay。
    const [imeComposition, setImeComposition] = React.useState<{ active: boolean; text: string }>({
      active: false,
      text: '',
    });
    const arrowIndicatorRef = React.useRef<HTMLDivElement>(null);
    const tabIndicatorTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    inputHandlerRef.current = onInput;
    resizeHandlerRef.current = onResize;
    inputFocusHandlerRef.current = onInputFocusChange;
    flowControlHandlerRef.current = onFlowControl;
    const autoFocusRef = React.useRef(autoFocus);
    autoFocusRef.current = autoFocus;
    const enableTouchScrollRef = React.useRef(enableTouchScroll);
    enableTouchScrollRef.current = enableTouchScroll;
    const hasTmuxScroll = !!onTmuxScroll;
    const terminalConvertEol = getTerminalConvertEol(hasTmuxScroll);

    // xterm's WebGL renderer is fast, but on mobile tmux scrollback it can
    // occasionally present stale row textures while tmux copy-mode is rapidly
    // repainting the viewport.  The terminal buffer itself is correct, but the
    // rendered rows appear to "jump".  Keep explicit WebGL available for users
    // who opt in, but make Auto prefer the built-in renderer for mobile tmux
    // sessions (identified by onTmuxScroll) where correctness matters more.
    //
    // 额外:auto 模式下,如果环境探测出不支持 WebGL(iOS / WebGL2 创建失败),
    // 强制走 canvas renderer,避免 init 时 WebglAddon 抛错再 fallback 多花
    // 一个 rAF 的时间 + 一帧空白。显式 webgl 模式不探测(用户强制)——
    // 探测失败由 enableWebglRenderer 内部 try/catch 兜底。
    //
    // 已知风险(xterm.js #5986):当前 @xterm/addon-webgl@0.19.0 仍带
    // gl.generateMipmap bug,Linux/Wayland + Intel Arc 上 WebGL 字形 atlas
    // 会出现黑方块/斜条纹。0.20.0-beta 已修复(删 mipmap),但 beta.284 peer
    // 依赖 @xterm/xterm@^6.1.0-beta.285(也是 beta)。保守决策:保持 0.19.0
    // stable,等 0.20.0 stable 后再统一升级 xterm + addon。升级时再跑一遍
    // htop/nvim 滚动 smoke test 验证黑方块消失。
    const webglCapability = rendererMode === 'auto' ? detectWebglCapability() : null;
    const webglSupported = webglCapability?.supported ?? true;
    const shouldUseWebgl = (rendererMode === 'webgl' || (rendererMode === 'auto' && !(enableTouchScroll && onTmuxScroll))) && webglSupported;

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
      const modes = getTerminalModes(terminal, backendTypeRef.current);

      if (modes.mouseTrackingMode !== 'none') {
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
        // 'scroll' reason 走 requestRefresh 编排器(经 ref 间接调,避免
        // useCallback TDZ —— requestRefresh 在本组件下方声明,hook 顺序
        // 要求 dep list 必须包含,这里用 ref 模式让 closure 拿最新值)。
        // WebGL 路径下 scheduleTextureAtlasRefresh(120ms 防抖) 让 atlas
        // 在滑动期间自愈 stale row;DOM 路径直接 refresh(0, rows-1)。
        // 依据:xterm.js + addon-webgl 0.19 在 scrollback 边界有漏画行
        // / stale row 的已知问题 (#4480/#4534 sister)。
        // runRefreshSequence 内 'scroll' 分支只刷 atlas,不动 fit /
        // resize push / scrollToBottom,不会有额外重排成本。
        requestRefreshRef.current?.('scroll', { skipFit: true, skipResizePush: true, skipScrollToBottom: true });
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
      const linesToSend = Math.max(1, Math.min(Math.abs(scrollLines), 10));
      onTmuxScroll!(direction, linesToSend);
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

    // Touch pointerdown 与 props 更新可能错开 1-2 帧，导致偶发：
    // 手势开始时 onTmuxScroll 还没切到 true，normal-scroll 抢先 claim 一段；
    // 随后 tmux-scroll 生效又接管，表现为“先普通滚动再内部滚动”。
    // 锁定 pointerdown 时刻的 tmux 判定，整次手势内保持一致，避免双路径串行。
    const gestureModeSnapshotRef = React.useRef<{
      pointerId: number | null;
      tmuxActiveAtDown: boolean;
    }>({ pointerId: null, tmuxActiveAtDown: false });

    React.useEffect(() => {
      if (!enableTouchScroll) return;

      const container = containerRef.current;
      if (!container) return;

      const handlePointerDownCapture = (event: PointerEvent) => {
        if (event.pointerType !== 'touch') return;
        gestureModeSnapshotRef.current.pointerId = event.pointerId;
        gestureModeSnapshotRef.current.tmuxActiveAtDown = !!onTmuxScrollRef.current;
      };

      const clearSnapshotIfMatches = (event: PointerEvent) => {
        if (event.pointerType !== 'touch') return;
        if (gestureModeSnapshotRef.current.pointerId !== event.pointerId) return;
        gestureModeSnapshotRef.current.pointerId = null;
        gestureModeSnapshotRef.current.tmuxActiveAtDown = false;
      };

      container.addEventListener('pointerdown', handlePointerDownCapture, { capture: true, passive: true });
      container.addEventListener('pointerup', clearSnapshotIfMatches, { capture: true, passive: true });
      container.addEventListener('pointercancel', clearSnapshotIfMatches, { capture: true, passive: true });

      return () => {
        container.removeEventListener('pointerdown', handlePointerDownCapture, true);
        container.removeEventListener('pointerup', clearSnapshotIfMatches, true);
        container.removeEventListener('pointercancel', clearSnapshotIfMatches, true);
      };
    }, [enableTouchScroll]);

    const canNormalScrollGestureClaim = React.useCallback(() => {
      const snap = gestureModeSnapshotRef.current;
      if (snap.pointerId !== null) {
        return !snap.tmuxActiveAtDown;
      }
      return !onTmuxScrollRef.current;
    }, []);

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
      if (getTerminalModes(terminal, backendTypeRef.current).mouseTrackingMode !== 'none') {
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
          // 与 xterm 默认行为一致：输入即清选区，避免选区残留遮挡输出
          try { terminalRef.current?.clearSelection(); } catch { /* ignored */ }
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

    /**
     * 桌面端：发一段已经编码好的转义序列（特殊键 / Ctrl+letter / Alt+letter / 粘贴）。
     * 1. 清空 textarea + sentValueRef，让下一次打印输入对齐
     * 2. clearSelection()：与 xterm 默认"输入即清选区"行为一致
     * 3. 带 skipModifierTransform 让 TerminalView 不再叠加移动端修饰符工具栏的状态
     */
    const sendTerminalSeq = React.useCallback((seq: string, textarea?: HTMLTextAreaElement | null) => {
      if (!seq) return;
      const target = textarea ?? hiddenInputRef.current;
      if (target) {
        target.value = '';
      }
      sentValueRef.current = '';
      try { terminalRef.current?.clearSelection(); } catch { /* ignored */ }
      inputHandlerRef.current(seq, { skipModifierTransform: true });
    }, []);

    /**
     * 桌面端：根据 xterm 当前光标位置计算 IME 候选窗锚点。
     * 候选窗会跟着 textarea 的视觉位置走；textarea 是 1 cell 大小，
     * caret 在 (0,0) 即等于终端光标位置。
     */
    const updateImeAnchor = React.useCallback(() => {
      if (enableTouchScroll) return;
      // composition 中冻结：后台 PTY 输出会触发 onRender，不能让 textarea
      // 跟着 cursor 走，否则候选窗会漂、文字会抖。
      if (imeFrozenAnchorRef.current) return;
      const term = terminalRef.current;
      if (!term || !term.element) return;

      let cellW = 8;
      let cellH = 17;
      try {
        const metrics = getCellMetrics(term, backendTypeRef.current);
        cellW = metrics.cellWidth;
        cellH = metrics.cellHeight;
      } catch { /* fall through to fallback */ }

      if (cellW <= 0 || cellH <= 0) {
        const rect = term.element.getBoundingClientRect();
        if (rect.width > 0 && term.cols > 0) cellW = rect.width / term.cols;
        if (rect.height > 0 && term.rows > 0) cellH = rect.height / term.rows;
      }

      const buf = term.buffer.active;
      const x = Math.round(buf.cursorX * cellW);
      const y = Math.round(buf.cursorY * cellH);

      setImeAnchor((prev) => {
        if (
          Math.abs(prev.x - x) < 0.5 &&
          Math.abs(prev.y - y) < 0.5 &&
          Math.abs(prev.cellW - cellW) < 0.5 &&
          Math.abs(prev.cellH - cellH) < 0.5
        ) {
          return prev;
        }
        return { x, y, cellW, cellH };
      });
    }, [enableTouchScroll]);

    const updateImeAnchorRef = React.useRef(updateImeAnchor);
    updateImeAnchorRef.current = updateImeAnchor;

    /**
     * 估算 IME composition 文本在终端格子坐标系下的视觉宽度(单位:cell)。
     * CJK / East-Asian-Wide 一字 2 cell，其余 1 cell。
     */
    const estimateImeTextCells = React.useCallback((text: string): number => {
      let cells = 0;
      for (const ch of text) {
        const cp = ch.codePointAt(0) ?? 0;
        // 简化判断：CJK 统一汉字、平假名/片假名、CJK 标点、全角符号、Hangul 等
        const isWide =
          (cp >= 0x1100 && cp <= 0x115F) ||
          (cp >= 0x2E80 && cp <= 0x303E) ||
          (cp >= 0x3041 && cp <= 0x33FF) ||
          (cp >= 0x3400 && cp <= 0x4DBF) ||
          (cp >= 0x4E00 && cp <= 0x9FFF) ||
          (cp >= 0xA000 && cp <= 0xA4CF) ||
          (cp >= 0xAC00 && cp <= 0xD7A3) ||
          (cp >= 0xF900 && cp <= 0xFAFF) ||
          (cp >= 0xFE30 && cp <= 0xFE4F) ||
          (cp >= 0xFF00 && cp <= 0xFF60) ||
          (cp >= 0xFFE0 && cp <= 0xFFE6) ||
          (cp >= 0x1F300 && cp <= 0x1FAFF);
        cells += isWide ? 2 : 1;
      }
      return cells;
    }, []);

    /**
     * 根据 composition text + 当前锚点 + term.cols 计算 textarea overlay 尺寸。
     * 单行能放下就单行；放不下走 wrap 到下一(可视)行。
     */
    const getImeOverlayMetrics = React.useCallback(
      (text: string): {
        width: number;
        height: number;
        whiteSpace: 'pre' | 'pre-wrap';
      } => {
        const term = terminalRef.current;
        const { cellW, cellH } = imeAnchor;
        if (!term || !text) {
          return {
            width: Math.max(1, Math.round(cellW)),
            height: Math.max(1, Math.round(cellH)),
            whiteSpace: 'pre',
          };
        }
        // 当前光标格子（从冻结快照取，避免 buffer 在 onRender 中变动）
        const frozen = imeFrozenAnchorRef.current;
        const cursorX = frozen
          ? Math.floor(frozen.x / Math.max(1, cellW))
          : term.buffer.active.cursorX;
        const cols = Math.max(1, term.cols);
        const estCells = Math.max(1, estimateImeTextCells(text));
        const availInline = Math.max(1, cols - cursorX);

        if (estCells <= availInline) {
          return {
            width: Math.max(1, Math.round(estCells * cellW)),
            height: Math.max(1, Math.round(cellH)),
            whiteSpace: 'pre',
          };
        }
        // wrap：第一行从 cursorX 开始；之后每行 cols 个 cell
        const remaining = estCells - availInline;
        const extraLines = Math.ceil(remaining / cols);
        const totalLines = 1 + extraLines;
        return {
          width: Math.max(1, Math.round(availInline * cellW)),
          height: Math.max(1, Math.round(totalLines * cellH)),
          whiteSpace: 'pre-wrap',
        };
      },
      [imeAnchor, estimateImeTextCells]
    );

    const freezeImeAnchor = React.useCallback(() => {
      imeFrozenAnchorRef.current = { ...imeAnchor };
    }, [imeAnchor]);

    const releaseImeAnchor = React.useCallback(() => {
      imeFrozenAnchorRef.current = null;
    }, []);


    const focusHiddenInput = React.useCallback((_clientX?: number, _clientY?: number) => {
      const touchEnabled = enableTouchScrollRef.current;
      // Desktop Ghostty should use ghostty-web's native contenteditable/key handler.
      // Mobile Ghostty must keep using our full-screen overlay textarea so the
      // soft keyboard has a real input target and text flows through diff-sync.
      if (backendTypeRef.current === 'ghostty' && !touchEnabled) {
        try { terminalRef.current?.focus(); } catch { /* ignored */ }
        return;
      }
      const input = hiddenInputRef.current;
      if (!input) {
        return;
      }

      try {
        input.removeAttribute('readonly');

        const alreadyFocused = typeof document !== 'undefined' && document.activeElement === input;
        const keyboardGone = alreadyFocused && !isViewportKeyboardLikelyOpen();
        const now = nowMs();
        const cooldownMs = now - lastFocusHiddenInputAtRef.current;
        lastFocusHiddenInputAtRef.current = now;

        if (keyboardGone && cooldownMs > 600) {
          input.blur();
          input.removeAttribute('readonly');
          input.focus();
          lastFocusHiddenInputAtRef.current = nowMs();
        } else {
          input.focus();
        }
      } catch { /* ignored */ }
    }, [isViewportKeyboardLikelyOpen, nowMs]);

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
    // Handlers stay mounted in both modes, but claim is gated by
    // pointerdown-time tmux snapshot so one gesture only runs one path.
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
      canStartScrollGesture: canNormalScrollGestureClaim,
      onScroll: handleScroll,
      onScrollWithCoords: handleScroll,
      onClickWithCoords: handleClick,
      onTap: stableOnTap,
      onClaimChange: notifyGestureLock,
      tapThreshold: 12,
      gestureName: `normal-scroll:${sessionKey}`,
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

    // ---- Tmux-mode touch scroll (registered via GestureManager) ----
    // Priority PRIORITY_TMUX_SCROLL (80) fires AFTER long-press (90) but
    // BEFORE normal-scroll (70).  Sends SGR (1006) mouse wheel escape
    // sequences directly through the PTY instead of server-side tmux
    // copy-mode commands.

    const tmuxScrollStateRef = React.useRef<{
      pointerId: number | null;
      lastX: number | null;
      lastY: number | null;
      startX: number | null;
      startY: number | null;
      gestureAxis: 'x' | 'y' | null;
      remainder: number;
      didScroll: boolean;
      rafId: number | null;
      velocity: number;
      instantSpeed: number;
    }>({
      pointerId: null,
      lastX: null,
      lastY: null,
      startX: null,
      startY: null,
      gestureAxis: null,
      remainder: 0,
      didScroll: false,
      rafId: null,
      velocity: 0,
      instantSpeed: 0,
    });

    const tmuxStopRaf = React.useCallback(() => {
      const st = tmuxScrollStateRef.current;
      if (st.rafId !== null) {
        cancelAnimationFrame(st.rafId);
        st.rafId = null;
      }
    }, []);

    const tmuxBuildSgrScroll = React.useCallback((direction: 'up' | 'down', clientX?: number, clientY?: number): string | null => {
      const term = terminalRef.current;
      if (!term || !term.element || !term.cols || !term.rows) return null;
      const st = tmuxScrollStateRef.current;
      const rect = term.element.getBoundingClientRect();
      const sourceX = clientX ?? st.lastX ?? rect.left + rect.width / 2;
      const sourceY = clientY ?? st.lastY ?? rect.top + rect.height / 2;
      const rx = sourceX - rect.left;
      const ry = sourceY - rect.top;
      const charW = term.element.offsetWidth / term.cols || 8;
      const charH = term.element.offsetHeight / term.rows || 16;
      const col = Math.max(1, Math.min(term.cols, Math.floor(rx / charW) + 1));
      const row = Math.max(1, Math.min(term.rows, Math.floor(ry / charH) + 1));
      const button = direction === 'up' ? 64 : 65;
      return `\x1b[<${button};${col};${row}M`;
    }, []);

    const tmuxSendSgrScroll = React.useCallback((direction: 'up' | 'down', count: number, clientX?: number, clientY?: number) => {
      if (count <= 0) return;
      const seq = tmuxBuildSgrScroll(direction, clientX, clientY);
      if (!seq) return;
      // 把 N 个 SGR 序列拼成一条 string 一次性写进 PTY。
      // tmux 在收到时会逐个解析为 mouse wheel 事件，效果完全等价，
      // 但只产生 1 次 ws.send + 1 次 PTY write，不会被高频调用打爆。
      inputHandlerRef.current(count === 1 ? seq : seq.repeat(count));
    }, [tmuxBuildSgrScroll]);

    // 桌面 wheel handler 是闭包注册一次的，不能直接捕获 useCallback；
    // 用 ref 桥接到最新版本。
    const tmuxSendSgrScrollRef = React.useRef(tmuxSendSgrScroll);
    tmuxSendSgrScrollRef.current = tmuxSendSgrScroll;

    const tmuxDynamicEff = React.useCallback((): number => {
      const lineHeightPx = Math.max(12, Math.round(fontSize * 1.35));
      const eff = lineHeightPx / Math.max(0.1, tmuxScrollSensitivity);
      const factor = 1 + tmuxScrollStateRef.current.instantSpeed * 0.10;
      return eff / Math.min(6, factor);
    }, [fontSize, tmuxScrollSensitivity]);

    const tmuxTick = React.useCallback(() => {
      const st = tmuxScrollStateRef.current;
      st.rafId = null;

      const deff = tmuxDynamicEff();
      let linesUp = 0;
      let linesDown = 0;

      while ((linesUp + linesDown) < 8 && st.remainder >= deff) {
        st.remainder -= deff;
        linesDown++;
      }
      while ((linesUp + linesDown) < 8 && st.remainder <= -deff) {
        st.remainder += deff;
        linesUp++;
      }

      if (linesDown > 0) tmuxSendSgrScroll('down', linesDown);
      if (linesUp > 0) tmuxSendSgrScroll('up', linesUp);

      const consumed = linesUp + linesDown;
      if (consumed > 0) {
        st.rafId = requestAnimationFrame(tmuxTick);
      } else if (st.pointerId !== null && Math.abs(st.remainder) >= deff / 3) {
        const dir = st.remainder > 0 ? 'down' : 'up';
        st.remainder = 0;
        tmuxSendSgrScroll(dir, 1);
        st.rafId = requestAnimationFrame(tmuxTick);
      }
    }, [tmuxDynamicEff, tmuxSendSgrScroll]);

    const tmuxScheduleTick = React.useCallback(() => {
      const st = tmuxScrollStateRef.current;
      if (st.rafId === null && typeof requestAnimationFrame !== 'undefined') {
        st.rafId = requestAnimationFrame(tmuxTick);
      }
    }, [tmuxTick]);

    const tmux_onPointerDown = React.useCallback((e: PointerEvent): boolean => {
      if (e.pointerType !== 'touch') return false;
      tmuxStopRaf();
      const st = tmuxScrollStateRef.current;
      st.pointerId = e.pointerId;
      st.lastX = e.clientX;
      st.lastY = e.clientY;
      st.startX = e.clientX;
      st.startY = e.clientY;
      st.gestureAxis = null;
      st.remainder = 0;
      st.velocity = 0;
      st.instantSpeed = 0;
      st.didScroll = false;
      return false;
    }, [tmuxStopRaf]);

    const tmux_onPointerMove = React.useCallback((e: PointerEvent, isClaimed: boolean): GestureAction => {
      const st = tmuxScrollStateRef.current;
      if (e.pointerType !== 'touch' || e.pointerId !== st.pointerId) return 'neutral';
      if (st.lastY == null) return 'neutral';

      if (st.gestureAxis === null && st.startX !== null && st.startY !== null) {
        const absDx = Math.abs(e.clientX - st.startX);
        const absDy = Math.abs(e.clientY - st.startY);
        const axisThreshold = 8;
        if (absDx > axisThreshold || absDy > axisThreshold) {
          if (absDx > absDy * 1.06) {
            st.gestureAxis = 'x';
            return 'release';
          } else if (absDy > absDx * 1.06) {
            st.gestureAxis = 'y';
          }
        }
      }

      if (st.gestureAxis === 'x') {
        st.lastX = e.clientX;
        st.lastY = e.clientY;
        return 'release';
      }

      if (st.gestureAxis === null) {
        st.lastX = e.clientX;
        st.lastY = e.clientY;
        return 'neutral';
      }

      const deltaY = e.clientY - st.lastY;
      st.lastX = e.clientX;
      st.lastY = e.clientY;

      const deltaPixels = -deltaY;
      st.remainder += deltaPixels;
      st.instantSpeed = Math.abs(deltaPixels);
      st.velocity = st.velocity * 0.45 + deltaPixels * 0.55;

      if (isClaimed) {
        const lineHeightPx = Math.max(12, Math.round(fontSize * 1.35));
        const eff = lineHeightPx / Math.max(0.1, tmuxScrollSensitivity);
        if (Math.abs(st.remainder) >= eff / 3) {
          st.didScroll = true;
          tmuxScheduleTick();
        }
      }

      return 'claim';
    }, [fontSize, tmuxScrollSensitivity, tmuxScheduleTick]);

    const tmux_onPointerUp = React.useCallback((e: PointerEvent): void => {
      const st = tmuxScrollStateRef.current;
      if (e.pointerType !== 'touch' || e.pointerId !== st.pointerId) return;
      tmuxStopRaf();
      st.pointerId = null;
      st.lastX = null;
      st.lastY = null;
      st.startX = null;
      st.startY = null;
      st.instantSpeed = 0;

      if (st.gestureAxis === 'x') {
        st.gestureAxis = null;
        return;
      }
      st.gestureAxis = null;

      const lineHeightPx = Math.max(12, Math.round(fontSize * 1.35));
      const eff = lineHeightPx / Math.max(0.1, tmuxScrollSensitivity);

      if (st.didScroll && Math.abs(st.velocity) > eff * 0.05) {
        const decay = () => {
          st.velocity *= 0.96;
          st.remainder += st.velocity;
          const factor = 1 + Math.abs(st.velocity) * 0.10;
          const deff = eff / Math.min(6, factor);
          if (Math.abs(st.velocity) < eff * 0.08) {
            if (Math.abs(st.remainder) >= deff / 3) {
              const dir = st.remainder > 0 ? 'down' : 'up';
              tmuxSendSgrScroll(dir, 1);
              st.remainder = 0;
            }
            st.velocity = 0;
            st.rafId = null;
            return;
          }
          let linesUp = 0;
          let linesDown = 0;
          while ((linesUp + linesDown) < 8 && st.remainder >= deff) {
            st.remainder -= deff;
            linesDown++;
          }
          while ((linesUp + linesDown) < 8 && st.remainder <= -deff) {
            st.remainder += deff;
            linesUp++;
          }
          if (linesDown > 0) tmuxSendSgrScroll('down', linesDown);
          if (linesUp > 0) tmuxSendSgrScroll('up', linesUp);
          st.rafId = requestAnimationFrame(decay);
        };
        st.rafId = requestAnimationFrame(decay);
      } else if (Math.abs(st.remainder) >= eff / 3) {
        tmuxScheduleTick();
      }

      if (st.didScroll) {
        e.stopImmediatePropagation();
      }
    }, [tmuxStopRaf, tmuxSendSgrScroll, tmuxScheduleTick, tmuxScrollSensitivity, fontSize]);

    const tmux_onPointerCancel = React.useCallback((e: PointerEvent): void => {
      const st = tmuxScrollStateRef.current;
      if (e.pointerType !== 'touch' || e.pointerId !== st.pointerId) return;
      tmuxStopRaf();
      st.pointerId = null;
      st.lastX = null;
      st.lastY = null;
      st.startX = null;
      st.startY = null;
      st.gestureAxis = null;
      st.remainder = 0;
      st.velocity = 0;
      st.didScroll = false;
    }, [tmuxStopRaf]);

    useGesture({
      name: `tmux-scroll:${sessionKey}`,
      priority: PRIORITY_TMUX_SCROLL,
      container: () => containerRef.current,
      onPointerDown: (enableTouchScroll && onTmuxScroll) ? tmux_onPointerDown : undefined,
      onPointerMove: (enableTouchScroll && onTmuxScroll) ? tmux_onPointerMove : undefined,
      onPointerUp: (enableTouchScroll && onTmuxScroll) ? tmux_onPointerUp : undefined,
      onPointerCancel: (enableTouchScroll && onTmuxScroll) ? tmux_onPointerCancel : undefined,
    });

    // ---- Mobile gesture capture (long-press arrows + double-tap Tab) ----
    // Registered via GestureManager at priority PRIORITY_LONG_PRESS (90).
    // UseGesture callbacks use stable refs so they never rebuild.
    const lpStateRef = React.useRef<{
      pointerId: number | null;
      originX: number;
      originY: number;
      holdTimer: ReturnType<typeof setTimeout> | null;
      mode: 'idle' | 'holding' | 'arrow';
      joystickDir: '' | 'up' | 'down' | 'left' | 'right';
      joystickRepeatTimer: ReturnType<typeof setTimeout> | null;
      repeatIntervalMs: number;
      lastHapticTime: number;
      lastTapTime: number;
      lastTapX: number;
      lastTapY: number;
      tapStartX: number;
      tapStartY: number;
      tapDidMove: boolean;
    }>({
      pointerId: null,
      originX: 0,
      originY: 0,
      holdTimer: null,
      mode: 'idle',
      joystickDir: '',
      joystickRepeatTimer: null,
      repeatIntervalMs: 260,
      lastHapticTime: 0,
      lastTapTime: 0,
      lastTapX: 0,
      lastTapY: 0,
      tapStartX: 0,
      tapStartY: 0,
      tapDidMove: false,
    });

    const containerForGestureRef = React.useRef<HTMLElement | null>(null);
    containerForGestureRef.current = containerRef.current;

    const lpContainerRef = containerForGestureRef;
    const lp_inputHandlerRef = inputHandlerRef;

    const lp_onPointerDown = React.useCallback((e: PointerEvent): boolean => {
      if (e.pointerType !== 'touch') return false;

      const container = lpContainerRef.current;
      if (!container) return false;

      const target = e.target;
      if (!(target instanceof HTMLElement)) return false;
      if (!container.contains(target)) return false;
      if (target.closest('[data-mobile-keyboard="true"]')) return false;

      const s = lpStateRef.current;

      if (s.mode === 'arrow') return true;

      if (onDoubleTapRef.current) {
        const now = performance.now();
        const x = e.clientX;
        const y = e.clientY;

        if (
          s.lastTapTime !== 0 &&
          now - s.lastTapTime <= 150 &&
          Math.hypot(x - s.lastTapX, y - s.lastTapY) <= 25
        ) {
          // 双击模式 (success preset: [20,50,20]) — 语义上契合"双击成功"
          hapticSuccess();
          onDoubleTapRef.current?.();
          setTabIndicator(true);
          if (tabIndicatorTimerRef.current) clearTimeout(tabIndicatorTimerRef.current);
          tabIndicatorTimerRef.current = setTimeout(() => setTabIndicator(false), 400);
          s.lastTapTime = 0;
          return true;
        }
      }

      if (s.holdTimer !== null) {
        clearTimeout(s.holdTimer);
        s.holdTimer = null;
      }
      if (s.joystickRepeatTimer !== null) {
        clearTimeout(s.joystickRepeatTimer);
        s.joystickRepeatTimer = null;
      }
      s.joystickDir = '';
      s.pointerId = e.pointerId;
      s.originX = e.clientX;
      s.originY = e.clientY;
      s.tapStartX = e.clientX;
      s.tapStartY = e.clientY;
      s.tapDidMove = false;
      s.mode = 'holding';

      s.holdTimer = setTimeout(() => {
        s.holdTimer = null;
        if (s.mode === 'holding') {
          s.mode = 'arrow';
          // 模式切换(进入方向键模式)— medium 比 light 更明确地告诉用户"切了"
          hapticMedium();
          notifyGestureLock(true);
          requestAnimationFrame(() => {
            setArrowIndicator({ visible: true, activeDir: '' });
          });
        }
      }, 350);

      return true;
    }, []);

    const lp_onPointerMove = React.useCallback((e: PointerEvent, isClaimed: boolean): GestureAction => {
      if (e.pointerType !== 'touch') return 'neutral';

      const s = lpStateRef.current;

      if (s.mode === 'arrow' && e.pointerId !== s.pointerId) return 'neutral';

      if (s.mode !== 'arrow' && e.pointerId !== s.pointerId) return 'neutral';

      const totalDx = e.clientX - s.tapStartX;
      const totalDy = e.clientY - s.tapStartY;
      if (Math.hypot(totalDx, totalDy) > 10) {
        s.tapDidMove = true;
      }

      if (s.mode === 'holding') {
        if (!isClaimed) {
          if (s.holdTimer !== null) {
            clearTimeout(s.holdTimer);
            s.holdTimer = null;
          }
          s.mode = 'idle';
          return 'neutral';
        }
        const dx = e.clientX - s.originX;
        const dy = e.clientY - s.originY;
        if (Math.hypot(dx, dy) > 20) {
          if (s.holdTimer !== null) {
            clearTimeout(s.holdTimer);
            s.holdTimer = null;
          }
          s.mode = 'idle';
          return 'release';
        }
        return 'claim';
      }

      if (s.mode === 'arrow') {
        if (!isClaimed) return 'claim';
        const ARROW_SEQUENCES: Record<string, string> = {
          up: '\x1b[A',
          down: '\x1b[B',
          left: '\x1b[D',
          right: '\x1b[C',
        };

        // Direction is always relative to the long-press origin so the
        // indicator stays perfectly in sync with the finger's actual
        // movement direction — no drift from origin resets.
        const dx = e.clientX - s.tapStartX;
        const dy = e.clientY - s.tapStartY;
        const dist = Math.hypot(dx, dy);

        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);

        let newDir: '' | 'up' | 'down' | 'left' | 'right' = '';
        if (dist > 12) {
          // Require a clear directional intent: the dominant axis must be at
          // least 1.5× the other.  This prevents accidental direction switches
          // when the finger drifts diagonally (e.g. 13px right, 12px down).
          const AXIS_RATIO = 1.5;
          if (absDx >= absDy * AXIS_RATIO) {
            newDir = dx > 0 ? 'right' : 'left';
          } else if (absDy >= absDx * AXIS_RATIO) {
            newDir = dy > 0 ? 'down' : 'up';
          }
          // else: ambiguous diagonal — keep previous direction (or none)
        }

        // Track incremental movement for repeat-rate control
        if (newDir && newDir !== s.joystickDir) {
          s.originX = e.clientX;
          s.originY = e.clientY;
        }

        if (newDir) {
          const newDx = e.clientX - s.originX;
          const newDy = e.clientY - s.originY;
          const newDist = Math.hypot(newDx, newDy);

          const excess = Math.min(newDist - 12, 80 - 12);
          const ratio = excess / (80 - 12);
          const intervalMs = 260 - ratio * (260 - 80);
          // Store for the running timer to pick up on its next iteration
          s.repeatIntervalMs = intervalMs;

          if (newDir !== s.joystickDir) {
            // Direction changed — fire immediately, start repeat with initial delay
            if (s.joystickRepeatTimer !== null) {
              clearTimeout(s.joystickRepeatTimer);
            }
            const isInitialActivation = s.joystickDir === '';
            s.joystickDir = newDir;
            lp_inputHandlerRef.current(ARROW_SEQUENCES[newDir]);
            // 初次激活用 medium(模式刚启动,需要明确反馈),方向切换用 light
            if (isInitialActivation) {
              hapticMedium();
            } else {
              hapticLight();
            }
            s.lastHapticTime = performance.now();
            // First activation: longer delay (user likely wants single step)
            // Direction switch: shorter delay (already in motion, wants responsive change)
            const initialDelay = isInitialActivation ? 400 : 300;
            s.joystickRepeatTimer = setTimeout(function repeat() {
              if (s.joystickDir !== newDir) return;
              lp_inputHandlerRef.current(ARROW_SEQUENCES[newDir]);
              const t = performance.now();
              if (t - s.lastHapticTime > 120) {
                hapticLight();
                s.lastHapticTime = t;
              }
              s.joystickRepeatTimer = setTimeout(repeat, s.repeatIntervalMs);
            }, initialDelay);
          }
          // Same direction — don't restart timer; it picks up repeatIntervalMs
          // on its next iteration, so speed adapts smoothly to finger distance.
          setArrowIndicator({ visible: true, activeDir: newDir });
        } else {
          if (s.joystickRepeatTimer !== null) {
            clearTimeout(s.joystickRepeatTimer);
            s.joystickRepeatTimer = null;
          }
          s.joystickDir = '';
          setArrowIndicator({ visible: true, activeDir: '' });
        }
        return 'claim';
      }
      return 'neutral';
    }, []);

    const lp_onPointerUp = React.useCallback((e: PointerEvent) => {
      if (e.pointerType !== 'touch' || e.pointerId !== lpStateRef.current.pointerId) return;

      const s = lpStateRef.current;

      if (s.mode === 'arrow') {
        notifyGestureLock(false);
        setArrowIndicator({ visible: false, activeDir: '' });
        if (s.holdTimer !== null) { clearTimeout(s.holdTimer); s.holdTimer = null; }
        if (s.joystickRepeatTimer !== null) { clearTimeout(s.joystickRepeatTimer); s.joystickRepeatTimer = null; }
        s.joystickDir = '';
        s.pointerId = null;
        s.mode = 'idle';
        return;
      }

      const container = lpContainerRef.current;
      if (container && !s.tapDidMove) {
        const target = e.target;
        if (target instanceof HTMLElement && container.contains(target) && !target.closest('[data-mobile-keyboard="true"]')) {
          s.lastTapTime = performance.now();
          s.lastTapX = e.clientX;
          s.lastTapY = e.clientY;
        }
      } else if (s.tapDidMove) {
        s.lastTapTime = 0;
      }

      if (s.holdTimer !== null) { clearTimeout(s.holdTimer); s.holdTimer = null; }
      if (s.joystickRepeatTimer !== null) { clearTimeout(s.joystickRepeatTimer); s.joystickRepeatTimer = null; }
      s.joystickDir = '';
      s.pointerId = null;
      s.mode = 'idle';
    }, []);

    const lp_onPointerCancel = React.useCallback(() => {
      const s = lpStateRef.current;
      if (s.mode === 'arrow') {
        notifyGestureLock(false);
        setArrowIndicator({ visible: false, activeDir: '' });
      }
      if (s.holdTimer !== null) { clearTimeout(s.holdTimer); s.holdTimer = null; }
      if (s.joystickRepeatTimer !== null) { clearTimeout(s.joystickRepeatTimer); s.joystickRepeatTimer = null; }
      s.joystickDir = '';
      s.pointerId = null;
      s.tapDidMove = false;
      s.mode = 'idle';
    }, []);

    useGesture({
      name: `long-press:${sessionKey}`,
      priority: PRIORITY_LONG_PRESS,
      container: () => containerRef.current,
      onPointerDown: enableTouchScroll ? lp_onPointerDown : undefined,
      onPointerMove: enableTouchScroll ? lp_onPointerMove : undefined,
      onPointerUp: enableTouchScroll ? lp_onPointerUp : undefined,
      onPointerCancel: enableTouchScroll ? lp_onPointerCancel : undefined,
    });

    const resetWriteState = React.useCallback(() => {
      pendingWriteRef.current = '';
      pendingBytesRef.current = 0;
      flowPausedRef.current = false;
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
      // Hysteresis：
      // 翻页 / visibility / focus 等"非真实尺寸变化"的 reason，容器宽高理论
      // 上没变。但 getBoundingClientRect 在亚像素 layout 上有微小抖动（swiper
      // transform 合成层、字号微调、DPR 非整数都会触发），rect.width 哪怕只动
      // 0.05px，只要跨过 metrics.width * N 的边界，floor 结果就跳 1 列。
      // 一旦 cols 跳了，terminal.resize 会让 ghostty wasm 全文本重 wrap → 整页
      // 文字"抖一下"。
      //
      // 决策表抽到 ../../terminal/fitHysteresis.ts（带单测）。这里只调用。
      try {
        const before = { cols: terminal.cols, rows: terminal.rows };
        if (backendTypeRef.current === 'ghostty') {
          const metrics = (terminal as any).renderer?.getMetrics?.();
          if (!metrics || metrics.width <= 0 || metrics.height <= 0) {
            throw new Error('ghostty metrics unavailable');
          }
          const nextCols = Math.max(2, Math.floor(rect.width / metrics.width));
          const nextRows = Math.max(1, Math.floor(rect.height / metrics.height));
          const decision = decideFitHysteresis({
            reason,
            currentCols: terminal.cols,
            currentRows: terminal.rows,
            proposedCols: nextCols,
            proposedRows: nextRows,
          });
          if (decision.accept) {
            terminal.resize(nextCols, nextRows);
          } else if (decision.colsDelta > 0 || decision.rowsDelta > 0) {
            debugTerminal('fit suppressed by hysteresis', {
              reason, before, proposed: { cols: nextCols, rows: nextRows },
              colsDelta: decision.colsDelta, rowsDelta: decision.rowsDelta,
            });
          }
        } else {
          // xterm 路径：FitAddon.fit() 内部也是 floor，同样会亚像素抖动。
          // 先 proposeDimensions 看看要不要真 fit；不满足 hysteresis 就放弃。
          const proposed: { cols: number; rows: number } | undefined =
            (fitAddon as { proposeDimensions?: () => { cols: number; rows: number } | undefined }).proposeDimensions?.();
          if (proposed && proposed.cols > 0 && proposed.rows > 0) {
            const decision = decideFitHysteresis({
              reason,
              currentCols: terminal.cols,
              currentRows: terminal.rows,
              proposedCols: proposed.cols,
              proposedRows: proposed.rows,
            });
            if (decision.accept) {
              fitAddon.fit();
            } else if (decision.colsDelta > 0 || decision.rowsDelta > 0) {
              debugTerminal('fit suppressed by hysteresis', {
                reason, before, proposed,
                colsDelta: decision.colsDelta, rowsDelta: decision.rowsDelta,
              });
            }
          } else {
            // proposeDimensions 拿不到，退回到 fit()（首次 fit / FitAddon 实现差异）
            fitAddon.fit();
          }
        }
        const next = { cols: terminal.cols, rows: terminal.rows };
        const previous = lastReportedSizeRef.current;

        debugTerminal('fit', {
          reason,
          backend: backendTypeRef.current,
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
      } catch {
        // fit failure is non-fatal; the next refresh attempt will retry.
      }
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
    }, [clearTextureAtlasRefreshTimer, debugTerminal, sessionKey]);

    const scheduleTextureAtlasRefresh = React.useCallback((reason: string) => {
      if (typeof window === 'undefined') {
        return;
      }

      clearTextureAtlasRefreshTimer();

      textureAtlasRefreshTimerRef.current = window.setTimeout(() => {
        textureAtlasRefreshTimerRef.current = null;
        refreshTextureAtlasNow(reason);
      }, TEXTURE_ATLAS_REFRESH_DELAY_MS);
    }, [clearTextureAtlasRefreshTimer, refreshTextureAtlasNow, sessionKey]);

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
          webglContextLostRef.current = true;
          // 走编排器：forceRendererRecreate=true 一定重建；异步 setTimeout
          // 是为了避开 onContextLoss 回调内同步重建的死循环（xterm 内部
          // 同步调用 nextTick，会卡住）。
          if (typeof window !== 'undefined') {
            window.setTimeout(() => {
              requestRefresh('webgl-context-loss', { forceRendererRecreate: true });
            }, 0);
          }
        });

        terminal.loadAddon(webglAddon);
        webglAddonRef.current = webglAddon;
        // 拿到一个新 renderer，先乐观地认为它的上下文是活的
        webglContextLostRef.current = false;

        debugTerminal('renderer', {
          type: 'webgl',
          reason,
          mobile: enableTouchScroll,
          mode: rendererMode,
        });
        // 新建 renderer 后立即同步刷新一次，确保字符立刻正确
        refreshTextureAtlasNow(`webgl-enabled:${reason}`);
        rendererReadyRef.current = true;
        return true;
      } catch (error) {
        debugTerminal('webgl load failed, fallback to canvas', {
          reason,
          error,
          mobile: enableTouchScroll,
          mode: rendererMode,
        });
        // WebGL 失败后会落到 canvas renderer（init useEffect 会跑下面的
        // 兜底分支并显式 setReady）。这里保持 false 即可。
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

    // ============================================================
    // 刷新编排器（orchestrator）
    // ------------------------------------------------------------
    // 所有"我想让终端重画一下"的入口都收编到 requestRefresh()。
    // 每次调用按 reason 走同一条确定性序列：
    //   1) throttle：visibility/bfcache/online 在 200ms 内只跑一次
    //   2) dedupe：同 reason 的连续调用合并，最后一次生效
    //   3) renderer：context 已知死或 forceRendererRecreate → 重建
    //                否则 → refreshTextureAtlasNow（清 atlas + 重绘）
    //   4) fit() → 拿到新 cols/rows
    //   5) resize push：first-fit immediate / 90ms debounce / skip-if-same /
    //                   candidateSize 防 shrink
    //   6) 滚底（非 alternate buffer 且未 skipScrollToBottom）→ rAF 等稳定
    // ============================================================

    const DEFAULT_RESIZE_DEBOUNCE_MS = 90;
    const RESUME_THROTTLE_MS = 200;

    // 每个 reason 上一次被调用的时间戳（用于 visibility/bfcache/online 互斥）
    const lastResumeAtRef = React.useRef(0);
    // 同 reason 的 pending rAF 句柄：连续调用只保留最后一次
    const pendingReasonRafRef = React.useRef<Map<RefreshReason, number>>(new Map());
    // resize 推送给服务端的 debounce 句柄（per fit cycle）
    const pendingResizeTimerRef = React.useRef<number | null>(null);
    // last sent to server，first-fit immediate 路径用它做"和上次一样就不发"判定
    const lastServerSizeRef = React.useRef<{ cols: number; rows: number } | null>(null);
    // 上次 fit 后 xterm 实际尺寸（用于 tmux candidateSize 防 shrink 等比较）
    const lastFittedDimsRef = React.useRef<{ cols: number; rows: number } | null>(null);
    // 每个 reason 上一次处理的 dedupeKey（用于 tmux-layout 之类的服务端重复推送）
    const lastDedupeKeyRef = React.useRef<Map<RefreshReason, string>>(new Map());
    // renderer 是否已就绪（enableWebglRenderer / canvas fallback 完成）
    const rendererReadyRef = React.useRef(false);
    // session（WS）是否已 ready：必须等 WS connected 事件到达，pushResizeToServer
    // 才会真正发出去。否则 reload 后 ResizeObserver 在 ensureSession 跑完之前
    // 就会用 OLD session id 推 resize，server 直接 404。
    const sessionReadyRef = React.useRef(false);

    const cancelPendingReasonRaf = React.useCallback((reason: RefreshReason) => {
      const map = pendingReasonRafRef.current;
      const id = map.get(reason);
      if (id !== undefined) {
        cancelAnimationFrame(id);
        map.delete(reason);
      }
    }, []);

    const cancelAllPendingReasonRafs = React.useCallback(() => {
      const map = pendingReasonRafRef.current;
      map.forEach((id) => cancelAnimationFrame(id));
      map.clear();
    }, []);

    const cancelPendingResizeTimer = React.useCallback(() => {
      if (pendingResizeTimerRef.current !== null) {
        window.clearTimeout(pendingResizeTimerRef.current);
        pendingResizeTimerRef.current = null;
      }
    }, []);

    const pushResizeToServer = React.useCallback(
      (cols: number, rows: number, debounceMs: number) => {
        cancelPendingResizeTimer();
        const last = lastServerSizeRef.current;
        if (last && last.cols === cols && last.rows === rows) {
          // 尺寸没变，不发
          return;
        }
        if (!sessionReadyRef.current) {
          // WS 还没收到 connected 事件：不能推 resize 给服务端。
          // 之前 (没有这个 gate) 会用旧的 terminalIdRef 直接 POST，
          // 后端 404、WS 4001，触发 auto-recreate，白白浪费一次往返。
          // 这里把 dims "记账" 一下，等 sessionReady 后由 connected 自身
          // 的 pushResizeToServer（first-fit immediate 路径）来真正发。
          // 关键：lastServerSizeRef 不更新，否则后续 same-size 会被 skip，
          // connected 那次就发不出来了。
          return;
        }
        if (debounceMs <= 0 || last === null) {
          // first-fit immediate
          lastServerSizeRef.current = { cols, rows };
          resizeHandlerRef.current(cols, rows);
          return;
        }
        pendingResizeTimerRef.current = window.setTimeout(() => {
          pendingResizeTimerRef.current = null;
          lastServerSizeRef.current = { cols, rows };
          resizeHandlerRef.current(cols, rows);
        }, debounceMs);
      },
      [cancelPendingResizeTimer]
    );

    const runRefreshSequence = React.useCallback(
      (reason: RefreshReason, options: RefreshOptions) => {
        const terminal = terminalRef.current;
        const fitAddon = fitAddonRef.current;
        if (!terminal || !fitAddon) {
          return;
        }

        // 0) renderer 必须就绪（init useEffect 已经调过 enableWebglRenderer
        //    或 canvas fallback）。否则这次 requestRefresh 是 useImperativeHandle
        //    ref attach 早于 init useEffect 时跑出来的早期调用——直接 bail，
        //    后续的 mount/connected/tmux-layout 会再触发一次。
        if (!rendererReadyRef.current) {
          debugTerminal('refresh skipped: renderer not ready', { reason });
          return;
        }

        // 'scroll' reason 走一条精简路径：只刷 atlas（WebGL 路径下避免滑动
        // 时的 stale row），不 fit、不推 resize、不滚底、不重建 renderer。
        // 用户已经在滚动了,fit/重建会引入额外的重排成本 + 一帧错位。
        if (reason === 'scroll') {
          if (backendTypeRef.current === 'ghostty') {
            (terminal as { refresh?: (start: number, end: number) => void }).refresh?.(0, terminal.rows - 1);
          } else if (shouldUseWebgl) {
            // scheduleTextureAtlasRefresh 走 120ms 防抖:滑动期间反复 fire 也
            // 只真正清 atlas 一次,避免 atlas 清空期间密集输出卡顿。
            scheduleTextureAtlasRefresh(`refresh:scroll`);
          } else {
            // DOM renderer 路径,直接 refresh 即可,不需要 atlas
            try {
              terminal.refresh(0, Math.max(0, terminal.rows - 1));
            } catch { /* ignored */ }
          }
          return;
        }

        // 0.5) dedupeKey：相同 reason + 相同 key 直接跳过，避免 tmux 服务端
        //      重复 layout 推送造成 fit/refresh 风暴。
        if (options.dedupeKey !== undefined) {
          const lastKey = lastDedupeKeyRef.current.get(reason);
          if (lastKey === options.dedupeKey) {
            debugTerminal('refresh deduped', { reason, dedupeKey: options.dedupeKey });
            return;
          }
          lastDedupeKeyRef.current.set(reason, options.dedupeKey);
        }

        debugTerminal('refresh', { reason, options });

        // 1) Renderer 决策
        const needsRecreate = options.forceRendererRecreate === true || webglContextLostRef.current;
        if (needsRecreate) {
          webglContextLostRef.current = false;
          if (backendTypeRef.current === 'ghostty') {
            // ghostty-web has no xterm-style refresh(); fit/resize below will
            // trigger its canvas renderer. Keep this branch non-throwing so
            // keyboard/viewport resize can continue to fitTerminal().
            (terminal as { refresh?: (start: number, end: number) => void }).refresh?.(0, terminal.rows - 1);
          } else if (shouldUseWebgl) {
            disposeWebglRenderer(`refresh:${reason}`);
            enableWebglRenderer(terminal, `refresh:${reason}`);
          } else {
            refreshTextureAtlasNow(`refresh:${reason}`);
          }
        } else {
          // 上下文还活着或 canvas renderer：只清 atlas + 重绘
          if (backendTypeRef.current === 'ghostty') {
            (terminal as { refresh?: (start: number, end: number) => void }).refresh?.(0, terminal.rows - 1);
          } else {
            refreshTextureAtlasNow(`refresh:${reason}`);
          }
        }

        // 2) fit() —— 这一步会触发 xterm 的 onResize
        const before = { cols: terminal.cols, rows: terminal.rows };
        if (!options.skipFit) {
          fitTerminal(`refresh:${reason}`);
        }
        const after = { cols: terminal.cols, rows: terminal.rows };
        lastFittedDimsRef.current = after;

        // 3) Resize push
        if (!options.skipResizePush) {
          // candidateSize 防 shrink：服务端报上来的尺寸如果比当前 xterm 小，忽略
          if (options.candidateSize) {
            const c = options.candidateSize;
            if (c.cols < after.cols || c.rows < after.rows) {
              // 已经在请求的尺寸之上，不缩
            } else {
              const debounce = options.resizeDebounceMs ?? DEFAULT_RESIZE_DEBOUNCE_MS;
              pushResizeToServer(c.cols, c.rows, debounce);
            }
          } else {
            // 跳过没变化的情况（before/after 完全一致 + 上次 fit 之后没新数据）
            if (before.cols !== after.cols || before.rows !== after.rows || lastServerSizeRef.current === null) {
              const debounce = options.resizeDebounceMs ?? DEFAULT_RESIZE_DEBOUNCE_MS;
              pushResizeToServer(after.cols, after.rows, debounce);
            }
          }
        }

        // 4) ScrollToBottom：fit() 已经先把 rows 切完了,这里同步 scroll 即可,
        // 不用再开一个 rAF。外层 requestRefresh 已经在 rAF 内调 runRefreshSequence,
        // 再嵌套 rAF 多走一帧 + 多一个 pendingReasonRafRef 维护成本。
        // (历史上有"等 viewport 切到新 rows"的考虑,实测 fit 之后 cols/rows
        // 已稳定,scrollToBottom 同步跑不会错位。)
        if (!options.skipScrollToBottom) {
          if (terminal.buffer.active.type !== 'alternate') {
            try {
              terminal.scrollToBottom();
            } catch { /* ignore */ }
          }
        }
      },
      [
        debugTerminal,
        shouldUseWebgl,
        disposeWebglRenderer,
        enableWebglRenderer,
        refreshTextureAtlasNow,
        fitTerminal,
        pushResizeToServer,
      ]
    );

    // 间接 ref 模式:让 handleNormalScroll(更早声明)能调用 requestRefresh
    // 而不报 useCallback TDZ。useEffect 内同步 ref。
    const requestRefreshRef = React.useRef<
      ((reason: RefreshReason, options?: RefreshOptions) => void) | null
    >(null);

    const requestRefresh = React.useCallback(
      (reason: RefreshReason, options: RefreshOptions = {}) => {
        const terminal = terminalRef.current;
        if (!terminal) {
          // xterm 还没初始化，mount/connected/init-fit 这些 reason 在 init useEffect
          // 里调也没问题，编排器会等下一帧再跑。
        }

        // 0) session-key-change 强制重置所有跟踪状态（lastServerSize、lastFittedDims、
        //    dedupe keys、pending rAF、pending timer），让下一个 session 的 first-fit 走 immediate 路径
        if (reason === 'session-key-change') {
          lastServerSizeRef.current = null;
          lastFittedDimsRef.current = null;
          lastDedupeKeyRef.current.clear();
          cancelPendingResizeTimer();
          cancelAllPendingReasonRafs();
        }

        // 1) Throttle：visibility / bfcache / online 互斥，200ms 内只跑一次
        if (!options.force) {
          if (reason === 'visibility' || reason === 'bfcache' || reason === 'online') {
            const now = Date.now();
            if (now - lastResumeAtRef.current < RESUME_THROTTLE_MS) {
              debugTerminal('refresh throttled', { reason });
              return;
            }
            lastResumeAtRef.current = now;
          }
        }

        // 2) Dedupe：同 reason 的 pending rAF 取消，只保留最后一次
        cancelPendingReasonRaf(reason);

        // 3) 调度：rAF 内跑序列（runRefreshSequence 内的 scrollToBottom
        // 已经合并到同一 rAF,不再嵌套)
        const raf = requestAnimationFrame(() => {
          pendingReasonRafRef.current.delete(reason);
          runRefreshSequence(reason, options);
        });
        pendingReasonRafRef.current.set(reason, raf);
      },
      [
        debugTerminal,
        cancelPendingReasonRaf,
        cancelAllPendingReasonRafs,
        cancelPendingResizeTimer,
        runRefreshSequence,
      ]
    );

    // 同步 ref 给 handleNormalScroll 等早期声明的 hook 用。
    // useEffect 内每次 render 同步(因为 requestRefresh 引用稳定时也更新 ref,
    // 但 requestRefresh 实际上每次 render 都返回新 useCallback —— 这里成本
    // 是 1 个 ref 赋值,无副作用)。
    React.useEffect(() => {
      requestRefreshRef.current = requestRefresh;
      return () => {
        requestRefreshRef.current = null;
      };
    }, [requestRefresh]);

    // 组件 unmount / sessionKey 变化时清理所有 pending raf 和 timer
    React.useEffect(() => {
      return () => {
        cancelAllPendingReasonRafs();
        cancelPendingResizeTimer();
      };
    }, [sessionKey, cancelAllPendingReasonRafs, cancelPendingResizeTimer]);

    // sessionKey 变化 = 切到别的 session = 重置 lastServerSize / lastFittedDims /
    // dedupe keys / renderer-ready，让下一个 session 的 first-fit 走 immediate 路径
    React.useEffect(() => {
      lastServerSizeRef.current = null;
      lastFittedDimsRef.current = null;
      lastDedupeKeyRef.current.clear();
      cancelPendingResizeTimer();
      // renderer 状态不在这里重置：disposeWebglRenderer 在 cleanup 跑，
      // 下一次 init useEffect 会再 enableWebglRenderer 并把 ready 置 true。
    }, [sessionKey, cancelPendingResizeTimer]);

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
      const chunkBytes = chunk.length;
      pendingWriteRef.current = '';

      isWritingRef.current = true;
      // 抽成 finishWrite 让 try/catch 两条路径用同一份 bookkeeping：成功路径
      // 由 term.write 的 ack callback 调；失败路径（term.write 同步抛）由
      // catch 立刻调，否则 isWritingRef / pendingBytes / flow-control 都会
      // 永久泄漏。ghostty-web 0.4.0 在罕见情况下会抛 "memory access out of
      // bounds"（WASM 堆 race），不能让一个 chunk 烧穿整个 terminal。
      const finishWrite = () => {
        isWritingRef.current = false;
        pendingBytesRef.current -= chunkBytes;
        if (pendingBytesRef.current < 0) pendingBytesRef.current = 0;

        // Flow control: resume PTY if paused and below low watermark
        if (flowPausedRef.current && pendingBytesRef.current < FLOW_CONTROL_LOW_WATERMARK) {
          flowPausedRef.current = false;
          flowControlHandlerRef.current?.(false);
        }

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
      };
      try {
        term.write(chunk, finishWrite);
      } catch (err) {
        if (typeof console !== 'undefined') {
          console.warn('[web-terminal] terminal.write threw; dropping chunk', err);
        }
        finishWrite();
      }
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
        pendingBytesRef.current += data.length;

        // Flow control: pause PTY if above high watermark
        if (!flowPausedRef.current && pendingBytesRef.current >= FLOW_CONTROL_HIGH_WATERMARK) {
          flowPausedRef.current = true;
          flowControlHandlerRef.current?.(true);
        }

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

      // 早 bail:仅 fontSize / fontFamily / theme 变了 && xterm 后端 && 已有 terminal
      // 走 setOption 路径,不整体 dispose + 重建。
      // ghostty 后端不走这个 bail:Canvas 2D 重建视觉上很轻,而且 ghostty-web
      // 0.4.0 的 options proxy 行为脆弱(参见 2378-2386 的 scrollbarOpacity
      // 修绕过),保守让 ghostty 走整体重建。
      const existing = terminalRef.current;
      const fontSizeChanged = lastInitFontSizeRef.current !== null && lastInitFontSizeRef.current !== fontSize;
      const fontFamilyChanged = lastInitFontFamilyRef.current !== null && lastInitFontFamilyRef.current !== fontFamily;
      const themeChanged = lastInitThemeRef.current !== null && lastInitThemeRef.current !== theme;
      if (
        existing &&
        backendTypeRef.current === 'xterm' &&
        (fontSizeChanged || fontFamilyChanged || themeChanged)
      ) {
        // 记录新值(让下次 effect 跑能正确判断"是不是又变了")
        lastInitFontSizeRef.current = fontSize;
        lastInitFontFamilyRef.current = fontFamily;
        lastInitThemeRef.current = theme;

        // ghostty 模式的 terminal 变量在 if 分支里是 const,这里需要重新拿
        const term = existing as Terminal;
        let liveUpdateSucceeded = true;
        try {
          if (fontSizeChanged) term.options.fontSize = fontSize;
          if (fontFamilyChanged) term.options.fontFamily = getTerminalFontFamily(fontFamily);
          if (themeChanged) term.options.theme = convertTheme(theme);
        } catch (error) {
          // setOption 失败(极少见,某些 addon 会 lock 住 options)→ 退到完整重建
          debugTerminal('live option update failed, falling back to rebuild', { error });
          liveUpdateSucceeded = false;
        }
        if (liveUpdateSucceeded) {
          // setOption 成功:等 web font 加载完再 fit,避免 webssh 注释里说的
          // "字体切换瞬间 cell 测量走 fallback,事后字体加载好也不会重测"
          // 依据:huashengdun/webssh main.js:152-167
          if (fontFamilyChanged) {
            void ensureTerminalFontsReady().then(() => {
              if (disposed) return;
              fitTerminal('live-option-font');
              refreshTextureAtlasNow('live-option-font');
              requestRefresh('resize', { resizeDebounceMs: 0 });
            });
          } else {
            // 字号/主题切换不需要等 font:同步 fit + atlas 刷新 + resize 推送
            fitTerminal('live-option-style');
            refreshTextureAtlasNow('live-option-style');
            requestRefresh('resize', { resizeDebounceMs: 0 });
          }
          // 早 bail:返回的 cleanup 啥也不做(terminal 还在,observer/IME 都没变)
          return () => { /* no-op: live update only, terminal not torn down */ };
        }
      }

      container.tabIndex = enableTouchScroll ? -1 : 0;

      const initialize = async () => {
        setLoadingState('loading');
        setErrorMessage(null);
        setIsInitializing(true);

        // 等终端字体加载完成再实例化 xterm，否则 cell 测量会用 fallback 字体
        // 的尺寸，事后字体加载好也不会重测，导致光标错位。详见
        // ensureTerminalFontsReady 文档。
        await ensureTerminalFontsReady();
        if (disposed) return;

        try {
          const isGhostty = engine === 'ghostty';
          backendTypeRef.current = isGhostty ? 'ghostty' : 'xterm';

          let terminal: any;
          let fitAddon: any;

          if (isGhostty) {
            // ---- ghostty-web backend ----
            const ghosttyMod = await ensureGhosttyWasmReady();
            if (disposed) return;

            const GhosttyTerminal = ghosttyMod.Terminal;
            const GhosttyFitAddon = ghosttyMod.FitAddon;

            terminal = new GhosttyTerminal({
              fontFamily: getTerminalFontFamily(fontFamily),
              fontSize,
              theme: convertTheme(theme),
              cursorBlink: true,
              cursorStyle: 'block',
              scrollback: onTmuxScroll ? 2000 : 5000,
              allowTransparency: false,
              convertEol: terminalConvertEol,
              // 关闭默认 100ms smooth scroll：项目自己有 requestRefresh /
              // scrollToBottom 编排器，再叠 100ms 平滑滚动会出现双驱动 + 残影。
              smoothScrollDuration: 0,
              // 显式锁定：未来 ghostty-web 默认值变化时也不会影响 read path。
              disableStdin: false,
            });

            fitAddon = new GhosttyFitAddon();
            // ghostty-web 0.4.0 的 FitAddon.proposeDimensions 在 clientWidth
            // 上硬扣 ~15px 给"假想的滚动条"留宽，但 ghostty 的滚动条画在
            // canvas 上不占布局，结果是右侧固定丢 1~2 列。重写一下 cols 的
            // 计算，从 clientWidth - paddingX 直接除以 cellWidth，rows 仍
            // 沿用上游算法（高度方向没扣保留）。
            //
            // HMR guard：React StrictMode / Vite HMR 在 dev 下会让这个 useEffect
            // 跑多轮（上一轮 cleanup 跑过 dispose，但模块级状态没清），同一个
            // fitAddon 实例被 patch 多次,补丁链会越包越深。没有 HMR guard 的话
            // 调 proposeDimensions 时会按"原函数 → 第一次 patch → 第二次 patch
            // → ..." 链式递归,直到 stack overflow。
            {
              const anyFit = fitAddon as any;
              if (!anyFit.__webTerminalProposePatch) {
                const origPropose = anyFit.proposeDimensions.bind(fitAddon);
                anyFit.proposeDimensions = () => {
                const dims = origPropose();
                if (!dims) return dims;
                try {
                  const renderer: any = (terminal as any).renderer;
                  const el: HTMLElement | undefined = (terminal as any).element;
                  const metrics = renderer?.getMetrics?.();
                  if (!renderer || !el || !metrics?.width) return dims;
                  const style = window.getComputedStyle(el);
                  const padLeft = parseInt(style.paddingLeft || '0', 10) || 0;
                  const padRight = parseInt(style.paddingRight || '0', 10) || 0;
                  const usableW = el.clientWidth - padLeft - padRight;
                  if (usableW <= 0) return dims;
                  const cols = Math.max(2, Math.floor(usableW / metrics.width));
                  // 不让 patch 后的结果反而比 ghostty 自己算的更小（极端布局
                  // 比如 padding 异常时退回原值，宁少勿乱）。
                  return { cols: Math.max(cols, dims.cols), rows: dims.rows };
                } catch {
                  return dims;
                }
              };
                anyFit.__webTerminalProposePatch = true;
              }
            }
            terminal.loadAddon(fitAddon);
          } else {
            // ---- xterm.js backend ----
            terminal = new Terminal({
              fontFamily: getTerminalFontFamily(fontFamily),
              fontSize,
              theme: convertTheme(theme),
              cursorBlink: true,
              cursorStyle: 'block',
              cursorInactiveStyle: 'bar',
              scrollback: onTmuxScroll ? 2000 : 5000,
              allowTransparency: false,
              allowProposedApi: true,
              convertEol: terminalConvertEol,
              customGlyphs: true,
              rescaleOverlappingGlyphs: true,
              letterSpacing: 0,
              lineHeight: 1,
              // VS Code 显式开启（xterm.js 默认 false）。`clear` / `Ctrl-L` / ED2
              // 时光标必须滚到底，否则屏幕顶部留一片旧输出。
              // 依据：xterm.js OptionsService.ts:75 + microsoft/vscode xtermTerminal.ts:215
              scrollOnEraseInDisplay: true,
              // VS Code 显式开启（xterm.js 6.0 新增，默认 false）。末行 resize 后
              // 字符必须 reflow,否则缩小列数时最右一列会"消失"。
              // 依据：xterm.js #5213 + Buffer._isReflowEnabled
              reflowCursorLine: true,
              // tmux / iTerm 必需：让 xterm 正确响应 CSI 16/18 cell-size 查询。
              // 依据：microsoft/vscode xtermTerminal.ts:228-232
              windowOptions: {
                getCellSizePixels: true,
                getWinSizePixels: true,
                getWinSizeChars: true,
              },
              overviewRuler: {
                width: 0,
              },
            });

            fitAddon = new FitAddon();
            // Patch proposeDimensions to never subtract scrollbar width.
            const originalPropose = fitAddon.proposeDimensions.bind(fitAddon);
            fitAddon.proposeDimensions = () => {
              const saved = terminal.options.scrollback;
              terminal.options.scrollback = 0;
              const dims = originalPropose();
              terminal.options.scrollback = saved;
              return dims;
            };
            terminal.loadAddon(fitAddon);
            terminal.loadAddon(new Unicode11Addon());
            terminal.unicode.activeVersion = '11';
            terminal.loadAddon(new SearchAddon());
            terminal.loadAddon(new WebLinksAddon());
          }

          localTerminal = terminal;
          terminalRef.current = terminal;
          fitAddonRef.current = fitAddon;
          // 记录本次 init 的 fontSize/fontFamily/theme,让下次 effect 跑能
          // 比对"是不是仅这三者变了"(命中则走 setOption 路径,不重建)
          lastInitFontSizeRef.current = fontSize;
          lastInitFontFamilyRef.current = fontFamily;
          lastInitThemeRef.current = theme;
          lastDevicePixelRatioRef.current = typeof window !== 'undefined' ? window.devicePixelRatio : 1;

          const terminalHost = isGhostty ? ghosttyHostRef.current : container;
          if (!terminalHost) {
            throw new Error('Terminal host is not ready');
          }
          // 防御性 replaceChildren：React 18 StrictMode 在 dev 下会跑两次
          // effect（setup→cleanup→setup）。若上一轮 init 已经把 ghostty 的
          // canvas/textarea 追加进了 terminalHost，新一轮 terminal.open 还会
          // 再追加，肉眼可见"双光标 / 双输入"。这里清场一次保险。xterm 用
          // container 直接挂 DOM tree 不需要这步。
          if (isGhostty) {
            try { terminalHost.replaceChildren(); } catch { /* ignored */ }
          }
          terminal.open(terminalHost);

          // 防御性：让 ghostty-web 在 open 之后立刻重测一次字体度量。当前架构下
          // init useEffect 在 fontSize 变化时会整体重建 terminal，所以这里其实等价
          // 于 no-op；但万一以后改成走 setFontSize 路径，这条能挡住 IME 锚点错位。
          if (isGhostty && terminal.renderer && typeof terminal.renderer.remeasureFont === 'function') {
            terminal.renderer.remeasureFont();
          }

          // ghostty-web 0.4.0 bug 兜底：Terminal.resize() 和 options Proxy
          // setter（fontSize / fontFamily / theme）在内部调 renderer.render() 时
          // 漏传 scrollbarOpacity，render 的默认参数是 1（见 dist/ghostty-web.js
          // 行 1396, 2259, 2427）。每次 resize / 字号切换都会在画布右侧画一道
          // 全不透明的滚动条；render loop 后续帧用 opacity=0 跑，但条件
          // `E && C > 0` 短路掉 renderScrollbar 不再画也不擦，结果留在画布上。
          // 软键盘弹/收必然走 fit→Terminal.resize→bug。Wrap renderer.render，
          // 未传 opacity 时回退到 this.scrollbarOpacity（默认 0）。
          if (isGhostty && terminal.renderer && typeof terminal.renderer.render === 'function') {
            const r: any = terminal.renderer;
            if (!r.__webTerminalScrollbarWrap) {
              const origRender = r.render.bind(r);
              r.render = (buf: any, forceAll: boolean, viewportY: number, provider: any, opacity?: number) => {
                return origRender(
                  buf,
                  forceAll,
                  viewportY,
                  provider,
                  opacity ?? (terminal as any).scrollbarOpacity ?? 0,
                );
              };
              r.__webTerminalScrollbarWrap = true;
            }
          }

          // Ghostty image paste：Cmd/Ctrl+V 触发的 paste 事件里，如果剪贴板
          // 含图（DataTransferItem.kind === 'file' && type startsWith image/），
          // 不传 base64 走 WS（一张图几 MB 直接打爆主线程），而是发 \x16
          // （SYN，对应 Ctrl+V 控制字符）让 PTY 内的程序自己用 OS API 读
          // 剪贴板（Claude Code / cursor-agent / nvim+img.nvim 都支持）。
          // 没图就放给浏览器走默认 text paste，ghostty bracketed-paste 接力。
          // capture-phase 拦在 ghostty 自家 paste handler 之前。
          if (isGhostty) {
            const handleGhosttyPaste = (event: ClipboardEvent) => {
              const items = event.clipboardData?.items;
              if (!items) return;
              let hasImage = false;
              for (let i = 0; i < items.length; i += 1) {
                const it = items[i];
                if (it && it.kind === 'file' && it.type.startsWith('image/')) {
                  hasImage = true;
                  break;
                }
              }
              if (hasImage) {
                event.preventDefault();
                event.stopPropagation();
                inputHandlerRef.current('\x16', { skipModifierTransform: true });
              }
            };
            terminalHost.addEventListener('paste', handleGhosttyPaste, { capture: true });
            localDisposables.push({
              dispose: () => {
                terminalHost.removeEventListener('paste', handleGhosttyPaste, true);
              },
            });
          }

          if (isGhostty && !enableTouchScroll) {
            const handleGhosttyFocus = () => {
              debugTerminal('ghostty focus');
              requestRefresh('focus', { skipResizePush: true, skipScrollToBottom: true });
              inputFocusHandlerRef.current?.(true);
            };
            const handleGhosttyBlur = () => {
              debugTerminal('ghostty blur');
              requestRefresh('blur', { skipResizePush: true, skipScrollToBottom: true });
              inputFocusHandlerRef.current?.(false);
            };
            terminalHost.addEventListener('focusin', handleGhosttyFocus);
            terminalHost.addEventListener('focusout', handleGhosttyBlur);
            localDisposables.push({
              dispose: () => {
                terminalHost.removeEventListener('focusin', handleGhosttyFocus);
                terminalHost.removeEventListener('focusout', handleGhosttyBlur);
              },
            });
          }

          if (isGhostty && enableTouchScroll) {
            // Mobile Ghostty reuses Termdock's overlay textarea for soft-keyboard
            // input. Disable ghostty-web's native contenteditable target after open;
            // otherwise mobile browsers show their own large caret and input can bypass
            // the overlay diff-sync path.
            try {
              terminalHost.removeAttribute('contenteditable');
              terminalHost.setAttribute('role', 'presentation');
              terminalHost.tabIndex = -1;
              const nativeTextarea = terminal.textarea as HTMLTextAreaElement | undefined;
              if (nativeTextarea) {
                nativeTextarea.tabIndex = -1;
                nativeTextarea.setAttribute('aria-hidden', 'true');
              }
            } catch { /* ignored */ }
          }

          if (isGhostty && !enableTouchScroll && typeof terminal.attachCustomKeyEventHandler === 'function') {
            // 桌面 ghostty 模式：让 ghostty-web 的 InputHandler + KeyEncoder 负责
            // 全部键盘事件 → 终端字节流（Kitty keyboard protocol、DECCKM 应用光标
            // 模式、IME composition 全部走原生路径，见 ghostty-web 0.4.0 PR #76/#81/#90）。
            // 我们只通过 attachCustomKeyEventHandler 拦截「系统级快捷键」，其它所有
            // 键 return false 让 KeyEncoder 处理；onData 收到编码好的字节后转发给 PTY。
            terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
              if (event.isComposing || event.keyCode === 229) return false;

              const cmd = event.metaKey;
              const ctrl = event.ctrlKey;
              const alt = event.altKey;
              const shift = event.shiftKey;
              const key = event.key;

              // Cmd+C（Mac 风格）：有选区时复制；不要回落到 SIGINT（C-c）。
              if (cmd && !ctrl && !alt && !shift && (key === 'c' || key === 'C')) {
                const sel = terminal.hasSelection?.() ? terminal.getSelection?.() : '';
                if (sel) {
                  navigator.clipboard?.writeText(sel).catch(() => { /* ignored */ });
                }
                return true;
              }

              // Cmd/Ctrl+K：清空可视屏幕。
              if ((cmd || ctrl) && !alt && !shift && (key === 'k' || key === 'K')) {
                terminal.reset();
                resetWriteState();
                requestRefresh('clear', { skipResizePush: true, skipScrollToBottom: true });
                return true;
              }

              // 其它所有键（含粘贴、方向键、修饰键组合、IME 输入）放给 KeyEncoder。
              return false;
            });

            // 订阅 KeyEncoder 编码后的字节流，转发给 PTY。
            // skipModifierTransform: true —— onData 出来的就是终端协议字节流，
            // 不再让 TerminalView 叠加移动端修饰符工具栏的状态。
            const dataDisposable = terminal.onData((data: string) => {
              inputHandlerRef.current(data, { skipModifierTransform: true });
            });
            localDisposables.push({ dispose: () => dataDisposable.dispose() });
          }

          // xterm-only: 之前这里有个 isCursorInitialized = true 的 monkey-patch,
          // 用来修 xterm 老版本"光标位置显示"问题。xterm 6.x 已经把这条修进
          // 正式代码,monkey-patch 反而破坏封装(读 _core.coreService 是
          // 私有 API),删掉。
          // ghostty 不需要这块。
          if (!isGhostty) {
            // 占位,留个 if 分支方便以后 xterm 又出 cursor 问题时加兜底
          }

          if (isGhostty) {
            // ghostty-web 使用 Canvas 2D 渲染，无需 WebGL 管理
            debugTerminal('renderer', { type: 'ghostty-canvas', reason: 'init' });
            rendererReadyRef.current = true;
            const runGhosttyFit = (reason: string) => {
              if (!disposed) fitTerminal(reason);
            };
            // rAF + 0ms 覆盖同步 layout（容器还没稳定，rAF 之后立刻第二次）。
            // 120ms 那一拍换成 FitAddon.observeResize()：官方自带 100ms 防抖的
            // ResizeObserver，监听容器尺寸变化自动 fit——更稳，不再依赖 1 次性
            // setTimeout 撞运气。
            requestAnimationFrame(() => runGhosttyFit('ghostty-init-raf'));
            window.setTimeout(() => runGhosttyFit('ghostty-init-timeout-0'), 0);
            if (typeof fitAddon.observeResize === 'function') {
              fitAddon.observeResize();
            }
          } else if (shouldUseWebgl) {
            enableWebglRenderer(terminal, 'init');
            // enableWebglRenderer 成功路径会自己把 rendererReadyRef 置 true；
            // 失败时它会 return false，下面兜底置 ready 避免后续 mount refresh 卡死。
            rendererReadyRef.current = true;
          } else {
            debugTerminal('renderer', {
              type: 'dom',
              reason: 'renderer-mode-canvas',
              mobile: enableTouchScroll,
              mode: rendererMode,
            });
            // canvas 路径：xterm 自带 DOM renderer，没有"挂载"事件，terminal.open
            // 已经渲染完一帧了，标记 ready 让 runRefreshSequence 放行。
            rendererReadyRef.current = true;
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

          // 桌面 tmux 模式：拦截 xterm 默认的 wheel → SGR mouse 上报，
          // 改成「按真实行高累积，凑满 1 行立即发 1 行」的模型，跟原生
          // 终端 / iTerm / VSCode 终端一致。
          //
          // ⚠️ 不复用 handleTmuxScrollInternal —— 它是为移动端 touchmove
          // 大幅 swipe 设计的，effectiveLineHeight = lineHeight/0.38 ≈ 124px，
          // 触控板每帧只来 ~5px，要累积 25 帧才能凑 1 行，完全不跟手。
          // 桌面这里：触控板/滚轮 deltaY 直接除以真实 lineHeight，
          // 立刻发 lines = trunc(累积/lineHeight)。
          //
          // ⚠️ 不能在外面 if (onTmuxScrollRef.current) —— terminal.open()
          // 初始化只跑一次，那一刻 isTmuxMode 还可能是 false。必须无条件
          // 注册，handler 内部用 ref 动态判断当前模式。
          if (!enableTouchScroll) {
            // 桌面 tmux 模式 wheel：走 SGR mouse wheel 协议（和移动端 touch
            // 滚动同一条路径），把 \x1b[<64;Cx;CyM / \x1b[<65;Cx;CyM 直接
            // 写进 PTY，让 tmux 自己识别为鼠标滚轮 → 进入 / 滚动 copy-mode。
            //
            // 不再走 onTmuxScroll → HTTP `/api/.../action` → server-side
            // `tmux send-keys -X scroll-up` —— 那条路径每行一次 fetch，
            // 触控板 60Hz 直接打爆主线程和 tmux server。
            //
            // 用 rAF 节流：同一帧内多次 wheel 累积，下一帧统一发。
            let pendingDeltaPx = 0;
            let lastClientX: number | null = null;
            let lastClientY: number | null = null;
            let rafId: number | null = null;
            const flushWheel = () => {
              rafId = null;
              const lineHeightPx = Math.max(12, Math.round(fontSize * 1.35));
              const total = desktopWheelRemainderRef.current + pendingDeltaPx;
              pendingDeltaPx = 0;
              const lines = Math.trunc(total / lineHeightPx);
              desktopWheelRemainderRef.current = total - lines * lineHeightPx;
              if (lines !== 0) {
                const direction = lines > 0 ? 'down' : 'up';
                // 一帧最多滚 1/2 屏 —— 触控板惯性滑很猛时一次能堆到上百行，
                // tmux 解析这种巨量序列会有可见停顿。超出部分直接丢（连同
                // 累积余数清零），跟原生 macOS 终端"惯性减速"行为一致，
                // 避免 backlog 持续在后续帧里释放造成回滚式跳动。
                const term = terminalRef.current;
                const maxPerFrame = Math.max(3, Math.floor((term?.rows ?? 24) / 2));
                const absLines = Math.abs(lines);
                if (absLines > maxPerFrame) {
                  desktopWheelRemainderRef.current = 0;
                }
                tmuxSendSgrScrollRef.current(
                  direction,
                  Math.min(absLines, maxPerFrame),
                  lastClientX ?? undefined,
                  lastClientY ?? undefined,
                );
              }
            };

            const wheelHandlerReturnValue = (processDefault: boolean) => {
              // xterm and ghostty-web use opposite return contracts here:
              // xterm: true = let xterm process the wheel event.
              // ghostty-web: true = stop ghostty's default wheel handling.
              return isGhostty ? !processDefault : processDefault;
            };

            terminal.attachCustomWheelEventHandler((ev: WheelEvent) => {
              // 通用早返:修饰键留给上一层(pinch-zoom 等),0 delta 直接吃掉。
              if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return wheelHandlerReturnValue(true);
              if (ev.deltaY === 0) return wheelHandlerReturnValue(false);

              const term = terminalRef.current;
              if (!term) return wheelHandlerReturnValue(true);

              // 非 tmux session 模式:交还给 xterm 默认处理。
              //   - mouseTracking on → xterm 自带 SGR mouse wheel 上报(完整且无副作用)
              //   - alt-screen only → xterm 自带 alt-buffer wheel → Up/Down 兜底
              //   - 主屏 + 无 mouseTracking → xterm 滚自己的本地 scrollback
              //     (这正是普通 shell 翻历史想要的;唯一会出问题的是用户在
              //     shell session 里手动 tmux 又关 mouse,那是个边角场景,
              //     真要修需要服务端把 activeProgram=tmux 透出来做检测,
              //     不属于本次 "tmux session 模式最佳实践" 的范围。)
              if (!onTmuxScrollRef.current) {
                return wheelHandlerReturnValue(true);
              }

              const lineHeightPx = Math.max(12, Math.round(fontSize * 1.35));
              let deltaPixels = ev.deltaY;
              if (ev.deltaMode === 1 /* DOM_DELTA_LINE */) {
                deltaPixels = ev.deltaY * lineHeightPx;
              } else if (ev.deltaMode === 2 /* DOM_DELTA_PAGE */) {
                deltaPixels = ev.deltaY * (container.clientHeight || lineHeightPx * 20);
              }

              pendingDeltaPx += deltaPixels;
              lastClientX = ev.clientX;
              lastClientY = ev.clientY;
              if (rafId === null) {
                rafId = requestAnimationFrame(flushWheel);
              }

              ev.preventDefault();
              return wheelHandlerReturnValue(false);
            });
          }

          // ghostty-web renders scrollbar on canvas, no DOM viewport to attach overlay scrollbar to
          if (!isGhostty) {
            const viewport = findScrollableViewport(container);
            if (viewport) {
              viewport.classList.add('overlay-scrollbar-target', 'overlay-scrollbar-container');
              viewportRef.current = viewport;
              forceRender();
            } else {
              viewportRef.current = null;
            }
          }

          requestRefresh('mount', { skipResizePush: true, skipScrollToBottom: true });
          if (autoFocusRef.current) {
            // 桌面：焦点必须落在覆盖层 textarea，绝不能给 xterm 自身 textarea。
            // 一旦 xterm.textarea 拿到焦点，IME（尤其搜狗英文联想）会把候选词
            // 直接 set 进 xterm.textarea.value，xterm 通过 input 事件读取再
            // 调 onData 发给 PTY，完全绕开我们的 diff-sync 路径。
            if (isGhostty && !enableTouchScroll) {
              // Desktop ghostty-web has its own input handling; don't redirect focus
              // to the xterm-specific overlay textarea.
              terminal.focus();
            } else if (!enableTouchScroll) {
              hiddenInputRef.current?.focus({ preventScroll: true });
            } else if (enableTouchScroll && isGhostty) {
              // Mobile Ghostty: do not focus ghostty-web's contenteditable on init.
              // User taps should focus our overlay textarea via focusHiddenInput(),
              // otherwise the browser shows a native oversized caret and soft-keyboard
              // text does not flow through Termdock's mobile input path.
            } else {
              terminal.focus();
            }
          }

          // 初始化锚点位置（即便 0,0 也得是当前 cell 真实尺寸）
          if (!enableTouchScroll) {
            updateImeAnchorRef.current();
          }

          // 桌面端：让覆盖层 textarea 始终拥有焦点，xterm 自身的 textarea 不再
          // 接收键盘输入。这样三方中文输入法（搜狗/微信）的 composition 不会
          // 拦截 keystroke 后吞掉某个字母。
          if (!enableTouchScroll && !isGhostty) {
            try {
              const xtermTextarea = terminal.textarea;
              if (xtermTextarea) {
                xtermTextarea.tabIndex = -1;
                xtermTextarea.setAttribute('aria-hidden', 'true');
                // 兜底：xterm 内部仍可能用 .focus() 主动拿焦点（比如鼠标点击
                // 时 SelectionService → Terminal.focus()）。这里挂一个 focus
                // 监听器，xterm.textarea 一拿到焦点就立即把它转给覆盖层；
                // 同时让它彻底不参与输入：readonly + 清空 value，确保即使
                // 某些 IME 抢先把候选词写进去，也不会被 xterm 的 input
                // handler 捕获并通过 onData 发出。
                xtermTextarea.setAttribute('readonly', '');
                xtermTextarea.value = '';
                const handleXtermTextareaFocus = () => {
                  hiddenInputRef.current?.focus({ preventScroll: true });
                };
                xtermTextarea.addEventListener('focus', handleXtermTextareaFocus);
                localDisposables.push({
                  dispose: () => xtermTextarea.removeEventListener('focus', handleXtermTextareaFocus),
                });
                // ⚠️ 不设 pointer-events:none：xterm 内部 wheel/mouse 上报
                // （SGR mouse wheel → tmux copy-mode）会路由到 textarea 上，
                // 屏蔽 hit-test 会导致触控板两指滚动收不到事件。
              }
            } catch { /* ignored */ }

            // IME 候选窗锚点跟随光标。onCursorMove 在光标 blink 切换
            // 时也会 fire (cursorX/Y 没变但 cursor state 变了),onRender 在
            // xterm RenderDebouncer 每帧 render 后 fire 一次。两者合起来
            // 1 帧内可能 fire 多次。updateImeAnchor 内部虽然有 0.5px dedupe
            // 跳过 setState,但函数本身仍要读 getCellMetrics + term.buffer,
            // 浪费 CPU。包一层 rAF throttle,1 帧最多跑一次。
            try {
              let imeAnchorRafRef: number | null = null;
              const scheduleImeAnchorUpdate = () => {
                if (imeAnchorRafRef !== null) return;
                imeAnchorRafRef = window.requestAnimationFrame(() => {
                  imeAnchorRafRef = null;
                  updateImeAnchorRef.current();
                });
              };
              localDisposables.push(terminal.onCursorMove(scheduleImeAnchorUpdate));
              localDisposables.push(terminal.onRender(scheduleImeAnchorUpdate));
              localDisposables.push(terminal.onResize(() => {
                // onResize 是真物理变化 (cols/rows 改了),不节流,立刻同步
                if (imeAnchorRafRef !== null) {
                  window.cancelAnimationFrame(imeAnchorRafRef);
                  imeAnchorRafRef = null;
                }
                updateImeAnchorRef.current();
              }));
              // cleanup:组件 unmount 时取消 pending rAF,避免回调跑空
              const prevDispose = localDisposables[localDisposables.length - 1]?.dispose;
              // 简单做:在 dispose 里 cleanup raf
              const wrappedDispose = () => {
                if (imeAnchorRafRef !== null) {
                  window.cancelAnimationFrame(imeAnchorRafRef);
                  imeAnchorRafRef = null;
                }
                prevDispose?.();
              };
              if (localDisposables.length > 0) {
                localDisposables[localDisposables.length - 1] = { dispose: wrappedDispose };
              }
            } catch { /* ignored */ }
          }

          // terminal.onData 仍保留：键盘输入已不走此路径（覆盖层 textarea 直接
          // 调 inputHandlerRef），剩下的都是终端内部产物——鼠标上报（mouseTracking）、
          // DSR 响应、bracketed-paste 包裹等，这些都是必须送到 PTY 的。
          localDisposables.push(
            terminal.onData((data: string) => {
              inputHandlerRef.current(data);
            })
          );

          // buffer 切换(进出 alt-screen)立即同步刷一次 atlas。
          // 触发场景:tmux 里打开/退出 vim/less/htop、进出 copy-mode、
          // 切 pane 到一个跑 TUI 的 pane 等。WebGL renderer 在两个 buffer 之间
          // 切换时 dirty rect 计算偶尔会漏一两行,残留旧字形,正好命中用户描述
          // 的"某一部分像被冻死"。这里用 onBufferChange 兜一道,代价只是切
          // buffer 时多刷一次,远低于 alt-screen 内任意一帧的代价。
          try {
            localDisposables.push(
              terminal.buffer.onBufferChange(() => {
                // ghostty-web 不需要 texture atlas 刷新，但仍然需要 buffer change 通知
                if (!isGhostty) {
                  refreshTextureAtlasNow('buffer-change');
                }
              })
            );
          } catch { /* ignored */ }

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

            // rAF 合并：sidebar 折叠 / swiper 翻页 / IME 弹起等场景下,
            // ResizeObserver 会在同一帧内连续 fire 多次(中间还会夹
            // 一次 clientHeight=0)。直接同步调 requestRefresh 会:
            //   1) 在 0 高度上跑 fitAddon.fit() 算错 cols/rows
            //   2) 让 WebGL renderer 在"mid texture-atlas rebuild"状态被
            //      第二次 resize 打断,出现 #2816 / Hermes 注释里描述的
            //      "sibling panes mid-transition crashes the WebGL renderer"
            //
            // 一帧合并一次,dprChanged 路径走 0ms debounce 立即推,普通
            // resize 走 90ms debounce(default)。
            if (!resizeRafRef.current) {
              resizeRafRef.current = window.requestAnimationFrame(() => {
                resizeRafRef.current = null;
                if (dprChanged) {
                  requestRefresh('dpr-change', { resizeDebounceMs: 0 });
                } else {
                  requestRefresh('resize');
                }
              });
            }
          });
          localResizeObserver.observe(container);

          if (typeof window !== 'undefined') {
            // post-init 二次 fit：等一帧让 layout 真正稳定再算 cols/rows
            window.setTimeout(() => {
              requestRefresh('init-fit', { skipScrollToBottom: true });
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
        disposed = true;
        void disposed;
        inputFocusHandlerRef.current?.(false);
        touchScrollCleanupRef.current?.();
        touchScrollCleanupRef.current = null;

        // composition 中 unmount / 切 session：浏览器不会派 compositionend，
        // 不复位的话下一次进来 isComposingRef 仍是 true，所有 input 会被
        // gate 掉。同时把 IME overlay 状态归零。
        isComposingRef.current = false;
        imeFrozenAnchorRef.current = null;
        setImeComposition({ active: false, text: '' });

        for (const disposable of localDisposables) {
          disposable.dispose();
        }
        localResizeObserver?.disconnect();
        if (resizeRafRef.current !== null) {
          window.cancelAnimationFrame(resizeRafRef.current);
          resizeRafRef.current = null;
        }

        if (wheelHandlerRef.current) {
          container.removeEventListener('wheel', wheelHandlerRef.current);
          wheelHandlerRef.current = null;
        }

        disposeWebglRenderer('component-unmount');
        localTerminal?.dispose();
        // 配合 init 端的 replaceChildren：localTerminal.dispose() 内部会摘
        // canvas/textarea，但 ghostty-web 0.4.0 cleanupComponents 只在 element
        // 还活着且组件还在时摘，dispose 之后若节点已被 React 重挂可能漏摘。
        // 这里给 ghostty host 兜一次底，下一轮 init 的 replaceChildren 就不会
        // 看到任何旧节点。
        try { ghosttyHostRef.current?.replaceChildren(); } catch { /* ignored */ }
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
      // session-reset：先重置状态，fit + atlas 刷新都走编排器
      // （sessionKey 变化时 lastServerSizeRef 已被 useEffect 重置为 null，
      //   所以这里推 resize 走 first-fit immediate 路径）
      requestRefresh('session-reset', { skipScrollToBottom: true });
      if (autoFocusRef.current) {
        const touchEnabled = enableTouchScrollRef.current;
        if (backendTypeRef.current === 'ghostty' && !touchEnabled) {
          terminal.focus();
        } else if (backendTypeRef.current === 'ghostty' && touchEnabled) {
          // Mobile Ghostty: keep focus on overlay textarea, not native contenteditable.
          focusHiddenInput();
        } else if (!touchEnabled) {
          hiddenInputRef.current?.focus({ preventScroll: true });
        } else {
          terminal.focus();
        }
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionKey, terminalReadyVersion, requestRefresh, resetWriteState]);

    React.useEffect(() => {
      if (!enableTouchScroll) return;
      const cleanup = setupTouchScroll();
      touchScrollCleanupRef.current = cleanup;
      return () => {
        cleanup();
        touchScrollCleanupRef.current = null;
      };
    }, [enableTouchScroll, setupTouchScroll]);

    // tmux 模式动态切换 xterm 本地 scrollback。
    // shell ↔ tmux 切换不会重建 terminal,所以构造时设的 scrollback 不够 —
    // 必须随 onTmuxScroll 变化重设。tmux 模式下 0 行避免任何路径漏出
    // "本地历史在 tmux 重绘下面" 的冻死视觉。
    // terminalReadyVersion 依赖确保终端真正初始化完(包括 reset / session-switch)
    // 之后再写,避免在 xterm 还没准备好时静默丢弃 options。
    React.useEffect(() => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      try {
        terminal.options.scrollback = onTmuxScroll ? 0 : 1000;
      } catch { /* ignored */ }
    }, [onTmuxScroll, terminalReadyVersion]);

    // 监听浏览器 zoom（ctrl+/- 或 cmd+/-）和系统 DPR 变化。
    // ResizeObserver 在窗口尺寸没变时不会 fire,但 DPR 变会导致 xterm
    // 内部 `_updateDimensions` 算出的 cell 像素错位 → 字符模糊/偏大/偏小
    // （xterm.js #4728: Firefox/Brave Responsive Design Mode 下 DPR>1 时
    // 字符溢出 cell）。
    // 依据：VS Code `DevicePixelObserver.ts`。
    React.useEffect(() => {
      if (typeof window === 'undefined' || !window.matchMedia) return;
      const mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      const handleDprChange = () => {
        debugTerminal('dpr changed via mql', {
          oldDpr: lastDevicePixelRatioRef.current,
          newDpr: window.devicePixelRatio,
        });
        // ResizeObserver 内已有 dpr 比较逻辑,这里只需要触发一次 fit + atlas 刷新
        // + 推 resize。dpr-change 走 0ms debounce 立即推。
        requestRefresh('dpr-change', { resizeDebounceMs: 0 });
      };
      mql.addEventListener('change', handleDprChange);
      return () => mql.removeEventListener('change', handleDprChange);
    }, []);

    React.useEffect(() => {
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }

      if (chunks.length === 0) {
        if (lastProcessedChunkIdRef.current !== null) {
          terminal.reset();
          resetWriteState();
          requestRefresh('buffer-reset', { skipResizePush: true, skipScrollToBottom: true });
        }
        return;
      }

      const lastProcessedId = lastProcessedChunkIdRef.current;
      let pending: TerminalChunk[];

      if (lastProcessedId === null) {
        pending = chunks;
      } else {
        // store 端 chunkId 单调递增,新 chunks 数组的 id 序列也单调。
        // 用二分查找替代 O(n) findIndex:密集输出场景(如 npm install / git
        // clone)chunks 累积到 1k+ 时,O(n) 每次 data 都扫整个数组。
        // 改动后 O(log n),1k chunks 从 ~1000 步降到 ~10 步。
        const lastProcessedIndex = findChunkIndexById(chunks, lastProcessedId);
        pending = lastProcessedIndex >= 0 ? chunks.slice(lastProcessedIndex + 1) : chunks;
      }

      if (pending.length > 0) {
        const rawChunk = pending.map((chunk) => chunk.data).join('');
        const merged = osc52RemainderRef.current + rawChunk;
        const oscResult = processOsc52Clipboard(merged);
        osc52RemainderRef.current = oscResult.remainder;
        // 设备探针过滤:在 OSC 52 之后、term.write 之前再过一道,过滤掉
        // xterm 启动时 DA1/DA2/DA3 设备的回包(参见 processDeviceStatusResponses
        // 顶部注释)。只在 onData 入口过滤,不阻断用户正常输出。
        const { cleaned: deviceCleaned } = processDeviceStatusResponses(oscResult.cleaned);
        if (deviceCleaned) {
          enqueueWrite(deviceCleaned);
        }
      }

      lastProcessedChunkIdRef.current = chunks[chunks.length - 1].id;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chunks, terminalReadyVersion, enqueueWrite, requestRefresh, resetWriteState]);

    React.useImperativeHandle(
      ref,
      (): TerminalController => ({
        focus: () => {
          const touchEnabled = enableTouchScrollRef.current;
          if (backendTypeRef.current === 'ghostty' && !touchEnabled) {
            terminalRef.current?.focus();
            return;
          }
          if (backendTypeRef.current === 'ghostty' && touchEnabled) {
            focusHiddenInput();
            return;
          }
          if (touchEnabled) {
            focusHiddenInput();
            return;
          }
          // 桌面 xterm：与 init / session-reset 一致，焦点统一交给覆盖层 textarea，
          // 否则 IME 会抢到 xterm.textarea 上绕开 diff-sync。
          hiddenInputRef.current?.focus({ preventScroll: true });
        },
        clear: () => {
          const terminal = terminalRef.current;
          if (!terminal) {
            return;
          }
          terminal.reset();
          resetWriteState();
          // clear 走 requestRefresh 统一路径（renderer 不重建、resize 不推）
          requestRefresh('clear', { skipResizePush: true, skipScrollToBottom: true });
        },
        getDimensions: () => {
          const terminal = terminalRef.current;
          if (!terminal || !terminal.cols || !terminal.rows) return null;
          return { cols: terminal.cols, rows: terminal.rows };
        },
        getBackendType: () => backendTypeRef.current,
        requestRefresh,
        setSessionReady: (ready: boolean) => {
          sessionReadyRef.current = ready;
        },
      }),
      [
        enableTouchScroll,
        focusHiddenInput,
        resetWriteState,
        requestRefresh,
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
        tabIndex={-1}
        onPointerDownCapture={() => extendBlurGuard(INPUT_BLUR_GUARD_ACTIVE_MS)}
        onPointerMoveCapture={() => extendBlurGuard(INPUT_BLUR_GUARD_ACTIVE_MS)}
        onPointerUpCapture={() => extendBlurGuard(INPUT_BLUR_GUARD_RELEASE_MS)}
        onPointerCancelCapture={() => extendBlurGuard(INPUT_BLUR_GUARD_RELEASE_MS)}
        onTouchStartCapture={() => extendBlurGuard(INPUT_BLUR_GUARD_ACTIVE_MS)}
        onTouchMoveCapture={() => extendBlurGuard(INPUT_BLUR_GUARD_ACTIVE_MS)}
        onTouchEndCapture={() => extendBlurGuard(INPUT_BLUR_GUARD_RELEASE_MS)}
        onTouchCancelCapture={() => extendBlurGuard(INPUT_BLUR_GUARD_RELEASE_MS)}
        onMouseDown={(event) => {
          // 桌面：让 xterm 先收到 mousedown 走选择 / 拖拽，rAF 后再把焦点
          // 转给覆盖 textarea。textarea 自身 pointer-events:none，鼠标事件
          // 直接落到 xterm canvas，不需要再额外转发。
          if (enableTouchScroll) return;
          if (event.button !== 0) return;
          requestAnimationFrame(() => {
            try {
              if (backendTypeRef.current === 'ghostty') {
                terminalRef.current?.focus();
              } else {
                hiddenInputRef.current?.focus({ preventScroll: true });
              }
            } catch { /* ignored */ }
          });
        }}
      >
        <div
          ref={ghosttyHostRef}
          aria-hidden={engine !== 'ghostty'}
          className={`absolute inset-0 ${engine === 'ghostty' ? '' : 'hidden'}`}
        />

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
                opacity: 0,
                zIndex: 20,
                background: 'transparent',
                color: 'transparent',
                caretColor: 'transparent',
                resize: 'none',
                overflow: 'hidden',
                border: 'none',
                padding: 0,
                margin: 0,
                outline: 'none',
                ...(enableTouchScroll
                  ? {
                      // 移动端：覆盖整个终端，触控走 textarea，键盘走 textarea。
                      inset: 0,
                      touchAction: 'none',
                      userSelect: 'none',
                      WebkitUserSelect: 'none',
                      WebkitTouchCallout: 'none',
                      pointerEvents: 'auto',
                      fontSize: '16px',
                    }
                  : (() => {
                      // 桌面端：1 cell 大小、跟随光标，鼠标事件透传给 xterm。
                      // IME 候选窗会贴着这个小框出现 → 视觉上 == 终端光标位置。
                      //
                      // ⚠️ 必须用 fixed，而不是 absolute：这个 textarea 长期处于
                      // focus 状态，浏览器会对 focused input/textarea 自动做
                      // scroll-into-view。若它是 absolute 且随着终端光标上下移动，
                      // 普通桌面键盘输入也可能触发页面/visualViewport 被顶上去，
                      // 表现为整个 terminal 先上抬再落回。fixed 元素不参与文档
                      // 滚动布局，同时仍可作为 IME candidate window 的锚点。
                      const containerRect = containerRef.current?.getBoundingClientRect();
                      const viewportLeft = Math.round((containerRect?.left ?? 0) + imeAnchor.x);
                      const viewportTop = Math.round((containerRect?.top ?? 0) + imeAnchor.y);
                      const base: React.CSSProperties = {
                        position: 'fixed',
                        left: viewportLeft,
                        top: viewportTop,
                        pointerEvents: 'none',
                        touchAction: 'auto',
                        fontSize: `${fontSize}px`,
                        fontFamily,
                        lineHeight: '1',
                        whiteSpace: 'pre',
                        boxSizing: 'content-box',
                        width: Math.max(1, Math.round(imeAnchor.cellW)),
                        height: Math.max(1, Math.round(imeAnchor.cellH)),
                      };
                      if (!imeComposition.active) return base;
                      // composition 态：textarea 显形为「带下划线、不透明
                      // 背景遮住 xterm」的可见 overlay；候选窗紧贴它出现。
                      const metrics = getImeOverlayMetrics(imeComposition.text);
                      return {
                        ...base,
                        opacity: 1,
                        color: theme.foreground,
                        background: theme.background,
                        caretColor: theme.cursor || theme.foreground,
                        textDecorationLine: 'underline',
                        textDecorationStyle: 'solid',
                        textDecorationColor: theme.foreground,
                        wordBreak: 'break-all',
                        zIndex: 21,
                        width: metrics.width,
                        height: metrics.height,
                        whiteSpace: metrics.whiteSpace,
                      } as React.CSSProperties;
                    })()),
              }}
              onFocus={() => {
                debugTerminal('input anchor focus');
                requestRefresh('focus', { skipResizePush: true, skipScrollToBottom: true });
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
                requestRefresh('blur', { skipResizePush: true, skipScrollToBottom: true });

                if (!guarded) {
                  // readonly 仅对移动端有意义（防止 iOS 长按放大镜）；
                  // 桌面端绝不能 readonly，否则下次 focus 收不到键。
                  if (enableTouchScroll) {
                    hiddenInputRef.current?.setAttribute('readonly', '');
                  }
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
                    if (enableTouchScroll) {
                      hiddenInputRef.current?.setAttribute('readonly', '');
                    }
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
                  const sinceCompEnd = Date.now() - lastCompositionEndAtRef.current;
                  // IME 选词后浏览器会补一记 insertLineBreak，必须吞掉。
                  if (sinceCompEnd < 200) {
                    event.preventDefault();
                    return;
                  }
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
                // ===== 桌面端独有：先处理 Cmd/Ctrl/Alt 修饰组合 =====
                if (!enableTouchScroll) {
                  const term = terminalRef.current;
                  const cmd = event.metaKey;
                  const ctrl = event.ctrlKey;
                  const alt = event.altKey;
                  const shift = event.shiftKey;
                  const key = event.key;

                  // ---- Cmd/Ctrl + V：粘贴 ----
                  if ((cmd || ctrl) && !alt && !shift && (key === 'v' || key === 'V')) {
                    event.preventDefault();
                    navigator.clipboard?.readText().then((text) => {
                      if (!text) return;
                      const cleaned = sanitizeTerminalInput(text);
                      if (cleaned) sendTerminalSeq(cleaned, event.currentTarget);
                    }).catch(() => { /* ignored */ });
                    return;
                  }

                  // ---- Cmd + C（Mac 风格）：有选区复制，无选区什么都不做 ----
                  if (cmd && !ctrl && !alt && !shift && (key === 'c' || key === 'C')) {
                    event.preventDefault();
                    const sel = term?.hasSelection() ? term.getSelection() : '';
                    if (sel) {
                      navigator.clipboard?.writeText(sel).catch(() => { /* ignored */ });
                    }
                    return;
                    // ⚠️ Mac Cmd+C 永远不发 SIGINT；Ctrl+C 走下面的 ctrl-letter 分支
                  }

                  // ---- Cmd/Ctrl + K：清空可视屏幕 ----
                  if ((cmd || ctrl) && !alt && !shift && (key === 'k' || key === 'K')) {
                    event.preventDefault();
                    if (term) {
                      term.reset();
                      resetWriteState();
                      // cmd-k 走编排器：clear reason，不重建 renderer、不推 resize、不滚底
                      requestRefresh('clear', { skipResizePush: true, skipScrollToBottom: true });
                    }
                    event.currentTarget.value = '';
                    sentValueRef.current = '';
                    return;
                  }

                  // ---- 其他 Cmd / Cmd+Shift / Cmd+Alt 组合 ----
                  // 不识别就交给 App.tsx 的全局监听器（Cmd+B / Cmd+Shift+E 等）。
                  // 不 preventDefault、也不发 PTY；textarea 对这些组合的默认行为
                  // 就是 no-op，所以不会留下垃圾字符。
                  if (cmd) {
                    return;
                  }

                  // ---- Ctrl + Space → NUL ----
                  if (ctrl && !alt && !shift && key === ' ') {
                    event.preventDefault();
                    sendTerminalSeq('\x00', event.currentTarget);
                    return;
                  }

                  // ---- Ctrl + letter → 控制字符 ----
                  if (ctrl && !alt && !cmd && key.length === 1) {
                    const code = key.toLowerCase().charCodeAt(0);
                    if (code >= 0x40 && code <= 0x7f) {
                      event.preventDefault();
                      sendTerminalSeq(String.fromCharCode(code & 0x1f), event.currentTarget);
                      return;
                    }
                  }

                  // ---- Alt + letter → ESC-prefix ----
                  if (alt && !ctrl && !cmd && key.length === 1) {
                    event.preventDefault();
                    sendTerminalSeq(`\x1b${key}`, event.currentTarget);
                    return;
                  }

                  // ---- 特殊键（方向 / Home / End / F1–F12 / Tab / Esc 等）----
                  if (term) {
                    const seq = mapSpecialKey(event, term, backendTypeRef.current);
                    if (seq !== null) {
                      event.preventDefault();
                      sendTerminalSeq(seq, event.currentTarget);
                      return;
                    }
                  }
                }

                // ===== 通用 Enter 处理（桌面 + 移动）=====
                // ⚠️ IME 合成中按 Enter 是用来「选中候选词上屏」，绝不能
                // 当作回车发给 PTY。判定条件：
                //   - event.isComposing：标准 W3C 标记
                //   - event.nativeEvent.isComposing：React 包装事件兜底
                //   - keyCode === 229：Chrome/Safari IME 占用码，所有
                //     IME 合成中的按键都会被映射到 229
                //   - isComposingRef.current：composition* 事件维护的状态，
                //     某些 IME（搜狗）首次按 Enter 不带 isComposing 标志，
                //     只能靠这条兜底
                if (event.key === 'Enter' || event.key === 'Go' || event.key === 'done' || event.key === 'send') {
                  const sinceCompEnd = Date.now() - lastCompositionEndAtRef.current;
                  if (
                    event.nativeEvent.isComposing ||
                    (event as unknown as { isComposing?: boolean }).isComposing ||
                    event.keyCode === 229 ||
                    isComposingRef.current ||
                    sinceCompEnd < 200
                  ) {
                    // IME 合成中 / 刚结束：吞掉这一记 Enter，候选词已经通过
                    // compositionend → syncTextareaToPty 发出去了。
                    event.preventDefault();
                    return;
                  }
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
                freezeImeAnchor();
                setImeComposition({ active: true, text: '' });
              }}
              onCompositionUpdate={(e) => {
                isComposingRef.current = true;
                const text = e.data ?? e.currentTarget.value;
                setImeComposition(prev =>
                  prev.active && prev.text === text ? prev : { active: true, text });
              }}
              onCompositionEnd={(event) => {
                isComposingRef.current = false;
                lastCompositionEndAtRef.current = Date.now();
                setImeComposition({ active: false, text: '' });
                syncTextareaToPty(event.currentTarget);
                releaseImeAnchor();
              }}
            />

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

            {/* Long-press arrow drag indicator — fixed top-center */}
            <div
              ref={arrowIndicatorRef}
              aria-hidden
              className="fixed left-1/2 top-6 z-30 pointer-events-none transition-opacity duration-150 ease-out"
              style={{
                opacity: arrowIndicator.visible ? 1 : 0,
                transform: arrowIndicator.visible
                  ? 'translate(-50%, 0) scale(1)'
                  : 'translate(-50%, -8px) scale(0.9)',
              }}
            >
              {arrowIndicator.visible && (() => {
                const { activeDir } = arrowIndicator;
                const A = (d: string) => activeDir === d;

                return (
                  <div className="flex flex-col items-center gap-0.5 rounded-xl bg-black/70 backdrop-blur-sm shadow-lg px-1.5 py-1.5">
                    {/* Up */}
                    <div className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors ${A('up') ? 'bg-white/25 text-white' : 'text-white/30'}`}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M7 11l5-5 5 5"/></svg>
                    </div>
                    {/* Left / Right */}
                    <div className="flex items-center gap-0.5">
                      <div className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors ${A('left') ? 'bg-white/25 text-white' : 'text-white/30'}`}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
                      </div>
                      <div className="w-7 h-7 flex items-center justify-center rounded-lg text-white/15">
                        <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="4"/></svg>
                      </div>
                      <div className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors ${A('right') ? 'bg-white/25 text-white' : 'text-white/30'}`}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                      </div>
                    </div>
                    {/* Down */}
                    <div className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors ${A('down') ? 'bg-white/25 text-white' : 'text-white/30'}`}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>
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

TerminalViewportInner.displayName = 'TerminalViewport';
export const TerminalViewport = TerminalViewportInner;
