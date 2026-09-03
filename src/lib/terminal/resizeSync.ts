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
