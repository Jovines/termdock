import { createElement, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Copy as CopyIcon } from 'lucide-react';

const LONG_PRESS_COPY_MS = 450;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;
const REFERENCE_COPY_POPOVER_WIDTH_PX = 88;
const REFERENCE_COPY_POPOVER_HEIGHT_PX = 36;
const REFERENCE_COPY_POPOVER_MARGIN_PX = 10;
const REFERENCE_COPY_POPOVER_FINGER_GAP_PX = 14;

function readDocumentCssPx(name: string): number {
  if (typeof document === 'undefined') return 0;
  const value = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(name) || '0'
  );
  return Number.isFinite(value) ? value : 0;
}

function getReferenceCopyPopoverPosition(clientX: number, clientY: number): { left: number; top: number } {
  if (typeof window === 'undefined') {
    return { left: 0, top: 0 };
  }

  const visualViewport = window.visualViewport;
  const viewportLeft = visualViewport?.offsetLeft ?? 0;
  const viewportTop = visualViewport?.offsetTop ?? 0;
  const viewportWidth = visualViewport?.width ?? window.innerWidth;
  const viewportHeight = visualViewport?.height ?? window.innerHeight;
  const safeTop = readDocumentCssPx('--safe-top-inset');
  const safeBottom = readDocumentCssPx('--safe-bottom-inset');
  const minLeft = viewportLeft + REFERENCE_COPY_POPOVER_MARGIN_PX;
  const maxLeft = viewportLeft + viewportWidth - REFERENCE_COPY_POPOVER_WIDTH_PX - REFERENCE_COPY_POPOVER_MARGIN_PX;
  const minTop = viewportTop + safeTop + REFERENCE_COPY_POPOVER_MARGIN_PX;
  const maxTop = viewportTop + viewportHeight - safeBottom - REFERENCE_COPY_POPOVER_HEIGHT_PX - REFERENCE_COPY_POPOVER_MARGIN_PX;
  const left = Math.max(
    minLeft,
    Math.min(clientX - REFERENCE_COPY_POPOVER_WIDTH_PX / 2, Math.max(minLeft, maxLeft)),
  );
  const preferredTop = clientY - REFERENCE_COPY_POPOVER_HEIGHT_PX - REFERENCE_COPY_POPOVER_FINGER_GAP_PX;
  const fallbackTop = clientY + REFERENCE_COPY_POPOVER_FINGER_GAP_PX;
  const topCandidate = preferredTop >= minTop ? preferredTop : fallbackTop;
  const top = Math.max(minTop, Math.min(topCandidate, Math.max(minTop, maxTop)));

  return { left: Math.round(left), top: Math.round(top) };
}

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
}

interface ReferenceCopyPopover {
  text: string;
  key: string;
  left: number;
  top: number;
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

type ReferenceLongPressHandlerFactory = ((text: string, key: string) => ReferenceLongPressHandlers) & {
  popoverNode: React.ReactPortal | null;
};

export function copyReferenceText(text: string): Promise<void> {
  return copyTextToClipboard(text);
}

export function useReferenceLongPressCopy(onCopied?: (key: string) => void) {
  const timerRef = useRef<number | null>(null);
  const stateRef = useRef<LongPressState | null>(null);
  const readyRef = useRef(false);
  const suppressNextClickRef = useRef(false);
  const popoverPressingRef = useRef(false);
  const [popover, setPopover] = useState<ReferenceCopyPopover | null>(null);

  useEffect(() => {
    if (!popover) return;
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('[data-reference-copy-popover="true"]')) {
        return;
      }
      setPopover(null);
      readyRef.current = false;
      suppressNextClickRef.current = false;
    };
    document.addEventListener('pointerdown', close, { capture: true });
    return () => document.removeEventListener('pointerdown', close, true);
  }, [popover]);

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
      };
      timerRef.current = window.setTimeout(() => {
        const state = stateRef.current;
        if (!state) return;
        readyRef.current = true;
        suppressNextClickRef.current = true;
        popoverPressingRef.current = false;
        setPopover({
          text: state.text,
          key: state.key,
          ...getReferenceCopyPopoverPosition(state.startX, state.startY),
        });
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
      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onContextMenu: (event) => {
      if (!readyRef.current && !suppressNextClickRef.current) return;
      event.preventDefault();
      event.stopPropagation();
    },
  }), [reset]);

  const pressPopover = useCallback((event: ReactPointerEvent<HTMLButtonElement> | ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!popover || popoverPressingRef.current) return;
    popoverPressingRef.current = true;
    const current = popover;
    setPopover(null);
    readyRef.current = false;
    suppressNextClickRef.current = false;
    void copyTextToClipboard(current.text).then(() => onCopied?.(current.key));
  }, [onCopied, popover]);

  const popoverNode = popover && typeof document !== 'undefined'
    ? createPortal(
      createElement(
        'button',
        {
          type: 'button',
          'data-reference-copy-popover': 'true',
          className: 'fixed z-popover inline-flex h-9 w-[88px] select-none items-center justify-center gap-1.5 rounded-full border border-white/15 bg-[rgb(28_28_30_/_0.92)] px-3 text-[13px] font-semibold text-white shadow-[0_10px_28px_rgb(0_0_0_/_0.32),0_2px_8px_rgb(0_0_0_/_0.18)] backdrop-blur-xl transition-transform duration-100 ease-out active:scale-[0.96]',
          style: {
            left: popover.left,
            top: popover.top,
            WebkitBackdropFilter: 'blur(18px)',
          },
          onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
            event.stopPropagation();
          },
          onPointerUp: pressPopover,
          onTouchStart: (event: React.TouchEvent<HTMLButtonElement>) => {
            event.stopPropagation();
          },
          onTouchEnd: pressPopover,
          onClick: pressPopover,
        },
        createElement(CopyIcon, { size: 14, strokeWidth: 2.4 }),
        createElement('span', null, 'Copy'),
      ),
      document.body,
    )
    : null;

  return useMemo(
    () => Object.assign(getHandlers, { popoverNode }) as ReferenceLongPressHandlerFactory,
    [getHandlers, popoverNode],
  );
}
