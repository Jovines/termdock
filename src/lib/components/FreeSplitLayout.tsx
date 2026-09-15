import { GripVertical } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { getSettings } from '../terminal/api';
import { collaborationPanelClientId, saveCollaborationPanel } from '../collaboration/panelPreferences';
import { useCollaborationPanelDock } from '../stores/useCollaborationPanelDock';
import { fourPaneBoundaries, layoutRects, leafIds, movePane, normalizeSplitNode, presetLayout, pruneLayout, resizeFourBoundary, resizeNode, splitLeaf, type PaneRect, type PaneSide, type SplitNode } from '../terminal/freeSplitLayout';

const COLLABORATION = '@collaboration';
const rectStyle = (r: PaneRect): CSSProperties => ({ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.width * 100}%`, height: `${r.height * 100}%` });
function CollaborationHost() {
  const setHost = useCollaborationPanelDock(state => state.setHost);
  return <div ref={setHost} className="h-full min-h-0 min-w-0 bg-surface" />;
}

export function FreeSplitLayout({ layoutId, panes, preset = 'grid', initialTree, focusId, mobile = false }: {
  initialTree?: SplitNode; layoutId: string; panes: { id: string; content: ReactNode }[]; preset?: 'horizontal' | 'vertical' | 'grid'; focusId?: string | null; mobile?: boolean;
}) {
  const dock = useCollaborationPanelDock(state => state.dock);
  const idsKey = JSON.stringify(panes.map(p => p.id));
  const hasDock = !!dock && panes.some(p => p.id === dock.sessionId);
  const container = useRef<HTMLDivElement>(null);
  const [tree, setTree] = useState<SplitNode>(() => initialTree ?? presetLayout(panes.map(p => p.id), mobile ? 'vertical' : preset));
  const treeRef = useRef(tree); treeRef.current = tree;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<{ id: string; dx: number; dy: number; originX: number; originY: number; scale: number } | null>(null);
  const [drop, setDrop] = useState<{ id: string; side: PaneSide | 'center' } | null>(null);
  const previousPreset = useRef(preset);
  const previousIds = useRef(panes.map(p => p.id));
  const lastDock = useRef('');
  const dirty = useRef(false);
  const persist = () => {
    if (!dirty.current) return;
    dirty.current = false;
    void saveCollaborationPanel({ layouts: { [layoutId]: treeRef.current } }).catch(() => { dirty.current = true; setError('布局保存失败，调整后重试'); });
  };
  useEffect(() => {
    let cancelled = false;
    void getSettings().then(settings => {
      if (cancelled) return;
      const panel = settings.collaborationPanels?.[collaborationPanelClientId()];
      // Restore the dock before pruning saved leaves; the sidebar opens its composer asynchronously.
      if (panel?.floatingGroupId && panel.mode === 'docked' && panel.dock && panes.some(p => p.id === panel.dock!.sessionId) && !useCollaborationPanelDock.getState().dock) {
        useCollaborationPanelDock.getState().setDock(panel.dock);
      }
      const saved = normalizeSplitNode(panel?.layouts?.[layoutId]);
      if (saved) setTree(saved);
      setReady(true);
    }).catch(() => { if (!cancelled) setError('布局加载失败，请刷新重试'); });
    return () => { cancelled = true; };
  }, [layoutId]);
  const change = (next: SplitNode) => { dirty.current = true; treeRef.current = next; setTree(next); };
  useLayoutEffect(() => {
    if (!ready) return;
    const ids = JSON.parse(idsKey) as string[];
    const reset = previousPreset.current !== preset;
    previousPreset.current = preset;
    const dockKey = hasDock ? `${dock!.sessionId}:${dock!.side}` : '';
    let next = reset ? presetLayout(ids, preset) : treeRef.current;
    const oldIds = previousIds.current;
    if (!reset && oldIds.length === ids.length && oldIds.every(id => ids.includes(id)) && oldIds.some((id, i) => id !== ids[i])) {
      const mapping = new Map(oldIds.map((id, i) => [id, ids[i]]));
      const remap = (node: SplitNode): SplitNode => 'id' in node ? { id: mapping.get(node.id) ?? node.id } : { ...node, first: remap(node.first), second: remap(node.second) };
      next = remap(next);
    }
    previousIds.current = ids;
    const allowed = new Set([...ids, ...(hasDock ? [COLLABORATION] : [])]);
    next = pruneLayout(next, allowed) ?? presetLayout(ids, preset);
    for (const id of ids) if (!leafIds(next).includes(id)) next = { axis: 'x', ratio: 0.5, first: next, second: { id } };
    if (hasDock && (!leafIds(next).includes(COLLABORATION) || (lastDock.current && lastDock.current !== dockKey))) {
      next = pruneLayout(next, new Set(ids))!;
      next = splitLeaf(next, dock!.sessionId, COLLABORATION, dock!.side);
    }
    lastDock.current = dockKey;
    if (JSON.stringify(next) !== JSON.stringify(treeRef.current)) { change(next); persist(); }
  }, [ready, idsKey, preset, hasDock, dock?.sessionId, dock?.side]);
  useEffect(() => {
    const flush = () => persist();
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); document.dispatchEvent(new CustomEvent('termdock:gesture-lock', { detail: { locked: false } })); flush(); };
  }, [layoutId]);

  const geometry = layoutRects(tree);
  const four = fourPaneBoundaries(tree);
  const allPanes = [...panes, ...(hasDock ? [{ id: COLLABORATION, content: <CollaborationHost /> }] : [])];
  const drag = useRef<{ id: string; x: number; y: number; moved: boolean; originX: number; originY: number; scale: number } | null>(null);
  const dropRef = useRef(drop); dropRef.current = drop;
  const activeResize = useRef<{ path?: string; side?: PaneSide; rect: PaneRect; axis: 'x' | 'y' } | null>(null);
  // Portal children are DOM descendants but not React descendants of this layout.
  // Capture starts on the DOM container so terminal and collaboration titles share the path.
  useEffect(() => {
    const host = container.current;
    if (!host || !ready) return;
    const start = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      const handle = event.target.closest('[data-split-pane-title], [data-panel-drag-title]');
      const control = event.target.closest('button, a, input, textarea, select');
      if (!handle || (control && control !== handle)) return;
      const pane = handle.closest<HTMLElement>('[data-layout-pane]');
      if (!pane || !host.contains(pane)) return;
      document.dispatchEvent(new CustomEvent('termdock:gesture-lock', { detail: { locked: true } }));
      const box = pane.getBoundingClientRect();
      drag.current = { id: pane.dataset.layoutPane!, x: event.clientX, y: event.clientY, moved: false,
        originX: event.clientX - box.left, originY: event.clientY - box.top,
        scale: Math.min(0.8, 480 / Math.max(1, box.width), 320 / Math.max(1, box.height)) };
      host.setPointerCapture?.(event.pointerId);
    };
    host.addEventListener('pointerdown', start, true);
    return () => host.removeEventListener('pointerdown', start, true);
  }, [ready]);
  const resize = (clientX: number, clientY: number) => {
    const box = container.current?.getBoundingClientRect(), active = activeResize.current;
    if (!box || !active) return;
    const length = active.axis === 'x' ? box.width * active.rect.width : box.height * active.rect.height;
    const start = active.axis === 'x' ? box.left + box.width * active.rect.x : box.top + box.height * active.rect.y;
    const minimum = Math.min(0.45, (mobile ? 48 : 120) / Math.max(1, length));
    const ratio = Math.max(minimum, Math.min(1 - minimum, ((active.axis === 'x' ? clientX : clientY) - start) / Math.max(1, length)));
    change(active.side ? resizeFourBoundary(treeRef.current, active.side, ratio) : resizeNode(treeRef.current, active.path!, ratio));
  };
  const handles = four ? [
    { key: 'top', side: 'top' as const, axis: 'x' as const, x: four.top, y: 0, length: (four.left + four.right) / 2 },
    { key: 'bottom', side: 'bottom' as const, axis: 'x' as const, x: four.bottom, y: (four.left + four.right) / 2, length: 1 - (four.left + four.right) / 2 },
    { key: 'left', side: 'left' as const, axis: 'y' as const, x: 0, y: four.left, length: (four.top + four.bottom) / 2 },
    { key: 'right', side: 'right' as const, axis: 'y' as const, x: (four.top + four.bottom) / 2, y: four.right, length: 1 - (four.top + four.bottom) / 2 },
  ].map(h => ({ ...h, rect: { x: 0, y: 0, width: 1, height: 1 }, path: undefined as string | undefined })) : geometry.dividers.map(d => ({ key: d.path, path: d.path, side: undefined as PaneSide | undefined, axis: d.node.axis, rect: d.rect,
    x: d.rect.x + (d.node.axis === 'x' ? d.rect.width * d.node.ratio : 0), y: d.rect.y + (d.node.axis === 'y' ? d.rect.height * d.node.ratio : 0), length: d.node.axis === 'x' ? d.rect.height : d.rect.width }));
  return <div ref={container} data-split-container="true" className="relative h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-border [&_[data-split-pane-title]]:touch-none [&_[data-panel-drag-title]]:touch-none"
    onPointerMove={event => {
      if (activeResize.current) { event.preventDefault(); resize(event.clientX, event.clientY); return; }
      const current = drag.current, box = container.current?.getBoundingClientRect();
      if (!current || !box) return;
      if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6) return;
      current.moved = true;
      setDragPreview({ id: current.id, dx: event.clientX - current.x, dy: event.clientY - current.y, originX: current.originX, originY: current.originY, scale: current.scale });
      const x = (event.clientX - box.left) / box.width, y = (event.clientY - box.top) / box.height;
      const target = geometry.panes.find(p => x >= p.rect.x && x <= p.rect.x + p.rect.width && y >= p.rect.y && y <= p.rect.y + p.rect.height);
      if (!target || target.id === current.id) { dropRef.current = null; setDrop(null); return; }
      const rx = (x - target.rect.x) / target.rect.width, ry = (y - target.rect.y) / target.rect.height;
      const side = Math.min(rx, 1-rx, ry, 1-ry) > 0.25 ? 'center' : rx < 1-rx && rx <= ry && rx <= 1-ry ? 'left' : 1-rx <= ry && 1-rx <= 1-ry ? 'right' : ry < 1-ry ? 'top' : 'bottom';
      const next = { id: target.id, side } as const; dropRef.current = next; setDrop(next);
    }}
    onPointerUp={event => {
      if (activeResize.current) { activeResize.current = null; persist(); }
      if (drag.current?.moved && dropRef.current) { change(movePane(treeRef.current, drag.current.id, dropRef.current.id, dropRef.current.side)); persist(); }
      drag.current = null; dropRef.current = null; setDrop(null); setDragPreview(null);
      document.dispatchEvent(new CustomEvent('termdock:gesture-lock', { detail: { locked: false } }));
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onLostPointerCapture={() => { document.dispatchEvent(new CustomEvent('termdock:gesture-lock', { detail: { locked: false } })); activeResize.current = null; drag.current = null; dropRef.current = null; setDrop(null); setDragPreview(null); persist(); }}
    onKeyDownCapture={event => { if (event.key === 'Escape') { drag.current = null; dropRef.current = null; setDrop(null); setDragPreview(null); document.dispatchEvent(new CustomEvent('termdock:gesture-lock', { detail: { locked: false } })); } }}
    onPointerCancel={() => { document.dispatchEvent(new CustomEvent('termdock:gesture-lock', { detail: { locked: false } })); activeResize.current = null; drag.current = null; dropRef.current = null; setDrop(null); setDragPreview(null); persist(); }}>
    {dragPreview && <div aria-hidden="true" data-drag-placeholder="true" className="pointer-events-none absolute border-2 border-dashed border-primary/30 bg-primary/5" style={rectStyle(geometry.panes.find(p => p.id === dragPreview.id)?.rect ?? { x: 0, y: 0, width: 0, height: 0 })} />}
    {allPanes.map(pane => {
      const rect = geometry.panes.find(p => p.id === pane.id)?.rect;
      const hidden = !rect || (!!focusId && pane.id !== focusId);
      return <div key={pane.id} data-layout-pane={pane.id} className={`absolute min-h-0 min-w-0 overflow-hidden bg-[var(--chrome-bg)] ${dragPreview?.id === pane.id ? 'pointer-events-none z-30 rounded-lg ring-1 ring-primary/60 opacity-90 shadow-xl' : ''}`} style={{ ...rectStyle(focusId === pane.id ? { x: 0, y: 0, width: 1, height: 1 } : rect ?? { x: 0, y: 0, width: 0, height: 0 }), padding: allPanes.length > 1 ? '0.5px' : 0, transition: 'none', visibility: hidden ? 'hidden' : undefined, ...(dragPreview?.id === pane.id ? { transform: `translate(${dragPreview.dx}px, ${dragPreview.dy}px) scale(${dragPreview.scale})`, transformOrigin: `${dragPreview.originX}px ${dragPreview.originY}px` } : {}) }}
        onDragStart={event => { if ((event.target as Element).closest('[data-split-pane-title], [data-panel-drag-title]')) event.preventDefault(); }}>{pane.content}
        {mobile && allPanes.length > 1 && pane.id !== COLLABORATION && <button type="button" data-panel-drag-title="true" aria-label="拖动面板到其他区域" className="swiper-no-swiping absolute right-1 top-1 z-20 rounded bg-surface p-1 text-muted-foreground"><GripVertical size={14} /></button>}
        {drop?.id === pane.id && <div className="pointer-events-none absolute z-30 border-2 border-primary bg-primary/20" style={{ top: drop.side === 'bottom' ? '50%' : 0, bottom: drop.side === 'top' ? '50%' : 0, left: drop.side === 'right' ? '50%' : 0, right: drop.side === 'left' ? '50%' : 0 }}></div>}
      </div>;
    })}
    {!focusId && handles.map(h => <button key={h.key} type="button" role="separator" aria-label={h.side ? `调整${({ top: '上', bottom: '下', left: '左', right: '右' })[h.side]}半段分隔线` : '调整分屏大小'} aria-orientation={h.axis === 'x' ? 'vertical' : 'horizontal'} disabled={!ready}
      className={`swiper-no-swiping absolute z-10 touch-none bg-border hover:bg-primary focus-visible:bg-primary ${h.axis === 'x' ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize'}`}
      style={{ left: `${h.x * 100}%`, top: `${h.y * 100}%`, ...(h.axis === 'x' ? { height: `${h.length * 100}%` } : { width: `${h.length * 100}%` }) }}
      onPointerDown={event => { event.preventDefault(); event.stopPropagation(); document.dispatchEvent(new CustomEvent('termdock:gesture-lock', { detail: { locked: true } })); activeResize.current = h; container.current?.setPointerCapture?.(event.pointerId); }}
      onDoubleClick={() => { change(h.side ? resizeFourBoundary(treeRef.current, h.side, 0.5) : resizeNode(treeRef.current, h.path!, 0.5)); persist(); }}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const current = h.side ? four![h.side] : geometry.dividers.find(d => d.path === h.path)!.node.ratio;
        const ratio = Math.max(0.05, Math.min(0.95, current + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 0.03 : -0.03)));
        change(h.side ? resizeFourBoundary(treeRef.current, h.side, ratio) : resizeNode(treeRef.current, h.path!, ratio)); persist();
      }}><span aria-hidden="true" className={`absolute ${h.axis === 'x' ? 'inset-y-0 -inset-x-1' : 'inset-x-0 -inset-y-1'}`} /></button>)}
    {error && <div role="alert" className="absolute bottom-1 left-1 z-20 rounded bg-surface px-2 py-1 text-[10px] text-destructive">{error}</div>}
  </div>;
}
