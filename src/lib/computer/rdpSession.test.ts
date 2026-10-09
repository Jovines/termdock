// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RdpSession } from './rdpSession';
const mocks = vi.hoisted(() => ({ clients: [] as any[], tunnels: [] as any[], keyboardReset: vi.fn(), displays: [] as any[], observers: [] as Array<() => void>, width: 1920, height: 900, displayWidth: 1280, displayHeight: 800, scale: vi.fn(), sendSize: vi.fn(), disconnect: vi.fn() }));
vi.mock('./secureRdpTunnel', () => ({ SecureRdpTunnel: class { constructor() { mocks.tunnels.push(this); } cancelPointerMoves() {} } }));
vi.mock('guacamole-common-js', () => {
  class Client {
    static State = { CONNECTED: 3, DISCONNECTED: 5 };
    constructor() { mocks.clients.push(this); }
    getDisplay() { const element = document.createElement('div'); const display = { getElement: () => element, getWidth: () => mocks.displayWidth, getHeight: () => mocks.displayHeight, scale: mocks.scale, showCursor: vi.fn() }; mocks.displays.push(display); return display; }
    connect() {} disconnect = mocks.disconnect; sendSize = mocks.sendSize; sendMouseState = vi.fn(); sendKeyEvent = vi.fn();
  }
  class Mouse { onEach() {} on() {} setCursor() { return true; } }
  return { default: { Client, Mouse: Object.assign(Mouse, { Touchscreen: Mouse }), Keyboard: class { reset = mocks.keyboardReset } } };
});
beforeEach(() => {
  vi.useFakeTimers(); mocks.clients.length = 0; mocks.tunnels.length = 0; mocks.displays.length = 0; mocks.keyboardReset.mockClear(); mocks.observers.length = 0; mocks.width = 1920; mocks.height = 900; mocks.displayWidth = 1280; mocks.displayHeight = 800; mocks.scale.mockClear(); mocks.sendSize.mockClear(); mocks.disconnect.mockClear();
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { mocks.observers.push(callback); } observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => mocks.width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => mocks.height);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function session() { return new RdpSession(document.createElement('div'), { host: '127.0.0.1', port: 3389, username: 'test', password: 'secret', domain: '', ignoreCert: false, width: 1280, height: 800 }, vi.fn()); }
describe('RDP viewport lifecycle', () => {
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
    expect(desktop.defaultPrevented).toBe(false); expect(document.activeElement).toBe(container);
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
    expect(document.activeElement).toBe(target.firstElementChild); s.disconnect(); target.remove(); input.remove();
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
