// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { SecureVncChannel } from './secureVncChannel';
const mocks = vi.hoisted(() => ({ socket: { readyState: 1, send: vi.fn(), close: vi.fn() } }));
vi.mock('../federation/browserIntegration', () => ({ secureSocket: vi.fn(() => mocks.socket) }));
it('filters Mac encoding negotiation inside the existing secure channel and never filters authentication bytes', () => {
  const channel = new SecureVncChannel('fixture-mac', vi.fn());
  const bytes = new Uint8Array(12), view = new DataView(bytes.buffer);
  bytes[0] = 2; view.setUint16(2, 2); view.setInt32(4, 0x574d5664); view.setInt32(8, -239);
  mocks.socket.send.mockClear();
  channel.send(bytes); // The same byte pattern outside SetEncodings is untouched.
  channel.withMacCursorEncodings(() => channel.send(bytes));
  expect(() => channel.withMacCursorEncodings(() => { throw new Error('test interruption'); })).toThrow();
  channel.send(bytes);
  const sent = mocks.socket.send.mock.calls.map(([json]) => Uint8Array.from(atob(JSON.parse(json).data), char => char.charCodeAt(0)));
  expect(sent[0]).toEqual(bytes); expect(sent[2]).toEqual(bytes);
  expect(sent[1]).toEqual(new Uint8Array([2, 0, 0, 1, 255, 255, 255, 17]));
});
