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

// Theme definition with semantic colors
export interface Theme {
  name: string;
  colors: {
    surface: {
      background: string;
      elevatedBackground: string;
      elevatedForeground: string;
      muted: string;
    };
    interactive: {
      cursor: string;
      selection: string;
      selectionForeground: string;
    };
    status: {
      error: string;
      success: string;
      warning: string;
      info: string;
    };
    syntax: {
      base: {
        foreground: string;
        comment: string;
        string: string;
        number: string;
        function: string;
        keyword: string;
        type: string;
        variable: string;
      };
    };
  };
}

// Built-in themes
export const THEMES: Theme[] = [
  {
    name: 'Dark',
    colors: {
      surface: {
        background: '#0d1117',
        elevatedBackground: '#161b22',
        elevatedForeground: '#f0f6fc',
        muted: '#6e7681',
      },
      interactive: {
        cursor: '#58a6ff',
        selection: '#264f78',
        selectionForeground: '#f0f6fc',
      },
      status: {
        error: '#f85149',
        success: '#3fb950',
        warning: '#d29922',
        info: '#58a6ff',
      },
      syntax: {
        base: {
          foreground: '#f0f6fc',
          comment: '#8b949e',
          string: '#a5d6ff',
          number: '#79c0ff',
          function: '#d2a8ff',
          keyword: '#ff7b72',
          type: '#79c0ff',
          variable: '#ffa657',
        },
      },
    },
  },
  {
    name: 'Light',
    colors: {
      surface: {
        background: '#ffffff',
        elevatedBackground: '#f6f8fa',
        elevatedForeground: '#24292f',
        muted: '#57606a',
      },
      interactive: {
        cursor: '#0969da',
        selection: '#b4dbf7',
        selectionForeground: '#24292f',
      },
      status: {
        error: '#cf222e',
        success: '#1a7f37',
        warning: '#9a6700',
        info: '#0969da',
      },
      syntax: {
        base: {
          foreground: '#24292f',
          comment: '#6a737d',
          string: '#0a3069',
          number: '#0550ae',
          function: '#8250df',
          keyword: '#cf222e',
          type: '#0550ae',
          variable: '#953800',
        },
      },
    },
  },
  {
    name: 'Solarized Dark',
    colors: {
      surface: {
        background: '#002b36',
        elevatedBackground: '#073642',
        elevatedForeground: '#93a1a1',
        muted: '#586e75',
      },
      interactive: {
        cursor: '#b58900',
        selection: '#073642',
        selectionForeground: '#93a1a1',
      },
      status: {
        error: '#dc322f',
        success: '#859900',
        warning: '#b58900',
        info: '#268bd2',
      },
      syntax: {
        base: {
          foreground: '#93a1a1',
          comment: '#586e75',
          string: '#2aa198',
          number: '#268bd2',
          function: '#268bd2',
          keyword: '#cb4b16',
          type: '#859900',
          variable: '#b58900',
        },
      },
    },
  },
  {
    name: 'Dracula',
    colors: {
      surface: {
        background: '#282a36',
        elevatedBackground: '#44475a',
        elevatedForeground: '#f8f8f2',
        muted: '#6272a4',
      },
      interactive: {
        cursor: '#f8f8f2',
        selection: '#44475a',
        selectionForeground: '#f8f8f2',
      },
      status: {
        error: '#ff5555',
        success: '#50fa7b',
        warning: '#f1fa8c',
        info: '#8be9fd',
      },
      syntax: {
        base: {
          foreground: '#f8f8f2',
          comment: '#6272a4',
          string: '#f1fa8c',
          number: '#bd93f9',
          function: '#50fa7b',
          keyword: '#ff79c6',
          type: '#8be9fd',
          variable: '#ffb86c',
        },
      },
    },
  },
  {
    name: 'Nord',
    colors: {
      surface: {
        background: '#2e3440',
        elevatedBackground: '#3b4252',
        elevatedForeground: '#eceff4',
        muted: '#616e88',
      },
      interactive: {
        cursor: '#88c0d0',
        selection: '#434c5e',
        selectionForeground: '#eceff4',
      },
      status: {
        error: '#bf616a',
        success: '#a3be8c',
        warning: '#ebcb8b',
        info: '#81a1c1',
      },
      syntax: {
        base: {
          foreground: '#eceff4',
          comment: '#616e88',
          string: '#a3be8c',
          number: '#b48ead',
          function: '#88c0d0',
          keyword: '#81a1c1',
          type: '#8fbcbb',
          variable: '#d8dee9',
        },
      },
    },
  },
];

export function convertThemeToXterm(theme: Theme): TerminalTheme {
  const { colors } = theme;
  const syntax = colors.syntax.base;

  return {
    background: colors.surface.background,
    foreground: syntax.foreground,
    cursor: colors.interactive.cursor,
    cursorAccent: colors.surface.background,
    selectionBackground: colors.interactive.selection,
    selectionForeground: colors.interactive.selectionForeground,
    selectionInactiveBackground: colors.interactive.selection + '50',
    black: colors.surface.muted,
    red: colors.status.error,
    green: colors.status.success,
    yellow: colors.status.warning,
    blue: syntax.function,
    magenta: syntax.keyword,
    cyan: syntax.type,
    white: syntax.foreground,
    brightBlack: syntax.comment,
    brightRed: colors.status.error,
    brightGreen: colors.status.success,
    brightYellow: colors.status.warning,
    brightBlue: syntax.function,
    brightMagenta: syntax.keyword,
    brightCyan: syntax.type,
    brightWhite: colors.surface.elevatedForeground,
  };
}

export function getDefaultTheme(): Theme {
  return THEMES[0];
}
