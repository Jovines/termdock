/**
 * ghostty-web integration utilities.
 *
 * Provides lazy WASM loading and terminal creation for the ghostty-web backend.
 */

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
    return Promise.resolve(cachedModule);
  }
  if (initPromise) {
    return initPromise;
  }
  initPromise = (async () => {
    const mod = await import('ghostty-web');
    await mod.init();
    cachedModule = mod;
    return mod;
  })().catch((error) => {
    initPromise = null;
    throw error;
  });
  return initPromise;
}
