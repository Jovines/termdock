import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import DOMPurify from 'dompurify';
import { Minus, Plus, Download, Expand, Scan, X } from 'lucide-react';
import { architectureDiagram, architectureScope, type ArchitecturePerspective } from '../../architecture/model';
import { initializeMermaid, loadMermaid } from '../../utils/mermaid';
import { saveDownloadBlob } from '../../terminal/api';
import { useI18n } from '../../i18n';
import { useKeyboardLayer } from '../../hooks/useKeyboardLayer';
import './architecture.css';

export function ArchitectureDiagram({ view, parentId, selectedId, onSelect, active = true, referenceWidth, inspector, inspectorStage = 'details', onDismissInspector, onExpandedChange, navigation, heading }: {
  view: ArchitecturePerspective;
  parentId?: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  active?: boolean;
  referenceWidth?: number;
  inspector?: ReactNode;
  inspectorStage?: 'preview' | 'details' | 'source' | 'analysis';
  onDismissInspector?: () => void;
  onExpandedChange?: (expanded: boolean) => void;
  navigation?: ReactNode;
  heading?: ReactNode;
}) {
  const { t } = useI18n();
  const key = useId().replace(/[^a-zA-Z0-9]/g, '');
  const root = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const fullscreenTrigger = useRef<HTMLButtonElement>(null);
  const [svg, setSvg] = useState('');
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const zoomValue = useRef(1);
  const [expanded, setExpanded] = useState(false);
  const restoreFocus = useRef(true);
  const inspectorNavigation = useRef({ inspector, onDismissInspector }); inspectorNavigation.current = { inspector, onDismissInspector };
  const expandedChange = useRef(onExpandedChange); expandedChange.current = onExpandedChange;
  const canvasPosition = useRef({ left: 0, top: 0 });
  const [downloadError, setDownloadError] = useState(false);
  const [viewportSize, setViewportSize] = useState({ width: 320, height: 320, clipHeight: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number; nodeId?: string }>());
  const dragged = useRef(false);
  const dragDistance = useRef(0);
  const diagram = useMemo(() => architectureDiagram(view, parentId), [view, parentId]);
  const connections = useMemo(() => architectureScope(view, parentId).edges, [view, parentId]);
  const geometry = useMemo(() => {
    const box = svg.match(/viewBox="([^"]+)"/)?.[1].split(/\s+/).map(Number);
    const width = box?.[2] || 320, height = box?.[3] || 240;
    // Reading is the default. Large graphs scroll instead of shrinking labels
    // and touch targets until they become unreadable.
    // Docking a reading pane changes the canvas size, not the user's zoom.
    const availableWidth = expanded ? window.innerWidth : referenceWidth || viewportSize.width;
    const scale = Math.max(1, Math.min(1.4, Math.max(160, availableWidth - 24) / width));
    return { width, height, scale };
  }, [svg, viewportSize.width, expanded, referenceWidth]);
  const size = { width: geometry.width * geometry.scale * zoom, height: geometry.height * geometry.scale * zoom };

  const changeZoom = (value: number, x?: number, y?: number) => {
    const next = Math.max(0.01, Math.min(4, value));
    const container = viewport.current;
    if (container) {
      const box = container.getBoundingClientRect();
      const anchorX = x === undefined ? container.clientWidth / 2 : x - box.left;
      const anchorY = y === undefined ? container.clientHeight / 2 : y - box.top;
      const ratio = next / zoomValue.current;
      const left = (container.scrollLeft + anchorX) * ratio - anchorX;
      const top = (container.scrollTop + anchorY) * ratio - anchorY;
      const apply = () => { if (viewport.current === container) { container.scrollLeft = left; container.scrollTop = top; } };
      if (window.requestAnimationFrame) window.requestAnimationFrame(apply); else window.setTimeout(apply, 0);
    }
    zoomValue.current = next; setZoom(next);
  };
  const resetZoom = () => {
    zoomValue.current = 1; setZoom(1);
    if (viewport.current) { viewport.current.scrollLeft = 0; viewport.current.scrollTop = 0; }
  };
  useEffect(() => {
    let cancelled = false;
    setSvg(''); setFailed(false); resetZoom(); setDownloadError(false); pointers.current.clear();
    void loadMermaid().then(async mermaid => {
      initializeMermaid(mermaid);
      const rendered = await mermaid.render(`td-architecture-${key}`, diagram.code);
      if (!cancelled) setSvg(DOMPurify.sanitize(rendered.svg, { USE_PROFILES: { svg: true, svgFilters: true } }));
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [diagram.code, key]);
  useEffect(() => { if (!active) setExpanded(false); }, [active]);
  useEffect(() => { expandedChange.current?.(expanded); }, [expanded]);
  useEffect(() => () => expandedChange.current?.(false), []);
  useLayoutEffect(() => {
    const container = viewport.current;
    if (!container) return;
    container.scrollLeft = canvasPosition.current.left; container.scrollTop = canvasPosition.current.top;
    return () => { canvasPosition.current = { left: container.scrollLeft, top: container.scrollTop }; };
  }, [expanded, !!svg]);

  useEffect(() => {
    const container = viewport.current;
    if (!container) return;
    const clip = container.closest<HTMLElement>('[data-architecture-content]');
    const resize = () => {
      setViewportSize({ width: container.clientWidth || 320, height: container.clientHeight || 320, clipHeight: clip?.clientHeight || 0 });
    };
    resize();
    const observer = new ResizeObserver(resize); observer.observe(container);
    if (clip) observer.observe(clip);
    return () => observer.disconnect();
  }, [svg, expanded]);

  useKeyboardLayer(dialog, expanded && active, () => {
    if (inspectorNavigation.current.inspector) inspectorNavigation.current.onDismissInspector?.();
    else setExpanded(false);
  }, () => restoreFocus.current ? fullscreenTrigger.current : null);
  useEffect(() => {
    if (!expanded) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = overflow; pointers.current.clear(); };
  }, [expanded]);

  useLayoutEffect(() => {
    const element = root.current?.querySelector('svg');
    const group = element?.querySelector('g');
    if (!element || !group || typeof group.getBBox !== 'function') return;
    try {
      const box = group.getBBox();
      if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) return;
      const viewBox = `${box.x - 16} ${box.y - 16} ${box.width + 32} ${box.height + 32}`;
      if (element.getAttribute('viewBox') === viewBox) return;
      element.setAttribute('viewBox', viewBox); setSvg(element.outerHTML);
    } catch { /* Detached SVGs can temporarily have no geometry. */ }
  }, [svg, expanded]);

  useLayoutEffect(() => {
    root.current?.querySelectorAll<SVGGElement>('g.node').forEach(node => {
      const index = Number(node.id.match(/flowchart-n(\d+)-/)?.[1]);
      const item = diagram.nodes[index];
      if (!item) return;
      node.dataset.architectureNode = item.id;
      node.dataset.architectureRelated = String(!!selectedId && connections.some(edge => (edge.from === selectedId && edge.to === item.id) || (edge.to === selectedId && edge.from === item.id)));
      node.setAttribute('role', 'button'); node.setAttribute('tabindex', '0');
      node.setAttribute('aria-label', item.title); node.setAttribute('aria-pressed', String(selectedId === item.id));
    });
  });
  useLayoutEffect(() => {
    if (!selectedId || inspectorStage === 'source' || inspectorStage === 'analysis') return;
    const container = viewport.current;
    const node = [...(root.current?.querySelectorAll<SVGGElement>('[data-architecture-node]') ?? [])].find(node => node.dataset.architectureNode === selectedId);
    if (!container || !node) return;
    let canvas = container.getBoundingClientRect();
    const clip = container.closest<HTMLElement>('[data-architecture-content]');
    if (!expanded && clip && canvas.width > 24 && canvas.height > 24) {
      const boundary = clip.getBoundingClientRect();
      // An expanded reading pane may leave the inline graph below the fold.
      // Reveal only enough graph to retain context, without resetting the page.
      const visibleHeight = Math.min(canvas.height, Math.max(160, boundary.height - 136));
      if (boundary.height > 160 && Math.min(canvas.bottom, boundary.bottom) - Math.max(canvas.top, boundary.top) < visibleHeight) {
        clip.scrollTop += Math.max(0, canvas.top - boundary.bottom + visibleHeight);
        canvas = container.getBoundingClientRect();
      }
      // The perspective selector and diagram toolbar stay above the graph.
      const top = Math.max(canvas.top, boundary.top + 136), bottom = Math.min(canvas.bottom, boundary.bottom);
      canvas = new DOMRect(canvas.left, top, canvas.width, Math.max(0, bottom - top));
    }
    const box = node.getBoundingClientRect();
    if (canvas.width <= 24 || canvas.height <= 24 || box.width <= 0 || box.height <= 0) return;
    // Move only as far as needed to keep the selected node in the remaining
    // canvas. Avoid scrollIntoView, which also scrolls ancestor panels.
    const margin = 12;
    const dx = box.width > canvas.width - 2 * margin ? (box.left + box.right - canvas.left - canvas.right) / 2
      : box.left < canvas.left + margin ? box.left - canvas.left - margin
      : box.right > canvas.right - margin ? box.right - canvas.right + margin : 0;
    const dy = box.height > canvas.height - 2 * margin ? (box.top + box.bottom - canvas.top - canvas.bottom) / 2
      : box.top < canvas.top + margin ? box.top - canvas.top - margin
      : box.bottom > canvas.bottom - margin ? box.bottom - canvas.bottom + margin : 0;
    container.scrollLeft += dx; container.scrollTop += dy;
  }, [selectedId, viewportSize.width, viewportSize.height, viewportSize.clipHeight, expanded, inspectorStage, svg]);
  const selectNode = (id: string) => {
    [...(root.current?.querySelectorAll<SVGGElement>('[data-architecture-node]') ?? [])].find(node => node.dataset.architectureNode === id)?.focus?.({ preventScroll: true });
    onSelect(id);
  };
  const control = 'flex h-11 min-w-11 items-center justify-center rounded-lg px-2 hover:bg-surface-elevated focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40';
  const controls = <>
    <button type="button" className={control} aria-label={t('architecture.zoomOut')} disabled={zoom <= 0.01} onClick={() => changeZoom(zoomValue.current / 1.25)}><Minus size={17} /></button>
    <button type="button" className={`${control} text-xs tabular-nums`} aria-label={t('architecture.resetZoom')} title={t('architecture.resetZoom')} onClick={resetZoom}>{Math.round(geometry.scale * zoom * 100)}%</button>
    <button type="button" className={control} aria-label={t('architecture.zoomIn')} disabled={zoom >= 4} onClick={() => changeZoom(zoomValue.current * 1.25)}><Plus size={17} /></button>
    <button type="button" className={control} aria-label={t('architecture.fitGraph')} onClick={() => changeZoom(Math.min((viewportSize.width - 24) / geometry.width, (viewportSize.height - 24) / geometry.height) / geometry.scale)}><Scan size={17} /></button>
    {!expanded && <button ref={fullscreenTrigger} type="button" className={control} aria-label={t('architecture.fullscreen')} onClick={() => { restoreFocus.current = true; setExpanded(true); }}><Expand size={17} /></button>}
    <button type="button" className={control} aria-label={t('architecture.download')} disabled={!svg} onClick={() => {
      setDownloadError(false);
      void saveDownloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `architecture-${view.id}.svg`).catch(() => setDownloadError(true));
    }}><Download size={17} /></button>
    {expanded && <button ref={close} type="button" className={control} aria-label={t('architecture.closeFullscreen')} onClick={() => setExpanded(false)}><X size={18} /></button>}
  </>;
  const title = view.nodes.find(node => node.id === parentId)?.title ?? view.title;
  const contents = <>
    {expanded ? <header className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/15 px-2 py-1">
      <div className="min-w-0 basis-full px-1 min-[360px]:basis-0 min-[360px]:flex-1">{heading ?? <h2 className="truncate text-xs font-semibold" title={title}>{title}</h2>}</div>
      <div className="flex w-full shrink-0 items-center justify-between gap-1 min-[360px]:w-auto" title={t('architecture.panHint')}>{controls}</div>
    </header> : <div className="sticky top-[60px] z-10 shrink-0 border-b border-border/15 bg-surface-2 px-2 py-1">
      <div className="flex items-center justify-between gap-1">{controls}</div>
      <p className="px-1 pb-1 text-xs text-muted-foreground">{t('architecture.panHint')}</p>
    </div>}
    {expanded && navigation}
    {downloadError && <p role="alert" className="px-3 py-2 text-xs text-destructive">{t('architecture.downloadFailed')}</p>}
    <div className={expanded ? 'relative flex min-h-0 flex-1 flex-col overflow-hidden min-[768px]:flex-row' : 'relative'}>
    {failed ? <p role="alert" className="p-4 text-sm text-muted-foreground">{t('architecture.diagramFailed')}</p>
      : !svg ? <p role="status" className="p-4 text-sm text-muted-foreground">{t('architecture.rendering')}</p>
      : <div ref={viewport} data-sidebar-gesture-ignore className={`termdock-architecture-viewport overflow-auto overscroll-contain p-3 ${expanded ? 'min-h-0 min-w-0 flex-1' : 'h-[min(50dvh,26rem)]'}`} style={{ touchAction: 'none', maxHeight: !expanded && viewportSize.clipHeight ? Math.max(160, viewportSize.clipHeight - 150) : undefined }}
        onPointerDown={event => {
          if (event.button !== 0) return;
          if (!pointers.current.size) { dragged.current = false; dragDistance.current = 0; }
          const nodeId = (event.target as Element).closest('[data-architecture-node]')?.getAttribute('data-architecture-node') ?? undefined;
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY, nodeId });
          if (pointers.current.size > 1) dragged.current = true;
          try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* pointer may already have ended */ }
        }} onPointerMove={event => {
          const before = pointers.current.get(event.pointerId);
          if (!before) return;
          const oldPoints = [...pointers.current.values()];
          pointers.current.set(event.pointerId, { ...before, x: event.clientX, y: event.clientY });
          const points = [...pointers.current.values()];
          if (points.length >= 2) {
            const distance = (items: { x: number; y: number }[]) => Math.hypot(items[0].x - items[1].x, items[0].y - items[1].y);
            const prior = distance(oldPoints), next = distance(points);
            if (prior > 0) changeZoom(zoomValue.current * next / prior, (points[0].x + points[1].x) / 2, (points[0].y + points[1].y) / 2);
            dragged.current = true;
          } else {
            const dx = before.x - event.clientX, dy = before.y - event.clientY;
            dragDistance.current += Math.hypot(dx, dy);
            if (dragDistance.current > 5) dragged.current = true;
            event.currentTarget.scrollLeft += dx; event.currentTarget.scrollTop += dy;
          }
        }} onPointerUp={event => {
          const point = pointers.current.get(event.pointerId);
          const tap = pointers.current.size === 1 && !dragged.current && point?.nodeId;
          pointers.current.delete(event.pointerId);
          if (tap) { dragged.current = true; selectNode(tap); }
        }} onPointerCancel={event => { pointers.current.delete(event.pointerId); dragged.current = true; }} onLostPointerCapture={event => { pointers.current.delete(event.pointerId); }}>
        <div ref={root} role="group" aria-label={t('architecture.modules')} className="termdock-architecture-diagram mx-auto" style={size}
          onClick={event => {
            if (dragged.current) return;
            const node = (event.target as Element).closest('[data-architecture-node]');
            const id = node?.getAttribute('data-architecture-node'); if (id) selectNode(id);
          }} onKeyDown={event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const id = (event.target as Element).closest('[data-architecture-node]')?.getAttribute('data-architecture-node');
            if (id) { event.preventDefault(); selectNode(id); }
          }} dangerouslySetInnerHTML={{ __html: svg }} />
      </div>}
      {expanded && inspector}
    </div>
  </>;
  if (expanded) return createPortal(<section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t('architecture.diagram')} data-sidebar-gesture-ignore className="fixed inset-0 z-modal-panel flex flex-col overflow-hidden bg-surface text-foreground pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
    {contents}
  </section>, document.body);
  return <section className="overflow-clip rounded-xl border border-border/20 bg-surface-2" aria-label={t('architecture.diagram')}>{contents}</section>;
}
