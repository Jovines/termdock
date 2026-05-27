import type {
  TerminalSession,
  TerminalStreamEvent,
  CreateTerminalOptions,
  ConnectStreamOptions,
  TmuxActionPayload,
  TmuxLayout,
  TmuxSessionSummary,
  TmuxStatus,
} from './types';

// ---- CSRF token (still needed for HTTP endpoints) ----

let csrfToken: string | null = null;

async function getCsrfToken(): Promise<string> {
  if (csrfToken) return csrfToken;
  const response = await fetch('/api/csrf-token');
  if (!response.ok) throw new Error('Failed to get CSRF token');
  const data = await response.json();
  csrfToken = data.csrfToken;
  return csrfToken as string;
}

// ---- WebSocket connections (replaces SSE + HTTP POST for terminal I/O) ----

interface WsConnection {
  ws: WebSocket;
  onEvent: (event: TerminalStreamEvent) => void;
  onError?: (error: Error, fatal?: boolean) => void;
  retryState: {
    maxRetries: number;
    initialDelayMs: number;
    maxDelayMs: number;
    connectionTimeoutMs: number;
    retryCount: number;
    retryTimeout: ReturnType<typeof setTimeout> | null;
    connectionTimeoutId: ReturnType<typeof setTimeout> | null;
    isClosed: boolean;
  };
}

const wsConnections = new Map<string, WsConnection>();

// Pending tmux request resolvers keyed by reqId.
const pendingTmuxRequests = new Map<
  string,
  { resolve: (value: { success: boolean; layout?: TmuxLayout }) => void; reject: (error: Error) => void }
>();

function resolveTmuxRequest(reqId: string, success: boolean, layout?: TmuxLayout, error?: string) {
  const entry = pendingTmuxRequests.get(reqId);
  if (!entry) return;
  pendingTmuxRequests.delete(reqId);
  if (success) {
    entry.resolve({ success: true, layout });
  } else {
    entry.reject(new Error(error || 'Tmux action failed'));
  }
}

