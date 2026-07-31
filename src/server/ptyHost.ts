#!/usr/bin/env node
/**
 * termdock pty-host daemon — owns shell-mode PTYs outside the server process,
 * so sessions survive server restarts/crashes/deploys. （架构移植自 tty7 的
 * persistent daemon，Apache-2.0；单进程多 channel 复用版）
 *
 * The server auto-spawns this process detached and talks to it over a
 * Unix-domain socket (see ptyhost/protocol.ts). One host holds *all* of one
 * server instance's shell sessions (channels), keeping a bounded replay ring
 * per channel so a reattaching server rebuilds scrollback + OSC state.
 *
 * Standalone entry: keep imports dependency-light (node-pty + protocol only).
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import type { IPty } from 'node-pty';
import {
  FRAME_CONTROL,
  FRAME_DATA,
  FRAME_INPUT,
  FRAME_REPLAY,
  PTY_HOST_PROTOCOL_VERSION,
  FrameDecoder,
  encodeControl,
  encodeDataFrame,
  type ControlOp,
  type HostChannelMeta,
  type HostSpawnSpec,
} from './ptyhost/protocol.js';

/** Bounded per-channel replay ring, in chars. */
const RING_CAP_CHARS = 256 * 1024;

interface Channel {
  id: string;
  spec: HostSpawnSpec;
  pty: IPty;
  /** Ring chunks with their absolute start offset (chars). */
  ring: Array<{ data: string; start: number }>;
  ringChars: number;
  /** Total chars the PTY has written. */
  offset: number;
  startedAt: number;
  exited: boolean;
  exitCode: number | null;
  exitSignal: number | null;
}

const channels = new Map<string, Channel>();
let serverConn: net.Socket | null = null;

function socketPathFromArgs(): string {
  const idx = process.argv.indexOf('--socket');
  const p = idx >= 0 ? process.argv[idx + 1] : undefined;
  if (!p) {
    console.error('[pty-host] missing --socket <path>');
    process.exit(2);
  }
  return p;
}

const SOCKET_PATH = socketPathFromArgs();

function send(msg: ControlOp): void {
  if (serverConn && !serverConn.destroyed) {
    serverConn.write(encodeControl(msg));
  }
}

function sendFrame(type: typeof FRAME_DATA | typeof FRAME_REPLAY, id: string, data: string): void {
  if (serverConn && !serverConn.destroyed) {
    serverConn.write(encodeDataFrame(type, id, data));
  }
}

function channelMeta(ch: Channel): HostChannelMeta {
  return {
    id: ch.id,
    shell: ch.spec.shell,
    cwd: ch.spec.cwd,
    cols: ch.spec.cols,
    rows: ch.spec.rows,
    pid: ch.pty.pid ?? null,
    startedAt: ch.startedAt,
    exited: ch.exited,
    exitCode: ch.exitCode,
    offset: ch.offset,
  };
}

function appendToRing(ch: Channel, data: string): void {
  const start = ch.offset;
  ch.offset += data.length;
  ch.ring.push({ data, start });
  ch.ringChars += data.length;
  while (ch.ringChars > RING_CAP_CHARS && ch.ring.length > 1) {
    const dropped = ch.ring.shift();
    if (dropped) ch.ringChars -= dropped.data.length;
  }
}

async function loadNodePty(): Promise<typeof import('node-pty')> {
  return await import('node-pty');
}

function spawnChannel(id: string, spec: HostSpawnSpec): void {
  if (channels.has(id)) {
    send({ op: 'spawned', id, ok: false, error: 'channel id already exists', offset: 0 });
    return;
  }
  void loadNodePty().then((pty) => {
    let proc: IPty;
    try {
      proc = pty.spawn(spec.shell, spec.args, {
        name: spec.termName,
        cols: spec.cols,
        rows: spec.rows,
        cwd: spec.cwd,
        env: spec.env,
      });
    } catch (error) {
      send({ op: 'spawned', id, ok: false, error: (error as Error).message, offset: 0 });
      return;
    }

    const ch: Channel = {
      id,
      spec,
      pty: proc,
      ring: [],
      ringChars: 0,
      offset: 0,
      startedAt: Date.now(),
      exited: false,
      exitCode: null,
      exitSignal: null,
    };
    channels.set(id, ch);

    proc.onData((data: string) => {
      appendToRing(ch, data);
      sendFrame(FRAME_DATA, id, data);
    });
    proc.onExit(({ exitCode, signal }) => {
      ch.exited = true;
      ch.exitCode = exitCode;
      ch.exitSignal = signal ?? null;
      send({ op: 'exit', id, exitCode, signal: signal ?? null, offset: ch.offset });
      // The channel's ring is the scrollback a reattaching server would want;
      // without a server there's no one to reattach, so exit the host when
      // nothing is left running.
      channels.delete(id);
      if (channels.size === 0 && !serverConn) shutdown();
    });

    send({ op: 'spawned', id, ok: true, pid: proc.pid, offset: 0 });
  }).catch((error) => {
    send({ op: 'spawned', id, ok: false, error: (error as Error).message, offset: 0 });
  });
}

