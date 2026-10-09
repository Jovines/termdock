// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultComputerPreferences } from './preferences';
import { useComputerPreferences } from './useComputerPreferences';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
it('serializes concurrent edits and persists the latest draft before any desktop connection', async () => {
  const writes: string[] = []; let finish!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method !== 'PUT') return { ok: true, json: async () => ({ configured: true, preferences: defaultComputerPreferences('linux') }) };
    writes.push(String(options.body));
    if (writes.length === 1) return new Promise(resolve => { finish = resolve; });
    return { ok: true };
  }));
  const { result } = renderHook(() => useComputerPreferences('ubuntu'));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  act(() => result.current.change(value => ({ ...value, local: { ...value.local, username: 'q' } })));
  let first!: Promise<boolean>, second!: Promise<boolean>;
  act(() => { first = result.current.flush(); });
  act(() => result.current.change(value => ({ ...value, local: { ...value.local, username: 'qiao', port: '3390' } })));
  act(() => { second = result.current.flush(); });
  expect(writes).toHaveLength(1);
  await act(async () => { finish({ ok: true }); expect(await first).toBe(true); expect(await second).toBe(true); });
  expect(writes).toHaveLength(2); expect(JSON.parse(writes[1]).local).toMatchObject({ username: 'qiao', port: '3390' });
  expect(result.current.saveState).toBe('saved');
});
it('keeps edits after a failed save and exposes a working retry', async () => {
  let fail = true;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => options?.method === 'PUT' ? { ok: !fail } : { ok: true, json: async () => ({ configured: true, preferences: defaultComputerPreferences('linux') }) }));
  const { result } = renderHook(() => useComputerPreferences('ubuntu')); await waitFor(() => expect(result.current.loaded).toBe(true));
  act(() => result.current.change(value => ({ ...value, viewOnly: true })));
  await act(async () => { expect(await result.current.flush()).toBe(false); });
  expect(result.current.saveState).toBe('error'); expect(result.current.preferences.viewOnly).toBe(true);
  fail = false; await act(async () => { expect(await result.current.flush()).toBe(true); }); expect(result.current.saveState).toBe('saved');
});
it('aborts old-service saves and ignores their late results after switching services', async () => {
  let finish!: (value: unknown) => void; let signal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method === 'PUT') { signal = options.signal as AbortSignal; return new Promise(resolve => { finish = resolve; }); }
    return { ok: true, json: async () => ({ configured: true, preferences: defaultComputerPreferences('darwin') }) };
  }));
  const { result, rerender } = renderHook(({ id }) => useComputerPreferences(id), { initialProps: { id: 'ubuntu' } });
  await waitFor(() => expect(result.current.loaded).toBe(true)); act(() => result.current.change(value => ({ ...value, local: { ...value.local, username: 'old-service-user' } })));
  let pending!: Promise<boolean>; act(() => { pending = result.current.flush(); }); rerender({ id: 'mac' });
  await waitFor(() => expect(result.current.loaded).toBe(true)); expect(signal?.aborted).toBe(true);
  await act(async () => { finish({ ok: true }); expect(await pending).toBe(false); });
  expect(result.current.preferences.local.username).toBe(''); expect(result.current.preferences.local.protocol).toBe('vnc'); expect(result.current.saveState).toBe('saved');
});
it('aborts an old-service credential retrieval and never accepts its late password', async () => {
  let finish!: (value: unknown) => void; let signal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes('/credentials/')) { signal = options?.signal as AbortSignal; return new Promise(resolve => { finish = resolve; }); }
    return { ok: true, json: async () => ({ configured: true, preferences: defaultComputerPreferences('linux'), credentialKeys: [] }) };
  }));
  const { result, rerender } = renderHook(({ id }) => useComputerPreferences(id), { initialProps: { id: 'old' } });
  await waitFor(() => expect(result.current.loaded).toBe(true));
  let request!: Promise<string | undefined>; act(() => { request = result.current.credentialRequest('use', result.current.preferences.local); });
  await waitFor(() => expect(signal).toBeDefined());
  rerender({ id: 'new' }); await waitFor(() => expect(result.current.loaded).toBe(true)); expect(signal?.aborted).toBe(true);
  await act(async () => {
    finish({ ok: true, json: async () => ({ password: 'old-service-secret' }) });
    await expect(request).rejects.toThrow('COMPUTER_CREDENTIALS_FAILED');
  });
  expect(result.current.credentialKeys).toEqual([]); expect(result.current.loginState).toBe('idle');
});
