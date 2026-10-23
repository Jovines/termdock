// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ControlEvent } from '../utils/clientStateSync';
import type { TermdockUpdateState } from './api';

const mocks = vi.hoisted(() => ({
  get: vi.fn(), subscribe: vi.fn(), target: { id: 'a' },
}));
vi.mock('./api', () => ({ getTermdockUpdateState: mocks.get }));
vi.mock('../federation/browserIntegration', () => ({
  SECURE_STATE_EVENT: 'secure-state', savedConnection: () => mocks.target,
}));
vi.mock('../utils/clientStateSync', () => ({ subscribeClientState: mocks.subscribe }));
import { useTermdockUpdateState } from './useTermdockUpdateState';

const ready: TermdockUpdateState = {
  status: 'ready', currentVersion: '1.4.350', latestVersion: '1.4.351',
  source: 'official', checkedAt: 1, error: null,
};
const current: TermdockUpdateState = { ...ready, status: 'current', currentVersion: '1.4.351' };
let push: (event: ControlEvent) => void;
let unsubscribe: ReturnType<typeof vi.fn>;
function deferred() {
  let resolve!: (state: TermdockUpdateState) => void;
  const promise = new Promise<TermdockUpdateState>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.target = { id: 'a' };
  unsubscribe = vi.fn();
  mocks.subscribe.mockImplementation(listener => { push = listener; return unsubscribe; });
});
afterEach(cleanup);

it('a late initial read cannot resurrect an update already consumed by another client', async () => {
  const initial = deferred();
  mocks.get.mockReturnValueOnce(initial.promise);
  const { result } = renderHook(useTermdockUpdateState);
  act(() => push({ type: 'update-state', state: current }));
  await act(async () => initial.resolve(ready));
  expect(result.current.state).toEqual(current);
});

it('refreshes on foreground and page restoration even if no control push arrived', async () => {
  mocks.get.mockResolvedValueOnce(ready).mockResolvedValue(current);
  const { result } = renderHook(useTermdockUpdateState);
  await act(async () => {});
  expect(result.current.state).toEqual(ready);
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(result.current.state).toEqual(current);
  await act(async () => window.dispatchEvent(new Event('pageshow')));
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(mocks.get).toHaveBeenCalledTimes(4);
});

it('clears a previous connection reminder and ignores its in-flight response', async () => {
  const previous = deferred(), next = deferred();
  mocks.get.mockReturnValueOnce(previous.promise).mockReturnValueOnce(next.promise);
  const { result } = renderHook(useTermdockUpdateState);
  act(() => push({ type: 'update-state', state: ready }));
  act(() => {
    mocks.target = { id: 'b' };
    window.dispatchEvent(new Event('secure-state'));
  });
  expect(result.current.state).toBeNull();
  await act(async () => previous.resolve(ready));
  expect(result.current.state).toBeNull();
  await act(async () => next.resolve(current));
  expect(result.current.state).toEqual(current);
});

it('a failed refresh cannot fabricate a pending update, and a later reconnect recovers', async () => {
  mocks.get.mockResolvedValueOnce(ready).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(current);
  const { result } = renderHook(useTermdockUpdateState);
  await act(async () => {});
  await act(async () => window.dispatchEvent(new Event('secure-state')));
  expect(result.current.state).toBeNull();
  await act(async () => window.dispatchEvent(new Event('secure-state')));
  expect(result.current.state).toEqual(current);
});

it('action responses win over pending reads and unmount removes lifecycle listeners', async () => {
  const initial = deferred();
  mocks.get.mockReturnValueOnce(initial.promise);
  const { result, unmount } = renderHook(useTermdockUpdateState);
  act(() => result.current.apply(current));
  await act(async () => initial.resolve(ready));
  expect(result.current.state).toEqual(current);
  unmount();
  window.dispatchEvent(new Event('pageshow'));
  window.dispatchEvent(new Event('secure-state'));
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(mocks.get).toHaveBeenCalledOnce();
});
