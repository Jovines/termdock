import type { Packet } from './packets.js';
import { TRANSFER_CHUNK_BYTES } from './transferWindow.js';

export const BINARY_RECORD_FLAG = 0x80000000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Negotiated file chunks avoid JSON/base64 expansion; the entire record,
 * including its stream id and kind, is still encrypted by Noise. */
export function binaryPacketBody(packet: Packet): Uint8Array | undefined {
  if (!(packet.bytes instanceof Uint8Array)) return;
  if (!['upload', 'chunk'].includes(packet.type)) throw new Error('Invalid binary record type');
  const id = encoder.encode(packet.id);
  if (!id.length || id.length > 128 || packet.bytes.length > TRANSFER_CHUNK_BYTES) throw new Error('Invalid binary record size');
  const result = new Uint8Array(2 + id.length + packet.bytes.length);
  result[0] = packet.type === 'upload' ? 1 : 2;
  result[1] = id.length;
  result.set(id, 2); result.set(packet.bytes, 2 + id.length);
  return result;
}

export function readBinaryPacket(body: Uint8Array): Packet {
  const kind = body[0], idLength = body[1];
  if (![1, 2].includes(kind) || !idLength || idLength > 128 || body.length < 2 + idLength
    || body.length - 2 - idLength > TRANSFER_CHUNK_BYTES) throw new Error('Invalid binary record');
  return { type: kind === 1 ? 'upload' : 'chunk', id: decoder.decode(body.subarray(2, 2 + idLength)), bytes: body.slice(2 + idLength) };
}
