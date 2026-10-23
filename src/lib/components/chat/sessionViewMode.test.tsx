// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSessionViewMode } from './sessionViewMode';
const connection = vi.hoisted(() => ({ client: { closed: false } }));
vi.mock('../../federation/browserIntegration', () => ({ currentSecureClient: () => connection.client, savedConnection: () => undefined }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
it('loads server state, follows another client, and restores the persisted mode after remount', async () => {
  let mode = 'chat';
  vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => { if (init?.method === 'PUT') mode = JSON.parse(String(init.body)).mode; return Response.json({ mode, updatedAt: 1 }); }));
  const first = renderHook(() => useSessionViewMode('sync'));
  await waitFor(() => expect(first.result.current[0]).toBe('chat'));
  mode = 'terminal'; act(() => window.dispatchEvent(new Event('online'))); await waitFor(() => expect(first.result.current[0]).toBe('terminal'));
  act(() => first.result.current[1]('chat')); await waitFor(() => expect(mode).toBe('chat'));
  first.unmount(); const reopened = renderHook(() => useSessionViewMode('sync')); await waitFor(() => expect(reopened.result.current[0]).toBe('chat'));
});
it('serializes rapid toggles and ignores an older GET completing after a local choice', async () => {
  let resolveRead!: (value: Response) => void, resolveWrite!: (value: Response) => void;
  const writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn((_url, init?: RequestInit) => {
    if (!init?.method) return new Promise<Response>(resolve => { resolveRead = resolve; });
    const mode = JSON.parse(String(init.body)).mode; writes.push(mode);
    if (writes.length === 1) return new Promise<Response>(resolve => { resolveWrite = resolve; });
    return Promise.resolve(Response.json({ mode, updatedAt: 2 }));
  }));
  const f = renderHook(() => useSessionViewMode('rapid'));
  act(() => { f.result.current[1]('chat'); f.result.current[1]('terminal'); }); expect(writes).toEqual(['chat']);
  await act(async () => resolveRead(Response.json({ mode: 'chat', updatedAt: 0 }))); expect(f.result.current[0]).toBe('terminal');
  await act(async () => resolveWrite(Response.json({ mode: 'chat', updatedAt: 1 })));
  await waitFor(() => expect(writes).toEqual(['chat', 'terminal'])); expect(f.result.current[0]).toBe('terminal');
});
it('resumes synchronization after reconnect and discards responses from the previous connection', async () => {
  let resolveOld!: (value: Response) => void;
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn((_url, init?: RequestInit) => {
    if (!init?.method && ++reads === 1) return new Promise<Response>(resolve => { resolveOld = resolve; });
    return Promise.resolve(Response.json({ mode: 'chat', updatedAt: 2 }));
  }));
  const f = renderHook(() => useSessionViewMode('reconnect'));
  connection.client.closed = true;
  connection.client = { closed: false };
  await act(async () => resolveOld(Response.json({ mode: 'terminal', updatedAt: 1 })));
  act(() => window.dispatchEvent(new Event('online')));
  await waitFor(() => expect(f.result.current[0]).toBe('chat'));
  expect(reads).toBe(2);
});
