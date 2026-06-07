/**
 * Terminal backend abstraction — re-exports.
 */

export type { TerminalBackendType, TerminalModes } from './types';
export { getTerminalModes, getCellMetrics, getBackendType } from './types';
export { ensureGhosttyWasmReady } from './ghostty';
