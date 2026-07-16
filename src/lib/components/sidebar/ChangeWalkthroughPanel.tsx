import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, GitBranch, Link2, Sparkles } from 'lucide-react';
import type { ChangeWalkthrough, ChangeWalkthroughAnchor, ChangeWalkthroughEdge, ChangeWalkthroughNode } from '../../terminal/api';

interface ChangeWalkthroughPanelProps {
  walkthroughs: ChangeWalkthrough[];
  repoRoot?: string | null;
  onNavigate: (anchor: ChangeWalkthroughAnchor) => void;
}

function pickWalkthrough(walkthroughs: ChangeWalkthrough[], repoRoot?: string | null): ChangeWalkthrough | null {
  const candidates = repoRoot ? walkthroughs.filter((item) => item.repoRoot === repoRoot) : walkthroughs;
  return candidates.slice().sort((a, b) => b.injectedAt - a.injectedAt)[0] ?? null;
}

function getKindRailClass(kind?: string | null): string {
  switch (kind) {
    case 'entry':
    case 'source':
      return 'bg-sky-400';
    case 'ui':
      return 'bg-fuchsia-400';
    case 'risk':
      return 'bg-destructive';
    case 'test':
      return 'bg-emerald-400';
    default:
      return 'bg-primary';
  }
}

function anchorTitle(anchor?: ChangeWalkthroughAnchor | null): string | undefined {
  if (!anchor) return undefined;
  const section = typeof anchor.sectionIndex === 'number' ? ` section ${anchor.sectionIndex + 1}` : '';
  const hunk = typeof anchor.hunkIndex === 'number' ? ` hunk ${anchor.hunkIndex + 1}` : '';
  return `${anchor.filePath}${hunk}${section}`;
}

function AnchorButton({
  anchor,
  children,
  onNavigate,
  className,
  style,
  elementRef,
}: {
  anchor?: ChangeWalkthroughAnchor | null;
  children: ReactNode;
  onNavigate: (anchor: ChangeWalkthroughAnchor) => void;
  className: string;
  style?: CSSProperties;
  elementRef?: (element: HTMLElement | null) => void;
}) {
  if (!anchor) return <span ref={elementRef} className={className} style={style}>{children}</span>;
  return (
    <button
      ref={elementRef as (element: HTMLButtonElement | null) => void}
      type="button"
      onClick={() => onNavigate(anchor)}
      title={anchorTitle(anchor)}
      className={`${className} text-left transition hover:border-primary/35 hover:bg-primary/15 active:scale-[0.99]`}
      style={style}
    >
      {children}
    </button>
  );
}

interface DagLayoutNode {
  node: ChangeWalkthroughNode;
  index: number;
  layer: number;
  row: number;
  x: number;
  y: number;
  height: number;
}

interface DagLayoutEdge extends ChangeWalkthroughEdge {
  key: string;
  index: number;
  fromNode: DagLayoutNode;
  toNode: DagLayoutNode;
  routeIndex: number;
  fromPortIndex: number;
  toPortIndex: number;
  fromY: number;
  toY: number;
  laneY: number;
}

const DAG_NODE_WIDTH = 190;
const DAG_NODE_HEIGHT = 92;
const DAG_COLUMN_GAP = 132;
const DAG_ROW_GAP = 28;
const DAG_PADDING = 16;
const DAG_ROUTE_GAP = 18;
const DAG_ROUTING_GUTTER = 54;
const DAG_CARD_CLEARANCE = 24;
const DAG_PORT_GAP = 18;
const DAG_EDGE_LABEL_GAP = 8;
const DAG_EDGE_LABEL_HEIGHT = 24;

const DAG_EDGE_COLORS = [
  'rgb(var(--primary-rgb))',
  'rgb(var(--accent-rgb))',
  'rgb(var(--warning-rgb))',
  'rgb(var(--success-rgb))',
  'rgb(192 132 252)',
] as const;

function getDagEdgeColor(index: number): string {
  return DAG_EDGE_COLORS[index % DAG_EDGE_COLORS.length];
}

function getDagEdgeKey(edge: ChangeWalkthroughEdge, index: number): string {
  return `${edge.from}->${edge.to}:${index}`;
}

