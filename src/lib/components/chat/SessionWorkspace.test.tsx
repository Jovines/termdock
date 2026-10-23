// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SessionWorkspace } from './SessionWorkspace';
import { SessionViewActions } from './SessionViewActions';
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
