import type { AgentLaunchCheck } from './agentLaunchCheck.js';
import { TerminalInputTargetChangedError } from './terminalInput.js';
import type { NativeProcessIdentityConfig } from './nativeProcessIdentity.js';

export interface SessionLaunchState {
  backendSessionId: string | null;
  agentLaunchGeneration?: string | null;
  agentLaunchCheck?: AgentLaunchCheck | null;
  agentNativeIdentity?: NativeProcessIdentityConfig | null;
}

export interface LaunchStateChange {
  expectedGeneration: string | null;
  expectedCheckId: string | null;
  generation: string | null;
  check: AgentLaunchCheck | null;
  nativeIdentity?: NativeProcessIdentityConfig | null;
}

/** Display/identity metadata may have crossed an await with an old snapshot.
 * Only the launch lifecycle can change these server-owned control fields. */
export function mergeSessionLaunchState<T extends SessionLaunchState>(
  candidate: T, current: T | undefined, change?: LaunchStateChange,
): T {
  if (!change) return current ? { ...candidate,
    agentLaunchGeneration: current.agentLaunchGeneration ?? null,
    agentLaunchCheck: current.agentLaunchCheck ?? null,
    agentNativeIdentity: current.agentNativeIdentity ?? null,
  } : candidate;
  if (!current || (current.agentLaunchGeneration ?? null) !== change.expectedGeneration
    || (current.agentLaunchCheck?.id ?? null) !== change.expectedCheckId) {
    throw new TerminalInputTargetChangedError({
      expected_backend_session_id: candidate.backendSessionId, current_backend_session_id: current?.backendSessionId ?? null,
      expected_launch_id: change.expectedGeneration, current_launch_id: current?.agentLaunchGeneration ?? null,
      backend_instance_matches: !!current && candidate.backendSessionId === current.backendSessionId,
      check_phase: 'launch_state_commit', checked_at: Date.now(),
    });
  }
  return { ...candidate, agentLaunchGeneration: change.generation, agentLaunchCheck: change.check,
    agentNativeIdentity: change.nativeIdentity === undefined ? current.agentNativeIdentity ?? null : change.nativeIdentity };
}

/** A file watcher can finish reading an old snapshot after an in-memory launch
 * or deletion. It must not revert server-owned fields or resurrect that ID. */
export function mergeReloadedSessionState<T extends SessionLaunchState & { sessionId: string }>(
  disk: T[], beforeRead: T[], current: T[],
): T[] {
  const before = new Map(beforeRead.map(record => [record.sessionId, record]));
  const live = new Map(current.map(record => [record.sessionId, record]));
  const result: T[] = [];
  const seen = new Set<string>();
  for (const candidate of disk) {
    const id = candidate.sessionId, now = live.get(id), old = before.get(id);
    if (seen.has(id) || old && !now) continue;
    seen.add(id);
    result.push(now ? JSON.stringify(now) !== JSON.stringify(old) ? now
      : mergeSessionLaunchState(candidate, now) : candidate);
  }
  for (const record of current) {
    if (!seen.has(record.sessionId) && (JSON.stringify(record) !== JSON.stringify(before.get(record.sessionId))
      || record.agentLaunchGeneration || record.agentNativeIdentity)) result.push(record);
  }
  return result;
}

/** Serialize durable global snapshots, taking a fresh value when each write
 * acquires the queue. A delayed old rename must not overwrite a later launch. */
export function createSessionStateWriter<T>(current: () => T, write: (snapshot: T) => Promise<void>): () => Promise<void> {
  let pending: Promise<void> = Promise.resolve();
  return () => {
    const next = pending.catch(() => undefined).then(() => write(structuredClone(current())));
    pending = next;
    return next;
  };
}
