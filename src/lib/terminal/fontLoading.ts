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
 *   - 显式 load 主字体与提示符图标的 Regular / Bold，避免 unicode-range
 *     懒加载导致 ready 提前 resolve（document.fonts.ready 只等当前已注册的
 *     FontFace，懒加载字体在被使用前不会注册）。
 *   - 兼容老浏览器 / 测试环境：API 缺失时直接 resolve。
 *   - 任何加载失败都吞掉，让终端继续以 fallback 启动，不阻塞用户。
 */
// Wait for primary text and prompt icons before xterm caches glyph metrics.
let terminalFontsReadyPromise: Promise<void> | null = null;
const TERMINAL_CRITICAL_FONT_PRELOADS = [
  {
    font: '400 14px "Termdock Maple"',
    text: 'Termdock 0123456789 ~!@#$%^&*()[]{}',
  },
  {
    font: '700 14px "Termdock Maple"',
    text: 'Termdock 0123456789 ~!@#$%^&*()[]{}',
  },
  {
    font: '400 14px "Termdock Prompt Icons"',
    text: '\uf179\uf17c\uf31b\uf31c\uf015\uf115\uf07b\uf126\ue0a0\ue0b0',
  },
  {
    font: '700 14px "Termdock Prompt Icons"',
    text: '\uf179\uf17c\uf31b\uf31c\uf015\uf115\uf07b\uf126\ue0a0\ue0b0',
  },
  {
    font: '400 13px "Noto Sans Mono CJK SC"',
    text: '终端中文路径',
  },
  {
    font: '700 13px "Noto Sans Mono CJK SC"',
    text: '终端中文路径',
  },
  {
    font: '400 13px "Termdock Star Symbol"',
    text: '✦✧',
  },
  {
    font: '400 13px "Noto Sans Symbols 2"',
    text: '⏺⏸⏹✓✗',
  },
] as const;

export const ensureTerminalFontsReady = (): Promise<void> => {
  if (terminalFontsReadyPromise) return terminalFontsReadyPromise;
  if (typeof document === 'undefined' || !('fonts' in document)) {
    terminalFontsReadyPromise = Promise.resolve();
    return terminalFontsReadyPromise;
  }
  const fonts = document.fonts;
  // Only faces that determine the first viewport's cell geometry block xterm.
  const preload = Promise.allSettled(
    TERMINAL_CRITICAL_FONT_PRELOADS.map(({ font, text }) => fonts.load(font, text)),
  );
  terminalFontsReadyPromise = preload
    .then(() => fonts.ready)
    .then(() => undefined)
    .catch(() => undefined);
  return terminalFontsReadyPromise;
};
