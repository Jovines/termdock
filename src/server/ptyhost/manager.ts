/**
 * Server-side client of the pty-host daemon: connection lifecycle (auto-spawn,
 * reconnect with delta replay) and `PtyHostClient`, a drop-in `PtyProcess`
 * whose PTY lives in the host process. （架构移植自 tty7 spawn.rs + remote.rs）
 *
 * Shell-mode sessions spawned through this manager survive server restarts:
 * the host holds the PTYs and a replay ring; on startup the server adopts the
 * live channels and rebuilds history/OSC state from the ring.
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
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
} from './protocol.js';

/** How long to wait for a freshly spawned host to start listening. */
const HOST_STARTUP_TIMEOUT_MS = 5_000;
const HOST_STARTUP_POLL_MS = 50;
const RECONNECT_DELAY_MS = 500;
/** connect + helloAck 的总等待上限。host 活着但 wedge（内核 backlog 收下
 * 连接、事件循环不回包）时，没有这个上限 promise 会永不 settle——且
 * ensureConnected 的 connecting 锁存器会让之后所有调用挂在同一个
 * promise 上，表现为"一次卡住、之后全部卡住"。 */
const CONNECT_HANDSHAKE_TIMEOUT_MS = 4_000;
/** spawn 发出后等 host 回 spawned 的上限。 */
const SPAWN_RESPONSE_TIMEOUT_MS = 10_000;
/** 心跳：连续 HEARTBEAT_MISS_LIMIT 个间隔没有 pong 判定 host wedge。 */
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_MISS_LIMIT = 2;

function hostSocketDir(): string {
  return path.join(os.homedir(), '.termdock', 'pty-hosts');
}

/**
 * One host per server instance: dev and prod servers get separate daemons
 * (and separate session sets) by keying the socket on the server port.
 */
export function ptyHostSocketPath(): string {
  const key = process.env.TERMDOCK_PTY_HOST_KEY ?? `port-${process.env.PORT ?? '9834'}`;
  return path.join(hostSocketDir(), `${key}.sock`);
}

/** The built host entry. Under tsx dev only the .ts source exists — spawn it
 *  through tsx in that case. */
function resolveHostEntry(): { command: string; args: string[] } {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const js = path.resolve(here, '..', 'ptyHost.js');
  if (fs.existsSync(js)) {
    return { command: process.execPath, args: [js, '--socket', ptyHostSocketPath()] };
  }
  const ts = path.resolve(here, '..', 'ptyHost.ts');
  // Dev: run through tsx (available as a devDependency).
  return { command: process.execPath, args: ['--import', 'tsx', ts, '--socket', ptyHostSocketPath()] };
}

type DataHandler = (data: string) => void;
type ExitHandler = (event: { exitCode: number; signal: number | null }) => void;

/**
 * A `PtyProcess` whose PTY lives in the host. Emits live data via onData;
 * the *initial* attach's replay is emitted via onReplay (history rebuild),
 * while reconnect replays (genuinely missed output) go to onData.
 */
export class PtyHostClient {
  pid: number | undefined;
  /** Char offset of host output seen so far (drives delta re-attach). */
  seenOffset = 0;

  private manager: PtyHostManager;
  private channelId: string;
  private dataHandlers = new Set<DataHandler>();
  private replayHandlers = new Set<DataHandler>();
  private exitHandlers = new Set<ExitHandler>();
  private hasAttachedOnce = false;
  private exited = false;

  constructor(manager: PtyHostManager, channelId: string) {
    this.manager = manager;
    this.channelId = channelId;
  }

  get id(): string {
    return this.channelId;
  }

  onData(handler: DataHandler): { dispose: () => void } {
    this.dataHandlers.add(handler);
    return { dispose: () => this.dataHandlers.delete(handler) };
  }

  onReplay(handler: DataHandler): { dispose: () => void } {
    this.replayHandlers.add(handler);
    return { dispose: () => this.replayHandlers.delete(handler) };
  }

  onExit(handler: ExitHandler): { dispose: () => void } {
    this.exitHandlers.add(handler);
    return { dispose: () => this.exitHandlers.delete(handler) };
  }

  write(data: string): void {
    if (this.exited) return;
    this.manager.sendRaw(encodeDataFrame(FRAME_INPUT, this.channelId, data));
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    this.manager.send({ op: 'resize', id: this.channelId, cols, rows });
  }

  kill(): void {
    if (this.exited) return;
    this.manager.send({ op: 'kill', id: this.channelId });
  }

  pause(): void {
    if (this.exited) return;
    this.manager.send({ op: 'pause', id: this.channelId });
  }

