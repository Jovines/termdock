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
  SessionInventory,
  OpenSessionInventoryOptions,
  OpenSessionInventoryResult,
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
// visibilitychange / online 唤醒后做一次健康探测：发 ping 等若干毫秒，超时直接重连。
// 1500ms 是给蜂窝网络/弱 Wi-Fi 唤醒首包留的余量（实测 500ms 经常误判半开导致无谓 close）。
const WAKEUP_PROBE_TIMEOUT_MS = 1500;

interface WsConnection {
  ws: WebSocket;
  onEvent: (event: TerminalStreamEvent) => void;
  onError?: (error: Error, fatal?: boolean) => void;
  reconnectNow: () => void;
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
  // 重连补帧基线：connected.replayLastSeq 到来时记录服务端 replay 后的基线，
  // live data 携带 seq 时再随已处理输出单调推进；下一次重连用它作为 since 参数。
  lastSeq: number;
  // 输入端缓冲：WS 没开时把用户输入暂存，连上后批量 flush，避免短线期间丢字。
  pendingInputs: string[];
  // 仅在拥塞时启用短窗口批量 flush，快网保持逐条直发。
  inputFlushTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  pongTimer: ReturnType<typeof setTimeout> | null;
  // 上次收到任意服务端消息的时间戳，用于判断半开连接。
  lastInboundAt: number;
}

const wsConnections = new Map<string, WsConnection>();

type LinkQuality = 'good' | 'degraded' | 'congested';

const INPUT_MICROBATCH_MS_DEGRADED = 24;
const INPUT_MICROBATCH_MS_CONGESTED = 40;
const INPUT_PENDING_CONGESTED_THRESHOLD = 40;

function estimateLinkQuality(conn: WsConnection): LinkQuality {
  if (conn.retryState.retryCount >= 2 || conn.pendingInputs.length >= INPUT_PENDING_CONGESTED_THRESHOLD) {
    return 'congested';
  }
  if (conn.retryState.retryCount >= 1 || conn.pendingInputs.length >= 8) {
    return 'degraded';
  }
  return 'good';
}

function flushPendingInputs(c: WsConnection): void {
  if (c.pendingInputs.length === 0 || c.ws.readyState !== WebSocket.OPEN) return;
  const queued = c.pendingInputs.splice(0);
  for (const data of queued) {
    try { c.ws.send(JSON.stringify({ type: 'input', data })); } catch { /* ignore */ }
  }
}