function getWebSocketUrl(sessionId: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/api/terminal/${sessionId}/ws`;
}

// ---- Session management (HTTP, unchanged) ----

export async function createTerminalSession(
  options: CreateTerminalOptions
): Promise<TerminalSession> {
  const keepAliveMs = Object.prototype.hasOwnProperty.call(options, 'keepAliveMs')
    ? (options.keepAliveMs ?? null)
    : 3 * 60 * 60 * 1000;
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch('/api/terminal/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-XSRF-TOKEN': csrfTokenHeader,
    },
    body: JSON.stringify({
      cols: options.cols || 80,
      rows: options.rows || 24,
      mode: options.mode || 'shell',
      tmuxSessionName: options.tmuxSessionName,
      shouldPersist: options.shouldPersist ?? true,
      keepAliveMs,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to create terminal' }));
    throw new Error(error.error || 'Failed to create terminal session');
  }

  return response.json();
}

// ---- Terminal stream (WebSocket replaces EventSource) ----

export function connectTerminalStream(
  sessionId: string,
  onEvent: (event: TerminalStreamEvent) => void,
  onError?: (error: Error, fatal?: boolean) => void,
  options: ConnectStreamOptions = {}
): () => void {
  const {
    maxRetries = 5,
    initialRetryDelay = 1000,
    maxRetryDelay = 15000,
    connectionTimeout = 15000,
  } = options;

  const retryState = {
    maxRetries,
    initialDelayMs: initialRetryDelay,
    maxDelayMs: maxRetryDelay,
    connectionTimeoutMs: connectionTimeout,
    retryCount: 0,
    retryTimeout: null as ReturnType<typeof setTimeout> | null,
    connectionTimeoutId: null as ReturnType<typeof setTimeout> | null,
    isClosed: false,
  };

  let conn: WsConnection | null = null;

  const clearTimeouts = () => {
    if (retryState.retryTimeout) { clearTimeout(retryState.retryTimeout); retryState.retryTimeout = null; }
    if (retryState.connectionTimeoutId) { clearTimeout(retryState.connectionTimeoutId); retryState.connectionTimeoutId = null; }
  };

  const cleanup = () => {
    retryState.isClosed = true;
    clearTimeouts();
    if (conn) {
      wsConnections.delete(sessionId);
      try { conn.ws.close(); } catch { /* ignore */ }
      conn = null;
    }
  };

  const connect = () => {
    if (retryState.isClosed) return;

    const url = getWebSocketUrl(sessionId);
    const ws = new WebSocket(url);

    retryState.connectionTimeoutId = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        ws.close();
        handleError(new Error('WebSocket connection timeout'), false);
      }
    }, connectionTimeout);

    ws.onopen = () => {
      clearTimeouts();
      retryState.retryCount = 0;
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);

        // Handle tmux-result (correlated response for sendTmuxAction)
        if (msg.type === 'tmux-result' && msg.reqId) {
          resolveTmuxRequest(msg.reqId, msg.success !== false, msg.layout, msg.error);
          return;
        }

        // Handle tmux-layout broadcast
        if (msg.type === 'tmux-layout' && msg.layout) {
          onEvent({ type: 'tmux-layout', layout: msg.layout });
          return;
        }

        // Handle active-program broadcast
        if (msg.type === 'active-program') {
          onEvent({
            type: 'active-program',
            activeProgram: msg.activeProgram,
            activeProgramSource: msg.activeProgramSource,
          });
          return;
        }

        // Handle cwd broadcast
        if (msg.type === 'cwd') {
          onEvent({ type: 'cwd', cwd: msg.cwd });
          return;
        }

        // Standard stream events
        const event_ = msg as TerminalStreamEvent;

        if (event_.type === 'connected') {
          onEvent(event_);
          return;
        }

        if (event_.type === 'exit') {
          cleanup();
          onEvent(event_);
          return;
        }

        onEvent(event_);
      } catch (error) {
        onError?.(error as Error, false);
      }
    };

    ws.onerror = () => {
      clearTimeouts();
      handleError(new Error('WebSocket connection error'), false);
    };

    ws.onclose = () => {
      clearTimeouts();
      if (!retryState.isClosed) {
        handleError(new Error('WebSocket connection closed'), false);
      }
    };

    conn = { ws, onEvent, onError, retryState };
    wsConnections.set(sessionId, conn);
  };

  const handleError = (error: Error, isFatal: boolean) => {
    if (retryState.isClosed) return;

    if (retryState.retryCount < maxRetries && !isFatal) {
      retryState.retryCount++;
      const delay = Math.min(
        initialRetryDelay * Math.pow(2, retryState.retryCount - 1),
        maxRetryDelay,
      );

      onEvent({
        type: 'reconnecting',
        attempt: retryState.retryCount,
        maxAttempts: maxRetries,
      });

      retryState.retryTimeout = setTimeout(() => {
        if (!retryState.isClosed) connect();
      }, delay);
    } else {
      onError?.(error, isFatal);
      cleanup();
    }
  };

  connect();
  return cleanup;
}

// ---- Terminal input (WebSocket replaces HTTP POST) ----

export async function sendTerminalInput(
  sessionId: string,
  data: string
): Promise<void> {
  const conn = wsConnections.get(sessionId);
  if (conn && conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(JSON.stringify({ type: 'input', data }));
    return;
  }
  // Fallback to HTTP for backward compatibility
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch(`/api/terminal/${sessionId}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'X-XSRF-TOKEN': csrfTokenHeader },
    body: data,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to send input' }));
    throw new Error(error.error || 'Failed to send terminal input');
  }
}

// ---- Resize (WebSocket replaces HTTP POST) ----

