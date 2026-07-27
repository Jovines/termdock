/**
 * Framed wire protocol between the termdock server and the pty-host daemon
 * over a Unix-domain socket. （架构移植自 tty7 daemon/protocol.rs，Apache-2.0）
 *
 * Frame layout: `[1B type][4B BE length][payload]`.
 * Per-channel payloads (DATA/INPUT/REPLAY) start with `[1B idLen][id utf8]`.
 * CONTROL payloads are a single JSON document.
 *
 * The host owns the PTYs and a bounded per-channel replay ring, and counts
 * output in *chars* (both sides count JS string length, so multibyte text
 * never desyncs the offset). Attach carries `since`; the host replays only
 * newer output, then live data.
 */

export const PTY_HOST_PROTOCOL_VERSION = 1;

export const FRAME_DATA = 0x01;    // host → server: live PTY output
export const FRAME_INPUT = 0x02;   // server → host: client keystrokes
export const FRAME_CONTROL = 0x03; // both ways: JSON control message
export const FRAME_REPLAY = 0x04;  // host → server: historical ring output

const HEADER_LEN = 5;
const MAX_FRAME = 4 * 1024 * 1024;

export type ControlOp =
  | { op: 'hello'; v: number }
  | { op: 'helloAck'; v: number; channels: HostChannelMeta[] }
  | { op: 'spawn'; id: string; spec: HostSpawnSpec }
  | { op: 'spawned'; id: string; ok: boolean; pid?: number; error?: string; offset: number }
  | { op: 'attach'; id: string; since: number }
  | { op: 'attached'; id: string; ok: boolean; error?: string }
  | { op: 'replayEnd'; id: string; offset: number }
  | { op: 'resize'; id: string; cols: number; rows: number }
  | { op: 'kill'; id: string }
  | { op: 'exit'; id: string; exitCode: number; signal: number | null; offset: number }
  | { op: 'pause'; id: string }
  | { op: 'resume'; id: string }
  | { op: 'pong'; t: number };

export interface HostSpawnSpec {
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
  termName: string;
}

export interface HostChannelMeta {
  id: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  pid: number | null;
  startedAt: number;
  exited: boolean;
  exitCode: number | null;
  /** Total chars the PTY has written (the attach `since` ceiling). */
  offset: number;
}

export function encodeDataFrame(type: typeof FRAME_DATA | typeof FRAME_INPUT | typeof FRAME_REPLAY, id: string, data: string): Buffer {
  const idBuf = Buffer.from(id, 'utf8');
  if (idBuf.length > 255) throw new Error('channel id too long');
  const dataBuf = Buffer.from(data, 'utf8');
  const frame = Buffer.allocUnsafe(HEADER_LEN + 1 + idBuf.length + dataBuf.length);
  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(1 + idBuf.length + dataBuf.length, 1);
  frame.writeUInt8(idBuf.length, HEADER_LEN);
  idBuf.copy(frame, HEADER_LEN + 1);
  dataBuf.copy(frame, HEADER_LEN + 1 + idBuf.length);
  return frame;
}

export function encodeControl(msg: ControlOp): Buffer {
  const json = Buffer.from(JSON.stringify(msg), 'utf8');
  const frame = Buffer.allocUnsafe(HEADER_LEN + json.length);
  frame.writeUInt8(FRAME_CONTROL, 0);
  frame.writeUInt32BE(json.length, 1);
  json.copy(frame, HEADER_LEN);
  return frame;
}

export interface DecodedFrame {
  type: number;
  id: string | null;
  data: string | null;
  control: ControlOp | null;
}

/** Incremental frame decoder: feed chunks, drain complete frames. */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  feed(chunk: Buffer): DecodedFrame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: DecodedFrame[] = [];
    for (;;) {
      if (this.buf.length < HEADER_LEN) break;
      const type = this.buf.readUInt8(0);
      const len = this.buf.readUInt32BE(1);
      if (len > MAX_FRAME) {
        // Desync guard: drop everything, let the connection reset.
        this.buf = Buffer.alloc(0);
        break;
      }
      if (this.buf.length < HEADER_LEN + len) break;
      const payload = this.buf.subarray(HEADER_LEN, HEADER_LEN + len);
      this.buf = this.buf.subarray(HEADER_LEN + len);

      if (type === FRAME_CONTROL) {
        try {
          out.push({ type, id: null, data: null, control: JSON.parse(payload.toString('utf8')) as ControlOp });
        } catch { /* malformed control frame: skip */ }
        continue;
      }
      if (type === FRAME_DATA || type === FRAME_INPUT || type === FRAME_REPLAY) {
        const idLen = payload.readUInt8(0);
        const id = payload.subarray(1, 1 + idLen).toString('utf8');
        const data = payload.subarray(1 + idLen).toString('utf8');
        out.push({ type, id, data, control: null });
        continue;
      }
      // Unknown frame type: skip payload (forward compatibility).
    }
    return out;
  }
}
