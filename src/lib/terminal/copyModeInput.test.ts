import { describe, expect, it } from 'vitest';
import { isTmuxMouseOrFocusInput, shouldConsumeAfterTmuxCopyModeExit } from './copyModeInput';

describe('shouldConsumeAfterTmuxCopyModeExit', () => {
  it('consumes a bare Escape after using the control channel to leave copy mode', () => {
    expect(shouldConsumeAfterTmuxCopyModeExit('\x1b')).toBe(true);
  });

  it('keeps forwarding other input after leaving copy mode', () => {
    expect(shouldConsumeAfterTmuxCopyModeExit('a')).toBe(false);
    expect(shouldConsumeAfterTmuxCopyModeExit('\r')).toBe(false);
    expect(shouldConsumeAfterTmuxCopyModeExit('\x1b[A')).toBe(false);
  });
});

describe('isTmuxMouseOrFocusInput', () => {
  it('recognizes SGR mouse reports, including coalesced focus reports', () => {
    expect(isTmuxMouseOrFocusInput('\x1b[<0;12;8M')).toBe(true);
    expect(isTmuxMouseOrFocusInput('\x1b[<32;13;8M\x1b[<0;13;8m')).toBe(true);
    expect(isTmuxMouseOrFocusInput('\x1b[I\x1b[<0;12;8M')).toBe(true);
    expect(isTmuxMouseOrFocusInput('\x1b[O')).toBe(true);
  });

  it('recognizes legacy mouse encodings', () => {
    expect(isTmuxMouseOrFocusInput('\x1b[M !!')).toBe(true);
    expect(isTmuxMouseOrFocusInput('\x1b[32;12;8M')).toBe(true);
  });

  it('does not classify keyboard input as mouse or focus input', () => {
    expect(isTmuxMouseOrFocusInput('a')).toBe(false);
    expect(isTmuxMouseOrFocusInput('\x1b')).toBe(false);
    expect(isTmuxMouseOrFocusInput('\x1b[A')).toBe(false);
  });
});
