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

// Flexoki Dark — warm low-contrast palette for readability
// https://stephango.com/flexoki
export const FLEXOKI_DARK: TerminalTheme = {
  background: '#100F0F',
  foreground: '#CECDC3',
  cursor: '#CECDC3',
  cursorAccent: '#100F0F',
  selectionBackground: '#403E3C',
  selectionForeground: '#CECDC3',
  selectionInactiveBackground: '#403E3C50',
  black: '#100F0F',
  red: '#D14D41',
  green: '#879A39',
  yellow: '#D0A215',
  blue: '#4385BE',
  magenta: '#CE5D97',
  cyan: '#3AA99F',
  white: '#CECDC3',
  brightBlack: '#575653',
  brightRed: '#D14D41',
  brightGreen: '#879A39',
  brightYellow: '#D0A215',
  brightBlue: '#4385BE',
  brightMagenta: '#CE5D97',
  brightCyan: '#3AA99F',
  brightWhite: '#FFFCF0',
};

// Flexoki Light — paired with the app's light UI tokens.
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

export function getTerminalTheme(colorTheme: TermdockColorTheme): TerminalTheme {
  return colorTheme === 'light' ? FLEXOKI_LIGHT : FLEXOKI_DARK;
}
