// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { beginSidebarResize } from './sidebarResize';
afterEach(() => { vi.unstubAllGlobals(); document.body.style.cssText = ''; });
function setup() {
  const frames = new Map<number, FrameRequestCallback>(); let next = 0;
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++next, fn); return next; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const panel = document.createElement('div'); panel.style.width = '300px';
  const commit = vi.fn();
  const stop = beginSidebarResize(panel, 300, 300, w => Math.min(500, Math.max(200, w)), commit);
  return {panel, commit, stop, frames, flush: () => { for (const [id, fn] of frames) { frames.delete(id); fn(0); } }};
}
it('tracks the newest pointer once per frame without persisting until release', () => {
  const drag = setup();
  for (const x of [310, 320, 350]) window.dispatchEvent(new MouseEvent('mousemove', {buttons:1, clientX:x}));
  expect(drag.frames.size).toBe(1); drag.flush();
  expect(drag.panel.style.width).toBe('350px'); expect(drag.commit).not.toHaveBeenCalled();
  window.dispatchEvent(new MouseEvent('mouseup', {buttons:1, clientX:360}));
  expect(drag.panel.style.width).toBe('360px'); expect(drag.commit).toHaveBeenCalledExactlyOnceWith(360);
  window.dispatchEvent(new MouseEvent('mousemove', {buttons:1, clientX:400})); expect(drag.frames.size).toBe(0);
});
it('flushes the final clamped width even when released before the frame', () => {
  const drag = setup(); window.dispatchEvent(new MouseEvent('mousemove', {buttons:1, clientX:900}));
  window.dispatchEvent(new MouseEvent('mouseup', {buttons:1, clientX:900}));
  expect(drag.frames.size).toBe(0); expect(drag.commit).toHaveBeenCalledExactlyOnceWith(500);
});
it('cancels cleanly on unmount and restores existing body styles', () => {
  document.body.style.cursor='crosshair'; document.body.style.userSelect='text';
  const drag=setup(); window.dispatchEvent(new MouseEvent('mousemove', {buttons:1, clientX:400})); drag.stop();
  expect(drag.frames.size).toBe(0); expect(drag.commit).not.toHaveBeenCalled();
  expect(drag.panel.style.width).toBe('300px'); expect(document.body.style.cursor).toBe('crosshair');
  expect(document.body.style.userSelect).toBe('text');
});
it('commits the latest width on lost window focus and only once', () => {
  const drag=setup(); window.dispatchEvent(new MouseEvent('mousemove', {buttons:1, clientX:100}));
  window.dispatchEvent(new Event('blur')); drag.stop();
  expect(drag.commit).toHaveBeenCalledExactlyOnceWith(200); expect(drag.frames.size).toBe(0);
});
it('stops at the last held position when mouseup was lost, without applying hover coordinates', () => {
  const drag = setup();
  window.dispatchEvent(new MouseEvent('mousemove', {buttons:1, clientX:350}));
  drag.flush();
  window.dispatchEvent(new MouseEvent('mousemove', {buttons:0, clientX:450}));
  window.dispatchEvent(new MouseEvent('mousemove', {buttons:0, clientX:480}));
  drag.flush();
  expect(drag.panel.style.width).toBe('350px');
  expect(drag.commit).toHaveBeenCalledExactlyOnceWith(350);
  expect(document.body.style.cursor).toBe('');
  drag.stop();
});
it('rolls back a resize on Escape and removes pending frames', () => {
  const drag = setup();
  window.dispatchEvent(new MouseEvent('mousemove', {buttons:1, clientX:400}));
  drag.flush();
  window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}));
  expect(drag.panel.style.width).toBe('300px');
  expect(drag.commit).not.toHaveBeenCalled();
  expect(drag.frames.size).toBe(0);
});
