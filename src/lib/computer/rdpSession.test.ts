// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RdpSession } from './rdpSession';
const mocks = vi.hoisted(() => ({ clients: [] as any[], observers: [] as Array<() => void>, width: 1920, height: 900, displayWidth: 1280, displayHeight: 800, scale: vi.fn(), sendSize: vi.fn(), disconnect: vi.fn() }));
vi.mock('./secureRdpTunnel', () => ({ SecureRdpTunnel: class { cancelPointerMoves() {} } }));
vi.mock('guacamole-common-js', () => {
  class Client {
    static State = { CONNECTED: 3, DISCONNECTED: 5 };
    constructor() { mocks.clients.push(this); }
    getDisplay() { const element = document.createElement('div'); return { getElement: () => element, getWidth: () => mocks.displayWidth, getHeight: () => mocks.displayHeight, scale: mocks.scale, showCursor: vi.fn() }; }
    connect() {} disconnect = mocks.disconnect; sendSize = mocks.sendSize; sendMouseState = vi.fn(); sendKeyEvent = vi.fn();
  }
  class Mouse { onEach() {} on() {} setCursor() { return true; } }
  return { default: { Client, Mouse: Object.assign(Mouse, { Touchscreen: Mouse }), Keyboard: class { reset() {} } } };
});
beforeEach(() => {
  vi.useFakeTimers(); mocks.clients.length = 0; mocks.observers.length = 0; mocks.width = 1920; mocks.height = 900; mocks.scale.mockClear(); mocks.sendSize.mockClear(); mocks.disconnect.mockClear();
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { mocks.observers.push(callback); } observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => mocks.width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => mocks.height);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function session() { return new RdpSession(document.createElement('div'), { host: '127.0.0.1', port: 3389, username: 'test', password: 'secret', domain: '', ignoreCert: false, width: 1280, height: 800 }, vi.fn()); }
describe('RDP viewport lifecycle', () => {
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
});
