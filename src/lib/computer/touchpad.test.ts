// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { attachComputerTouchpad } from './touchpad';
import type { ComputerTouchMode } from './touchpad';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
function setup(mode: ComputerTouchMode = 'trackpad', viewOnly = false, rendersCursor = false, remotePosition?: { x: number; y: number }) {
  const viewport = document.createElement('div'), surface = document.createElement('canvas'), cursor = document.createElement('div');
  viewport.append(surface, cursor); document.body.append(viewport);
  viewport.getBoundingClientRect = () => ({ left: 0, top: 0, width: 390, height: 700 }) as DOMRect;
  surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 390, height: 234 }) as DOMRect;
  const send = vi.fn(), set = vi.fn(), pan = vi.fn();
  const cleanup = attachComputerTouchpad(viewport, { rendersCursor, position: remotePosition ? () => remotePosition : undefined, surface: () => surface, size: () => ({ width: 1000, height: 600 }), send }, cursor, { current: null },
    { mode, viewOnly, zoom: { get: () => 1, set, pan, dispose() {} } });
  const touch = (type: string, id: number, x: number, y: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerType: 'touch', pointerId: id, clientX: x, clientY: y }); viewport.dispatchEvent(event);
  };
  return { send, set, pan, cleanup, touch, cursor };
}
it.each(['trackpad', 'direct'] as const)('pinches the local desktop in %s mode without remote clicks or wheel events', mode => {
  vi.useFakeTimers();
  const s = setup(mode);
  s.touch('pointerdown', 1, 80, 100); s.touch('pointerdown', 2, 180, 100);
  s.touch('pointermove', 2, 260, 100);
  vi.advanceTimersByTime(50);
  expect(s.set).toHaveBeenCalledWith(1.8, expect.objectContaining({ x: 170, y: 100 }));
  s.touch('pointerup', 1, 80, 100); s.touch('pointerup', 2, 260, 100);
  expect(s.send).not.toHaveBeenCalled(); s.cleanup();
});
it('allows local pinch zoom in view-only mode without sending input', () => {
  vi.useFakeTimers();
  const s = setup('direct', true);
  s.touch('pointerdown', 1, 80, 100); s.touch('pointerdown', 2, 180, 100); s.touch('pointermove', 2, 230, 100);
  vi.advanceTimersByTime(50);
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

it('uses the session cursor without drawing a second generic arrow', () => {
  const native = setup('trackpad', false, true);
  native.touch('pointerdown', 1, 80, 100); native.touch('pointermove', 1, 100, 100);
  native.touch('pointerup', 1, 100, 100);
  expect(native.send).toHaveBeenCalled(); expect(native.cursor.hidden).toBe(true); native.cleanup();
  const fallback = setup();
  fallback.touch('pointerdown', 1, 80, 100); fallback.touch('pointermove', 1, 100, 100);
  fallback.touch('pointerup', 1, 100, 100);
  expect(fallback.cursor.hidden).toBe(true); fallback.cleanup();
});

it('starts each relative gesture at the displayed remote cursor instead of jumping to the desktop centre', () => {
  const remote = { x: 100, y: 90 };
  const s = setup('trackpad', false, true, remote);
  s.touch('pointerdown', 1, 80, 100); s.touch('pointermove', 1, 119, 80.5); s.touch('pointerup', 1, 119, 80.5);
  expect(s.send).toHaveBeenLastCalledWith(200, 40, 0);
  // A physical mouse or server-side action may move the cursor between gestures.
  remote.x = 700; remote.y = 400;
  s.touch('pointerdown', 2, 20, 20); s.touch('pointermove', 2, 59, 20); s.touch('pointerup', 2, 59, 20);
  expect(s.send).toHaveBeenLastCalledWith(800, 400, 0); s.cleanup();
});

it('forwards captured continuous touch input directly without waiting for frames or drawing a local cursor', () => {
  const frames = new Map<number, FrameRequestCallback>(); let next = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const viewport = document.createElement('div'), surface = document.createElement('div'), cursor = document.createElement('div'); viewport.append(surface, cursor);
  const scaleX = 0.6280029296875, scaleY = 0.6280148423005566;
  viewport.getBoundingClientRect = () => ({ left: 0, top: 0, width: 402, height: 677 }) as DOMRect;
  surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640 * scaleX, height: 1078 * scaleY }) as DOMRect;
  let local = { x: 200, y: 500 };
  const send = vi.fn((x: number, y: number) => { local = { x, y }; });
  const stop = attachComputerTouchpad(viewport, { size: () => ({ width: 640, height: 1078 }), surface: () => surface,
    rendersCursor: true, position: () => local, send }, cursor, { current: null }, { mode: 'trackpad' });
  const input = (type: string, x: number, y: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerType: 'touch', pointerId: 1, clientX: x, clientY: y }); viewport.dispatchEvent(event);
  };
  // Relative input positions and actual RAF order from the reproduced 51/57 ms stalls.
  const timeline: Array<[number, string, number?, number?]> = [[0,"input",0.0,0],[0,"frame"],[17,"input",0.0,-6.666667],[17,"frame"],[33,"frame"],[37,"input",0.0,-16.333333],[66,"input",2.333333,-28.333333],[67,"frame"],[72,"input",8.666667,-43],[73,"frame"],[84,"input",16.333333,-59.333333],[84,"frame"],[100,"input",25.333333,-76.666667],[101,"frame"],[116,"input",35.666667,-93],[117,"frame"],[134,"frame"],[137,"input",46.333333,-108],[161,"input",57.666667,-121],[174,"frame"],[177,"input",69.0,-133],[177,"frame"],[183,"input",80.666667,-144],[183,"frame"],[199,"input",93.333333,-155.333333],[200,"frame"],[216,"input",106.333333,-165.333333],[216,"frame"]];
  input('pointerdown', 0, 0);
  let checked = 0;
  for (const [time, kind, x, y] of timeline) {
    if (kind === 'frame') { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(time)); }
    else {
      const sent = send.mock.calls.length;
      input('pointermove', x!, y!);
      expect(cursor.hidden).toBe(true);
      expect(send).toHaveBeenCalledTimes(sent + 1); checked++;
    }
  }
  expect(checked).toBeGreaterThan(10); expect(send.mock.calls.length).toBe(checked);
  expect(send).toHaveBeenLastCalledWith(Math.round(200 + 106.333333 / scaleX), Math.round(500 - 165.333333 / scaleY), 0);
  const last = timeline.filter(row => row[1] === 'input').at(-1)!;
  input('pointerup', last[2]!, last[3]!); stop();
});


