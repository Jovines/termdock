import type {
  TerminalSession,
  TerminalStreamEvent,
  CreateTerminalOptions,
  ConnectStreamOptions,
  AgentIndicator,
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

// 心跳间隔：定时给后端发 ping，让后端知道连接还活着；
// 同时如果在 PONG_TIMEOUT_MS 内未收到任何消息（含 pong/data/事件），就主动断开重连。
// iOS PWA 后台返回时这个机制比 TCP keepalive 更快发现"半开连接"。
const HEARTBEAT_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 8_000;
// visibilitychange / online 唤醒后做一次健康探测：发 ping 等 500ms，超时直接重连。
const WAKEUP_PROBE_TIMEOUT_MS = 500;

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
  // 重连补帧基线：每次收到 data 时不递增（服务端补帧靠 replayLastSeq 同步），
  // 仅在 connected.replayLastSeq 到来时刷新；下一次重连用它作为 since 参数。
  lastSeq: number;
  // 输入端缓冲：WS 没开时把用户输入暂存，连上后批量 flush，避免短线期间丢字。
  pendingInputs: string[];
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  pongTimer: ReturnType<typeof setTimeout> | null;
  // 上次收到任意服务端消息的时间戳，用于判断半开连接。
  lastInboundAt: number;
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

function getWebSocketUrl(sessionId: string, sinceSeq: number): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const base = `${proto}://${window.location.host}/api/terminal/${sessionId}/ws`;
  // sinceSeq > 0 时让服务端只补发增量（短线重连补帧）；首次连接为 0，服务端不会重复发送。
  return sinceSeq > 0 ? `${base}?since=${sinceSeq}` : base;
}

