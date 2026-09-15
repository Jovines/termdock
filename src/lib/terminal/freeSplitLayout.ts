export type SplitNode = { id: string } | { axis: 'x' | 'y'; ratio: number; first: SplitNode; second: SplitNode };
export type PaneSide = 'left' | 'right' | 'top' | 'bottom';
export interface PaneRect { x: number; y: number; width: number; height: number }
export const unitRect: PaneRect = { x: 0, y: 0, width: 1, height: 1 };
export function leafIds(node: SplitNode): string[] { return 'id' in node ? [node.id] : [...leafIds(node.first), ...leafIds(node.second)]; }
export function normalizeSplitNode(value: unknown, depth = 0, seen = new Set<string>()): SplitNode | null {
  if (!value || typeof value !== 'object' || depth > 24) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id === 'string' && raw.id && !seen.has(raw.id)) { seen.add(raw.id); return { id: raw.id }; }
  if (!['x', 'y'].includes(String(raw.axis)) || !Number.isFinite(raw.ratio)) return null;
  const first = normalizeSplitNode(raw.first, depth + 1, seen), second = normalizeSplitNode(raw.second, depth + 1, seen);
  return first && second ? { axis: raw.axis as 'x' | 'y', ratio: Math.max(0.02, Math.min(0.98, Number(raw.ratio))), first, second } : first ?? second;
}
export function pruneLayout(node: SplitNode, ids: Set<string>): SplitNode | null {
  if ('id' in node) return ids.has(node.id) ? node : null;
  const first = pruneLayout(node.first, ids), second = pruneLayout(node.second, ids);
  return first && second ? { ...node, first, second } : first ?? second;
}
export function splitLeaf(node: SplitNode, target: string, id: string, side: PaneSide): SplitNode {
  if ('id' in node) return node.id === target ? { axis: side === 'left' || side === 'right' ? 'x' : 'y', ratio: 0.5,
    first: side === 'left' || side === 'top' ? { id } : node, second: side === 'left' || side === 'top' ? node : { id } } : node;
  return { ...node, first: splitLeaf(node.first, target, id, side), second: splitLeaf(node.second, target, id, side) };
}
export function movePane(node: SplitNode, source: string, target: string, side: PaneSide | 'center'): SplitNode {
  if (source === target || !leafIds(node).includes(source) || !leafIds(node).includes(target)) return node;
  if (side === 'center') {
    const swap = (n: SplitNode): SplitNode => 'id' in n ? { id: n.id === source ? target : n.id === target ? source : n.id } : { ...n, first: swap(n.first), second: swap(n.second) };
    return swap(node);
  }
  return splitLeaf(pruneLayout(node, new Set(leafIds(node).filter(id => id !== source)))!, target, source, side);
}
export function presetLayout(ids: string[], mode: 'horizontal' | 'vertical' | 'grid'): SplitNode {
  if (ids.length === 1) return { id: ids[0] };
  if (mode === 'grid' && ids.length > 2) {
    const count = Math.ceil(ids.length / 2);
    return { axis: 'y', ratio: 0.5, first: presetLayout(ids.slice(0, count), 'horizontal'), second: presetLayout(ids.slice(count), 'horizontal') };
  }
  return { axis: mode === 'vertical' ? 'y' : 'x', ratio: 1 / ids.length, first: { id: ids[0] }, second: presetLayout(ids.slice(1), mode) };
}
export function layoutRects(node: SplitNode, rect = unitRect, path = ''): { panes: { id: string; rect: PaneRect }[]; dividers: { path: string; node: Exclude<SplitNode, { id: string }>; rect: PaneRect }[] } {
  if ('id' in node) return { panes: [{ id: node.id, rect }], dividers: [] };
  const a = { ...rect }, b = { ...rect };
  if (node.axis === 'x') { a.width *= node.ratio; b.x += a.width; b.width -= a.width; }
  else { a.height *= node.ratio; b.y += a.height; b.height -= a.height; }
  const first = layoutRects(node.first, a, path + '0'), second = layoutRects(node.second, b, path + '1');
  return { panes: [...first.panes, ...second.panes], dividers: [{ path, node, rect }, ...first.dividers, ...second.dividers] };
}
export function resizeNode(node: SplitNode, path: string, ratio: number): SplitNode {
  if ('id' in node) return node;
  if (!path) return { ...node, ratio };
  return path[0] === '0' ? { ...node, first: resizeNode(node.first, path.slice(1), ratio) } : { ...node, second: resizeNode(node.second, path.slice(1), ratio) };
}
export function fourPaneBoundaries(node: SplitNode) {
  if ('id' in node || 'id' in node.first || 'id' in node.second || node.first.axis === node.axis || node.second.axis === node.axis ||
    !('id' in node.first.first) || !('id' in node.first.second) || !('id' in node.second.first) || !('id' in node.second.second)) return null;
  return node.axis === 'y'
    ? { ids: [node.first.first.id, node.first.second.id, node.second.first.id, node.second.second.id], top: node.first.ratio, bottom: node.second.ratio, left: node.ratio, right: node.ratio }
    : { ids: [node.first.first.id, node.second.first.id, node.first.second.id, node.second.second.id], top: node.ratio, bottom: node.ratio, left: node.first.ratio, right: node.second.ratio };
}
/** Four independently draggable half-lines; changing the main axis reconciles T-junctions. */
export function resizeFourBoundary(node: SplitNode, side: PaneSide, ratio: number): SplitNode {
  const shape = fourPaneBoundaries(node);
  if (!shape) return node;
  const [tl, tr, bl, br] = shape.ids.map(id => ({ id }));
  if (side === 'top' || side === 'bottom') return { axis: 'y', ratio: (shape.left + shape.right) / 2,
    first: { axis: 'x', ratio: side === 'top' ? ratio : shape.top, first: tl, second: tr },
    second: { axis: 'x', ratio: side === 'bottom' ? ratio : shape.bottom, first: bl, second: br } };
  return { axis: 'x', ratio: (shape.top + shape.bottom) / 2,
    first: { axis: 'y', ratio: side === 'left' ? ratio : shape.left, first: tl, second: bl },
    second: { axis: 'y', ratio: side === 'right' ? ratio : shape.right, first: tr, second: br } };
}

