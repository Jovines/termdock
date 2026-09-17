import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import net from 'node:net';
import { delimiter, dirname, join } from 'node:path';
import { randomInt } from 'node:crypto';
import { adbSearchPath, resolveAdbBinary } from './adb.js';

const DEVICE_NAME_LENGTH = 64;
const VIDEO_HEADER_LENGTH = 12;
const FRAME_HEADER_LENGTH = 12;
const CONNECT_TIMEOUT_MS = 12_000;

export type ScrcpyVideoCodec = 'h264' | 'h265' | 'av1';
const CODEC_IDS: Record<number, ScrcpyVideoCodec> = {
  0x68323634: 'h264',
  0x68323635: 'h265',
  0x00617631: 'av1',
};

export interface ScrcpyVideoHeader { codec: ScrcpyVideoCodec; width: number; height: number; deviceName: string }
export interface ScrcpyFrame { config: boolean; keyFrame: boolean; pts: bigint; data: Buffer }
export interface ScrcpySessionEvents {
  onHeader: (header: ScrcpyVideoHeader) => void;
  onFrame: (frame: ScrcpyFrame) => void;
  onError: (error: Error) => void;
  onClose: () => void;
}
export interface ScrcpyStartOptions { maxSize?: number; maxFps?: number; videoBitRate?: number }

interface ScrcpyBinaries { bin: string; serverJar: string; version: string }

function scrcpyExecutableCandidates(): string[] {
  const override = process.env.TERMDOCK_SCRCPY_BIN;
  const candidates: string[] = [];
  if (override) candidates.push(override);
  const names = process.platform === 'win32' ? ['scrcpy.exe', 'scrcpy'] : ['scrcpy'];
  // 用平台路径分隔符切分；Windows 盘符里的 ':' 在正斜杠分隔下会出错。
  for (const dir of adbSearchPath().split(delimiter).filter(Boolean)) {
    for (const name of names) candidates.push(join(dir, name));
  }
  return candidates;
}

function resolveScrcpyBin(): string | null {
  for (const candidate of scrcpyExecutableCandidates()) if (existsSync(candidate)) return candidate;
  return null;
}

function serverJarCandidates(bin: string): string[] {
  const candidates: string[] = [process.env.TERMDOCK_SCRCPY_SERVER || ''];
  if (bin !== 'scrcpy') {
    let resolved = bin;
    try { resolved = realpathSync(bin); } catch { /* keep original path */ }
    const dir = dirname(resolved);
    candidates.push(join(dir, 'scrcpy-server'));
    candidates.push(join(dir, '..', 'share', 'scrcpy', 'scrcpy-server'));
  }
  candidates.push('/usr/local/share/scrcpy/scrcpy-server');
  candidates.push('/usr/share/scrcpy/scrcpy-server');
  candidates.push('/opt/homebrew/share/scrcpy/scrcpy-server');
  return candidates.filter(Boolean);
}

let cachedBinaries: ScrcpyBinaries | null | undefined;

function runCapture(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: adbSearchPath() } });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('SCRCPY_PROBE_TIMEOUT')); }, timeout);
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 || out.trim()) resolve(out.trim() || err.trim());
      else reject(new Error(err.trim() || `SCRCPY_PROBE_FAILED_${code}`));
    });
  });
}

/** 定位 scrcpy 客户端与随包 scrcpy-server，并从 `scrcpy --version` 取协议版本。 */
export async function resolveScrcpyBinaries(): Promise<ScrcpyBinaries> {
  if (cachedBinaries !== undefined) {
    if (!cachedBinaries) throw new Error('SCRCPY_NOT_FOUND');
    return cachedBinaries;
  }
  // 找不到绝对路径时退回 PATH 解析（安装包可能把 scrcpy 放在非常规目录）。
  const bin = resolveScrcpyBin() ?? 'scrcpy';
  const serverJar = serverJarCandidates(bin).find(candidate => existsSync(candidate));
  if (!serverJar) { cachedBinaries = null; throw new Error('SCRCPY_SERVER_NOT_FOUND'); }
  let version = '';
  try {
    const output = await runCapture(bin, ['--version'], 6000);
    version = /^scrcpy\s+([0-9][^\s]*)/m.exec(output)?.[1] ?? '';
  } catch { version = ''; }
  if (!version) { cachedBinaries = null; throw new Error('SCRCPY_VERSION_UNKNOWN'); }
  cachedBinaries = { bin, serverJar, version };
  return cachedBinaries;
}

function remoteJarPath(version: string): string {
  return `/data/local/tmp/termdock-scrcpy-server-${version}.jar`;
}

function adbBinary(): string {
  const binary = resolveAdbBinary();
  if (!binary) throw new Error('ADB_NOT_FOUND');
  return binary;
}

