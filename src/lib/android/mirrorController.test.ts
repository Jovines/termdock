// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AndroidMirrorController } from './mirrorController';
import { CONTROL_TYPE_RESET_VIDEO, fromBase64 } from './control';
import { DEFAULT_ANDROID_QUALITY } from './api';

// 传输层换成假的 WebSocket：这里只验控制消息的发送时机，不碰真连接。
const sockets: FakeSocket[] = [];
class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: string[] = [];
  constructor() { sockets.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  /** 握手完成：控制器以 readyState === 1 判定「可以发控制消息」。 */
  open() { this.readyState = 1; this.onopen?.(); }
  /** 服务器推一条消息（header/frame/...）。 */
  push(message: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(message) }); }
}
vi.mock('../federation/browserIntegration', () => ({
  secureSocket: () => {
    const socket = new FakeSocket();
    socket.open(); // 同步握手：测试里用假定时器，微任务不保证在断言前跑完
    return socket;
  },
}));

/** 控制器发的控制消息（base64）解回字节，只看是不是 RESET_VIDEO。 */
const resetRequests = (socket: FakeSocket): number[] => socket.sent
  .map(item => JSON.parse(item) as { type?: string; data?: string })
  .filter(item => item.type === 'control' && typeof item.data === 'string')
  .map(item => Array.from(fromBase64(item.data!)))
  .filter(bytes => bytes[0] === CONTROL_TYPE_RESET_VIDEO)
  .map(bytes => bytes[0]!);

const fakeCanvas = () => ({ width: 0, height: 0, getContext: () => null }) as unknown as HTMLCanvasElement;

const header = { type: 'header', deviceName: 'Test', codec: 'h264', width: 544, height: 1080 };

const connected = () => {
  const states: string[] = [];
  const controller = new AndroidMirrorController(fakeCanvas(), {
    onState: state => states.push(state),
    onHeader: () => { /* 不关心 */ },
    onStats: () => { /* 不关心 */ },
    onWarning: () => { /* 不关心 */ },
  });
  controller.connect('emulator-5554', DEFAULT_ANDROID_QUALITY);
  const socket = sockets.at(-1)!;
  socket.push(header);
  return { controller, socket, states };
};

describe('投屏入口采集刷新', () => {
  beforeEach(() => {
    sockets.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('首帧头之后自动补发一次 RESET_VIDEO，且只发一次', () => {
    const { socket } = connected();
    expect(resetRequests(socket)).toHaveLength(0); // 刚进会话不刷，先让设备把唤醒动画走完

    vi.advanceTimersByTime(3000);
    expect(resetRequests(socket)).toEqual([CONTROL_TYPE_RESET_VIDEO]);

    // 之后的常规心跳/统计不该再触发采集重建（否则每次进入都会多卡一下）。
    // 持续推帧，把「卡顿自愈」那条路径排除在外，只验入口这一次。
    for (let index = 0; index < 30; index++) {
      socket.push({ type: 'frame', data: 'AAAA', seq: index + 1 });
      vi.advanceTimersByTime(2000);
    }
    expect(resetRequests(socket)).toHaveLength(1);
  });

  it('手动 refreshCapture 立即发，用于画面发糊时重建设备侧采集', () => {
    const { controller, socket } = connected();
    vi.advanceTimersByTime(3000); // 先把入口那次用掉，避免混淆
    expect(controller.refreshCapture()).toBe(true);
    expect(resetRequests(socket)).toHaveLength(2);
  });

  it('断开后不再补发，避免对着已经关掉的会话发控制消息', () => {
    const { controller, socket } = connected();
    controller.disconnect();
    vi.advanceTimersByTime(3000);
    expect(resetRequests(socket)).toHaveLength(0);
    expect(controller.refreshCapture()).toBe(false);
  });

  it('会话没连上时不发（连接失败会话里没有可重建的采集）', () => {
    const controller = new AndroidMirrorController(fakeCanvas(), {
      onState: () => { /* 不关心 */ },
      onHeader: () => { /* 不关心 */ },
      onStats: () => { /* 不关心 */ },
      onWarning: () => { /* 不关心 */ },
    });
    expect(controller.refreshCapture()).toBe(false);
  });
});
