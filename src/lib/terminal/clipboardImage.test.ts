// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../federation/browserIntegration', () => ({ secureSocket: vi.fn() }));
import { resetCsrfTokenCache } from './api';
import { readTerminalClipboardImage, uploadTerminalClipboardImage } from './clipboardImage';

beforeEach(() => resetCsrfTokenCache());
afterEach(() => vi.unstubAllGlobals());

describe('terminal clipboard image', () => {
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
