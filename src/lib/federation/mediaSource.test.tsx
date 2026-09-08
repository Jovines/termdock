// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useEncryptedMediaSource } from './mediaSource';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
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
it('reports missing worker support instead of silently issuing a native business request', () => {
  vi.useFakeTimers(); vi.stubGlobal('navigator', {});
  const error = vi.fn();
  const { result } = renderHook(() => useEncryptedMediaSource('/api/terminal/fs/blob?path=private.png', error));
  act(() => vi.advanceTimersByTime(10_000));
  expect(result.current).toBeUndefined(); expect(error).toHaveBeenCalledOnce();
});
