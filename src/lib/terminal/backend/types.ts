/**
 * Terminal backend types for the ghostty-web integration.
 *
 * These types define the minimal abstraction needed to support both
 * xterm.js and ghostty-web in TerminalViewport.tsx.
 */

/** The type of terminal backend in use. */
export type TerminalBackendType = 'xterm' | 'ghostty';

/**
 * Normalized terminal modes — the key API difference between backends.
 *
 * xterm.js: `terminal.modes.mouseTrackingMode` (property)
 * ghostty:  `terminal.hasMouseTracking()` / `terminal.getMode(1, false)` (methods)
 */
export interface TerminalModes {
  mouseTrackingMode: 'none' | 'x10' | 'normal' | 'button-event' | 'any-event';
  applicationCursorKeysMode: boolean;
}

/**
 * Get normalized terminal modes from either backend.
 */
export function getTerminalModes(
  terminal: any,
  backend: TerminalBackendType,
): TerminalModes {
  if (backend === 'ghostty') {
    const hasMouse = terminal.hasMouseTracking();
    const appCursor = terminal.getMode(1, false); // DECCKM mode 1
    return {
      mouseTrackingMode: hasMouse ? 'normal' : 'none',
      applicationCursorKeysMode: appCursor,
    };
  }
  // xterm.js
  return {
    mouseTrackingMode: terminal.modes?.mouseTrackingMode ?? 'none',
    applicationCursorKeysMode: terminal.modes?.applicationCursorKeysMode === true,
  };
}

/**
 * Get cell metrics (width/height in pixels) for IME anchor positioning.
 *
 * xterm.js: queries `.xterm-rows` DOM element
 * ghostty:  uses `terminal.renderer.getMetrics()`
 */
export function getCellMetrics(
  terminal: any,
  backend: TerminalBackendType,
): { cellWidth: number; cellHeight: number } {
  if (backend === 'ghostty') {
    const renderer = terminal.renderer;
    if (renderer) {
      const m = renderer.getMetrics();
      return { cellWidth: m.width, cellHeight: m.height };
    }
  }

  // xterm.js: measure from DOM
  let cellW = 8;
  let cellH = 17;
  try {
    const rowsEl = terminal.element?.querySelector('.xterm-rows') as HTMLElement | null;
    const firstRow = rowsEl?.firstElementChild as HTMLElement | null;
    if (firstRow && firstRow.offsetHeight > 0) {
      cellH = firstRow.offsetHeight;
    }
    if (rowsEl && rowsEl.offsetWidth > 0 && terminal.cols > 0) {
      cellW = rowsEl.offsetWidth / terminal.cols;
    }
  } catch { /* fall through */ }

  if (cellW <= 0 || cellH <= 0) {
    const rect = terminal.element?.getBoundingClientRect();
    if (rect) {
      if (rect.width > 0 && terminal.cols > 0) cellW = rect.width / terminal.cols;
      if (rect.height > 0 && terminal.rows > 0) cellH = rect.height / terminal.rows;
    }
  }

  return { cellWidth: cellW, cellHeight: cellH };
}

/**
 * Determine the backend type from the renderer mode setting.
 */
export function getBackendType(rendererMode: string): TerminalBackendType {
  return rendererMode === 'ghostty' ? 'ghostty' : 'xterm';
}
