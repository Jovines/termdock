// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../federation/browserIntegration', () => ({ secureSocket: vi.fn() }));
import { resetCsrfTokenCache } from './api';
import { readTerminalClipboardImage, uploadTerminalClipboardImage } from './clipboardImage';

beforeEach(() => resetCsrfTokenCache());
afterEach(() => vi.unstubAllGlobals());

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
      expect(url).toBe('/api/terminal/fs/upload?dir=%2Ftmp');
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