function attachChannel(id: string, since: number): void {
  const ch = channels.get(id);
  if (!ch) {
    send({ op: 'attached', id, ok: false, error: 'no such channel' });
    return;
  }
  send({ op: 'attached', id, ok: true });
  // Replay ring chunks newer than `since` (char offsets, absolute).
  for (const chunk of ch.ring) {
    if (chunk.start + chunk.data.length <= since) continue;
    const sliceStart = Math.max(0, since - chunk.start);
    sendFrame(FRAME_REPLAY, id, chunk.data.slice(sliceStart));
  }
  send({ op: 'replayEnd', id, offset: ch.offset });
}

function handleControl(msg: ControlOp): void {
  switch (msg.op) {
    case 'hello':
      send({ op: 'helloAck', v: PTY_HOST_PROTOCOL_VERSION, channels: [...channels.values()].map(channelMeta) });
      return;
    case 'spawn':
      spawnChannel(msg.id, msg.spec);
      return;
    case 'attach':
      attachChannel(msg.id, msg.since);
      return;
    case 'ping':
      // 服务端心跳：host 事件循环活着就立即回 pong；连续不回 = wedge。
      send({ op: 'pong', t: msg.t });
      return;
    case 'resize': {
      const ch = channels.get(msg.id);
      if (ch && !ch.exited) {
        ch.spec.cols = msg.cols;
        ch.spec.rows = msg.rows;
        try { ch.pty.resize(msg.cols, msg.rows); } catch { /* pty raced exit */ }
      }
      return;
    }
    case 'kill': {
      const ch = channels.get(msg.id);
      if (ch && !ch.exited) {
        try { ch.pty.kill(); } catch { /* already gone */ }
      }
      return;
    }
    case 'pause': {
      const ch = channels.get(msg.id);
      if (ch && !ch.exited) {
        try { ch.pty.pause?.(); } catch { /* optional capability */ }
      }
      return;
    }
    case 'resume': {
      const ch = channels.get(msg.id);
      if (ch && !ch.exited) {
        try { ch.pty.resume?.(); } catch { /* optional capability */ }
      }
      return;
    }
    default:
      // attached/spawned/exit/replayEnd/pong are host→server; ignore here.
      return;
  }
}

function onServerConnection(conn: net.Socket): void {
  // Single client (the server). A second connection means the server
  // restarted its socket; drop the old one.
  if (serverConn && !serverConn.destroyed) {
    serverConn.destroy();
  }
  serverConn = conn;

  const decoder = new FrameDecoder();
  conn.on('data', (chunk: Buffer) => {
    for (const frame of decoder.feed(chunk)) {
      try {
        if (frame.type === FRAME_CONTROL && frame.control) {
          handleControl(frame.control);
        } else if (frame.type === FRAME_INPUT && frame.id && frame.data !== null) {
          const ch = channels.get(frame.id);
          if (ch && !ch.exited) {
            try { ch.pty.write(frame.data); } catch { /* pty raced exit */ }
          }
        }
      } catch (error) {
        console.error('[pty-host] frame handling error:', (error as Error).message);
      }
    }
  });
  conn.on('close', () => {
    if (serverConn === conn) serverConn = null;
  });
  conn.on('error', () => { /* server disappeared; close event follows */ });
}

function shutdown(): void {
  try { fs.unlinkSync(SOCKET_PATH); } catch { /* already gone */ }
  try { fs.unlinkSync(pidFilePath()); } catch { /* already gone */ }
  process.exit(0);
}

function pidFilePath(): string {
  return `${SOCKET_PATH}.pid`;
}

function main(): void {
  fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true, mode: 0o700 });
  // Stale socket from a crashed host: only our own pid could own it, and we
  // just started — remove and re-listen.
  try { fs.unlinkSync(SOCKET_PATH); } catch { /* not present */ }

  const server = net.createServer(onServerConnection);
  server.listen(SOCKET_PATH, () => {
    try { fs.chmodSync(SOCKET_PATH, 0o600); } catch { /* best effort */ }
    // 写 pid 文件：服务端检测到这个 host wedge（心跳超时）时需要知道
    // 杀谁——host 是 detached 的，pid 没法靠父子关系找回。
    try { fs.writeFileSync(pidFilePath(), String(process.pid), { mode: 0o600 }); } catch { /* best effort */ }
    console.log(`[pty-host] listening on ${SOCKET_PATH} (pid ${process.pid})`);
  });

  // The host is meant to run forever; a dropped server connection is normal
  // (server restart) and channels outlive it.
  process.on('SIGTERM', () => shutdown());
  process.on('SIGINT', () => shutdown());
}

main();
