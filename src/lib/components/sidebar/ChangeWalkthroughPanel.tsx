import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
  fromNode: DagLayoutNode;
  toNode: DagLayoutNode;
  routeIndex: number;
}

const DAG_NODE_WIDTH = 190;
const DAG_NODE_HEIGHT = 92;
const DAG_COLUMN_GAP = 82;
const DAG_ROW_GAP = 28;
const DAG_PADDING = 16;
const DAG_ROUTE_GAP = 12;
const DAG_ROUTING_GUTTER = 54;

function buildDagLayout(nodes: ChangeWalkthroughNode[], edges: ChangeWalkthroughEdge[], measuredHeights: Record<string, number> = {}) {
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
      const height = Math.max(DAG_NODE_HEIGHT, Math.ceil(measuredHeights[node.id] ?? DAG_NODE_HEIGHT));
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
  const layoutEdges: DagLayoutEdge[] = validEdges.flatMap((edge) => {
    const fromNode = layoutById.get(edge.from);
    const toNode = layoutById.get(edge.to);
    return fromNode && toNode ? [{ ...edge, fromNode, toNode, routeIndex: 0 }] : [];
  }).map((edge, index) => ({ ...edge, routeIndex: index }));
  const maxLayer = Math.max(0, ...layoutNodes.map((node) => node.layer));
  const contentBottom = Math.max(DAG_PADDING + DAG_ROUTING_GUTTER + DAG_NODE_HEIGHT, ...layoutNodes.map((node) => node.y + node.height));
  return {
    nodes: layoutNodes,
    edges: layoutEdges,
    width: DAG_PADDING * 2 + (maxLayer + 1) * DAG_NODE_WIDTH + maxLayer * DAG_COLUMN_GAP,
    height: contentBottom + DAG_PADDING + DAG_ROUTING_GUTTER,
  };
}

function getDagEdgePath(edge: DagLayoutEdge): string {
  const x1 = edge.fromNode.x + DAG_NODE_WIDTH + 8;
  const y1 = edge.fromNode.y + edge.fromNode.height / 2;
  const x2 = edge.toNode.x - 8;
  const y2 = edge.toNode.y + edge.toNode.height / 2;
  const layerDistance = Math.abs(edge.toNode.layer - edge.fromNode.layer);
  if (layerDistance <= 1) {
    const curve = Math.max(36, (x2 - x1) * 0.52);
    return `M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`;
  }

  const channelBias = edge.routeIndex % 2 === 0 ? -1 : 1;
  const channelOffset = (Math.floor(edge.routeIndex / 2) + 1) * DAG_ROUTE_GAP;
  const topLane = Math.min(edge.fromNode.y, edge.toNode.y) - 20 - channelOffset;
  const bottomLane = Math.max(edge.fromNode.y + edge.fromNode.height, edge.toNode.y + edge.toNode.height) + 20 + channelOffset;
  const laneY = channelBias < 0 ? Math.max(DAG_PADDING, topLane) : bottomLane;
  const r = 12;
  return [
    `M ${x1} ${y1}`,
    `L ${x1 + r} ${y1}`,
    `Q ${x1 + r * 2} ${y1} ${x1 + r * 2} ${y1 + Math.sign(laneY - y1) * r}`,
    `L ${x1 + r * 2} ${laneY - Math.sign(laneY - y1) * r}`,
    `Q ${x1 + r * 2} ${laneY} ${x1 + r * 3} ${laneY}`,
    `L ${x2 - r * 3} ${laneY}`,
    `Q ${x2 - r * 2} ${laneY} ${x2 - r * 2} ${y2 - Math.sign(y2 - laneY) * r}`,
    `L ${x2 - r * 2} ${y2 - Math.sign(y2 - laneY) * r}`,
    `Q ${x2 - r * 2} ${y2} ${x2 - r} ${y2}`,
    `L ${x2} ${y2}`,
  ].join(' ');
}

function getDagEdgeLabelPosition(edge: DagLayoutEdge): { x: number; y: number } {
  const x1 = edge.fromNode.x + DAG_NODE_WIDTH + 8;
  const y1 = edge.fromNode.y + edge.fromNode.height / 2;
  const x2 = edge.toNode.x - 8;
  const y2 = edge.toNode.y + edge.toNode.height / 2;
  const layerDistance = Math.abs(edge.toNode.layer - edge.fromNode.layer);
  if (layerDistance <= 1) return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 9 };
  const channelBias = edge.routeIndex % 2 === 0 ? -1 : 1;
  const channelOffset = (Math.floor(edge.routeIndex / 2) + 1) * DAG_ROUTE_GAP;
  const topLane = Math.min(edge.fromNode.y, edge.toNode.y) - 20 - channelOffset;
  const bottomLane = Math.max(edge.fromNode.y + edge.fromNode.height, edge.toNode.y + edge.toNode.height) + 20 + channelOffset;
  return { x: (x1 + x2) / 2, y: channelBias < 0 ? Math.max(DAG_PADDING, topLane) - 5 : bottomLane - 5 };
}

