// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise attach lifetime above the existing encrypted transport facade.
vi.mock('../federation/browserIntegration', () => ({
  secureSocket: (url: string) => new WebSocket(url),
}));

import { closeTerminal, connectTerminalStream, reconnectTerminalConnectionNow, resetCsrfTokenCache, sendTerminalInput } from './api';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code: 1000 }));
  });

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(data: Record<string, unknown>): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }
}

const disconnects: Array<() => void> = [];

function attach(sessionId = 'close-session') {
  const onEvent = vi.fn();
  disconnects.push(connectTerminalStream(sessionId, onEvent, vi.fn(), { initialRetryDelay: 10 }));
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  return { socket, onEvent };
}

function mockDelete(operation: () => Promise<Response>) {
  let started!: () => void;
  const deleteStarted = new Promise<void>(resolve => { started = resolve; });
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/csrf-token') {
      return Promise.resolve(new Response(JSON.stringify({ csrfToken: 'test-token' }), { status: 200 }));
    }
    expect(String(input)).toBe('/api/terminal/close-session');
    expect(init?.method).toBe('DELETE');
    expect(init?.headers).toEqual({ 'X-XSRF-TOKEN': 'test-token' });
    started();
    return operation();
  });
  vi.stubGlobal('fetch', fetchMock);
  return { deleteStarted, fetchMock };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  resetCsrfTokenCache();
});

afterEach(() => {
  disconnects.splice(0).forEach(disconnect => disconnect());
  resetCsrfTokenCache();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('closeTerminal attach lifetime', () => {
  it('keeps input and output usable while DELETE is pending, then closes on confirmation', async () => {
    let resolveDelete!: (response: Response) => void;
    const { deleteStarted } = mockDelete(() => new Promise(resolve => { resolveDelete = resolve; }));
    const { socket, onEvent } = attach();
    const closing = closeTerminal('close-session');
    await deleteStarted;

    expect(socket.close).not.toHaveBeenCalled();
    await sendTerminalInput('close-session', 'still attached');
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'input', data: 'still attached' }));
    socket.receive({ type: 'data', data: 'output while closing' });
    expect(onEvent).toHaveBeenCalledWith({ type: 'data', data: 'output while closing' });

    resolveDelete(new Response(null, { status: 204 }));
    await closing;
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(reconnectTerminalConnectionNow('close-session')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(20_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it.each([403, 500])('retains input and reconnection after DELETE returns %s', async status => {
    mockDelete(() => Promise.resolve(new Response(JSON.stringify({ error: 'Close rejected' }), { status })));
    const { socket } = attach();
    await expect(closeTerminal('close-session')).rejects.toThrow('Close rejected');
    expect(socket.close).not.toHaveBeenCalled();
    await sendTerminalInput('close-session', 'retry later');
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'input', data: 'retry later' }));

    socket.close();
    vi.advanceTimersByTime(10);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const replacement = FakeWebSocket.instances[1];
    await sendTerminalInput('close-session', 'buffered while reconnecting');
    replacement.open();
    expect(replacement.send).toHaveBeenCalledWith(JSON.stringify({ type: 'input', data: 'buffered while reconnecting' }));
  });

  it('retains the attach after a rejected DELETE transport request', async () => {
    mockDelete(() => Promise.reject(new Error('Encrypted connection unavailable')));
    const { socket } = attach();
    await expect(closeTerminal('close-session')).rejects.toThrow('Encrypted connection unavailable');
    expect(socket.close).not.toHaveBeenCalled();
    await sendTerminalInput('close-session', 'still usable');
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'input', data: 'still usable' }));
  });

  it('retains the attach when CSRF preparation fails before DELETE', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('CSRF unavailable'));
    vi.stubGlobal('fetch', fetchMock);
    const { socket } = attach();
    await expect(closeTerminal('close-session')).rejects.toThrow('CSRF unavailable');
    expect(socket.close).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/csrf-token', expect.anything());
    await sendTerminalInput('close-session', 'continue');
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'input', data: 'continue' }));
  });

  it('treats 404 as confirmed removal and closes the attach', async () => {
    mockDelete(() => Promise.resolve(new Response(null, { status: 404 })));
    const { socket } = attach();
    await expect(closeTerminal('close-session')).resolves.toBeUndefined();
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(reconnectTerminalConnectionNow('close-session')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes the replacement socket when the attach reconnects during DELETE', async () => {
    let resolveDelete!: (response: Response) => void;
    const { deleteStarted } = mockDelete(() => new Promise(resolve => { resolveDelete = resolve; }));
    const { socket } = attach();
    const closing = closeTerminal('close-session');
    await deleteStarted;
    socket.close();
    vi.advanceTimersByTime(10);
    const replacement = FakeWebSocket.instances[1];
    replacement.open();
    expect(replacement.close).not.toHaveBeenCalled();

    resolveDelete(new Response(null, { status: 204 }));
    await closing;
    expect(replacement.close).toHaveBeenCalledTimes(1);
    expect(reconnectTerminalConnectionNow('close-session')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(20_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
