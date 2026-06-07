// Single source of truth for the persisted client-state list on the client.
//
// The server owns `globalSessionState` (the canonical tab list). This module
// opens a long-lived control WebSocket and fans server-pushed snapshots out
// to subscribers, replacing the previous 5-second HTTP poll. The WebSocket
// auto-reconnects with exponential backoff; while disconnected the existing
// localStorage cache + cold-start GET hydrate the UI, so a transient
// network blip doesn't blank the tab bar.
//
// Pattern: a single module-level singleton. Multiple components can call
// `subscribe()`; all receive the same snapshot. The connection is opened
// lazily on first subscribe so SSR / non-browser contexts are safe.

import type { PersistedTerminalClientSession, SessionInventory } from '../terminal';

export interface ClientStateSnapshot {
  sessions: PersistedTerminalClientSession[];
  updatedAt: number;
}

export interface ControlSnapshot {
  clientState: ClientStateSnapshot;
  inventory?: SessionInventory;
  seq?: number;
}

type Listener = (state: ControlSnapshot) => void;

interface SyncState {
  ws: WebSocket | null;
  listeners: Set<Listener>;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  // 0 listeners → "idle" mode: we keep the WS alive briefly (e.g. to ride
  // out React strict-mode's mount→unmount→mount cycle), then close it.
  idleCloseTimer: ReturnType<typeof setTimeout> | null;
  closing: boolean;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 20_000;
// Heartbeat pings from the server arrive every 30s; if we don't hear
// anything for 90s, the socket is half-open — kick a reconnect.
const STALE_PING_THRESHOLD_MS = 90_000;
// How long to keep the WS open after the last subscriber unsubscribes.
// Long enough to swallow HMR / React strict-mode double-invoke, short
// enough that we don't hold an idle connection forever.
const IDLE_CLOSE_DELAY_MS = 5_000;

const sync: SyncState = {
  ws: null,
  listeners: new Set(),
  reconnectAttempt: 0,
  reconnectTimer: null,
  idleCloseTimer: null,
  closing: false,
};

let lastServerPingAt = 0;
let staleCheckTimer: ReturnType<typeof setInterval> | null = null;

function getControlWsUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/api/control/ws`;
}

function clearIdleClose(): void {
  if (sync.idleCloseTimer) {
    clearTimeout(sync.idleCloseTimer);
    sync.idleCloseTimer = null;
  }
}

function scheduleIdleClose(): void {
  clearIdleClose();
  if (sync.ws && sync.ws.readyState === WebSocket.OPEN) {
    // Already open — keep it; another subscriber is likely on the way.
    return;
  }
  sync.idleCloseTimer = setTimeout(() => {
    sync.idleCloseTimer = null;
    if (sync.listeners.size === 0) {
      teardownConnection();
    }
  }, IDLE_CLOSE_DELAY_MS);
}

function teardownConnection(): void {
  if (sync.ws) {
    try { sync.ws.close(); } catch { /* ignore */ }
    sync.ws = null;
  }
  if (staleCheckTimer) {
    clearInterval(staleCheckTimer);
    staleCheckTimer = null;
  }
}

function scheduleReconnect(): void {
  if (sync.closing) return;
  if (sync.reconnectTimer) return;
  const delay = Math.min(
    RECONNECT_BASE_MS * Math.pow(2, sync.reconnectAttempt),
    RECONNECT_MAX_MS,
  );
  sync.reconnectAttempt += 1;
  sync.reconnectTimer = setTimeout(() => {
    sync.reconnectTimer = null;
    connect();
  }, delay);
}

function connect(): void {
  if (sync.closing) return;
  const url = getControlWsUrl();
  if (!url) return;
  if (sync.ws && sync.ws.readyState === WebSocket.OPEN) return;

  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }
  sync.ws = ws;

  ws.onopen = () => {
    sync.reconnectAttempt = 0;
    lastServerPingAt = Date.now();
    if (!staleCheckTimer) {
      staleCheckTimer = setInterval(() => {
        if (!sync.ws || sync.ws.readyState !== WebSocket.OPEN) return;
        if (lastServerPingAt > 0 && Date.now() - lastServerPingAt > STALE_PING_THRESHOLD_MS) {
          // Server hasn't sent anything (including its 30s pings) for too
          // long → assume the socket is half-open. Force a close so the
          // onclose path reconnects.
          try { sync.ws.close(); } catch { /* ignore */ }
        }
      }, 30_000);
      staleCheckTimer.unref?.();
    }
  };

  ws.onmessage = (event) => {
    lastServerPingAt = Date.now();
    let msg: { type?: string; state?: ClientStateSnapshot; inventory?: SessionInventory; seq?: number } | null = null;
    try {
      msg = JSON.parse(event.data as string);
    } catch {
      return;
    }
    if (!msg || msg.type !== 'client-state' || !msg.state) return;
    const snapshot: ControlSnapshot = {
      clientState: {
        sessions: Array.isArray(msg.state.sessions) ? msg.state.sessions : [],
        updatedAt: typeof msg.state.updatedAt === 'number' ? msg.state.updatedAt : Date.now(),
      },
      inventory: msg.inventory,
      seq: typeof msg.seq === 'number' ? msg.seq : undefined,
    };
    for (const listener of sync.listeners) {
      try { listener(snapshot); } catch (error) {
        console.error('[clientStateSync] listener threw:', error);
      }
    }
  };

  ws.onclose = () => {
    if (sync.ws === ws) sync.ws = null;
    if (sync.listeners.size > 0) {
      // Still have subscribers; reconnect.
      scheduleReconnect();
    }
    // If no subscribers, the idle-close timer is the one that decides.
  };

  ws.onerror = () => {
    // onclose will fire next; let it drive the reconnect.
  };
}

export function subscribeClientState(listener: Listener): () => void {
  sync.listeners.add(listener);
  clearIdleClose();
  if (!sync.ws) {
    // No live connection — open one. (Safe to call repeatedly; connect()
    // early-returns if already open or connecting.)
    connect();
  }
  return () => {
    sync.listeners.delete(listener);
    if (sync.listeners.size === 0) {
      // Defer close: a strict-mode/HMR second mount may be moments away.
      scheduleIdleClose();
    }
  };
}

// Test-only helper: tear down the singleton. Not used in production code.
export function __resetClientStateSyncForTests(): void {
  sync.closing = true;
  teardownConnection();
  if (sync.reconnectTimer) {
    clearTimeout(sync.reconnectTimer);
    sync.reconnectTimer = null;
  }
  clearIdleClose();
  sync.listeners.clear();
  sync.closing = false;
  sync.reconnectAttempt = 0;
}
