import type RFB from '@novnc/novnc';
import type { SecureVncChannel } from './secureVncChannel';

const VMWARE_CURSOR = 0x574d5664;

/** Apple's VNC server can stop sending ALL cursor images when this extension
 * is advertised. Keep standard RichCursor and every other negotiated encoding.
 * https://github.com/novnc/noVNC/issues/1430 */
export function macVncCursorEncodings(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 2) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(2);
  if (bytes.length !== 4 + count * 4) return bytes;
  const kept: number[] = [];
  for (let offset = 4; offset < bytes.length; offset += 4) {
    const encoding = view.getInt32(offset);
    if (encoding !== VMWARE_CURSOR) kept.push(encoding);
  }
  if (kept.length === count) return bytes;
  const result = new Uint8Array(4 + kept.length * 4), output = new DataView(result.buffer);
  result.set(bytes.subarray(0, 2)); output.setUint16(2, kept.length);
  kept.forEach((encoding, index) => output.setInt32(4 + index * 4, encoding));
  return result;
}

/** noVNC 1.7 has no public encoding filter. Scope adaptation to this session's
 * synchronous SetEncodings call, never authentication or arbitrary VNC bytes. */
export function configureMacVncCursor(session: RFB, channel: SecureVncChannel): void {
  const vnc = session as unknown as { _sendEncodings(): void };
  const original = vnc._sendEncodings;
  vnc._sendEncodings = () => channel.withMacCursorEncodings(() => original.call(session));
}
