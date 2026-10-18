// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise attach lifetime above the existing encrypted transport facade.
vi.mock('../federation/browserIntegration', () => ({
  secureSocket: (url: string) => new WebSocket(url),
}));

import { closeTerminal, connectTerminalStream, reconnectTerminalConnectionNow, resetCsrfTokenCache, sendTerminalInput, sendTmuxAction, TerminalInputError } from './api';
import { PacketQueueBackpressureError } from '../../server/federation/packets.js';

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

  it('keeps the rejected and remaining queued input after a synchronous frame refusal', async () => {
    const disconnect = connectTerminalStream('input-refusal-order', vi.fn(), vi.fn());
    const socket = FakeWebSocket.instances.at(-1)!;
    await sendTerminalInput('input-refusal-order', 'first');
    await sendTerminalInput('input-refusal-order', 'second');
    await sendTerminalInput('input-refusal-order', 'third');
    const attempted: string[] = [];
    const accepted: string[] = [];
    socket.send.mockImplementationOnce((message: string) => { attempted.push(message); accepted.push(message); });
    socket.send.mockImplementationOnce((message: string) => { attempted.push(message); throw new PacketQueueBackpressureError(); });
    socket.open();
    expect(attempted).toEqual([
      JSON.stringify({ type: 'input', data: 'first' }),
      JSON.stringify({ type: 'input', data: 'second' }),
    ]);
    socket.send.mockImplementation(message => { attempted.push(message); accepted.push(message); });
    vi.advanceTimersByTime(50);
    expect(attempted).toEqual([
      JSON.stringify({ type: 'input', data: 'first' }),
      JSON.stringify({ type: 'input', data: 'second' }),
      JSON.stringify({ type: 'input', data: 'second' }),
      JSON.stringify({ type: 'input', data: 'third' }),
    ]);
    expect(attempted.filter(message => message === JSON.stringify({ type: 'input', data: 'first' }))).toHaveLength(1);
    expect(accepted).toEqual([
      JSON.stringify({ type: 'input', data: 'first' }),
      JSON.stringify({ type: 'input', data: 'second' }),
      JSON.stringify({ type: 'input', data: 'third' }),
    ]);
    disconnect();
  });

  it('releases sent input slots during repeated partial progress without draining the queue', async () => {
    const disconnect = connectTerminalStream('input-partial-progress', vi.fn(), vi.fn());
    const socket = FakeWebSocket.instances.at(-1)!;
    for (let index = 0; index < 70; index++) await sendTerminalInput('input-partial-progress', `initial-${index}`);
    const accepted: string[] = [];
    let inputAttempts = 0;
    socket.send.mockImplementation((message: string) => {
      const parsed = JSON.parse(message);
      if (parsed.type !== 'input') return;
      inputAttempts++;
      if (inputAttempts % 2 === 0) throw new PacketQueueBackpressureError();
      accepted.push(parsed.data);
    });
    socket.open();
    for (let index = 0; index < 70; index++) {
      await sendTerminalInput('input-partial-progress', `later-${index}`);
      vi.advanceTimersByTime(index === 0 ? 40 : 100);
    }
    for (let index = 0; index < 70; index++) vi.advanceTimersByTime(100);
    expect(accepted).toEqual([
      ...Array.from({ length: 70 }, (_, index) => `initial-${index}`),
      ...Array.from({ length: 70 }, (_, index) => `later-${index}`),
    ]);
    disconnect();
  });

  it('bounds CONNECTING input bytes and explicitly rejects oversized or excess paste', async () => {
    const disconnect = connectTerminalStream('bounded-input', vi.fn(), vi.fn());
    const socket = FakeWebSocket.instances.at(-1)!;
    await expect(sendTerminalInput('bounded-input', 'x'.repeat(1024 * 1024))).rejects.toThrow('frame limit');
    const piece = 'y'.repeat(4000);
    let accepted = 0;
    while (true) {
      try { await sendTerminalInput('bounded-input', piece); accepted++; }
      catch (error) { expect(String(error)).toContain('queue is full'); break; }
    }
    expect(accepted).toBeGreaterThan(0);
    socket.open();
    vi.advanceTimersByTime(40);
    expect(socket.send).toHaveBeenCalledTimes(accepted);
    expect(socket.send.mock.calls.every(([message]) => message === JSON.stringify({ type: 'input', data: piece }))).toBe(true);
    disconnect();
  });

  it('rejects an input whose real ws-data JSON envelope exceeds the record limit', async () => {
    const disconnect = connectTerminalStream('outer-frame-limit', vi.fn(), vi.fn());
    const socket = FakeWebSocket.instances.at(-1)!;
    const data = '"'.repeat(524_262);
    const message = JSON.stringify({ type: 'input', data });
    const messageBytes = new TextEncoder().encode(message).byteLength;
    const outer = JSON.stringify({ id: '0'.repeat(36), type: 'ws-data', data: message });
    expect(messageBytes).toBeLessThan(1024 * 1024);
    expect(new TextEncoder().encode(outer).byteLength).toBeGreaterThan(2 * 1024 * 1024);
    await expect(sendTerminalInput('outer-frame-limit', data)).rejects.toThrow('encrypted socket frame limit');
    socket.open();
    expect(socket.send).not.toHaveBeenCalled();
    disconnect();
  });

  it('surfaces permanent send errors once instead of retrying the same frame forever', async () => {
    const onError = vi.fn();
    const disconnect = connectTerminalStream('permanent-input-error', vi.fn(), onError);
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    socket.send.mockImplementation(() => { throw new Error('Record too large'); });
    await expect(sendTerminalInput('permanent-input-error', 'input'))
      .rejects.toMatchObject({ name: 'TerminalInputError', code: 'TERMINAL_INPUT_REJECTED', message: 'Record too large' });
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toBeInstanceOf(TerminalInputError);
    expect(onError.mock.calls[0][0].message).toBe('Record too large');
    expect(onError.mock.calls[0][1]).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(socket.send).toHaveBeenCalledTimes(1);
    disconnect();
  });

  it('bounds retries for persistent typed byte-budget backpressure', async () => {
    const onError = vi.fn();
    const disconnect = connectTerminalStream('persistent-input-backpressure', vi.fn(), onError);
    const socket = FakeWebSocket.instances.at(-1)!;
    await sendTerminalInput('persistent-input-backpressure', 'input');
    const inputMessage = JSON.stringify({ type: 'input', data: 'input' });
    let inputAttempts = 0;
    socket.send.mockImplementation((message: string) => {
      if (message !== inputMessage) return;
      inputAttempts++;
      throw new PacketQueueBackpressureError();
    });
    socket.open();
    vi.advanceTimersByTime(60_000);
    expect(inputAttempts).toBe(20);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].message).toContain('repeated encrypted-channel backpressure');
    expect(onError.mock.calls[0][1]).toBe(true);
    disconnect();
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

