// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDirectoryListing } from './useDirectoryListing';

const { list, cancel } = vi.hoisted(() => ({ list: vi.fn(), cancel: vi.fn() }));
vi.mock('../terminal/api', () => ({ listDirectory: list, cancelIoSlot: cancel }));

beforeEach(() => { list.mockReset(); cancel.mockReset(); });
afterEach(cleanup);

describe('shared directory listing lifecycle', () => {
  it('ignores late results and cancels only the old request when navigating', async () => {
    let finish!: (result: { path: string; entries: [] }) => void;
    list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce({ path: '/new', entries: [] });
    const loaded = vi.fn();
    const view = renderHook(({ path }) => useDirectoryListing({ path, onLoad: loaded }), { initialProps: { path: '/old' } });
    const oldSignal = list.mock.calls[0][1];
    const oldSlot = list.mock.calls[0][4];
    view.rerender({ path: '/new' });
    expect(oldSignal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledWith(oldSlot);
    expect(list.mock.calls[1][4]).not.toBe(oldSlot);
    await waitFor(() => expect(view.result.current.result?.path).toBe('/new'));
    await act(async () => finish({ path: '/old', entries: [] }));
    expect(view.result.current.result?.path).toBe('/new');
    expect(loaded).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(list.mock.calls[1][1].aborted).toBe(true);
  });

  it('retries a failed folder with a new slot and clears the error', async () => {
    list.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ path: '/repo', entries: [], truncated: true });
    const { result } = renderHook(() => useDirectoryListing({ path: '/repo', showHidden: true, gitIgnoreRoot: '/repo', sortMode: 'modified' }));
    await waitFor(() => expect(result.current.error).toBe('offline'));
    expect(result.current.loading).toBe(false);
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.result?.truncated).toBe(true));
    expect(result.current.error).toBeNull();
    expect(list.mock.calls[1][4]).not.toBe(list.mock.calls[0][4]);
    expect(list.mock.calls[1].slice(5)).toEqual(['modified', '/repo']);
  });

  it('keeps two browsers of the same directory independent', async () => {
    list.mockImplementation(() => new Promise(() => {}));
    const first = renderHook(() => useDirectoryListing({ path: '/repo' }));
    const second = renderHook(() => useDirectoryListing({ path: '/repo' }));
    const [firstCall, secondCall] = list.mock.calls;
    expect(firstCall[4]).not.toBe(secondCall[4]);
    first.unmount();
    expect(firstCall[1].aborted).toBe(true);
    expect(secondCall[1].aborted).toBe(false);
    expect(cancel).not.toHaveBeenCalledWith(secondCall[4]);
    second.unmount();
  });
});
