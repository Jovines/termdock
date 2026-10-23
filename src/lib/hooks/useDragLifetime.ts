import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { observeDragLifetime, prepareDragLifetimes, type DragFinishReason } from '../gesture/dragLifetime';

/** Add to an accepted pointer-down. Existing move/up handlers keep their business rules. */
export function useDragLifetime(onFinish: (reason: DragFinishReason, pointerId: number) => void, multiple = false) {
  const callback = useRef(onFinish);
  callback.current = onFinish;
  const sessions = useRef(new Map<number, () => void>());
  useEffect(() => {
    prepareDragLifetimes();
    return () => { for (const stop of [...sessions.current.values()]) stop(); };
  }, []);
  return useCallback((event: ReactPointerEvent<Element> | PointerEvent, captureTarget?: Element) => {
    if (!multiple) for (const stop of [...sessions.current.values()]) stop();
    else sessions.current.get(event.pointerId)?.();
    const pointerId = event.pointerId;
    const stop = observeDragLifetime({
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      captureTarget: captureTarget ?? (event.currentTarget instanceof Element ? event.currentTarget : undefined),
      deferRelease: true,
      onFinish: reason => { sessions.current.delete(pointerId); callback.current(reason, pointerId); },
    });
    sessions.current.set(pointerId, stop);
  }, [multiple]);
}
