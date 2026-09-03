export interface PersistedAgentResumeInfo {
  slug: string;
  sessionId: string | null;
  launchArgv: string[] | null;
  updatedAt: number;
}

const SAFE_AGENT_SLUG = /^[A-Za-z0-9._-]+$/;
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

/** Normalize the last-known Agent conversation before it reaches disk again. */
export function normalizePersistedAgentResumeInfo(input: unknown): PersistedAgentResumeInfo | null {
  if (!input || typeof input !== 'object') return null;
  const candidate = input as Partial<PersistedAgentResumeInfo>;
  const slug = typeof candidate.slug === 'string' ? candidate.slug.trim() : '';
  const sessionId = typeof candidate.sessionId === 'string' ? candidate.sessionId.trim() : '';
  if (!slug || !SAFE_AGENT_SLUG.test(slug) || !sessionId || !SAFE_SESSION_ID.test(sessionId)) {
    return null;
  }

  const launchArgv = candidate.launchArgv === null || candidate.launchArgv === undefined
    ? null
    : Array.isArray(candidate.launchArgv)
      && candidate.launchArgv.length <= 256
      && candidate.launchArgv.every((value) => typeof value === 'string' && value.length <= 8_192)
      ? [...candidate.launchArgv]
      : null;

  return {
    slug,
    sessionId,
    launchArgv,
    updatedAt: typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
      ? Math.floor(candidate.updatedAt)
      : Date.now(),
  };
}

/** A dead shell is worth rebuilding only when it can restore an Agent conversation. */
export function canRestoreDeadAgentShell(input: {
  cwd?: string | null;
  agentResume?: PersistedAgentResumeInfo | null;
}): boolean {
  return typeof input.cwd === 'string'
    && input.cwd.trim().length > 0
    && typeof input.agentResume?.sessionId === 'string'
    && input.agentResume.sessionId.length > 0;
}

/**
 * A live Agent process can confirm recovery even when its session-start hook
 * is delayed or unavailable. Require both the Agent identity and the native
 * session id from the process argv so an unrelated fresh launch cannot clear
 * the recovery offer.
 */
export function isConfirmedAgentResumeProcess(
  pending: PersistedAgentResumeInfo | null | undefined,
  detectedSlug: string,
  inferredSessionId: string | null,
): boolean {
  return Boolean(
    pending?.sessionId
    && pending.slug === detectedSlug
    && pending.sessionId === inferredSessionId,
  );
}
