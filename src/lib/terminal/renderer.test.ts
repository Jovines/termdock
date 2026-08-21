import { describe, expect, it } from 'vitest';
import { shouldAllowTerminalTransparency } from './renderer';

describe('terminal renderer transparency', () => {
  it('only enables transparency when the WebGL image renderer can use it', () => {
    expect(shouldAllowTerminalTransparency('webgl', true)).toBe(true);
    expect(shouldAllowTerminalTransparency('webgl', false)).toBe(false);
    expect(shouldAllowTerminalTransparency('auto', true)).toBe(false);
    expect(shouldAllowTerminalTransparency('canvas', true)).toBe(false);
  });
});
