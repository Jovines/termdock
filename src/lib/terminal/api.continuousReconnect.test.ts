// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectTerminalStream,
  probeTerminalConnection,
  reconnectTerminalConnectionNow,
  suspendTerminalConnectionReconnects,
} from './api';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = FakeWebSocket.CONNECTING;
  readonly OPEN = FakeWebSocket.OPEN;
  readonly CLOSING = FakeWebSocket.CLOSING;
  readonly CLOSED = FakeWebSocket.CLOSED;

  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(): void {}

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }

  fail(): void {
    this.onerror?.();
  }

  closeFromServer(code: number, reason: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }
}

describe('connectTerminalStream reconnect policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps reconnecting after the backoff step limit is reached', () => {
    const onError = vi.fn();
    const disconnect = connectTerminalStream('continuous-reconnect', vi.fn(), onError, {
      maxRetries: 2,
      initialRetryDelay: 10,
      maxRetryDelay: 20,
      connectionTimeout: 1_000,
    });

    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.instances[0].fail();
    vi.advanceTimersByTime(10);
    FakeWebSocket.instances[1].fail();
    vi.advanceTimersByTime(20);
    FakeWebSocket.instances[2].fail();
    vi.advanceTimersByTime(20);

    expect(FakeWebSocket.instances).toHaveLength(4);
    expect(onError).not.toHaveBeenCalled();

    disconnect();
  });

  it('still stops for an explicit authentication failure', () => {
    const onError = vi.fn();
    connectTerminalStream('auth-failure', vi.fn(), onError, {
      maxRetries: 2,
      initialRetryDelay: 10,
      maxRetryDelay: 20,
      connectionTimeout: 1_000,
    });

    FakeWebSocket.instances[0].closeFromServer(4401, 'Authentication required');
    vi.advanceTimersByTime(1_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Authentication required',
    }), true);
  });

  it('schedules only one reconnect when the connection handshake times out', () => {
    connectTerminalStream('handshake-timeout', vi.fn(), vi.fn(), {
      maxRetries: 2,
      initialRetryDelay: 10,
      maxRetryDelay: 20,
      connectionTimeout: 100,
    });

    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(10);

    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('parks background retry timers until the session is explicitly resumed', () => {
    const disconnect = connectTerminalStream('background-retry', vi.fn(), vi.fn(), {
      initialRetryDelay: 10,
      connectionTimeout: 1_000,
    });

    FakeWebSocket.instances[0].fail();
    suspendTerminalConnectionReconnects();
    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(1);

    expect(probeTerminalConnection('background-retry')).toBe(true);
    vi.runOnlyPendingTimers();
    expect(FakeWebSocket.instances).toHaveLength(2);

    disconnect();
  });

  it('reports an open connection responsive after its wake probe receives data', () => {
    const onResponsive = vi.fn();
    const disconnect = connectTerminalStream('responsive-probe', vi.fn(), vi.fn());
    const socket = FakeWebSocket.instances[0];
    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen?.();
    suspendTerminalConnectionReconnects();

    expect(probeTerminalConnection('responsive-probe', onResponsive)).toBe(true);
    vi.advanceTimersByTime(1);
    socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'pong' }) }));
    vi.advanceTimersByTime(1_499);

    expect(onResponsive).toHaveBeenCalledTimes(1);

    // The explicit foreground probe also unfreezes normal retry behavior.
    socket.fail();
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    disconnect();
  });

  it('replaces the foreground socket immediately without waiting for the probe timeout', () => {
    const disconnect = connectTerminalStream('foreground-resume', vi.fn(), vi.fn());
    const socket = FakeWebSocket.instances[0];
    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen?.();
    suspendTerminalConnectionReconnects();

    expect(reconnectTerminalConnectionNow('foreground-resume')).toBe(true);
    vi.advanceTimersByTime(0);

    expect(FakeWebSocket.instances).toHaveLength(2);
    disconnect();
  });
});
