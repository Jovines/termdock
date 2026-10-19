import { expect, it, vi } from 'vitest';
import type RFB from '@novnc/novnc';
import type { SecureVncChannel } from './secureVncChannel';
import { configureMacVncCursor, macVncCursorEncodings } from './vncMacCursor';
const encode = (encodings: number[]) => {
  const bytes = new Uint8Array(4 + encodings.length * 4), view = new DataView(bytes.buffer);
  bytes[0] = 2; view.setUint16(2, encodings.length);
  encodings.forEach((value, index) => view.setInt32(4 + 4 * index, value)); return bytes;
};
it('omits only VMware cursor support while retaining RichCursor, image encodings and clipboard negotiation', () => {
  const bytes = encode([1, 7, -223, -308, -309, 0x574d5664, -239]);
  expect(macVncCursorEncodings(bytes)).toEqual(encode([1, 7, -223, -308, -309, -239]));
  expect(Array.from(bytes)).toEqual(Array.from(encode([1, 7, -223, -308, -309, 0x574d5664, -239])));
});
it('leaves non-encoding, incomplete and already compatible messages unchanged', () => {
  for (const bytes of [encode([-239]), new Uint8Array([2, 0, 0, 1]), new Uint8Array([4, 1, 0, 0, 0, 0, 0, 65])]) {
    expect(macVncCursorEncodings(bytes)).toBe(bytes);
  }
});
it('adapts only one Mac session and keeps the original synchronous negotiation path', () => {
  const sent: number[] = [];
  const vnc = { _sendEncodings: vi.fn(function (this: object) { expect(this).toBe(vnc); sent.push(1); }) };
  const other = { _sendEncodings: vi.fn() };
  const channel = { withMacCursorEncodings: vi.fn((send: () => void) => { sent.push(0); send(); sent.push(2); }) };
  configureMacVncCursor(vnc as unknown as RFB, channel as unknown as SecureVncChannel);
  vnc._sendEncodings(); expect(sent).toEqual([0, 1, 2]); expect(other._sendEncodings).not.toHaveBeenCalled();
});
