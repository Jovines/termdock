// The pinned OpenUI 1.0.1 web entry auto-loads a CDN inspector in development.
// Termdock owns its UI and diagnostics; don't mount that extra product surface.
const flags = globalThis as typeof globalThis & Record<symbol, unknown>;
flags[Symbol.for('openui.devtools.autoMount')] = true;
