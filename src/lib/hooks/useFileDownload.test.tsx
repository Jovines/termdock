// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { downloadFile, type DownloadResult } from '../terminal/api';
import { useFileDownload } from './useFileDownload';

vi.mock('../terminal/api', () => ({ downloadFile: vi.fn() }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it.each(['success', 'failure'] as const)('ignores late A %s while B is downloading', async outcome => {
  const a = deferred<DownloadResult>(), b = deferred<DownloadResult>();
  vi.mocked(downloadFile).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  const { result, rerender } = renderHook(({ path }) => useFileDownload(path), { initialProps: { path: '/A' } });
  let first!: Promise<void>, second!: Promise<void>;
  act(() => { first = result.current.start(); });
  const oldSignal = vi.mocked(downloadFile).mock.calls[0][1]!;
  rerender({ path: '/B' });
  expect(oldSignal.aborted).toBe(true);
  expect(result.current.status).toBe('idle');
  act(() => { second = result.current.start(); });
  await act(async () => {
    if (outcome === 'success') a.resolve('saved'); else a.reject(new Error('A failed late'));
    await first;
  });
  expect(result.current.status).toBe('pending');
  expect(result.current.error).toBeNull();
  await act(async () => { b.resolve('saved'); await second; });
  expect(result.current.result).toBe('saved');
});

it('cancels immediately and allows retry before the canceled transport settles', async () => {
  const old = deferred<DownloadResult>(), retry = deferred<DownloadResult>();
  vi.mocked(downloadFile).mockReturnValueOnce(old.promise).mockReturnValueOnce(retry.promise);
  const { result } = renderHook(() => useFileDownload('/A'));
  let first!: Promise<void>, second!: Promise<void>;
  act(() => { first = result.current.start(); void result.current.start(); });
  expect(downloadFile).toHaveBeenCalledOnce();
  act(() => result.current.cancel());
  expect(vi.mocked(downloadFile).mock.calls[0][1]?.aborted).toBe(true);
  expect(result.current.status).toBe('canceled');
  act(() => { second = result.current.start(); });
  await act(async () => { old.reject(new Error('aborted late')); await first; });
  expect(result.current.status).toBe('pending');
  await act(async () => { retry.resolve('canceled'); await second; });
  expect(result.current.result).toBe('canceled');
});

it('aborts on close and unmount and starts a fresh lifecycle on reopening', async () => {
  const closed = deferred<DownloadResult>(), unmounted = deferred<DownloadResult>();
  vi.mocked(downloadFile).mockReturnValueOnce(closed.promise).mockReturnValueOnce(unmounted.promise);
  const { result, rerender, unmount } = renderHook(({ active }) => useFileDownload('/A', active), { initialProps: { active: true } });
  let first!: Promise<void>, second!: Promise<void>;
  act(() => { first = result.current.start(); });
  rerender({ active: false });
  expect(vi.mocked(downloadFile).mock.calls[0][1]?.aborted).toBe(true);
  await act(async () => { await result.current.start(); closed.resolve('saved'); await first; });
  expect(downloadFile).toHaveBeenCalledOnce();
  expect(result.current.status).toBe('idle');
  rerender({ active: true });
  act(() => { second = result.current.start(); });
  unmount();
  expect(vi.mocked(downloadFile).mock.calls[1][1]?.aborted).toBe(true);
  await act(async () => { unmounted.reject(new Error('closed')); await second; });
});

it('keeps a failure visible until retry and clears it while retry is pending', async () => {
  const failed = deferred<DownloadResult>(), retried = deferred<DownloadResult>();
  vi.mocked(downloadFile).mockReturnValueOnce(failed.promise).mockReturnValueOnce(retried.promise);
  const { result } = renderHook(() => useFileDownload('/A'));
  let first!: Promise<void>, second!: Promise<void>;
  act(() => { first = result.current.start(); });
  await act(async () => { failed.reject(new Error('offline')); await first; });
  expect(result.current).toMatchObject({ status: 'error', error: 'offline', result: null });
  act(() => { second = result.current.start(); });
  expect(result.current).toMatchObject({ status: 'pending', error: null });
  await act(async () => { retried.resolve('saved'); await second; });
  expect(result.current.status).toBe('saved');
});
