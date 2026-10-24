import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { commands, page, userEvent } from 'vitest/browser';
import '../../../index.css';
import { SessionWorkspace } from './SessionWorkspace';
import { SessionModeSwitch } from './SessionModeSwitch';
import { TerminalView } from '../views/TerminalView';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { getDefaultTerminalSettings } from '../../terminal/settings';
import type { TerminalHandlers } from '../../terminal/types';
import { clearChatSnapshots } from './chatSnapshot';
const backend = vi.hoisted(() => ({ inputs: vi.fn(), connect: vi.fn(), resize: vi.fn(), close: vi.fn(), handlers: undefined as TerminalHandlers | undefined }));
vi.mock('../../terminal/factory', () => ({ createTermdockAPI: () => ({
  connect: (_id: string, handlers: TerminalHandlers) => {
    backend.connect(); backend.handlers = handlers;
    queueMicrotask(() => handlers.onEvent({ type: 'connected', mode: 'shell', cwd: '/tmp' }));
    return { close: backend.close };
  },
  sendInput: async (_id: string, text: string) => { backend.inputs(text); if (!/[\x00-\x1f\x7f]/.test(text)) backend.handlers?.onEvent({ type: 'data', data: text }); },
  resize: async (size: { seq: number; cols: number; rows: number }) => { backend.resize(size); queueMicrotask(() => backend.handlers?.onEvent({ type: 'resize-ack', ok: true, ...size })); },
}) }));
declare module 'vitest/browser' { interface BrowserCommands { peekMove(selector: string, x?: number, y?: number): Promise<void> } }
let root: Root | undefined, sessionId = '';
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
afterEach(async () => {
  root?.unmount(); root = undefined; useTerminalStore.getState().clearAllTerminalSessions(); clearChatSnapshots();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); document.body.replaceChildren(); localStorage.clear(); sessionStorage.clear();
  await page.viewport(1280, 900);
});
async function mount(width = 1280) {
  await page.viewport(width, 900);
  sessionId = `peek-${Date.now()}`; let mode = 'chat', replyPending = true;
  localStorage.setItem(`termdock:session-view:${location.origin}:${sessionId}`, mode);
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (String(url).includes('/view-mode')) { if (init?.body) mode = JSON.parse(String(init.body)).mode; return Response.json({ mode }); }
    if (String(url).includes('/chat')) return Response.json({ agentAvailable: true, agent: { displayName: 'Codex', slug: 'codex' }, replyPending, messages: [{ id: 'u1', role: 'user', content: '检查构建输出', createdAt: 1, status: 'delivered' }] });
    return Response.json({});
  }));
  useTerminalStore.getState().setTerminalSession(sessionId, { sessionId: 'backend-peek', mode: 'shell', cols: 120, rows: 32, cwd: '/tmp' });
  useTerminalStore.getState().replaceBuffer(sessionId, ['isolated terminal output\r\n$ ']);
  const host = document.createElement('div'); host.className = 'h-screen flex flex-col'; document.body.append(host);
  root = createRoot(host);
  root.render(<><header className="h-12 shrink-0"><SessionModeSwitch sessionId={sessionId} /></header><main className="flex-1 min-h-0"><SessionWorkspace sessionId={sessionId} name="构建检查" active>{(visible, interactive) => <TerminalView sessionId={sessionId} mode="shell" isActive isLayoutVisible={visible} focusSuspended={!interactive} suppressKeyboard={!visible} terminalSettings={{ ...getDefaultTerminalSettings(), rendererMode: 'canvas', enableImages: false, fontLigatures: false }} />}</SessionWorkspace></main></>);
  await expect.element(page.getByText('工作中…')).toBeVisible(); await frame();
  return { completeReply: () => { replyPending = false; window.dispatchEvent(new Event('online')); } };
}
it.each([1280, 390])('baseline: switches between chat and the retained full terminal at width %i', async width => {
  await mount(width);
  const editor = document.querySelector('[data-session-chat] [role="textbox"]') as HTMLElement;
  editor.focus(); await userEvent.keyboard('保留聊天草稿');
  const input = document.querySelector('textarea[data-terminal-input-anchor]');
  await page.getByRole('button', { name: '切换到终端' }).click();
  await expect.poll(() => document.querySelector('.xterm-rows')?.textContent).toContain('isolated terminal output');
  expect(document.querySelector('textarea[data-terminal-input-anchor]')).toBe(input);
  await page.getByRole('button', { name: '切换到对话' }).click();
  expect(editor.textContent).toContain('保留聊天草稿');
  expect(backend.connect).toHaveBeenCalledTimes(1);
});

