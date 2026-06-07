export interface FocusTrackingScanState {
  buffer: string;
  requested: boolean;
}

export interface FocusTrackingScanResult extends FocusTrackingScanState {
  changed: boolean;
}

export interface FocusClientState {
  clientId: string;
  focused: boolean;
}

export interface FocusAggregationState {
  focusedClients: Map<string, boolean>;
  effectiveFocused: boolean;
}

export const FOCUS_IN_SEQUENCE = '\x1b[I';
export const FOCUS_OUT_SEQUENCE = '\x1b[O';

const FOCUS_MODE_PATTERN = /\x1b\[\?1004([hl])/g;
const MAX_FOCUS_MODE_BUFFER = 16;

export function scanFocusTrackingMode(
  chunk: string,
  previous: FocusTrackingScanState,
): FocusTrackingScanResult {
  const combined = previous.buffer + chunk;
  let requested = previous.requested;
  let changed = false;
  let match: RegExpExecArray | null;

  FOCUS_MODE_PATTERN.lastIndex = 0;
  while ((match = FOCUS_MODE_PATTERN.exec(combined)) !== null) {
    const nextRequested = match[1] === 'h';
    if (requested !== nextRequested) {
      requested = nextRequested;
      changed = true;
    }
  }

  return {
    buffer: combined.slice(-MAX_FOCUS_MODE_BUFFER),
    requested,
    changed,
  };
}

export function setClientFocusState(
  state: FocusAggregationState,
  clientId: string,
  focused: boolean,
): { effectiveFocused: boolean; changed: boolean } {
  if (focused) {
    state.focusedClients.set(clientId, true);
  } else {
    state.focusedClients.delete(clientId);
  }

  return recomputeEffectiveFocus(state);
}

export function removeClientFocusState(
  state: FocusAggregationState,
  clientId: string,
): { effectiveFocused: boolean; changed: boolean } {
  state.focusedClients.delete(clientId);
  return recomputeEffectiveFocus(state);
}

export function recomputeEffectiveFocus(
  state: FocusAggregationState,
): { effectiveFocused: boolean; changed: boolean } {
  const nextFocused = Array.from(state.focusedClients.values()).some(Boolean);
  const changed = state.effectiveFocused !== nextFocused;
  state.effectiveFocused = nextFocused;
  return { effectiveFocused: nextFocused, changed };
}

export function getFocusSequence(focused: boolean): string {
  return focused ? FOCUS_IN_SEQUENCE : FOCUS_OUT_SEQUENCE;
}
