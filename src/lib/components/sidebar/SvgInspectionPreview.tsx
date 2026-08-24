import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type WheelEvent } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2 as RiFullscreen, Minimize2 as RiFullscreenExit, Scan as RiFit } from 'lucide-react';
import { FloatingAnnotationButton } from './FloatingAnnotationButton';

export interface SvgPick {
  x: number;
  y: number;
  xPercent: number;
  yPercent: number;
  nearestText?: string;
}

interface SvgViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface SvgViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Convert a browser pointer position into the SVG's viewBox coordinates.
 * The preview always uses `xMidYMid meet`, so account for the empty bands
 * introduced when the element and viewBox have different aspect ratios.
 */
export function clientPointToSvgViewBox(
  clientX: number,
  clientY: number,
  viewport: SvgViewport,
  viewBox: SvgViewBox,
): Omit<SvgPick, 'nearestText'> | null {
  if (viewport.width <= 0 || viewport.height <= 0 || viewBox.width <= 0 || viewBox.height <= 0) return null;
  const scale = Math.min(viewport.width / viewBox.width, viewport.height / viewBox.height);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const contentWidth = viewBox.width * scale;
  const contentHeight = viewBox.height * scale;
  const contentLeft = viewport.left + (viewport.width - contentWidth) / 2;
  const contentTop = viewport.top + (viewport.height - contentHeight) / 2;
  const offsetX = clientX - contentLeft;
  const offsetY = clientY - contentTop;
  if (offsetX < 0 || offsetY < 0 || offsetX > contentWidth || offsetY > contentHeight) return null;
  const xPercent = offsetX / contentWidth * 100;
  const yPercent = offsetY / contentHeight * 100;
  return {
    x: viewBox.x + viewBox.width * xPercent / 100,
    y: viewBox.y + viewBox.height * yPercent / 100,
    xPercent,
    yPercent,
  };
}

export function formatSvgAnnotation(filePath: string, viewLabel: string, pick: SvgPick): string {
  const fields = [
    `SVG标注: ${filePath}`,
    `视图: ${viewLabel}`,
    `SVG坐标: (${pick.x.toFixed(2)},${pick.y.toFixed(2)}) [viewBox坐标]`,
    `图片位置: (${pick.xPercent.toFixed(1)}%,${pick.yPercent.toFixed(1)}%) [相对内容边界左上角]`,
  ];
  if (pick.nearestText) fields.push(`最近文字: ${pick.nearestText}`);
  return `"${fields.join(' / ')}"`;
}

function sanitizeSvg(source: string): string {
  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  const svg = document.documentElement;
  if (svg.nodeName.toLowerCase() !== 'svg' || document.querySelector('parsererror')) {
    throw new Error('Invalid SVG document');
  }
  document.querySelectorAll('script,foreignObject,iframe,object,embed').forEach((node) => node.remove());
  document.querySelectorAll('*').forEach((node) => {
    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith('on') || ((name === 'href' || name.endsWith(':href')) && value && !value.startsWith('#'))) {
        node.removeAttribute(attribute.name);
      }
    }
  });
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  return new XMLSerializer().serializeToString(svg);
}

function nearestSvgText(svg: SVGSVGElement, x: number, y: number): string | undefined {
  let nearest: { text: string; distance: number } | null = null;
  for (const node of Array.from(svg.querySelectorAll<SVGTextElement>('text'))) {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const tx = Number(node.getAttribute('x'));
    const ty = Number(node.getAttribute('y'));
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) continue;
    const distance = Math.hypot(tx - x, ty - y);
    if (!nearest || distance < nearest.distance) nearest = { text, distance };
  }
  return nearest?.text.slice(0, 120);
}

