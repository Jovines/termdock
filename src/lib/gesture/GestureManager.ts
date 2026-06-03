import type { GestureAction, GestureHandler, GestureHandlerInfo, GesturePointerState } from './types';

function isTouchPointer(e: PointerEvent): boolean {
  return e.pointerType === 'touch' || e.pointerType === 'pen';
}

type GestureChangeListener = (event: {
  type: 'claim' | 'release' | 'complete';
  pointerId: number;
  handler: string | null;
}) => void;

/**
 * Centralised gesture dispatcher.  Single document capture listener.
 *
 * Every registered handler whose `container` matches the event target
 * receives EVERY event independently, mirroring the original multi-listener
 * architecture where each handler had its own DOM listener at a different
 * phase / level.
 *
 * ## Lifecyle (per pointerId)
 *
 *   pointerdown  →  onPointerDown called for every matching handler.
 *                   First to return `true` claims the pointer.
 *
 *   pointermove  →  onPointerMove called for every matching handler.
 *                   Handlers return a GestureAction:
 *                     'claim'   — lock this pointer, preventDefault
 *                     'release' — give up so lower-prio handlers can claim
 *                     'neutral' — just tracking, no claim change
 *
 *                   `isClaimed` tells the handler whether IT holds the
 *                   claim.  Only the claimant performs the actual action
 *                   (scroll, SGR, arrows); all others just track state.
 *
 *   pointerup    →  onPointerUp called for every matching handler.
 *   pointercancel →  onPointerCancel called for every matching handler.
 *
 * ## Adding a new gesture
 *
 *   1. Pick a priority in one of the gaps (100 / 90 / 80 / 70)
 *   2. Implement GestureHandler (4 methods + name/prio/container)
 *   3. Call GestureManager.register() or use useGesture()
 *
 * Done.  No DOM listeners, no stopImmediatePropagation, no phase order hacks.
 */
class GestureManagerClass {
  private handlers = new Map<string, GestureHandler>();
  private active: Map<number, string> = new Map();
  private pointerStates = new Map<number, GesturePointerState>();
  private sorted: GestureHandler[] = [];
  private sortedDirty = false;
  private listenersRegistered = false;
  private changeListeners = new Set<GestureChangeListener>();

  constructor() {
    this.ensureListeners();
  }

  // ── Registration ──

  register(handler: GestureHandler): () => void {
    if (this.handlers.has(handler.name)) {
      this.log('replace', handler.name);
    }
    this.handlers.set(handler.name, handler);
    this.sortedDirty = true;
    this.log('register', handler.name, `prio=${handler.priority}`);
    return () => {
      this.unregister(handler.name);
    };
  }

  unregister(name: string): void {
    this.handlers.delete(name);
    this.sortedDirty = true;
    for (const [pid, hName] of this.active) {
      if (hName === name) {
        this.active.delete(pid);
        this.pointerStates.delete(pid);
      }
    }
    this.log('unregister', name);
  }

  // ── Inspection ──

  getHandlers(): ReadonlyArray<GestureHandlerInfo> {
    return this.sortedHandlers().map((h) => ({
      name: h.name,
      priority: h.priority,
      hasContainer: h.container != null,
    }));
  }

  getClaimedHandler(pointerId: number): string | null {
    return this.active.get(pointerId) ?? null;
  }

  isClaimedBy(pointerId: number, handlerName: string): boolean {
    return this.active.get(pointerId) === handlerName;
  }

  isAnyPointerClaimed(): boolean {
    return this.active.size > 0;
  }

  // ── Change subscription ──

