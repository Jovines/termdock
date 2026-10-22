export interface TmuxRecoveryCandidate {
  sessionId: string;
  tmuxSessionName: string;
  resumable: boolean;
}

export interface TmuxRecoveryIncident {
  id: string;
  detectedAt: number;
  previousServerPid: number | null;
  currentServerPid: number | null;
  affectedSessionIds: string[];
}

export function normalizeTmuxRecoveryIncident(input: unknown): TmuxRecoveryIncident | null {
  if (!input || typeof input !== 'object') return null;
  const candidate = input as Partial<TmuxRecoveryIncident>;
  if (typeof candidate.id !== 'string' || !Array.isArray(candidate.affectedSessionIds)) return null;
  const affectedSessionIds = candidate.affectedSessionIds
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (affectedSessionIds.length === 0) return null;
  return {
    id: candidate.id,
    detectedAt: typeof candidate.detectedAt === 'number' ? candidate.detectedAt : Date.now(),
    previousServerPid: typeof candidate.previousServerPid === 'number' ? candidate.previousServerPid : null,
    currentServerPid: typeof candidate.currentServerPid === 'number' ? candidate.currentServerPid : null,
    affectedSessionIds: Array.from(new Set(affectedSessionIds)),
  };
}

export function detectTmuxRecoveryIncident(input: {
  previousServerPid: number | null;
  currentServerPid: number | null;
  authoritativeTmuxList: boolean;
  candidates: TmuxRecoveryCandidate[];
  liveSessionNames: ReadonlySet<string>;
  intentionallyDeleting?: ReadonlySet<string>;
  existingIncident?: TmuxRecoveryIncident | null;
  dismissedSessionIds?: ReadonlySet<string>;
  /** Sessions with a matching Agent confirmed running in their live pane. */
  restoredSessionIds?: ReadonlySet<string>;
  now?: number;
}): TmuxRecoveryIncident | null {
  // A failed/disabled inventory is an unknown observation, never evidence of loss.
  if (!input.authoritativeTmuxList) return input.existingIncident ?? null;
  const intentionallyDeleting = input.intentionallyDeleting ?? new Set<string>();
  const recoverable = input.candidates.filter((candidate) =>
    candidate.resumable
    && !input.dismissedSessionIds?.has(candidate.sessionId)
    && !input.restoredSessionIds?.has(candidate.sessionId)
    && !intentionallyDeleting.has(candidate.tmuxSessionName));
  const missing = recoverable.filter((candidate) =>
    !input.liveSessionNames.has(candidate.tmuxSessionName));
  const existingIncident = input.existingIncident;
  if (existingIncident) {
    const eligibleIds = new Set(recoverable.map(candidate => candidate.sessionId));
    // A recreated shell still needs recovery. Only a verified running Agent,
    // removed record or explicit acknowledgement can retire its old entry.
    const affectedSessionIds = Array.from(new Set([
      ...existingIncident.affectedSessionIds.filter(id => eligibleIds.has(id)),
      ...missing.map(candidate => candidate.sessionId),
    ]));
    if (affectedSessionIds.length === 0) return null;
    if (affectedSessionIds.length === existingIncident.affectedSessionIds.length
      && affectedSessionIds.every((id, index) => id === existingIncident.affectedSessionIds[index])) {
      return existingIncident;
    }
    return { ...existingIncident, affectedSessionIds };
  }
  // A PID change is diagnostic context, not proof of session loss or a crash.
  // Require an actually missing session before creating a recovery incident.
  if (missing.length === 0) return null;

  const now = input.now ?? Date.now();
  return {
    id: `tmux-loss-${now.toString(36)}`,
    detectedAt: now,
    previousServerPid: input.previousServerPid,
    currentServerPid: input.currentServerPid,
    affectedSessionIds: missing.map((candidate) => candidate.sessionId),
  };
}

// A dismissed loss stays acknowledged until that session is observed alive
// again. Other sessions can still report new losses in the meantime.
export function retainDismissedTmuxSessions(
  dismissedSessionIds: readonly string[],
  candidates: TmuxRecoveryCandidate[],
  liveSessionNames: ReadonlySet<string>,
): string[] {
  return dismissedSessionIds.filter((id) => candidates.some((candidate) =>
    candidate.sessionId === id && !liveSessionNames.has(candidate.tmuxSessionName)));
}
