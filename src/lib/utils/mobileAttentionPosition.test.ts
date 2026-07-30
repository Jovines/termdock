import { describe, expect, it } from 'vitest';
import {
  MOBILE_ATTENTION_EDGE_GAP_PX,
  MOBILE_ATTENTION_SIZE_PX,
  clampMobileAttentionDrag,
  resolveMobileAttentionPosition,
  snapMobileAttentionPosition,
} from './mobileAttentionPosition';

const viewport = {
  width: 390,
  height: 664,
  safeTop: 20,
  safeRight: 0,
  safeBottom: 34,
  safeLeft: 0,
};

describe('mobile attention position', () => {
  it('keeps both snap points outside the sidebar edge gesture zones', () => {
    const left = resolveMobileAttentionPosition(viewport, { side: 'left', yRatio: 0.5 });
    const right = resolveMobileAttentionPosition(viewport, { side: 'right', yRatio: 0.5 });

    expect(left.x).toBe(MOBILE_ATTENTION_EDGE_GAP_PX);
    expect(right.x + MOBILE_ATTENTION_SIZE_PX).toBe(
      viewport.width - MOBILE_ATTENTION_EDGE_GAP_PX,
    );
  });

  it('clamps dragging away from the top chrome and bottom keyboard bar', () => {
    expect(clampMobileAttentionDrag(viewport, { x: -100, y: -100 })).toEqual({
      x: MOBILE_ATTENTION_EDGE_GAP_PX,
      y: 52,
    });
    const bottom = clampMobileAttentionDrag(viewport, { x: 999, y: 999 });
    expect(bottom.x + MOBILE_ATTENTION_SIZE_PX).toBe(
      viewport.width - MOBILE_ATTENTION_EDGE_GAP_PX,
    );
    expect(bottom.y + MOBILE_ATTENTION_SIZE_PX).toBeLessThanOrEqual(
      viewport.height - viewport.safeBottom - 72,
    );
  });

  it('snaps to the nearest side and preserves proportional height', () => {
    const snapped = snapMobileAttentionPosition(viewport, { x: 40, y: 240 });
    expect(snapped.preference.side).toBe('left');

    const rotated = resolveMobileAttentionPosition(
      { ...viewport, width: 844, height: 390 },
      snapped.preference,
    );
    expect(rotated.x).toBe(MOBILE_ATTENTION_EDGE_GAP_PX);
    expect(rotated.y).toBeGreaterThanOrEqual(52);
  });
});
