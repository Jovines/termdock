// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureMirrorScreenshot, formatRecordingElapsed, mirrorCaptureName,
  pickMirrorRecordingMime, recordingExtension,
} from './mirrorCapture';

describe('mirror recording codec selection', () => {
  it('前面优先选 MP4，浏览器不支持时才回退 WebM', () => {
    const onlyWebm = pickMirrorRecordingMime(mime => mime.startsWith('video/webm'));
    expect(onlyWebm).toBe('video/webm;codecs=vp9');
    expect(pickMirrorRecordingMime(() => true)).toBe('video/mp4;codecs=avc1.42E01E');
  });

  it('一个都不支持时返回 null，由调用方报错而不是录出坏文件', () => {
    expect(pickMirrorRecordingMime(() => false)).toBeNull();
  });

  it('按容器决定扩展名', () => {
    expect(recordingExtension('video/mp4;codecs=avc1.42E01E')).toBe('mp4');
    expect(recordingExtension('video/webm;codecs=vp9')).toBe('webm');
  });
});

describe('mirror capture naming', () => {
  it('截图是 png，录屏跟随容器，且多次采集不重名', () => {
    expect(mirrorCaptureName('shot')).toMatch(/^termdock-mirror-shot-\d{14}-[a-z0-9]+\.png$/);
    expect(mirrorCaptureName('rec', 'video/mp4')).toMatch(/\.mp4$/);
    expect(mirrorCaptureName('rec', 'video/webm')).toMatch(/\.webm$/);
    const names = new Set(Array.from({ length: 20 }, () => mirrorCaptureName('shot')));
    expect(names.size).toBe(20);
  });
});

describe('recording elapsed label', () => {
  it('按 mm:ss 展示并夹住负数', () => {
    expect(formatRecordingElapsed(0)).toBe('00:00');
    expect(formatRecordingElapsed(9_400)).toBe('00:09');
    expect(formatRecordingElapsed(65_000)).toBe('01:05');
    expect(formatRecordingElapsed(-5)).toBe('00:00');
  });
});

describe('mirror screenshot capture', () => {
  // jsdom 没有真正的 canvas 后端，截图里的快照画布同样要给出 2d context 和 toBlob。
  const canvasWithFrame = (width: number, height: number, toBlob?: HTMLCanvasElement['toBlob']) => {
    const real = document.createElement.bind(document);
    const canvas = real('canvas') as HTMLCanvasElement;
    canvas.width = width;
    canvas.height = height;
    const context = { drawImage: vi.fn() };
    const stub = (element: HTMLCanvasElement) => {
      element.getContext = vi.fn(() => context) as unknown as HTMLCanvasElement['getContext'];
      element.toBlob = toBlob ?? ((callback: BlobCallback) => callback(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })));
    };
    stub(canvas);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const element = real(tag);
      if (tag === 'canvas') stub(element as HTMLCanvasElement);
      return element;
    }) as typeof document.createElement);
    return canvas;
  };

  afterEach(() => { vi.restoreAllMocks(); });

  it('拿设备原始分辨率出 PNG 文件', async () => {
    const file = await captureMirrorScreenshot(canvasWithFrame(1080, 2340), 'shot.png');
    expect(file.name).toBe('shot.png');
    expect(file.type).toBe('image/png');
    expect(file.size).toBeGreaterThan(0);
  });

  it('还没解出画面时报错，而不是插入一张空图', async () => {
    await expect(captureMirrorScreenshot(canvasWithFrame(0, 0))).rejects.toThrow('投屏画面尚未就绪');
  });

  it('编码失败时报错', async () => {
    const toBlob = ((callback: BlobCallback) => callback(null)) as HTMLCanvasElement['toBlob'];
    await expect(captureMirrorScreenshot(canvasWithFrame(100, 100, toBlob))).rejects.toThrow('截图失败');
  });
});