function getNodeDegreeHeight(nodeId: string, incoming: Map<string, string[]>, outgoing: Map<string, string[]>): number {
  const portCount = Math.max(incoming.get(nodeId)?.length ?? 0, outgoing.get(nodeId)?.length ?? 0);
  return Math.max(DAG_NODE_HEIGHT, 36 + Math.max(0, portCount - 1) * DAG_PORT_GAP);
}

function getPortY(node: DagLayoutNode, portIndex: number, portCount: number): number {
  if (portCount <= 1) return node.y + node.height / 2;
  const availableSpan = Math.max(0, node.height - 36);
  const span = Math.min(availableSpan, (portCount - 1) * DAG_PORT_GAP);
  return node.y + node.height / 2 - span / 2 + (span / (portCount - 1)) * portIndex;
}

function getConnectionOrder(
  edgeIndexes: number[],
  edges: Array<DagLayoutEdge>,
  side: 'from' | 'to',
): number[] {
  return edgeIndexes.slice().sort((leftIndex, rightIndex) => {
    const left = edges[leftIndex];
    const right = edges[rightIndex];
    const leftOpposite = side === 'from' ? left.toNode : left.fromNode;
    const rightOpposite = side === 'from' ? right.toNode : right.fromNode;
    return leftOpposite.y - rightOpposite.y
      || leftOpposite.index - rightOpposite.index
      || left.index - right.index;
  });
}

function packEdgeLanes(
  edges: DagLayoutEdge[],
  measuredLabelHeights: Record<string, number>,
): void {
  const byLayerPair = new Map<string, DagLayoutEdge[]>();
  for (const edge of edges) {
    if (Math.abs(edge.toNode.layer - edge.fromNode.layer) !== 1) continue;
    const key = `${edge.fromNode.layer}:${edge.toNode.layer}`;
    const group = byLayerPair.get(key) ?? [];
    group.push(edge);
    byLayerPair.set(key, group);
  }

  for (const group of byLayerPair.values()) {
    group.sort((left, right) => (
      (left.fromY + left.toY) / 2 - (right.fromY + right.toY) / 2
      || left.index - right.index
    ));
    const positions: number[] = [];
    group.forEach((edge, index) => {
      const desiredY = (edge.fromY + edge.toY) / 2;
      const currentHalfHeight = Math.max(DAG_EDGE_LABEL_HEIGHT, measuredLabelHeights[edge.key] ?? 0) / 2;
      if (index === 0) {
        positions.push(desiredY);
        return;
      }
      const previous = group[index - 1];
      const previousHalfHeight = Math.max(DAG_EDGE_LABEL_HEIGHT, measuredLabelHeights[previous.key] ?? 0) / 2;
      positions.push(Math.max(desiredY, positions[index - 1] + previousHalfHeight + currentHalfHeight + DAG_EDGE_LABEL_GAP));
    });

    const averageShift = positions.reduce((sum, position, index) => (
      sum + position - (group[index].fromY + group[index].toY) / 2
    ), 0) / Math.max(1, positions.length);
    const top = Math.min(...positions.map((position, index) => (
      position - averageShift - Math.max(DAG_EDGE_LABEL_HEIGHT, measuredLabelHeights[group[index].key] ?? 0) / 2
    )));
    const topCorrection = Math.max(0, DAG_PADDING - top);
    group.forEach((edge, index) => {
      edge.laneY = positions[index] - averageShift + topCorrection;
    });
  }
}

