// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSessionOrderStore } from '../../stores/useSessionOrderStore';
import { CollaborationSessionMenu } from './CollaborationSessionMenu';

const mocks = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('../../terminal/api', () => ({ saveCollaborationGroup: mocks.save }));
vi.mock('../../federation/browserIntegration', () => ({ currentSecureClient: () => undefined, savedConnection: () => null }));
const remoteId = 'remote:https%3A%2F%2Foffline.example:n2w8lg8d';
const group = { id: 'team', name: '协作', sessionIds: ['local', remoteId], createdAt: 1, updatedAt: 10 };
const select = vi.fn(), open = vi.fn();
function setup(id = remoteId) {
  useSessionOrderStore.setState({ collaborationGroups: [{ ...group, sessionIds: ['local', id] }] });
  return render(<CollaborationSessionMenu sessionId={id} groupId="team" label="n2w8lg8d" detail="远端服务 · 连接已断开" onOpen={open}>
    <button onClick={select}>n2w8lg8d</button>
  </CollaborationSessionMenu>);
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each([remoteId, 'n2w8lg8d'])('manages an offline saved member without opening or destroying its terminal (%s)', async id => {
  mocks.save.mockResolvedValue({ group: { ...group, sessionIds: ['local'], updatedAt: 11 } });
  setup(id);
  fireEvent.contextMenu(screen.getByText('n2w8lg8d'), { clientX: 200, clientY: 300 });
  expect(screen.getByRole('dialog', { name: 'n2w8lg8d' })).toBeTruthy();
  expect(select).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /Leave collaboration group/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm leave' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith({ id: 'team', name: '协作', sessionIds: ['local'], expectedUpdatedAt: 10 });
  expect(select).not.toHaveBeenCalled();
});

it('opens from its visible action or keyboard, restores focus, and leaves membership unchanged on dismiss', () => {
  setup();
  const action = screen.getByRole('button', { name: '成员操作：n2w8lg8d' });
  action.focus(); fireEvent.click(action);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.keyDown(screen.getByText('n2w8lg8d'), { key: 'F10', shiftKey: true });
  fireEvent.click(screen.getByRole('button', { name: /Open collaboration group/ }));
  expect(open).toHaveBeenCalledOnce();
  expect(mocks.save).not.toHaveBeenCalled();
});

it('supports touch long-press on a saved row and does not switch sessions on release', () => {
  vi.useFakeTimers();
  vi.stubGlobal('PointerEvent', class extends MouseEvent { pointerId = 1; pointerType = 'touch'; });
  setup();
  const member = screen.getByText('n2w8lg8d');
  fireEvent.pointerDown(member, { clientX: 60, clientY: 120 });
  act(() => vi.advanceTimersByTime(550));
  expect(screen.getByRole('dialog', { name: 'n2w8lg8d' })).toBeTruthy();
  fireEvent.pointerUp(member); fireEvent.click(member);
  expect(select).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /Leave collaboration group/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(mocks.save).not.toHaveBeenCalled();
});
