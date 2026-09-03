import { describe, expect, it } from 'vitest';
import { estimateTerminalCellHeight } from './initialDimensions';

describe('estimateTerminalCellHeight', () => {
  it('uses the complete font box instead of the visibly painted glyph bounds', () => {
    expect(estimateTerminalCellHeight({
      actualBoundingBoxAscent: 9,
      actualBoundingBoxDescent: 0,
      fontBoundingBoxAscent: 13,
      fontBoundingBoxDescent: 4,
    }, 13, 1.05)).toBe(17);
  });

  it('falls back to glyph bounds when font bounds are unavailable', () => {
    expect(estimateTerminalCellHeight({
      actualBoundingBoxAscent: 10,
      actualBoundingBoxDescent: 3,
    }, 13, 1.2)).toBe(15);
  });

  it('falls back to the configured font size for incomplete metrics', () => {
    expect(estimateTerminalCellHeight({}, 14, 1.1)).toBe(15);
  });
});
