// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSessionOrderStore } from '../../stores/useSessionOrderStore';
import { SessionCollaborationActions } from './SessionCollaborationActions';

const mocks = vi.hoisted(() => ({ save: vi.fn(), peer: 'local', client: {} }));
vi.mock('../../terminal/api', () => ({ saveCollaborationGroup: mocks.save }));
vi.mock('../../federation/browserIntegration', () => ({
  currentSecureClient: () => mocks.client, savedConnection: () => ({ targetPeerId: mocks.peer }),
}));
const group = { id: 'group', name: '发布组', sessionIds: ['backend', 'other'], createdAt: 1, updatedAt: 10 };
const done = vi.fn(), open = vi.fn();
function setup() {
  return render(<SessionCollaborationActions sessionId="frontend" backendSessionId="backend"
    itemClassName="" iconClassName="" onOpen={open} onDone={done} />);
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.peer = 'local';
  useSessionOrderStore.setState({ collaborationGroups: [group] });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(cleanup);

it('opens the matching group and allows cancellation without changing membership', () => {
  setup();
  fireEvent.click(screen.getByRole('button', { name: /Open collaboration group/ }));
  expect(open).toHaveBeenCalledWith('group');
  fireEvent.click(screen.getByRole('button', { name: /Leave collaboration group/ }));
  expect(screen.getByText(/terminal keeps running/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(mocks.save).not.toHaveBeenCalled();
  expect(useSessionOrderStore.getState().collaborationGroups).toEqual([group]);
});

it('removes only this backend member, keeps empty groups, and synchronizes navigation', async () => {
  useSessionOrderStore.setState({ collaborationGroups: [{ ...group, sessionIds: ['backend'] }] });
  mocks.save.mockResolvedValue({ group: { ...group, sessionIds: [], updatedAt: 11 } });
  setup();
  fireEvent.click(screen.getByRole('button', { name: /Leave collaboration group/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm leave' }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith({ id: 'group', name: '发布组', sessionIds: [], expectedUpdatedAt: 10 });
  expect(useSessionOrderStore.getState().collaborationGroups[0].sessionIds).toEqual([]);
});

it('uses the confirmed revision and preserves newer membership when a save is rejected', async () => {
  mocks.save.mockRejectedValue(new Error('协作组已变化，请刷新后重试'));
  setup();
  fireEvent.click(screen.getByRole('button', { name: /Leave collaboration group/ }));
  act(() => useSessionOrderStore.setState({ collaborationGroups: [{ ...group, sessionIds: [...group.sessionIds, 'new'], updatedAt: 11 }] }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm leave' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '协作组已变化，请刷新后重试');
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ sessionIds: ['other'], expectedUpdatedAt: 10 }));
  expect(useSessionOrderStore.getState().collaborationGroups[0].sessionIds).toEqual(['backend', 'other', 'new']);
  expect(done).not.toHaveBeenCalled();
});

it('submits once while pending and ignores a response after switching services', async () => {
  let resolve!: (value: unknown) => void;
  mocks.save.mockReturnValue(new Promise(r => { resolve = r; }));
  setup();
  fireEvent.click(screen.getByRole('button', { name: /Leave collaboration group/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm leave' }));
  fireEvent.click(screen.getByRole('button', { name: 'Leaving…' }));
  expect(mocks.save).toHaveBeenCalledOnce();
  mocks.peer = 'different';
  await act(async () => resolve({ group: { ...group, sessionIds: ['other'], updatedAt: 11 } }));
  expect(done).not.toHaveBeenCalled();
  expect(useSessionOrderStore.getState().collaborationGroups).toEqual([group]);
});

it('shows no membership actions for sessions outside a collaboration group', () => {
  useSessionOrderStore.setState({ collaborationGroups: [{ ...group, sessionIds: ['other'] }] });
  setup();
  expect(screen.queryByRole('button')).toBeNull();
});
