/**
 * Tracks which push-subscribed clients are actively viewing the app, using
 * their visible terminal sessions as presence signals. Pushes can then skip
 * every client that already has Termdock in the foreground, regardless of
 * which session produced the event.
 *
 * The per-terminal WebSocket reports viewing state (session active + document
 * visible + window focused + stream ready — deliberately NOT textarea focus,
 * since mobile users routinely watch output with the keyboard dismissed) on
 * every change, including a viewing=false when the user switches sessions,
 * backgrounds the app, or the window blurs — and the WS close handler clears
 * the entry when the connection dies (e.g. the iOS PWA was killed without a
 * clean viewing=false).
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

/** Push subscription clientIds that currently have Termdock in the foreground. */
export function getForegroundPushClientIds(): Set<string> {
  return new Set(viewingSessionsByClient.keys());
}
