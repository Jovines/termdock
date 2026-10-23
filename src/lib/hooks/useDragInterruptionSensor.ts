import { useEffect } from 'react';
import type { SensorAPI } from '@hello-pangea/dnd';

const INTERRUPT_DRAG = 'termdock-interrupt-drag';

/** Release both pending touch lifts and active drags before opening an overlay. */
export function interruptActiveDrag(): void {
  window.dispatchEvent(new Event(INTERRUPT_DRAG));
}

export function useDragInterruptionSensor(api: SensorAPI): void {
  useEffect(() => {
    const interrupt = () => api.tryReleaseLock();
    window.addEventListener(INTERRUPT_DRAG, interrupt);
    return () => window.removeEventListener(INTERRUPT_DRAG, interrupt);
  }, [api]);
}

export const interruptibleDragSensors = [useDragInterruptionSensor];
