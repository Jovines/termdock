// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { attachComputerTouchpad } from './touchpad';
import type { ComputerTouchMode } from './touchpad';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });
function setup(mode: ComputerTouchMode = 'trackpad', viewOnly = false) {
  const viewport = document.createElement('div'), surface = document.createElement('canvas'), cursor = document.createElement('div');
  viewport.append(surface, cursor); document.body.append(viewport);
  viewport.getBoundingClientRect = () => ({ left: 0, top: 0, width: 390, height: 700 }) as DOMRect;
  surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 390, height: 234 }) as DOMRect;
  const send = vi.fn(), set = vi.fn(), pan = vi.fn();
  const cleanup = attachComputerTouchpad(viewport, { surface: () => surface, size: () => ({ width: 1000, height: 600 }), send }, cursor, { current: null },
    { mode, viewOnly, zoom: { get: () => 1, set, pan, dispose() {} } });
  const touch = (type: string, id: number, x: number, y: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerType: 'touch', pointerId: id, clientX: x, clientY: y }); viewport.dispatchEvent(event);
  };
  return { send, set, pan, cleanup, touch };
}
it.each(['trackpad', 'direct'] as const)('pinches the local desktop in %s mode without remote clicks or wheel events', mode => {
  const s = setup(mode);
  s.touch('pointerdown', 1, 80, 100); s.touch('pointerdown', 2, 180, 100);
  s.touch('pointermove', 2, 260, 100);
  expect(s.set).toHaveBeenCalledWith(1.8, expect.objectContaining({ x: 170, y: 100 }));
  s.touch('pointerup', 1, 80, 100); s.touch('pointerup', 2, 260, 100);
  expect(s.send).not.toHaveBeenCalled(); s.cleanup();
});
it('allows local pinch zoom in view-only mode without sending input', () => {
  const s = setup('direct', true);
  s.touch('pointerdown', 1, 80, 100); s.touch('pointerdown', 2, 180, 100); s.touch('pointermove', 2, 230, 100);
  expect(s.set).toHaveBeenCalled(); s.touch('pointerup', 1, 80, 100); s.touch('pointerup', 2, 230, 100);
  expect(s.send).not.toHaveBeenCalled(); s.cleanup();
});
it('keeps two-finger scrolling available in trackpad mode and sends a direct tap at remote coordinates', () => {
  const scroll = setup();
  scroll.touch('pointerdown', 1, 80, 100); scroll.touch('pointerdown', 2, 180, 100);
  scroll.touch('pointermove', 1, 80, 80); scroll.touch('pointermove', 2, 180, 80);
  scroll.touch('pointerup', 1, 80, 80); scroll.touch('pointerup', 2, 180, 80);
  expect(scroll.set).not.toHaveBeenCalled(); expect(scroll.send).toHaveBeenCalledWith(500, 300, 16); scroll.cleanup();
  const direct = setup('direct'); direct.touch('pointerdown', 1, 195, 117); direct.touch('pointerup', 1, 195, 117);
  expect(direct.send.mock.calls).toEqual([[500, 300, 1], [500, 300, 0]]); direct.cleanup();
});