function buildDagLayout(
  nodes: ChangeWalkthroughNode[],
  edges: ChangeWalkthroughEdge[],
  measuredHeights: Record<string, number> = {},
  measuredLabelHeights: Record<string, number> = {},
) {
  const nodeById = new Map(nodes.map((node, index) => [node.id, { node, index }]));
  const validEdges = edges.filter((edge) => nodeById.has(edge.from) && nodeById.has(edge.to));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) {
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
  }
  for (const edge of validEdges) {
    incoming.get(edge.to)?.push(edge.from);
    outgoing.get(edge.from)?.push(edge.to);
  }

  const layerById = new Map<string, number>();
  const visiting = new Set<string>();
  const resolveLayer = (nodeId: string): number => {
    const existing = layerById.get(nodeId);
    if (existing !== undefined) return existing;
    if (visiting.has(nodeId)) return 0;
    visiting.add(nodeId);
    const parents = incoming.get(nodeId) ?? [];
    const layer = parents.length === 0 ? 0 : Math.max(...parents.map(resolveLayer)) + 1;
    visiting.delete(nodeId);
    layerById.set(nodeId, layer);
    return layer;
  };
  for (const node of nodes) resolveLayer(node.id);

  const byLayer = new Map<number, Array<{ node: ChangeWalkthroughNode; index: number }>>();
  for (const node of nodes) {
    const layer = layerById.get(node.id) ?? 0;
    const list = byLayer.get(layer) ?? [];
    const indexed = nodeById.get(node.id);
    if (indexed) list.push(indexed);
    byLayer.set(layer, list);
  }

  const layoutNodes: DagLayoutNode[] = [];
  for (const [layer, list] of byLayer.entries()) {
    list.sort((a, b) => a.index - b.index);
    let y = DAG_PADDING + DAG_ROUTING_GUTTER;
    list.forEach(({ node, index }, row) => {
      const height = Math.max(
        getNodeDegreeHeight(node.id, incoming, outgoing),
        Math.ceil(measuredHeights[node.id] ?? DAG_NODE_HEIGHT),
      );
      layoutNodes.push({
        node,
        index,
        layer,
        row,
        x: DAG_PADDING + layer * (DAG_NODE_WIDTH + DAG_COLUMN_GAP),
        y,
        height,
      });
      y += height + DAG_ROW_GAP;
    });
  }

  const layoutById = new Map(layoutNodes.map((entry) => [entry.node.id, entry]));
  const layoutEdges: DagLayoutEdge[] = validEdges.flatMap((edge, index) => {
    const fromNode = layoutById.get(edge.from);
    const toNode = layoutById.get(edge.to);
    if (!fromNode || !toNode) return [];
    return [{
      ...edge,
      key: getDagEdgeKey(edge, index),
      index,
      fromNode,
      toNode,
      routeIndex: index,
      fromPortIndex: 0,
      toPortIndex: 0,
      fromY: fromNode.y + fromNode.height / 2,
      toY: toNode.y + toNode.height / 2,
      laneY: (fromNode.y + fromNode.height / 2 + toNode.y + toNode.height / 2) / 2,
    }];
  });

  const outgoingEdgeIndexes = new Map<string, number[]>();
  const incomingEdgeIndexes = new Map<string, number[]>();
  layoutEdges.forEach((edge, edgeIndex) => {
    outgoingEdgeIndexes.set(edge.from, [...(outgoingEdgeIndexes.get(edge.from) ?? []), edgeIndex]);
    incomingEdgeIndexes.set(edge.to, [...(incomingEdgeIndexes.get(edge.to) ?? []), edgeIndex]);
  });
  for (const [nodeId, edgeIndexes] of outgoingEdgeIndexes) {
    const ordered = getConnectionOrder(edgeIndexes, layoutEdges, 'from');
    ordered.forEach((edgeIndex, portIndex) => {
      const edge = layoutEdges[edgeIndex];
      edge.fromPortIndex = portIndex;
      edge.fromY = getPortY(layoutById.get(nodeId) as DagLayoutNode, portIndex, ordered.length);
    });
  }
  for (const [nodeId, edgeIndexes] of incomingEdgeIndexes) {
    const ordered = getConnectionOrder(edgeIndexes, layoutEdges, 'to');
    ordered.forEach((edgeIndex, portIndex) => {
      const edge = layoutEdges[edgeIndex];
      edge.toPortIndex = portIndex;
      edge.toY = getPortY(layoutById.get(nodeId) as DagLayoutNode, portIndex, ordered.length);
    });
  }

  packEdgeLanes(layoutEdges, measuredLabelHeights);
  let longRouteIndex = 0;
  layoutEdges.forEach((edge) => {
    const minLayer = Math.min(edge.fromNode.layer, edge.toNode.layer);
    const maxLayer = Math.max(edge.fromNode.layer, edge.toNode.layer);
    const layerDistance = maxLayer - minLayer;
    if (layerDistance <= 1) return;

    const routeIndex = longRouteIndex;
    longRouteIndex += 1;
    edge.routeIndex = routeIndex;
    const blockers = layoutNodes.filter((node) => node.layer >= minLayer && node.layer <= maxLayer);
    const top = Math.min(...blockers.map((node) => node.y)) - DAG_CARD_CLEARANCE - (Math.floor(routeIndex / 2) + 1) * DAG_ROUTE_GAP;
    const bottom = Math.max(...blockers.map((node) => node.y + node.height)) + DAG_CARD_CLEARANCE + (Math.floor(routeIndex / 2) + 1) * DAG_ROUTE_GAP;
    edge.laneY = routeIndex % 2 === 0 ? Math.max(DAG_PADDING, top) : bottom;
  });
  const maxLayer = Math.max(0, ...layoutNodes.map((node) => node.layer));
  const contentBottom = Math.max(
    DAG_PADDING + DAG_ROUTING_GUTTER + DAG_NODE_HEIGHT,
    ...layoutNodes.map((node) => node.y + node.height),
    ...layoutEdges.map((edge) => edge.laneY + Math.max(DAG_EDGE_LABEL_HEIGHT, measuredLabelHeights[edge.key] ?? 0) / 2),
  );
  return {
    nodes: layoutNodes,
    edges: layoutEdges,
    width: DAG_PADDING * 2 + (maxLayer + 1) * DAG_NODE_WIDTH + maxLayer * DAG_COLUMN_GAP,
    height: contentBottom + DAG_PADDING + DAG_ROUTING_GUTTER,
  };
}

