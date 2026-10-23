type FontZoomWheel = Pick<WheelEvent, 'ctrlKey' | 'metaKey' | 'deltaX' | 'deltaY' | 'deltaMode'>;

// Trackpads emit many tiny wheel events (including ctrl-modified pinch events).
// Require deliberate movement and discard excess momentum instead of persisting
// a new session size for every event.
export function createFontZoomGesture() {
  let accumulated = 0;
  let lastEventAt = -Infinity;
  let lastStepAt = -Infinity;
  const reset = () => { accumulated = 0; lastEventAt = lastStepAt = -Infinity; };
  return {
    reset,
    consume(event: FontZoomWheel, now: number): number {
      if (!event.ctrlKey && !event.metaKey) { reset(); return 0; }
      const { deltaY, deltaX, deltaMode } = event;
      if (!Number.isFinite(deltaY) || !Number.isFinite(deltaX)
        || deltaY === 0 || Math.abs(deltaY) <= Math.abs(deltaX)) return 0;
      const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 40 : 1);
      if (now - lastEventAt > 250 || Math.sign(pixels) !== Math.sign(accumulated)) accumulated = 0;
      lastEventAt = now;
      if (now - lastStepAt < 120) { accumulated = 0; return 0; }
      accumulated += pixels;
      if (Math.abs(accumulated) < 40) return 0;
      const step = accumulated > 0 ? -1 : 1;
      accumulated = 0;
      lastStepAt = now;
      return step;
    },
  };
}
