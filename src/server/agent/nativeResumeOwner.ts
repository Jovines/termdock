import { integrationError } from './integrationStore.js';

export interface NativeResumeOwnerCandidate {
  backendSessionId: string;
  tmuxSessionName?: string | null;
  cachedSlug: string | null;
  cachedNativeId: string | null;
}
interface NativeResumeInventoryEntry {
  sessionId: string;
  backendSessionId: string | null;
  mode: string;
  tmuxSessionName?: string | null;
  agentResume?: { slug: string; sessionId: string | null } | null;
}
interface NativeResumeBackend {
  mode: string;
  tmuxSessionName: string | null;
  agent: { slug: string } | null;
  agentSession: { sessionId: string | null } | null;
}
/** A tmux remains observable without a browser/PTY attachment, including after
 * service restart. Inventory UUIDs never filter the candidate set. */
export function collectNativeResumeOwnerCandidates(
  inventory: NativeResumeInventoryEntry[],
  backends: ReadonlyMap<string, NativeResumeBackend>,
): NativeResumeOwnerCandidate[] {
  const candidates: NativeResumeOwnerCandidate[] = [];
  const seenTmux = new Set<string>(), seenBackend = new Set<string>();
  for (const entry of inventory) {
    if (entry.mode !== 'tmux' || !entry.tmuxSessionName || seenTmux.has(entry.tmuxSessionName)) continue;
    const backend = entry.backendSessionId ? backends.get(entry.backendSessionId) : null;
    candidates.push({ backendSessionId: entry.backendSessionId ?? `inventory:${entry.sessionId}`,
      tmuxSessionName: entry.tmuxSessionName, cachedSlug: backend?.agent?.slug ?? entry.agentResume?.slug ?? null,
      cachedNativeId: backend?.agentSession?.sessionId ?? entry.agentResume?.sessionId ?? null });
    seenTmux.add(entry.tmuxSessionName);
    if (entry.backendSessionId) seenBackend.add(entry.backendSessionId);
  }
  for (const [backendSessionId, backend] of backends) {
    if (seenBackend.has(backendSessionId) || backend.mode === 'tmux' && backend.tmuxSessionName && seenTmux.has(backend.tmuxSessionName)) continue;
    candidates.push({ backendSessionId, tmuxSessionName: backend.mode === 'tmux' ? backend.tmuxSessionName : null,
      cachedSlug: backend.agent?.slug ?? null, cachedNativeId: backend.agentSession?.sessionId ?? null });
    if (backend.mode === 'tmux' && backend.tmuxSessionName) seenTmux.add(backend.tmuxSessionName);
  }
  return candidates;
}
export interface NativeResumeProcess {
  confirmed: boolean;
  agentSlug: string | null;
  nativeId: string | null;
}

/** Only process observations prove presence or absence of another owner.
 * Cached UUIDs cannot exclude a terminal; the caller verifies its own pane. */
export async function assertNativeResumeAvailable(
  target: { slug: string; nativeSessionId: string },
  excludedBackendSessionId: string | null,
  candidates: NativeResumeOwnerCandidate[],
  observe: (candidate: NativeResumeOwnerCandidate) => Promise<NativeResumeProcess[]>,
): Promise<void> {
  let uncertain = false;
  for (const candidate of candidates) {
    if (candidate.backendSessionId === excludedBackendSessionId) continue;
    let processes: NativeResumeProcess[];
    try { processes = await observe(candidate); }
    catch { uncertain = true; continue; }
    for (const process of processes) {
      if (process.confirmed && process.agentSlug === target.slug && process.nativeId === target.nativeSessionId) {
        integrationError('NATIVE_SESSION_ALREADY_RUNNING', 'Another terminal process proves the exact native conversation is running', 409);
      }
      if (!process.confirmed || process.agentSlug === target.slug && !process.nativeId) uncertain = true;
    }
  }
  if (uncertain) integrationError('NATIVE_SESSION_OWNER_UNCONFIRMED', 'A possible native owner cannot be verified; inspect its terminal before restoring', 409);
}
