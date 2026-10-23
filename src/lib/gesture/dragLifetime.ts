export type DragFinishReason = 'release' | 'buttons-lost' | 'blur' | 'hidden' | 'escape' | 'cancel' | 'capture-lost' | 'dispose';

interface DragLifetimeOptions {
  /** Omit for legacy mouse handlers. Touch/pen gestures always supply an ID. */
  pointerId?: number;
  pointerType?: string;
  captureTarget?: Element;
  /** React release handlers run before fallback cleanup at the end of dispatch. */
  deferRelease?: boolean;
  onFinish: (reason: DragFinishReason, event?: MouseEvent | PointerEvent) => void;
}

// Install once, before libraries attach per-drag window listeners. This lets
// cancellation run before a library can lift/move using an unpressed pointer.
const subscribers = new Map<string, Set<EventListener>>();
export function prepareDragLifetimes(): void {
  for (const type of ['mousemove', 'pointermove', 'mouseup', 'pointerup', 'pointercancel', 'blur', 'pagehide', 'keydown', 'visibilitychange']) {
    if (subscribers.has(type)) continue;
    const handlers = new Set<EventListener>();
    subscribers.set(type, handlers);
    const target = type === 'visibilitychange' ? document : window;
    target.addEventListener(type, event => { for (const handler of [...handlers]) handler(event); }, true);
  }
}

/** Shared termination contract; movement, persistence and rollback belong to the caller. */
export function observeDragLifetime(options: DragLifetimeOptions): () => void {
  prepareDragLifetimes();
  let finished = false;
  const removers: (() => void)[] = [];
  const listen = (target: EventTarget, type: string, listener: EventListener) => {
    const shared = subscribers.get(type);
    if (shared && (target === window || target === document)) {
      shared.add(listener);
      removers.push(() => { shared.delete(listener); });
    } else {
      target.addEventListener(type, listener, true);
      removers.push(() => target.removeEventListener(type, listener, true));
    }
  };
  const finish = (reason: DragFinishReason, event?: MouseEvent | PointerEvent) => {
    if (finished) return;
    finished = true;
    removers.forEach(remove => remove());
    try {
      options.onFinish(reason, event);
    } finally {
      const { captureTarget, pointerId } = options;
      if (captureTarget && pointerId !== undefined) {
        try {
          if (captureTarget.hasPointerCapture?.(pointerId)) captureTarget.releasePointerCapture(pointerId);
        } catch { /* The webview may already have released the pointer. */ }
      }
    }
  };
  const matches = (event: PointerEvent) => event.pointerId === options.pointerId;
  const checkButtons = (event: MouseEvent) => {
    if ((event.buttons & 1) === 0) finish('buttons-lost', event);
  };
  const release = (event: MouseEvent | PointerEvent) => {
    if (options.deferRelease) queueMicrotask(() => finish('release', event));
    else finish('release', event);
  };
  if (options.pointerId === undefined) {
    listen(window, 'mousemove', event => checkButtons(event as MouseEvent));
    listen(window, 'pointermove', event => {
      if ((event as PointerEvent).pointerType === 'mouse') checkButtons(event as PointerEvent);
    });
    listen(window, 'mouseup', event => {
      const mouse = event as MouseEvent;
      if (mouse.button === 0) release(mouse);
    });
    listen(window, 'pointercancel', event => {
      if ((event as PointerEvent).pointerType === 'mouse') finish('cancel', event as PointerEvent);
    });
  } else {
    listen(window, 'pointermove', event => {
      const pointer = event as PointerEvent;
      if (matches(pointer) && (options.pointerType === 'mouse' || options.pointerType === 'pen')) checkButtons(pointer);
    });
    listen(window, 'pointerup', event => { if (matches(event as PointerEvent)) release(event as PointerEvent); });
    listen(window, 'pointercancel', event => { if (matches(event as PointerEvent)) finish('cancel', event as PointerEvent); });
    if (options.captureTarget) listen(options.captureTarget, 'lostpointercapture', event => {
      if (event.target === options.captureTarget && matches(event as PointerEvent)) finish('capture-lost', event as PointerEvent);
    });
  }
  // Capture also observes input/button blur; only leaving the window ends a drag.
  listen(window, 'blur', event => { if (event.target === event.currentTarget) finish('blur'); });
  listen(window, 'pagehide', () => finish('hidden'));
  listen(document, 'visibilitychange', () => { if (document.hidden) finish('hidden'); });
  listen(window, 'keydown', event => { if ((event as KeyboardEvent).key === 'Escape') finish('escape'); });
  return () => finish('dispose');
}
