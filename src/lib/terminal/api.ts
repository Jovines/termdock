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

// ---- Global 401 interceptor ----
//
// We wrap window.fetch once on module load so every request to our backend
// participates in auth handling. On a 401 we clear the cached CSRF token and
// emit an `auth:unauthorized` window event; App.tsx listens for this and
// re-renders the LoginScreen.
//
// This must happen before any other module-level code below issues a fetch.
export const AUTH_UNAUTHORIZED_EVENT = 'auth:unauthorized';

// ---- CSRF token (still needed for HTTP endpoints) ----

let csrfToken: string | null = null;

if (typeof window !== 'undefined' && !(window as any).__termdockFetchPatched) {
  (window as any).__termdockFetchPatched = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await originalFetch(...args);
    if (response.status === 401) {
      // Drop CSRF cache so the next login re-fetches a fresh token.
      csrfToken = null;
      try {
        window.dispatchEvent(new CustomEvent(AUTH_UNAUTHORIZED_EVENT));
      } catch {
        // ignore — environments without CustomEvent support are not relevant here
      }
    }
    return response;
  };
}

async function getCsrfToken(): Promise<string> {
  if (csrfToken) return csrfToken;
  const response = await fetch('/api/csrf-token');
  if (!response.ok) throw new Error('Failed to get CSRF token');
  const data = await response.json();
  csrfToken = data.csrfToken;
  return csrfToken as string;
}

// Exported so the auth flow can force a fresh token after login.
export function resetCsrfTokenCache(): void {
  csrfToken = null;
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
  // Guard against onerror + onclose double-fire: only the first one
  // should trigger handleError for a given disconnection.
  let handlingError = false;

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
    handlingError = false; // reset for new connection attempt

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

        // Handle agent-status broadcast
        if (msg.type === 'agent-status') {
          onEvent({ type: 'agent-status', agentStatus: msg.agentStatus ?? null });
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
      if (!handlingError) {
        handlingError = true;
        handleError(new Error('WebSocket connection error'), false);
      }
    };

    ws.onclose = (ev: CloseEvent) => {
      clearTimeouts();
      if (retryState.isClosed) return;
      if (handlingError) return; // already handled by onerror
      handlingError = true;

      // Server closed with 4001 = session not found — fatal, no point retrying
      if (ev.code === 4001) {
        handleError(new Error('Session not found on server'), true);
        return;
      }

      // Server closed with 4003 / 4401 = auth failure — trigger re-login
      if (ev.code === 4003 || ev.code === 4401) {
        try {
          window.dispatchEvent(new CustomEvent(AUTH_UNAUTHORIZED_EVENT));
        } catch { /* ignore */ }
        handleError(new Error('Authentication required'), true);
        return;
      }

      handleError(new Error('WebSocket connection closed'), false);
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
      // Retries exhausted → treat as fatal so UI shows Retry button
      onError?.(error, isFatal || retryState.retryCount >= maxRetries);
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
  options: { cwd?: string; cols?: number; rows?: number; mode?: 'shell' | 'tmux'; tmuxSessionName?: string }
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

export async function attachTerminalSession(sessionId: string): Promise<{
  sessionId: string; cwd: string; backend: string; clients: number; mode: 'shell' | 'tmux';
  tmuxSessionName: string | null; history: string[];
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

export async function killTmuxSession(name: string): Promise<{ cleanedSessions: string[]; alreadyGone?: boolean }> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('tmux session name is required');
  }
  const response = await fetch(`/api/terminal/tmux/sessions/${encodeURIComponent(trimmed)}`, { method: 'DELETE' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to kill tmux session' }));
    throw new Error(error.error || 'Failed to kill tmux session');
  }
  const payload = await response.json() as { cleanedSessions?: string[]; alreadyGone?: boolean };
  return {
    cleanedSessions: Array.isArray(payload.cleanedSessions) ? payload.cleanedSessions : [],
    alreadyGone: Boolean(payload.alreadyGone),
  };
}

export interface PersistedTerminalClientSession {
  sessionId: string; name: string; customName?: boolean; backendSessionId: string | null;
  mode: 'shell' | 'tmux'; tmuxSessionName: string | null;
  createdAt: number; lastActivity: number;
}

export interface TerminalClientState {
  sessions: PersistedTerminalClientSession[];
  activeSessionId?: string | null; // Deprecated: no longer returned by server, kept for backward compat
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

export interface ToolbarPresetsDoc {
  version: number;
  presets: unknown[];
  updatedAt?: number;
}

export async function getToolbarPresetsDoc(): Promise<ToolbarPresetsDoc> {
  const response = await fetch('/api/terminal/toolbar-presets', { method: 'GET' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to load toolbar presets' }));
    throw new Error(error.error || 'Failed to load toolbar presets');
  }
  return response.json();
}

export async function replaceToolbarPresetsDoc(doc: ToolbarPresetsDoc): Promise<ToolbarPresetsDoc> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch('/api/terminal/toolbar-presets', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': csrfTokenHeader },
    body: JSON.stringify(doc),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to save toolbar presets' }));
    throw new Error(error.error || 'Failed to save toolbar presets');
  }
  return response.json();
}

// ---- Settings (prevent sleep) ----

export interface SettingsState {
  preventSleep: boolean;
  caffeinateActive: boolean;
  networkAvailable: boolean;
}

export async function getSettings(): Promise<SettingsState> {
  const response = await fetch('/api/terminal/settings', { method: 'GET' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to load settings' }));
    throw new Error(error.error || 'Failed to load settings');
  }
  return response.json();
}

export async function updateSettings(settings: { preventSleep: boolean }): Promise<SettingsState> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch('/api/terminal/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': csrfTokenHeader },
    body: JSON.stringify(settings),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to update settings' }));
    throw new Error(error.error || 'Failed to update settings');
  }
  return response.json();
}

// ---- Auth ----

export interface AuthStatus {
  enabled: boolean;
  authenticated: boolean;
}

export async function getAuthStatus(): Promise<AuthStatus> {
  // /api/auth/status is public — it must not 401, but we go through the
  // patched fetch anyway to keep behaviour uniform.
  const response = await fetch('/api/auth/status');
  if (!response.ok) {
    throw new Error('Failed to query auth status');
  }
  return response.json();
}

export interface LoginResult {
  ok: boolean;
  error?: string;
  retryAfterMs?: number;
  rateLimited?: boolean;
}

export async function loginWithPassword(password: string): Promise<LoginResult> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (response.ok) {
    // Force a fresh CSRF token tied to the new session.
    resetCsrfTokenCache();
    return { ok: true };
  }
  const data = await response.json().catch(() => null);
  if (response.status === 429) {
    return {
      ok: false,
      rateLimited: true,
      retryAfterMs: typeof data?.retryAfterMs === 'number' ? data.retryAfterMs : undefined,
      error: data?.error || 'Too many failed attempts. Please wait and try again.',
    };
  }
  return { ok: false, error: data?.error || 'Login failed' };
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' });
  resetCsrfTokenCache();
}

// ---- Agent detection rules API ----

export interface AgentRule {
  pattern: string;
  status: string;
}

export interface AgentProgramConfig {
  program: string;
  rules: AgentRule[];
}

export async function getAgentRules(): Promise<AgentProgramConfig[]> {
  const response = await fetch('/api/terminal/agent-rules');
  if (!response.ok) throw new Error('Failed to get agent rules');
  return response.json();
}

export async function replaceAgentRules(rules: AgentProgramConfig[]): Promise<AgentProgramConfig[]> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch('/api/terminal/agent-rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': csrfTokenHeader },
    body: JSON.stringify(rules),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to update agent rules' }));
    throw new Error(error.error || 'Failed to update agent rules');
  }
  return response.json();
}