/** Translate existing row/column/grid ratios without discarding a user's current sizes. */
export function legacySplitTree(ids: string[], mode: 'horizontal' | 'vertical' | 'grid', ratios?: number[], columns?: number[], rows?: number[]): SplitNode {
  const weighted = (nodes: SplitNode[], axis: 'x' | 'y', weights?: number[]): SplitNode => {
    if (nodes.length === 1) return nodes[0];
    const valid = weights?.length === nodes.length && weights.every(n => Number.isFinite(n) && n > 0) ? weights : nodes.map(() => 1);
    return { axis, ratio: valid[0] / valid.reduce((a, b) => a + b, 0), first: nodes[0], second: weighted(nodes.slice(1), axis, valid.slice(1)) };
  };
  if (mode !== 'grid') return weighted(ids.map(id => ({ id })), mode === 'vertical' ? 'y' : 'x', ratios);
  const count = Math.ceil(Math.sqrt(ids.length));
  const rowNodes: SplitNode[] = [];
  for (let i = 0; i < ids.length; i += count) {
    const leaves = ids.slice(i, i + count).map(id => ({ id }));
    const weights = columns?.length === count ? columns.slice(0, leaves.length) : undefined;
    if (weights && leaves.length < count) weights[weights.length - 1] += columns!.slice(leaves.length).reduce((a, b) => a + b, 0);
    rowNodes.push(weighted(leaves, 'x', weights));
  }
  return weighted(rowNodes, 'y', rows);
}
