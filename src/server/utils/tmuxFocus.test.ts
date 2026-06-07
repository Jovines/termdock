import { describe, expect, it } from 'vitest';
import {
  getFocusSequence,
  removeClientFocusState,
  scanFocusTrackingMode,
  setClientFocusState,
  type FocusAggregationState,
} from './tmuxFocus.js';

function createAggregationState(): FocusAggregationState {
  return {
    focusedClients: new Map(),
    effectiveFocused: false,
  };
}

describe('tmux focus tracking helpers', () => {
  it('detects focus tracking enable and disable sequences', () => {
    let state = scanFocusTrackingMode('\x1b[?1004h', { buffer: '', requested: false });
    expect(state.requested).toBe(true);
    expect(state.changed).toBe(true);

    state = scanFocusTrackingMode('plain\x1b[?1004ltext', state);
    expect(state.requested).toBe(false);
    expect(state.changed).toBe(true);
  });

  it('detects focus tracking sequences split across chunks', () => {
    let state = scanFocusTrackingMode('\x1b[?10', { buffer: '', requested: false });
    expect(state.requested).toBe(false);
    expect(state.changed).toBe(false);

    state = scanFocusTrackingMode('04h', state);
    expect(state.requested).toBe(true);
    expect(state.changed).toBe(true);
  });

  it('aggregates focus across clients', () => {
    const state = createAggregationState();

    expect(setClientFocusState(state, 'a', true)).toEqual({ effectiveFocused: true, changed: true });
    expect(setClientFocusState(state, 'b', true)).toEqual({ effectiveFocused: true, changed: false });
    expect(setClientFocusState(state, 'a', false)).toEqual({ effectiveFocused: true, changed: false });
    expect(removeClientFocusState(state, 'b')).toEqual({ effectiveFocused: false, changed: true });
  });

  it('returns the canonical terminal focus sequences', () => {
    expect(getFocusSequence(true)).toBe('\x1b[I');
    expect(getFocusSequence(false)).toBe('\x1b[O');
  });
});
