// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { collaborationGroupPreferences, openCollaborationGroups, collaborationPanelClientId, relativePanelPosition } from './panelPreferences';

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
