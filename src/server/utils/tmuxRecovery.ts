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
  candidates: TmuxRecoveryCandidate[];
  liveSessionNames: ReadonlySet<string>;
  intentionallyDeleting?: ReadonlySet<string>;
  existingIncident?: TmuxRecoveryIncident | null;
  dismissedSessionIds?: ReadonlySet<string>;
  now?: number;
}): TmuxRecoveryIncident | null {
  if (input.existingIncident) return input.existingIncident;
  const intentionallyDeleting = input.intentionallyDeleting ?? new Set<string>();
  const recoverable = input.candidates.filter((candidate) =>
    candidate.resumable
    && !input.dismissedSessionIds?.has(candidate.sessionId)
    && !intentionallyDeleting.has(candidate.tmuxSessionName));
  const missing = recoverable.filter((candidate) =>
    !input.liveSessionNames.has(candidate.tmuxSessionName));
  if (recoverable.length === 0) return null;

  const knownTmuxCount = input.candidates.filter((candidate) =>
    !intentionallyDeleting.has(candidate.tmuxSessionName)).length;
  const serverGenerationChanged = input.previousServerPid !== null
    && input.currentServerPid !== input.previousServerPid;
  const bulkLoss = knownTmuxCount >= 2
    && input.liveSessionNames.size === 0
    && missing.length >= 1;
  if (!serverGenerationChanged && !bulkLoss && missing.length === 0) return null;
  const affected = serverGenerationChanged ? recoverable : missing;
  if (affected.length === 0) return null;

  const now = input.now ?? Date.now();
  return {
    id: `tmux-loss-${now.toString(36)}`,
    detectedAt: now,
    previousServerPid: input.previousServerPid,
    currentServerPid: input.currentServerPid,
    affectedSessionIds: affected.map((candidate) => candidate.sessionId),
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
