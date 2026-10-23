import { describe, expect, it } from 'vitest';
import { createFontZoomGesture } from './fontZoomGesture';

const wheel = (deltaY: number, extra = {}) => ({ ctrlKey: true, metaKey: false, deltaX: 0, deltaY, deltaMode: 0, ...extra });

describe('terminal font zoom gesture', () => {
  it('ignores ordinary scrolling, zero deltas, horizontal movement and isolated trackpad noise', () => {
    const gesture = createFontZoomGesture();
    expect(gesture.consume(wheel(100, { ctrlKey: false }), 0)).toBe(0);
    expect(gesture.consume(wheel(0), 1)).toBe(0);
    expect(gesture.consume(wheel(100, { deltaX: 200 }), 2)).toBe(0);
    expect(gesture.consume(wheel(NaN), 3)).toBe(0);
    for (let i = 0; i < 100; i++) expect(gesture.consume(wheel(1), 1000 + i * 300)).toBe(0);
  });

  it('accumulates intentional pinch movement and limits a rapid wheel burst to one step', () => {
    const gesture = createFontZoomGesture();
    for (let i = 0; i < 19; i++) expect(gesture.consume(wheel(2), i)).toBe(0);
    expect(gesture.consume(wheel(2), 19)).toBe(-1);
    for (let i = 20; i < 100; i++) expect(gesture.consume(wheel(120), i)).toBe(0);
    expect(gesture.consume(wheel(40), 150)).toBe(-1);
  });

  it('supports command-wheel and mouse wheel line/page units in both directions', () => {
    const gesture = createFontZoomGesture();
    expect(gesture.consume(wheel(-3, { ctrlKey: false, metaKey: true, deltaMode: 1 }), 0)).toBe(1);
    expect(gesture.consume(wheel(1, { deltaMode: 2 }), 200)).toBe(-1);
  });

  it('does not carry partial movement across refocus, an idle gap, ordinary scrolling or reversal', () => {
    const gesture = createFontZoomGesture();
    expect(gesture.consume(wheel(30), 0)).toBe(0);
    gesture.reset();
    expect(gesture.consume(wheel(30), 10)).toBe(0);
    expect(gesture.consume(wheel(30), 300)).toBe(0);
    expect(gesture.consume(wheel(100, { ctrlKey: false }), 301)).toBe(0);
    expect(gesture.consume(wheel(30), 302)).toBe(0);
    expect(gesture.consume(wheel(-30), 303)).toBe(0);
    expect(gesture.consume(wheel(-10), 304)).toBe(1);
  });
});
