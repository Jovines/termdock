import { afterEach, expect, it, vi } from 'vitest';
import { MODEL_PREVIEW_REQUEST_TIMEOUT_MS, readModel3dBlob } from './api';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('keeps model downloads and cancellation alive after headers, beyond 12 seconds', async () => {
  vi.useFakeTimers();
  let transferSignal!: AbortSignal;
  let complete!: (blob: Blob) => void;
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    transferSignal = init.signal;
    return { ok: true, headers: new Headers(), blob: () => new Promise<Blob>((resolve, reject) => {
      complete = resolve;
      transferSignal.addEventListener('abort', () => reject(transferSignal.reason), { once: true });
    }) };
  }));
  const slow = readModel3dBlob('/repo/装配预览.glb');
  await vi.advanceTimersByTimeAsync(15_000);
  expect(transferSignal.aborted).toBe(false);
  complete(new Blob(['glb']));
  await expect(slow).resolves.toMatchObject({ ext: '.glb' });
  expect(vi.getTimerCount()).toBe(0);

  const stalled = readModel3dBlob('/repo/stalled.glb');
  const timedOut = expect(stalled).rejects.toThrow('3D model transfer timed out');
  await vi.advanceTimersByTimeAsync(MODEL_PREVIEW_REQUEST_TIMEOUT_MS);
  await timedOut;
  expect(transferSignal.aborted).toBe(true);

  const controller = new AbortController();
  const cancelled = readModel3dBlob('/repo/cancel.glb', controller.signal);
  await vi.advanceTimersByTimeAsync(0);
  const stopped = expect(cancelled).rejects.toThrow('Changed file');
  controller.abort(new Error('Changed file'));
  await stopped;
  expect(transferSignal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
