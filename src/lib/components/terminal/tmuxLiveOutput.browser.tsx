import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { Terminal } from '@xterm/xterm';
import '../../../index.css';
import { TerminalView } from '../views/TerminalView';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { getDefaultTerminalSettings } from '../../terminal/settings';
import type { TerminalHandlers } from '../../terminal/types';

const backend = vi.hoisted(() => ({ connect: vi.fn(), close: vi.fn(), inputs: vi.fn(), handlers: undefined as TerminalHandlers | undefined }));
vi.mock('../../terminal/factory', () => ({ createTermdockAPI: () => ({
  connect: (_id: string, handlers: TerminalHandlers) => {
    backend.connect(); backend.handlers = handlers; return { close: backend.close };
  },
  sendInput: async (_id: string, text: string) => { backend.inputs(text); },
  resize: async (size: { seq: number; cols: number; rows: number }) => {
    queueMicrotask(() => backend.handlers?.onEvent({ type: 'resize-ack', ok: true, ...size }));
  },
}) }));
let root: Root | undefined;
afterEach(() => {
  root?.unmount(); root = undefined;
  useTerminalStore.getState().clearAllTerminalSessions();
  vi.restoreAllMocks(); vi.clearAllMocks(); document.body.replaceChildren();
});
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

it('keeps only live tmux delivery across resizing and gets a fresh screen after xterm recreation', async () => {
  const sessionId = 'tmux-live-browser';
  const store = useTerminalStore.getState();
  store.setTerminalSession(sessionId, { sessionId: 'tmux-backend', mode: 'tmux', cols: 120, rows: 40 });
  store.replaceBuffer(sessionId, ['CACHED_OLD_GRID\r\n'.repeat(50_000)]);
  const write = vi.spyOn(Terminal.prototype, 'write');
  const host = document.createElement('div'); host.className = 'h-screen'; document.body.append(host);
  root = createRoot(host);
  const settings = { ...getDefaultTerminalSettings(), rendererMode: 'canvas' as const, enableImages: false, fontLigatures: false };
  const render = (fontSize = 14) => root!.render(<TerminalView sessionId={sessionId} mode="tmux" terminalSettings={{ ...settings, fontSize }} />);
  render();
  await expect.poll(() => backend.connect.mock.calls.length).toBe(1);
  for (let n = 0; n < 4; n++) await frame();
  expect(write.mock.calls).toHaveLength(0);
  const first = backend.handlers!;
  first.onEvent({ type: 'connected', mode: 'tmux', replayChunks: ['\x1b[HBEFORE_LAYOUT'], replayOutOfWindow: true });
  await expect.poll(() => document.querySelector('.xterm-rows')?.textContent).toContain('BEFORE_LAYOUT');
  await expect.poll(() => store.getTerminalSession(sessionId)!.bufferLength).toBe(0);
  first.onEvent({ type: 'data', data: '\x1b[2;1HLIVE_OUTPUT' });
  await expect.poll(() => document.querySelector('.xterm-rows')?.textContent).toContain('LIVE_OUTPUT');
  await expect.poll(() => store.getTerminalSession(sessionId)!.bufferLength).toBe(0);
  // Releasing earlier chunks must not label new bytes as replay and suppress
  // the terminal's reply to a live cursor-position query.
  await new Promise(resolve => setTimeout(resolve, 250));
  first.onEvent({ type: 'data', data: '\x1b[6n' });
  await expect.poll(() => backend.inputs.mock.calls.some(([data]) => /\x1b\[\d+;\d+R/.test(String(data)))).toBe(true);
  const terminal = document.querySelector('.xterm');
  write.mockClear();
  await page.viewport(900, 700); await frame();
  expect(document.querySelector('.xterm')).toBe(terminal);
  expect(backend.connect).toHaveBeenCalledTimes(1);
  expect(write.mock.calls).toHaveLength(0);
  render(18);
  await expect.poll(() => backend.connect.mock.calls.length).toBe(2);
  expect(backend.close).toHaveBeenCalledOnce();
  expect(document.querySelector('.xterm')).not.toBe(terminal);
  // Hold attach back: the new renderer must remain empty, with no local replay.
  for (let n = 0; n < 4; n++) await frame();
  expect(write.mock.calls).toHaveLength(0);
  first.onEvent({ type: 'data', data: 'DETACHED_OLD_GRID' });
  backend.handlers!.onEvent({ type: 'connected', mode: 'tmux', replayChunks: ['\x1b[HAFTER_LAYOUT'], replayOutOfWindow: true });
  await expect.poll(() => document.querySelector('.xterm-rows')?.textContent).toContain('AFTER_LAYOUT');
  await expect.poll(() => store.getTerminalSession(sessionId)!.bufferLength).toBe(0);
  expect(write.mock.calls.map(([data]) => String(data)).join('')).not.toMatch(/CACHED_OLD_GRID|BEFORE_LAYOUT|LIVE_OUTPUT|DETACHED_OLD_GRID/);
  backend.handlers!.onEvent({ type: 'reconnecting' });
  await frame();
  expect(document.querySelector('.xterm-rows')?.textContent).toContain('AFTER_LAYOUT');
});
