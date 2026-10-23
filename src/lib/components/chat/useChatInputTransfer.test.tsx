// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ upload: vi.fn(), client: undefined, target: undefined as object | undefined }));
vi.mock('../../terminal/api', () => ({ uploadFiles: mocks.upload }));
vi.mock('../../federation/browserIntegration', () => ({ currentSecureClient: () => mocks.client }));
vi.mock('../../federation/clientScope', () => ({ selectedTarget: () => mocks.target }));
import { useChatInputTransfer } from './useChatInputTransfer';
const file = () => new File(['file contents'], 'a.txt', { type: 'text/plain' });
beforeEach(() => { mocks.upload.mockReset(); mocks.client = undefined; mocks.target = undefined; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function fixture() {
  const insert = vi.fn(), error = vi.fn(), input = { current: document.createElement('textarea') };
  document.body.append(input.current);
  const hook = renderHook(({ active }) => useChatInputTransfer({ sessionId: 'one', active, canWrite: true, directory: '/tmp', input, insert, error }), { initialProps: { active: true } });
  return { ...hook, insert, error };
}
it('uploads through the existing file API, escapes references, and never submits them', async () => {
  mocks.upload.mockResolvedValue({ files: [{ path: '/tmp/file with space.txt' }] });
  const f = fixture(); act(() => f.result.current.addFiles([file()]));
  await waitFor(() => expect(f.insert).toHaveBeenCalledWith('/tmp/file\\ with\\ space.txt ', true));
  expect(mocks.upload.mock.calls[0][0]).toBe('/tmp'); expect(f.result.current.busy).toBe(false);
});
it('discards and aborts an upload when its session is hidden before completion', async () => {
  let finish!: (result: unknown) => void;
  mocks.upload.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const f = fixture(); act(() => f.result.current.addFiles([file()])); f.rerender({ active: false });
  expect(mocks.upload.mock.calls[0][2].aborted).toBe(true);
  await act(async () => finish({ files: [{ path: '/tmp/a.txt' }] })); expect(f.insert).not.toHaveBeenCalled();
});
it('keeps a failed upload retryable without inserting a partial result', async () => {
  mocks.upload.mockResolvedValueOnce({ files: [] }).mockResolvedValueOnce({ files: [{ path: '/tmp/a.txt' }] });
  const f = fixture(); act(() => f.result.current.addFiles([file()])); await waitFor(() => expect(f.result.current.transfer?.stage).toBe('failed'));
  expect(f.insert).not.toHaveBeenCalled(); act(() => f.result.current.retry()); await waitFor(() => expect(f.insert).toHaveBeenCalledOnce());
});
it('reads older native clipboard files but never invokes a legacy preload uploader', async () => {
  const legacy = vi.fn(); vi.stubGlobal('termdockDesktop', { readClipboardFiles: vi.fn(async () => [{ name: 'a.txt', bytes: new Uint8Array([1]).buffer }]), uploadDroppedFiles: legacy, pasteClipboardImage: legacy });
  mocks.upload.mockResolvedValue({ files: [{ path: '/tmp/native-a.txt' }] });
  const f = fixture(); await act(async () => { await f.result.current.paste({ files: [], text: 'cover text' }); });
  expect(f.insert).toHaveBeenCalledWith('/tmp/native-a.txt ', true); expect(legacy).not.toHaveBeenCalled();
});
it('does not replace an unreadable video with its cover text or image', async () => {
  vi.stubGlobal('termdockDesktop', { readClipboardFiles: vi.fn(async () => { throw new Error('TERMDOCK_CLIPBOARD_VIDEO_ERROR: 无法读取剪贴板视频'); }) });
  const f = fixture(); await act(async () => { await f.result.current.paste({ files: [new File(['cover'], 'cover.png', { type: 'image/png' })], text: 'cover text' }); });
  expect(f.insert).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled(); expect(f.error).toHaveBeenCalledWith('无法读取剪贴板视频');
});
