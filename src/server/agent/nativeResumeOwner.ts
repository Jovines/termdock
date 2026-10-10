import { CollaborationError } from './collaborationProtocol.js';

export interface NativeResumeOwnerCandidate {
  backendSessionId: string;
  sessionId?: string | null;
  backendAttached?: boolean;
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
      sessionId: entry.sessionId, backendAttached: !!backend,
      tmuxSessionName: entry.tmuxSessionName, cachedSlug: backend?.agent?.slug ?? entry.agentResume?.slug ?? null,
      cachedNativeId: backend?.agentSession?.sessionId ?? entry.agentResume?.sessionId ?? null });
    seenTmux.add(entry.tmuxSessionName);
    if (entry.backendSessionId) seenBackend.add(entry.backendSessionId);
  }
  for (const [backendSessionId, backend] of backends) {
    if (seenBackend.has(backendSessionId) || backend.mode === 'tmux' && backend.tmuxSessionName && seenTmux.has(backend.tmuxSessionName)) continue;
    candidates.push({ backendSessionId, sessionId: inventory.find(entry => entry.backendSessionId === backendSessionId)?.sessionId ?? null,
      backendAttached: true, tmuxSessionName: backend.mode === 'tmux' ? backend.tmuxSessionName : null,
      cachedSlug: backend.agent?.slug ?? null, cachedNativeId: backend.agentSession?.sessionId ?? null });
    if (backend.mode === 'tmux' && backend.tmuxSessionName) seenTmux.add(backend.tmuxSessionName);
  }
  return candidates;
}
export interface NativeResumeProcess {
  confirmed: boolean;
  agentSlug: string | null;
  nativeId: string | null;
  paneId?: string;
  panePid?: number;
  processPid?: number;
  nativeIdentitySource?: 'argv' | 'linux-flock-owner' | null;
  nativeIdentityFailure?: 'NATIVE_SESSION_IDENTITY_CONFLICT' | 'NATIVE_SESSION_IDENTITY_AMBIGUOUS' | 'NATIVE_SESSION_PROCESS_CHANGED' | 'NATIVE_SESSION_OWNERSHIP_UNCONFIRMED' | null;
  tmuxSessionId?: string;
  program?: string | null;
  processSource?: string;
  argumentsObserved?: boolean;
  shellFailure?: ShellVerificationFailure | null;
  pgid?: number | null;
  tpgid?: number | null;
}
export type ShellVerificationFailure = 'SHELL_PROCESS_NOT_FOUND' | 'SHELL_FOREGROUND_MISMATCH'
  | 'SHELL_ARGUMENTS_UNSUPPORTED' | 'SHELL_OBSERVATION_FAILED';
export type NativeOwnerDiagnosticReason = ShellVerificationFailure | 'TERMINAL_OBSERVATION_FAILED'
  | 'PROCESS_ARGUMENTS_UNAVAILABLE' | 'FOREGROUND_PROCESS_UNCONFIRMED' | 'NATIVE_SESSION_ID_MISSING' | 'NATIVE_SESSION_MATCH'
  | 'NATIVE_SESSION_IDENTITY_CONFLICT' | 'NATIVE_SESSION_IDENTITY_AMBIGUOUS' | 'NATIVE_SESSION_PROCESS_CHANGED' | 'NATIVE_SESSION_OWNERSHIP_UNCONFIRMED';
