// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Reconnection policy sits above the encrypted transport; simulate its socket facade.
vi.mock('../federation/browserIntegration', () => ({ secureSocket: (url: string) => new WebSocket(url) }));
import { createTermdockAPI } from './factory';
import {
  connectTerminalStream,
  probeTerminalConnection,
  reconnectTerminalConnectionNow,
  suspendTerminalConnectionReconnects,
  resizeTerminal,
  VISIBLE_WAKEUP_PROBE_TIMEOUT_MS,
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
  it('preserves the retry across error followed by close after waking', () => {
    const onEvent = vi.fn();
    const disconnect = connectTerminalStream('wake-error-close', onEvent, vi.fn(), {
      initialRetryDelay: 10,
    });
    const first = FakeWebSocket.instances[0];
    first.readyState = FakeWebSocket.OPEN;
    first.onopen?.();
    suspendTerminalConnectionReconnects();
    probeTerminalConnection('wake-error-close', undefined, { visible: true });
    first.fail();
    vi.advanceTimersByTime(5);
    first.closeFromServer(1006, '');
    first.fail();
    vi.advanceTimersByTime(5);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const recovered = FakeWebSocket.instances[1];
    recovered.readyState = FakeWebSocket.OPEN;
    recovered.onopen?.();
    recovered.onmessage?.(new MessageEvent('message', {
      data: JSON.stringify({ type: 'connected' }),
    }));
    expect(onEvent).toHaveBeenLastCalledWith({ type: 'connected' });
    disconnect();
  });

  it('ignores delayed open and exit events from the socket replaced on resume', () => {
    const onEvent = vi.fn();
    const disconnect = connectTerminalStream('stale-wake-events', onEvent, vi.fn(), {
      connectionTimeout: 100,
      initialRetryDelay: 10,
    });
    const stale = FakeWebSocket.instances[0];
    reconnectTerminalConnectionNow('stale-wake-events');
    vi.advanceTimersByTime(0);
    stale.onopen?.();
    stale.onmessage?.(new MessageEvent('message', {
      data: JSON.stringify({ type: 'exit' }),
    }));
    expect(onEvent).not.toHaveBeenCalledWith({ type: 'exit' });
    // The old open event must not cancel the new handshake deadline.
    vi.advanceTimersByTime(120);
    expect(FakeWebSocket.instances).toHaveLength(3);
    disconnect();
  });

  it('recovers a dead heartbeat even when close never emits an event', () => {
    const disconnect = connectTerminalStream('silent-close', vi.fn(), vi.fn(), {
      initialRetryDelay: 10,
    });
    const socket = FakeWebSocket.instances[0];
    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen?.();
    vi.spyOn(socket, 'close').mockImplementation(() => {
      socket.readyState = FakeWebSocket.CLOSING;
    });
    vi.advanceTimersByTime(28_010);
    expect(FakeWebSocket.instances).toHaveLength(2);
    disconnect();
  });

  it('reconnects an unresponsive visible pane before the background probe expires', () => {
    const closeVisible = connectTerminalStream('visible-dead', vi.fn());
    const closeBackground = connectTerminalStream('background-dead', vi.fn());
    for (const socket of FakeWebSocket.instances) {
      socket.readyState = FakeWebSocket.OPEN;
      socket.onopen?.();
    }
    probeTerminalConnection('background-dead');
    probeTerminalConnection('visible-dead', undefined, { visible: true });
    vi.advanceTimersByTime(VISIBLE_WAKEUP_PROBE_TIMEOUT_MS + 1);
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(FakeWebSocket.instances[2].url).toContain('/visible-dead/');
    vi.advanceTimersByTime(1_500);
    expect(FakeWebSocket.instances[3].url).toContain('/background-dead/');
    closeVisible();
    closeBackground();
  });

  it('promotes a pending background probe without a second ping or stale timeout', () => {
    const close = connectTerminalStream('promoted-probe', vi.fn());
    const socket = FakeWebSocket.instances[0];
    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen?.();
    const send = vi.spyOn(socket, 'send');
    const responsive = vi.fn();
    probeTerminalConnection('promoted-probe', responsive);
    vi.advanceTimersByTime(100);
    probeTerminalConnection('promoted-probe', responsive, { visible: true });
    vi.advanceTimersByTime(20);
    socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'pong' }) }));
    expect(responsive).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_600);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    close();
  });

  it('coalesces wake probes and replaces an unresponsive OPEN socket once', () => {
    const disconnect = connectTerminalStream('half-open-probe', vi.fn());
    const socket = FakeWebSocket.instances[0];
    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen?.();
    const send = vi.spyOn(socket, 'send');
    const responsive = vi.fn();
    probeTerminalConnection('half-open-probe', responsive);
    probeTerminalConnection('half-open-probe', responsive);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_501);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(responsive).not.toHaveBeenCalled();
    disconnect();
  });

  it('uses the measured viewport on the first connection and reads it again on reconnect', () => {
    let dimensions = { cols: 58, rows: 40 };
    const subscription = createTermdockAPI().connect('initial-geometry', { onEvent: vi.fn() }, {
      getDimensions: () => dimensions,
    });
    const initial = new URL(FakeWebSocket.instances[0].url).searchParams;
    expect(initial.get('cols')).toBe('58');
    expect(initial.get('rows')).toBe('40');

    dimensions = { cols: 112, rows: 32 };
    reconnectTerminalConnectionNow('initial-geometry');
    vi.advanceTimersByTime(0);
    const reconnected = new URL(FakeWebSocket.instances[1].url).searchParams;
    expect(reconnected.get('cols')).toBe('112');
    expect(reconnected.get('rows')).toBe('32');
    subscription.close();
  });

  it('reconnects with the keyboard-closed grid without shrinking to metadata dimensions', async () => {
    const disconnect = connectTerminalStream('resume-geometry', vi.fn());
    const first = FakeWebSocket.instances[0];
    first.readyState = FakeWebSocket.OPEN;
    await resizeTerminal('resume-geometry', 58, 20);
    await resizeTerminal('resume-geometry', 58, 40);
    reconnectTerminalConnectionNow('resume-geometry');
    vi.advanceTimersByTime(0);
    const params = new URL(FakeWebSocket.instances[1].url).searchParams;
    expect(params.get('cols')).toBe('58');
    expect(params.get('rows')).toBe('40');
    disconnect();
  });

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
    expect(onResponsive).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_499);

    expect(onResponsive).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);

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
