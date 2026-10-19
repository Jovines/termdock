// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { observeComputerMotion } from './motionObservation';
import type { ComputerPointer } from './pointer';
afterEach(() => { vi.unstubAllGlobals(); });
it('observes touch and pointer streams without cancelling or changing their routing', () => {
  const frames = new Map<number, FrameRequestCallback>(); let next = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const viewport = document.createElement('div'), record = vi.fn(), flush = vi.fn(), send = vi.fn();
  const pointer: ComputerPointer = { size: () => ({ width: 640, height: 1078 }), surface: () => viewport, send,
    position: () => ({ x: 100, y: 200 }), observeCursor: () => ({ transform: 'translate(100px,200px)' }) };
  const stop = observeComputerMotion(viewport, pointer, { record, flush, dispose() {} });
  const bubbled = vi.fn(); viewport.addEventListener('touchmove', bubbled);
  const emitPointer = (type: string) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerType: 'touch', pointerId: 8, clientX: 20, clientY: 30 }); viewport.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  };
  const emitTouch = (type: string, active: boolean) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const touch = { identifier: 3, clientX: 20, clientY: 30 };
    Object.assign(event, { touches: active ? [touch] : [], changedTouches: [touch] }); viewport.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  };
  emitPointer('pointerdown'); emitTouch('touchstart', true); emitPointer('pointercancel');
  // A pointer cancellation does not end observation of a still-active touch.
  emitTouch('touchmove', true); const callback = [...frames.values()][0]; frames.clear(); callback(16);
  expect(record).toHaveBeenCalledWith('browser-frame', expect.objectContaining({ logical: { x: 100, y: 200 } }));
  expect(record).toHaveBeenCalledWith('raw-pointer', expect.objectContaining({ type: 'pointercancel' }));
  expect(record).toHaveBeenCalledWith('raw-touch', expect.objectContaining({ touches: [[3, 20, 30]] }));
  expect(bubbled).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled();
  emitTouch('touchend', false); expect(frames.size).toBe(0);
  stop(); const count = record.mock.calls.length; emitTouch('touchmove', true);
  expect(record).toHaveBeenCalledTimes(count); expect(flush).toHaveBeenCalledWith('observation-stop');
});
