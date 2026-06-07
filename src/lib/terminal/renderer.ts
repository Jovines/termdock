/**
 * Terminal engine type — determines which VT parser/terminal emulator is used.
 * This is the "brain" that parses escape sequences and maintains terminal state.
 */
export type TerminalEngine = 'xterm' | 'ghostty';

/**
 * Terminal renderer mode — determines how pixels are drawn to screen.
 * Only applies to the xterm.js engine; ghostty always uses Canvas 2D.
 */
export type TerminalRendererMode = 'auto' | 'webgl' | 'canvas';

export const DEFAULT_TERMINAL_RENDERER_MODE: TerminalRendererMode = 'auto';
export const DEFAULT_TERMINAL_ENGINE: TerminalEngine = 'ghostty';

export function isTerminalRendererMode(value: unknown): value is TerminalRendererMode {
  return value === 'auto' || value === 'webgl' || value === 'canvas';
}

export function isTerminalEngine(value: unknown): value is TerminalEngine {
  return value === 'xterm' || value === 'ghostty';
}
