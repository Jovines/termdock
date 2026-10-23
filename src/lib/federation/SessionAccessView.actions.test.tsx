// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SessionAccessView } from './SessionAccessView';
import type { SecureClient } from './secureClient';
vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('../components/chat/SessionChatView', () => ({ SessionChatView: ({ canWrite }: { canWrite: boolean }) => <section><p>Shared history to copy</p><textarea aria-label="Shared input" disabled={!canWrite} /></section> }));
afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); localStorage.clear(); vi.unstubAllGlobals(); });
it.each([false, true])('isolates shared session context menus regardless of write permission (%s)', async canWrite => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ mode: 'chat' })));
  const client = { targetPeerId: `guest-${canWrite}`, request: vi.fn(async ({ type }) => type === 'permissions' ? { grants: [] } : { items: [{ sessionId: 'guest', name: 'Shared', live: true, canWrite, canResize: false }] }), openSocket: vi.fn() };
  const outerMenu = vi.fn();
  const view = render(<div onContextMenu={outerMenu}><SessionAccessView client={client as unknown as SecureClient} initialViewMode="chat" /></div>);
  const input = await screen.findByRole('textbox', { name: 'Shared input' });
  expect((input as HTMLTextAreaElement).disabled).toBe(!canWrite);
  expect(fireEvent.contextMenu(input)).toBe(false);
  expect(outerMenu).not.toHaveBeenCalled();
  expect(screen.queryByText('插入待办提示')).toBeNull();
  expect(screen.queryByText('分享这个会话')).toBeNull();
  const text = screen.getByText('Shared history to copy');
  const range = document.createRange(); range.selectNodeContents(text); window.getSelection()?.addRange(range);
  expect(fireEvent.contextMenu(text)).toBe(true);
  expect(outerMenu).not.toHaveBeenCalled();
  expect(client.openSocket).not.toHaveBeenCalled();
  view.unmount();
});
