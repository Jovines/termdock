// @vitest-environment jsdom
import React, { useLayoutEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RightSidebar } from './RightSidebar';
import { TerminalView } from '../views/TerminalView';
import { I18nProvider } from '../../i18n';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { useMultiSessionStore } from '../../stores/useMultiSessionStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { isKeyboardLayerOpen } from '../../hooks/useKeyboardLayer';
import { terminalSequencePayload } from '../../terminal/sequencePayload';
import { registerCollaborationInput } from '../../collaboration/inputTarget';
import type { TerminalHandlers } from '../../terminal/types';

// Keep the real Form, Panel, Sidebar router, layer registry, TerminalView input
// boundary and payload encoder. Replace only the rendering/controller boundary
// and the backend: the test must never launch a real shell or Agent.
const env = vi.hoisted(() => ({ send: vi.fn(), controller: true, streams: new Map<string, TerminalHandlers>(),
  inputs: new Map<string, (data: string, options?: object) => unknown>(), sequence: vi.fn(), map: null as unknown }));
vi.mock('../terminal/TerminalViewport', async () => ({
  TerminalViewport: React.forwardRef((props: any, ref: any) => {
    env.inputs.set(props.sessionId, props.onInput);
    React.useImperativeHandle(ref, () => env.controller ? new Proxy({
      sendSequence: (text: string, options: any) => {
        env.sequence(text, options);
        return props.onInput(terminalSequencePayload(text, options), { ...options, skipModifierTransform: true });
      },
      getDimensions: () => ({ cols: 80, rows: 24 }), serializeSnapshot: () => null,
    }, { get: (target: any, key) => key in target ? target[key] : () => {} }) : null);
    useLayoutEffect(() => { props.onReadyChange(true); }, [props.onReadyChange]);
    return <div data-testid={`viewport-${props.sessionId}`} />;
  }),
}));
vi.mock('../../terminal/factory', () => ({ createTermdockAPI: () => ({
  sendInput: env.send,
  connect: (id: string, handlers: TerminalHandlers) => {
    env.streams.set(id, handlers);
    queueMicrotask(() => handlers.onEvent({ type: 'connected' }));
    return { close: () => env.streams.delete(id) };
  },
  checkHealth: vi.fn().mockResolvedValue({ healthy: true }),
}) }));
vi.mock('./Sidebar', () => ({ Sidebar: ({ children }: any) => <div>{children}</div> }));
vi.mock('../../architecture/api', () => ({ readArchitecture: vi.fn(async () => env.map), listArchitectures: vi.fn(async () => []) }));
vi.mock('./HtmlPreviewFrame', () => ({ HtmlPreviewFrame: () => null }));
vi.mock('../../terminal/api', async original => ({ ...await original<any>(),
  getSettings: vi.fn(async () => ({})), listDirectory: vi.fn(async () => ({ entries: [], path: '/project' })),
  readFileContent: vi.fn(async () => ({ path: '/project/src/demo.ts', content: 'first\nsecond', size: 12, modified: '', binary: false })),
  loadContextDraft: vi.fn(async () => ({ text: '' })), saveContextDraft: vi.fn(async () => ({})),
  openSessionInventoryEntry: vi.fn(async () => ({})), updateSessionInventoryEntry: vi.fn(async () => ({})),
  sendTerminalFocusState: vi.fn(), sendTerminalViewingState: vi.fn(), sendTerminalFlowControlState: vi.fn(),
}));
const sidebarInitial = useSidebarStore.getState();
beforeEach(() => {
  env.send.mockReset().mockResolvedValue(undefined); env.sequence.mockReset(); env.streams.clear(); env.inputs.clear(); env.controller = true; env.map = null;
  sessionStorage.clear(); localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  useSidebarStore.setState({ ...sidebarInitial, rootPath: '/project', rightTab: 'architecture' });
  // The retired store remains empty in the real App.
  useMultiSessionStore.setState({ activeSessionId: null });
  useTerminalStore.getState().setActiveSessionId('alpha');
  useTerminalStore.getState().setTerminalSession('alpha', { sessionId: 'backend-alpha', mode: 'shell', cols: 80, rows: 24 });
  useTerminalStore.getState().setTerminalSession('beta', { sessionId: 'backend-beta', mode: 'shell', cols: 80, rows: 24 });
});
afterEach(() => { cleanup(); useSidebarStore.setState(sidebarInitial); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function mount(extra: { suspended?: boolean; beta?: boolean; width?: number } = {}) {
  return render(<I18nProvider><TerminalView sessionId="alpha" mode="shell" isActive focusSuspended={extra.suspended} suppressKeyboard />
    {extra.beta && <TerminalView sessionId="beta" mode="shell" isActive={false} suppressKeyboard />}
    <RightSidebar isOpen sessionId="alpha" drawerWidthPx={extra.width ?? 900} onClose={vi.fn()} />
  </I18nProvider>);
}
async function prepare() {
  await screen.findByRole('button', { name: 'Generate' });
  await waitFor(() => expect(env.streams.has('backend-alpha')).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
  expect(isKeyboardLayerOpen()).toBe(true);
  return screen.getByRole('button', { name: 'Insert prompt' });
}
it('keeps raw and plain targeted input blocked, accepts the exact prompt once as a safe paste into its fixed target', async () => {
  mount({ beta: true }); const insert = await prepare();
  await act(async () => { env.inputs.get('alpha')!('x'); env.inputs.get('alpha')!('x', { targeted: true }); });
  expect(env.send).not.toHaveBeenCalled();
  fireEvent.click(insert); fireEvent.click(insert);
  await screen.findByText('Review the current input or context draft, then send it to your Agent.');
  expect(env.send).toHaveBeenCalledOnce();
  const [target, payload] = env.send.mock.calls[0];
  expect(target).toBe('backend-alpha');
  const raw = env.sequence.mock.calls[0][0];
  expect(raw).toContain('/project'); expect(raw.length).toBeGreaterThan(4000);
  expect(payload).toBe(terminalSequencePayload(raw, env.sequence.mock.calls[0][1]));
  expect(payload.startsWith('\x1b[200~')).toBe(true); expect(payload.endsWith('\x1b[201~')).toBe(true);
  expect(payload.slice(6, -6)).not.toContain('\x1b');
  expect(isKeyboardLayerOpen()).toBe(true);
  expect(insert.closest('form')!.contains(document.activeElement)).toBe(true);
});
it.each(['controller', 'disconnected', 'rejected', 'external suspension', 'offline', 'hidden'])('preserves prepared content and reports failure on %s', async failure => {
  if (failure === 'controller') env.controller = false;
  mount({ suspended: failure === 'external suspension' }); const insert = await prepare();
  if (failure === 'disconnected') await act(async () => { env.streams.get('backend-alpha')!.onEvent({ type: 'reconnecting', attempt: 1 }); });
  if (failure === 'offline') vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  if (failure === 'hidden') vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  if (failure === 'rejected') env.send.mockRejectedValueOnce(new Error('connection lost'));
  fireEvent.click(insert);
  await screen.findByText('Could not add the prompt. Check the current session, or copy it below.');
  expect(screen.queryByText('Review the current input or context draft, then send it to your Agent.')).toBeNull();
  expect(screen.getByRole('heading', { name: 'Prepare architecture analysis' })).toBeTruthy();
  if (failure !== 'rejected') expect(env.send).not.toHaveBeenCalled();
});
it('cancels without input and keeps collaboration routing local', async () => {
  mount(); await prepare(); fireEvent.click(screen.getByRole('button', { name: 'Close analysis settings' }));
  expect(env.send).not.toHaveBeenCalled();
  const receive = vi.fn(); const unregister = registerCollaborationInput(receive, 'architecture-integration');
  try {
    const insert = await prepare(); fireEvent.click(insert);
    await screen.findByText('Review the current input or context draft, then send it to your Agent.');
    expect(receive).toHaveBeenCalledOnce(); expect(receive.mock.calls[0][0]).toContain('/project');
    expect(env.sequence).not.toHaveBeenCalled(); expect(env.send).not.toHaveBeenCalled();
  } finally { unregister(); }
});
it('keeps a context draft local and confirms its acceptance without terminal input', async () => {
  localStorage.setItem('termdock:right-sidebar:context-draft-enabled:v1', 'true');
  mount(); const insert = await prepare(); fireEvent.click(insert);
  await screen.findByText('Review the current input or context draft, then send it to your Agent.');
  expect(env.send).not.toHaveBeenCalled();
  expect((document.querySelector('[data-context-draft-input]') as HTMLTextAreaElement).value).toContain('/project');
});
it.each([900, 390])('accepts an explicit module source reference while the Inspector owns input at width %s', async width => {
  env.map = { version: 1, generatedAt: '2026-10-10T00:00:00Z', summary: 'Fixture architecture', perspectives: [
    { id: 'main', title: 'Main', summary: '', nodes: [{ id: 'module', title: 'Demo module', summary: 'Source module', files: [{ path: 'src/demo.ts', line: 1 }] }], edges: [] },
  ] };
  mount({ width }); fireEvent.click(await screen.findByRole('button', { name: 'Demo module' }));
  fireEvent.click(screen.getByRole('button', { name: /src\/demo.ts/ }));
  await waitFor(() => expect(document.querySelector('[data-file-preview-line]')).not.toBeNull());
  if (width < 600) await waitFor(() => expect(document.querySelector('[data-file-preview-line]')?.className).toContain('bg-[var(--surface-2)]'));
  const insert = await screen.findByRole('button', { name: width < 600 ? /Insert.*1/ : 'Insert' });
  expect(isKeyboardLayerOpen()).toBe(true);
  await act(async () => { env.inputs.get('alpha')!('x'); });
  expect(env.send).not.toHaveBeenCalled();
  fireEvent.click(insert);
  await waitFor(() => expect(env.send).toHaveBeenCalledOnce());
  expect(env.send.mock.calls[0][0]).toBe('backend-alpha');
  const payload = env.send.mock.calls[0][1];
  expect(payload).toBe(terminalSequencePayload(env.sequence.mock.calls[0][0], env.sequence.mock.calls[0][1]));
  expect(payload).toContain(width < 600 ? '/project/src/demo.ts:1' : '/project/src/demo.ts ');
  if (width < 600) expect(payload).toContain('first');
  expect(payload.endsWith('\x1b[201~')).toBe(true);
  expect(isKeyboardLayerOpen()).toBe(true);
});

it.each(['target changes', 'layer closes', 'connection epoch changes'])('does not confirm a late transport result after %s', async stale => {
  let accept!: () => void;
  env.send.mockImplementationOnce(() => new Promise<void>(resolve => { accept = resolve; }));
  mount(); const insert = await prepare(); fireEvent.click(insert);
  await waitFor(() => expect(env.send).toHaveBeenCalledOnce());
  if (stale === 'target changes') act(() => useTerminalStore.getState().setActiveSessionId('beta'));
  if (stale === 'layer closes') fireEvent.click(screen.getByRole('button', { name: 'Close analysis settings' }));
  if (stale === 'connection epoch changes') await act(async () => { env.streams.get('backend-alpha')!.onEvent({ type: 'connected' }); });
  await act(async () => { accept(); });
  expect(screen.queryByText('Review the current input or context draft, then send it to your Agent.')).toBeNull();
  expect(env.send).toHaveBeenCalledOnce();
  if (stale !== 'layer closes') await screen.findByText('Could not add the prompt. Check the current session, or copy it below.');
});
