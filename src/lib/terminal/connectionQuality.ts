import type { ConnectionDiagnostics, DiagnosticSocket } from '../federation/connectionDiagnostics';
/** Application RTT on the terminal's existing encrypted socket, including relays. */
interface ProbeState {
  pending?: { id: string; sentAt: number };
  lastPoll: number;
  lastSent: number;
  lastReply: number;
  samples: Array<number | null>;
  handlerMs?: number;
}
export interface ConnectionQuality {
  connected: boolean;
  rtt: number | null;
  average: number | null;
  jitter: number | null;
  timeouts: number;
  samples: number;
  waiting: boolean;
  minimum?: number;
  maximum?: number;
  p95?: number;
  history?: Array<number | null>;
  handlerMs?: number;
  lastReplyAgeMs?: number;
  diagnostics?: ConnectionDiagnostics;
}
const states = new WeakMap<WebSocket, ProbeState>();
let sequence = 0;

export function receiveQualityPong(ws: WebSocket, id: unknown, handlerMs?: unknown): void {
  const state = states.get(ws);
  if (!state?.pending || state.pending.id !== id) return;
  const now = performance.now();
  // Background suspension and heavily delayed UI timers must not become RTT samples.
  if (!document.hidden && now - state.lastPoll < 2500) {
    const elapsed = now - state.pending.sentAt;
    state.samples.push(elapsed < 8000 ? elapsed : null);
    state.samples = state.samples.slice(-20);
    if (elapsed < 8000) {
      state.lastReply = now;
      state.handlerMs = typeof handlerMs === 'number' && Number.isFinite(handlerMs) && handlerMs >= 0 && handlerMs <= elapsed ? handlerMs : undefined;
    }
  }
  state.pending = undefined;
}

export function pollConnectionQuality(ws?: WebSocket): ConnectionQuality {
  const empty: ConnectionQuality = { connected: false, rtt: null, average: null, jitter: null, timeouts: 0, samples: 0, waiting: false };
  if (!ws || ws.readyState !== WebSocket.OPEN) return empty;
  const now = performance.now();
  let state = states.get(ws);
  if (!state) {
    state = { lastPoll: now, lastSent: -Infinity, lastReply: -Infinity, samples: [] };
    states.set(ws, state);
  }
  if (document.hidden || now - state.lastPoll >= 2500) {
    state.pending = undefined;
    state.lastSent = -Infinity;
    state.lastReply = -Infinity;
  }
  state.lastPoll = now;
  if (!document.hidden) {
    if (state.pending && now - state.pending.sentAt >= 8000) {
      state.samples.push(null);
      state.samples = state.samples.slice(-20);
      state.pending = undefined;
    }
    if (!state.pending && now - state.lastSent >= 5000) {
      const id = `quality-${++sequence}`;
      state.pending = { id, sentAt: now };
      state.lastSent = now;
      try { ws.send(JSON.stringify({ type: 'ping', qualityProbeId: id })); }
      catch { state.pending = undefined; return empty; }
    }
  }
  const values = state.samples.filter((value): value is number => value !== null);
  const latest = state.samples[state.samples.length - 1];
  const fresh = now - state.lastReply < 15000;
  const differences = values.slice(1).map((value, index) => Math.abs(value - values[index]));
  const sorted = [...values].sort((a, b) => a - b);
  return {
    diagnostics: (ws as WebSocket & DiagnosticSocket).getConnectionDiagnostics?.(),
    minimum: sorted[0], maximum: sorted[sorted.length - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    history: [...state.samples], handlerMs: fresh && latest != null ? state.handlerMs : undefined,
    lastReplyAgeMs: Number.isFinite(state.lastReply) ? now - state.lastReply : undefined,
    connected: true,
    rtt: fresh && latest != null ? Math.round(latest) : null,
    average: values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null,
    jitter: differences.length ? Math.round(differences.reduce((a, b) => a + b, 0) / differences.length) : null,
    timeouts: state.samples.length - values.length,
    samples: state.samples.length,
    waiting: !!state.pending && now - state.pending.sentAt >= 1500,
  };
}
