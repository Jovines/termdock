// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AndroidMirrorController, type MirrorStats } from './mirrorController';
import { secureSocket } from '../federation/browserIntegration';
vi.mock('../federation/browserIntegration', () => ({ secureSocket: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('mirror adaptation telemetry', () => {
  it('measures ping on the secure stream, exposes failed probes, and stops after disconnect', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date', 'performance'] });
    const socket = { readyState: 1, send: vi.fn(), close: vi.fn(), onopen: null as null | (() => void), onmessage: null as null | ((event: { data: string }) => void) };
    vi.mocked(secureSocket).mockReturnValue(socket as unknown as WebSocket);
    let stats: MirrorStats | undefined;
    const controller = new AndroidMirrorController(document.createElement('canvas'), {
      onState: vi.fn(), onHeader: vi.fn(), onWarning: vi.fn(), onStats: next => { stats = next; },
    });
    controller.connect('test', { id: 'auto', maxSize: 720, bitRate: 1200000, maxFps: 30 });
    expect(secureSocket).toHaveBeenCalledWith('/api/android/test/ws?max_size=720&bit_rate=1200000&max_fps=30');
    socket.onopen?.();
    vi.advanceTimersByTime(2000);
    expect(socket.send).toHaveBeenCalledWith('{"type":"ping"}');
    vi.advanceTimersByTime(70);
    socket.onmessage?.({ data: '{"type":"pong"}' });
    vi.advanceTimersByTime(930);
    expect(stats?.adaptation?.rttMs).toBe(70);
    vi.advanceTimersByTime(4000);
    expect(stats?.adaptation?.rttMs).toBeGreaterThanOrEqual(3000);
    controller.disconnect();
    const count = socket.send.mock.calls.length;
    vi.advanceTimersByTime(15000);
    expect(socket.send).toHaveBeenCalledTimes(count);
  });
  it('reports connection failures without falling back to a plain socket', () => {
    vi.mocked(secureSocket).mockImplementation(() => { throw new Error('secure transport unavailable'); });
    const onState = vi.fn();
    const controller = new AndroidMirrorController(document.createElement('canvas'), {
      onState, onHeader: vi.fn(), onWarning: vi.fn(), onStats: vi.fn(),
    });
    controller.connect('test');
    expect(onState).toHaveBeenLastCalledWith('error', 'secure transport unavailable');
  });
});

describe('live bitrate over the existing encrypted socket', () => {
  it('negotiates capability, confirms only matching ACKs, and keeps the stream on rejection', async () => {
    const socket = { readyState: 1, send: vi.fn(), close: vi.fn(), onmessage: null as null | ((event: { data: string }) => void) };
    vi.mocked(secureSocket).mockReturnValue(socket as unknown as WebSocket);
    const onState = vi.fn(), onBitrateSupport = vi.fn();
    const controller = new AndroidMirrorController(document.createElement('canvas'), {
      onState, onBitrateSupport, onHeader: vi.fn(), onWarning: vi.fn(), onStats: vi.fn(),
    });
    const message = (value: unknown) => socket.onmessage?.({ data: JSON.stringify(value) });
    controller.connect('device');
    expect(await controller.setBitrate(1_800_000)).toBe(false); // old server: no reconnect/fallback
    message({ type: 'bitrate-support', supported: true });
    const pending = controller.setBitrate(1_800_000);
    expect(socket.send).toHaveBeenLastCalledWith('{"type":"bitrate","requestId":1,"bitRate":1800000}');
    message({ type: 'bitrate-result', requestId: 999, bitRate: 1_800_000, applied: true });
    expect(controller.canSetBitrate).toBe(false);
    message({ type: 'bitrate-result', requestId: 1, bitRate: 1_800_000, applied: true });
    expect(await pending).toBe(true);
    const rejected = controller.setBitrate(8_000_000);
    message({ type: 'bitrate-result', requestId: 2, bitRate: 8_000_000, applied: false, detail: 'BITRATE_ENCODER_REJECTED: requested=8000000; device=test' });
    expect(await rejected).toBe(false);
    expect(onBitrateSupport).toHaveBeenLastCalledWith(false, 'BITRATE_ENCODER_REJECTED: requested=8000000; device=test');
    expect(socket.close).not.toHaveBeenCalled();
    expect(onState).toHaveBeenCalledTimes(1);
    controller.disconnect();
  });
  it('settles outstanding requests on timeout and disconnect without reopening video', async () => {
    vi.useFakeTimers();
    const socket = { readyState: 1, send: vi.fn(), close: vi.fn(), onmessage: null as null | ((event: { data: string }) => void) };
    vi.mocked(secureSocket).mockReturnValue(socket as unknown as WebSocket);
    const controller = new AndroidMirrorController(document.createElement('canvas'), {
      onState: vi.fn(), onHeader: vi.fn(), onWarning: vi.fn(), onStats: vi.fn(),
    });
    controller.connect('device');
    socket.onmessage?.({ data: '{"type":"bitrate-support","supported":true}' });
    const timeout = controller.setBitrate(4_000_000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await timeout).toBe(false);
    expect(controller.lastBitrateFailure).toContain('BITRATE_CLIENT_TIMEOUT');
    expect(socket.close).not.toHaveBeenCalled();
    controller.disconnect();
  });
});

describe('transient video decoder recovery', () => {
  it('requests a reset and clears the error when a rebuilt decoder produces a frame', () => {
    const decoders: Decoder[] = [];
    class Decoder {
      state = 'unconfigured';
      decodeQueueSize = 0;
      constructor(readonly callbacks: VideoDecoderInit) { decoders.push(this); }
      configure() { this.state = 'configured'; }
      decode() {}
      close() { this.state = 'closed'; }
    }
    vi.stubGlobal('VideoDecoder', Decoder);
    vi.stubGlobal('EncodedVideoChunk', class {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const socket = { readyState: 1, send: vi.fn(), close: vi.fn(), onmessage: null as null | ((event: { data: string }) => void) };
    vi.mocked(secureSocket).mockReturnValue(socket as unknown as WebSocket);
    const onState = vi.fn();
    const canvas = document.createElement('canvas');
    const drawImage = vi.fn();
    vi.spyOn(canvas, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    const controller = new AndroidMirrorController(canvas, { onState, onHeader: vi.fn(), onWarning: vi.fn(), onStats: vi.fn() });
    const message = (value: unknown) => socket.onmessage?.({ data: JSON.stringify(value) });
    try {
      controller.connect('test');
      message({ type: 'header', codec: 'h264', width: 100, height: 200 });
      message({ type: 'frame', config: true, data: 'AAAAAQ==' });
      decoders[0].close();
      decoders[0].callbacks.error(new DOMException('decoder resource reclaimed', 'EncodingError'));
      expect(onState).toHaveBeenLastCalledWith('error', 'VIDEO_DECODER_ERROR: decoder resource reclaimed');
      expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('control'));
      message({ type: 'frame', key: true, data: 'AAAAAQ==' });
      expect(decoders).toHaveLength(2);
      const frame = { displayWidth: 100, displayHeight: 200, close: vi.fn() } as unknown as VideoFrame;
      decoders[1].callbacks.output(frame);
      expect(drawImage).toHaveBeenCalled();
      expect(onState).toHaveBeenLastCalledWith('streaming');
      controller.disconnect();
      const count = onState.mock.calls.length;
      decoders[1].callbacks.output(frame);
      decoders[1].callbacks.error(new DOMException('late error'));
      expect(onState).toHaveBeenCalledTimes(count);
    } finally { controller.disconnect(); vi.unstubAllGlobals(); }
  });
});

describe('mirror failure diagnostics', () => {
  it.each([true, false])('preserves the server cause and includes socket close details (server error: %s)', serverError => {
    const socket = {
      readyState: 1, send: vi.fn(), close: vi.fn(),
      onmessage: null as null | ((event: { data: string }) => void),
      onerror: null as null | (() => void),
      onclose: null as null | ((event: { code: number; reason: string }) => void),
    };
    vi.mocked(secureSocket).mockReturnValue(socket as unknown as WebSocket);
    const onState = vi.fn();
    const controller = new AndroidMirrorController(document.createElement('canvas'), {
      onState, onHeader: vi.fn(), onWarning: vi.fn(), onStats: vi.fn(),
    });
    try {
      controller.connect('test');
      if (serverError) {
        socket.onmessage?.({ data: JSON.stringify({ type: 'error', message: 'SCRCPY_CONNECT_TIMEOUT: device offline' }) });
        socket.onmessage?.({ data: '{"type":"closed"}' });
      }
      socket.onerror?.();
      socket.onclose?.({ code: 1011, reason: 'upstream closed' });
      expect(onState).toHaveBeenLastCalledWith('error', `${serverError ? 'SCRCPY_CONNECT_TIMEOUT: device offline' : 'SCRCPY_CONNECTION_LOST'}\nWebSocket close code=1011: upstream closed`);
    } finally { controller.disconnect(); }
  });
});

it('keeps view-only phones on the encrypted stream while suppressing device input', () => {
  const socket = { readyState: 1, send: vi.fn(), close: vi.fn(), onmessage: null };
  vi.mocked(secureSocket).mockReturnValue(socket as unknown as WebSocket);
  const controller = new AndroidMirrorController(document.createElement('canvas'), { onState: vi.fn(), onHeader: vi.fn(), onWarning: vi.fn(), onStats: vi.fn() });
  controller.setReadOnly(true); controller.connect('pixel'); controller.sendText('must not be typed'); controller.back(); controller.rotate();
  expect(socket.send.mock.calls.filter(call => JSON.parse(call[0]).type === 'control')).toHaveLength(0);
  controller.setReadOnly(false); controller.back(); expect(socket.send.mock.calls.filter(call => JSON.parse(call[0]).type === 'control')).toHaveLength(2); controller.disconnect();
});