export async function resizeTerminal(
  sessionId: string,
  cols: number,
  rows: number
): Promise<void> {
  const conn = wsConnections.get(sessionId);
  if (conn && conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    return;
  }
  // Fallback to HTTP
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch(`/api/terminal/${sessionId}/resize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': csrfTokenHeader },
    body: JSON.stringify({ cols, rows }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to resize terminal' }));
    throw new Error(error.error || 'Failed to resize terminal');
  }
}

// ---- Tmux actions (WebSocket with reqId correlation) ----

export async function sendTmuxAction(
  sessionId: string,
  payload: TmuxActionPayload
): Promise<{ success: boolean; layout?: TmuxLayout }> {
  const conn = wsConnections.get(sessionId);
  if (conn && conn.ws.readyState === WebSocket.OPEN) {
    const isFireAndForget = payload.action === 'scroll' || payload.action === 'copy-mode';
    if (isFireAndForget) {
      // Scroll and copy-mode actions don't wait for a server response.
      conn.ws.send(JSON.stringify({ type: 'tmux', ...payload }));
      return { success: true };
    }
    return new Promise((resolve, reject) => {
      const reqId = Math.random().toString(36).substring(7);
      pendingTmuxRequests.set(reqId, { resolve, reject });
      conn.ws.send(JSON.stringify({ type: 'tmux', reqId, ...payload }));
      setTimeout(() => {
        if (pendingTmuxRequests.has(reqId)) {
          pendingTmuxRequests.delete(reqId);
          reject(new Error('Tmux action timed out'));
        }
      }, 30000);
    });
  }
  // Fallback to HTTP
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch(`/api/terminal/${sessionId}/tmux`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': csrfTokenHeader },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to execute tmux action' }));
    throw new Error(error.error || 'Failed to execute tmux action');
  }
  return response.json();
}

// ---- Session management (HTTP) ----

export async function closeTerminal(sessionId: string): Promise<void> {
  // Clean up WebSocket first
  const conn = wsConnections.get(sessionId);
  if (conn) { conn.retryState.isClosed = true; try { conn.ws.close(); } catch { /* ignore */ } wsConnections.delete(sessionId); }

  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch(`/api/terminal/${sessionId}`, {
    method: 'DELETE',
    headers: { 'X-XSRF-TOKEN': csrfTokenHeader },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to close terminal' }));
    throw new Error(error.error || 'Failed to close terminal');
  }
}

export async function restartTerminalSession(
  currentSessionId: string,
  options: { cwd?: string; cols?: number; rows?: number; keepAliveMs?: number | null; mode?: 'shell' | 'tmux'; tmuxSessionName?: string }
): Promise<TerminalSession> {
  // Clean up old WebSocket
  const conn = wsConnections.get(currentSessionId);
  if (conn) { conn.retryState.isClosed = true; try { conn.ws.close(); } catch { /* ignore */ } wsConnections.delete(currentSessionId); }

  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch(`/api/terminal/${currentSessionId}/restart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': csrfTokenHeader },
    body: JSON.stringify({
      ...(options.cwd ? { cwd: options.cwd } : {}),
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      mode: options.mode,
      tmuxSessionName: options.tmuxSessionName,
      keepAliveMs: options.keepAliveMs,
    }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to restart terminal' }));
    throw new Error(error.error || 'Failed to restart terminal session');
  }
  return response.json();
}

export async function checkTerminalHealth(sessionId: string): Promise<{
  healthy: boolean; sessionId: string; cwd?: string; clients?: number; lastActivity?: number;
  backend?: string; mode?: 'shell' | 'tmux'; tmuxSessionName?: string | null;
  activeProgram?: string | null; activeProgramSource?: 'tmux-pane' | 'shell-tty' | 'shell-pid' | 'unknown' | null;
}> {
  const response = await fetch(`/api/terminal/${sessionId}/health`, { method: 'GET' });
  if (!response.ok) {
    if (response.status === 404) return { healthy: false, sessionId };
    const error = await response.json().catch(() => ({ error: 'Failed to check terminal health' }));
    throw new Error(error.error || 'Failed to check terminal health');
  }
  return response.json();
}

export interface PersistentTerminalProcess {
  sessionId: string; cwd: string; createdAt: number; lastActivity: number; backend: string;
  clients: number; mode: 'shell' | 'tmux'; tmuxSessionName: string | null;
  shouldPersist: boolean; keepAliveMs: number | null; isOrphan: boolean; hasWrittenData: boolean;
  activeProgram: string | null; activeProgramSource: 'tmux-pane' | 'shell-tty' | 'shell-pid' | 'unknown' | null;
}

export async function listTerminalProcesses(): Promise<{
  reconnect: { graceTime: number; scrollback: number; idleTimeout: number }; processes: PersistentTerminalProcess[];
}> {
  const response = await fetch('/api/terminal/processes', { method: 'GET' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to list terminal processes' }));
    throw new Error(error.error || 'Failed to list terminal processes');
  }
  return response.json();
}

export async function attachTerminalSession(sessionId: string): Promise<{
  sessionId: string; cwd: string; backend: string; clients: number; mode: 'shell' | 'tmux';
  tmuxSessionName: string | null; history: string[]; shouldPersist: boolean; keepAliveMs: number | null;
  activeProgram: string | null; activeProgramSource: 'tmux-pane' | 'shell-tty' | 'shell-pid' | 'unknown' | null;
}> {
  const response = await fetch(`/api/terminal/${sessionId}/attach`, { method: 'GET' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to attach terminal session' }));
    if (response.status === 404) throw new Error('SESSION_NOT_FOUND');
    throw new Error(error.error || 'Failed to attach terminal session');
  }
  return response.json();
}

export async function updateTerminalSessionPolicy(sessionId: string, policy: {
  keepAliveMs?: number | null; shouldPersist?: boolean;
}): Promise<{ sessionId: string; keepAliveMs: number | null; shouldPersist: boolean; clients: number }> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch(`/api/terminal/${sessionId}/policy`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': csrfTokenHeader },
    body: JSON.stringify(policy),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to update terminal session policy' }));
    throw new Error(error.error || 'Failed to update terminal session policy');
  }
  return response.json();
}

export async function detachTerminalSession(sessionId: string): Promise<void> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch(`/api/terminal/${sessionId}/detach`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': csrfTokenHeader },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to detach terminal session' }));
    throw new Error(error.error || 'Failed to detach terminal session');
  }
}

