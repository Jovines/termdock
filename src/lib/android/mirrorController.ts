import { secureSocket } from '../federation/browserIntegration';
import { androidStreamPath, type AndroidQuality } from './api';
import {
  ANDROID_KEYCODE, BUTTON_PRIMARY, KEY_ACTION_DOWN, KEY_ACTION_UP, MOTION_ACTION_CANCEL, MOTION_ACTION_DOWN, MOTION_ACTION_MOVE,
  MOTION_ACTION_UP, POINTER_ID_FINGER, POINTER_ID_MOUSE, serializeBackOrScreenOn, serializeDisplayPower,
  serializeKeycode, serializeScroll, serializeSimple, serializeStartApp, serializeText, serializeTouch, toBase64, fromBase64,
  CONTROL_TYPE_COLLAPSE_PANELS, CONTROL_TYPE_EXPAND_NOTIFICATION_PANEL, CONTROL_TYPE_RESET_VIDEO,
  CONTROL_TYPE_ROTATE_DEVICE, type TouchPoint,
} from './control';

export type MirrorState = 'idle' | 'connecting' | 'streaming' | 'error';

export interface MirrorHeader { deviceName: string; codec: 'h264' | 'h265' | 'av1'; width: number; height: number }
export interface MirrorStats { fps: number; kbps: number; width: number; height: number; received: number; decoded: number; controls: number; last: string }
export interface MirrorCallbacks {
  onState: (state: MirrorState, error?: string) => void;
  onHeader: (header: MirrorHeader) => void;
  onStats: (stats: MirrorStats) => void;
  /** 客户端侧诊断（解码器不可用/配置失败等），用于在没有 devtools 的环境里定位问题。 */
  onWarning: (message: string) => void;
}

interface ServerMessage {
  type?: string;
  deviceName?: string;
  codec?: 'h264' | 'h265' | 'av1';
  width?: number;
  height?: number;
  seq?: number;
  config?: boolean;
  key?: boolean;
  pts?: string;
  data?: string;
  message?: string;
}

function hex(value: number): string {
  return value.toString(16).padStart(2, '0');
}

/** 从 Annex B 码流里取指定类型的 NAL（含 header 字节）。 */
function findNal(data: Uint8Array, wanted: number, hevc: boolean): Uint8Array | null {
  for (let index = 0; index + 4 < data.length; index++) {
    const isThreeByteStart = data[index] === 0 && data[index + 1] === 0 && data[index + 2] === 1;
    const isFourByteStart = data[index] === 0 && data[index + 1] === 0 && data[index + 2] === 0 && data[index + 3] === 1;
    const start = isFourByteStart ? index + 4 : isThreeByteStart ? index + 3 : -1;
    if (start < 0 || start >= data.length) continue;
    const type = hevc ? (data[start] >> 1) & 0x3f : data[start] & 0x1f;
    if (type !== wanted) { index = start - 1; continue; }
    let end = start + 1;
    while (end + 2 < data.length) {
      if (data[end] === 0 && data[end + 1] === 0 && (data[end + 2] === 1 || (data[end + 2] === 0 && data[end + 3] === 1))) break;
      end++;
    }
    return data.subarray(start, Math.min(data.length, end));
  }
  return null;
}

/** 用 SPS 反推精确的 avc1.PPCCLL；失败时退回通用 baseline。 */
function avcCodecString(config: Uint8Array | null): string {
  const sps = config ? findNal(config, 7, false) : null;
  if (sps && sps.length >= 4) return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
  return 'avc1.42e01e';
}

function hevcCodecString(config: Uint8Array | null): string {
  const vps = config ? findNal(config, 32, true) : null;
  if (vps && vps.length >= 13) {
    const profileSpace = (vps[1] >> 6) & 0x3;
    const profileIdc = vps[1] & 0x1f;
    const levelIdc = vps[12];
    return `hev1.${profileSpace}.${profileIdc}.L${levelIdc}.B0`;
  }
  return 'hev1.1.6.L120.B0';
}

