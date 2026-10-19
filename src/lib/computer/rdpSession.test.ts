// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RdpSession } from './rdpSession';
const mocks = vi.hoisted(() => ({ clients: [] as any[], mice: [] as any[], tunnels: [] as any[], keyboardReset: vi.fn(), displays: [] as any[], readers: [] as any[], observers: [] as Array<() => void>, width: 1920, height: 900, displayWidth: 1280, displayHeight: 800, scale: vi.fn(), sendSize: vi.fn(), disconnect: vi.fn() }));
vi.mock('./secureRdpTunnel', () => ({ SecureRdpTunnel: class { constructor() { mocks.tunnels.push(this); } cancelPointerMoves() {} sendPointer = vi.fn(); } }));
vi.mock('guacamole-common-js', () => {
  class Client {
    static State = { CONNECTED: 3, DISCONNECTED: 5 };
    constructor() { mocks.clients.push(this); }
    getDisplay() { const element = document.createElement('div'), cursor = document.createElement('div'); const display = { getCursorLayer: () => ({ getElement: () => cursor }), getElement: () => element, getWidth: () => mocks.displayWidth, getHeight: () => mocks.displayHeight, cursorX: 700, cursorY: 120, scale: mocks.scale, showCursor: vi.fn(), moveCursor: vi.fn() }; mocks.displays.push(display); return display; }
    connect() {} disconnect = mocks.disconnect; sendSize = mocks.sendSize; sendMouseState = vi.fn(); sendKeyEvent = vi.fn();
  }
  class Mouse { handlers: Record<string, (event?: any) => void> = {}; constructor() { mocks.mice.push(this); } onEach(names: string[], callback: (event: any) => void) { names.forEach(name => { this.handlers[name] = callback; }); } on(name: string, callback: () => void) { this.handlers[name] = callback; } reset() {} setCursor() { return true; } }
  return { default: { Client, ArrayBufferReader: class { constructor() { mocks.readers.push(this); } }, Mouse: Object.assign(Mouse, { Touchscreen: Mouse }), Keyboard: class { reset = mocks.keyboardReset } } };
});
beforeEach(() => {
  vi.useFakeTimers(); mocks.readers.length = 0; mocks.clients.length = 0; mocks.mice.length = 0; mocks.tunnels.length = 0; mocks.displays.length = 0; mocks.keyboardReset.mockClear(); mocks.observers.length = 0; mocks.width = 1920; mocks.height = 900; mocks.displayWidth = 1280; mocks.displayHeight = 800; mocks.scale.mockClear(); mocks.sendSize.mockClear(); mocks.disconnect.mockClear();
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { mocks.observers.push(callback); } observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => mocks.width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => mocks.height);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function session() { return new RdpSession(document.createElement('div'), { host: '127.0.0.1', port: 3389, username: 'test', password: 'secret', domain: '', ignoreCert: false, width: 1280, height: 800 }, vi.fn()); }
describe('RDP viewport lifecycle', () => {
  it('draws the remote system cursor immediately for touchpad movement and preserves cursor shape updates', () => {
    const s = session(); mocks.clients[0].onstatechange(3);
    const display = mocks.displays[0], pointer = s.pointerTarget;
    expect(display.getCursorLayer().getElement().style.transition).toBe('none');
    pointer.send(240, 180, 0);
    expect(display.moveCursor).toHaveBeenLastCalledWith(240, 180);
    expect(display.showCursor).toHaveBeenLastCalledWith(true);
    expect(mocks.tunnels[0].sendPointer).toHaveBeenLastCalledWith(240, 180, 0);
    // Even if CSS cursors work for a physical mouse, touchpad input must keep
    // the remote bitmap visible when the server supplies a new shape/hotspot.
    display.oncursor(document.createElement('canvas'), 5, 7);
    expect(display.showCursor).toHaveBeenLastCalledWith(true);
    s.viewOnly = true; expect(display.showCursor).toHaveBeenLastCalledWith(false);
    pointer.send(300, 200, 1); expect(mocks.tunnels[0].sendPointer).toHaveBeenCalledTimes(1);
    s.disconnect();
  });
  it('ignores compatibility mouse movement and mouseout after touch until a physical mouse takes over', () => {
    const target = document.createElement('div');
    const s = new RdpSession(target, { host: '127.0.0.1', port: 3389, username: 'test', password: 'secret', domain: '', ignoreCert: false, width: 1280, height: 800 }, vi.fn());
    mocks.clients[0].onstatechange(3);
    expect(s.pointerTarget.position?.()).toEqual({ x: 700, y: 120 });
    s.pointerTarget.send(750, 150, 0);
    const mouse = mocks.mice[0], display = mocks.displays[0];
    display.oncursor(document.createElement('canvas'), 0, 0);
    mouse.handlers.mousemove({ state: { x: 30, y: 50 } }); mouse.handlers.mouseout();
    expect(mocks.clients[0].sendMouseState).not.toHaveBeenCalled();
    expect(display.showCursor).toHaveBeenLastCalledWith(true);
    const physical = new Event('pointermove', { bubbles: true }); Object.assign(physical, { pointerType: 'mouse' });
    target.firstElementChild!.dispatchEvent(physical);
    mouse.handlers.mousemove({ state: { x: 80, y: 60 } });
    expect(mocks.clients[0].sendMouseState).toHaveBeenCalledExactlyOnceWith({ x: 80, y: 60 }, true);
    mouse.handlers.mouseout(); expect(display.showCursor).toHaveBeenLastCalledWith(false); s.disconnect();
  });
  it('updates only the renderer cursor when sending a touchpad sample', () => {
    const s = session(); mocks.clients[0].onstatechange(3);
    const display = mocks.displays[0], pointer = s.pointerTarget;
    expect(pointer).not.toHaveProperty('preview');
    pointer.send(120, 181, 0);
    expect(display.moveCursor).toHaveBeenCalledExactlyOnceWith(120, 181);
    expect(display.showCursor).toHaveBeenLastCalledWith(true);
    expect(mocks.tunnels[0].sendPointer).toHaveBeenCalledExactlyOnceWith(120, 181, 0);
    s.disconnect();
  });
  it('retains manual magnification when the viewport resizes without changing pointer scale independently', () => {
    const s = session(); s.viewportZoom = 2;
    expect(mocks.scale).toHaveBeenLastCalledWith(2.25);
    mocks.height = 400; mocks.observers[0]();
    expect(mocks.scale).toHaveBeenLastCalledWith(1);
    s.viewportZoom = 1; expect(mocks.scale).toHaveBeenLastCalledWith(0.5); s.disconnect();
  });
  it('waits for observed login before announcing a connected Guacamole desktop, and announces once', () => {
    const s = session(), connected = vi.fn(); s.addEventListener('connect', connected);
    mocks.tunnels[0].onauthentication('pending'); mocks.clients[0].onstatechange(3);
    expect(connected).not.toHaveBeenCalled();
    mocks.tunnels[0].onauthentication('authenticated');
    expect(connected).toHaveBeenCalledTimes(1);
    mocks.clients[0].onstatechange(3); mocks.tunnels[0].onauthentication('authenticated');
    expect(connected).toHaveBeenCalledTimes(1); s.disconnect();
  });
  it('retains old-server compatibility and proceeds when local login observation is unavailable', () => {
    const legacy = session(), legacyConnect = vi.fn(); legacy.addEventListener('connect', legacyConnect);
    mocks.clients[0].onstatechange(3); expect(legacyConnect).toHaveBeenCalledTimes(1); legacy.disconnect();
    const observed = session(), observedConnect = vi.fn(); observed.addEventListener('connect', observedConnect);
    mocks.tunnels[1].onauthentication('pending'); mocks.clients[1].onstatechange(3);
    expect(observedConnect).not.toHaveBeenCalled(); mocks.tunnels[1].onauthentication('unavailable');
    expect(observedConnect).toHaveBeenCalledTimes(1); observed.disconnect();
  });
  it('ignores late connection and authentication callbacks after cancellation', () => {
    const s = session(), connected = vi.fn(); s.addEventListener('connect', connected);
    mocks.tunnels[0].onauthentication('pending'); s.disconnect();
    mocks.clients[0].onstatechange(3); mocks.tunnels[0].onauthentication('authenticated');
    expect(connected).not.toHaveBeenCalled();
  });
  it('keeps the phone input focused during desktop pointer use and resets held keyboard state', () => {
    const target = document.createElement('div'); document.body.append(target);
    const s = new RdpSession(target, { host: '127.0.0.1', port: 3389, username: 'test', password: 'secret', domain: '', ignoreCert: false, width: 1280, height: 800 }, vi.fn());
    const container = target.firstElementChild as HTMLElement;
    const input = document.createElement('input'); document.body.append(input); input.focus();
    s.keyboardActive = true; expect(mocks.keyboardReset).toHaveBeenCalledTimes(1);
    const pointer = new Event('pointerdown', { bubbles: true, cancelable: true }); container.dispatchEvent(pointer);
    expect(pointer.defaultPrevented).toBe(true); expect(document.activeElement).toBe(input);
    s.keyboardActive = false; expect(mocks.keyboardReset).toHaveBeenCalledTimes(2);
    const desktop = new Event('pointerdown', { bubbles: true, cancelable: true }); container.dispatchEvent(desktop);
    expect(desktop.defaultPrevented).toBe(false); expect(document.activeElement).toBe(container.querySelector('textarea'));
    s.disconnect(); target.remove(); input.remove();
  });
  it('does not announce or resize an empty desktop until display dimensions arrive', () => {
    mocks.displayWidth = 0; mocks.displayHeight = 0;
    const s = session(), connected = vi.fn(); s.addEventListener('connect', connected);
    mocks.clients[0].onstatechange(3); vi.advanceTimersByTime(200);
    expect(connected).not.toHaveBeenCalled(); expect(mocks.sendSize).not.toHaveBeenCalled();
    mocks.displayWidth = 1280; mocks.displayHeight = 800; mocks.displays[0].onresize();
    expect(connected).toHaveBeenCalledTimes(1); vi.advanceTimersByTime(200);
    expect(mocks.sendSize).toHaveBeenCalledExactlyOnceWith(1920, 900); s.disconnect();
  });
  it('does not report a successful connection while XRDP is still authenticating', () => {
    const s = session(), connected = vi.fn(); s.addEventListener('connect', connected);
    mocks.tunnels[0].onauthentication('pending'); mocks.clients[0].onstatechange(3);
    expect(connected).not.toHaveBeenCalled(); vi.advanceTimersByTime(200); expect(mocks.sendSize).not.toHaveBeenCalled(); mocks.tunnels[0].onauthentication('authenticated');
    expect(connected).toHaveBeenCalledTimes(1); mocks.clients[0].onstatechange(3);
    expect(connected).toHaveBeenCalledTimes(1); s.disconnect();
  });
  it('keeps the phone input focused when touching the remote desktop, and restores desktop focus after closing the keyboard', () => {
    const target = document.createElement('div'); document.body.appendChild(target);
    const s = new RdpSession(target, { host: '127.0.0.1', port: 3389, username: 'test', password: 'secret', domain: '', ignoreCert: false, width: 1280, height: 800 }, vi.fn());
    const input = document.createElement('input'); document.body.appendChild(input); input.focus();
    s.keyboardActive = true; target.firstElementChild!.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(input);
    s.keyboardActive = false; target.firstElementChild!.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(target.querySelector('textarea')); s.disconnect(); target.remove(); input.remove();
  });
  it('waits for the hidden connecting screen to become visible and resizes once to its usable area', () => {
    mocks.width = 0; mocks.height = 0; const s = session(); mocks.clients[0].onstatechange(3); vi.advanceTimersByTime(200);
    expect(mocks.sendSize).not.toHaveBeenCalled();
    mocks.width = 1920; mocks.height = 900; mocks.observers[0](); vi.advanceTimersByTime(200);
    expect(mocks.sendSize).toHaveBeenCalledExactlyOnceWith(1920, 900);
    mocks.observers[0](); vi.advanceTimersByTime(200); expect(mocks.sendSize).toHaveBeenCalledTimes(1); s.disconnect();
  });
  it('fits a fixed desktop without distortion and retains usable resolution on a narrow screen', () => {
    const s = session(); s.scaleViewport = true;
    expect(mocks.scale).toHaveBeenLastCalledWith(1.125);
    mocks.width = 390; mocks.height = 600; mocks.clients[0].onstatechange(3); mocks.observers[0](); vi.advanceTimersByTime(200);
    expect(mocks.sendSize).toHaveBeenLastCalledWith(640, 985);
    expect(mocks.scale).toHaveBeenLastCalledWith(390 / 1280); s.disconnect();
  });
  it('keeps resolution stable when remote repaint or zoom changes inner scrollbars', () => {
    const target = document.createElement('div');
    Object.defineProperties(target, { clientWidth: { get: () => 390 }, clientHeight: { get: () => 744 } });
    const s = new RdpSession(target, { host: '127.0.0.1', port: 3389, username: 'test', password: 'secret', domain: '', ignoreCert: false, width: 640, height: 1221 }, vi.fn());
    // The existing desktop temporarily overflows while XRDP repaints. Only the
    // inner scroller loses width/height; the actual viewport has not changed.
    mocks.width = 375; mocks.height = 729;
    mocks.clients[0].onstatechange(3); mocks.observers[0](); vi.advanceTimersByTime(200);
    expect(mocks.sendSize).not.toHaveBeenCalled();
    expect(mocks.scale).toHaveBeenLastCalledWith(390 / 1280);
    s.viewportZoom = 2; mocks.observers[0](); vi.advanceTimersByTime(200);
    mocks.width = 390; mocks.height = 744; s.viewportZoom = 1;
    mocks.displays[0].onresize(); mocks.observers[0](); vi.advanceTimersByTime(200);
    expect(mocks.sendSize).not.toHaveBeenCalled(); s.disconnect();
  });
  it('debounces window resizing, preserves original-size mode, and cancels pending updates on disconnect', () => {
    const s = session(); mocks.clients[0].onstatechange(3);
    mocks.width = 1500; mocks.observers[0](); mocks.width = 1600; mocks.observers[0](); vi.advanceTimersByTime(200);
    expect(mocks.sendSize).toHaveBeenCalledExactlyOnceWith(1600, 900);
    s.scaleViewport = false; mocks.width = 2000; mocks.observers[0](); vi.advanceTimersByTime(200);
    expect(mocks.scale).toHaveBeenLastCalledWith(1); expect(mocks.sendSize).toHaveBeenCalledTimes(1);
    s.scaleViewport = true; s.disconnect(); vi.advanceTimersByTime(200); expect(mocks.sendSize).toHaveBeenCalledTimes(1);
  });
  it('distinguishes certificate validation from credential failure', () => {
    const fail = vi.fn(); const s = new RdpSession(document.createElement('div'), { host: '127.0.0.1', port: 3389, username: 'test', password: 'secret', domain: '', ignoreCert: false, width: 1280, height: 800 }, fail);
    mocks.clients[0].onerror({ code: 0x0200, message: 'The server certificate could not be validated.' }); expect(fail).toHaveBeenLastCalledWith('COMPUTER_RDP_CERTIFICATE');
    mocks.clients[0].onerror({ code: 0x0301, message: 'Invalid credentials' }); expect(fail).toHaveBeenLastCalledWith('COMPUTER_AUTH_FAILED'); s.disconnect();
  });
  it('keeps remote resolution stable while the phone keyboard is open, then resumes viewport sizing', () => {
    const s = session(); mocks.clients[0].onstatechange(3); vi.advanceTimersByTime(200);
    mocks.sendSize.mockClear(); s.pauseResize = true; mocks.height = 480; mocks.observers[0](); vi.advanceTimersByTime(200);
    expect(mocks.sendSize).not.toHaveBeenCalled();
    s.pauseResize = false; vi.advanceTimersByTime(200); expect(mocks.sendSize).toHaveBeenCalledExactlyOnceWith(1920, 480); s.disconnect();
  });
  it('retains readable desktop scale when the phone keyboard reduces the viewport instead of shrinking the whole desktop', () => {
    mocks.width = 390; mocks.height = 743; mocks.displayWidth = 640; mocks.displayHeight = 1221;
    const s = session(); s.scaleViewport = true; const scale = mocks.scale.mock.lastCall![0];
    s.keyboardActive = true; s.pauseResize = true; mocks.height = 329; mocks.observers[0]();
    expect(mocks.scale).toHaveBeenLastCalledWith(scale);
    s.keyboardActive = false; expect(mocks.scale).toHaveBeenLastCalledWith(329 / 1221); s.disconnect();
  });
});


it('receives a complete Unicode clipboard stream and ignores replaced or disconnected streams', () => {
  const s = session(), receive = vi.fn(); s.addEventListener('clipboard', receive);
  const stream = { sendAck: vi.fn() };
  mocks.clients[0].onclipboard(stream, 'text/plain;charset=utf-8');
  mocks.readers[0].ondata(new TextEncoder().encode('你好').buffer); mocks.readers[0].ondata(new TextEncoder().encode('🙂\ntext').buffer);
  expect(receive).not.toHaveBeenCalled(); mocks.readers[0].onend();
  expect(receive.mock.calls[0][0].detail.text).toBe('你好🙂\ntext');
  mocks.clients[0].onclipboard(stream, 'text/plain'); const old = mocks.readers[1];
  mocks.clients[0].onclipboard(stream, 'text/plain'); const latest = mocks.readers[2];
  old.ondata(new TextEncoder().encode('stale').buffer); old.onend(); expect(receive).toHaveBeenCalledTimes(1);
  latest.ondata(new TextEncoder().encode('new').buffer); latest.onend(); expect(receive.mock.calls[1][0].detail.text).toBe('new');
  mocks.clients[0].onclipboard(stream, 'text/plain'); s.disconnect();
  mocks.readers[3].ondata(new TextEncoder().encode('late').buffer); mocks.readers[3].onend(); expect(receive).toHaveBeenCalledTimes(2);
});
it('rejects non-text and oversized remote clipboard streams without emitting partial text', () => {
  const s = session(), receive = vi.fn(), failed = vi.fn(); s.addEventListener('clipboard', receive); s.addEventListener('clipboarderror', failed);
  const stream = { sendAck: vi.fn() };
  mocks.clients[0].onclipboard(stream, 'image/png'); expect(mocks.readers).toHaveLength(0); expect(stream.sendAck).toHaveBeenCalled();
  mocks.clients[0].onclipboard(stream, 'text/plain'); mocks.readers[0].ondata(new TextEncoder().encode('a'.repeat(1_048_577)).buffer); mocks.readers[0].onend();
  expect(receive).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledTimes(1); s.disconnect();
});
