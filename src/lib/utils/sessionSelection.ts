export function pickSessionAfterClose<T>(
  sessions: readonly T[],
  closedSessionId: string,
  getSessionId: (session: T) => string,
): string | null {
  const closedIndex = sessions.findIndex((session) => getSessionId(session) === closedSessionId);
  if (closedIndex < 0) return null;

  return (sessions[closedIndex + 1]
    ? getSessionId(sessions[closedIndex + 1]!)
    : closedIndex > 0
      ? getSessionId(sessions[closedIndex - 1]!)
      : null);
}