function scheduleInputFlush(c: WsConnection): void {
  if (c.ws.readyState !== WebSocket.OPEN) return;
  const quality = estimateLinkQuality(c);
  if (quality === 'good') {
    flushPendingInputs(c);
    return;
  }

  if (c.inputFlushTimer) {
    return;
  }

  const delay = quality === 'congested' ? INPUT_MICROBATCH_MS_CONGESTED : INPUT_MICROBATCH_MS_DEGRADED;
  c.inputFlushTimer = setTimeout(() => {
    c.inputFlushTimer = null;
    flushPendingInputs(c);
  }, delay);
}

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
      termType: options.termType,
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
  let manualReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Sockets we intentionally superseded (wake probe / manual retry). Their
  // late onclose/onerror events must not schedule another retry against the
  // freshly created socket.
  const ignoredSockets = new WeakSet<WebSocket>();

  const clearTimeouts = () => {
    if (retryState.retryTimeout) { clearTimeout(retryState.retryTimeout); retryState.retryTimeout = null; }
    if (retryState.connectionTimeoutId) { clearTimeout(retryState.connectionTimeoutId); retryState.connectionTimeoutId = null; }
    if (manualReconnectTimer) { clearTimeout(manualReconnectTimer); manualReconnectTimer = null; }
  };

  const stopHeartbeat = (c: WsConnection) => {
    if (c.heartbeatTimer) { clearInterval(c.heartbeatTimer); c.heartbeatTimer = null; }
    if (c.pongTimer) { clearTimeout(c.pongTimer); c.pongTimer = null; }
    if (c.inputFlushTimer) { clearTimeout(c.inputFlushTimer); c.inputFlushTimer = null; }
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


  const connect = () => {
    if (retryState.isClosed) return;

    if (conn) {
      ignoredSockets.add(conn.ws);
      stopHeartbeat(conn);
      try { conn.ws.close(); } catch { /* ignore */ }
    }

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
      reconnectNow: () => {
        if (retryState.isClosed) return;
        if (manualReconnectTimer) return;
        clearTimeouts();
        if (conn) {
          ignoredSockets.add(conn.ws);
          stopHeartbeat(conn);
          try { conn.ws.close(); } catch { /* ignore */ }
        }
        onEvent({
          type: 'reconnecting',
          attempt: Math.min(retryState.retryCount + 1, maxRetries),
          maxAttempts: maxRetries,
        });
        // Wake-from-background should not wait for a stale exponential-backoff
        // timer that may have been scheduled/throttled while the PWA was hidden.
        retryState.retryCount = Math.min(retryState.retryCount + 1, maxRetries);
        handlingError = true;
        manualReconnectTimer = setTimeout(() => {
          manualReconnectTimer = null;
          handlingError = false;
          connect();
        }, 0);
      },
      retryState,
      lastSeq,
      pendingInputs,
      inputFlushTimer: null,
      heartbeatTimer: null,
      pongTimer: null,
      lastInboundAt: Date.now(),
    };

    ws.onopen = () => {
      clearTimeouts();
      retryState.retryCount = 0;
      newConn.lastInboundAt = Date.now();
      startHeartbeat(newConn);
      // WS 重新打开后优先按当前链路质量 flush 输入。
      scheduleInputFlush(newConn);
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
            activeProgramRaw: msg.activeProgramRaw,
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

        // Handle focus tracking mode updates
        if (msg.type === 'focus-mode') {
          onEvent({
            type: 'focus-mode',
            focusTrackingRequested: msg.focusTrackingRequested === true,
          });
          return;
        }

        // Handle resize ack
        if (msg.type === 'resize-ack') {
          onEvent({
            type: 'resize-ack',
            seq: typeof msg.seq === 'number' ? msg.seq : undefined,
            cols: typeof msg.cols === 'number' ? msg.cols : undefined,
            rows: typeof msg.rows === 'number' ? msg.rows : undefined,
            ok: msg.ok !== false,
            error: typeof msg.error === 'string' ? msg.error : undefined,
          });
          return;
        }

        // pty-size 广播：服务端在任意 client resize 后把真实 pty 尺寸推
        // 给所有连接的浏览器。viewport 用它同步 lastServerSize，便于多
        // 端切换时判断本地 xterm 是否跟服务端脱钩。
        if (msg.type === 'pty-size') {
          onEvent({
            type: 'pty-size',
            cols: typeof msg.cols === 'number' ? msg.cols : undefined,
            rows: typeof msg.rows === 'number' ? msg.rows : undefined,
            source: typeof msg.source === 'string' ? msg.source : undefined,
          });
          return;
        }

        // Shell-reported title (OSC 2) — shell integration sets this to
        // cwd when idle or command name when running.
        if (msg.type === 'shell-title') {
          onEvent({
            type: 'shell-title',
            title: typeof msg.title === 'string' ? msg.title : '',
          });
          return;
        }

        // Shell-reported prompt state (OSC 133) — 'idle' at prompt, 'running' when command executing.
        if (msg.type === 'prompt-state') {
          onEvent({
            type: 'prompt-state',
            state: msg.state === 'running' ? 'running' : 'idle',
            exitCode: typeof msg.exitCode === 'number' ? msg.exitCode : undefined,
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
        if (event_.type === 'data' && typeof event_.seq === 'number' && Number.isFinite(event_.seq) && event_.seq > lastSeq) {
          lastSeq = event_.seq;
          newConn.lastSeq = lastSeq;
        }
      } catch (error) {
        onError?.(error as Error, false);
      }
    };

    ws.onerror = () => {
      if (ignoredSockets.has(ws)) return;
      clearTimeouts();
      stopHeartbeat(newConn);
      if (!handlingError) {
        handlingError = true;
        handleError(new Error('WebSocket connection error'), false);
      }
    };

    ws.onclose = (ev: CloseEvent) => {
      if (ignoredSockets.has(ws)) return;
      clearTimeouts();
      stopHeartbeat(newConn);
      if (retryState.isClosed) return;
      if (handlingError) return; // already handled by onerror
      handlingError = true;

      // Server closed with 4001 = session not found — fatal, no point retrying
      if (ev.code === 4001) {
        // eslint-disable-next-line no-console
        console.warn('[Terminal] WS 4001: Session not found on server', {
          code: ev.code,
          reason: ev.reason,
          stack: new Error().stack,
        });
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
      conn.pendingInputs.push(data);
      scheduleInputFlush(conn);
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
// - 没有 conn：说明已彻底断开，连重连机器都不存在，调用方需要自行重建。
// - WS 非 OPEN（CONNECTING/CLOSING/CLOSED）：iOS PWA 后台时 OS 可能撕掉底层 TCP
//   但 JS 引擎收不到任何 onerror/onclose；这种"僵尸 socket"不能只 close() 等事件，
//   要立即替换为新连接。
// - WS OPEN：发 ping，等 WAKEUP_PROBE_TIMEOUT_MS 内有任何消息就算活着；
//   超时则主动替换连接，走重连补帧路径。
export function probeTerminalConnection(sessionId: string): boolean {
  const conn = wsConnections.get(sessionId);
  if (!conn) return false;
  if (conn.ws.readyState !== WebSocket.OPEN) {
    // 卡死的握手 / 僵尸连接：不要只依赖 close/onclose（iOS PWA 唤醒时
    // onclose 可能延迟或已在后台被吞），直接替换为一条新的连接。
    conn.reconnectNow();
    return true;
  }
  const baseline = conn.lastInboundAt;
  try { conn.ws.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
  setTimeout(() => {
    // 如果在窗口期内 lastInboundAt 没有更新，就视为半开连接，强行 close。
    if (conn.lastInboundAt <= baseline) {
      conn.reconnectNow();
    }
  }, WAKEUP_PROBE_TIMEOUT_MS);
  return true;
}

// ---- Terminal focus / flow-control state (WebSocket)

export function sendTerminalFocusState(
  sessionId: string,
  focused: boolean,
  reason?: string,
): void {
  const conn = wsConnections.get(sessionId);
  if (!conn || conn.ws.readyState !== WebSocket.OPEN) return;
  try {
    conn.ws.send(JSON.stringify({ type: 'focus', focused, reason }));
  } catch {
    // Focus state is advisory; the heartbeat/reconnect path will repair stale sockets.
  }
}

export function sendTerminalFlowControlState(
  sessionId: string,
  paused: boolean,
  reason?: string,
): void {
  const conn = wsConnections.get(sessionId);
  if (!conn || conn.ws.readyState !== WebSocket.OPEN) return;
  try {
    conn.ws.send(JSON.stringify({ type: 'flow-control', paused, reason }));
  } catch {
    // Flow-control is advisory; viewport watermarks will emit the next state change.
  }
}

// ---- Resize (WebSocket replaces HTTP POST) ----

export async function resizeTerminal(
  sessionId: string,
  cols: number,
  rows: number,
  seq?: number,
): Promise<void> {
  const conn = wsConnections.get(sessionId);
  if (conn && conn.ws.readyState === WebSocket.OPEN) {
    try {
      conn.ws.send(JSON.stringify({ type: 'resize', cols, rows, seq }));
      return;
    } catch {
      // Fall through to HTTP fallback.
    }
  }
  // Fallback to HTTP
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch(`/api/terminal/${sessionId}/resize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': csrfTokenHeader },
    body: JSON.stringify({ cols, rows, seq }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to resize terminal' }));
    throw new Error(error.error || 'Failed to resize terminal');
  }

  const payload = await response.json().catch(() => ({ success: true }));
  if (payload?.success === false || payload?.ok === false) {
    throw new Error(payload?.error || 'Failed to resize terminal');
  }
}

// ---- Tmux actions (WebSocket with reqId correlation) ----

export async function sendTmuxAction(
  sessionId: string,
  payload: TmuxActionPayload
): Promise<{ success: boolean; layout?: TmuxLayout }> {
  const conn = wsConnections.get(sessionId);
  if (conn && conn.ws.readyState === WebSocket.OPEN) {
    // 只有 scroll 走 fire-and-forget：高频、连续，没必要往返。
    // copy-mode 不能 fire-and-forget——客户端会在退出 copy-mode 后立即
    // 发送用户输入，必须等服务端真正退出 copy-mode 再发，否则 input 会
    // 在 tmux 还处于 copy-mode 时被写进 PTY，被 copy-mode keymap 吃掉。
    if (payload.action === 'scroll') {
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
  // Closing is idempotent from the UI perspective: after fast-restore or a
  // server-side cleanup race the backend session may already be gone, but the
  // local tab still needs to be removable.
  if (response.status === 404) {
    return;
  }
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
  activeProgram?: string | null; activeProgramRaw?: string | null; activeProgramSource?: 'tmux-pane' | 'tmux-tty' | 'shell-tty' | 'shell-pid' | 'unknown' | null;
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
  activeProgram: string | null; activeProgramRaw?: string | null; activeProgramSource: 'tmux-pane' | 'tmux-tty' | 'shell-tty' | 'shell-pid' | 'unknown' | null;
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
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch(`/api/terminal/tmux/sessions/${encodeURIComponent(trimmed)}`, {
    method: 'DELETE',
    headers: { 'X-XSRF-TOKEN': csrfTokenHeader },
  });
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

export async function getSessionInventory(): Promise<SessionInventory> {
  const response = await fetch('/api/terminal/session-inventory', { method: 'GET' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to load session inventory' }));
    throw new Error(error.error || 'Failed to load session inventory');
  }
  return response.json() as Promise<SessionInventory>;
}

export async function openSessionInventoryEntry(
  options: OpenSessionInventoryOptions,
): Promise<OpenSessionInventoryResult> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch('/api/terminal/session-inventory/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': csrfTokenHeader },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to open session' }));
    throw new Error(error.error || 'Failed to open session');
  }
  return response.json() as Promise<OpenSessionInventoryResult>;
}

export async function updateSessionInventoryEntry(
  frontendSessionId: string,
  patch: { name?: string; customName?: boolean; backendSessionId?: string | null; tmuxSessionName?: string | null },
): Promise<SessionInventory> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch(`/api/terminal/session-inventory/sessions/${encodeURIComponent(frontendSessionId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': csrfTokenHeader },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to update session' }));
    throw new Error(error.error || 'Failed to update session');
  }
  return response.json() as Promise<SessionInventory>;
}

export async function reorderSessionInventoryEntries(sessionIds: string[]): Promise<SessionInventory> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch('/api/terminal/session-inventory/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': csrfTokenHeader },
    body: JSON.stringify({ sessionIds }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to reorder sessions' }));
    throw new Error(error.error || 'Failed to reorder sessions');
  }
  return response.json() as Promise<SessionInventory>;
}

export async function removeSessionInventoryEntry(frontendSessionId: string): Promise<void> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch(`/api/terminal/session-inventory/sessions/${encodeURIComponent(frontendSessionId)}`, {
    method: 'DELETE',
    headers: { 'X-XSRF-TOKEN': csrfTokenHeader },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to remove session' }));
    throw new Error(error.error || 'Failed to remove session');
  }
}

export async function clearSessionInventoryEntries(): Promise<void> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch('/api/terminal/session-inventory/sessions', {
    method: 'DELETE',
    headers: { 'X-XSRF-TOKEN': csrfTokenHeader },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to clear sessions' }));
    throw new Error(error.error || 'Failed to clear sessions');
  }
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

export interface LocalAccessInterfaceAddress {
  name: string;
  address: string;
  family: 'IPv4';
  label: string;
  qrDataUrl?: string | null;
  url?: string;
}

export interface LocalAccessState {
  name: string;
  source: 'auto' | 'manual';
  hostname: string;
  fallbackHostname: string;
  url: string;
  fallbackUrl: string;
  onboardingUrl: string | null;
  status: 'active' | 'disabled' | 'needs-auth' | 'loopback-only' | 'conflict' | 'error';
  reason: string | null;
  httpsEnabled: boolean;
  caAvailable: boolean;
  lanAddresses: string[];
  interfaces: LocalAccessInterfaceAddress[];
}

export interface SettingsState {
  preventSleep: boolean;
  caffeinateActive: boolean;
  networkAvailable: boolean;
  localAccess: LocalAccessState;
}

export async function getSettings(): Promise<SettingsState> {
  const response = await fetch('/api/terminal/settings', { method: 'GET' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to load settings' }));
    throw new Error(error.error || 'Failed to load settings');
  }
  return response.json();
}

export async function updateSettings(settings: { preventSleep?: boolean; localAccess?: { name?: string; reset?: boolean } }): Promise<SettingsState> {
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
  const csrfTokenHeader = await getCsrfToken();
  await fetch('/api/auth/logout', {
    method: 'POST',
    headers: { 'X-XSRF-TOKEN': csrfTokenHeader },
  });
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
  // 新格式：一个规则配置可匹配多个程序
  programs?: string[];
  // 兼容旧格式：单程序字段
  program?: string;
  rules: AgentRule[];
}

export interface ProgramLabelRule {
  id: string;
  enabled?: boolean;
  priority?: number;
  matchType: 'exact' | 'includes' | 'prefix' | 'regex';
  pattern: string;
  output: string;
  source?: Array<'tmux-pane' | 'tmux-tty' | 'shell-tty' | 'shell-pid' | 'unknown'>;
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

export async function getProgramRules(): Promise<ProgramLabelRule[]> {
  const response = await fetch('/api/terminal/program-rules');
  if (!response.ok) throw new Error('Failed to get program rules');
  return response.json();
}

export async function replaceProgramRules(rules: ProgramLabelRule[]): Promise<ProgramLabelRule[]> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch('/api/terminal/program-rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': csrfTokenHeader },
    body: JSON.stringify(rules),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to update program rules' }));
    throw new Error(error.error || 'Failed to update program rules');
  }
  return response.json();
}

export async function resetProgramRules(): Promise<ProgramLabelRule[]> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch('/api/terminal/program-rules', {
    method: 'DELETE',
    headers: { 'X-XSRF-TOKEN': csrfTokenHeader },
  });
  if (!response.ok) throw new Error('Failed to reset program rules');
  return response.json();
}

// ---- Program Detection Config API ----

export interface ProgramDetectionConfig {
  genericProgramNames: string[];
  wrapperScriptNames: string[];
  shellNames: string[];
}

export async function getProgramDetection(): Promise<ProgramDetectionConfig> {
  const response = await fetch('/api/terminal/program-detection');
  if (!response.ok) throw new Error('Failed to get program detection config');
  return response.json();
}

export async function replaceProgramDetection(config: ProgramDetectionConfig): Promise<ProgramDetectionConfig> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch('/api/terminal/program-detection', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': csrfTokenHeader },
    body: JSON.stringify(config),
  });
  if (!response.ok) throw new Error('Failed to save program detection config');
  return response.json();
}

export async function resetProgramDetection(): Promise<ProgramDetectionConfig> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch('/api/terminal/program-detection', {
    method: 'DELETE',
    headers: { 'X-XSRF-TOKEN': csrfTokenHeader },
  });
  if (!response.ok) throw new Error('Failed to reset program detection config');
  return response.json();
}

// ---- Filesystem API ----

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

export function getImageMimeTypeForPath(filePath: string): string | null {
  const dotIndex = filePath.lastIndexOf('.');
  if (dotIndex < 0) return null;
  return IMAGE_MIME_BY_EXT[filePath.slice(dotIndex).toLowerCase()] ?? null;
}

export function isPreviewableImagePath(filePath: string): boolean {
  return getImageMimeTypeForPath(filePath) !== null;
}

export interface ImagePreviewBlob {
  blob: Blob;
  path: string;
  size: number | null;
  modified: string | null;
  mimeType: string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
  size?: number;
  modified?: string;
}

export interface FileSearchResponse {
  path: string;
  query: string;
  entries: FileEntry[];
  truncated: boolean;
  total: number;
  engine: 'rg' | 'fallback';
  limited?: boolean;
}

export type FileSearchEngine = 'rg' | 'fallback';

export type FileSearchMode = 'name' | 'content';

export interface FileContentMatchLine {
  line: number;
  text: string;
}

export interface FileContentSearchEntry {
  name: string;
  path: string;
  matches: FileContentMatchLine[];
}

export interface FileSearchProgress {
  path?: string;
  query?: string;
  engine?: FileSearchEngine;
  mode?: FileSearchMode;
  entries?: FileEntry[];
  contentEntries?: FileContentSearchEntry[];
  total?: number;
  truncated?: boolean;
  limited?: boolean;
  done?: boolean;
  error?: string;
}

export interface FileWatchEvent {
  type: 'created' | 'deleted' | 'updated' | 'rescan-required';
  path: string;
  entry?: FileEntry;
  reason?: string;
}

export async function listDirectory(dirPath: string, signal?: AbortSignal, showHidden?: boolean): Promise<{ path: string; entries: FileEntry[]; truncated?: boolean; total?: number }> {
  const params = new URLSearchParams({ path: dirPath });
  if (showHidden) params.set('showHidden', 'true');
  const response = await fetch(`/api/terminal/fs/list?${params}`, { signal });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to list directory' }));
    throw new Error(error.error || 'Failed to list directory');
  }
  return response.json();
}

