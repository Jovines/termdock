/**
 * Terminal renderer mode — determines how xterm.js draws pixels to screen.
 */
export type TerminalRendererMode = 'auto' | 'webgl' | 'canvas';

export const DEFAULT_TERMINAL_RENDERER_MODE: TerminalRendererMode = 'auto';

export function isTerminalRendererMode(value: unknown): value is TerminalRendererMode {
  return value === 'auto' || value === 'webgl' || value === 'canvas';
}
