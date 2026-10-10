// @vitest-environment jsdom
// Hook lifecycle fixtures use a mocked upload API. These tests do not verify
// encryption or a real upload; filesystemUpload.test.ts covers disk behavior.
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadFiles, UploadFilesError, type UploadFilesResponse, type UploadedFile } from '../../terminal/api';
import { useSidebarUpload } from './useSidebarUpload';

vi.mock('../../terminal/api', async importOriginal => ({
  ...await importOriginal<typeof import('../../terminal/api')>(),
  uploadFiles: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const fixture = (name = 'selected.txt') => new File([`contents:${name}`], name);
const saved = (file: File, path = `/work/${file.name}`): UploadedFile => ({ name: file.name, path, size: file.size });

afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('sidebar upload lifecycle and recovery', () => {
  it('retains a selection of 51 files and reports the real API precheck without sending a request', async () => {
    const actualApi = await vi.importActual<typeof import('../../terminal/api')>('../../terminal/api');
    vi.mocked(uploadFiles).mockImplementationOnce(actualApi.uploadFiles);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const selected = Array.from({ length: 51 }, (_, index) => fixture(`selected-${index}.txt`));
    const refreshed = vi.fn();
    const { result } = renderHook(() => useSidebarUpload(refreshed));
    await act(async () => { expect(await result.current.start('/work', selected)).toBe(false); });
    expect(fetch).not.toHaveBeenCalled();
    expect(refreshed).not.toHaveBeenCalled();
    expect(result.current.task).toMatchObject({ status: 'error', error: 'UPLOAD_LIMIT', files: selected, retryFiles: selected, uploaded: [] });
    expect(result.current.busy).toBe(false);
  });

  it('serializes duplicate starts and retries while an upload is pending', async () => {
    const upload = deferred<UploadFilesResponse>();
    vi.mocked(uploadFiles).mockReturnValueOnce(upload.promise);
    const file = fixture();
    const other = fixture('other.txt');
    const refreshed = vi.fn();
    const { result } = renderHook(() => useSidebarUpload(refreshed));
    let first!: Promise<boolean>;
    let duplicate!: Promise<boolean>;
    act(() => {
      first = result.current.start('/work', [file]);
      duplicate = result.current.start('/other', [other]);
      result.current.dismiss();
    });
    expect(await duplicate).toBe(false);
    expect(await result.current.retry()).toBe(false);
    expect(uploadFiles).toHaveBeenCalledOnce();
    expect(result.current.busy).toBe(true);
    expect(result.current.task).toMatchObject({ status: 'uploading', directory: '/work', files: [file] });
    await act(async () => { upload.resolve({ files: [saved(file)] }); expect(await first).toBe(true); });
    expect(result.current.task?.status).toBe('done');
    expect(result.current.busy).toBe(false);
    expect(refreshed).toHaveBeenCalledWith('/work');
  });

  it('keeps a final image path after ACK=false and retries its reference without uploading again', async () => {
    const file = fixture('photo.png');
    const uploaded = saved(file, '/tmp/photo_8.png');
    const ack = deferred<boolean>();
    vi.mocked(uploadFiles).mockResolvedValueOnce({ files: [uploaded] });
    const insert = vi.fn().mockReturnValueOnce(ack.promise).mockResolvedValueOnce(true);
    const { result } = renderHook(() => useSidebarUpload(vi.fn()));
    let first!: Promise<boolean>;
    await act(async () => { first = result.current.start('/tmp', [file], insert, () => true); });
    expect(result.current.task?.status).toBe('inserting');
    expect(result.current.busy).toBe(true);
    expect(insert).toHaveBeenCalledWith(uploaded.path);
    await act(async () => { ack.resolve(false); expect(await first).toBe(false); });
    expect(result.current.task).toMatchObject({ status: 'error', error: 'reference', uploaded: [uploaded], retryFiles: [] });
    await act(async () => { expect(await result.current.retry()).toBe(true); });
    expect(uploadFiles).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert).toHaveBeenLastCalledWith('/tmp/photo_8.png');
    expect(result.current.task?.status).toBe('done');
  });

  it('keeps the uploaded path without inserting when the session changes during upload', async () => {
    const upload = deferred<UploadFilesResponse>();
    const file = fixture('photo.png');
    const uploaded = saved(file, '/tmp/photo.png');
    vi.mocked(uploadFiles).mockReturnValueOnce(upload.promise);
    const insert = vi.fn().mockResolvedValue(true);
    let isCurrent = true;
    const { result } = renderHook(() => useSidebarUpload(vi.fn()));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.start('/tmp', [file], insert, () => isCurrent); });
    isCurrent = false;
    await act(async () => { upload.resolve({ files: [uploaded] }); expect(await pending).toBe(false); });
    expect(insert).not.toHaveBeenCalled();
    expect(result.current.task).toMatchObject({ status: 'error', error: 'reference', uploaded: [uploaded] });
    await act(async () => { expect(await result.current.retry()).toBe(false); });
    expect(uploadFiles).toHaveBeenCalledOnce();
    expect(insert).not.toHaveBeenCalled();
  });

  it('does not mark a late ACK successful after the target session changes', async () => {
    const ack = deferred<boolean>();
    const file = fixture('photo.png');
    vi.mocked(uploadFiles).mockResolvedValueOnce({ files: [saved(file, '/tmp/photo.png')] });
    let isCurrent = true;
    const insert = vi.fn().mockReturnValueOnce(ack.promise);
    const { result } = renderHook(() => useSidebarUpload(vi.fn()));
    let pending!: Promise<boolean>;
    await act(async () => { pending = result.current.start('/tmp', [file], insert, () => isCurrent); });
    isCurrent = false;
    await act(async () => { ack.resolve(true); expect(await pending).toBe(false); });
    expect(result.current.task).toMatchObject({ status: 'error', error: 'reference' });
    expect(result.current.task?.uploaded[0].path).toBe('/tmp/photo.png');
  });

  it.each(['resolved', 'rejected'] as const)('reports a %s partial batch and retries only failed items, retaining all saved paths', async outcome => {
    const files = [fixture('first.txt'), fixture('second.txt'), fixture('third.txt')];
    const successful = [saved(files[0]), saved(files[2])];
    const partial: UploadFilesResponse = { files: successful, results: [
      { index: 0, name: files[0].name, status: 'uploaded', path: successful[0].path },
      { index: 1, name: files[1].name, status: 'failed', error: 'disk full' },
      { index: 2, name: files[2].name, status: 'uploaded', path: successful[1].path },
    ] };
    if (outcome === 'resolved') vi.mocked(uploadFiles).mockResolvedValueOnce(partial);
    else vi.mocked(uploadFiles).mockRejectedValueOnce(new UploadFilesError('partial upload', partial, 'UPLOAD_FAILED'));
    vi.mocked(uploadFiles).mockResolvedValueOnce({ files: [saved(files[1])] });
    const refreshed = vi.fn();
    const { result } = renderHook(() => useSidebarUpload(refreshed));
    await act(async () => { expect(await result.current.start('/work', files)).toBe(false); });
    expect(result.current.task).toMatchObject({ status: 'error', uploaded: successful, retryFiles: [files[1]] });
    await act(async () => { expect(await result.current.retry()).toBe(true); });
    expect(uploadFiles).toHaveBeenNthCalledWith(2, '/work', [files[1]], expect.any(AbortSignal));
    expect(result.current.task?.uploaded.map(file => file.path).sort()).toEqual(files.map(file => `/work/${file.name}`).sort());
    expect(result.current.task).toMatchObject({ status: 'done', retryFiles: [], files });
    expect(refreshed).toHaveBeenCalledTimes(2);
  });

  it('blocks automatic retry of legacy partial results whose failed indexes are unknown', async () => {
    const files = [fixture('same.txt'), fixture('same.txt')];
    vi.mocked(uploadFiles).mockResolvedValueOnce({ files: [saved(files[0], '/work/same_1.txt')] });
    const { result } = renderHook(() => useSidebarUpload(vi.fn()));
    await act(async () => { expect(await result.current.start('/work', files)).toBe(false); });
    expect(result.current.task).toMatchObject({ status: 'error', retryFiles: [], files });
    expect(result.current.task?.uploaded[0].path).toBe('/work/same_1.txt');
    await act(async () => { expect(await result.current.retry()).toBe(false); });
    expect(uploadFiles).toHaveBeenCalledOnce();
  });

  it.each(['resolve', 'reject'] as const)('aborts a canceled upload and never claims done on its late %s', async outcome => {
    const upload = deferred<UploadFilesResponse>();
    const file = fixture();
    vi.mocked(uploadFiles).mockReturnValueOnce(upload.promise);
    const insert = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useSidebarUpload(vi.fn()));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.start('/tmp', [file], insert, () => true); });
    const signal = vi.mocked(uploadFiles).mock.calls[0][2]!;
    act(() => result.current.cancel());
    expect(signal.aborted).toBe(true);
    await act(async () => {
      if (outcome === 'resolve') upload.resolve({ files: [saved(file)] });
      else upload.reject(new Error('late abort'));
      expect(await pending).toBe(false);
    });
    expect(result.current.task?.status).toBe('canceled');
    expect(result.current.busy).toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });

  it('aborts on unmount and blocks a late reference callback', async () => {
    const upload = deferred<UploadFilesResponse>();
    const file = fixture();
    vi.mocked(uploadFiles).mockReturnValueOnce(upload.promise);
    const insert = vi.fn().mockResolvedValue(true);
    const { result, unmount } = renderHook(() => useSidebarUpload(vi.fn()));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.start('/tmp', [file], insert, () => true); });
    const signal = vi.mocked(uploadFiles).mock.calls[0][2]!;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { upload.resolve({ files: [saved(file)] }); expect(await pending).toBe(false); });
    expect(insert).not.toHaveBeenCalled();
  });
});