export async function searchFiles(dirPath: string, query: string, signal?: AbortSignal): Promise<FileSearchResponse> {
  const params = new URLSearchParams({ path: dirPath, query });
  const response = await fetch(`/api/terminal/fs/search?${params}`, { signal });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to search files' }));
    throw new Error(error.error || 'Failed to search files');
  }
  return response.json();
}

export async function searchFilesStream(
  dirPath: string,
  query: string,
  onProgress: (progress: FileSearchProgress) => void,
  signal?: AbortSignal,
  showHidden?: boolean,
  mode: FileSearchMode = 'name',
): Promise<void> {
  const params = new URLSearchParams({ path: dirPath, query, stream: 'true' });
  if (showHidden) params.set('showHidden', 'true');
  if (mode === 'content') params.set('mode', 'content');
  const response = await fetch(`/api/terminal/fs/search?${params}`, { signal });
  if (!response.ok || !response.body) {
    const error = await response.json().catch(() => ({ error: 'Failed to search files' }));
    throw new Error(error.error || 'Failed to search files');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as FileSearchProgress & { type?: string; message?: string };
    if (event.type === 'meta') {
      onProgress({ path: event.path, query: event.query, engine: event.engine, mode: event.mode, limited: event.limited });
    } else if (event.type === 'batch') {
      onProgress({ entries: event.entries ?? [] });
    } else if (event.type === 'content-batch') {
      onProgress({ contentEntries: event.contentEntries ?? [] });
    } else if (event.type === 'error') {
      throw new Error(event.message || 'Search failed');
    } else if (event.type === 'done') {
      onProgress({ total: event.total, truncated: event.truncated, limited: event.limited, engine: event.engine, mode: event.mode, done: true });
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      consumeLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  consumeLine(buffer);
}

export async function watchFileSystem(
  roots: string[],
  onEvents: (events: FileWatchEvent[]) => void,
  signal?: AbortSignal,
): Promise<void> {
  const params = new URLSearchParams();
  params.set('roots', roots.join('|'));
  const response = await fetch(`/api/terminal/fs/watch?${params}`, { signal });
  if (!response.ok || !response.body) {
    const error = await response.json().catch(() => ({ error: 'Failed to watch files' }));
    throw new Error(error.error || 'Failed to watch files');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as { type?: string; events?: FileWatchEvent[] };
    if (event.type === 'events' && event.events?.length) onEvents(event.events);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      consumeLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  consumeLine(buffer);
}

export async function readFileContent(filePath: string, signal?: AbortSignal): Promise<{
  path: string; content: string; size: number; modified: string; truncated?: boolean;
}> {
  const response = await fetch(`/api/terminal/fs/read?path=${encodeURIComponent(filePath)}`, { signal });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to read file' }));
    throw new Error(error.error || 'Failed to read file');
  }
  return response.json();
}

export async function readImagePreviewBlob(filePath: string, signal?: AbortSignal): Promise<ImagePreviewBlob> {
  const response = await fetch(`/api/terminal/fs/blob?path=${encodeURIComponent(filePath)}`, { signal });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to load image preview' }));
    throw new Error(error.error || 'Failed to load image preview');
  }

  const blob = await response.blob();
  const sizeHeader = response.headers.get('Content-Length');
  return {
    blob,
    path: filePath,
    size: sizeHeader ? Number(sizeHeader) : null,
    modified: response.headers.get('Last-Modified'),
    mimeType: response.headers.get('Content-Type') || blob.type || getImageMimeTypeForPath(filePath) || 'application/octet-stream',
  };
}

export interface FileDiffSkippedFile {
  path: string;
  reason: string;
  size?: number;
  maxBytes?: number;
}

export interface FileDiffResponse {
  path: string | null;
  diff: string;
  error?: string;
  truncated?: boolean;
  tooLarge?: boolean;
  size?: number;
  maxBytes?: number;
  skippedFiles?: FileDiffSkippedFile[];
}

export async function getFileDiff(filePath?: string, cached?: boolean, cwd?: string, signal?: AbortSignal): Promise<FileDiffResponse> {
  const params = new URLSearchParams();
  if (filePath) params.set('path', filePath);
  if (cached) params.set('cached', 'true');
  if (cwd) params.set('cwd', cwd);
  const response = await fetch(`/api/terminal/fs/diff?${params}`, { signal });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to get diff' }));
    throw new Error(error.error || 'Failed to get diff');
  }
  return response.json();
}

