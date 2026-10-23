import { useEffect } from 'react';
import type { SensorAPI } from '@hello-pangea/dnd';
import { observeDragLifetime, prepareDragLifetimes } from '../gesture/dragLifetime';

const INTERRUPT_DRAG = 'termdock-interrupt-drag';

/** Release both pending touch lifts and active drags before opening an overlay. */
export function interruptActiveDrag(): void {
  window.dispatchEvent(new Event(INTERRUPT_DRAG));
}

export function useDragInterruptionSensor(api: SensorAPI): void {
  useEffect(() => {
    prepareDragLifetimes();
    let stopMouse: (() => void) | null = null;
    const clearMouseGesture = () => { stopMouse?.(); stopMouse = null; };
    const interrupt = () => { clearMouseGesture(); api.tryReleaseLock(); };
    const mouseDown = (event: MouseEvent) => {
      clearMouseGesture();
      if (event.button !== 0 || api.findClosestDraggableId(event) === null) return;
      stopMouse = observeDragLifetime({
        onFinish: reason => {
          stopMouse = null;
          if (reason !== 'release' && reason !== 'dispose') api.tryReleaseLock();
        },
      });
    };
    window.addEventListener(INTERRUPT_DRAG, interrupt);
    window.addEventListener('mousedown', mouseDown, true);
    window.addEventListener('keydown', clearMouseGesture, true);
    window.addEventListener('touchstart', clearMouseGesture, true);
    window.addEventListener('blur', interrupt);
    return () => {
      clearMouseGesture();
      window.removeEventListener(INTERRUPT_DRAG, interrupt);
      window.removeEventListener('mousedown', mouseDown, true);
      window.removeEventListener('keydown', clearMouseGesture, true);
      window.removeEventListener('touchstart', clearMouseGesture, true);
      window.removeEventListener('blur', interrupt);
    };
  }, [api]);
}

export const interruptibleDragSensors = [useDragInterruptionSensor];
