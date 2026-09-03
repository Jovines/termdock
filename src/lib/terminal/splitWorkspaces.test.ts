import { describe, expect, it } from 'vitest';
import {
  combineSplitWorkspaces,
  findSplitWorkspace,
  getSplitGridDimensions,
  normalizeSplitWorkspaces,
  pruneSplitWorkspaces,
  removeSessionFromSplitWorkspace,
  reorderSplitWorkspaceSessions,
  resizeAdjacentRatios,
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

  it('uses a grid for larger workspaces and can remove one pane without dissolving the rest', () => {
    let workspaces = combineSplitWorkspaces([], 'A', 'B');
    workspaces = combineSplitWorkspaces(workspaces, 'A', 'C');
    expect(workspaces[0]).toMatchObject({ sessionIds: ['A', 'B', 'C'], layout: 'grid' });

    workspaces = removeSessionFromSplitWorkspace(workspaces, 'B');
    expect(workspaces[0]?.sessionIds).toEqual(['A', 'C']);
    expect(removeSessionFromSplitWorkspace(workspaces, 'A')).toEqual([]);
  });

  it('normalizes independent column and row ratios for grid workspaces', () => {
    expect(getSplitGridDimensions(4)).toEqual({ columns: 2, rows: 2 });
    expect(getSplitGridDimensions(5)).toEqual({ columns: 3, rows: 2 });

    const [workspace] = normalizeSplitWorkspaces([
      {
        id: 'grid',
        sessionIds: ['A', 'B', 'C', 'D'],
        layout: 'grid',
        ratios: [1, 1, 1, 1],
        gridColumnRatios: [1, 3],
        gridRowRatios: [2, 1],
      },
    ]);
    expect(workspace?.gridColumnRatios).toEqual([0.25, 0.75]);
    expect(workspace?.gridRowRatios).toEqual([2 / 3, 1 / 3]);
  });

  it('resizes only the two tracks next to a dragged grid divider', () => {
    expect(resizeAdjacentRatios([0.2, 0.3, 0.5], 1, 0.75, 0.1)).toEqual([
      0.2,
      0.55,
      0.25,
    ]);
    const clamped = resizeAdjacentRatios([0.5, 0.5], 0, 0.95, 0.2);
    expect(clamped[0]).toBeCloseTo(0.8);
    expect(clamped[1]).toBeCloseTo(0.2);
  });
});
