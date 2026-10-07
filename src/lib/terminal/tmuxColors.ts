import type { TerminalTheme } from './theme';

/** Seed tmux's client palette even when its attach-time queries were replayed. */
export function buildTmuxDefaultColorReplies(theme: TerminalTheme): string {
  return ([['10', theme.foreground], ['11', theme.background]] as const)
    .map(([slot, color]) => {
      const components = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);
      if (!components) return '';
      const rgb = components.slice(1).map(component => component.repeat(2)).join('/');
      return `\x1b]${slot};rgb:${rgb}\x1b\\`;
    })
    .join('');
}