  resume(): void {
    if (this.exited) return;
    this.manager.send({ op: 'resume', id: this.channelId });
  }

  // -- manager-facing frame handlers --

  handleLiveData(data: string): void {
    this.seenOffset += data.length;
    for (const h of this.dataHandlers) h(data);
  }

  handleReplayData(data: string): void {
    this.seenOffset += data.length;
    if (this.hasAttachedOnce) {
      // Reconnect delta: genuinely missed output — normal path.
      for (const h of this.dataHandlers) h(data);
    } else {
      // Initial adoption replay: history rebuild only.
      for (const h of this.replayHandlers) h(data);
    }
  }

  handleReplayEnd(offset: number): void {
    this.seenOffset = Math.max(this.seenOffset, offset);
    this.hasAttachedOnce = true;
  }

  handleExit(exitCode: number, signal: number | null, offset: number): void {
    if (this.exited) return;
    this.exited = true;
    this.seenOffset = Math.max(this.seenOffset, offset);
    for (const h of this.exitHandlers) h({ exitCode, signal });
  }

  get isExited(): boolean {
    return this.exited;
  }
}

export class PtyHostManager {
  private conn: net.Socket | null = null;
  private decoder = new FrameDecoder();
  private clients = new Map<string, PtyHostClient>();
  private connecting: Promise<HostChannelMeta[]> | null = null;
  private helloResolve: ((channels: HostChannelMeta[]) => void) | null = null;
  private pendingSpawns = new Map<string, {
    resolve: (result: { pid: number | undefined; offset: number }) => void;
    reject: (error: Error) => void;
  }>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;
  private killingWedgedHost: Promise<void> | null = null;
  private stopped = false;

