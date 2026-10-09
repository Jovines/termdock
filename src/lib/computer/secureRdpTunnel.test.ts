// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Guacamole from 'guacamole-common-js';
import { SecureRdpTunnel } from './secureRdpTunnel';

const mocks = vi.hoisted(() => ({ socket: vi.fn() }));
vi.mock('../federation/browserIntegration', () => ({ secureSocket: mocks.socket }));
let socket: {
  readyState: number; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>;
  onopen: (() => void) | null; onmessage: ((event: { data: string }) => void) | null;
  onclose: ((event: { reason: string }) => void) | null; onerror: (() => void) | null;
};
const options = () => ({ host: '127.0.0.1', port: 3389, username: 'rdp-user', password: 'private-password', domain: '', ignoreCert: false, width: 1280, height: 800 });
beforeEach(() => {
  mocks.socket.mockReset();
  socket = { readyState: 0, send: vi.fn(), close: vi.fn(), onopen: null, onmessage: null, onclose: null, onerror: null };
  mocks.socket.mockReturnValue(socket);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Native fetch forbidden'); }));
  vi.stubGlobal('WebSocket', vi.fn(() => { throw new Error('Native socket forbidden'); }));
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { controller: null } });
  Object.defineProperty(window, 'termdockDesktop', { configurable: true, value: { uploadClipboardImage: vi.fn(), uploadDroppedFiles: vi.fn() } });
});
afterEach(() => { vi.unstubAllGlobals(); delete (window as unknown as { termdockDesktop?: unknown }).termdockDesktop; });

