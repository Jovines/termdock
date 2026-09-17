// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useEncryptedMediaSource } from './mediaSource';

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: vi.fn(() => 'blob:https://app.test/decrypted-media') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: originalCreateObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: originalRevokeObjectURL });
});

it('withholds business media URLs on first load until encrypted worker forwarding is available', () => {
  const worker = Object.assign(new EventTarget(), { controller: null as object | null });
  vi.stubGlobal('navigator', { serviceWorker: worker });
  const { result, rerender } = renderHook(({ url }) => useEncryptedMediaSource(url), { initialProps: { url: '/api/terminal/fs/video?path=private.mp4' } });
  expect(result.current).toBeUndefined();
  act(() => { worker.controller = {}; worker.dispatchEvent(new Event('controllerchange')); });
  expect(result.current).toContain('/api/terminal/fs/video');
  rerender({ url: 'blob:https://app.test/decrypted-image' });
  expect(result.current).toBe('blob:https://app.test/decrypted-image');
});

it('falls back to a blob fetched through the page when no worker controls the page', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('navigator', {});
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('media-bytes')); controller.close(); } });
  const fetchMock = vi.fn(async () => new Response(body, { status: 200, headers: { 'Content-Type': 'image/png' } }));
  vi.stubGlobal('fetch', fetchMock);
  const { result } = renderHook(() => useEncryptedMediaSource('/api/terminal/fs/blob?path=private.png'));
  expect(result.current).toBeUndefined();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(result.current).toBe('blob:https://app.test/decrypted-media');
});

it('reports failure instead of issuing a native business request when the fallback fetch fails', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('navigator', {});
  const fetchMock = vi.fn(() => Promise.reject(new Error('offline')));
  vi.stubGlobal('fetch', fetchMock);
  const error = vi.fn();
  const { result } = renderHook(() => useEncryptedMediaSource('/api/terminal/fs/blob?path=private.png', error));
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(result.current).toBeUndefined();
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(error).toHaveBeenCalledOnce();
});
