import { describe, expect, it } from 'vitest';
import { shouldForceSettledRedraw } from './refreshRedraw';

describe('shouldForceSettledRedraw', () => {
  it('keeps the recovery redraw when terminal dimensions stayed unchanged', () => {
    expect(shouldForceSettledRedraw(
      { cols: 80, rows: 24 },
      { cols: 80, rows: 24 },
    )).toBe(true);
  });

  it('skips the redundant redraw after xterm already resized and repainted', () => {
    expect(shouldForceSettledRedraw(
      { cols: 80, rows: 24 },
      { cols: 100, rows: 30 },
    )).toBe(false);
  });

  it('uses the conservative recovery path when dimensions are unavailable', () => {
    expect(shouldForceSettledRedraw(null, { cols: 80, rows: 24 })).toBe(true);
    expect(shouldForceSettledRedraw({ cols: 80, rows: 24 }, null)).toBe(true);
  });
});
