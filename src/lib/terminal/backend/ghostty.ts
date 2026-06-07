/**
 * ghostty-web integration utilities.
 *
 * Provides lazy WASM loading and terminal creation for the ghostty-web backend.
 */

import { clientLog } from '../../utils/clientLog';

/**
 * Lazily load the ghostty-web WASM module.
 * Must be called (and awaited) before creating a ghostty Terminal.
 * Returns the module reference for use in terminal creation.
 * Subsequent calls return the cached module instantly.
 */
let cachedModule: typeof import('ghostty-web') | null = null;
let initPromise: Promise<typeof import('ghostty-web')> | null = null;

export function ensureGhosttyWasmReady(): Promise<typeof import('ghostty-web')> {
  if (cachedModule) {
    console.debug('[DEBUG_Ghostty] wasm ready: cached module');
    clientLog('debug', '[DEBUG_Ghostty] wasm ready: cached module');
    return Promise.resolve(cachedModule);
  }
  if (initPromise) {
    console.debug('[DEBUG_Ghostty] wasm ready: reuse pending init');
    clientLog('debug', '[DEBUG_Ghostty] wasm ready: reuse pending init');
    return initPromise;
  }
  console.info('[DEBUG_Ghostty] wasm init start');
  clientLog('info', '[DEBUG_Ghostty] wasm init start');
  initPromise = (async () => {
    const mod = await import('ghostty-web');
    await mod.init();
    cachedModule = mod;
    console.info('[DEBUG_Ghostty] wasm init done');
    clientLog('info', '[DEBUG_Ghostty] wasm init done');
    return mod;
  })().catch((error) => {
    console.error('[DEBUG_Ghostty] wasm init failed', error);
    clientLog('error', '[DEBUG_Ghostty] wasm init failed', { error: error instanceof Error ? error.message : String(error) });
    initPromise = null;
    throw error;
  });
  return initPromise;
}
