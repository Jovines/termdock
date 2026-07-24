// TerminalTheme defines the ANSI 16-color palette + additional rendering tokens
// consumed by xterm.js at initialization time. The palette is applied via
// xterm.options.theme and is NOT reactive — changing it requires destroying and
// recreating the terminal instance. If you need runtime theme switching, wire
// it through the terminal factory's recreate path rather than mutating options
// in place, as xterm silently ignores post-constructor theme reassignment.
export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground?: string;
  selectionInactiveBackground?: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export type TermdockColorTheme = 'dark' | 'light';

// Terminal colors are an ANSI palette, not regular app UI tokens.
//
// Keep ANSI 0-7 and bright 8-15 as two distinct ramps so TUI programs can
// express state through SGR codes. Do not collapse these values into the
// app's surface/foreground tokens: xterm must render whatever colors the
// process emits, while this file only defines the palette those ANSI indexes
// resolve to.
//
// Flexoki Dark — warm low-contrast palette for readability
// https://stephango.com/flexoki
export const FLEXOKI_DARK: TerminalTheme = {
  background: '#1C1B1A',
  foreground: '#CECDC3',
  cursor: '#CECDC3',
  cursorAccent: '#1C1B1A',
  selectionBackground: '#403E3C',
  selectionForeground: '#CECDC3',
  selectionInactiveBackground: '#403E3C50',
  black: '#6F6E69',
  red: '#AF3029',
  green: '#66800B',
  yellow: '#AD8301',
  blue: '#205EA6',
  magenta: '#A02F6F',
  cyan: '#24837B',
  white: '#CECDC3',
  brightBlack: '#6F6E69',
  brightRed: '#D14D41',
  brightGreen: '#879A39',
  brightYellow: '#D0A215',
  brightBlue: '#4385BE',
  brightMagenta: '#CE5D97',
  brightCyan: '#3AA99F',
  brightWhite: '#FFFCF0',
};

// Flexoki Light — same ANSI contract as dark, on paper background.
// 浅色下 ANSI white/brightWhite 必须"反转"成深色调:7 号白给中深灰(tx-3),
// 15 号亮白给最深的 tx——否则白字/加粗白字在纸面上直接隐形(TUI 大量
// 用 bright white 做强调)。其余彩色仍按作者规则走 600(正常)/400(明亮)。
export const FLEXOKI_LIGHT: TerminalTheme = {
  background: '#FFFCF0',
  foreground: '#100F0F',
  cursor: '#100F0F',
  cursorAccent: '#FFFCF0',
  selectionBackground: '#CECDC3',
  selectionForeground: '#100F0F',
  selectionInactiveBackground: '#CECDC350',
  black: '#100F0F',
  red: '#AF3029',
  green: '#66800B',
  yellow: '#AD8301',
  blue: '#205EA6',
  magenta: '#A02F6F',
  cyan: '#24837B',
  white: '#575653',
  brightBlack: '#6F6E69',
  brightRed: '#D14D41',
  brightGreen: '#879A39',
  brightYellow: '#D0A215',
  brightBlue: '#4385BE',
  brightMagenta: '#CE5D97',
  brightCyan: '#3AA99F',
  brightWhite: '#100F0F',
};

export function getTerminalTheme(colorTheme: TermdockColorTheme): TerminalTheme {
  return colorTheme === 'light' ? FLEXOKI_LIGHT : FLEXOKI_DARK;
}
