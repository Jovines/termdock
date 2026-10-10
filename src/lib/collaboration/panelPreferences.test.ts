import { useCollaborationNavigation } from '../stores/useCollaborationNavigation';
// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { collaborationGroupPreferences, openCollaborationGroups, collaborationPanelClientId, relativePanelPosition, openCollaborationMessagesPanel } from './panelPreferences';

it('keeps a stable client key across reopening while other clients have a different key', () => {
  localStorage.clear();
  const first = collaborationPanelClientId();
  expect(collaborationPanelClientId()).toBe(first);
  localStorage.clear();
  expect(collaborationPanelClientId()).not.toBe(first);
});

it('stores the same relative position on different screen sizes and clamps small viewports', () => {
  expect(relativePanelPosition(212, 112, 12, 12, 400, 200)).toEqual({ x: 0.5, y: 0.5 });
  expect(relativePanelPosition(62, 37, 12, 12, 100, 50)).toEqual({ x: 0.5, y: 0.5 });
  expect(relativePanelPosition(-20, 200, 12, 12, 100, 50)).toEqual({ x: 0, y: 1 });
  expect(relativePanelPosition(0, 0, 12, 12, 0, -10)).toEqual({ x: 0.5, y: 0.5 });
});

it('assigns legacy docking only to its original group and keeps it when adding scoped preferences', () => {
  const state = { floatingGroupId: 'a', mode: 'docked' as const,
    dock: { sessionId: 'one', side: 'right' as const },
    groups: { a: { floatingGroupId: 'a' }, b: { floatingGroupId: 'b' } } };
  expect(collaborationGroupPreferences(state, 'a').dock?.sessionId).toBe('one');
  expect(collaborationGroupPreferences(state, 'b').dock).toBeUndefined();
  expect(openCollaborationGroups(state)).toEqual(['a', 'b']);
  state.groups.a.floatingGroupId = '';
  expect(openCollaborationGroups(state)).toEqual(['b']);
});

const api = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('../terminal/api', () => ({ updateSettings: api.update }));

it('saves the current message draft and split layout before opening the resident panel', async () => {
  api.update.mockReset().mockResolvedValue({});
  useCollaborationNavigation.setState({ groupId: 'team', drafts: { team: { content: '仅消息协作', targets: ['worker'] } } });
  const open = vi.fn(); window.addEventListener('termdock:open-collaboration-messages', open);
  await openCollaborationMessagesPanel('team', 'lead');
  expect(api.update.mock.calls[0][0].collaborationPanel.state.drafts.team.content).toBe('仅消息协作');
  expect(api.update.mock.calls[1][0].collaborationPanel.state.groups.team).toMatchObject({ floatingGroupId: 'team', mode: 'docked', dock: { sessionId: 'lead', side: 'right' } });
  expect(open).toHaveBeenCalledOnce();
  window.removeEventListener('termdock:open-collaboration-messages', open);
});

it('does not open a panel or discard a draft when saving the layout fails', async () => {
  api.update.mockReset().mockRejectedValue(new Error('保存失败'));
  useCollaborationNavigation.setState({ groupId: 'team', drafts: {} });
  const open = vi.fn(); window.addEventListener('termdock:open-collaboration-messages', open);
  await expect(openCollaborationMessagesPanel('team', 'lead')).rejects.toThrow('保存失败');
  expect(open).not.toHaveBeenCalled();
  expect(useCollaborationNavigation.getState().groupId).toBe('team');
  window.removeEventListener('termdock:open-collaboration-messages', open);
});

it('does not pull the user out of a page selected while the layout save was pending', async () => {
  let resolve!: (value: unknown) => void;
  api.update.mockReset().mockImplementation(() => new Promise(done => { resolve = done; }));
  useCollaborationNavigation.setState({ groupId: 'team', drafts: {} });
  const open = vi.fn(); window.addEventListener('termdock:open-collaboration-messages', open);
  const pending = openCollaborationMessagesPanel('team', 'lead');
  await vi.waitFor(() => expect(api.update).toHaveBeenCalledOnce());
  useCollaborationNavigation.getState().open('other'); resolve({});
  await expect(pending).rejects.toThrow('页面已切换');
  expect(open).not.toHaveBeenCalled();
  window.removeEventListener('termdock:open-collaboration-messages', open);
});