it.each([['horizontal', 120, 100], ['vertical', 100, 120]] as const)(
  'does not mistake staggered %s finger positions for pinch during parallel scrolling', (_axis, x, y) => {
    vi.useFakeTimers();
    const s = setup();
    s.touch('pointerdown', 1, 100, 100); s.touch('pointerdown', 2, x, y);
    // One physical two-finger sample arrives as two separate pointer events.
    s.touch('pointermove', 1, 100, 70);
    expect(s.set).not.toHaveBeenCalled();
    s.touch('pointermove', 2, x, y - 30);
    vi.advanceTimersByTime(60);
    s.touch('pointerup', 1, 100, 70); s.touch('pointerup', 2, x, y - 30);
    expect(s.set).not.toHaveBeenCalled();
    expect(s.send.mock.calls.some(call => call[2] === 16)).toBe(true);
    expect(s.send.mock.calls.every(call => call[2] === 0 || call[2] === 16)).toBe(true);
    s.cleanup();
  });

it('locks a scroll gesture until all fingers lift even if their spacing later changes', () => {
  vi.useFakeTimers();
  const s = setup();
  s.touch('pointerdown', 1, 80, 100); s.touch('pointerdown', 2, 180, 100);
  s.touch('pointermove', 1, 80, 70); s.touch('pointermove', 2, 180, 70);
  s.touch('pointermove', 2, 260, 40);
  vi.advanceTimersByTime(60);
  s.touch('pointerup', 1, 80, 70); s.touch('pointerup', 2, 260, 40);
  expect(s.set).not.toHaveBeenCalled();
  expect(s.send.mock.calls.some(call => call[2] === 16)).toBe(true); s.cleanup();
});

it.each(['pointercancel', 'lostpointercapture', 'blur', 'dispose'] as const)(
  'cancels an undecided pinch without delayed input after %s', reason => {
    vi.useFakeTimers();
    const s = setup();
    s.touch('pointerdown', 1, 80, 100); s.touch('pointerdown', 2, 180, 100);
    s.touch('pointermove', 2, 260, 100);
    if (reason === 'blur') window.dispatchEvent(new Event('blur'));
    else if (reason === 'dispose') s.cleanup();
    else s.touch(reason, 2, 260, 100);
    vi.advanceTimersByTime(1000);
    expect(s.set).not.toHaveBeenCalled(); expect(s.send).not.toHaveBeenCalled();
    s.cleanup();
  });


it.each(['pointercancel', 'lostpointercapture', 'blur', 'dispose'] as const)(
  'releases a held drag once without replaying movement on %s', reason => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 42));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const s = setup();
    s.touch('pointerdown', 1, 80, 100); vi.advanceTimersByTime(450);
    expect(s.send.mock.calls.map(call => call[2])).toEqual([1]);
    s.touch('pointermove', 1, 119, 100);
    if (reason === 'blur') window.dispatchEvent(new Event('blur'));
    else if (reason === 'dispose') s.cleanup();
    else s.touch(reason, 1, 119, 100);
    expect(s.send.mock.calls.map(call => call[2])).toEqual([1, 1, 0]);
    vi.advanceTimersByTime(1000); s.touch('pointerup', 1, 119, 100); s.cleanup();
    expect(s.send.mock.calls.map(call => call[2])).toEqual([1, 1, 0]);
  });

it('drops queued wheel events when the page loses focus before the frame', () => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 42));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const s = setup();
  s.touch('pointerdown', 1, 80, 100); s.touch('pointerdown', 2, 180, 100);
  s.touch('pointermove', 1, 80, 40); s.touch('pointermove', 2, 180, 40);
  window.dispatchEvent(new Event('blur')); vi.advanceTimersByTime(1000);
  expect(s.send).not.toHaveBeenCalled(); s.cleanup();
});

it('sends each single-finger delta immediately even when the browser never runs RAF', () => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const s = setup('trackpad', false, true, { x: 100, y: 90 });
  s.touch('pointerdown', 1, 80, 100); expect(s.send).not.toHaveBeenCalled();
  s.touch('pointermove', 1, 119, 80.5); expect(s.send).toHaveBeenLastCalledWith(200, 40, 0);
  s.touch('pointermove', 1, 158, 80.5); expect(s.send).toHaveBeenLastCalledWith(300, 40, 0);
  expect(s.send).toHaveBeenCalledTimes(2);
  s.touch('pointerup', 1, 158, 80.5); expect(s.send).toHaveBeenCalledTimes(2); s.cleanup();
});
