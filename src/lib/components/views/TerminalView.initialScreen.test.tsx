// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TerminalChunk, TerminalHandlers } from '../../terminal/types';

const mocks = vi.hoisted(() => ({ connect: vi.fn(), frames: [] as string[], viewport: null as null | {
  onReadyChange: (ready: boolean) => void; onWriteProgress: (id: number) => void;
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
    chunks: TerminalChunk[]; onReadyChange: (ready: boolean) => void; onWriteProgress: (id: number) => void;
  }, ref) {
    mocks.viewport = props;
    React.useImperativeHandle(ref, () => ({
      requestRefresh() {}, setSessionReady() {}, prepareScreenReplacement() {},
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function cache(sessionId: string, mode: 'shell' | 'tmux') {
  const store = useTerminalStore.getState();
  store.setTerminalSession(sessionId, { sessionId: `backend-${sessionId}`, cols: 120, rows: 40, mode });
  store.replaceBuffer(sessionId, ['OLD_FRAME\r\n'.repeat(50_000)]);
}

it('skips a retained tmux transcript on mount, shows the attach screen, and retains it during reconnect', async () => {
  cache('tmux-initial-screen', 'tmux');
  const view = render(<TerminalView sessionId="tmux-initial-screen" mode="tmux" />);
  await waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce());
  expect(mocks.frames.every(frame => frame === '')).toBe(true);
  const handlers = mocks.connect.mock.calls[0][1] as TerminalHandlers;
  act(() => handlers.onEvent({ type: 'connected', mode: 'tmux', replayChunks: ['CURRENT_SCREEN'], replayOutOfWindow: true }));
  expect(mocks.frames.at(-1)).toContain('CURRENT_SCREEN');
  expect(mocks.frames.every(frame => !frame.includes('OLD_FRAME'))).toBe(true);
  act(() => handlers.onEvent({ type: 'reconnecting' }));
  expect(mocks.frames.at(-1)).toContain('CURRENT_SCREEN');
  view.unmount();
  // A new viewport for the same session must wait for its own attach screen.
  mocks.frames.length = 0;
  render(<TerminalView sessionId="tmux-initial-screen" mode="tmux" initialConnectEnabled={false} />);
  expect(mocks.frames.every(frame => frame === '')).toBe(true);
});

it('keeps immediate cached output for shell sessions', () => {
  cache('shell-initial-screen', 'shell');
  render(<TerminalView sessionId="shell-initial-screen" mode="shell" initialConnectEnabled={false} />);
  expect(mocks.frames.at(-1)).toContain('OLD_FRAME');
});

it('releases parsed tmux output and gets a new screen when the inner terminal is rebuilt', async () => {
  cache('tmux-rebuild', 'tmux');
  const close = vi.fn(); mocks.connect.mockReturnValue({ close });
  render(<TerminalView sessionId="tmux-rebuild" mode="tmux" />);
  await waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce());
  const first = mocks.connect.mock.calls[0][1] as TerminalHandlers;
  act(() => first.onEvent({ type: 'connected', mode: 'tmux', replayChunks: ['BEFORE_LAYOUT'], replayOutOfWindow: true }));
  const writtenId = useTerminalStore.getState().getTerminalSession('tmux-rebuild')!.bufferChunks.at(-1)!.id;
  act(() => mocks.viewport!.onWriteProgress(writtenId));
  expect(useTerminalStore.getState().getTerminalSession('tmux-rebuild')!.bufferLength).toBe(0);
  act(() => first.onEvent({ type: 'data', data: 'UNPARSED_OLD_GRID' }));
  act(() => mocks.viewport!.onReadyChange(false));
  expect(close).toHaveBeenCalledOnce();
  expect(useTerminalStore.getState().hasPendingBufferWrites('tmux-rebuild')).toBe(false);
  expect(mocks.frames.at(-1)).toBe('');
  // Late data from the detached stream must not seed the empty renderer.
  act(() => first.onEvent({ type: 'data', data: 'LATE_OLD_GRID' }));
  act(() => mocks.viewport!.onReadyChange(true));
  expect(mocks.connect).toHaveBeenCalledTimes(2);
  const second = mocks.connect.mock.calls[1][1] as TerminalHandlers;
  act(() => second.onEvent({ type: 'connected', mode: 'tmux', replayChunks: ['AFTER_LAYOUT'], replayOutOfWindow: true }));
  expect(mocks.frames.at(-1)).toContain('AFTER_LAYOUT');
  expect(mocks.frames.at(-1)).not.toMatch(/OLD_GRID|BEFORE_LAYOUT/);
});
