import { describe, expect, it } from 'vitest';
import { moveMirrorViewport, type ViewportGeometry } from './mirrorViewport';

const box: ViewportGeometry = { cx: 200, cy: 300, width: 400, height: 600, contentWidth: 200, contentHeight: 600 };
const center = { x: 200, y: 300 };

describe('mirror viewport direct manipulation', () => {
  it('keeps an off-centre focal point fixed even on a letterboxed axis', () => {
    const focus = { x: 250, y: 400 };
    const view = moveMirrorViewport({ zoom: 1, pan: { x: 0, y: 0 } }, box, focus, focus, 1.5);
    expect(view.pan).toEqual({ x: -25, y: -50 });
    expect((focus.x - box.cx - view.pan.x) / view.zoom).toBe(50);
    expect((focus.y - box.cy - view.pan.y) / view.zoom).toBe(100);
  });

  it('reverses immediately after hitting the zoom limit', () => {
    const limit = moveMirrorViewport({ zoom: 1, pan: { x: 0, y: 0 } }, box, center, center, 10);
    const reversed = moveMirrorViewport(limit, box, center, center, 0.99);
    expect(limit.zoom).toBe(8);
    expect(reversed.zoom).toBeCloseTo(7.92);
  });

  it('discards pan overshoot so reversing by one pixel moves one pixel', () => {
    const limit = moveMirrorViewport({ zoom: 2, pan: { x: 0, y: 0 } }, box, center, { x: 1200, y: 300 }, 1);
    expect(limit.pan.x).toBe(100);
    const reversed = moveMirrorViewport(limit, box, { x: 1200, y: 300 }, { x: 1199, y: 300 }, 1);
    expect(reversed.pan.x).toBe(99);
  });

  it('returns exactly to the fitted pose after a reversible pinch', () => {
    const focus = { x: 245, y: 350 };
    let view = { zoom: 1, pan: { x: 0, y: 0 } };
    for (let i = 0; i < 100; i++) view = moveMirrorViewport(view, box, focus, focus, 1.01);
    for (let i = 0; i < 100; i++) view = moveMirrorViewport(view, box, focus, focus, 1 / 1.01);
    expect(view.zoom).toBeCloseTo(1, 10);
    expect(view.pan.x).toBeCloseTo(0, 10);
    expect(view.pan.y).toBeCloseTo(0, 10);
  });
});
