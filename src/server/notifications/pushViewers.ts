/**
 * Tracks which push-subscribed clients are actively viewing which terminal
 * session, so agent-transition pushes can skip the very client that is
 * already looking at the session (its notification would be redundant).
 *
 * The per-terminal WebSocket reports logical focus (session active + viewport
 * focused + document visible + window focused) on every change, including a
 * focus=false when the user switches sessions, blurs the window, or the
 * document goes hidden — and the WS close handler clears the entry when the
 * connection dies (e.g. the iOS PWA was killed without a clean focus=false).
 */
const viewingSessionsByClient = new Map<string, Set<string>>();

export function setClientViewingSession(
  pushClientId: string,
  sessionId: string,
  viewing: boolean,
): void {
  if (!pushClientId || !sessionId) return;
  if (!viewing) {
    const sessions = viewingSessionsByClient.get(pushClientId);
    if (!sessions) return;
    sessions.delete(sessionId);
    if (sessions.size === 0) viewingSessionsByClient.delete(pushClientId);
    return;
  }
  let sessions = viewingSessionsByClient.get(pushClientId);
  if (!sessions) {
    sessions = new Set();
    viewingSessionsByClient.set(pushClientId, sessions);
  }
  sessions.add(sessionId);
}

/** Push subscription clientIds currently looking at the given session. */
export function getViewingPushClientIds(sessionId: string): Set<string> {
  const result = new Set<string>();
  if (!sessionId) return result;
  for (const [pushClientId, sessions] of viewingSessionsByClient) {
    if (sessions.has(sessionId)) result.add(pushClientId);
  }
  return result;
}
