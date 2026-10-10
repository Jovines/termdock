// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../federation/browserIntegration', () => ({ secureSocket: vi.fn() }));
import { resetCsrfTokenCache } from './api';
import { clearSelectedTarget, saveSelectedTarget } from '../federation/clientScope';
import { TerminalClipboardVideoError, readTerminalClipboardFiles, readTerminalClipboardImage, readTerminalClipboardVideos, uploadTerminalClipboardImage } from './clipboardImage';

beforeEach(() => resetCsrfTokenCache());
afterEach(() => { vi.unstubAllGlobals(); clearSelectedTarget(); });

describe('terminal clipboard video', () => {
  it('reads a video before the cover image advertised by the browser', async () => {
    const cover = vi.fn();
    const movie = new Blob(['movie'], { type: 'video/mp4' });
    const videos = await readTerminalClipboardVideos({ read: vi.fn().mockResolvedValue([
      { types: ['image/png'], getType: cover },
      { types: ['video/mp4'], getType: vi.fn().mockResolvedValue(movie) },
    ]) });
    expect(videos).toHaveLength(1);
    expect(videos[0].type).toBe('video/mp4');
    expect(videos[0].size).toBe(movie.size);
    expect(cover).not.toHaveBeenCalled();
  });

  it.each([
    '无法读取剪贴板文件或视频：execution error: Error: TERMDOCK_CLIPBOARD_VIDEO_ERROR: 复制来源未提供可读取的视频数据 (-2700)',
    'Error invoking remote method: script source; execution error: Error: 无法读取剪贴板视频 (-2700)',
  ])('preserves recognized native video failures for the paste handler: %s', async message => {
    vi.stubGlobal('termdockDesktop', { readClipboardFiles: vi.fn().mockRejectedValue(new Error(message)) });
    await expect(readTerminalClipboardFiles()).rejects.toBeInstanceOf(TerminalClipboardVideoError);
  });

  it('keeps a legacy framework failure eligible for text and image fallback', async () => {
    const error = new Error("source: throw new Error('无法读取剪贴板视频'); execution error: Error: nothing found to import (-2700)");
    vi.stubGlobal('termdockDesktop', { readClipboardFiles: vi.fn().mockRejectedValue(error) });
    await expect(readTerminalClipboardFiles()).rejects.toBe(error);
  });

  it('rejects empty movie data returned by an older native reader', async () => {
    vi.stubGlobal('termdockDesktop', { readClipboardFiles: vi.fn().mockResolvedValue([
      { name: 'empty.mp4', type: 'video/mp4', bytes: new ArrayBuffer(0) },
    ]) });
    await expect(readTerminalClipboardFiles()).rejects.toBeInstanceOf(TerminalClipboardVideoError);
  });

  it('passes the actual target peer to native verification when reusing a local path', async () => {
    saveSelectedTarget({ url: 'http://localhost:9834', targetPeerId: 'actual-target-peer' });
    const read = vi.fn().mockResolvedValue([{ name: 'movie.mp4', path: '/original/movie.mp4' }]);
    vi.stubGlobal('termdockDesktop', { readClipboardFiles: read });
    await expect(readTerminalClipboardFiles()).resolves.toEqual({ files: [], paths: ['/original/movie.mp4'] });
    expect(read).toHaveBeenCalledWith({ localServiceId: 'actual-target-peer' });
  });

  it('does not insert a file after the user switches target during native reading', async () => {
    saveSelectedTarget({ url: 'http://localhost:9834', targetPeerId: 'first-peer' });
    vi.stubGlobal('termdockDesktop', { readClipboardFiles: vi.fn(async () => {
      saveSelectedTarget({ url: 'http://remote:9834', targetPeerId: 'second-peer' });
      return [{ name: 'movie.mp4', path: '/original/movie.mp4' }];
    }) });
    await expect(readTerminalClipboardFiles()).rejects.toThrow('目标服务已切换');
  });
});

describe('terminal clipboard image', () => {
  it('reads native PNG bytes even when the browser cannot expose the clipboard image', async () => {
    const png = new Uint8Array([137, 80, 78, 71]).buffer;
    const nativeRead = vi.fn().mockResolvedValue(png);
    const legacy = vi.fn();
    const browserRead = vi.fn().mockRejectedValue(new Error('Clipboard permission denied'));
    vi.stubGlobal('termdockDesktop', { readClipboardImage: nativeRead, pasteClipboardImage: legacy });
    const image = await readTerminalClipboardImage({ read: browserRead });
    expect(image?.size).toBe(4);
    expect(image?.type).toBe('image/png');
    expect(nativeRead).toHaveBeenCalledOnce();
    expect(browserRead).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
  });

  it('leaves native text clipboards alone without requesting browser image access', async () => {
    vi.stubGlobal('termdockDesktop', { readClipboardImage: vi.fn().mockResolvedValue(null) });
    const read = vi.fn();
    await expect(readTerminalClipboardImage({ read })).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('surfaces native clipboard failures without invoking the legacy uploader', async () => {
    const legacy = vi.fn();
    vi.stubGlobal('termdockDesktop', {
      readClipboardImage: vi.fn().mockRejectedValue(new Error('Native clipboard unavailable')),
      pasteClipboardImage: legacy,
    });
    await expect(readTerminalClipboardImage()).rejects.toThrow('Native clipboard unavailable');
    expect(legacy).not.toHaveBeenCalled();
  });

  it('reads image bytes and uploads through renderer encrypted fetch, never the native desktop uploader', async () => {
    const legacy = vi.fn(() => { throw new Error('Unencrypted preload request'); });
    vi.stubGlobal('termdockDesktop', { pasteClipboardImage: legacy });
    const blob = new Blob(['image bytes'], { type: 'image/png' });
    const image = await readTerminalClipboardImage({ read: vi.fn().mockResolvedValue([
      { types: ['text/html', 'image/png'], getType: vi.fn().mockResolvedValue(blob) },
    ]) });
    const requests: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (url === '/api/csrf-token') return Response.json({ csrfToken: 'encrypted' });
      expect(url).toBe('/api/terminal/fs/upload?dir=%2Ftmp&fileCount=1');
      requests.push(init);
      return Response.json({ files: [{ path: '/tmp/collision-safe.png' }] });
    }));
    expect(image?.type).toBe('image/png');
    expect(image?.size).toBe(blob.size);
    await expect(uploadTerminalClipboardImage(image!)).resolves.toBe('/tmp/collision-safe.png');
    const uploaded = (requests[0].body as FormData).get('files') as File;
    expect(uploaded.name).toMatch(/^termdock-clipboard-.*\.png$/);
    expect(uploaded.size).toBe(image?.size);
    expect(uploaded.type).toBe('image/png');
    await uploadTerminalClipboardImage(image!);
    expect(((requests[1].body as FormData).get('files') as File).name).not.toBe(uploaded.name);
    expect(legacy).not.toHaveBeenCalled();
  });

  it('leaves text-only clipboard contents to text paste', async () => {
    await expect(readTerminalClipboardImage({ read: vi.fn().mockResolvedValue([
      { types: ['text/plain'] },
    ]) })).resolves.toBeNull();
  });

  it('propagates encrypted upload failure without falling back to plaintext', async () => {
    const fetch = vi.fn(async (url) => {
      if (url === '/api/csrf-token') return Response.json({ csrfToken: 'encrypted' });
      throw new Error('Relay disconnected');
    });
    vi.stubGlobal('fetch', fetch);
    await expect(uploadTerminalClipboardImage(new File(['png'], 'image.png', { type: 'image/png' })))
      .rejects.toThrow('Relay disconnected');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
