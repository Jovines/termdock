import { useEffect, useRef } from 'react';
import { GestureManager } from '../gesture/GestureManager';
import type { GestureAction, GestureHandler, GesturePointerState } from '../gesture/types';

interface UseGestureConfig {
  name: string;
  priority: number;
  container?: HTMLElement | (() => HTMLElement | null | undefined);
  onPointerDown?: (e: PointerEvent, state: GesturePointerState) => boolean;
  onPointerMove?: (e: PointerEvent, isClaimed: boolean) => GestureAction;
  onPointerUp?: (e: PointerEvent) => void;
  onPointerCancel?: (e: PointerEvent) => void;
}

export function useGesture(config: UseGestureConfig): void {
  const { name, priority } = config;

  const onPointerDownRef = useRef(config.onPointerDown);
  const onPointerMoveRef = useRef(config.onPointerMove);
  const onPointerUpRef = useRef(config.onPointerUp);
  const onPointerCancelRef = useRef(config.onPointerCancel);
  const containerRef = useRef(config.container);

  onPointerDownRef.current = config.onPointerDown;
  onPointerMoveRef.current = config.onPointerMove;
  onPointerUpRef.current = config.onPointerUp;
  onPointerCancelRef.current = config.onPointerCancel;
  containerRef.current = config.container;

  useEffect(() => {
    const handler: GestureHandler = {
      name,
      priority,
      get container() {
        const c = containerRef.current;
        return typeof c === 'function' ? c() : c;
      },

      onPointerDown(e: PointerEvent, state: GesturePointerState): boolean {
        return onPointerDownRef.current?.(e, state) ?? false;
      },

      onPointerMove(e: PointerEvent, isClaimed: boolean): GestureAction {
        return onPointerMoveRef.current?.(e, isClaimed) ?? 'neutral';
      },

      onPointerUp(e: PointerEvent): void {
        onPointerUpRef.current?.(e);
      },

      onPointerCancel(e: PointerEvent): void {
        onPointerCancelRef.current?.(e);
      },
    };

    const unregister = GestureManager.register(handler);
    return unregister;
  }, [name, priority]);
}