export function ChangeWalkthroughPanel({ walkthroughs, repoRoot, onNavigate }: ChangeWalkthroughPanelProps) {
  const walkthrough = pickWalkthrough(walkthroughs, repoRoot);
  const nodeRefs = useRef(new Map<string, HTMLElement>());
  const [measuredHeights, setMeasuredHeights] = useState<Record<string, number>>({});
  const dag = useMemo(() => walkthrough ? buildDagLayout(walkthrough.nodes, walkthrough.edges, measuredHeights) : null, [measuredHeights, walkthrough]);

  useLayoutEffect(() => {
    if (!walkthrough) return;
    const next: Record<string, number> = {};
    for (const node of walkthrough.nodes) {
      const element = nodeRefs.current.get(node.id);
      if (element) next[node.id] = element.offsetHeight;
    }
    setMeasuredHeights((current) => {
      const currentKeys = Object.keys(current);
      const nextKeys = Object.keys(next);
      if (currentKeys.length === nextKeys.length && nextKeys.every((key) => current[key] === next[key])) return current;
      return next;
    });
  }, [walkthrough]);

  if (!walkthrough || !dag) return null;
  const markerId = `walkthrough-arrow-${walkthrough.id.replace(/[^a-zA-Z0-9_-]/g, '') || 'default'}`;
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
          <div className="truncate text-[12px] font-semibold text-foreground">{walkthrough.title}</div>
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
                <span className="min-w-0 truncate text-[11px] font-semibold text-foreground">{highlight.what}</span>
              </div>
              <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{highlight.effect}</div>
            </div>
          ))}
        </div>
      )}

      {walkthrough.nodes.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            <GitBranch size={11} />
            DAG
          </div>
          <div
            className="swiper-no-swiping overflow-x-auto rounded-md border border-border/15 bg-surface-2 p-1.5"
            data-sidebar-gesture-ignore
            onPointerDown={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
          >
            <div className="relative" style={{ width: dag.width, height: dag.height }}>
              <svg className="pointer-events-none absolute inset-0" width={dag.width} height={dag.height} aria-hidden="true">
                <defs>
                  <marker id={markerId} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="5" markerHeight="5" orient="auto" markerUnits="strokeWidth">
                    <path d="M0,0 L10,5 L0,10 Z" fill="rgba(var(--primary-rgb),0.78)" />
                  </marker>
                </defs>
                {dag.edges.map((edge, index) => {
                  const label = edge.label?.slice(0, 18);
                  const path = getDagEdgePath(edge);
                  const { x: labelX, y: labelY } = getDagEdgeLabelPosition(edge);
                  const labelWidth = label ? Math.max(34, Math.min(92, label.length * 9 + 12)) : 0;
                  return (
                    <g key={`${edge.from}-${edge.to}-${index}`}>
                      <path d={path} fill="none" stroke="rgba(255,252,240,0.16)" strokeWidth="4" strokeLinecap="round" />
                      <path d={path} fill="none" stroke="rgba(var(--primary-rgb),0.52)" strokeWidth="1.6" strokeLinecap="round" markerEnd={`url(#${markerId})`} />
                      {label && (
                        <>
                          <rect
                            x={labelX - labelWidth / 2}
                            y={labelY - 10}
                            width={labelWidth}
                            height="16"
                            rx="5"
                            fill="var(--surface-2)"
                            stroke="var(--border)"
                            strokeWidth="1"
                          />
                          <text x={labelX} y={labelY + 2} textAnchor="middle" className="fill-muted-foreground text-[9px]">
                            {label}
                        </text>
                        </>
                      )}
                    </g>
                  );
                })}
              </svg>
              {dag.nodes.map(({ node, index, x, y }) => (
                <AnchorButton
                  key={node.id}
                  elementRef={(element) => {
                    if (element) nodeRefs.current.set(node.id, element);
                    else nodeRefs.current.delete(node.id);
                  }}
                  anchor={node.anchor ?? fallbackAnchorByNodeId.get(node.id)}
                  onNavigate={onNavigate}
                  className="absolute overflow-hidden rounded-lg border border-border/25 bg-surface/95 px-2.5 py-2 text-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)]"
                  style={{ left: x, top: y, width: DAG_NODE_WIDTH, minHeight: DAG_NODE_HEIGHT } as CSSProperties}
                >
                  <span className={`absolute bottom-2 left-0 top-2 w-[3px] rounded-r-full ${getKindRailClass(node.kind)}`} />
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[9px] font-bold text-primary">{index + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-foreground">{node.title}</span>
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
              <span className="line-clamp-2">{risk.title}</span>
            </AnchorButton>
          ))}
          {walkthrough.checks.slice(0, 3).map((check, index) => (
            <div key={`${check}-${index}`} className="flex items-start gap-1.5 rounded-md bg-surface-2 px-2 py-1.5 text-[10px] text-muted-foreground">
              <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-primary" />
              <span className="line-clamp-2">{check}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
