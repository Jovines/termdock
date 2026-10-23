import { create } from 'zustand';
import { useEffect } from 'react';
import { currentSecureClient, savedConnection } from '../../federation/browserIntegration';
export type SessionViewMode = 'terminal' | 'chat';
const state = create<{ modes: Record<string, SessionViewMode>; errors: Record<string, string | undefined> }>(() => ({ modes: {}, errors: {} }));
const clearError = (key: string) => state.setState(value => ({ errors: { ...value.errors, [key]: undefined } }));
interface Entry { refs: number; epoch: number; writing: boolean; reading: boolean; queued?: SessionViewMode; confirmed?: SessionViewMode; timer?: ReturnType<typeof setInterval>; current: () => boolean; url: string; key: string }
const entries = new Map<string, Entry>();
const valid = (mode: unknown): mode is SessionViewMode => mode === 'terminal' || mode === 'chat';
function apply(key: string, mode: SessionViewMode) {
  state.setState(value => ({ modes: { ...value.modes, [key]: mode } }));
  try { localStorage.setItem(key, mode); } catch { /* Retain the server-backed in-memory value. */ }
}
async function write(entry: Entry, mode: SessionViewMode) {
  entry.queued = mode; entry.epoch++;
  if (entry.writing) return;
  entry.writing = true;
  let requestClient = currentSecureClient();
  try {
    while (entry.queued && entry.current()) {
      const requested = entry.queued; entry.queued = undefined;
      requestClient = currentSecureClient();
      const response = await fetch(entry.url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: requested }) });
      if (!response.ok) throw new Error('模式保存失败');
      const result = await response.json();
      if (!valid(result.mode)) throw new Error('模式保存失败');
      if (currentSecureClient() === requestClient && entry.current()) {
        entry.confirmed = result.mode;
        if (!entry.queued) apply(entry.key, result.mode);
      }
    }
  } catch {
    if (!entry.queued && entry.current() && currentSecureClient() === requestClient) { if (entry.confirmed) apply(entry.key, entry.confirmed); state.setState(value => ({ errors: { ...value.errors, [entry.key]: '显示模式未保存，请检查连接后重新切换' } })); }
  } finally { entry.writing = false; if (entry.queued && entry.current()) void write(entry, entry.queued); else if (!entry.refs && entries.get(entry.key) === entry) entries.delete(entry.key); }
}
export function useSessionViewMode(sessionId: string, synchronize = true, defaultMode: SessionViewMode = 'terminal', preferDefault = false): [SessionViewMode, (mode: SessionViewMode) => void, string | undefined, () => void] {
  const target = savedConnection()?.targetPeerId || location.origin, key = `termdock:session-view:${target}:${sessionId}`;
  const stored = state(value => value.modes[key]), error = state(value => value.errors[key]);
  let cached: SessionViewMode | undefined, fallback = defaultMode;
  try { const local = localStorage.getItem(key); if (valid(local)) cached = local; if (sessionStorage.getItem(`termdock:shared-view:${target}`) === 'chat') fallback = 'chat'; } catch { /* Optional local cache. */ }
  useEffect(() => {
    if (!sessionId || !synchronize) return;
    let entry = entries.get(key);
    if (!entry) {
      entry = { key, url: `/api/terminal/${encodeURIComponent(sessionId)}/view-mode`, refs: 0, epoch: 0, writing: false, reading: false,
        current: () => (savedConnection()?.targetPeerId || location.origin) === target && !currentSecureClient()?.closed };
      entries.set(key, entry);
    }
    entry.refs++;
    const owned = entry;
    const refresh = async () => {
      if (owned.writing || owned.reading || !owned.current() || document.visibilityState === 'hidden') return;
      const epoch = owned.epoch, client = currentSecureClient(); owned.reading = true;
      try {
        const response = await fetch(owned.url); if (!response.ok) return;
        const result = await response.json();
        if (owned.epoch !== epoch || owned.writing || !owned.current() || currentSecureClient() !== client || entries.get(key) !== owned) return;
        if (valid(result.mode)) { owned.confirmed = result.mode; apply(key, result.mode); }
        else if (result.mode === null && (preferDefault || cached)) { const initial = preferDefault ? defaultMode : cached!; apply(key, initial); void write(owned, initial); }
      } catch { /* Keep the last view while disconnected. */ } finally { owned.reading = false; }
    };
    if (!entry.timer) { void refresh(); entry.timer = setInterval(() => void refresh(), 2500); }
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('online', visible); document.addEventListener('visibilitychange', visible);
    return () => { window.removeEventListener('online', visible); document.removeEventListener('visibilitychange', visible); if (--owned.refs === 0) { clearInterval(owned.timer); owned.timer = undefined; if (!owned.writing) entries.delete(key); } };
  }, [sessionId, synchronize, key, target, defaultMode, preferDefault]);
  return [stored || (preferDefault ? fallback : cached || fallback), mode => {
    if (!sessionId) return;
    clearError(key); apply(key, mode);
    const entry = entries.get(key);
    if (entry) void write(entry, mode);
  }, error, () => clearError(key)];
}
