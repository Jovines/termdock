import { useCallback, useRef, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from 'react';

const LONG_PRESS_COPY_MS = 450;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

async function copyTextToClipboard(text: string): Promise<void> {
  if (!text) return;
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the textarea fallback.
    }
  }

  if (typeof document === 'undefined') return;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
}

interface LongPressState {
  pointerId: number;
  startX: number;
  startY: number;
  text: string;
  key: string;
  copied: boolean;
}

interface ReferenceLongPressHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
  onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => void;
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}

export function copyReferenceText(text: string): Promise<void> {
  return copyTextToClipboard(text);
}

export function useReferenceLongPressCopy(onCopied?: (key: string) => void) {
  const timerRef = useRef<number | null>(null);
  const stateRef = useRef<LongPressState | null>(null);
  const readyRef = useRef(false);
  const suppressNextClickRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clearTimer();
    stateRef.current = null;
    readyRef.current = false;
  }, [clearTimer]);

  const getHandlers = useCallback((text: string, key: string): ReferenceLongPressHandlers => ({
    onPointerDown: (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      reset();
      stateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        text,
        key,
        copied: false,
      };
      timerRef.current = window.setTimeout(() => {
        const state = stateRef.current;
        if (!state || state.copied) return;
        state.copied = true;
        readyRef.current = true;
        suppressNextClickRef.current = true;
        void copyTextToClipboard(state.text).then(() => onCopied?.(state.key));
        timerRef.current = null;
      }, LONG_PRESS_COPY_MS);
    },
    onPointerMove: (event) => {
      const state = stateRef.current;
      if (!state || state.pointerId !== event.pointerId || readyRef.current) return;
      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOLERANCE_PX) reset();
    },
    onPointerUp: (event) => {
      const state = stateRef.current;
      if (!state || state.pointerId !== event.pointerId) {
        reset();
        return;
      }
      if (readyRef.current) {
        event.preventDefault();
        event.stopPropagation();
        suppressNextClickRef.current = true;
      }
      reset();
    },
    onPointerCancel: reset,
    onPointerLeave: (event) => {
      const state = stateRef.current;
      if (state?.pointerId === event.pointerId && !readyRef.current) reset();
    },
    onClickCapture: (event) => {
      if (!suppressNextClickRef.current) return;
      suppressNextClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenu: (event) => {
      if (!readyRef.current && !suppressNextClickRef.current) return;
      event.preventDefault();
      event.stopPropagation();
    },
  }), [onCopied, reset]);

  return getHandlers;
}