it('moves the same complete terminal into a hover bubble, accepts input, and closes immediately outside', async () => {
  await mount();
  const editor = document.querySelector('[data-session-chat] [role="textbox"]') as HTMLElement;
  editor.focus(); await userEvent.keyboard('聊天草稿不变');
  const input = document.querySelector<HTMLTextAreaElement>('textarea[data-terminal-input-anchor]')!;
  const viewport = document.querySelector('.xterm')!, toolbar = document.querySelector('[data-mobile-keyboard]');
  await page.getByRole('button', { name: '查看会话终端' }).hover();
  await expect.element(page.getByRole('dialog', { name: '会话终端预览' })).toBeVisible();
  const panel = document.querySelector<HTMLElement>('[data-terminal-peek]')!;
  expect(panel.querySelector('textarea[data-terminal-input-anchor]')).toBe(input);
  expect(panel.querySelector('.xterm')).toBe(viewport);
  expect(document.activeElement).toBe(editor);
  expect(panel.getBoundingClientRect().right).toBeLessThanOrEqual(innerWidth);
  expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(innerHeight);
  const below = parseFloat(panel.style.paddingTop) > 0;
  await commands.peekMove('[data-terminal-peek-trigger]', .5, below ? 1.1 : -.1);
  expect(document.querySelector('[data-terminal-peek]')).toBe(panel);
  await commands.peekMove('[data-terminal-peek] .xterm');
  expect(document.activeElement).toBe(editor);
  expect(document.querySelector('[data-terminal-peek]')).toBe(panel);
  await page.elementLocator(panel.querySelector('.xterm')!).click();
  await expect.poll(() => document.activeElement === input).toBe(true);
  await userEvent.keyboard('hello{Enter}{Escape}{Control>}c{/Control}');
  await expect.poll(() => backend.inputs.mock.calls.map(([text]) => text).join('')).toContain('hello\r\x1b\x03');
  expect(editor.textContent).toBe('聊天草稿不变');
  if (toolbar) expect(panel.contains(toolbar)).toBe(true);
  await page.screenshot({ path: `/tmp/termdock-terminal-peek-dpr${devicePixelRatio}.png` });
  await page.getByRole('button', { name: '查看会话终端' }).hover();
  expect(document.querySelector('[data-terminal-peek]')).toBe(panel);
  await commands.peekMove('[data-chat-composer]');
  await expect.poll(() => document.querySelector('[data-terminal-peek]')).toBeNull();
  await expect.poll(() => document.activeElement === editor).toBe(true);
  expect(document.querySelector('textarea[data-terminal-input-anchor]')).toBe(input);
  expect(backend.connect).toHaveBeenCalledTimes(1);
  expect(backend.close).not.toHaveBeenCalled();
});
it('reopens and expands the retained terminal without losing state or reconnecting', async () => {
  await mount();
  const input = document.querySelector('textarea[data-terminal-input-anchor]');
  await page.getByRole('button', { name: '查看会话终端' }).hover();
  await expect.element(page.getByRole('dialog', { name: '会话终端预览' })).toBeVisible();
  await expect.poll(() => backend.resize.mock.calls.length).toBeGreaterThan(0);
  const peekCols = backend.resize.mock.lastCall![0].cols;
  expect(peekCols).toBeGreaterThan(40);
  await commands.peekMove('[data-chat-composer]');
  await expect.poll(() => document.querySelector('[data-terminal-peek]')).toBeNull();
  await page.getByRole('button', { name: '查看会话终端' }).hover();
  await page.getByRole('button', { name: '在完整会话中打开终端' }).click();
  await expect.poll(() => backend.resize.mock.lastCall?.[0].cols).toBeGreaterThan(peekCols);
  await expect.poll(() => document.querySelector('[data-terminal-peek]')).toBeNull();
  await expect.element(page.getByRole('button', { name: '切换到对话' })).toBeVisible();
  expect(document.querySelector('textarea[data-terminal-input-anchor]')).toBe(input);
  await expect.poll(() => document.querySelector('.xterm-rows')?.textContent).toContain('isolated terminal output');
  expect(backend.connect).toHaveBeenCalledTimes(1);
  expect(backend.close).not.toHaveBeenCalled();
});

it('keeps toolbar shortcuts, live output and reconnect handling working while hovering the retained terminal', async () => {
  const { completeReply } = await mount();
  await page.getByRole('button', { name: '查看会话终端' }).hover();
  await expect.element(page.getByRole('dialog', { name: '会话终端预览' })).toBeVisible();
  const panel = document.querySelector('[data-terminal-peek]')!;
  await page.elementLocator(panel).getByRole('button', { name: 'Esc', exact: true }).click();
  await expect.poll(() => backend.inputs.mock.calls.map(([text]) => text).join('')).toContain('\x1b');
  await page.elementLocator(panel).getByRole('button', { name: 'Ctrl-C', exact: true }).click();
  await expect.poll(() => backend.inputs.mock.calls.map(([text]) => text).join('')).toContain('\x03');
  backend.handlers!.onEvent({ type: 'reconnecting' }); await frame();
  backend.handlers!.onEvent({ type: 'connected', mode: 'shell' });
  backend.handlers!.onEvent({ type: 'data', data: '\r\nreconnected live output\r\n$ ' });
  await expect.poll(() => panel.querySelector('.xterm-rows')?.textContent).toContain('reconnected live output');
  await commands.peekMove('[data-terminal-peek] .xterm');
  completeReply();
  await expect.poll(() => document.querySelector('[data-terminal-peek-trigger]')).toBeNull();
  expect(document.querySelector('[data-terminal-peek]')).toBe(panel);
  await page.elementLocator(panel.querySelector('.xterm')!).click();
  await userEvent.keyboard('after-reconnect');
  await expect.poll(() => backend.inputs.mock.calls.map(([text]) => text).join('')).toContain('after-reconnect');
  await commands.peekMove('[data-chat-composer]');
  await expect.poll(() => document.querySelector('[data-terminal-peek]')).toBeNull();
});

it('uses the normal terminal view on devices without hover', async () => {
  await mount(390);
  const media = window.matchMedia.bind(window);
  vi.spyOn(window, 'matchMedia').mockImplementation(query => query === '(hover: hover) and (pointer: fine)' ? { matches: false } as MediaQueryList : media(query));
  await page.getByRole('button', { name: '查看会话终端' }).click();
  await expect.element(page.getByRole('button', { name: '切换到对话' })).toBeVisible();
  expect(document.querySelector('[data-terminal-peek]')).toBeNull();
  await expect.poll(() => document.querySelector('.xterm-rows')?.textContent).toContain('isolated terminal output');
});
