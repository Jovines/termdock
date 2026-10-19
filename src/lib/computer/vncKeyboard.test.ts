// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type RFB from '@novnc/novnc';
import { attachVncKeyboard } from './vncKeyboard';
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });
function setup() {
  const screen = document.createElement('div'), canvas = document.createElement('canvas'); screen.append(canvas); document.body.append(screen);
  const keyboard = { _target: canvas as HTMLElement, grab: vi.fn(), ungrab: vi.fn(), _allKeysUp: vi.fn() };
  const focus = vi.fn(), send = vi.fn(), session = { _mouseButtonMask: 0, _mousePos: { x: 40, y: 60 }, _mouseMoveTimer: null, _sendMouse: vi.fn(), _screen: screen, _canvas: canvas, _keyboard: keyboard, focus, viewOnly: false };
  const stop = attachVncKeyboard(session as unknown as RFB, send), field = screen.querySelector('textarea')!;
  return { screen, canvas, keyboard, focus, send, session, stop, field };
}
it('rebinds noVNC physical-key handling and restores it after teardown', () => {
  const s = setup(); expect(s.keyboard._target).toBe(s.field); s.session.focus(); expect(document.activeElement).toBe(s.field);
  s.stop(); s.stop(); expect(s.keyboard._target).toBe(s.canvas); expect(s.session.focus).toBe(s.focus); expect(s.screen.querySelector('textarea')).toBeNull();
  expect(s.keyboard.ungrab).toHaveBeenCalledTimes(2); expect(s.keyboard.grab).toHaveBeenCalledTimes(2);
});
it('keeps browser composition alive and commits a candidate once after trailing input', () => {
  let callback!: FrameRequestCallback; vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { callback = fn; return 1; }); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const s = setup(), renderer = vi.fn(); s.field.addEventListener('keydown', renderer);
  const key = new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, cancelable: true }); s.field.dispatchEvent(key);
  expect(key.defaultPrevented).toBe(false); expect(renderer).not.toHaveBeenCalled();
  s.field.dispatchEvent(new CompositionEvent('compositionstart')); s.field.value = 'ni';
  s.field.dispatchEvent(new InputEvent('input', { isComposing: true })); expect(s.send).not.toHaveBeenCalled();
  s.field.value = '你好🙂'; s.field.dispatchEvent(new CompositionEvent('compositionend', { data: '你好🙂' }));
  s.field.dispatchEvent(new InputEvent('input', { data: '你好🙂' })); expect(s.send).not.toHaveBeenCalled();
  callback(0); expect(s.send).toHaveBeenCalledExactlyOnceWith('你好🙂'); expect(s.field.value).toBe(''); s.stop();
});
it('flushes an already confirmed candidate on blur but sends nothing in view-only mode', () => {
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const s = setup(); s.field.value = 'confirmed'; s.field.dispatchEvent(new CompositionEvent('compositionend')); s.field.dispatchEvent(new Event('blur'));
  expect(s.send).toHaveBeenCalledExactlyOnceWith('confirmed'); expect(s.keyboard._allKeysUp).toHaveBeenCalled();
  s.session.viewOnly = true; s.field.value = 'ignored'; s.field.dispatchEvent(new InputEvent('input')); expect(s.send).toHaveBeenCalledTimes(1); s.stop();
  expect(s.keyboard.grab).toHaveBeenCalledTimes(1);
});

it('releases physical mouse drag on window blur without leaving a timer to send stale movement', () => {
  const s = setup(); s.session._mouseButtonMask = 1; window.dispatchEvent(new Event('blur'));
  expect(s.session._sendMouse).toHaveBeenCalledExactlyOnceWith(40, 60, 0); expect(s.session._mouseButtonMask).toBe(0);
  s.stop(); expect(s.session._sendMouse).toHaveBeenCalledTimes(1);
});
