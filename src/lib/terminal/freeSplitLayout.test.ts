import { describe, expect, it } from 'vitest';
import { fourPaneBoundaries, layoutRects, leafIds, movePane, normalizeSplitNode, presetLayout, pruneLayout, resizeFourBoundary, splitLeaf, type SplitNode } from './freeSplitLayout';

function assertTiling(tree: SplitNode, ids: string[]) {
  const { panes } = layoutRects(tree);
  expect(leafIds(tree).sort()).toEqual([...ids].sort());
  expect(new Set(leafIds(tree)).size).toBe(ids.length);
  expect(panes.reduce((sum, p) => sum + p.rect.width * p.rect.height, 0)).toBeCloseTo(1, 10);
  for (const { rect: a } of panes) {
    expect(a.width).toBeGreaterThan(0); expect(a.height).toBeGreaterThan(0);
    expect(a.x).toBeGreaterThanOrEqual(0); expect(a.y).toBeGreaterThanOrEqual(0);
    expect(a.x + a.width).toBeLessThanOrEqual(1.000000001); expect(a.y + a.height).toBeLessThanOrEqual(1.000000001);
    for (const { rect: b } of panes) if (a !== b) {
      const overlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      expect(overlap).toBeLessThan(1e-10);
    }
  }
}

describe('four independent boundary segments', () => {
  it('moves the upper half without moving the lower half, then reconciles horizontal T-junctions', () => {
    let tree = presetLayout(['a', 'b', 'c', 'd'], 'grid');
    tree = resizeFourBoundary(tree, 'top', 0.3);
    expect(fourPaneBoundaries(tree)).toMatchObject({ top: 0.3, bottom: 0.5 });
    tree = resizeFourBoundary(tree, 'bottom', 0.7);
    expect(fourPaneBoundaries(tree)).toMatchObject({ top: 0.3, bottom: 0.7 });
    tree = resizeFourBoundary(tree, 'left', 0.2);
    expect(fourPaneBoundaries(tree)).toMatchObject({ left: 0.2, right: 0.5 });
    assertTiling(tree, ['a', 'b', 'c', 'd']);
  });
  it('keeps exactly four rectangles through repeated boundary crossings and tiny/large ratios', () => {
    let tree = presetLayout(['a', 'b', 'c', 'd'], 'grid');
    for (let i = 0; i < 400; i++) {
      tree = resizeFourBoundary(tree, (['top', 'left', 'bottom', 'right'] as const)[i % 4], 0.02 + ((i * 67) % 97) / 100);
      assertTiling(tree, ['a', 'b', 'c', 'd']);
    }
  });
});
it('forms three panes above one and one above three by moving existing leaves', () => {
  const initial = presetLayout(['a', 'b', 'c', 'd'], 'grid');
  const top = movePane(initial, 'c', 'a', 'left');
  const topRects = layoutRects(top).panes;
  expect(topRects.filter(p => p.rect.y === 0)).toHaveLength(3);
  expect(topRects.find(p => p.id === 'd')?.rect.width).toBe(1);
  assertTiling(top, ['a', 'b', 'c', 'd']);
  const bottom = movePane(initial, 'b', 'c', 'right');
  expect(layoutRects(bottom).panes.find(p => p.id === 'a')?.rect.width).toBe(1);
  assertTiling(bottom, ['a', 'b', 'c', 'd']);
});
it('uses the same split/move/prune operations for collaboration and terminal panes', () => {
  let tree = presetLayout(['a', 'b', 'c'], 'grid');
  tree = splitLeaf(tree, 'c', '@collaboration', 'right');
  expect(fourPaneBoundaries(tree)).not.toBeNull();
  tree = movePane(tree, '@collaboration', 'a', 'top');
  assertTiling(tree, ['a', 'b', 'c', '@collaboration']);
  const removed = pruneLayout(tree, new Set(['a', 'b', 'c']))!;
  assertTiling(removed, ['a', 'b', 'c']);
});
it('swaps at the center and ignores invalid or self drops', () => {
  const tree = presetLayout(['a', 'b', 'c', 'd'], 'grid');
  expect(leafIds(movePane(tree, 'a', 'd', 'center'))).toEqual(['d', 'b', 'c', 'a']);
  expect(movePane(tree, 'a', 'a', 'left')).toBe(tree);
  expect(movePane(tree, 'missing', 'a', 'left')).toBe(tree);
});
it('rejects corrupt saved trees and removes duplicate leaves', () => {
  expect(normalizeSplitNode({ axis: 'x', ratio: 'bad' })).toBeNull();
  expect(normalizeSplitNode({ axis: 'x', ratio: 0.5, first: { id: 'a' }, second: { id: 'a' } })).toEqual({ id: 'a' });
});
it('preserves existing grid sizes during migration', async () => {
  const { legacySplitTree } = await import('./freeSplitLayout');
  const tree = legacySplitTree(['a', 'b', 'c', 'd'], 'grid', undefined, [0.3, 0.7], [0.4, 0.6]);
  expect(fourPaneBoundaries(tree)).toMatchObject({ top: 0.3, bottom: 0.3, left: 0.4, right: 0.4 });
  assertTiling(tree, ['a', 'b', 'c', 'd']);
});
