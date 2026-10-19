import type { ComputerPointer } from './pointer';
import type { ComputerZoom } from './zoom';
import type { ComputerMotionTrace } from './motionTrace';
import { observeComputerMotion } from './motionObservation';

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
const TWO_FINGER_WAIT_MS = 50;
const clamp = (value: number, max: number) => Math.max(0, Math.min(value, Math.max(0, max - 1)));

/** Capture touch only: physical mouse input continues through the renderer.
 * One-finger motion is relative, so lifting/repositioning never teleports the
 * cursor. Native touch handlers never receive this gesture a second time. */
export function attachComputerTouchpad(
  viewport: HTMLElement,
  pointer: ComputerPointer,
  position: { current: TouchpadPosition | null },
  options: { mode?: ComputerTouchMode; zoom?: ComputerZoom; viewOnly?: boolean; trace?: ComputerMotionTrace } = {},
): () => void {
  const listeners = new AbortController();
  const stopObservation = options.trace ? observeComputerMotion(viewport, pointer, options.trace) : undefined;
  const fingers = new Map<number, Finger>();
  let startedAt = 0;
  let maxFingers = 0;
  let moved = false;
  let cancelled = false;
  let scrolling = false;
  let pinching = false;
  let pinchDistance = 0;
  let pinchZoom = 1;
  let twoGesture: 'pending' | 'scroll' | 'pan' | 'pinch' = 'pending';
  let twoStart: Array<{ x: number; y: number }> = [];
  let twoOrigin = { x: 0, y: 0 };
  let twoApplied = { x: 0, y: 0 };
  let twoWait: ReturnType<typeof setTimeout> | undefined;
  let scrollY = 0;
  let buttons = 0;
  let frame: number | undefined;
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
  const trace = (event: string, input?: PointerEvent) => {
    if (!options.trace) return;
    const g = geometry;
    options.trace.record(event, {
      mode: options.mode, pointerType: input?.pointerType, pointerId: input?.pointerId,
      client: input ? [input.clientX, input.clientY] : undefined, inputTime: input?.timeStamp,
      target: position.current ? [position.current.x, position.current.y] : null,
      actual: pointer.position?.(), buttons, fingers: fingers.size, moved, pinching, scrolling,
      zoom: options.zoom?.get(), scale: g ? [g.scaleX, g.scaleY] : undefined,
      surface: g ? [g.left, g.top, g.width, g.height] : undefined,
      viewport: g ? [g.clientLeft, g.clientTop, g.viewportWidth, g.viewportHeight] : undefined,
    });
  };
  options.trace?.record('touchpad-attached', { mode: options.mode, viewOnly: options.viewOnly });
  const followPointer = () => {
    const g = measure(), p = point();
    if (!g.width || !g.height || pinching || options.viewOnly) return;
    let x = g.left + p.x * g.scaleX, y = g.top + p.y * g.scaleY;
    // Follow the pointer only when it crosses an original-size viewport edge.
    // Read all geometry before writing scroll offsets.
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
  };
  const transmit = (mask = buttons) => {
    if (options.viewOnly) return;
    const p = point();
    const before = options.trace ? pointer.position?.() : undefined;
    pointer.send(Math.round(p.x), Math.round(p.y), mask);
    options.trace?.record('send', { target: [Math.round(p.x), Math.round(p.y)], buttons: mask, before, after: pointer.position?.() });
  };
  // RAF batches only wheel ticks and viewport scrolling, never pointer input.
  const renderFrame = () => {
    frame = undefined;
    followPointer();
    let steps = 0;
    while (Math.abs(scrollY) >= SCROLL_STEP && steps++ < 8) {
      const mask = scrollY > 0 ? 16 : 8;
      transmit(mask); transmit(0);
      scrollY -= Math.sign(scrollY) * SCROLL_STEP;
    }
  };
  const schedule = (layoutChanged = false) => {
    if (stopped || (!layoutChanged && Math.abs(scrollY) < SCROLL_STEP && !geometry?.scrollers.length)) return;
    frame ??= requestAnimationFrame(renderFrame);
  };
  const flush = () => {
    if (frame === undefined) return;
    cancelAnimationFrame(frame); renderFrame();
  };
  const discardPending = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined; scrollY = 0;
  };
  const release = () => {
    clearTimeout(hold);
    flush();
    if (buttons) { buttons = 0; transmit(); }
  };
  const suppress = (event: Event) => { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation(); };
  const twoFingers = () => {
    const [a, b] = [...fingers.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  // Pointer events for the two fingers arrive separately. Following noVNC's
  // gesture arbitration, wait briefly for the other finger and then latch the
  // intent. An intermediate change in spacing must not turn a scroll into zoom.
  // This arbitration applies only to two fingers; cursor movement stays immediate.
  const updateTwoFingers = (waited = false) => {
    if (stopped || cancelled || fingers.size !== 2 || maxFingers !== 2) return;
    const focus = twoFingers();
    if (twoGesture === 'pending') {
      const deltas = [...fingers.values()].map((finger, index) => ({
        x: finger.x - twoStart[index].x, y: finger.y - twoStart[index].y,
      }));
      const lengths = deltas.map(delta => Math.hypot(delta.x, delta.y));
      if (Math.max(...lengths) < TAP_DISTANCE) return;
      if (!waited && Math.min(...lengths) < TAP_DISTANCE) {
        twoWait ??= setTimeout(() => { twoWait = undefined; updateTwoFingers(true); }, TWO_FINGER_WAIT_MS);
        return;
      }
      clearTimeout(twoWait); twoWait = undefined;
      const spanChange = Math.abs(focus.distance - pinchDistance);
      const opposite = deltas[0].x * deltas[1].x + deltas[0].y * deltas[1].y < 0;
      const spreading = Math.min(...lengths) >= TAP_DISTANCE ? opposite
        : spanChange > Math.max(Math.abs(focus.x - twoOrigin.x), Math.abs(focus.y - twoOrigin.y));
      twoGesture = options.zoom && spanChange >= TAP_DISTANCE && spreading ? 'pinch'
        : options.mode === 'direct' && options.zoom && options.zoom.get() > 1 ? 'pan' : 'scroll';
      pinching = twoGesture === 'pinch'; moved = true;
      trace('two-finger-classified');
    }
    if (twoGesture === 'pinch' && pinchDistance > 0) {
      options.zoom?.set(pinchZoom * focus.distance / pinchDistance, focus);
      options.zoom?.pan(focus.x - twoApplied.x, focus.y - twoApplied.y);
      geometryDirty = true;
    } else if (twoGesture === 'pan') {
      options.zoom?.pan(focus.x - twoApplied.x, focus.y - twoApplied.y);
      geometryDirty = true;
    } else {
      // Natural scrolling, with fractional movement retained between samples.
      scrollY += twoApplied.y - focus.y;
    }
    twoApplied = focus;
    schedule();
  };
  const directPosition = (event: PointerEvent) => {
    const g = measure();
    position.current = { x: clamp((event.clientX - g.clientLeft - g.left) / g.scaleX, g.width),
      y: clamp((event.clientY - g.clientTop - g.top) / g.scaleY, g.height) };
  };
  const down = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    suppress(event);
    if (!fingers.size) {
      geometryDirty = true;
      clearTimeout(twoWait); twoWait = undefined;
      startedAt = performance.now(); maxFingers = 0; moved = false; cancelled = false; scrolling = false; pinching = false; scrollY = 0;
      if (options.mode === 'direct') directPosition(event);
      else if (pointer.position) { position.current = { ...pointer.position() }; point(); }
    }
    fingers.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY });
    maxFingers = Math.max(maxFingers, fingers.size);
    trace('down', event);
    try { viewport.setPointerCapture(event.pointerId); } catch { /* Pointer already cancelled by the browser. */ }
    clearTimeout(hold);
    if (fingers.size === 1 && maxFingers === 1) {
      hold = setTimeout(() => {
        if (!stopped && fingers.size === 1 && !moved && !cancelled) { buttons = 1; transmit(); }
      }, DRAG_MS);
    } else {
      release(); scrolling = true;
      if (fingers.size === 2 && maxFingers === 2) {
        const focus = twoFingers();
        pinchDistance = focus.distance; pinchZoom = options.zoom?.get() ?? 1;
        twoOrigin = twoApplied = focus; twoGesture = 'pending';
        twoStart = [...fingers.values()].map(({ x, y }) => ({ x, y }));
      } else { cancelled = true; clearTimeout(twoWait); twoWait = undefined; }

    }
  };
  const move = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') return;
    const finger = fingers.get(event.pointerId);
    if (!finger) return;
    suppress(event);
    const dx = event.clientX - finger.x, dy = event.clientY - finger.y;
    finger.x = event.clientX; finger.y = event.clientY;
    trace('move-input', event);
    if (Math.hypot(finger.x - finger.startX, finger.y - finger.startY) > TAP_DISTANCE) {
      moved = true; clearTimeout(hold);
    }
    if (fingers.size === 2 && !cancelled) {
      updateTwoFingers();
    } else if (fingers.size === 1 && !scrolling && !cancelled) {
      if (options.mode === 'direct') {
        directPosition(event);
        if (moved) buttons = 1;
        transmit(); schedule(); return;
      }
      const p = point();
      // One CSS pixel of finger motion moves the displayed cursor one pixel.
      // Tap tolerance only classifies clicks; it must not create a dead zone
      // or discard the beginning of a slow, precise movement.
      const g = measure();
      p.x += dx / g.scaleX; p.y += dy / g.scaleY;
      point();
      transmit(); schedule();
    }
  };
  const up = (event: PointerEvent) => {
    if (!fingers.has(event.pointerId)) return;
    suppress(event);
    trace(event.type, event);
    clearTimeout(twoWait); twoWait = undefined;
    const wasDragging = buttons !== 0;
    if (event.type !== 'pointerup') { cancelled = true; discardPending(); }
    release();
    fingers.delete(event.pointerId);
    try { if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId); } catch { /* Browser already released it. */ }
    if (fingers.size) return;
    scrollY = 0;
    if (!cancelled && !wasDragging && !moved && maxFingers <= 2 && performance.now() - startedAt <= TAP_MS) {
      if (options.mode !== 'direct' || maxFingers === 1) { transmit(maxFingers === 2 ? 4 : 1); transmit(0); }
    }
    trace('gesture-end', event); options.trace?.flush('gesture-end');
  };
  const reset = () => {
    cancelled = true; discardPending();
    clearTimeout(twoWait); twoWait = undefined;
    release();
    const ids = [...fingers.keys()]; fingers.clear();
    scrollY = 0;
    for (const id of ids) try { if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id); } catch { /* Disposed element. */ }
  };
  const listenerOptions = { capture: true, passive: false, signal: listeners.signal };
  viewport.addEventListener('pointerdown', down, listenerOptions);
  viewport.addEventListener('pointermove', move, listenerOptions);
  viewport.addEventListener('pointerup', up, listenerOptions);
  viewport.addEventListener('pointercancel', up, listenerOptions);
  viewport.addEventListener('lostpointercapture', up, listenerOptions);
  for (const name of ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'contextmenu']) viewport.addEventListener(name, suppress, listenerOptions);
  const layoutChanged = () => { geometryDirty = true; schedule(true); };
  viewport.addEventListener('scroll', layoutChanged, { capture: true, signal: listeners.signal });
  window.addEventListener('blur', reset, { signal: listeners.signal });
  const visibility = () => { if (document.hidden) reset(); };
  document.addEventListener('visibilitychange', visibility, { signal: listeners.signal });
  const resize = new ResizeObserver(layoutChanged); resize.observe(viewport); resize.observe(pointer.surface());
  if (!position.current && pointer.position) position.current = { ...pointer.position() };
  followPointer();
  return () => {
    if (stopped) return;
    stopped = true;
    // Remove cancellation listeners before explicitly releasing capture.
    trace('touchpad-detached');
    listeners.abort(); reset(); resize.disconnect();
    stopObservation?.();
    options.trace?.flush('touchpad-detached');
  };
}