export async function forceKillTerminal(options: {
  sessionId?: string; cwd?: string;
}): Promise<void> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch('/api/terminal/force-kill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': csrfTokenHeader },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to force kill terminal' }));
    throw new Error(error.error || 'Failed to force kill terminal');
  }
}

export async function listTmuxSessions(): Promise<TmuxSessionSummary[]> {
  const response = await fetch('/api/terminal/tmux/sessions', { method: 'GET' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to list tmux sessions' }));
    throw new Error(error.error || 'Failed to list tmux sessions');
  }
  const payload = await response.json() as { sessions?: TmuxSessionSummary[] };
  return Array.isArray(payload.sessions) ? payload.sessions : [];
}

export async function getTmuxStatus(): Promise<TmuxStatus> {
  const response = await fetch('/api/terminal/tmux/status', { method: 'GET' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to get tmux status' }));
    throw new Error(error.error || 'Failed to get tmux status');
  }
  return response.json() as Promise<TmuxStatus>;
}

export interface PersistedTerminalClientSession {
  sessionId: string; name: string; backendSessionId: string | null;
  mode: 'shell' | 'tmux'; tmuxSessionName: string | null; keepAliveMs: number | null;
  createdAt: number; lastActivity: number;
}

export interface TerminalClientState {
  sessions: PersistedTerminalClientSession[];
  activeSessionId?: string | null;
  updatedAt?: number;
}

export async function getTerminalClientState(): Promise<TerminalClientState> {
  const response = await fetch('/api/terminal/client-state', { method: 'GET' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to load terminal client state' }));
    throw new Error(error.error || 'Failed to load terminal client state');
  }
  return response.json();
}

export async function replaceTerminalClientState(state: TerminalClientState): Promise<TerminalClientState> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch('/api/terminal/client-state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': csrfTokenHeader },
    body: JSON.stringify(state),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to save terminal client state' }));
    throw new Error(error.error || 'Failed to save terminal client state');
  }
  return response.json();
}

export async function clearTerminalClientState(): Promise<void> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch('/api/terminal/client-state', {
    method: 'DELETE',
    headers: { 'X-XSRF-TOKEN': csrfTokenHeader },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to clear terminal client state' }));
    throw new Error(error.error || 'Failed to clear terminal client state');
  }
}
