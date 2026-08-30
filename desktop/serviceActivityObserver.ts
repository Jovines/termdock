/**
 * Runs in the service page's main world before its own scripts.
 *
 * The observer deliberately watches the page's existing terminal streams
 * instead of opening extra HTTP/WS connections. That lets a new desktop shell
 * understand agent activity from older Termdock web clients without doubling
 * terminal traffic or requiring the remote service to upgrade first.
 */
export function installServiceActivityObserver(): void {
  const marker = '__termdockDesktopActivityObserverV1';
  const page = window as typeof window & Record<string, unknown>;
  if (page[marker]) return;
  page[marker] = true;

  type Activity = { running: boolean; review: boolean };
  const activityBySession = new Map<string, Activity>();
  const richStatusSessions = new Set<string>();
  const openStreamsBySession = new Map<string, number>();
  const closeTimers = new Map<string, number>();

  const sessionIdFromUrl = (rawUrl: unknown): string | null => {
    try {
      const url = new URL(String(rawUrl), window.location.href);
      const match = url.pathname.match(/\/api\/terminal\/([^/]+)\/(?:ws|stream)$/);
      return match ? decodeURIComponent(match[1]) : null;
    } catch {
      return null;
    }
  };

  const publish = () => {
    let runningCount = 0;
    let reviewCount = 0;
    for (const activity of activityBySession.values()) {
      if (activity.running) runningCount += 1;
      if (activity.review) reviewCount += 1;
    }
    window.postMessage({
      source: 'termdock-desktop-activity-v1',
      activity: { runningCount, reviewCount },
    }, window.location.origin);
  };

  const recordPayload = (sessionId: string, rawData: unknown) => {
    if (typeof rawData !== 'string') return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawData) as Record<string, unknown>;
    } catch {
      return;
    }
    const current = activityBySession.get(sessionId) ?? { running: false, review: false };
    if (payload.type === 'agent-status') {
      richStatusSessions.add(sessionId);
      const agentStatus = typeof payload.agentStatus === 'string' ? payload.agentStatus : null;
      const next = {
        running: agentStatus === 'working',
        review: agentStatus === 'waiting' || payload.reviewed === false,
      };
      if (next.running !== current.running || next.review !== current.review) {
        activityBySession.set(sessionId, next);
        publish();
      }
      return;
    }
    // Very old services did not emit agent-status yet. Their connected event
    // still exposes the active program, which is enough for a conservative
    // running fallback (review remains unavailable on those versions).
    if (payload.type === 'connected' || payload.type === 'active-program') {
      if (richStatusSessions.has(sessionId)) return;
      const program = typeof payload.activeProgram === 'string' ? payload.activeProgram.toLowerCase() : '';
      const looksLikeAgent = /(?:^|\/)claude$|(?:^|\/)codex$|(?:^|\/)gemini$|(?:^|\/)opencode$|(?:^|\/)trae(?:x)?$|(?:^|\/)aider$/.test(program);
      if (looksLikeAgent !== current.running || current.review) {
        activityBySession.set(sessionId, { running: looksLikeAgent, review: false });
        publish();
      }
    }
  };

  const streamOpened = (sessionId: string) => {
    const pending = closeTimers.get(sessionId);
    if (pending !== undefined) {
      window.clearTimeout(pending);
      closeTimers.delete(sessionId);
    }
    openStreamsBySession.set(sessionId, (openStreamsBySession.get(sessionId) ?? 0) + 1);
  };

  const streamClosed = (sessionId: string) => {
    const remaining = Math.max(0, (openStreamsBySession.get(sessionId) ?? 1) - 1);
    if (remaining > 0) {
      openStreamsBySession.set(sessionId, remaining);
      return;
    }
    openStreamsBySession.delete(sessionId);
    // A reconnect replaces one socket with another. Delay removal so that
    // transition does not flash the global status back to zero.
    const timer = window.setTimeout(() => {
      closeTimers.delete(sessionId);
      if (openStreamsBySession.has(sessionId)) return;
      richStatusSessions.delete(sessionId);
      if (activityBySession.delete(sessionId)) publish();
    }, 1_500);
    closeTimers.set(sessionId, timer);
  };

  const observeStream = (stream: EventTarget, rawUrl: unknown) => {
    const sessionId = sessionIdFromUrl(rawUrl);
    if (!sessionId) return;
    streamOpened(sessionId);
    stream.addEventListener('message', (event) => {
      recordPayload(sessionId, (event as MessageEvent).data);
    });
    stream.addEventListener('close', () => streamClosed(sessionId), { once: true });
    // EventSource has no close event and transient errors automatically
    // reconnect, so wrap its explicit close method instead of treating every
    // network interruption as a removed session.
    if (typeof EventSource !== 'undefined' && stream instanceof EventSource) {
      const nativeClose = stream.close.bind(stream);
      stream.close = () => {
        streamClosed(sessionId);
        nativeClose();
      };
    }
  };

  const NativeWebSocket = window.WebSocket;
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget) as WebSocket;
      observeStream(socket, args[0]);
      return socket;
    },
  });

  if (typeof window.EventSource === 'function') {
    const NativeEventSource = window.EventSource;
    window.EventSource = new Proxy(NativeEventSource, {
      construct(target, args, newTarget) {
        const stream = Reflect.construct(target, args, newTarget) as EventSource;
        observeStream(stream, args[0]);
        return stream;
      },
    });
  }
  publish();
}
