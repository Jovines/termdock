// @vitest-environment jsdom
import React, { useLayoutEffect, useRef } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { TerminalView } from '../views/TerminalView';
import { RightSidebar } from './RightSidebar';

const env = vi.hoisted(() => ({ send: vi.fn(), focus: vi.fn() }));
vi.mock('../terminal/TerminalViewport', async () => ({
  TerminalViewport: React.forwardRef((props: any, ref: any) => {
    const input = useRef<HTMLTextAreaElement>(null);
    React.useImperativeHandle(ref, () => new Proxy({
      focus: () => { env.focus(); input.current?.focus(); },
      getDimensions: () => ({ cols: 80, rows: 24 }), serializeSnapshot: () => null,
      renderer: () => 'web', prepareNativeSession: undefined,
    }, { get: (target: any, key) => key in target ? target[key] : () => {} }));
    useLayoutEffect(() => { props.onReadyChange(true); }, [props.onReadyChange]);
    return <textarea ref={input} data-terminal-input-anchor="true" aria-label="Fixture terminal" />;
  }),
}));
vi.mock('../../terminal/factory', () => ({ createTermdockAPI: () => ({
  sendInput: env.send,
  connect: (_id: string, handlers: any) => {
    queueMicrotask(() => handlers.onEvent({ type: 'connected' }));
    return { close() {} };
  },
  checkHealth: vi.fn().mockResolvedValue({ healthy: true }),
}) }));
vi.mock('./Sidebar', () => ({ Sidebar: ({ children }: any) => <aside>{children}</aside> }));
vi.mock('./HtmlPreviewFrame', () => ({ HtmlPreviewFrame: () => null }));
vi.mock('../../terminal/api', async original => ({ ...await original<any>(),
  getSettings: vi.fn(async () => ({})),
  listDirectory: vi.fn(async () => ({ path: '/project', entries: ['a.md', 'b.md', 'c.md'].map(name => ({ name, path: `/project/${name}`, type: 'file' })) })),
  readFileContent: vi.fn(async (path: string) => ({ path, content: `# ${path}\nPreview content`, size: 40, modified: '', binary: false })),
  loadContextDraft: vi.fn(async () => ({ text: '' })), saveContextDraft: vi.fn(async () => ({})),
  sendTerminalFocusState: vi.fn(), sendTerminalViewingState: vi.fn(), sendTerminalFlowControlState: vi.fn(),
}));
const initialSidebar = useSidebarStore.getState();
beforeEach(() => {
  env.send.mockReset().mockResolvedValue(undefined); env.focus.mockReset();
  sessionStorage.clear(); localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  useSidebarStore.setState({ ...initialSidebar, rootPath: '/project', rightTab: 'files', fileSortModesHydrated: true,
    hideGitIgnoredRootsHydrated: true, directoryCache: new Map(), selectedFilePath: null });
  useTerminalStore.getState().setActiveSessionId('file-keys');
  useTerminalStore.getState().setTerminalSession('file-keys', { sessionId: 'fixture-backend', mode: 'shell', cols: 80, rows: 24 });
});
afterEach(() => { cleanup(); useSidebarStore.setState(initialSidebar); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('keeps keyboard ownership in the real sidebar after pointer-up and window refocus, then returns it on terminal clicks', async () => {
  const user = userEvent.setup();
  const view = render(<I18nProvider>
    <TerminalView sessionId="file-keys" mode="shell" isActive suppressKeyboard />
    <RightSidebar isOpen sessionId="file-keys" drawerWidthPx={1100} onClose={vi.fn()} />
  </I18nProvider>);
  const row = () => view.container.querySelector<HTMLElement>('[data-file-tree-path="/project/a.md"]')!;
  await waitFor(() => expect(row()).toBeTruthy());
  await user.click(row());
  // The terminal's document pointer-up listener restores focus on a timer.
  await new Promise(resolve => setTimeout(resolve, 70));
  expect(document.activeElement).toBe(row());
  env.focus.mockClear();
  await user.keyboard('{ArrowDown}');
  expect(useSidebarStore.getState().selectedFilePath).toBe('/project/b.md');
  const preview = view.container.querySelector<HTMLElement>('[data-file-browser-keyboard] [data-file-preview-container]')
    ?? Array.from(view.container.querySelectorAll<HTMLElement>('[tabindex="-1"]')).find(element => element.textContent?.includes('Preview content') && element.closest('[data-file-browser-keyboard]') && !element.hasAttribute('data-file-browser-keyboard'))!;
  expect(preview).toBeTruthy();
  preview.focus();
  fireEvent.pointerUp(preview);
  fireEvent(window, new Event('focus'));
  await new Promise(resolve => setTimeout(resolve, 80));
  expect(document.activeElement).toBe(preview);
  expect(env.focus).not.toHaveBeenCalled();
  await user.keyboard('{ArrowDown}{ArrowUp}');
  expect(useSidebarStore.getState().selectedFilePath).toBe('/project/b.md');
  expect(env.send).not.toHaveBeenCalled();
  await user.click(screen.getByRole('textbox', { name: 'Fixture terminal' }));
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(env.focus).toHaveBeenCalled();
});
