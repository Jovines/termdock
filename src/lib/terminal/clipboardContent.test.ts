// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readClipboardContent } from './clipboardContent';
vi.mock('./api', () => ({ uploadFiles: vi.fn() }));
vi.mock('../federation/clientScope', () => ({ selectedTarget: () => ({ targetPeerId: 'owned' }) }));
beforeEach(() => { delete window.termdockDesktop; });
afterEach(() => { delete window.termdockDesktop; vi.unstubAllGlobals(); });
it('prefers native files over cover text and reuses local paths without uploading', async () => {
  window.termdockDesktop = { readClipboardFiles: vi.fn(async () => [{ name: 'movie.mp4', path: '/local/movie.mp4' }]) } as any;
  expect(await readClipboardContent({ files: [], text: 'cover' })).toEqual({ kind: 'files', files: [], paths: ['/local/movie.mp4'] });
});
it('never falls back to a movie cover when native video reading fails', async () => {
  window.termdockDesktop = { readClipboardFiles: vi.fn(async () => { throw new Error('TERMDOCK_CLIPBOARD_VIDEO_ERROR: 视频不可读取'); }) } as any;
  await expect(readClipboardContent({ files: [new File(['cover'], 'cover.png')], text: 'cover' })).rejects.toThrow('视频不可读取');
});
it('uses native images without requesting browser clipboard permission', async () => {
  const read = vi.fn(); vi.stubGlobal('navigator', { clipboard: { read } });
  window.termdockDesktop = { readClipboardImage: vi.fn(async () => new Uint8Array([1, 2]).buffer) } as any;
  const content = await readClipboardContent();
  expect(content.kind).toBe('files'); expect(read).not.toHaveBeenCalled();
});
it('reads browser content once and keeps videos ahead of image covers and text', async () => {
  const read = vi.fn(async () => [{ types: ['image/png', 'text/plain', 'video/mp4'], getType: async (type: string) => new Blob(['data'], { type }) }]);
  vi.stubGlobal('navigator', { clipboard: { read } });
  const content = await readClipboardContent(); expect(read).toHaveBeenCalledOnce();
  expect(content.kind === 'files' && content.files[0].type).toBe('video/mp4');
});
it('falls back to event text after a legacy native file reader fails', async () => {
  window.termdockDesktop = { readClipboardFiles: vi.fn(async () => { throw new Error('old reader unavailable'); }) } as any;
  expect(await readClipboardContent({ files: [], text: 'real text' })).toEqual({ kind: 'text', text: 'real text' });
});
it('stops before consuming late native bytes after ownership changes', async () => {
  let done!: (bytes: ArrayBuffer) => void; let current = true;
  window.termdockDesktop = { readClipboardImage: vi.fn(() => new Promise(resolve => { done = resolve; })) } as any;
  const pending = readClipboardContent(undefined, () => current); current = false; done(new Uint8Array([1]).buffer);
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