  /**
   * Subscribe to claim/release/complete events.
   * Useful for external integration (e.g. locking Swiper's allowTouchMove).
   */
  onChange(listener: GestureChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private emitChange(
    type: 'claim' | 'release' | 'complete',
    pointerId: number,
    handler: string | null,
  ): void {
    if (this.changeListeners.size === 0) return;
    this.changeListeners.forEach((fn) => {
      try {
        fn({ type, pointerId, handler });
      } catch {
        /* swallow subscriber errors */
      }
    });
  }

  // ── Debug ──

  private log(action: string, handler: string, detail = ''): void {
    if (typeof window !== 'undefined' && (window as any).__TERMDOCK_GESTURE_DEBUG__) {
      const ts = performance.now().toFixed(0);
      console.debug(`[GestureManager ${ts}] ${action} ${handler} ${detail}`);
    }
  }

  // ── Internal ──

  private sortedHandlers(): GestureHandler[] {
    if (this.sortedDirty) {
      this.sorted = [...this.handlers.values()].sort((a, b) => b.priority - a.priority);
      this.sortedDirty = false;
    }
    return this.sorted;
  }

  private ensureListeners(): void {
    if (this.listenersRegistered) return;
    this.listenersRegistered = true;

    document.addEventListener('pointerdown', this.handlePointerDown, {
      capture: true,
      passive: false,
    });
    document.addEventListener('pointermove', this.handlePointerMove, {
      capture: true,
      passive: false,
    });
    document.addEventListener('pointerup', this.handlePointerUp, {
      capture: true,
      passive: false,
    });
    document.addEventListener('pointercancel', this.handlePointerCancel, {
      capture: true,
      passive: false,
    });
  }

  private handlePointerDown = (e: PointerEvent): void => {
    if (!isTouchPointer(e)) return;

    const state: GesturePointerState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startTime: performance.now(),
    };
    this.pointerStates.set(e.pointerId, state);

    let anyClaimed = false;

    for (const handler of this.sortedHandlers()) {
      if (!this.handlerMatchesContainer(handler, e)) {
        this.log('skip-container', handler.name);
        continue;
      }
      const claimed = handler.onPointerDown(e, state);
      if (claimed && !anyClaimed) {
        this.active.set(e.pointerId, handler.name);
        anyClaimed = true;
        this.log('claim', handler.name, `pid=${e.pointerId} onPointerDown`);
        this.emitChange('claim', e.pointerId, handler.name);
      }
    }

    if (anyClaimed) {
      e.preventDefault();
    }
  };

  private handlePointerMove = (e: PointerEvent): void => {
    if (!isTouchPointer(e)) return;
    if (!this.pointerStates.has(e.pointerId)) return;

    let didClaim = false;

    for (const handler of this.sortedHandlers()) {
      if (!this.handlerMatchesContainer(handler, e)) continue;

      const isClaimed = this.active.get(e.pointerId) === handler.name;
      const action: GestureAction = handler.onPointerMove(e, isClaimed);

      if (action === 'claim' && !didClaim) {
        const prevOwner = this.active.get(e.pointerId) ?? null;
        this.active.set(e.pointerId, handler.name);
        didClaim = true;
        e.preventDefault();
        if (prevOwner && prevOwner !== handler.name) {
          this.log('handoff', `${prevOwner}->${handler.name}`, `pid=${e.pointerId}`);
        }
        this.log('claim', handler.name, `pid=${e.pointerId} onPointerMove`);
        this.emitChange('claim', e.pointerId, handler.name);
      }
      if (action === 'release' && isClaimed && !didClaim) {
        const prev = this.active.get(e.pointerId);
        this.active.delete(e.pointerId);
        this.log('release', handler.name, `pid=${e.pointerId}`);
        this.emitChange('release', e.pointerId, prev ?? null);
      }
    }
  };

  private handlePointerUp = (e: PointerEvent): void => {
    if (!isTouchPointer(e)) return;

    for (const handler of this.sortedHandlers()) {
      if (!this.handlerMatchesContainer(handler, e)) continue;
      handler.onPointerUp(e);
    }

    const claimed = this.active.get(e.pointerId) ?? null;
    this.active.delete(e.pointerId);
    this.pointerStates.delete(e.pointerId);
    this.emitChange('complete', e.pointerId, claimed);
  };

  private handlePointerCancel = (e: PointerEvent): void => {
    if (!isTouchPointer(e)) return;

    for (const handler of this.sortedHandlers()) {
      if (!this.handlerMatchesContainer(handler, e)) continue;
      handler.onPointerCancel(e);
    }

    const claimed = this.active.get(e.pointerId) ?? null;
    this.active.delete(e.pointerId);
    this.pointerStates.delete(e.pointerId);
    this.emitChange('complete', e.pointerId, claimed);
  };

  private handlerMatchesContainer(handler: GestureHandler, e: PointerEvent): boolean {
    if (!handler.container) return true;
    return handler.container.contains(e.target as Node);
  }
}

export const GestureManager = new GestureManagerClass();