export interface NativeOwnerDiagnostic {
  session_id: string | null; backend_session_id: string | null; backend_attached: boolean | null;
  tmux_session_name: string | null; tmux_session_id: string | null; pane_id: string | null; pane_pid: number | null;
  process_pid: number | null; native_identity_source: 'argv' | 'linux-flock-owner' | null;
  program: string | null; process_source: string | null; arguments_observed: boolean;
  agent_slug: string | null; last_known_native_id: string | null; observed_native_id: string | null;
  pgid: number | null; tpgid: number | null; reason: NativeOwnerDiagnosticReason; observed_at: number;
}
export interface NativeOwnerCheck {
  code: 'NATIVE_SESSION_ALREADY_RUNNING' | 'NATIVE_SESSION_OWNER_UNCONFIRMED'; checked_at: number;
  candidates: NativeOwnerDiagnostic[]; total_blockers: number; truncated: boolean;
}
export class NativeResumeOwnerError extends CollaborationError {
  readonly diagnostics: NativeOwnerCheck;
  constructor(code: NativeOwnerCheck['code'], blockers: NativeOwnerDiagnostic[]) {
    super(code, code === 'NATIVE_SESSION_ALREADY_RUNNING'
      ? 'Another terminal process proves the exact native conversation is running'
      : 'A possible native owner cannot be verified; inspect its terminal before restoring', 409);
    // Preserve the proven owner even when earlier uncertain panes exceed the bound.
    const ordered = code === 'NATIVE_SESSION_ALREADY_RUNNING' ? [blockers.at(-1)!, ...blockers.slice(0, -1)] : blockers;
    this.diagnostics = { code, checked_at: Date.now(), candidates: ordered.slice(0, 128), total_blockers: blockers.length, truncated: blockers.length > 128 };
  }
}
function diagnostic(candidate: NativeResumeOwnerCandidate, process: NativeResumeProcess | null, reason: NativeOwnerDiagnosticReason): NativeOwnerDiagnostic {
  // Store only named locator/evidence fields. Never serialize a callback error,
  // argv, terminal text, cwd, or plugin/wrapper payload into diagnostics.
  const text = (value: string | null | undefined) => typeof value === 'string' && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
  const pid = (value: number | null | undefined) => Number.isInteger(value) && value! > 0 ? value! : null;
  return { session_id: text(candidate.sessionId), backend_session_id: candidate.backendSessionId.startsWith('inventory:') ? null : text(candidate.backendSessionId),
    backend_attached: candidate.backendAttached ?? null, tmux_session_name: text(candidate.tmuxSessionName),
    tmux_session_id: text(process?.tmuxSessionId), pane_id: text(process?.paneId), pane_pid: pid(process?.panePid),
    process_pid: pid(process?.processPid), native_identity_source: process?.nativeIdentitySource === 'argv'
      || process?.nativeIdentitySource === 'linux-flock-owner' ? process.nativeIdentitySource : null,
    program: text(process?.program), process_source: text(process?.processSource), arguments_observed: process?.argumentsObserved === true,
    agent_slug: text(process?.agentSlug), last_known_native_id: text(candidate.cachedNativeId), observed_native_id: text(process?.nativeId),
    pgid: Number.isInteger(process?.pgid) ? process!.pgid! : null,
    tpgid: Number.isInteger(process?.tpgid) ? process!.tpgid! : null, reason, observed_at: Date.now() };
}

/** Only process observations prove presence or absence of another owner.
 * Cached UUIDs cannot exclude a terminal; the caller verifies its own pane. */
export async function assertNativeResumeAvailable(
  target: { slug: string; nativeSessionId: string },
  excludedBackendSessionId: string | null,
  candidates: NativeResumeOwnerCandidate[],
  observe: (candidate: NativeResumeOwnerCandidate) => Promise<NativeResumeProcess[]>,
): Promise<void> {
  const blockers: NativeOwnerDiagnostic[] = [];
  for (const candidate of candidates) {
    if (candidate.backendSessionId === excludedBackendSessionId) continue;
    let processes: NativeResumeProcess[];
    try { processes = await observe(candidate); }
    catch { blockers.push(diagnostic(candidate, null, 'TERMINAL_OBSERVATION_FAILED')); continue; }
    for (const process of processes) {
      if (process.confirmed && process.agentSlug === target.slug && process.nativeId === target.nativeSessionId) {
        blockers.push(diagnostic(candidate, process, 'NATIVE_SESSION_MATCH'));
        throw new NativeResumeOwnerError('NATIVE_SESSION_ALREADY_RUNNING', blockers);
      }
      if (!process.confirmed) blockers.push(diagnostic(candidate, process, process.nativeIdentityFailure ?? process.shellFailure
        ?? (process.argumentsObserved === false ? 'PROCESS_ARGUMENTS_UNAVAILABLE' : 'FOREGROUND_PROCESS_UNCONFIRMED')));
      else if (process.agentSlug === target.slug && !process.nativeId) blockers.push(diagnostic(candidate, process, 'NATIVE_SESSION_ID_MISSING'));
    }
  }
  if (blockers.length) throw new NativeResumeOwnerError('NATIVE_SESSION_OWNER_UNCONFIRMED', blockers);
}