export async function getDiffFileList(cwd?: string): Promise<{
  files: GitChangedFile[];
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

export type GitChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted' | 'unknown';

export interface GitChangedFile {
  path: string;
  absolutePath: string;
  status: GitChangeStatus;
  oldPath?: string;
  indexStatus?: string;
  worktreeStatus?: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  tracked: boolean;
  canStage: boolean;
  canUnstage: boolean;
  canStash: boolean;
  canRestoreWorktree: boolean;
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
  remotes?: string[];
  branches?: string[];
  upstream?: string | null;
  upstreamRemote?: string | null;
  upstreamBranch?: string | null;
  ahead?: number | null;
  behind?: number | null;
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
export interface GitBundleResponse {
  available: boolean;
  files: GitChangedFile[];
  context: GitContext | null;
  error?: string;
}

export type GitActionRequest =
  | { action: 'stage-file'; cwd: string; paths: [string] }
  | { action: 'stage-all'; cwd: string }
  | { action: 'unstage-file'; cwd: string; paths: [string] }
  | { action: 'stash-file'; cwd: string; paths: [string]; message?: string }
  | { action: 'stash-all'; cwd: string; message?: string }
  | { action: 'commit'; cwd: string; message: string }
  | { action: 'switch-branch'; cwd: string; branch: string }
  | { action: 'push'; cwd: string; remote?: string; branch?: string }
  | { action: 'pull'; cwd: string; remote?: string; branch?: string }
  | { action: 'restore-worktree-file'; cwd: string; paths: [string]; confirm: { acknowledged: true; phrase: string } };

export interface GitActionResponse {
  ok: true;
  action: GitActionRequest['action'];
  message: string;
  output?: string;
  bundle: GitBundleResponse;
}

export async function getGitBundle(cwd?: string, signal?: AbortSignal): Promise<GitBundleResponse> {
  const params = new URLSearchParams();
  if (cwd) params.set('cwd', cwd);
  const qs = params.toString();
  const response = await fetch(`/api/terminal/fs/git-bundle${qs ? `?${qs}` : ''}`, { signal });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to get git bundle' }));
    throw new Error(error.error || 'Failed to get git bundle');
  }
  return response.json();
}

export async function runGitAction(request: GitActionRequest): Promise<GitActionResponse> {
  const csrfTokenHeader = await getCsrfToken();
  const response = await fetch('/api/terminal/fs/git-action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': csrfTokenHeader },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Git action failed' }));
    const message = error.confirmationPhrase
      ? `${error.error || 'Git action failed'} (${error.confirmationPhrase})`
      : error.error || 'Git action failed';
    throw new Error(message);
  }
  return response.json();
}
