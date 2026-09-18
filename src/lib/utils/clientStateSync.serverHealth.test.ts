// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ secureSocket: vi.fn() }));
vi.mock('../federation/browserIntegration', () => ({ secureSocket: mocks.secureSocket }));
import { subscribeClientState, __resetClientStateSyncForTests } from './clientStateSync';
afterEach(() => { __resetClientStateSyncForTests(); vi.clearAllMocks(); });

function connectControlSocket() {
  const sockets: Array<{ onmessage?: (event: { data: string }) => void; close: () => void }> = [];
  mocks.secureSocket.mockImplementation(() => { const socket = { close: vi.fn() }; sockets.push(socket); return socket; });
  const listener = vi.fn();
  const unsubscribe = subscribeClientState(listener);
  return { listener, unsubscribe, push: (payload: unknown) => sockets[0].onmessage!({ data: JSON.stringify(payload) }) };
}

const STATE = {
  supervised: true,
  supervisor: { pid: 42, alive: true, phase: 'running', restarts: 1, consecutiveCrashes: 1 },
  incident: null,
  dismissedAt: null,
  attention: true,
  generatedAt: 1,
};

it('把服务健康快照交给监听者', () => {
  const { listener, unsubscribe, push } = connectControlSocket();
  push({ type: 'server-health', state: STATE });
  expect(listener).toHaveBeenCalledWith({ type: 'server-health', state: STATE });
  unsubscribe();
});

it('缺 attention/supervised 的快照当作没收到——红点的显示条件不能靠猜', () => {
  const { listener, unsubscribe, push } = connectControlSocket();
  push({ type: 'server-health', state: { ...STATE, attention: undefined } });
  push({ type: 'server-health', state: { ...STATE, supervised: 'yes' } });
  push({ type: 'server-health' });
  expect(listener).not.toHaveBeenCalled();
  unsubscribe();
});
