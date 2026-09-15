// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ secureSocket: vi.fn() }));
vi.mock('../federation/browserIntegration', () => ({ secureSocket: mocks.secureSocket }));
import { subscribeClientState, __resetClientStateSyncForTests } from './clientStateSync';
afterEach(() => { __resetClientStateSyncForTests(); vi.useRealTimers(); vi.clearAllMocks(); });

it('receives reminders on initial secure control connection and after reconnect, without HTTP fallback', () => {
  vi.useFakeTimers();
  const sockets: Array<{ onmessage?: (event: { data: string }) => void; onclose?: () => void; close: () => void }> = [];
  mocks.secureSocket.mockImplementation(() => { const socket = { close: vi.fn() }; sockets.push(socket); return socket; });
  const fallback = vi.spyOn(globalThis, 'fetch');
  const listener = vi.fn();
  const unsubscribe = subscribeClientState(listener);
  const notice = { type: 'session-notice', id: '1', sessionId: 'source', sessionName: 'Build', message: 'Complete', createdAt: 1 };
  sockets[0].onmessage!({ data: JSON.stringify(notice) });
  expect(listener).toHaveBeenCalledWith(notice);
  sockets[0].onmessage!({ data: JSON.stringify({ ...notice, message: 123 }) });
  expect(listener).toHaveBeenCalledTimes(1);
  sockets[0].onclose!();
  mocks.secureSocket.mockImplementationOnce(() => { throw new Error('Disconnected'); });
  vi.advanceTimersByTime(1000);
  expect(listener).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(2000);
  sockets[1].onmessage!({ data: JSON.stringify({ ...notice, id: '2' }) });
  expect(listener).toHaveBeenCalledTimes(2);
  expect(mocks.secureSocket).toHaveBeenCalledTimes(3);
  expect(mocks.secureSocket).toHaveBeenCalledWith(expect.stringContaining('/api/control/ws'));
  expect(fallback).not.toHaveBeenCalled();
  fallback.mockRestore(); unsubscribe();
});
