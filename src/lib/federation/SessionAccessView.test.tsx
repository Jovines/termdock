// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { SessionAccessView } from './SessionAccessView';
import type { SecureClient } from './secureClient';
const mocks = vi.hoisted(() => ({ writes: [] as Array<{ data: string; callback?: () => void }>, resize: vi.fn(), options: {} as Record<string, unknown>, fit: vi.fn() }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24;
  constructor(options: Record<string, unknown>) { mocks.options = options; }
  loadAddon() {} open() {} dispose() {}
  write(data: string, callback?: () => void) { mocks.writes.push({ data, callback }); }
  resize(cols: number, rows: number) { mocks.resize(cols, rows); }
  onData() { return { dispose() {} }; }
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() { mocks.fit(); } } }));
afterEach(() => { cleanup(); mocks.writes.length = 0; vi.clearAllMocks(); vi.unstubAllGlobals(); });
describe('scoped encrypted terminal viewer', () => {
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
