// Per-session font size override: lets an individual terminal session render at
// a different font size than the global setting. Persisted per frontend session
// id so it survives page refresh; cleared when the session is removed.
//
// Change notification: `termfontchange` CustomEvent on `window` with
// SessionFontSizeChangeDetail. Views filter by sessionId before applying.

export const SESSION_FONT_SIZE_STORAGE_KEY = 'termdock-session-fonts-v1';

// Same clamp as the global settings UI and the ctrl/⌘+wheel gesture.
export const MIN_SESSION_FONT_SIZE = 8;
export const MAX_SESSION_FONT_SIZE = 32;

export interface SessionFontSizeChangeDetail {
  sessionId: string;
  /** New size in px; null means the override was cleared (follow global again). */
  fontSize: number | null;
}

export function clampSessionFontSize(size: number): number {
  if (!Number.isFinite(size)) return MIN_SESSION_FONT_SIZE;
  return Math.max(MIN_SESSION_FONT_SIZE, Math.min(MAX_SESSION_FONT_SIZE, Math.round(size)));
}

function readSessionFontSizes(): Record<string, number> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(SESSION_FONT_SIZE_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const result: Record<string, number> = {};
    for (const [sessionId, size] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof size === 'number' && Number.isFinite(size)) {
        result[sessionId] = clampSessionFontSize(size);
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writeSessionFontSizes(sizes: Record<string, number>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SESSION_FONT_SIZE_STORAGE_KEY, JSON.stringify(sizes));
  } catch { /* ignore */ }
}

/** Effective per-session override; null = follow the global setting. */
export function getSessionFontSize(sessionId: string): number | null {
  return readSessionFontSizes()[sessionId] ?? null;
}

/** Persist (or clear) the override and notify views via `termfontchange`. */
export function setSessionFontSize(sessionId: string, fontSize: number | null): void {
  if (typeof window === 'undefined') return;
  const sizes = readSessionFontSizes();
  const normalized = fontSize === null ? null : clampSessionFontSize(fontSize);
  if (normalized === null) {
    delete sizes[sessionId];
  } else {
    sizes[sessionId] = normalized;
  }
  writeSessionFontSizes(sizes);
  window.dispatchEvent(new CustomEvent<SessionFontSizeChangeDetail>('termfontchange', {
    detail: { sessionId, fontSize: normalized },
  }));
}

/** Silent removal (no event) — used when a session is closed/removed. */
export function removeSessionFontSize(sessionId: string): void {
  if (typeof window === 'undefined') return;
  const sizes = readSessionFontSizes();
  if (!(sessionId in sizes)) return;
  delete sizes[sessionId];
  writeSessionFontSizes(sizes);
}

export function clearAllSessionFontSizes(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(SESSION_FONT_SIZE_STORAGE_KEY);
  } catch { /* ignore */ }
}
