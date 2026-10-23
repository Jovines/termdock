// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SessionWorkspace } from './SessionWorkspace';
import { SessionViewActions } from './SessionViewActions';
import { ShareAccessContext } from '../../federation/ShareAccessContext';
vi.mock('./SessionChatView', () => ({ SessionChatView: () => <div>Chat view</div> }));
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => Response.json({ mode: init?.body ? JSON.parse(String(init.body)).mode : null, updatedAt: 1 }))); });
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });
it('keeps mode actions in the existing session menu and retains the terminal when switching', async () => {
  const done = vi.fn();
  const { container } = render(<><div data-workspace><SessionWorkspace sessionId="canvas-test" name="Task" active>{visible => <textarea data-visible={visible} defaultValue="keep terminal" />}</SessionWorkspace></div><SessionViewActions sessionId="canvas-test" onDone={done} /></>);
  expect(container.querySelector('[data-workspace] button')).toBeNull();
  const terminal = screen.getByRole('textbox');
  fireEvent.click(screen.getByRole('button', { name: '普通对话' }));
  await screen.findByText('Chat view');
  expect(terminal.getAttribute('data-visible')).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: '终端' }));
  expect(screen.getByRole('textbox')).toBe(terminal); expect((terminal as HTMLTextAreaElement).value).toBe('keep terminal'); expect(done).toHaveBeenCalledTimes(2);
});

it('switches either way directly in the navigation and blurs the previous input without recreating the terminal', async () => {
  const { SessionModeSwitch } = await import('./SessionModeSwitch');
  render(<><SessionModeSwitch sessionId="quick-toggle" /><SessionWorkspace sessionId="quick-toggle" name="Task" active>{visible => <textarea data-visible={visible} defaultValue="preserved" />}</SessionWorkspace></>);
  const terminal = screen.getByRole('textbox'); terminal.focus();
  fireEvent.click(screen.getByRole('button', { name: '切换到对话' }));
  await screen.findByText('Chat view'); expect(document.activeElement).not.toBe(terminal);
  fireEvent.click(screen.getByRole('button', { name: '切换到终端' }));
  expect(screen.getByRole('textbox')).toBe(terminal); expect(terminal.getAttribute('data-visible')).toBe('true');
  expect((terminal as HTMLTextAreaElement).value).toBe('preserved');
});
it('opens the common session menu from content without stealing native text selection', () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('fine') }));
  const menu = vi.fn(); window.addEventListener('termdock:session-context-menu', menu);
  const view = render(<SessionWorkspace sessionId="context" name="Task" active terminalReady>{() => <textarea defaultValue="existing input" />}</SessionWorkspace>);
  const input = screen.getByRole('textbox') as HTMLTextAreaElement; input.setSelectionRange(4, 4);
  fireEvent.contextMenu(input, { clientX: 100, clientY: 80 }); expect(menu).toHaveBeenCalledOnce();
  expect((menu.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 'context', x: 100, y: 80 });
  expect(view.container.querySelector('[data-session-input-ready="true"]')).toBeTruthy();
  input.setSelectionRange(0, 3); fireEvent.contextMenu(input); expect(menu).toHaveBeenCalledOnce();
  window.removeEventListener('termdock:session-context-menu', menu);
});
it('keeps the todo prompt action as one menu item instead of adding a composer form', () => {
  const insert = vi.fn(); render(<SessionViewActions sessionId="action" onDone={vi.fn()} onInsertTodoPrompt={insert} />);
  fireEvent.click(screen.getByRole('button', { name: '插入待办提示' })); expect(insert).toHaveBeenCalledOnce();
});
it('blocks owner menus and draft targeting in shared content while preserving native selection', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const outerMenu = vi.fn(), insert = vi.fn();
  const view = render(<div onContextMenu={outerMenu}><ShareAccessContext.Provider value={{}}>
    <SessionWorkspace sessionId="guest-context" name="Shared" active terminalReady>{() => <textarea defaultValue="shared text" />}</SessionWorkspace>
    <SessionViewActions sessionId="guest-context" onDone={vi.fn()} onInsertTodoPrompt={insert} />
  </ShareAccessContext.Provider></div>);
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  input.setSelectionRange(4, 4);
  expect(fireEvent.contextMenu(input)).toBe(false);
  expect(outerMenu).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '插入待办提示' })).toBeNull();
  expect(screen.queryByRole('button', { name: '分享这个会话' })).toBeNull();
  expect(view.container.querySelector('[data-session-input-ready="true"]')).toBeNull();
  input.setSelectionRange(0, 6);
  expect(fireEvent.contextMenu(input)).toBe(true);
  expect(outerMenu).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled();
});