  /** Resolve when the host is connected + handshaken; returns live channels. */
  ensureConnected(): Promise<HostChannelMeta[]> {
    if (this.connecting) return this.connecting;
    this.connecting = this.connectWithSpawnRetry()
      .finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async connectWithSpawnRetry(): Promise<HostChannelMeta[]> {
    try {
      return await this.connectOnce();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ECONNREFUSED') {
        this.spawnHostDaemon();
      } else if (code === 'PTY_HOST_HANDSHAKE_TIMEOUT') {
        // host 活着但 wedge（accept 连接不回 helloAck）：杀掉再重生。
        console.warn('[pty-host] handshake timed out — replacing wedged host:', ptyHostSocketPath());
        await this.killWedgedHost();
        this.spawnHostDaemon();
      } else {
        throw error;
      }
    }
    const deadline = Date.now() + HOST_STARTUP_TIMEOUT_MS;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, HOST_STARTUP_POLL_MS));
      try {
        return await this.connectOnce();
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`pty-host did not start listening in time: ${(lastError as Error)?.message ?? lastError}`);
  }

  /** 杀掉 wedge 的 host（SIGTERM → 1s 后 SIGKILL）并清理 socket/pid 文件。
   * 等旧 host 确实死了才返回——否则旧 host 的 SIGTERM shutdown 可能删掉
   * 新 host 刚 bind 的 socket 文件。并发调用共享同一次 kill。 */
  private killWedgedHost(): Promise<void> {
    if (!this.killingWedgedHost) {
      this.killingWedgedHost = this.doKillWedgedHost().finally(() => {
        this.killingWedgedHost = null;
      });
    }
    return this.killingWedgedHost;
  }

  private async doKillWedgedHost(): Promise<void> {
    const sockPath = ptyHostSocketPath();
    const pidPath = `${sockPath}.pid`;
    let pid: number | null = null;
    try {
      const parsed = Number(fs.readFileSync(pidPath, 'utf8').trim());
      if (Number.isInteger(parsed) && parsed > 1) pid = parsed;
    } catch { /* 无 pid 文件（host 早于该特性）——只能放弃精准击杀 */ }

    if (pid) {
      const alive = () => {
        try {
          process.kill(pid!, 0);
          return true;
        } catch {
          return false;
        }
      };
      console.warn(`[pty-host] killing wedged host (pid ${pid})`);
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      let deadline = Date.now() + 1_000;
      while (alive() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (alive()) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        deadline = Date.now() + 1_000;
        while (alive() && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    }
    try { fs.unlinkSync(sockPath); } catch { /* gone */ }
    try { fs.unlinkSync(pidPath); } catch { /* gone */ }
  }

  private spawnHostDaemon(): void {
    const { command, args } = resolveHostEntry();
    fs.mkdirSync(hostSocketDir(), { recursive: true, mode: 0o700 });
    // Detached + own session + ignored stdio + never waited on: the host
    // must not die with (or be reaped by) this server.
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    console.log(`[pty-host] spawned host daemon (pid ${child.pid})`);
  }

  private connectOnce(): Promise<HostChannelMeta[]> {
    return new Promise((resolvePromise, rejectPromise) => {
      const conn = net.createConnection(ptyHostSocketPath());
      const timer = setTimeout(() => {
        const error = new Error('pty-host handshake timed out') as NodeJS.ErrnoException;
        error.code = 'PTY_HOST_HANDSHAKE_TIMEOUT';
        conn.destroy();
        rejectPromise(error);
      }, CONNECT_HANDSHAKE_TIMEOUT_MS);
      const onError = (error: Error) => {
        clearTimeout(timer);
        conn.destroy();
        rejectPromise(error);
      };
      conn.once('error', onError);
      conn.once('connect', () => {
        conn.removeListener('error', onError);
        this.attachConnection(conn);
        this.helloResolve = (channels) => {
          clearTimeout(timer);
          // handleDisconnect 会用 [] 兜底调用这里——连接已死时不开心跳。
          if (this.conn === conn && !conn.destroyed) this.startHeartbeat();
          resolvePromise(channels);
        };
        conn.write(encodeControl({ op: 'hello', v: PTY_HOST_PROTOCOL_VERSION }));
      });
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (!this.conn || this.conn.destroyed) {
        this.stopHeartbeat();
        return;
      }
      if (Date.now() - this.lastPongAt > HEARTBEAT_INTERVAL_MS * HEARTBEAT_MISS_LIMIT) {
        // host 事件循环 wedge：杀旧 host（新 host 由重连路径 respawn）。
        console.warn('[pty-host] heartbeat missed — host appears wedged, replacing it:', ptyHostSocketPath());
        this.stopHeartbeat();
        this.conn.destroy();
        void this.killWedgedHost();
        return;
      }
      this.send({ op: 'ping', t: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private attachConnection(conn: net.Socket): void {
    if (this.conn && !this.conn.destroyed) this.conn.destroy();
    this.conn = conn;
    this.decoder = new FrameDecoder();

    conn.on('data', (chunk: Buffer) => {
      for (const frame of this.decoder.feed(chunk)) {
        try {
          this.handleFrame(frame.type, frame.id, frame.data, frame.control);
        } catch (error) {
          console.warn('[pty-host] frame handling error:', (error as Error).message);
        }
      }
    });
    conn.on('close', () => {
      if (this.conn !== conn) return;
      this.conn = null;
      this.handleDisconnect();
    });
    conn.on('error', () => { /* close follows */ });
  }

  private handleFrame(type: number, id: string | null, data: string | null, control: ControlOp | null): void {
    if (type === FRAME_DATA && id && data !== null) {
      this.clients.get(id)?.handleLiveData(data);
      return;
    }
    if (type === FRAME_REPLAY && id && data !== null) {
      this.clients.get(id)?.handleReplayData(data);
      return;
    }
    if (type !== FRAME_CONTROL || !control) return;

    switch (control.op) {
      case 'helloAck': {
        if (control.v !== PTY_HOST_PROTOCOL_VERSION) {
          console.warn(`[pty-host] protocol mismatch: host v${control.v}, server v${PTY_HOST_PROTOCOL_VERSION} — continuing best-effort`);
        }
        this.helloResolve?.(control.channels);
        this.helloResolve = null;
        return;
      }
      case 'spawned': {
        const pending = this.pendingSpawns.get(control.id);
        this.pendingSpawns.delete(control.id);
        if (!pending) return;
        if (control.ok) {
          pending.resolve({ pid: control.pid, offset: control.offset });
        } else {
          pending.reject(new Error(control.error ?? 'pty-host spawn failed'));
        }
        return;
      }
      case 'replayEnd':
        this.clients.get(control.id)?.handleReplayEnd(control.offset);
        return;
      case 'pong':
        this.lastPongAt = Date.now();
        return;
      case 'exit': {
        const client = this.clients.get(control.id);
        if (client) {
          client.handleExit(control.exitCode, control.signal, control.offset);
        }
        return;
      }
      default:
        return;
    }
  }

  private handleDisconnect(): void {
    this.stopHeartbeat();
    this.helloResolve?.([]);
    this.helloResolve = null;
    for (const pending of this.pendingSpawns.values()) {
      pending.reject(new Error('pty-host connection dropped'));
    }
    this.pendingSpawns.clear();

    if (this.stopped) return;
    if (this.clients.size === 0) return; // nothing to lose; reconnect lazily

    // The host may have died (taking every PTY with it) or be mid-restart
    // itself. Probe: quick reconnect; if the socket is gone for good, declare
    // the channels dead so sessions clean up like a PTY exit today.
    const probe = async () => {
      try {
        const channels = await this.ensureConnected();
        const live = new Set(channels.map((c) => c.id));
        for (const [id, client] of this.clients) {
          if (client.isExited) continue;
          if (live.has(id)) {
            // Re-attach with delta replay for the gap.
            this.send({ op: 'attach', id, since: client.seenOffset });
          } else {
            // Channel vanished with the host: surface as an exit.
            client.handleExit(-1, null, client.seenOffset);
          }
        }
      } catch {
        // Host is down for good: all live channels died with it.
        for (const client of this.clients.values()) {
          if (!client.isExited) client.handleExit(-1, null, client.seenOffset);
        }
      }
    };
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { void probe(); }, RECONNECT_DELAY_MS);
  }

  send(msg: ControlOp): void {
    if (this.conn && !this.conn.destroyed) {
      this.conn.write(encodeControl(msg));
    }
  }

  sendRaw(frame: Buffer): void {
    if (this.conn && !this.conn.destroyed) {
      this.conn.write(frame);
    }
  }

  /**
   * Spawn a new channel and return its client (attached, replay complete).
   * Rejects when the host can't spawn the PTY (bad shell, OOM, …).
   */
  async spawnChannel(id: string, spec: HostSpawnSpec): Promise<PtyHostClient> {
    await this.ensureConnected();
    const client = new PtyHostClient(this, id);
    this.clients.set(id, client);
    let spawnTimer: ReturnType<typeof setTimeout> | null = null;
    const spawned = new Promise<{ pid: number | undefined; offset: number }>((resolvePromise, rejectPromise) => {
      // host wedge 时 spawned 永远不会来——必须有超时，否则这里永挂。
      spawnTimer = setTimeout(() => {
        const error = new Error('pty-host spawn timed out') as NodeJS.ErrnoException;
        error.code = 'PTY_HOST_SPAWN_TIMEOUT';
        rejectPromise(error);
      }, SPAWN_RESPONSE_TIMEOUT_MS);
      this.pendingSpawns.set(id, {
        resolve: (result) => {
          if (spawnTimer) clearTimeout(spawnTimer);
          resolvePromise(result);
        },
        reject: (error) => {
          if (spawnTimer) clearTimeout(spawnTimer);
          rejectPromise(error);
        },
      });
    });
    this.send({ op: 'spawn', id, spec });
    try {
      const { pid, offset } = await spawned;
      client.pid = pid;
      client.seenOffset = offset;
      // Attach from the spawn offset: a fresh channel has nothing to replay,
      // but the attach registers live delivery on the host side too.
      this.send({ op: 'attach', id, since: offset });
      return client;
    } catch (error) {
      this.clients.delete(id);
      this.pendingSpawns.delete(id);
      // spawn 超时 ≈ host wedge：断连触发 handleDisconnect 的自愈重连。
      if ((error as NodeJS.ErrnoException).code === 'PTY_HOST_SPAWN_TIMEOUT') {
        console.warn('[pty-host] spawn timed out — host may be wedged, dropping connection:', ptyHostSocketPath());
        this.conn?.destroy();
      }
      throw error;
    }
  }

  /**
   * Adopt every live channel the host reports (server startup). Returns the
   * channel metas with attached clients; replay frames arrive right after
   * (register onReplay handlers synchronously).
   */
  async adoptChannels(): Promise<Array<{ meta: HostChannelMeta; client: PtyHostClient }>> {
    // No socket, no survivors — don't spawn an idle host just to learn that.
    if (!fs.existsSync(ptyHostSocketPath())) return [];
    let channels: HostChannelMeta[];
    try {
      channels = await this.ensureConnected();
    } catch (error) {
      console.warn('[pty-host] adoption skipped: cannot reach host:', (error as Error).message);
      return [];
    }
    const adopted: Array<{ meta: HostChannelMeta; client: PtyHostClient }> = [];
    for (const meta of channels) {
      if (meta.exited) continue;
      let client = this.clients.get(meta.id);
      if (!client) {
        client = new PtyHostClient(this, meta.id);
        this.clients.set(meta.id, client);
      }
      client.pid = meta.pid ?? undefined;
      adopted.push({ meta, client });
      this.send({ op: 'attach', id: meta.id, since: client.seenOffset });
    }
    return adopted;
  }
}

let managerSingleton: PtyHostManager | null = null;

export function getPtyHostManager(): PtyHostManager {
  if (!managerSingleton) {
    managerSingleton = new PtyHostManager();
  }
  return managerSingleton;
}
