// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { downloadMarkdownImage } from './markdownImageDownload';

let clicks: { href: string; filename: string }[];
const originalWorker = navigator.serviceWorker;
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('image bytes', { headers: { 'Content-Type': 'image/png' } })));
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicks.push({ href: this.href, filename: this.download });
  });
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:http://localhost/saved-image');
    static revokeObjectURL = vi.fn();
  });
  clicks = [];
});
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: originalWorker });
});

it('downloads the original local file through page fetch without a worker', async () => {
  const path = '/repo/图表 & 设计.svg';
  await downloadMarkdownImage({ kind: 'image', src: `/api/terminal/fs/blob?path=${encodeURIComponent(path)}&v=3`, alt: 'Diagram' });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/terminal/fs/download?path=${encodeURIComponent(path)}`);
  expect(clicks).toEqual([{ href: 'blob:http://localhost/saved-image', filename: '图表 & 设计.svg' }]);
  vi.runAllTimers();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/saved-image');
});

it.each(['offline', 'HTTP error'])('does not navigate to the business URL when download fails: %s', async (failure) => {
  if (failure === 'offline') vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
  else vi.mocked(fetch).mockResolvedValueOnce(new Response('{"error":"File missing"}', { status: 404 }));
  await expect(downloadMarkdownImage({ kind: 'image', src: '/api/terminal/fs/blob?path=%2Fmap.svg', alt: 'Map' })).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(clicks).toEqual([]);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('saves an external image as fetched bytes with its decoded filename', async () => {
  const src = 'https://images.test/%E5%9B%BE.png?token=123';
  await downloadMarkdownImage({ kind: 'image', src, alt: 'Remote image' });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(src);
  expect(clicks[0].filename).toBe('图.png');
  expect(clicks[0].href).toBe('blob:http://localhost/saved-image');
});

it('exports Mermaid SVG bytes without fetching', async () => {
  await downloadMarkdownImage({ kind: 'mermaid', svg: '<svg/>', alt: 'Graph' });
  expect(fetch).not.toHaveBeenCalled();
  expect(clicks[0].filename).toBe('mermaid.svg');
  const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
  expect(blob.type).toBe('image/svg+xml');
  expect(blob.size).toBe(6);
});

it('honors cancellation in the native file picker without a fallback download', async () => {
  const picker = vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
  Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: picker });
  try {
    await downloadMarkdownImage({ kind: 'image', src: '/api/terminal/fs/blob?path=%2Fmap.png', alt: 'Map' });
    expect(picker).toHaveBeenCalledWith({ suggestedName: 'map.png' });
    expect(clicks).toEqual([]);
  } finally {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  }
});
