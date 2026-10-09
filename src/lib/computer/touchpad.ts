import type { ComputerPointer } from './pointer';

export type ComputerTouchMode = 'trackpad' | 'direct';
const MODE_KEY = 'termdock:computer-touch-mode:v1';
export function readComputerTouchMode(): ComputerTouchMode {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === 'trackpad' || saved === 'direct') return saved;
  } catch { /* Device-local preference is optional. */ }
  return navigator.maxTouchPoints > 0 && window.matchMedia('(any-pointer: coarse)').matches ? 'trackpad' : 'direct';
}
export function saveComputerTouchMode(mode: ComputerTouchMode): void {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* Private browsing. */ }
}

export interface TouchpadPosition { x: number; y: number }
interface Finger { x: number; y: number; startX: number; startY: number }
const TAP_DISTANCE = 8;
const TAP_MS = 300;
const DRAG_MS = 450;
const SCROLL_STEP = 18;
const clamp = (value: number, max: number) => Math.max(0, Math.min(value, Math.max(0, max - 1)));

/** Capture touch only: physical mouse input continues through the renderer.
 * One-finger motion is relative, so lifting/repositioning never teleports the
 * cursor. Native touch handlers never receive this gesture a second time. */
export function attachComputerTouchpad(
  viewport: HTMLElement,
  pointer: ComputerPointer,
  cursor: HTMLElement,
  position: { current: TouchpadPosition | null },
): () => void {
  const listeners = new AbortController();
  const fingers = new Map<number, Finger>();
  let startedAt = 0;
  let maxFingers = 0;
  let moved = false;
  let cancelled = false;
  let scrolling = false;
  let scrollY = 0;
  let buttons = 0;
  let frame: number | undefined;
  let pendingMovement = false;
  let cursorVisible = true;
  let geometryDirty = true;
  let hold: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const point = () => {
    const size = pointer.size();
    const current = position.current ??= { x: size.width / 2, y: size.height / 2 };
    current.x = clamp(current.x, size.width); current.y = clamp(current.y, size.height);
    return current;
  };
  // Cache layout outside the pointer-move path. Mixing DOM writes and layout
  // reads for every touch sample forces reflow on mobile browsers.
  interface Geometry {
    width: number; height: number; left: number; top: number; scaleX: number; scaleY: number;
    viewportWidth: number; viewportHeight: number; clientLeft: number; clientTop: number;
    scrollers: Array<{ element: HTMLElement; left: number; top: number; right: number; bottom: number; maxX: number; maxY: number }>;
  }
  let geometry: Geometry | undefined;
  const measure = (): Geometry => {
    const size = pointer.size();
    if (!geometry || geometry.width !== size.width || geometry.height !== size.height) geometryDirty = true;
    if (!geometryDirty && geometry) return geometry;
    const surface = pointer.surface(), bounds = viewport.getBoundingClientRect(), rect = surface.getBoundingClientRect();
    const scrollers: Geometry['scrollers'] = [];
    for (let parent = surface.parentElement; parent && parent !== viewport; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const maxX = /auto|scroll/.test(style.overflowX) ? Math.max(0, parent.scrollWidth - parent.clientWidth) : 0;
      const maxY = /auto|scroll/.test(style.overflowY) ? Math.max(0, parent.scrollHeight - parent.clientHeight) : 0;
      if (!maxX && !maxY) continue;
      const area = parent.getBoundingClientRect();
      scrollers.push({ element: parent, left: area.left - bounds.left, top: area.top - bounds.top,
        right: area.right - bounds.left, bottom: area.bottom - bounds.top, maxX, maxY });
    }
    geometry = { ...size, left: rect.left - bounds.left, top: rect.top - bounds.top,
      scaleX: size.width && rect.width ? rect.width / size.width : 1,
      scaleY: size.height && rect.height ? rect.height / size.height : 1,
      viewportWidth: bounds.width, viewportHeight: bounds.height, clientLeft: bounds.left, clientTop: bounds.top, scrollers };
    geometryDirty = false;
    return geometry;
  };
  const drawCursor = () => {
    const g = measure(), p = point();
    if (!g.width || !g.height || !cursorVisible) { cursor.hidden = true; return; }
    let x = g.left + p.x * g.scaleX, y = g.top + p.y * g.scaleY;
    // Follow the pointer only when it crosses an original-size viewport edge.
    // Read all geometry before writing scroll offsets and the cursor transform.
    for (const area of g.scrollers) {
      if (area.maxX) {
        const previous = area.element.scrollLeft;
        const delta = x < area.left + 20 ? x - area.left - 20 : x > area.right - 20 ? x - area.right + 20 : 0;
        const next = Math.max(0, Math.min(area.maxX, previous + delta));
        if (previous !== next) { area.element.scrollLeft = next; x -= next - previous; g.left -= next - previous; }
      }
      if (area.maxY) {
        const previous = area.element.scrollTop;
        const delta = y < area.top + 20 ? y - area.top - 20 : y > area.bottom - 20 ? y - area.bottom + 20 : 0;
        const next = Math.max(0, Math.min(area.maxY, previous + delta));
        if (previous !== next) { area.element.scrollTop = next; y -= next - previous; g.top -= next - previous; }
      }
    }
    cursor.hidden = x < 0 || y < 0 || x >= g.viewportWidth || y >= g.viewportHeight;
    cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };
  const transmit = (mask = buttons) => {
    const p = point();
    pointer.send(Math.round(p.x), Math.round(p.y), mask);
  };
  const renderFrame = () => {
    frame = undefined;
    drawCursor();
    if (pendingMovement) { pendingMovement = false; transmit(); }
    let steps = 0;
    while (Math.abs(scrollY) >= SCROLL_STEP && steps++ < 8) {
      const mask = scrollY > 0 ? 16 : 8;
      transmit(mask); transmit(0);
      scrollY -= Math.sign(scrollY) * SCROLL_STEP;
    }
  };
  const schedule = () => { if (!stopped) frame ??= requestAnimationFrame(renderFrame); };
  const flush = () => {
    if (frame === undefined) return;
    cancelAnimationFrame(frame); renderFrame();
  };
  const release = () => {
    clearTimeout(hold);
    flush();
    if (buttons) { buttons = 0; transmit(); }
  };
  const suppress = (event: Event) => { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation(); };
  const centroidY = () => [...fingers.values()].reduce((sum, finger) => sum + finger.y, 0) / fingers.size;
  const down = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    suppress(event);
    cursorVisible = true;
    schedule();
    if (!fingers.size) {
      startedAt = performance.now(); maxFingers = 0; moved = false; cancelled = false; scrolling = false; scrollY = 0;
    }
    fingers.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY });
    maxFingers = Math.max(maxFingers, fingers.size);
    try { viewport.setPointerCapture(event.pointerId); } catch { /* Pointer already cancelled by the browser. */ }
    clearTimeout(hold);
    if (fingers.size === 1 && maxFingers === 1) {
      hold = setTimeout(() => {
        if (!stopped && fingers.size === 1 && !moved && !cancelled) { buttons = 1; transmit(); }
      }, DRAG_MS);
    } else { release(); scrolling = true; }
  };
  const move = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') {
      // Native mouse input does not use this touchpad's position scheduler.
      const g = measure();
      position.current = { x: clamp((event.clientX - g.clientLeft - g.left) / g.scaleX, g.width),
        y: clamp((event.clientY - g.clientTop - g.top) / g.scaleY, g.height) };
      cursorVisible = false;
      cursor.hidden = true;
      return;
    }
    const finger = fingers.get(event.pointerId);
    if (!finger) return;
    suppress(event);
    const previousY = centroidY();
    const dx = event.clientX - finger.x, dy = event.clientY - finger.y;
    finger.x = event.clientX; finger.y = event.clientY;
    if (Math.hypot(finger.x - finger.startX, finger.y - finger.startY) > TAP_DISTANCE) {
      moved = true; clearTimeout(hold);
    }
    if (fingers.size === 2 && !cancelled) {
      // Natural scrolling: moving fingers upward scrolls the desktop down.
      scrollY += previousY - centroidY();
      if (Math.abs(scrollY) >= SCROLL_STEP) { moved = true; schedule(); }
    } else if (fingers.size === 1 && !scrolling && !cancelled) {
      const p = point();
      // One CSS pixel of finger motion moves the displayed cursor one pixel.
      // Tap tolerance only classifies clicks; it must not create a dead zone
      // or discard the beginning of a slow, precise movement.
      const g = geometry ?? measure();
      p.x += dx / g.scaleX; p.y += dy / g.scaleY;
      point(); pendingMovement = true; schedule();
    }
  };
  const up = (event: PointerEvent) => {
    if (!fingers.has(event.pointerId)) return;
    suppress(event);
    const wasDragging = buttons !== 0;
    if (event.type !== 'pointerup') cancelled = true;
    release();
    fingers.delete(event.pointerId);
    try { if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId); } catch { /* Browser already released it. */ }
    if (fingers.size) return;
    scrollY = 0;
    if (!cancelled && !wasDragging && !moved && maxFingers <= 2 && performance.now() - startedAt <= TAP_MS) {
      transmit(maxFingers === 2 ? 4 : 1); transmit(0);
    }
  };
  const reset = () => {
    cancelled = true;
    release();
    const ids = [...fingers.keys()]; fingers.clear();
    scrollY = 0;
    for (const id of ids) try { if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id); } catch { /* Disposed element. */ }
  };
  const options = { capture: true, passive: false, signal: listeners.signal };
  viewport.addEventListener('pointerdown', down, options);
  viewport.addEventListener('pointermove', move, options);
  viewport.addEventListener('pointerup', up, options);
  viewport.addEventListener('pointercancel', up, options);
  viewport.addEventListener('lostpointercapture', up, options);
  for (const name of ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'contextmenu']) viewport.addEventListener(name, suppress, options);
  const layoutChanged = () => { geometryDirty = true; schedule(); };
  viewport.addEventListener('scroll', layoutChanged, { capture: true, signal: listeners.signal });
  window.addEventListener('blur', reset, { signal: listeners.signal });
  const visibility = () => { if (document.hidden) reset(); };
  document.addEventListener('visibilitychange', visibility, { signal: listeners.signal });
  const resize = new ResizeObserver(layoutChanged); resize.observe(viewport); resize.observe(pointer.surface());
  drawCursor();
  return () => {
    if (stopped) return;
    stopped = true;
    // Remove cancellation listeners before explicitly releasing capture.
    listeners.abort(); reset(); resize.disconnect(); cursor.hidden = true;
  };
}
