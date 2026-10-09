import { expect, it } from 'vitest';
import { normalizeSessionOrderGroups } from './display';

it('does not turn stale local membership or overlapping membership into standalone empty groups', () => {
  const groups = [
    { id: 'old', sessionIds: ['removed-a', 'removed-b'] },
    { id: 'active', sessionIds: ['a'] },
    { id: 'duplicate', sessionIds: ['a'] },
    { id: 'new', sessionIds: [] },
    { id: 'archived', sessionIds: [] },
    { id: 'offline', sessionIds: ['remote:offline'], federated: true },
  ];
  expect(normalizeSessionOrderGroups(groups, new Set(['a']))).toEqual([
    groups[1], groups[3], groups[4], { ...groups[5], sessionIds: [] },
  ]);
  expect(groups[0].sessionIds).toEqual(['removed-a', 'removed-b']);
});
