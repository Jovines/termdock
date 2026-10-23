// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { observeDragLifetime, prepareDragLifetimes } from './dragLifetime';

const stops: (() => void)[] = [];
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.restoreAllMocks(); });
function observe(options: Parameters<typeof observeDragLifetime>[0]) {
  const stop = observeDragLifetime(options); stops.push(stop); return stop;
}
function pointer(type: string, pointerId = 1, pointerType = 'mouse', buttons = 1, target: EventTarget = window) {
  const event = new MouseEvent(type, { bubbles: true, buttons });
  Object.defineProperties(event, { pointerId: { value: pointerId }, pointerType: { value: pointerType } });
  target.dispatchEvent(event);
}

it('stops before a component can apply an unpressed mouse move and finishes exactly once', () => {
  prepareDragLifetimes();
  let active = true;
  const move = vi.fn(() => { if (active) applied(); });
  const applied = vi.fn();
  const finish = vi.fn(() => { active = false; });
  const stop = observe({ onFinish: finish });
  window.addEventListener('mousemove', move);
  window.dispatchEvent(new MouseEvent('mousemove', { buttons: 1 }));
  window.dispatchEvent(new MouseEvent('mousemove', { buttons: 0 }));
  window.dispatchEvent(new MouseEvent('mouseup'));
  stop();
  window.removeEventListener('mousemove', move);
  expect(applied).toHaveBeenCalledOnce();
  expect(finish).toHaveBeenCalledExactlyOnceWith('buttons-lost', expect.any(MouseEvent));
});

it.each(['blur', 'pagehide', 'escape', 'hidden', 'pointercancel', 'capture-lost'])('cleans up on %s even without a release event', reason => {
  const target = document.createElement('div');
  const releaseCapture = vi.fn();
  target.hasPointerCapture = () => true;
  target.releasePointerCapture = releaseCapture;
  const finish = vi.fn();
  observe({ pointerId: 1, pointerType: 'mouse', captureTarget: target, onFinish: finish });
  if (reason === 'hidden') {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
  } else if (reason === 'escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  else if (reason === 'capture-lost') pointer('lostpointercapture', 1, 'mouse', 0, target);
  else if (reason === 'pointercancel') pointer('pointercancel');
  else window.dispatchEvent(new Event(reason));
  pointer('pointerup');
  expect(finish).toHaveBeenCalledOnce();
  expect(releaseCapture).toHaveBeenCalledExactlyOnceWith(1);
});

it('ignores other pointers and keeps touch gestures alive when buttons is zero', () => {
  const finish = vi.fn();
  observe({ pointerId: 7, pointerType: 'touch', onFinish: finish });
  pointer('pointermove', 7, 'touch', 0);
  pointer('pointerup', 8, 'touch', 0);
  pointer('pointercancel', 8, 'touch', 0);
  window.dispatchEvent(new MouseEvent('mousemove', { buttons: 0 }));
  expect(finish).not.toHaveBeenCalled();
  pointer('pointerup', 7, 'touch', 0);
  expect(finish).toHaveBeenCalledExactlyOnceWith('release', expect.any(MouseEvent));
});

it('keeps two fingers independent and allows a fresh gesture after cancellation', () => {
  const first = vi.fn(), second = vi.fn(), next = vi.fn();
  observe({ pointerId: 1, pointerType: 'touch', onFinish: first });
  observe({ pointerId: 2, pointerType: 'touch', onFinish: second });
  pointer('pointercancel', 1, 'touch');
  expect(first).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled();
  pointer('pointerup', 2, 'touch');
  expect(second).toHaveBeenCalledOnce();
  observe({ pointerId: 1, pointerType: 'mouse', onFinish: next });
  pointer('pointermove', 1, 'mouse', 0);
  expect(next).toHaveBeenCalledExactlyOnceWith('buttons-lost', expect.any(MouseEvent));
});

it('lets normal component release handlers finish before fallback cleanup', async () => {
  const order: string[] = [];
  observe({ pointerId: 1, deferRelease: true, onFinish: () => order.push('cleanup') });
  const release = () => order.push('drop');
  window.addEventListener('pointerup', release);
  pointer('pointerup');
  window.removeEventListener('pointerup', release);
  expect(order).toEqual(['drop']);
  await Promise.resolve();
  expect(order).toEqual(['drop', 'cleanup']);
});

it('disposes without leaving callbacks subscribed to future gestures', () => {
  const finish = vi.fn();
  const stop = observe({ pointerId: 1, onFinish: finish });
  stop(); stop(); pointer('pointercancel'); pointer('pointerup');
  expect(finish).toHaveBeenCalledExactlyOnceWith('dispose', undefined);
});

it('does not confuse ordinary control focus changes with losing window focus', () => {
  const input = document.createElement('input');
  document.body.append(input);
  const finish = vi.fn();
  observe({ pointerId: 1, onFinish: finish });
  input.dispatchEvent(new FocusEvent('blur'));
  expect(finish).not.toHaveBeenCalled();
  window.dispatchEvent(new FocusEvent('blur'));
  expect(finish).toHaveBeenCalledExactlyOnceWith('blur', undefined);
  input.remove();
});
