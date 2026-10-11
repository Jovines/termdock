// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type RFB from '@novnc/novnc';
import { attachComputerZoom } from './zoom';

it('keeps manual VNC magnification through renderer resizing and restores the renderer on disposal', () => {
  const canvas = document.createElement('canvas'), scroller = document.createElement('div');
  const display = { scale: 0.25 };
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000 * display.scale, height: 600 * display.scale }) as DOMRect;
  scroller.getBoundingClientRect = () => ({ left: 0, top: 0, width: 390, height: 700 }) as DOMRect;
  const original = vi.fn(() => { display.scale = 0.25; });
  const session = { _canvas: canvas, _screen: scroller, _display: display, _updateScale: original };
  const changed = vi.fn(), zoom = attachComputerZoom(session as unknown as RFB, changed);
  zoom.set(2); expect(display.scale).toBe(0.5); expect(zoom.get()).toBe(2);
  session._updateScale(); expect(display.scale).toBe(0.5);
  zoom.set(50); expect(zoom.get()).toBe(8);
  zoom.set(0); expect(zoom.get()).toBe(1); expect(display.scale).toBe(0.25); expect(scroller.scrollLeft).toBe(0); expect(scroller.scrollTop).toBe(0);
  zoom.dispose(); expect(session._updateScale).toBe(original);
});
