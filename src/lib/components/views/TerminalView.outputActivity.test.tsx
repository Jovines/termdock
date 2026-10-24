// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TerminalChunk, TerminalHandlers } from '../../terminal/types';

const mocks = vi.hoisted(() => ({ connect: vi.fn(), frames: [] as string[], viewport: null as null | {
  onReadyChange: (ready: boolean) => void; onWriteProgress: (id: number) => void; onFlowControl: (paused: boolean) => void;
} }));
vi.mock('../../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../../terminal/factory', () => ({ createTermdockAPI: () => ({ connect: mocks.connect, sendInput: async () => {} }) }));
vi.mock('../../terminal/api', async original => ({
  ...await original<typeof import('../../terminal/api')>(),
  sendTerminalFocusState() {}, sendTerminalViewingState() {}, sendTerminalFlowControlState() {},
  acknowledgeTerminalOutput() {},
}));
vi.mock('../terminal/TerminalViewport', () => ({
  TerminalViewport: React.forwardRef(function Viewport(props: {
    chunks: TerminalChunk[]; onReadyChange: (ready: boolean) => void; onWriteProgress: (id: number) => void; onFlowControl: (paused: boolean) => void;
  }, ref) {
    mocks.viewport = props;
    React.useImperativeHandle(ref, () => ({
      requestRefresh() {}, setSessionReady() {}, prepareScreenReplacement() {}, notifyScreenSynchronized() {}, notifyServerSize() {},
      getDimensions: () => ({ cols: 120, rows: 40 }),
    }));
    React.useEffect(() => props.onReadyChange(true), [props.onReadyChange]);
    mocks.frames.push(props.chunks.map(chunk => chunk.data).join(''));
    return null;
  }),
}));
import { TerminalView } from './TerminalView';
import { useTerminalStore } from '../../stores/useTerminalStore';

beforeEach(() => {
  mocks.frames.length = 0;
  mocks.connect.mockReset();
  mocks.connect.mockReturnValue({ close() {} });
  vi.stubGlobal('matchMedia', vi.fn((media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} })));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); useTerminalStore.getState().clearAllTerminalSessions(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const store = () => useTerminalStore.getState();
async function mount(id: string, mode: 'shell' | 'tmux' = 'shell') {
  store().setTerminalSession(id, { sessionId: `backend-${id}`, cols: 120, rows: 40, mode, history: ['shell history'] });
  const view = render(<TerminalView sessionId={id} mode={mode} />);
  await waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce());
  const handlers = mocks.connect.mock.calls[0][1] as TerminalHandlers;
  const emit = (event: Parameters<TerminalHandlers['onEvent']>[0]) => act(() => { handlers.onEvent(event); store().flushPendingBufferWrites(id); });
  return { ...view, handlers, emit, time: () => store().sessions.get(id)?.lastOutputAt };
}
it('ignores initial history, incremental reconnect replay, empty packets and metadata; observes live output', async () => {
  const view = await mount('history');
  view.emit({ type: 'connected', mode: 'shell', replayChunks: ['old output'] }); expect(view.time()).toBeNull();
  view.emit({ type: 'data', data: '' }); view.emit({ type: 'agent-status', agentStatus: 'working' }); expect(view.time()).toBeNull();
  view.emit({ type: 'data', data: 'new output' }); expect(view.time()).toBeTypeOf('number');
  view.emit({ type: 'reconnecting' }); expect(view.time()).toBeNull();
  view.emit({ type: 'connected', mode: 'shell', replayChunks: ['missed while offline'] }); expect(view.time()).toBeNull();
  view.emit({ type: 'data', data: 'new again' }); expect(view.time()).toBeTypeOf('number');
  const rejected = Object.assign(new Error('input denied'), { name: 'TerminalInputError', code: 'TERMINAL_INPUT_REJECTED' });
  act(() => view.handlers.onError!(rejected, false)); expect(view.time()).toBeTypeOf('number');
  act(() => view.handlers.onError!(new Error('disconnected'), false)); expect(view.time()).toBeNull();
});
it('records flow-controlled output at arrival, never when delayed bytes finally render', async () => {
  const view = await mount('backpressure'); view.emit({ type: 'connected', mode: 'shell' });
  vi.spyOn(Date, 'now').mockReturnValue(100_000);
  act(() => mocks.viewport!.onFlowControl(true));
  view.emit({ type: 'data', data: 'buffered-live' }); expect(view.time()).toBe(100_000);
  vi.mocked(Date.now).mockReturnValue(110_000);
  act(() => { mocks.viewport!.onFlowControl(false); store().flushPendingBufferWrites('backpressure'); });
  expect(view.time()).toBe(100_000);
  expect(store().sessions.get('backpressure')?.bufferChunks.map(chunk => chunk.data).join('')).toContain('buffered-live');
});
it('screen snapshots do not create activity or erase a genuine live receipt, and exit/unmount discard pending observations', async () => {
  const view = await mount('tmux-output', 'tmux');
  view.emit({ type: 'connected', mode: 'tmux', replayChunks: ['initial screen'], replayOutOfWindow: true }); expect(view.time()).toBeNull();
  view.emit({ type: 'tmux-screen-sync', generation: 1, chunks: ['resized'] }); expect(view.time()).toBeNull();
  act(() => { view.handlers.onEvent({ type: 'data', data: 'real output' }); view.handlers.onEvent({ type: 'tmux-screen-sync', generation: 2, chunks: ['new screen'] }); store().flushPendingBufferWrites('tmux-output'); });
  expect(view.time()).toBeTypeOf('number');
  act(() => { view.handlers.onEvent({ type: 'data', data: 'before exit' }); view.handlers.onEvent({ type: 'exit', exitCode: 0 }); store().flushPendingBufferWrites('tmux-output'); }); expect(view.time()).toBeNull();
  view.unmount();
  act(() => { view.handlers.onEvent({ type: 'data', data: 'late old stream' }); store().flushPendingBufferWrites('tmux-output'); }); expect(view.time()).toBeNull();
});
it('restores server activity on connect and follows server transitions rather than data or agent hooks', async () => {
  const view = await mount('authoritative');
  const active = () => store().sessions.get('authoritative')?.terminalOutputActive;
  view.emit({ type: 'connected', mode: 'shell', terminalOutputActive: true, replayChunks: ['old'] }); expect(active()).toBe(true);
  view.emit({ type: 'terminal-output-activity', active: false }); expect(active()).toBe(false);
  view.emit({ type: 'data', data: 'unqualified output' }); view.emit({ type: 'agent-status', agentStatus: 'working' }); expect(active()).toBe(false);
  view.emit({ type: 'terminal-output-activity', active: true }); expect(active()).toBe(true);
  view.emit({ type: 'tmux-screen-sync', generation: 1, chunks: ['screen'] }); expect(active()).toBe(true);
  view.emit({ type: 'reconnecting' }); expect(active()).toBe(false);
  view.emit({ type: 'connected', mode: 'shell', replayChunks: ['old again'] }); expect(active()).toBe(false);
  view.emit({ type: 'terminal-output-activity', active: true }); expect(active()).toBe(true);
  view.unmount(); expect(active()).toBe(false);
  view.emit({ type: 'terminal-output-activity', active: true }); expect(active()).toBe(false);
});