export function SvgInspectionPreview({
  blobUrl,
  filePath,
  viewLabel,
  onInsertAnnotation,
}: {
  blobUrl: string;
  filePath: string;
  viewLabel: string;
  onInsertAnnotation?: (text: string, key: string) => void;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [markup, setMarkup] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const [pick, setPick] = useState<(SvgPick & { stageX: number; stageY: number; stageXPercent: number; stageYPercent: number }) | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<{
    kind: 'pan' | 'pinch';
    startX: number;
    startY: number;
    startScrollLeft: number;
    startScrollTop: number;
    startDistance?: number;
    startZoom: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useEffect(() => {
    const controller = new AbortController();
    setMarkup(null);
    setError(null);
    setPick(null);
    setZoom(1);
    fetch(blobUrl, { signal: controller.signal })
      .then((response) => response.text())
      .then((text) => setMarkup(sanitizeSvg(text)))
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'SVG preview failed');
      });
    return () => controller.abort();
  }, [blobUrl]);

  useEffect(() => {
    if (!expanded) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [expanded]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const svg = root?.querySelector<SVGSVGElement>('[data-svg-document] > svg');
    if (!root || !svg) return;
    let box: DOMRect | SVGRect;
    try {
      box = svg.getBBox();
    } catch {
      return;
    }
    if (!box.width || !box.height) return;
    const padding = Math.max(2, Math.min(box.width, box.height) * 0.025);
    svg.setAttribute('viewBox', `${box.x - padding} ${box.y - padding} ${box.width + 2 * padding} ${box.height + 2 * padding}`);
    svg.style.width = `${zoom * 100}%`;
    svg.style.height = `${zoom * 100}%`;
    svg.style.minWidth = `${zoom * 100}%`;
    svg.style.minHeight = `${zoom * 100}%`;
    svg.style.display = 'block';
  }, [markup, zoom]);

  const annotation = useMemo(
    () => pick ? formatSvgAnnotation(filePath, viewLabel, pick) : null,
    [filePath, pick, viewLabel],
  );

  const handlePick = (event: MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const root = rootRef.current;
    const svg = root?.querySelector<SVGSVGElement>('[data-svg-document] > svg');
    const stage = stageRef.current;
    if (!root || !svg || !stage) return;
    const viewBox = svg.viewBox.baseVal;
    const local = clientPointToSvgViewBox(event.clientX, event.clientY, svg.getBoundingClientRect(), viewBox);
    if (!local) return;
    const stageRect = stage.getBoundingClientRect();
    setPick({
      ...local,
      nearestText: nearestSvgText(svg, local.x, local.y),
      stageX: event.clientX - stageRect.left,
      stageY: event.clientY - stageRect.top,
      stageXPercent: (event.clientX - stageRect.left) / stageRect.width * 100,
      stageYPercent: (event.clientY - stageRect.top) / stageRect.height * 100,
    });
  };

  const clampZoom = (value: number) => Math.max(1, Math.min(12, value));
  const paintZoom = (root: HTMLDivElement, value: number) => {
    const nextZoom = clampZoom(value);
    const svg = root.querySelector<SVGSVGElement>('[data-svg-document] > svg');
    if (!svg) return nextZoom;
    const size = `${nextZoom * 100}%`;
    svg.style.width = size;
    svg.style.height = size;
    svg.style.minWidth = size;
    svg.style.minHeight = size;
    zoomRef.current = nextZoom;
    return nextZoom;
  };

  const zoomAtPoint = (root: HTMLDivElement, value: number, clientX: number, clientY: number) => {
    const previousZoom = zoomRef.current;
    const rect = root.getBoundingClientRect();
    const centerX = clientX - rect.left;
    const centerY = clientY - rect.top;
    const contentX = (root.scrollLeft + centerX) / previousZoom;
    const contentY = (root.scrollTop + centerY) / previousZoom;
    const nextZoom = paintZoom(root, value);
    root.scrollLeft = contentX * nextZoom - centerX;
    root.scrollTop = contentY * nextZoom - centerY;
    return nextZoom;
  };
  const distanceBetweenPointers = () => {
    const points = Array.from(pointersRef.current.values());
    return points.length >= 2 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0;
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const root = rootRef.current;
    if (!root) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    root.setPointerCapture?.(event.pointerId);
    if (pointersRef.current.size >= 2) {
      gestureRef.current = {
        kind: 'pinch',
        startX: event.clientX,
        startY: event.clientY,
        startScrollLeft: root.scrollLeft,
        startScrollTop: root.scrollTop,
        startDistance: distanceBetweenPointers(),
        startZoom: zoomRef.current,
        moved: false,
      };
      suppressClickRef.current = true;
    } else if (zoomRef.current > 1) {
      gestureRef.current = {
        kind: 'pan',
        startX: event.clientX,
        startY: event.clientY,
        startScrollLeft: root.scrollLeft,
        startScrollTop: root.scrollTop,
        startZoom: zoomRef.current,
        moved: false,
      };
    }
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const root = rootRef.current;
    const gesture = gestureRef.current;
    if (!root || !gesture) return;
    if (pointersRef.current.size >= 2 && gesture.kind === 'pinch') {
      const nextDistance = distanceBetweenPointers();
      if (!gesture.startDistance || !nextDistance) return;
      const nextZoom = clampZoom(gesture.startZoom * nextDistance / gesture.startDistance);
      if (Math.abs(nextZoom - zoomRef.current) < 0.01) return;
      const points = Array.from(pointersRef.current.values());
      const centerClientX = (points[0].x + points[1].x) / 2;
      const centerClientY = (points[0].y + points[1].y) / 2;
      gesture.moved = true;
      suppressClickRef.current = true;
      zoomAtPoint(root, nextZoom, centerClientX, centerClientY);
      event.preventDefault();
      return;
    }
    if (gesture.kind === 'pan' && pointersRef.current.size === 1) {
      const dx = event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;
      if (!gesture.moved && Math.hypot(dx, dy) < 6) return;
      gesture.moved = true;
      suppressClickRef.current = true;
      root.scrollLeft = gesture.startScrollLeft - dx;
      root.scrollTop = gesture.startScrollTop - dy;
      event.preventDefault();
    }
  };

  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    const gesture = gestureRef.current;
    const wasSingleTap = pointersRef.current.size === 1 && !gesture?.moved;
    pointersRef.current.delete(event.pointerId);
    try { root?.releasePointerCapture?.(event.pointerId); } catch { /* capture is best effort */ }
    if (pointersRef.current.size === 1 && gesture?.kind === 'pinch') {
      const remaining = Array.from(pointersRef.current.values())[0];
      gestureRef.current = root ? {
        kind: 'pan', startX: remaining.x, startY: remaining.y,
        startScrollLeft: root.scrollLeft, startScrollTop: root.scrollTop,
        startZoom: zoomRef.current, moved: false,
      } : null;
      return;
    }
    if (pointersRef.current.size > 0) return;
    gestureRef.current = null;
    // Pinch paints directly for frame-rate responsiveness; synchronize React
    // only once at gesture end so later fit/double-tap controls see the value.
    if (gesture?.kind === 'pinch') setZoom(zoomRef.current);
    if (!wasSingleTap || suppressClickRef.current) return;
    const now = Date.now();
    const last = lastTapRef.current;
    if (last && now - last.time < 350 && Math.hypot(event.clientX - last.x, event.clientY - last.y) < 24) {
      lastTapRef.current = null;
      suppressClickRef.current = true;
      setZoom((value) => value > 1 ? 1 : 2.5);
    } else {
      lastTapRef.current = { time: now, x: event.clientX, y: event.clientY };
    }
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    const root = rootRef.current;
    if (!root) return;
    event.preventDefault();
    const nextZoom = zoomAtPoint(root, zoomRef.current * Math.exp(-event.deltaY * 0.01), event.clientX, event.clientY);
    setZoom(nextZoom);
  };

  const fitToWindow = () => {
    setZoom(1);
    zoomRef.current = 1;
    if (rootRef.current) {
      rootRef.current.scrollLeft = 0;
      rootRef.current.scrollTop = 0;
    }
  };

  const viewer = (
    <div className={expanded
      ? 'fixed inset-0 z-modal-panel flex min-h-0 flex-col bg-surface pt-[env(safe-area-inset-top,0px)]'
      : 'flex h-full min-h-0 flex-col bg-surface'}>
      <div ref={stageRef} className="relative min-h-0 flex-1">
        <div
          ref={rootRef}
          role="button"
          tabIndex={0}
          onClick={handlePick}
          onDoubleClick={(event) => { event.preventDefault(); setZoom((value) => value > 1 ? 1 : 2.5); }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onWheel={handleWheel}
          onScroll={() => setPick(null)}
          className="h-full touch-none cursor-crosshair overflow-auto bg-white p-3 text-slate-900"
        >
          {error ? <div className="p-4 text-sm text-destructive">{error}</div> : markup ? <div data-svg-document className="h-full min-h-[240px] w-full" dangerouslySetInnerHTML={{ __html: markup }} /> : <div className="p-4 text-sm text-muted-foreground">Loading SVG…</div>}
        </div>
        {pick && <span data-svg-pick-marker className="pointer-events-none absolute z-10 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-white shadow-sm" style={{ left: pick.stageX, top: pick.stageY }} />}
        {pick && annotation && (
          <FloatingAnnotationButton
            anchor={{ xPercent: pick.stageXPercent, yPercent: pick.stageYPercent }}
            title="引用 SVG 标注"
            onClick={() => {
              onInsertAnnotation?.(annotation, `svg:${pick.x.toFixed(2)}:${pick.y.toFixed(2)}`);
              setPick(null);
            }}
          >
            引用 SVG 标注
          </FloatingAnnotationButton>
        )}
        <div
          data-svg-toolbar
          className="absolute right-2 top-2 z-20 flex gap-1"
        >
          {zoom > 1.001 && <button type="button" aria-label="适合窗口" title="适合窗口" onClick={(event) => { event.stopPropagation(); fitToWindow(); }} className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white/95 text-slate-600 shadow-sm backdrop-blur transition active:scale-95"><RiFit size={14} /></button>}
          <button
            type="button"
            aria-label={expanded ? '退出全屏 SVG' : '全屏 SVG'}
            title={expanded ? '退出全屏 SVG' : '全屏 SVG'}
            onClick={(event) => { event.stopPropagation(); setExpanded((value) => !value); }}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white/95 text-slate-600 shadow-sm backdrop-blur transition active:scale-95"
          >
            {expanded ? <RiFullscreenExit size={14} /> : <RiFullscreen size={14} />}
          </button>
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/15 px-3 py-2">
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">{pick ? `SVG (${pick.x.toFixed(2)}, ${pick.y.toFixed(2)}) · ${pick.nearestText ?? '附近无文字'}` : '点击 SVG 的问题位置生成精确引用'}</span>
      </div>
    </div>
  );

  return expanded ? createPortal(viewer, document.body) : viewer;
}
