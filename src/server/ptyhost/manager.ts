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
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT'
        && (error as NodeJS.ErrnoException).code !== 'ECONNREFUSED') {
        throw error;
      }
    }
    this.spawnHostDaemon();
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
      const onError = (error: Error) => {
        conn.destroy();
        rejectPromise(error);
      };
      conn.once('error', onError);
      conn.once('connect', () => {
        conn.removeListener('error', onError);
        this.attachConnection(conn);
        this.helloResolve = resolvePromise;
        conn.write(encodeControl({ op: 'hello', v: PTY_HOST_PROTOCOL_VERSION }));
      });
    });
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
    const spawned = new Promise<{ pid: number | undefined; offset: number }>((resolvePromise, rejectPromise) => {
      this.pendingSpawns.set(id, { resolve: resolvePromise, reject: rejectPromise });
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