export async function resetAgentRules(): Promise<AgentProgramConfig[]> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch('/api/terminal/agent-rules', {
    method: 'DELETE',
    headers: { 'X-XSRF-TOKEN': csrfTokenHeader },
  });
  if (!response.ok) throw new Error('Failed to reset agent rules');
  return response.json();
}

// ---- Filesystem API ----

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
  size?: number;
  modified?: string;
}

export async function listDirectory(dirPath: string): Promise<{ path: string; entries: FileEntry[] }> {
  const response = await fetch(`/api/terminal/fs/list?path=${encodeURIComponent(dirPath)}`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to list directory' }));
    throw new Error(error.error || 'Failed to list directory');
  }
  return response.json();
}

export async function readFileContent(filePath: string): Promise<{
  path: string; content: string; size: number; modified: string; truncated?: boolean;
}> {
  const response = await fetch(`/api/terminal/fs/read?path=${encodeURIComponent(filePath)}`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to read file' }));
    throw new Error(error.error || 'Failed to read file');
  }
  return response.json();
}

export async function getFileDiff(filePath?: string, cached?: boolean): Promise<{
  path: string | null; diff: string; error?: string;
}> {
  const params = new URLSearchParams();
  if (filePath) params.set('path', filePath);
  if (cached) params.set('cached', 'true');
  const response = await fetch(`/api/terminal/fs/diff?${params}`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to get diff' }));
    throw new Error(error.error || 'Failed to get diff');
  }
  return response.json();
}

export async function getDiffFileList(): Promise<{
  files: Array<{ path: string; status: string; oldPath?: string }>;
  error?: string;
}> {
  const response = await fetch('/api/terminal/fs/diff-files');
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to get diff file list' }));
    throw new Error(error.error || 'Failed to get diff file list');
  }
  return response.json();
}
