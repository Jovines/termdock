// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../federation/browserIntegration', () => ({ secureSocket: vi.fn() }));
vi.mock('./secureDownload', () => ({ prepareEncryptedDownload: vi.fn() }));
import { downloadFile, saveDownloadBlob } from './api';
import { prepareEncryptedDownload } from './secureDownload';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function picker(value: unknown) {
  Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value });
}
afterEach(() => {
  delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetAllMocks();
});

it('skips pre-aborted requests entirely', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const controller = new AbortController(); controller.abort();
  expect(await downloadFile('/A', controller.signal)).toBe('canceled');
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['headers', 'body', 'failure'] as const)('never saves a late %s result after abort', async stage => {
  const response = deferred<Response>(), body = deferred<Blob>();
  const fetch = vi.fn(() => response.promise); vi.stubGlobal('fetch', fetch);
  const save = vi.fn(); picker(save);
  const controller = new AbortController();
  const downloading = downloadFile('/private/A', controller.signal);
  expect(fetch).toHaveBeenCalledWith('/api/terminal/fs/download?path=%2Fprivate%2FA', { signal: controller.signal });
  if (stage === 'body') {
    response.resolve({ ok: true, blob: () => body.promise } as Response);
    await Promise.resolve();
  }
  controller.abort();
  if (stage === 'failure') response.reject(new Error('disconnected'));
  else if (stage === 'headers') response.resolve(new Response('private bytes'));
  else body.resolve(new Blob(['private bytes']));
  expect(await downloading).toBe('canceled');
  expect(save).not.toHaveBeenCalled();
});

it('keeps transport failure as an error without retrying a direct endpoint', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error('offline')); vi.stubGlobal('fetch', fetch);
  const save = vi.fn(); picker(save);
  await expect(downloadFile('/A')).rejects.toThrow('offline');
  expect(fetch).toHaveBeenCalledOnce(); expect(save).not.toHaveBeenCalled();
});

it('distinguishes native picker cancellation and completed writes', async () => {
  const show = vi.fn().mockRejectedValueOnce(new DOMException('Canceled', 'AbortError'));
  const writable = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
  show.mockResolvedValueOnce({ createWritable: async () => writable }); picker(show);
  expect(await saveDownloadBlob(new Blob(['bytes']), 'A')).toBe('canceled');
  expect(await saveDownloadBlob(new Blob(['bytes']), 'A')).toBe('saved');
  expect(writable.write).toHaveBeenCalledOnce(); expect(writable.close).toHaveBeenCalledOnce();
});

it('does not create a writable after a canceled picker eventually selects a destination', async () => {
  const dialog = deferred<{ createWritable: ReturnType<typeof vi.fn> }>();
  picker(() => dialog.promise);
  const controller = new AbortController(), createWritable = vi.fn();
  const saving = saveDownloadBlob(new Blob(['bytes']), 'A', controller.signal);
  controller.abort(); dialog.resolve({ createWritable });
  expect(await saving).toBe('canceled'); expect(createWritable).not.toHaveBeenCalled();
});

it('aborts an in-progress native write and never closes it after cancellation', async () => {
  const writing = deferred<void>();
  const writable = { write: () => writing.promise, close: vi.fn(), abort: vi.fn().mockResolvedValue(undefined) };
  picker(async () => ({ createWritable: async () => writable }));
  const controller = new AbortController();
  const saving = saveDownloadBlob(new Blob(['bytes']), 'A', controller.signal);
  await Promise.resolve(); await Promise.resolve();
  controller.abort(); writing.resolve(undefined);
  expect(await saving).toBe('canceled');
  expect(writable.abort).toHaveBeenCalledOnce(); expect(writable.close).not.toHaveBeenCalled();
});

it.each(['success', 'failure'] as const)('handles a late writable creation %s after cancellation', async outcome => {
  const opening = deferred<{ write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> }>();
  picker(async () => ({ createWritable: () => opening.promise }));
  const controller = new AbortController();
  const saving = saveDownloadBlob(new Blob(['bytes']), 'A', controller.signal);
  await Promise.resolve();
  controller.abort();
  const writable = { write: vi.fn(), close: vi.fn(), abort: vi.fn().mockResolvedValue(undefined) };
  if (outcome === 'failure') opening.reject(new Error('creation canceled')); else opening.resolve(writable);
  expect(await saving).toBe('canceled');
  expect(writable.write).not.toHaveBeenCalled(); expect(writable.close).not.toHaveBeenCalled();
  if (outcome === 'success') expect(writable.abort).toHaveBeenCalledOnce();
});

it('reports a native write failure instead of falling through to another save destination', async () => {
  picker(async () => ({ createWritable: async () => ({ write: async () => { throw new Error('disk full'); }, close: vi.fn() }) }));
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await expect(saveDownloadBlob(new Blob(['bytes']), 'A')).rejects.toThrow('disk full');
  expect(click).not.toHaveBeenCalled();
});

it('distinguishes iOS share dismissal from a successful handoff', async () => {
  const share = vi.fn().mockRejectedValueOnce(new DOMException('Dismissed', 'AbortError')).mockResolvedValueOnce(undefined);
  vi.stubGlobal('navigator', { userAgent: 'iPhone', platform: 'iPhone', share, canShare: () => true });
  expect(await saveDownloadBlob(new Blob(['bytes']), 'A')).toBe('canceled');
  expect(await saveDownloadBlob(new Blob(['bytes']), 'A')).toBe('saved');
  expect(prepareEncryptedDownload).not.toHaveBeenCalled();
});

it('does not navigate or start an anchor fallback when canceled while preparing an iOS attachment', async () => {
  vi.stubGlobal('navigator', { userAgent: 'iPhone', platform: 'iPhone' });
  const attachment = deferred<string | null>();
  vi.mocked(prepareEncryptedDownload).mockReturnValueOnce(attachment.promise);
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const controller = new AbortController();
  const saving = saveDownloadBlob(new Blob(['bytes']), 'A', controller.signal);
  controller.abort(); attachment.resolve('https://localhost/__termdock-download/123');
  expect(await saving).toBe('canceled'); expect(click).not.toHaveBeenCalled();
});
