import { describe, expect, it } from 'vitest';
import { shouldConsumeAfterTmuxCopyModeExit } from './copyModeInput';

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
