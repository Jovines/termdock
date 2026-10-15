import type { AgentLaunchCheck } from './agentLaunchCheck.js';
import { TerminalInputTargetChangedError } from './terminalInput.js';

export interface SessionLaunchState {
  backendSessionId: string | null;
  agentLaunchGeneration?: string | null;
  agentLaunchCheck?: AgentLaunchCheck | null;
}

export interface LaunchStateChange {
  expectedGeneration: string | null;
  expectedCheckId: string | null;
  generation: string | null;
  check: AgentLaunchCheck | null;
}

/** Display/identity metadata may have crossed an await with an old snapshot.
 * Only the launch lifecycle can change these server-owned control fields. */
export function mergeSessionLaunchState<T extends SessionLaunchState>(
  candidate: T, current: T | undefined, change?: LaunchStateChange,
): T {
  if (!change) return current ? { ...candidate,
    agentLaunchGeneration: current.agentLaunchGeneration ?? null,
    agentLaunchCheck: current.agentLaunchCheck ?? null,
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
  return { ...candidate, agentLaunchGeneration: change.generation, agentLaunchCheck: change.check };
}