describe('secure RDP tunnel', () => {
  it('works on first load without worker control or native transports, sends credentials after open, and acknowledges display records', () => {
    const credentials = options(), tunnel = new SecureRdpTunnel(credentials, vi.fn());
    const instruction = vi.fn(); tunnel.oninstruction = instruction;
    tunnel.connect();
    expect(mocks.socket).toHaveBeenCalledWith('/api/computer/ws?host=127.0.0.1&protocol=rdp&port=3389');
    expect(socket.send).not.toHaveBeenCalled();
    socket.readyState = 1; socket.onopen!();
    expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({ type: 'start', password: 'private-password', ignoreCert: false });
    expect(credentials.password).toBe('');
    socket.onmessage!({ data: JSON.stringify({ type: 'instructions', seq: 1, instructions: [['ready', 'session-id'], ['size', '0', '1280', '800']] }) });
    expect(tunnel.state).toBe(Guacamole.Tunnel.State.OPEN);
    expect(instruction).toHaveBeenCalledWith('size', ['0', '1280', '800']);
    expect(socket.send.mock.calls.map(call => JSON.parse(call[0]))).toContainEqual({ type: 'instruction', opcode: 'nop', args: [] });
    expect(JSON.parse(socket.send.mock.lastCall![0])).toEqual({ type: 'ack', seq: 1 });
    tunnel.sendMessage('key', 65507, 1);
    expect(JSON.parse(socket.send.mock.lastCall![0])).toEqual({ type: 'instruction', opcode: 'key', args: ['65507', '1'] });
    expect(fetch).not.toHaveBeenCalled(); expect(WebSocket).not.toHaveBeenCalled();
    tunnel.disconnect();
  });

  it('coalesces high-frequency movement while preserving clicks, scroll, and keyboard ordering', () => {
    const frames: Array<FrameRequestCallback> = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn(callback => { frames.push(callback); return frames.length; }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const tunnel = new SecureRdpTunnel(options(), vi.fn()); tunnel.connect(); socket.readyState = 1; socket.onopen!();
    socket.onmessage!({ data: JSON.stringify({ type: 'instructions', seq: 1, instructions: [['ready', 'session']] }) }); socket.send.mockClear();
    for (let i = 0; i < 200; i++) tunnel.sendMessage('mouse', i, i, 0);
    expect(socket.send).not.toHaveBeenCalled(); frames[0](0);
    expect(JSON.parse(socket.send.mock.lastCall![0])).toEqual({ type: 'instruction', opcode: 'mouse', args: ['199', '199', '0'] });
    expect(socket.send).toHaveBeenCalledTimes(1);
    tunnel.sendMessage('mouse', 210, 210, 0); tunnel.sendMessage('mouse', 211, 211, 1);
    tunnel.sendMessage('mouse', 220, 220, 1); tunnel.sendMessage('mouse', 221, 221, 0);
    tunnel.sendMessage('mouse', 230, 230, 0); tunnel.sendMessage('key', 13, 1);
    const inputs = socket.send.mock.calls.map(call => JSON.parse(call[0]));
    expect(inputs.map(input => [input.opcode, ...input.args])).toEqual([
      ['mouse', '199', '199', '0'], ['mouse', '210', '210', '0'], ['mouse', '211', '211', '1'],
      ['mouse', '220', '220', '1'], ['mouse', '221', '221', '0'], ['mouse', '230', '230', '0'], ['key', '13', '1'],
    ]);
    tunnel.sendMessage('mouse', 240, 240, 8); tunnel.sendMessage('mouse', 240, 240, 0);
    expect(socket.send.mock.calls.slice(-2).map(call => JSON.parse(call[0]).args[2])).toEqual(['8', '0']);
    tunnel.sendMessage('mouse', 250, 250, 0); const count = socket.send.mock.calls.length; tunnel.disconnect(); frames.at(-1)!(0); expect(socket.send).toHaveBeenCalledTimes(count);
    expect(fetch).not.toHaveBeenCalled(); expect(WebSocket).not.toHaveBeenCalled();
  });
  it('keeps remote cursor echoes from overriding active local control, while still displaying a remote cursor in view-only mode', () => {
    let local = true; const tunnel = new SecureRdpTunnel(options(), vi.fn(), () => local); const instruction = vi.fn(); tunnel.oninstruction = instruction;
    tunnel.connect(); socket.readyState = 1; socket.onopen!();
    socket.onmessage!({ data: JSON.stringify({ type: 'instructions', seq: 1, instructions: [['ready', 'session'], ['mouse', '10', '20'], ['sync', '1']] }) });
    expect(instruction).not.toHaveBeenCalledWith('mouse', ['10', '20']); expect(instruction).toHaveBeenCalledWith('sync', ['1']);
    local = false;
    socket.onmessage!({ data: JSON.stringify({ type: 'instructions', seq: 2, instructions: [['mouse', '30', '40']] }) });
    expect(instruction).toHaveBeenCalledWith('mouse', ['30', '40']); expect(JSON.parse(socket.send.mock.lastCall![0])).toEqual({ type: 'ack', seq: 2 }); tunnel.disconnect();
  });
  it('preserves authorization errors and never falls back after transport failure', () => {
    const fail = vi.fn(), credentials = options(); const tunnel = new SecureRdpTunnel(credentials, fail);
    tunnel.connect(); socket.onerror!(); socket.onclose!({ reason: 'Authorization revoked' });
    expect(fail).toHaveBeenCalledWith('Authorization revoked');
    expect(tunnel.state).toBe(Guacamole.Tunnel.State.CLOSED);
    expect(credentials.password).toBe(''); expect(fetch).not.toHaveBeenCalled(); expect(WebSocket).not.toHaveBeenCalled();
    tunnel.disconnect();
  });

  it('cancels before open without transmitting credentials or accepting stale output', () => {
    const credentials = options(), tunnel = new SecureRdpTunnel(credentials, vi.fn());
    tunnel.connect(); tunnel.disconnect();
    expect(socket.onopen).toBeNull(); expect(socket.onmessage).toBeNull();
    expect(socket.send).not.toHaveBeenCalled(); expect(credentials.password).toBe('');
  });

  it('closes on malformed or repeated display records', () => {
    const fail = vi.fn(), tunnel = new SecureRdpTunnel(options(), fail); tunnel.connect();
    socket.readyState = 1; socket.onopen!();
    socket.onmessage!({ data: JSON.stringify({ type: 'instructions', seq: 2, instructions: [['sync', '1']] }) });
    expect(fail).toHaveBeenCalledWith('COMPUTER_INVALID_MESSAGE');
    expect(socket.close).toHaveBeenCalled();
  });
});