function getRoundedOrthogonalPath(points: Array<{ x: number; y: number }>, radius = 12): string {
  const first = points[0];
  if (!first) return '';
  const commands = [`M ${first.x} ${first.y}`];
  for (let index = 1; index < points.length; index += 1) {
    const prev = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    if (!next) {
      commands.push(`L ${current.x} ${current.y}`);
      continue;
    }
    const incomingX = current.x - prev.x;
    const incomingY = current.y - prev.y;
    const outgoingX = next.x - current.x;
    const outgoingY = next.y - current.y;
    const incomingLength = Math.abs(incomingX) + Math.abs(incomingY);
    const outgoingLength = Math.abs(outgoingX) + Math.abs(outgoingY);
    if (incomingLength === 0 || outgoingLength === 0 || (incomingX && outgoingX) || (incomingY && outgoingY)) {
      commands.push(`L ${current.x} ${current.y}`);
      continue;
    }
    const r = Math.min(radius, incomingLength / 2, outgoingLength / 2);
    const before = {
      x: current.x - Math.sign(incomingX) * r,
      y: current.y - Math.sign(incomingY) * r,
    };
    const after = {
      x: current.x + Math.sign(outgoingX) * r,
      y: current.y + Math.sign(outgoingY) * r,
    };
    commands.push(`L ${before.x} ${before.y}`);
    commands.push(`Q ${current.x} ${current.y} ${after.x} ${after.y}`);
  }
  return commands.join(' ');
}

function getDagEdgePath(edge: DagLayoutEdge): string {
  const x1 = edge.fromNode.x + DAG_NODE_WIDTH + 8;
  const y1 = edge.fromY;
  const x2 = edge.toNode.x - 8;
  const y2 = edge.toY;
  const layerDistance = Math.abs(edge.toNode.layer - edge.fromNode.layer);
  const startGutterX = x1 + 22 + edge.fromPortIndex * 5;
  const endGutterX = x2 - 22 - edge.toPortIndex * 5;
  if (layerDistance <= 1) {
    return getRoundedOrthogonalPath([
      { x: x1, y: y1 },
      { x: startGutterX, y: y1 },
      { x: startGutterX, y: edge.laneY },
      { x: endGutterX, y: edge.laneY },
      { x: endGutterX, y: y2 },
      { x: x2, y: y2 },
    ]);
  }

  return getRoundedOrthogonalPath([
    { x: x1, y: y1 },
    { x: startGutterX, y: y1 },
    { x: startGutterX, y: edge.laneY },
    { x: endGutterX, y: edge.laneY },
    { x: endGutterX, y: y2 },
    { x: x2, y: y2 },
  ]);
}