// 给定一个已知的初始 seq（来自 attach 接口），让 connectTerminalStream 后续重连
// 自动带上正确的 since。如果尚未建立连接，则记录在外层 map 等待 connect() 时使用。
const pendingInitialSeq = new Map<string, number>();
export function setTerminalInitialSeq(sessionId: string, seq: number): void {
  if (seq > 0) {
    pendingInitialSeq.set(sessionId, seq);
  }
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
      cwd: options.cwd,
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
    // 调长重连窗口：覆盖电梯/地铁/锁屏 1-2 分钟的常见弱网场景。
    // 10 次指数退避 + 20s 上限 ≈ 总等待 3 分钟。
    maxRetries = 10,
    initialRetryDelay = 1000,
    maxRetryDelay = 20000,
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
  // 初始 seq 来自 /attach（如果有），后续每次重连用 conn.lastSeq。
  let lastSeq = pendingInitialSeq.get(sessionId) ?? 0;
  pendingInitialSeq.delete(sessionId);
  // WS 没建立时积累的输入缓冲；每次创建新 conn 时挂到上面。
  const pendingInputs: string[] = [];
  // Guard against onerror + onclose double-fire: only the first one
  // should trigger handleError for a given disconnection.
  let handlingError = false;

  const clearTimeouts = () => {
    if (retryState.retryTimeout) { clearTimeout(retryState.retryTimeout); retryState.retryTimeout = null; }
    if (retryState.connectionTimeoutId) { clearTimeout(retryState.connectionTimeoutId); retryState.connectionTimeoutId = null; }
  };

  const stopHeartbeat = (c: WsConnection) => {
    if (c.heartbeatTimer) { clearInterval(c.heartbeatTimer); c.heartbeatTimer = null; }
    if (c.pongTimer) { clearTimeout(c.pongTimer); c.pongTimer = null; }
  };

  const startHeartbeat = (c: WsConnection) => {
    stopHeartbeat(c);
    c.heartbeatTimer = setInterval(() => {
      if (c.ws.readyState !== WebSocket.OPEN) return;
      try { c.ws.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
      // 启动一次 pong 超时检测：在 PONG_TIMEOUT_MS 内未收到任何消息则视为半开连接。
      if (c.pongTimer) clearTimeout(c.pongTimer);
      c.pongTimer = setTimeout(() => {
        const sinceLast = Date.now() - c.lastInboundAt;
        if (sinceLast >= PONG_TIMEOUT_MS) {
          // 主动关掉，让 onclose 走重连路径。
          try { c.ws.close(); } catch { /* ignore */ }
        }
      }, PONG_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  };

  const cleanup = () => {
    retryState.isClosed = true;
    clearTimeouts();
    if (conn) {
      stopHeartbeat(conn);
      wsConnections.delete(sessionId);
      try { conn.ws.close(); } catch { /* ignore */ }
      conn = null;
    }
  };

  const flushPendingInputs = (c: WsConnection) => {
    if (c.pendingInputs.length === 0) return;
    const queued = c.pendingInputs.splice(0);
    for (const data of queued) {
      try { c.ws.send(JSON.stringify({ type: 'input', data })); } catch { /* ignore */ }
    }
  };

  const connect = () => {
    if (retryState.isClosed) return;

    const url = getWebSocketUrl(sessionId, lastSeq);
    const ws = new WebSocket(url);
    handlingError = false; // reset for new connection attempt

    retryState.connectionTimeoutId = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        ws.close();
        handleError(new Error('WebSocket connection timeout'), false);
      }
    }, connectionTimeout);

    const newConn: WsConnection = {
      ws,
      onEvent,
      onError,
      retryState,
      lastSeq,
      pendingInputs,
      heartbeatTimer: null,
      pongTimer: null,
      lastInboundAt: Date.now(),
    };

    ws.onopen = () => {
      clearTimeouts();
      retryState.retryCount = 0;
      newConn.lastInboundAt = Date.now();
      startHeartbeat(newConn);
      // WS 重新打开后立刻把断线期间的输入 flush 到后端。
      flushPendingInputs(newConn);
    };

    ws.onmessage = (event) => {
      newConn.lastInboundAt = Date.now();
      try {
        const msg = JSON.parse(event.data as string);

        // 服务端 pong 不需要透传给上层。
        if (msg.type === 'pong') {
          if (newConn.pongTimer) { clearTimeout(newConn.pongTimer); newConn.pongTimer = null; }
          return;
        }

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
          onEvent({
            type: 'agent-status',
            agentStatus: msg.agentStatus ?? null,
            agentColor: msg.agentColor ?? null,
            agentIndicator: msg.agentIndicator ?? null,
          });
          return;
        }

        // Standard stream events
        const event_ = msg as TerminalStreamEvent;

        if (event_.type === 'connected') {
          // 收到服务端基线，下一次重连就用这个 seq 做 since。
          if (typeof event_.replayLastSeq === 'number' && event_.replayLastSeq > 0) {
            lastSeq = event_.replayLastSeq;
            newConn.lastSeq = lastSeq;
          }
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
      stopHeartbeat(newConn);
      if (!handlingError) {
        handlingError = true;
        handleError(new Error('WebSocket connection error'), false);
      }
    };

    ws.onclose = (ev: CloseEvent) => {
      clearTimeouts();
      stopHeartbeat(newConn);
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

    conn = newConn;
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
//
// 短线重连期间不再 fallback 到 HTTP（HTTP 大概率也失败），而是把 input 暂存到
// 当前 conn.pendingInputs；WS 重新连上后 onopen 里会自动 flush。
// 这样 iOS PWA 后台返回的瞬间用户敲的命令不会丢。
export async function sendTerminalInput(
  sessionId: string,
  data: string
): Promise<void> {
  const conn = wsConnections.get(sessionId);
  if (conn) {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify({ type: 'input', data }));
      return;
    }
    if (conn.ws.readyState === WebSocket.CONNECTING) {
      // 正在握手，先排队等 onopen 一起 flush。
      conn.pendingInputs.push(data);
      return;
    }
  }
  // 完全没有 conn（极少数边缘情况：cleanup 后又触发 input），fallback HTTP。
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

// 主动探测：visibilitychange/online/pageshow 唤醒后调用，确认 WS 是否还活着。
// - 没有 conn 或 WS 不在 OPEN 态：直接当成已断，调用方应触发重连。
// - WS OPEN：发一个 ping，等 WAKEUP_PROBE_TIMEOUT_MS 内有任何消息就算活着；
//   超时则主动 close 触发 onclose 走重连补帧路径。
export function probeTerminalConnection(sessionId: string): void {
  const conn = wsConnections.get(sessionId);
  if (!conn) return;
  if (conn.ws.readyState !== WebSocket.OPEN) {
    // 不是 OPEN 就由现有重连机制处理，不在这里干预。
    return;
  }
  const baseline = conn.lastInboundAt;
  try { conn.ws.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
  setTimeout(() => {
    // 如果在窗口期内 lastInboundAt 没有更新，就视为半开连接，强行 close。
    if (conn.lastInboundAt <= baseline) {
      try { conn.ws.close(); } catch { /* ignore */ }
    }
  }, WAKEUP_PROBE_TIMEOUT_MS);
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
  color?: string;
  indicator?: AgentIndicator;
  clearDelayMs?: number;
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

export async function listDirectory(dirPath: string): Promise<{ path: string; entries: FileEntry[]; truncated?: boolean; total?: number }> {
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

export async function getFileDiff(filePath?: string, cached?: boolean, cwd?: string): Promise<{
  path: string | null; diff: string; error?: string;
}> {
  const params = new URLSearchParams();
  if (filePath) params.set('path', filePath);
  if (cached) params.set('cached', 'true');
  if (cwd) params.set('cwd', cwd);
  const response = await fetch(`/api/terminal/fs/diff?${params}`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to get diff' }));
    throw new Error(error.error || 'Failed to get diff');
  }
  return response.json();
}

export async function getDiffFileList(cwd?: string): Promise<{
  files: Array<{ path: string; absolutePath: string; status: string; oldPath?: string }>;
  error?: string;
}> {
  const params = new URLSearchParams();
  if (cwd) params.set('cwd', cwd);
  const qs = params.toString();
  const response = await fetch(`/api/terminal/fs/diff-files${qs ? `?${qs}` : ''}`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to get diff file list' }));
    throw new Error(error.error || 'Failed to get diff file list');
  }
  return response.json();
}

export interface GitContextFile {
  path: string;
  absolutePath: string;
  status: string;
}

export interface GitContext {
  available: boolean;
  cwd?: string;
  root?: string;
  branch?: string | null;
  status?: string;
  recentCommits?: string[];
  changedFiles?: GitContextFile[];
  truncated?: boolean;
  error?: string;
}

export async function getGitContext(cwd?: string): Promise<GitContext> {
  const params = new URLSearchParams();
  if (cwd) params.set('cwd', cwd);
  const qs = params.toString();
  const response = await fetch(`/api/terminal/fs/git-context${qs ? `?${qs}` : ''}`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to get git context' }));
    throw new Error(error.error || 'Failed to get git context');
  }
  return response.json();
}

// Combined payload for sidebar open — saves a round-trip and a git rev-parse.
export async function getGitBundle(cwd?: string): Promise<{
  available: boolean;
  files: Array<{ path: string; absolutePath: string; status: string; oldPath?: string }>;
  context: GitContext | null;
  error?: string;
}> {
  const params = new URLSearchParams();
  if (cwd) params.set('cwd', cwd);
  const qs = params.toString();
  const response = await fetch(`/api/terminal/fs/git-bundle${qs ? `?${qs}` : ''}`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to get git bundle' }));
    throw new Error(error.error || 'Failed to get git bundle');
  }
  return response.json();
}