function runAdbCapture(args: string[], timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(adbBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: adbSearchPath() } });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ADB_TIMEOUT')); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error((err || out).trim() || `ADB_FAILED_${code}`));
    });
  });
}

function scidHex(scid: number): string {
  return scid.toString(16).padStart(8, '0');
}

/** 单设备的一条 scrcpy 会话：推送 server → adb reverse → 启动 server → 解析 H.264/H.265 流。 */
export class ScrcpySession {
  private readonly scid = randomInt(1, 0x7fffffff);
  private child: ChildProcess | null = null;
  private server: net.Server | null = null;
  private videoSocket: net.Socket | null = null;
  private controlSocket: net.Socket | null = null;
  private videoBuffer = Buffer.alloc(0);
  private controlBuffer = Buffer.alloc(0);
  private videoStage: 'meta' | 'codec' | 'frames' = 'meta';
  private port = 0;
  private stopped = false;
  private started = false;
  private deviceName = '';
  private resolveHeader: (() => void) | null = null;
  private readonly logLines: string[] = [];

  constructor(
    private readonly serial: string,
    private readonly events: ScrcpySessionEvents,
    private readonly options: ScrcpyStartOptions = {},
  ) {}

  get running(): boolean { return this.started && !this.stopped; }

  private log(line: string): void {
    const text = line.trim();
    if (!text) return;
    this.logLines.push(text);
    if (this.logLines.length > 40) this.logLines.shift();
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.events.onError(error);
    void this.stop();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      const { serverJar, version } = await resolveScrcpyBinaries();
      const remoteJar = remoteJarPath(version);
      await runAdbCapture(['-s', this.serial, 'push', serverJar, remoteJar], 60_000);

      const server = net.createServer();
      this.server = server;
      server.on('connection', socket => this.acceptSocket(socket));
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { this.port = (server.address() as net.AddressInfo).port; resolve(); });
      });

      await runAdbCapture(['-s', this.serial, 'reverse', `localabstract:scrcpy_${scidHex(this.scid)}`, `tcp:${this.port}`], 15_000);

      const args = [
        '-s', this.serial, 'shell',
        `CLASSPATH=${remoteJar}`,
        'app_process', '/',
        'com.genymobile.scrcpy.Server', version,
        `scid=${this.scid.toString(16)}`,
        'log_level=info',
        'audio=false',
        'control=true',
        'tunnel_forward=false',
        'power_on=true',
        'stay_awake=true',
        'clipboard_autosync=false',
        `max_size=${this.options.maxSize ?? 1600}`,
        `video_bit_rate=${this.options.videoBitRate ?? 8_000_000}`,
      ];
      if (this.options.maxFps && this.options.maxFps > 0) args.push(`max_fps=${this.options.maxFps}`);

      const child = spawn(adbBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: adbSearchPath() } });
      this.child = child;
      child.stdout?.on('data', chunk => this.log(String(chunk).replace(/^\[server\]\s*/, '')));
      child.stderr?.on('data', chunk => this.log(String(chunk)));
      child.on('error', error => this.fail(error instanceof Error ? error : new Error('SCRCPY_SPAWN_FAILED')));
      child.on('close', () => { if (!this.stopped) this.fail(new Error(this.logLines.at(-1) || 'SCRCPY_SERVER_EXITED')); });

      await this.waitForHeader();
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error('SCRCPY_START_FAILED');
      if (!this.stopped) this.fail(normalized);
      throw normalized;
    }
  }

  private waitForHeader(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.resolveHeader = null; reject(new Error('SCRCPY_CONNECT_TIMEOUT')); }, CONNECT_TIMEOUT_MS);
      this.resolveHeader = () => { clearTimeout(timer); this.resolveHeader = null; resolve(); };
    });
  }

  private acceptSocket(socket: net.Socket): void {
    socket.setNoDelay(true);
    if (!this.videoSocket) {
      this.videoSocket = socket;
      socket.on('data', chunk => this.readVideo(chunk));
      socket.on('error', error => this.fail(error instanceof Error ? error : new Error('VIDEO_SOCKET_ERROR')));
      socket.on('close', () => { if (!this.stopped) this.fail(new Error(this.logLines.at(-1) || 'VIDEO_SOCKET_CLOSED')); });
      return;
    }
    if (!this.controlSocket) {
      this.controlSocket = socket;
      // 控制通道会回传剪贴板/ACK 等设备消息；v1 只消费，避免读缓冲堆积。
      socket.on('data', chunk => this.readControl(chunk));
      socket.on('error', () => { /* 控制通道异常由视频通道统一收敛 */ });
      return;
    }
    socket.destroy();
  }

  private readVideo(chunk: Buffer): void {
    if (this.stopped) return;
    this.videoBuffer = Buffer.concat([this.videoBuffer, chunk]);
    if (this.videoStage === 'meta') {
      if (this.videoBuffer.length < DEVICE_NAME_LENGTH) return;
      this.deviceName = this.videoBuffer.subarray(0, DEVICE_NAME_LENGTH).toString('utf8').replace(/\0+$/, '');
      this.videoBuffer = this.videoBuffer.subarray(DEVICE_NAME_LENGTH);
      this.videoStage = 'codec';
    }
    if (this.videoStage === 'codec') {
      if (this.videoBuffer.length < VIDEO_HEADER_LENGTH) return;
      const codec = CODEC_IDS[this.videoBuffer.readUInt32BE(0)];
      const width = this.videoBuffer.readUInt32BE(4);
      const height = this.videoBuffer.readUInt32BE(8);
      this.videoBuffer = this.videoBuffer.subarray(VIDEO_HEADER_LENGTH);
      this.videoStage = 'frames';
      if (!codec) { this.fail(new Error('SCRCPY_UNSUPPORTED_CODEC')); return; }
      this.events.onHeader({ codec, width, height, deviceName: this.deviceName || this.serial });
      this.resolveHeader?.();
    }
    while (this.videoStage === 'frames' && this.videoBuffer.length >= FRAME_HEADER_LENGTH) {
      const ptsFlags = this.videoBuffer.readBigUInt64BE(0);
      const size = this.videoBuffer.readUInt32BE(8);
      if (this.videoBuffer.length < FRAME_HEADER_LENGTH + size) break;
      const payload = Buffer.from(this.videoBuffer.subarray(FRAME_HEADER_LENGTH, FRAME_HEADER_LENGTH + size));
      this.videoBuffer = this.videoBuffer.subarray(FRAME_HEADER_LENGTH + size);
      const config = ((ptsFlags >> 63n) & 1n) === 1n;
      const keyFrame = ((ptsFlags >> 62n) & 1n) === 1n;
      this.events.onFrame({ config, keyFrame, pts: ptsFlags & ((1n << 62n) - 1n), data: payload });
    }
  }

  private readControl(chunk: Buffer): void {
    this.controlBuffer = Buffer.concat([this.controlBuffer, chunk]);
    while (this.controlBuffer.length > 0) {
      const type = this.controlBuffer[0];
      if (type === 0) {
        if (this.controlBuffer.length < 5) return;
        const length = this.controlBuffer.readUInt32BE(1);
        if (this.controlBuffer.length < 5 + length) return;
        this.controlBuffer = this.controlBuffer.subarray(5 + length);
      } else if (type === 1) {
        if (this.controlBuffer.length < 9) return;
        this.controlBuffer = this.controlBuffer.subarray(9);
      } else {
        this.controlBuffer = Buffer.alloc(0);
        return;
      }
    }
  }

  /** 客户端消费不过来时暂停视频 socket：让内核缓冲填满，把反压传到设备端，
   * 从而在不丢帧的前提下限制延迟（丢 delta 会让参考帧链断裂、画面花屏）。 */
  pauseVideo(): void {
    if (this.videoPaused) return;
    this.videoPaused = true;
    try { this.videoSocket?.pause(); } catch { /* ignore */ }
  }

  resumeVideo(): void {
    if (!this.videoPaused) return;
    this.videoPaused = false;
    try { this.videoSocket?.resume(); } catch { /* ignore */ }
  }

  private videoPaused = false;

  sendControl(data: Buffer): boolean {
    const socket = this.controlSocket;
    if (!socket || socket.destroyed) return false;
    try { socket.write(data); return true; }
    catch { return false; }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    activeSessions.delete(this);
    const child = this.child;
    this.child = null;
    try { this.videoSocket?.destroy(); } catch { /* ignore */ }
    try { this.controlSocket?.destroy(); } catch { /* ignore */ }
    this.videoSocket = null;
    this.controlSocket = null;
    try { this.server?.close(); } catch { /* ignore */ }
    this.server = null;
    if (child) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
    try { await runAdbCapture(['-s', this.serial, 'reverse', '--remove', `localabstract:scrcpy_${scidHex(this.scid)}`], 8000); }
    catch { /* reverse 可能已随进程退出被清理 */ }
    this.events.onClose();
  }
}

const activeSessions = new Set<ScrcpySession>();

export function createScrcpySession(serial: string, events: ScrcpySessionEvents, options?: ScrcpyStartOptions): ScrcpySession {
  const session = new ScrcpySession(serial, events, options);
  activeSessions.add(session);
  return session;
}

export async function stopAllScrcpySessions(): Promise<void> {
  await Promise.all([...activeSessions].map(session => session.stop()));
}