function getDagEdgeLabelPosition(edge: DagLayoutEdge): { x: number; y: number; maxWidth: number } {
  const x1 = edge.fromNode.x + DAG_NODE_WIDTH + 8;
  const x2 = edge.toNode.x - 8;
  const layerDistance = Math.abs(edge.toNode.layer - edge.fromNode.layer);
  const gapWidth = Math.max(34, Math.abs(x2 - x1));
  if (layerDistance <= 1) {
    return {
      x: (x1 + x2) / 2,
      y: edge.laneY,
      maxWidth: Math.max(72, Math.min(108, gapWidth - 34)),
    };
  }
  return {
    x: (x1 + x2) / 2,
    y: edge.laneY,
    maxWidth: Math.max(84, Math.min(120, gapWidth * 0.3)),
  };
}

export function ChangeWalkthroughPanel({ walkthroughs, repoRoot, onNavigate }: ChangeWalkthroughPanelProps) {
  const instanceId = useId();
  const walkthrough = pickWalkthrough(walkthroughs, repoRoot);
  const nodeRefs = useRef(new Map<string, HTMLElement>());
  const labelRefs = useRef(new Map<string, HTMLElement>());
  const [measuredHeights, setMeasuredHeights] = useState<Record<string, number>>({});
  const [measuredLabelHeights, setMeasuredLabelHeights] = useState<Record<string, number>>({});
  const [hoveredEdgeKey, setHoveredEdgeKey] = useState<string | null>(null);
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null);
  const dag = useMemo(
    () => walkthrough ? buildDagLayout(walkthrough.nodes, walkthrough.edges, measuredHeights, measuredLabelHeights) : null,
    [measuredHeights, measuredLabelHeights, walkthrough],
  );

  useLayoutEffect(() => {
    if (!walkthrough) return;
    const nextNodeHeights: Record<string, number> = {};
    for (const node of walkthrough.nodes) {
      const element = nodeRefs.current.get(node.id);
      if (element) nextNodeHeights[node.id] = element.offsetHeight;
    }
    setMeasuredHeights((current) => {
      const currentKeys = Object.keys(current);
      const nextKeys = Object.keys(nextNodeHeights);
      if (currentKeys.length === nextKeys.length && nextKeys.every((key) => current[key] === nextNodeHeights[key])) return current;
      return nextNodeHeights;
    });

    const nextLabelHeights: Record<string, number> = {};
    for (const [key, element] of labelRefs.current) {
      nextLabelHeights[key] = element.offsetHeight;
    }
    setMeasuredLabelHeights((current) => {
      const currentKeys = Object.keys(current);
      const nextKeys = Object.keys(nextLabelHeights);
      if (currentKeys.length === nextKeys.length && nextKeys.every((key) => current[key] === nextLabelHeights[key])) return current;
      return nextLabelHeights;
    });
  }, [walkthrough]);

  if (!walkthrough || !dag) return null;
  const markerIdPrefix = `walkthrough-arrow-${instanceId.replace(/[^a-zA-Z0-9_-]/g, '') || 'default'}`;
  const candidateEdgeKey = hoveredEdgeKey ?? selectedEdgeKey;
  const focusedEdgeKey = dag.edges.some((edge) => edge.key === candidateEdgeKey) ? candidateEdgeKey : null;
  const focusedEdge = dag.edges.find((edge) => edge.key === focusedEdgeKey);
  const focusedNodeIds = focusedEdge ? new Set([focusedEdge.from, focusedEdge.to]) : null;
  const fallbackAnchorByNodeId = new Map(
    walkthrough.sections
      .filter((section) => section.nodeId && section.anchor)
      .map((section) => [section.nodeId as string, section.anchor]),
  );

  return (
    <section className="mb-2 px-0 py-0">
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/12 text-primary">
          <Sparkles size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="whitespace-normal break-words text-[12px] font-semibold leading-snug text-foreground">{walkthrough.title}</div>
          {walkthrough.summary && (
            <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{walkthrough.summary}</div>
          )}
        </div>
      </div>

      {walkthrough.highlights.length > 0 && (
        <div className="mt-2 grid gap-1.5">
          {walkthrough.highlights.slice(0, 4).map((highlight, index) => (
            <div key={`${highlight.what}-${index}`} className="rounded-md bg-surface-2 px-2 py-1.5">
              <div className="flex min-w-0 items-center gap-1.5">
                {highlight.tag && <span className="shrink-0 rounded bg-surface-elevated px-1.5 py-0.5 text-[9px] font-semibold text-primary">{highlight.tag}</span>}
                <span className="min-w-0 flex-1 whitespace-normal break-words text-[11px] font-semibold leading-snug text-foreground">{highlight.what}</span>
              </div>
              <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{highlight.effect}</div>
            </div>
          ))}
        </div>
      )}

      {walkthrough.nodes.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
            <div className="flex items-center gap-1.5 font-semibold uppercase tracking-[0.12em]">
              <GitBranch size={11} />
              DAG
            </div>
            {walkthrough.edges.some((edge) => edge.label?.trim()) && (
              <span className="normal-case tracking-normal">点击标注聚焦路径</span>
            )}
          </div>
          <div
            className="swiper-no-swiping overflow-x-auto rounded-md border border-border/15 bg-surface-2 p-1.5"
            data-sidebar-gesture-ignore
            onPointerDown={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
          >
            <div className="relative" style={{ width: dag.width, height: dag.height }}>
              <svg className="absolute inset-0" width={dag.width} height={dag.height} aria-hidden="true">
                <defs>
                  {DAG_EDGE_COLORS.map((color, index) => (
                    <marker
                      key={color}
                      id={`${markerIdPrefix}-${index}`}
                      viewBox="0 0 10 10"
                      refX="8.5"
                      refY="5"
                      markerWidth="5"
                      markerHeight="5"
                      orient="auto"
                      markerUnits="strokeWidth"
                    >
                      <path d="M0,0 L10,5 L0,10 Z" fill={color} />
                    </marker>
                  ))}
                </defs>
                {dag.edges.map((edge) => {
                  const path = getDagEdgePath(edge);
                  const color = getDagEdgeColor(edge.index);
                  const isFocused = focusedEdgeKey === edge.key;
                  const isDimmed = Boolean(focusedEdgeKey && !isFocused);
                  return (
                    <g
                      key={edge.key}
                      className="transition-opacity duration-150"
                      style={{ opacity: isDimmed ? 0.14 : 1 }}
                    >
                      <path className="pointer-events-none" d={path} fill="none" stroke="var(--surface-2)" strokeWidth={isFocused ? 7 : 5} strokeLinecap="round" />
                      <path
                        className="pointer-events-none transition-[stroke-width,opacity] duration-150"
                        d={path}
                        fill="none"
                        stroke={color}
                        strokeWidth={isFocused ? 3 : 1.8}
                        strokeLinecap="round"
                        markerEnd={`url(#${markerIdPrefix}-${edge.index % DAG_EDGE_COLORS.length})`}
                      />
                      <path
                        data-dag-edge={edge.key}
                        d={path}
                        fill="none"
                        stroke="transparent"
                        strokeWidth="14"
                        className="cursor-pointer"
                        onPointerEnter={() => setHoveredEdgeKey(edge.key)}
                        onPointerLeave={() => setHoveredEdgeKey((current) => current === edge.key ? null : current)}
                        onClick={() => setSelectedEdgeKey((current) => current === edge.key ? null : edge.key)}
                      />
                      <circle className="pointer-events-none" cx={edge.fromNode.x + DAG_NODE_WIDTH + 8} cy={edge.fromY} r={isFocused ? 4 : 3} fill={color} stroke="var(--surface-2)" strokeWidth="2" />
                      <circle className="pointer-events-none" cx={edge.toNode.x - 8} cy={edge.toY} r={isFocused ? 4 : 3} fill={color} stroke="var(--surface-2)" strokeWidth="2" />
                    </g>
                  );
                })}
              </svg>
              {dag.edges.map((edge) => {
                const label = edge.label?.trim();
                if (!label) return null;
                const { x: labelX, y: labelY, maxWidth } = getDagEdgeLabelPosition(edge);
                const color = getDagEdgeColor(edge.index);
                const isFocused = focusedEdgeKey === edge.key;
                const isDimmed = Boolean(focusedEdgeKey && !isFocused);
                return (
                  <button
                    ref={(element) => {
                      if (element) labelRefs.current.set(edge.key, element);
                      else labelRefs.current.delete(edge.key);
                    }}
                    key={`${edge.key}-label`}
                    type="button"
                    data-dag-edge-label={edge.key}
                    className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-normal break-words rounded-md border bg-surface-elevated px-1.5 py-1 text-center text-[9px] leading-[11px] shadow-sm transition-[opacity,box-shadow,transform] duration-150 [overflow-wrap:anywhere] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                    style={{
                      left: labelX,
                      top: labelY,
                      maxWidth,
                      width: 'max-content',
                      borderColor: color,
                      color,
                      opacity: isDimmed ? 0.24 : 1,
                      boxShadow: isFocused ? `0 0 0 2px ${color}, 0 6px 18px rgb(0 0 0 / 0.24)` : undefined,
                    }}
                    title={`${edge.fromNode.index + 1} ${edge.fromNode.node.title} → ${edge.toNode.index + 1} ${edge.toNode.node.title}${edge.desc ? `\n${edge.desc}` : ''}`}
                    aria-pressed={selectedEdgeKey === edge.key}
                    onPointerEnter={() => setHoveredEdgeKey(edge.key)}
                    onPointerLeave={() => setHoveredEdgeKey((current) => current === edge.key ? null : current)}
                    onClick={() => setSelectedEdgeKey((current) => current === edge.key ? null : edge.key)}
                  >
                    <span className="block font-bold tabular-nums">{edge.fromNode.index + 1} → {edge.toNode.index + 1}</span>
                    <span className="block text-muted-foreground">{label}</span>
                  </button>
                );
              })}
              {dag.nodes.map(({ node, index, x, y, height }) => (
                <AnchorButton
                  key={node.id}
                  elementRef={(element) => {
                    if (element) nodeRefs.current.set(node.id, element);
                    else nodeRefs.current.delete(node.id);
                  }}
                  anchor={node.anchor ?? fallbackAnchorByNodeId.get(node.id)}
                  onNavigate={onNavigate}
                  className={`absolute overflow-hidden rounded-lg border bg-surface/95 px-2.5 py-2 text-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)] transition-[opacity,border-color,box-shadow] duration-150 ${
                    focusedNodeIds?.has(node.id)
                      ? 'border-primary/60 shadow-[0_0_0_1px_rgb(var(--primary-rgb)/0.28),0_10px_24px_rgba(0,0,0,0.22)]'
                      : focusedNodeIds
                        ? 'border-border/15 opacity-40'
                        : 'border-border/25'
                  }`}
                  style={{ left: x, top: y, width: DAG_NODE_WIDTH, minHeight: height } as CSSProperties}
                >
                  <span className={`absolute bottom-2 left-0 top-2 w-[3px] rounded-r-full ${getKindRailClass(node.kind)}`} />
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[9px] font-bold text-primary">{index + 1}</span>
                    <span className="min-w-0 flex-1 whitespace-normal break-words text-[11px] font-semibold leading-snug text-foreground">{node.title}</span>
                    {node.anchor && <Link2 size={11} className="shrink-0 opacity-70" />}
                  </div>
                  {node.kind && <div className="mt-0.5 truncate text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80">{node.kind}</div>}
                  <div className="mt-0.5 whitespace-normal break-words text-[10px] leading-snug text-muted-foreground">{node.business}</div>
                </AnchorButton>
              ))}
            </div>
          </div>
        </div>
      )}

      {(walkthrough.risks.length > 0 || walkthrough.checks.length > 0) && (
        <div className="mt-2 grid gap-1.5">
          {walkthrough.risks.slice(0, 3).map((risk, index) => (
            <AnchorButton
              key={`${risk.title}-${index}`}
              anchor={risk.anchor}
              onNavigate={onNavigate}
              className="flex w-full items-start gap-1.5 rounded-md border border-[rgb(var(--warning-rgb)_/_0.25)] bg-[rgb(var(--warning-rgb)_/_0.10)] px-2 py-1.5 text-[10px] text-muted-foreground"
            >
              <AlertTriangle size={12} className="mt-0.5 shrink-0 text-[color:var(--warning)]" />
              <span className="min-w-0 whitespace-normal break-words leading-snug">{risk.title}</span>
            </AnchorButton>
          ))}
          {walkthrough.checks.slice(0, 3).map((check, index) => (
            <div key={`${check}-${index}`} className="flex items-start gap-1.5 rounded-md bg-surface-2 px-2 py-1.5 text-[10px] text-muted-foreground">
              <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-primary" />
              <span className="min-w-0 whitespace-normal break-words leading-snug">{check}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
