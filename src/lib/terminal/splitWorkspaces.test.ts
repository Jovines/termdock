import { describe, expect, it } from 'vitest';
import {
  combineSplitWorkspaces,
  findSplitWorkspace,
  normalizeSplitWorkspaces,
  pruneSplitWorkspaces,
  reorderSplitWorkspaceSessions,
  renameSplitWorkspace,
} from './splitWorkspaces';

describe('split workspaces', () => {
  it('keeps multiple independent groups and merges either group on demand', () => {
    let workspaces = combineSplitWorkspaces([], 'A', 'B');
    workspaces = combineSplitWorkspaces(workspaces, 'C', 'D');
    expect(workspaces.map((workspace) => workspace.sessionIds)).toEqual([['A', 'B'], ['C', 'D']]);

    workspaces = combineSplitWorkspaces(workspaces, 'B', 'C');
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.sessionIds).toEqual(['A', 'B', 'C', 'D']);
  });

  it('prunes closed sessions and dissolves one-pane groups', () => {
    const workspaces = normalizeSplitWorkspaces([
      { id: 'one', sessionIds: ['A', 'B', 'C'], layout: 'grid', ratios: [0.2, 0.3, 0.5] },
      { id: 'two', sessionIds: ['D', 'E'], layout: 'vertical', ratios: [0.5, 0.5] },
    ]);
    const pruned = pruneSplitWorkspaces(workspaces, ['A', 'C', 'D']);
    expect(pruned).toHaveLength(1);
    expect(pruned[0]).toMatchObject({ id: 'one', sessionIds: ['A', 'C'], layout: 'grid' });
    expect(findSplitWorkspace(pruned, 'C')?.id).toBe('one');
  });

  it('rejects duplicate membership and malformed persisted data', () => {
    expect(normalizeSplitWorkspaces([
      { id: 'one', sessionIds: ['A', 'A', 'B'], layout: 'nope', ratios: [] },
      { id: 'two', sessionIds: ['B', 'C'], layout: 'vertical', ratios: [1, 1] },
    ])).toEqual([
      { id: 'one', sessionIds: ['A', 'B'], layout: 'horizontal', ratios: [0.5, 0.5] },
    ]);
  });

  it('reorders panes without changing workspace membership', () => {
    const workspaces = normalizeSplitWorkspaces([
      { id: 'one', sessionIds: ['A', 'B', 'C'], layout: 'grid', ratios: [1, 1, 1] },
    ]);
    expect(reorderSplitWorkspaceSessions(workspaces, 'one', ['C', 'A', 'B'])[0]?.sessionIds)
      .toEqual(['C', 'A', 'B']);
    expect(reorderSplitWorkspaceSessions(workspaces, 'one', ['A', 'C'])[0]?.sessionIds)
      .toEqual(['A', 'B', 'C']);
  });

  it('sets and clears a custom workspace name', () => {
    const workspaces = normalizeSplitWorkspaces([
      { id: 'one', sessionIds: ['A', 'B'], layout: 'horizontal', ratios: [1, 1] },
    ]);
    const named = renameSplitWorkspace(workspaces, 'one', '  API work  ');
    expect(named[0]?.name).toBe('API work');
    expect(renameSplitWorkspace(named, 'one', '')[0]?.name).toBeUndefined();
  });
});