export class AndroidMirrorController {
  private socket: WebSocket | null = null;
  private decoder: VideoDecoder | null = null;
  private configured = false;
  private configData: Uint8Array | null = null;
  private header: MirrorHeader | null = null;
  private closedByUser = false;
  private lastMessageAt = 0;
  private lastFrameAt = 0;
  private lastResetAt = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  /** 待并入下一个（关键）帧的 SPS/PPS：单独喂会被 Chrome 判为「非关键帧」而报错。 */
  private pendingConfig: Uint8Array | null = null;
  /** configure() 之后解码器必须先吃到一个真正的 IDR，否则 decode 会抛错。 */
  private needsKeyframe = false;
  private frameCount = 0;
  private receivedFrames = 0;
  private decodedFrames = 0;
  private controlsSent = 0;
  private lastSeq = 0;
  private lastType = '';
  private bytesSinceSample = 0;
  private warnedUnsupported = false;
  private lastSampleAt = 0;
  private serial = '';

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly callbacks: MirrorCallbacks,
  ) {}

  get currentHeader(): MirrorHeader | null { return this.header; }

  connect(serial: string, quality?: AndroidQuality): void {
    this.serial = serial;
    this.closedByUser = false;
    this.callbacks.onState('connecting');
    let socket: WebSocket;
    try { socket = secureSocket(androidStreamPath(serial, quality)); }
    catch (error) {
      this.callbacks.onState('error', error instanceof Error ? error.message : 'ANDROID_STREAM_FAILED');
      return;
    }
    this.socket = socket;
    socket.onopen = () => { this.lastMessageAt = Date.now(); };
    socket.onmessage = event => this.handleMessage(event.data);
    socket.onerror = () => { if (!this.closedByUser) this.callbacks.onState('error', 'SCRCPY_CONNECTION_LOST'); };
    socket.onclose = () => {
      this.teardownTimers();
      if (!this.closedByUser) this.callbacks.onState('error', 'SCRCPY_CONNECTION_CLOSED');
      else this.callbacks.onState('idle');
    };
    this.startTimers();
  }

  disconnect(): void {
    this.closedByUser = true;
    this.teardownTimers();
    try { this.decoder?.close(); } catch { /* already closed */ }
    this.decoder = null;
    this.configured = false;
    try { this.socket?.close(); } catch { /* already closed */ }
    this.socket = null;
    this.callbacks.onState('idle');
  }

  private teardownTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.heartbeat = null; this.statsTimer = null; this.stallTimer = null;
  }

  private startTimers(): void {
    this.lastSampleAt = Date.now();
    this.heartbeat = setInterval(() => {
      if (!this.socket || this.socket.readyState !== 1) return;
      if (Date.now() - this.lastMessageAt > 45_000) {
        try { this.socket.close(); } catch { /* ignore */ }
        return;
      }
      this.send({ type: 'ping' });
    }, 15_000);
    // 卡顿自愈：长时间收不到帧（解码器卡住/时序错位）时请求一次关键帧重置。
    this.stallTimer = setInterval(() => {
      if (!this.header || this.closedByUser) return;
      const now = Date.now();
      if (now - this.lastFrameAt > 8000 && now - this.lastResetAt > 8000) {
        this.lastResetAt = now;
        console.warn('[android] no frames for 8s; requesting keyframe reset');
        this.sendControl(serializeSimple(CONTROL_TYPE_RESET_VIDEO));
      }
    }, 2000);
    this.statsTimer = setInterval(() => {
      const now = Date.now();
      const elapsed = (now - this.lastSampleAt) / 1000;
      if (elapsed <= 0) return;
      this.callbacks.onStats({
        fps: Math.round((this.frameCount / elapsed) * 10) / 10,
        kbps: Math.round((this.bytesSinceSample * 8) / elapsed / 1000),
        width: this.header?.width ?? 0,
        height: this.header?.height ?? 0,
        received: this.receivedFrames,
        decoded: this.decodedFrames,
        controls: this.controlsSent,
        last: this.lastType,
      });
      this.frameCount = 0;
      this.bytesSinceSample = 0;
      this.lastSampleAt = now;
    }, 1000);
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== 1) return;
    try { this.socket.send(JSON.stringify(payload)); } catch { /* transport closed */ }
  }

  private sendControl(bytes: Uint8Array | null): void {
    if (!bytes) return;
    this.controlsSent++;
    this.send({ type: 'control', data: toBase64(bytes) });
  }

  /** 每收到一个非配置帧就回一次 ack（带 seq），让服务端窗口等于「已送达」而不是「已解码」。 */
  private ack(): void {
    this.send({ type: 'ack', seq: this.lastSeq });
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    this.lastMessageAt = Date.now();
    let message: ServerMessage;
    try { message = JSON.parse(raw) as ServerMessage; } catch { return; }
    this.lastType = `${message.type ?? '?'}${message.config ? ':cfg' : ''}${message.key ? ':key' : ''}`;
    try {
      this.dispatchMessage(message);
    } catch (error) {
      console.warn('[android] message handling failed', error);
      this.callbacks.onWarning(`处理消息失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private dispatchMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'header':
        this.header = {
          deviceName: message.deviceName ?? this.serial,
          codec: message.codec ?? 'h264',
          width: message.width ?? 0,
          height: message.height ?? 0,
        };
        this.lastFrameAt = Date.now();
        this.callbacks.onHeader(this.header);
        this.callbacks.onState('streaming');
        break;
      case 'frame':
        this.handleFrame(message);
        break;
      case 'error':
        this.callbacks.onState('error', message.message || 'SCRCPY_ERROR');
        break;
      case 'closed':
        this.callbacks.onState('error', 'SCRCPY_SESSION_CLOSED');
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  private handleFrame(message: ServerMessage): void {
    if (typeof message.data !== 'string') return;
    if (typeof message.seq === 'number') this.lastSeq = message.seq;
    const bytes = fromBase64(message.data);
    this.bytesSinceSample += message.data.length;
    this.receivedFrames++;
    this.lastFrameAt = Date.now();
    if (this.decoder?.state === 'closed') { this.decoder = null; this.configured = false; }
    if (message.config) {
      // 配置包只用于 configure()，不能单独解码；参数集并入下一个关键帧。
      this.configData = bytes;
      this.pendingConfig = bytes;
      this.configureDecoder();
      this.ack();
      return;
    }
    if (!this.configured) this.configureDecoder();
    const keyFrame = message.key === true;
    if (this.needsKeyframe && !keyFrame) {
      // 重配后的第一个关键帧之前，delta 无法解码；跳过但照常回 ack。
      this.ack();
      return;
    }
    let payload = bytes;
    if (this.pendingConfig) {
      payload = new Uint8Array(this.pendingConfig.length + bytes.length);
      payload.set(this.pendingConfig, 0);
      payload.set(bytes, this.pendingConfig.length);
      this.pendingConfig = null;
    }
    if (keyFrame) this.needsKeyframe = false;
    this.decode(payload, keyFrame, message.pts);
    this.ack();
  }

  private configureDecoder(): void {
    const codec = this.header?.codec ?? 'h264';
    if (!this.decoder || this.decoder.state === 'closed') {
      if (typeof VideoDecoder === 'undefined') {
        if (!this.warnedUnsupported) {
          this.warnedUnsupported = true;
          this.callbacks.onWarning('当前浏览器不支持 WebCodecs（VideoDecoder），无法解码投屏画面。');
        }
        this.callbacks.onState('error', 'VIDEO_DECODER_UNSUPPORTED');
        return;
      }
      try {
        this.decoder = new VideoDecoder({
          output: frame => this.onDecodedFrame(frame),
          error: error => {
            // 解码器致命错误后会被关闭：下次收到帧时重建，并请求关键帧重置。
            this.configured = false;
            console.warn('[android] video decoder error', error);
            this.callbacks.onState('error', error instanceof Error ? error.message : 'VIDEO_DECODER_ERROR');
            this.sendControl(serializeSimple(CONTROL_TYPE_RESET_VIDEO));
          },
        });
      } catch (error) {
        console.warn('[android] VideoDecoder unavailable', error);
        this.callbacks.onWarning(`创建 VideoDecoder 失败：${error instanceof Error ? error.message : String(error)}`);
        this.callbacks.onState('error', 'VIDEO_DECODER_UNSUPPORTED');
        return;
      }
    }
    // TS 5.3 的 lib.dom 还没有 avc/hevc 字段（Annex B 输入），这里补类型。
    type AnnexBConfig = VideoDecoderConfig & { avc?: { format: 'annexb' }; hevc?: { format: 'annexb' } };
    const base: AnnexBConfig = { codec: 'avc1.42e01e', optimizeForLatency: true };
    let candidates: string[];
    if (codec === 'h264') {
      const parsed = avcCodecString(this.configData);
      candidates = [parsed, 'avc1.42e01e', 'avc1.4d401e', 'avc1.64001f'].filter((value, index, all) => all.indexOf(value) === index);
      base.avc = { format: 'annexb' };
    } else if (codec === 'h265') {
      candidates = [hevcCodecString(this.configData), 'hev1.1.6.L120.B0', 'hvc1.1.6.L120.B0'];
      base.hevc = { format: 'annexb' };
    } else {
      candidates = ['av01.0.04M.08'];
    }
    const failures: string[] = [];
    for (const candidate of candidates) {
      try {
        this.decoder.configure({ ...base, codec: candidate } as VideoDecoderConfig);
        this.configured = true;
        // configure() 之后必须先送一个真正的 IDR；参数集随它一起送入。
        this.needsKeyframe = true;
        if (candidate !== candidates[0]) console.warn('[android] decoder configured with fallback codec', candidate);
        return;
      } catch (error) {
        failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
        console.warn('[android] decoder configure failed', candidate, error);
      }
    }
    this.callbacks.onWarning(`解码器配置失败（${failures.join('；')}）`);
    this.callbacks.onState('error', 'VIDEO_DECODER_UNSUPPORTED');
  }

  private decode(bytes: Uint8Array, key: boolean, pts?: string): void {
    if (!this.decoder || this.decoder.state !== 'configured') return;
    try {
      this.decoder.decode(new EncodedVideoChunk({
        type: key ? 'key' : 'delta',
        timestamp: pts ? Number(pts) : this.lastTimestamp + 1,
        data: bytes,
      }));
      this.lastTimestamp = pts ? Number(pts) : this.lastTimestamp + 1;
    } catch (error) {
      // 单个 chunk 失败不终止整条流；等待下一个关键帧即可恢复，但要把原因暴露出来。
      if (this.decodeFailureCount++ < 3) {
        console.warn('[android] decode threw', error);
        this.callbacks.onWarning(`送入解码器失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private decodeFailureCount = 0;

  private lastTimestamp = 0;

  private onDecodedFrame(frame: VideoFrame): void {
    this.frameCount++;
    this.decodedFrames++;
    const width = frame.displayWidth || frame.codedWidth;
    const height = frame.displayHeight || frame.codedHeight;
    const canvas = this.canvas;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      if (this.header) {
        this.header = { ...this.header, width, height };
        this.callbacks.onHeader(this.header);
      }
    }
    const context = canvas.getContext('2d');
    if (context) {
      context.drawImage(frame, 0, 0, canvas.width, canvas.height);
    }
    frame.close();
  }

  // ---- 输入注入 ----

  private pointerPoint(x: number, y: number): TouchPoint {
    return { x, y, screenWidth: this.header?.width ?? 0, screenHeight: this.header?.height ?? 0 };
  }

  touch(action: number, x: number, y: number, pointerId: bigint): void {
    const released = action === MOTION_ACTION_UP || action === MOTION_ACTION_CANCEL;
    const pressure = released ? 0 : 1;
    // scrcpy 语义：鼠标按下/移动时 buttons=BUTTON_PRIMARY，抬起时为 0；
    // actionButton 只在按下/抬起那一刻带上被操作的按键。
    const buttons = pointerId === POINTER_ID_MOUSE && !released ? BUTTON_PRIMARY : 0;
    const actionButton = (action === MOTION_ACTION_DOWN || action === MOTION_ACTION_UP) && pointerId === POINTER_ID_MOUSE ? BUTTON_PRIMARY : 0;
    this.sendControl(serializeTouch(action, pointerId, this.pointerPoint(x, y), pressure, actionButton, buttons));
  }

  pointerDown(x: number, y: number, pointerType: string): void {
    this.touch(MOTION_ACTION_DOWN, x, y, pointerType === 'mouse' ? POINTER_ID_MOUSE : POINTER_ID_FINGER);
  }

  pointerMove(x: number, y: number, pointerType: string): void {
    this.touch(MOTION_ACTION_MOVE, x, y, pointerType === 'mouse' ? POINTER_ID_MOUSE : POINTER_ID_FINGER);
  }

  pointerUp(x: number, y: number, pointerType: string): void {
    this.touch(MOTION_ACTION_UP, x, y, pointerType === 'mouse' ? POINTER_ID_MOUSE : POINTER_ID_FINGER);
  }

  scroll(x: number, y: number, deltaX: number, deltaY: number): void {
    this.sendControl(serializeScroll(this.pointerPoint(x, y), deltaX, deltaY));
  }

  key(keycode: number, action: number = KEY_ACTION_DOWN): void {
    this.sendControl(serializeKeycode(action, keycode));
  }

  tapKey(keycode: number): void {
    this.sendControl(serializeKeycode(KEY_ACTION_DOWN, keycode));
    this.sendControl(serializeKeycode(KEY_ACTION_UP, keycode));
  }

  back(): void {
    this.sendControl(serializeBackOrScreenOn(KEY_ACTION_DOWN));
    this.sendControl(serializeBackOrScreenOn(KEY_ACTION_UP));
  }

  home(): void { this.tapKey(ANDROID_KEYCODE.HOME); }
  recents(): void { this.tapKey(ANDROID_KEYCODE.APP_SWITCH); }
  power(): void { this.tapKey(ANDROID_KEYCODE.POWER); }
  volumeUp(): void { this.tapKey(ANDROID_KEYCODE.VOLUME_UP); }
  volumeDown(): void { this.tapKey(ANDROID_KEYCODE.VOLUME_DOWN); }
  rotate(): void { this.sendControl(serializeSimple(CONTROL_TYPE_ROTATE_DEVICE)); }
  expandNotifications(): void { this.sendControl(serializeSimple(CONTROL_TYPE_EXPAND_NOTIFICATION_PANEL)); }
  collapsePanels(): void { this.sendControl(serializeSimple(CONTROL_TYPE_COLLAPSE_PANELS)); }
  setDisplayPower(on: boolean): void { this.sendControl(serializeDisplayPower(on)); }
  sendText(text: string): void { this.sendControl(serializeText(text)); }
  startApp(name: string): void { this.sendControl(serializeStartApp(name)); }
}
