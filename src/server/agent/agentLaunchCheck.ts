/** A one-time process/binding check for a TD-initiated Agent launch.
 * This is not an application input-ready or consumption signal. */
export interface AgentLaunchCheck {
  id: string;
  agentSlug: string;
  nativeSessionId: string | null;
  deadline: number;
}

export function normalizeAgentLaunchCheck(input: unknown): AgentLaunchCheck | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Partial<AgentLaunchCheck>;
  if (typeof value.id !== 'string' || !value.id || typeof value.agentSlug !== 'string' || !value.agentSlug
    || !Number.isFinite(value.deadline) || !(value.nativeSessionId === null || typeof value.nativeSessionId === 'string')) return null;
  return { id: value.id, agentSlug: value.agentSlug, nativeSessionId: value.nativeSessionId, deadline: value.deadline! };
}

/** Caller supplies current terminal process evidence, never screen text or cached hooks. */
export function agentLaunchBlockReason(check: AgentLaunchCheck | null | undefined,
  observed: { agentSlug: string | null; nativeSessionId: string | null }, now = Date.now()): string | null {
  if (!check) return null;
  // A late actual observation can resolve an earlier timeout without retyping.
  if (observed.agentSlug === check.agentSlug
    && (!check.nativeSessionId || observed.nativeSessionId === check.nativeSessionId)) return null;
  if (observed.agentSlug && observed.agentSlug !== check.agentSlug
    || check.nativeSessionId && observed.nativeSessionId && observed.nativeSessionId !== check.nativeSessionId) return 'AGENT_LAUNCH_IDENTITY_MISMATCH';
  return now >= check.deadline ? 'AGENT_LAUNCH_TIMEOUT' : 'AGENT_LAUNCH_PENDING';
}
