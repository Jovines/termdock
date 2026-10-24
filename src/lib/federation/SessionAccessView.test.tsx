// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { SessionAccessView } from './SessionAccessView';
import type { SecureClient } from './secureClient';
const mocks = vi.hoisted(() => ({ writes: [] as Array<{ data: string; callback?: () => void }>, resize: vi.fn(), options: {} as Record<string, unknown>, fit: vi.fn(), fontsReady: Promise.resolve(), dimensions: { cols: 120, rows: 40 } }));
vi.mock('../terminal/fontLoading', () => ({ ensureTerminalFontsReady: () => mocks.fontsReady }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24;
  options: Record<string, unknown>;
  buffer = { active: { type: 'normal', baseY: 0, viewportY: 0 } };
  constructor(options: Record<string, unknown>) { mocks.options = options; this.options = options; }
  loadAddon() {} open() {} dispose() {}
  write(data: string, callback?: () => void) { mocks.writes.push({ data, callback }); }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; mocks.resize(cols, rows); }
  scrollToBottom() {} refresh() {}
  onData() { return { dispose() {} }; }
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions() { mocks.fit(); return mocks.dimensions; } } }));
beforeEach(() => { mocks.fontsReady = Promise.resolve(); mocks.dimensions = { cols: 120, rows: 40 }; });
afterEach(() => { cleanup(); mocks.writes.length = 0; vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('scoped encrypted terminal viewer', () => {
  it('sends resize only when its measured grid differs from the connected or pending grid', async () => {
    let notify = () => {};
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { notify = callback; } observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1000, height: 600 } as DOMRect);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    const socket = { readyState: 1, send: vi.fn(), close: vi.fn(), onopen: null as (() => void) | null, onmessage: null as ((event: { data: string }) => void) | null };
    const client = { targetPeerId: 'resize-dedup', request: vi.fn(async () => ({ items: [{ sessionId: 'backend', name: 'task', live: true, canWrite: true, canResize: true }] })), openSocket: vi.fn(() => socket) };
    render(<SessionAccessView client={client as unknown as SecureClient} />);
    await waitFor(() => expect(client.openSocket).toHaveBeenCalledOnce());
    act(() => socket.onopen!());
    expect(socket.send).not.toHaveBeenCalled();
    act(() => {
      socket.onmessage!({ data: JSON.stringify({ type: 'connected', cols: 120, rows: 40 }) });
      mocks.writes.at(-1)!.callback!(); notify(); notify();
    });
    expect(socket.send).not.toHaveBeenCalled();
    act(() => { mocks.dimensions = { cols: 121, rows: 40 }; notify(); notify(); });
    expect(socket.send).toHaveBeenCalledOnce();
    const request = JSON.parse(socket.send.mock.calls[0][0]);
    expect(request).toMatchObject({ type: 'resize', cols: 121, rows: 40 });
    act(() => { socket.onmessage!({ data: JSON.stringify({ type: 'resize-ack', ok: true, seq: request.seq, cols: 121, rows: 40 }) }); notify(); });
    expect(socket.send).toHaveBeenCalledOnce();
  });
  it('waits for fonts and advertises measured geometry on its first encrypted socket', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1000, height: 600 } as DOMRect);
    let ready!: () => void;
    mocks.fontsReady = new Promise(resolve => { ready = resolve; });
    const socket = { readyState: 0, close: vi.fn() };
    const client = { targetPeerId: 'geometry', request: vi.fn(async () => ({ items: [{ sessionId: 'backend', name: 'task', live: true, canWrite: true, canResize: true }] })), openSocket: vi.fn((_url: string) => socket) };
    const view = render(<SessionAccessView client={client as unknown as SecureClient} />);
    await act(async () => {});
    expect(client.openSocket).not.toHaveBeenCalled();
    await act(async () => ready());
    await waitFor(() => expect(client.openSocket).toHaveBeenCalledOnce());
    const query = new URL(client.openSocket.mock.calls[0][0], 'https://fixture.local').searchParams;
    expect(query.get('cols')).toBe('120');
    expect(query.get('rows')).toBe('40');
    view.unmount();
  });

  it('does not open a stale terminal after unmounting during font initialization', async () => {
    let ready!: () => void;
    mocks.fontsReady = new Promise(resolve => { ready = resolve; });
    const client = { targetPeerId: 'cancel-geometry', request: vi.fn(async () => ({ items: [{ sessionId: 'backend', name: 'task', live: true, canWrite: true, canResize: true }] })), openSocket: vi.fn() };
    const view = render(<SessionAccessView client={client as unknown as SecureClient} />);
    await act(async () => {});
    view.unmount();
    await act(async () => ready());
    expect(client.openSocket).not.toHaveBeenCalled();
  });

  it('uses the real grid in read-only mode and acknowledges flowSeq only after xterm applies output', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const socket = { readyState: 1, send: vi.fn(), close: vi.fn(), onopen: null, onmessage: null as ((e: { data: string }) => void) | null, onclose: null, onerror: null };
    const client = { targetPeerId: 'C', request: vi.fn(async () => ({ items: [{ sessionId: 'backend', sourceSessionId: 'frontend', name: 'task', live: true, canWrite: false, canResize: false }] })), openSocket: vi.fn(() => socket) };
    render(<SessionAccessView client={client as unknown as SecureClient} initialSessionId="frontend" />);
    await waitFor(() => expect(client.openSocket).toHaveBeenCalledOnce());
    act(() => socket.onmessage!({ data: JSON.stringify({ type: 'connected', replayChunks: ['screen'], replayOutOfWindow: true, replayLastSeq: 4, streamEpoch: 'epoch', cols: 120, rows: 40 }) }));
    expect(mocks.resize).toHaveBeenCalledWith(120, 40);
    expect(mocks.writes[0].data).toBe('\x1bcscreen');
    expect(mocks.options.disableStdin).toBe(true);
    expect(mocks.options.theme).toHaveProperty('background', '#1C1B1A');
    act(() => socket.onmessage!({ data: JSON.stringify({ type: 'data', data: 'output', flowSeq: 7, seq: 9 }) }));
    expect(socket.send).not.toHaveBeenCalled();
    act(() => mocks.writes[1].callback!());
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({ type: 'output-ack', flowSeq: 7, since: 9, epoch: 'epoch' });
    expect(mocks.fit).not.toHaveBeenCalled();
  });
});
