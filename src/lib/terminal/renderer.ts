/**
 * Terminal renderer mode — determines how xterm.js draws pixels to screen.
 *
 * Note: with @xterm/xterm v6 the published @xterm/addon-canvas package still
 * targets xterm v5, so the historical "canvas" option is kept as a persisted
 * compatibility alias for xterm's built-in stable renderer rather than loading
 * an incompatible canvas addon.
 */
export type TerminalRendererMode = 'auto' | 'webgl' | 'canvas';

export const DEFAULT_TERMINAL_RENDERER_MODE: TerminalRendererMode = 'auto';

export function isTerminalRendererMode(value: unknown): value is TerminalRendererMode {
  return value === 'auto' || value === 'webgl' || value === 'canvas';
}