it('tmux copy responses stay on their encrypted socket and preserve selection metadata',async()=>{
 const a=attach('copy-a'),b=attach('copy-b');let resolved=false;
 const copying=sendTmuxAction('copy-a',{action:'copy-selection'}).then(value=>{resolved=true;return value;});
 const request=JSON.parse(a.socket.send.mock.lastCall![0]);expect(request.action).toBe('copy-selection');
 b.socket.receive({type:'tmux-result',reqId:request.reqId,success:true,selection:{status:'copied',paneId:'%2',text:'wrong',bytes:5}});await Promise.resolve();expect(resolved).toBe(false);
 a.socket.receive({type:'tmux-result',reqId:request.reqId,success:true,selection:{status:'copied',paneId:'%1',text:'owned',bytes:5}});
 expect(await copying).toMatchObject({selection:{paneId:'%1',text:'owned',bytes:5}});expect(b.socket.send).not.toHaveBeenCalled();
});

for(const message of ['Tmux selection exceeds the 256 KiB copy limit','Tmux selection read failed','Tmux selection target changed while copying'])it(`correlated tmux copy rejects immediately: ${message}`,async()=>{
 const {socket}=attach('copy-error');const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
 const copying=sendTmuxAction('copy-error',{action:'copy-selection'});const rejected=expect(copying).rejects.toThrow(message);
 const request=JSON.parse(socket.send.mock.lastCall![0]);socket.receive({type:'tmux-result',reqId:request.reqId,success:false,error:message});await rejected;expect(fetchMock).not.toHaveBeenCalled();
});

it('new input cannot bypass an active backpressure retry timer',async()=>{
 const {socket}=attach('input-backoff');
 socket.send.mockImplementationOnce(()=>{throw new PacketQueueBackpressureError();});
 await sendTerminalInput('input-backoff','first');expect(socket.send).toHaveBeenCalledTimes(1);
 await sendTerminalInput('input-backoff','second');await sendTerminalInput('input-backoff','third');
 expect(socket.send).toHaveBeenCalledTimes(1);vi.advanceTimersByTime(49);expect(socket.send).toHaveBeenCalledTimes(1);
 vi.advanceTimersByTime(1);expect(socket.send.mock.calls.slice(1).map(([raw])=>JSON.parse(raw).data)).toEqual(['first','second','third']);
 const disconnect=disconnects.pop()!;disconnect();expect(vi.getTimerCount()).toBe(0);
});
