export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface PendingResize extends TerminalSize {
  seq: number;
  attempt: number;
}

export interface ResizeSyncState {
  confirmed: TerminalSize | null;
  pending: PendingResize | null;
  nextSeq: number;
}

export type ResizeRequest = PendingResize;

export function createResizeSyncState(): ResizeSyncState {
  return { confirmed: null, pending: null, nextSeq: 1 };
}

function sameSize(a: TerminalSize | null, b: TerminalSize): boolean {
  return a?.cols === b.cols && a.rows === b.rows;
}

function makeRequest(
  state: ResizeSyncState,
  size: TerminalSize,
  attempt: number,
): { state: ResizeSyncState; request: ResizeRequest } {
  const request = { ...size, seq: state.nextSeq, attempt };
  return {
    state: { ...state, pending: request, nextSeq: state.nextSeq + 1 },
    request,
  };
}

export function requestResize(
  state: ResizeSyncState,
  size: TerminalSize,
): { state: ResizeSyncState; request: ResizeRequest | null } {
  if (sameSize(state.pending, size) || (!state.pending && sameSize(state.confirmed, size))) {
    return { state, request: null };
  }
  return makeRequest(state, size, 0);
}

/**
 * Re-send the current dimensions even when they are already confirmed. TUI
 * programs use the resulting PTY resize signal to repaint an authoritative
 * cursor after a cold client has reconstructed the screen from byte history.
 */
export function forceResize(
  state: ResizeSyncState,
  size: TerminalSize,
): { state: ResizeSyncState; request: ResizeRequest } {
  return makeRequest(state, size, 0);
}

export function acknowledgeResize(
  state: ResizeSyncState,
  ack: { seq?: number; ok: boolean; cols?: number; rows?: number },
): { state: ResizeSyncState; accepted: boolean } {
  const pending = state.pending;
  if (!pending || ack.seq !== pending.seq) {
    return { state, accepted: false };
  }
  const confirmed = ack.ok && Number.isFinite(ack.cols) && Number.isFinite(ack.rows)
    && (ack.cols ?? 0) > 0 && (ack.rows ?? 0) > 0
    ? { cols: Math.floor(ack.cols!), rows: Math.floor(ack.rows!) }
    : null;
  return {
    state: { ...state, confirmed, pending: null },
    accepted: true,
  };
}

export function retryResize(
  state: ResizeSyncState,
  seq: number,
  maxRetries = 1,
): { state: ResizeSyncState; request: ResizeRequest | null; exhausted: boolean } {
  const pending = state.pending;
  if (!pending || pending.seq !== seq) {
    return { state, request: null, exhausted: false };
  }
  if (pending.attempt >= maxRetries) {
    return {
      state: { ...state, confirmed: null, pending: null },
      request: null,
      exhausted: true,
    };
  }
  const next = makeRequest(state, pending, pending.attempt + 1);
  return { ...next, exhausted: false };
}

export function observeServerSize(
  state: ResizeSyncState,
  size: TerminalSize,
): ResizeSyncState {
  if (!Number.isFinite(size.cols) || !Number.isFinite(size.rows) || size.cols <= 0 || size.rows <= 0) {
    return state;
  }
  return {
    ...state,
    confirmed: { cols: Math.floor(size.cols), rows: Math.floor(size.rows) },
  };
}

export function clearPendingResize(state: ResizeSyncState): ResizeSyncState {
  return { ...state, pending: null };
}

/**
 * Coalescing policy for fit-driven resize pushes. Layout transitions (split
 * panes attaching, saved trees settling, keyboard animations) produce a burst
 * of fits within a few hundred milliseconds; each push triggers a tmux window
 * resize and a full redraw on every attached viewer, so pushing every step
 * makes the whole workspace visibly jump for seconds. The first push goes out
 * immediately (first-fit, single resizes keep zero added latency); pushes that
 * arrive while the previous one is still settling are held and only the newest
 * size is sent when the window closes.
 */
export const RESIZE_PUSH_COALESCE_MS = 150;

export interface ResizePushGate {
  lastPushAt: number;
}

export function createResizePushGate(now = 0): ResizePushGate {
  return { lastPushAt: now };
}

export type ResizePushDecision =
  | { action: 'send' }
  | { action: 'hold'; readyAt: number };

export function planResizePush(
  gate: ResizePushGate,
  now: number,
  coalesceMs = RESIZE_PUSH_COALESCE_MS,
): ResizePushDecision {
  if (now - gate.lastPushAt >= coalesceMs) {
    gate.lastPushAt = now;
    return { action: 'send' };
  }
  return { action: 'hold', readyAt: gate.lastPushAt + coalesceMs };
}

export function markResizePushSent(now: number): ResizePushGate {
  return { lastPushAt: now };
}
